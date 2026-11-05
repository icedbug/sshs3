import crypto from 'node:crypto';
import type { StorageRegistry } from '../storage/StorageRegistry';
import { SFTPStorageProvider } from '../storage/SFTPStorageProvider';
import { quotePathOperand } from '../search/shellQuote';
import { createLogger } from '../log';
import { StringDecoder } from 'node:string_decoder';
const filetailserviceLog = createLogger('FileTailService');

export interface FileTailDataEvent {
  tailId: string;
  chunk: string;
}

export interface FileTailErrorEvent {
  tailId: string;
  error: string;
}

export interface FileTailStartResult {
  tailId: string;
  initialContent: string;
  size: number;
}

interface ActiveTailSession {
  tailId: string;
  providerId: string;
  remotePath: string;
  stop: () => void;
}

export class FileTailService {
  private activeTails = new Map<string, ActiveTailSession>();

  /**
   * Starts tailing a file. Fetches initial tail content (last 5 MB) and streams
   * subsequent appended data.
   */
  public async startTail(
    storageRegistry: StorageRegistry,
    providerId: string,
    remotePath: string,
    onData: (event: FileTailDataEvent) => void,
    onError: (event: FileTailErrorEvent) => void
  ): Promise<FileTailStartResult> {
    const provider = storageRegistry.get(providerId);
    if (!provider) {
      throw new Error(`Storage provider not found: ${providerId}`);
    }

    const stat = await provider.stat(remotePath);
    const size = stat.size;

    // Fetch initial tail content (last 5 MB max)
    const maxInitialBytes = 5 * 1024 * 1024;
    const startByte = Math.max(0, size - maxInitialBytes);

    let initialContent = '';
    try {
      const readStream = await provider.createReadStream(remotePath, startByte);
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        readStream.on('data', (chunk: Buffer) => chunks.push(chunk));
        readStream.on('end', () => resolve());
        readStream.on('error', (err) => reject(err));
      });
      const fullBuf = Buffer.concat(chunks);
      let text = fullBuf.toString('utf-8');

      // If we didn't start at 0, strip the first partial line
      if (startByte > 0) {
        const firstNewlineIdx = text.indexOf('\n');
        if (firstNewlineIdx !== -1) {
          text = text.substring(firstNewlineIdx + 1);
        }
      }
      initialContent = text;
    } catch (err: any) {
      filetailserviceLog.error('Error reading initial content:', err);
    }

    const tailId = crypto.randomUUID();
    let stopFn: () => void = () => {};

    // Check if SFTP provider is available and supports exec stream
    let startedSftpTail = false;
    if (provider.type === 'sftp' && provider instanceof SFTPStorageProvider) {
      try {
        await provider.ensureConnected();
        const resolvedPath = await provider.resolveRemotePath(remotePath);
        const cmd = `tail -n 0 -f ${quotePathOperand(resolvedPath)}`;

        if (typeof (provider as any).createExecStream === 'function') {
          try {
            const stream = (provider as any).createExecStream(cmd);
            stream.on('data', (data: Buffer) => {
              onData({ tailId, chunk: data.toString('utf-8') });
            });
            stream.on('error', (err: any) => {
              onError({ tailId, error: err.message || String(err) });
            });
            stopFn = () => {
              try {
                (stream as any).destroy?.();
              } catch {
                // ignore
              }
            };
            startedSftpTail = true;
          } catch {
            startedSftpTail = false;
          }
        }

        if (!startedSftpTail) {
          const rawSshClient = (provider as any).client?.client;
          if (rawSshClient && typeof rawSshClient.exec === 'function') {
            await new Promise<void>((resolve, reject) => {
              rawSshClient.exec(cmd, (err: any, stream: any) => {
                if (err || !stream) {
                  return reject(err || new Error('Failed to open exec stream'));
                }

                const decoder = new StringDecoder('utf8'); // a character may be split across two chunks
                stream.on('data', (data: Buffer) => {
                  const chunk = decoder.write(data);
                  if (chunk) onData({ tailId, chunk });
                });

                stream.stderr?.on('data', (data: Buffer) => {
                  const errStr = data.toString('utf-8');
                  if (errStr.trim()) {
                    onError({ tailId, error: errStr });
                  }
                });

                stopFn = () => {
                  try {
                    stream.close?.();
                    stream.destroy?.();
                  } catch {
                    // ignore
                  }
                };

                startedSftpTail = true;
                resolve();
              });
            });
          }
        }
      } catch (sftpErr) {
        filetailserviceLog.warn('SFTP tail command execution failed, falling back to polling:', sftpErr);
        startedSftpTail = false;
      }
    }

    // Fallback or S3 / Local provider: Polling via stat + Range Read
    if (!startedSftpTail) {
      let lastSize = size;
      let isPolling = false;
      const decoder = new StringDecoder('utf8');

      const intervalId = setInterval(async () => {
        if (isPolling) return;
        isPolling = true;
        try {
          const currentStat = await provider.stat(remotePath);
          if (currentStat.size > lastSize) {
            // The end of a range is inclusive: the last byte of the file is at size - 1.
            const rangeStream = await provider.createReadStream(remotePath, lastSize, currentStat.size - 1);
            const chunks: Buffer[] = [];
            await new Promise<void>((resolve, reject) => {
              rangeStream.on('data', (chunk: Buffer) => chunks.push(chunk));
              rangeStream.on('end', () => resolve());
              rangeStream.on('error', (err) => reject(err));
            });
            const newBuf = Buffer.concat(chunks);
            lastSize = currentStat.size;
            const text = decoder.write(newBuf);
            if (text) {
              onData({ tailId, chunk: text });
            }
          } else if (currentStat.size < lastSize) {
            // File truncated or reset
            lastSize = currentStat.size;
          }
        } catch (pollErr: any) {
          // Non-fatal polling error
          onError({ tailId, error: pollErr instanceof Error ? pollErr.message : String(pollErr) });
        } finally {
          isPolling = false;
        }
      }, 2000);

      stopFn = () => {
        clearInterval(intervalId);
      };
    }

    const session: ActiveTailSession = {
      tailId,
      providerId,
      remotePath,
      stop: stopFn,
    };
    this.activeTails.set(tailId, session);

    return {
      tailId,
      initialContent,
      size,
    };
  }

  /**
   * Stops an active tail session.
   */
  public stopTail(tailId: string): void {
    const session = this.activeTails.get(tailId);
    if (session) {
      session.stop();
      this.activeTails.delete(tailId);
    }
  }

  /**
   * Disposes all active tail sessions.
   */
  public dispose(): void {
    for (const session of this.activeTails.values()) {
      session.stop();
    }
    this.activeTails.clear();
  }
}
