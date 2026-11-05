import crypto from 'node:crypto';
import type { StorageRegistry } from '../storage/StorageRegistry';
import { SFTPStorageProvider } from '../storage/SFTPStorageProvider';
import { anchorPath, quotePathOperand, quoteShellArg } from './shellQuote';
import { buildLineMatcher } from './lineMatcher';
import type {
  SearchDoneEvent,
  SearchErrorEvent,
  SearchMatch,
  SearchPreviewResult,
  SearchProgressEvent,
  SearchResultEvent,
  SearchStartOptions,
} from '../../shared/types/search';

const SEARCH_TIMEOUT_MS = 120_000;
const BATCH_MAX_MATCHES = 25;
const BATCH_MAX_DELAY_MS = 150;
const PROGRESS_INTERVAL_MS = 300;
/** Extra headroom over maxResults before `head` cuts the remote pipe off, so a few
 * matches that were already in flight when the cap was hit aren't silently lost. */
const RESULT_CAP_SAFETY_FACTOR = 1.2;

interface ActiveSearchSession {
  searchId: string;
  stop: () => void;
  markCancelled: () => void;
}

export function buildFindGrepCommand(resolvedRoot: string, options: SearchStartOptions): string {
  const parts: string[] = ['find', quotePathOperand(resolvedRoot)];

  if (Number.isInteger(options.maxDepth) && (options.maxDepth as number) >= 0) {
    parts.push('-maxdepth', String(options.maxDepth));
  }
  parts.push('-type', 'f', '!', '-type', 'l');

  if (options.includeGlobs && options.includeGlobs.length > 0) {
    const clauses = options.includeGlobs.flatMap((glob) => ['-iname', quoteShellArg(glob), '-o']);
    clauses.pop(); // drop trailing -o
    parts.push('\\(', ...clauses, '\\)');
  }
  if (options.excludeGlobs && options.excludeGlobs.length > 0) {
    const clauses = options.excludeGlobs.flatMap((glob) => ['-iname', quoteShellArg(glob), '-o']);
    clauses.pop();
    parts.push('!', '\\(', ...clauses, '\\)');
  }

  parts.push('-print0');

  const grepFlags = ['-I', '-n', '-H'];
  if (!options.caseSensitive) grepFlags.push('-i');
  grepFlags.push(options.mode === 'regex' ? '-E' : '-F');

  // maxResults crosses the IPC boundary untyped and is interpolated into the command line unquoted.
  const maxResults = Number.isInteger(options.maxResults) && (options.maxResults as number) > 0 ? (options.maxResults as number) : 500;
  const cap = Math.max(maxResults, Math.ceil(maxResults * RESULT_CAP_SAFETY_FACTOR));

  return (
    parts.join(' ') +
    ` | xargs -0 -r grep ${grepFlags.join(' ')} -e ${quoteShellArg(options.query)} --` +
    ` | head -n ${cap}`
  );
}

/** Parses a single `grep -nH` output line ("path:lineno:content") into its parts. */
function parseGrepLine(line: string): { path: string; lineNumber: number; content: string } | null {
  const match = /^(.*?):(\d+):(.*)$/s.exec(line);
  if (!match) return null;
  return { path: match[1], lineNumber: parseInt(match[2], 10), content: match[3] };
}

function displayPathFor(fullPath: string, resolvedRoot: string): string {
  if (fullPath === resolvedRoot) return fullPath;
  const withSlash = resolvedRoot.endsWith('/') ? resolvedRoot : `${resolvedRoot}/`;
  return fullPath.startsWith(withSlash) ? fullPath.slice(withSlash.length) : fullPath;
}

export class RemoteSearchService {
  private sessions = new Map<string, ActiveSearchSession>();

  public async startSearch(
    storageRegistry: StorageRegistry,
    options: SearchStartOptions,
    onResult: (event: SearchResultEvent) => void,
    onError: (event: SearchErrorEvent) => void,
    onDone: (event: SearchDoneEvent) => void,
    onProgress?: (event: SearchProgressEvent) => void
  ): Promise<{ searchId: string }> {
    const provider = storageRegistry.get(options.providerId);
    if (!provider || !(provider instanceof SFTPStorageProvider)) {
      throw new Error(`SFTP storage provider not found: ${options.providerId}`);
    }

    await provider.ensureConnected();
    const rawSshClient = (provider as any).client?.client;
    const hasCreateExec = typeof (provider as any).client?.createExecStream === 'function';
    const hasRawExec = rawSshClient && typeof rawSshClient.exec === 'function';
    if (!hasCreateExec && !hasRawExec) {
      throw new Error('This SFTP connection does not support running remote commands');
    }

    // Anchored like the `find` operand, because that is how `find` prints the root in every result path.
    const resolvedRoot = anchorPath(await provider.resolveRemotePath(options.rootPath));
    const searchId = crypto.randomUUID();
    const cmd = buildFindGrepCommand(resolvedRoot, options);

    let finished = false;
    let scannedCount = 0;
    let matchCount = 0;
    let pendingBatch: SearchMatch[] = [];
    let batchTimer: NodeJS.Timeout | null = null;
    let lineBuffer = '';
    const maxResults = options.maxResults ?? 500;
    const matcher = buildLineMatcher(options.query, options.mode, options.caseSensitive);

    const flushBatch = () => {
      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
      if (pendingBatch.length === 0) return;
      onResult({ searchId, matches: pendingBatch });
      pendingBatch = [];
    };

    const scheduleFlush = () => {
      if (batchTimer) return;
      batchTimer = setTimeout(flushBatch, BATCH_MAX_DELAY_MS);
    };

    let stopFn: () => void = () => {};
    let timeoutHandle: NodeJS.Timeout | null = null;
    let wasCancelled = false;

    // grep only ever emits matching lines, so there's no cheap way to report "files
    // scanned" separately from "matches found so far" for this backend — the heartbeat
    // reports matchCount as the live-progress signal instead.
    const progressInterval = onProgress
      ? setInterval(() => onProgress({ searchId, scannedCount, matchCount }), PROGRESS_INTERVAL_MS)
      : null;

    const finish = (result: { truncated: boolean }) => {
      if (finished) return;
      finished = true;
      flushBatch();
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (progressInterval) clearInterval(progressInterval);
      this.sessions.delete(searchId);
      onDone({ searchId, matchCount, scannedCount, cancelled: wasCancelled, truncated: result.truncated });
    };

    await new Promise<void>((resolve, reject) => {
      const attachListeners = (stream: any) => {
        stream.on('data', (data: Buffer) => {
          if (finished) return;
          lineBuffer += data.toString('utf-8');
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line) continue;
            scannedCount += 1;
            const parsed = parseGrepLine(line);
            if (!parsed) continue;
            const offsets = matcher(parsed.content) ?? { start: 0, end: 0 };
            matchCount += 1;
            pendingBatch.push({
              id: `${searchId}-${matchCount}`,
              path: parsed.path,
              displayPath: displayPathFor(parsed.path, resolvedRoot),
              lineNumber: parsed.lineNumber,
              snippet: parsed.content.trim(),
              matchStart: offsets.start,
              matchEnd: offsets.end,
              source: 'sftp-grep',
            });
            if (pendingBatch.length >= BATCH_MAX_MATCHES) {
              flushBatch();
            } else {
              scheduleFlush();
            }
            if (matchCount >= maxResults) {
              stopFn();
              finish({ truncated: true });
              return;
            }
          }
        });

        stream.stderr?.on('data', (data: Buffer) => {
          const text = data.toString('utf-8').trim();
          if (text) {
            onError({ searchId, message: text, fatal: false });
          }
        });

        stream.on('close', () => {
          finish({ truncated: false });
        });

        stream.on('error', (streamErr: any) => {
          onError({
            searchId,
            message: streamErr instanceof Error ? streamErr.message : String(streamErr),
            fatal: true,
          });
          finish({ truncated: false });
        });

        stopFn = () => {
          try {
            stream.close?.();
            stream.destroy?.();
          } catch {
            // ignore
          }
        };

        resolve();
      };

      if (hasCreateExec) {
        try {
          const stream = (provider as any).client.createExecStream(cmd);
          attachListeners(stream);
        } catch (err) {
          reject(err);
        }
      } else {
        rawSshClient.exec(cmd, (err: any, stream: any) => {
          if (err || !stream) {
            reject(err || new Error('Failed to start remote search'));
            return;
          }
          attachListeners(stream);
        });
      }
    });

    timeoutHandle = setTimeout(() => {
      if (finished) return;
      onError({ searchId, message: 'Search timed out after 120 seconds', fatal: false });
      stopFn();
      finish({ truncated: true });
    }, SEARCH_TIMEOUT_MS);

    this.sessions.set(searchId, {
      searchId,
      stop: stopFn,
      markCancelled: () => {
        wasCancelled = true;
      },
    });

    return { searchId };
  }

  public cancelSearch(searchId: string): void {
    const session = this.sessions.get(searchId);
    if (session) {
      session.markCancelled();
      session.stop();
      this.sessions.delete(searchId);
    }
  }

  /**
   * Fetches a bounded slice of lines around a match, for click-to-preview, without
   * streaming the whole (possibly huge) remote file into the renderer.
   */
  public async previewLines(
    storageRegistry: StorageRegistry,
    providerId: string,
    remotePath: string,
    lineNumber: number,
    contextLines: number
  ): Promise<SearchPreviewResult> {
    const provider = storageRegistry.get(providerId);
    if (!provider || !(provider instanceof SFTPStorageProvider)) {
      throw new Error(`SFTP storage provider not found: ${providerId}`);
    }

    await provider.ensureConnected();

    const resolvedPath = await provider.resolveRemotePath(remotePath);
    // lineNumber/contextLines cross the IPC boundary as untyped JSON, so a malicious or
    // buggy renderer could send a non-integer value; TypeScript's `number` type isn't
    // enforced at runtime. Coerce to safe integers before they're interpolated into the
    // remote command line, so only digit characters can ever reach the sed range.
    const safeLine = Number.isInteger(lineNumber) && lineNumber >= 1 ? lineNumber : 1;
    const safeContext = Number.isInteger(contextLines) && contextLines >= 0 ? contextLines : 0;
    const startLine = Math.max(1, safeLine - safeContext);
    const endLine = safeLine + safeContext;
    const cmd = `sed -n '${startLine},${endLine}p' ${quotePathOperand(resolvedPath)}`;

    // stderr is non-fatal for preview purposes (e.g. permission edge cases); an empty
    // result surfaces as "no preview available" in the UI.
    const { stdout } = await provider.exec(cmd);
    const content = stdout.toString('utf-8');

    return { content, startLine };
  }

  public dispose(): void {
    for (const session of this.sessions.values()) {
      session.stop();
    }
    this.sessions.clear();
  }
}
