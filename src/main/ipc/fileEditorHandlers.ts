import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { IpcBridge } from '../IpcBridge';
import type { CertificatePreviewResult } from '../../shared/types/certificate';
import { isCertificateFileName } from '../../shared/certificateFileName';
import { describeCertificateFile, MAX_CERTIFICATE_FILE_BYTES } from '../certs/certificateInfo';
import { assertStrings } from './ipcHelpers';

/** The part of IpcBridge this handler group may use. */
export type FileEditorHost = Pick<
  IpcBridge,
  'fileEditorService' | 'fileTailService' | 'registerHandler' | 'sendToSender' | 'storageRegistry'
>;

async function ensureLocalProvider(bridge: FileEditorHost, providerId: string): Promise<void> {
  if (providerId === 'local' && !bridge.storageRegistry.has('local')) {
    await bridge.storageRegistry.getOrCreate({ id: 'local', name: 'Local Disk', type: 'local' });
  }
}

export function registerFileEditorHandlers(bridge: FileEditorHost): void {
  bridge.registerHandler(
    IPC_CHANNELS.FILE_READ,
    async (_event, providerId: string, remotePath: string, maxBytes?: number) => {
      await ensureLocalProvider(bridge, providerId);
      return await bridge.fileEditorService.readFile(
        bridge.storageRegistry,
        providerId,
        remotePath,
        maxBytes
      );
    }
  );

  // Parsed here so that nothing but certificate facts reaches the renderer: a .pem often holds a private key too.
  bridge.registerHandler(
    IPC_CHANNELS.CERTIFICATE_PREVIEW,
    async (_event, providerId: string, remotePath: string, host?: string): Promise<CertificatePreviewResult> => {
      assertStrings({ providerId, remotePath });
      if (!isCertificateFileName(remotePath)) return { certs: [], moreCerts: 0, error: 'none' };
      try {
        await ensureLocalProvider(bridge, providerId);
        const read = await bridge.fileEditorService.readBytes(
          bridge.storageRegistry,
          providerId,
          remotePath,
          MAX_CERTIFICATE_FILE_BYTES
        );
        if ('isDirectory' in read) return { certs: [], moreCerts: 0, error: 'none' };
        if (read.truncated) return { certs: [], moreCerts: 0, error: 'too-large' };
        return describeCertificateFile(read.buffer, Date.now(), host);
      } catch {
        // The error text can name the path or the host; the preview only needs to know it failed.
        return { certs: [], moreCerts: 0, error: 'unreadable' };
      }
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.FILE_SAVE,
    async (_event, providerId: string, remotePath: string, content: string) => {
      await ensureLocalProvider(bridge, providerId);
      await bridge.fileEditorService.saveFile(
        bridge.storageRegistry,
        providerId,
        remotePath,
        content
      );
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.FILE_OPEN_EXTERNAL,
    async (event, providerId: string, remotePath: string) => {
      const sender = event?.sender;
      await ensureLocalProvider(bridge, providerId);
      return await bridge.fileEditorService.openInExternalEditor(
        bridge.storageRegistry,
        providerId,
        remotePath,
        (statusEvent) => {
          bridge.sendToSender(sender, IPC_CHANNELS.FILE_EXTERNAL_STATUS, statusEvent);
        }
      );
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.FILE_CLOSE_EXTERNAL,
    async (_event, sessionToken: string) => {
      await bridge.fileEditorService.closeExternalEditor(sessionToken);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.FILE_TAIL_START,
    async (event, providerId: string, remotePath: string) => {
      const sender = event?.sender;
      await ensureLocalProvider(bridge, providerId);
      return await bridge.fileTailService.startTail(
        bridge.storageRegistry,
        providerId,
        remotePath,
        (dataEvent) => {
          bridge.sendToSender(sender, IPC_CHANNELS.FILE_TAIL_DATA, dataEvent);
        },
        (errorEvent) => {
          bridge.sendToSender(sender, IPC_CHANNELS.FILE_TAIL_ERROR, errorEvent);
        }
      );
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.FILE_TAIL_STOP,
    async (_event, tailId: string) => {
      bridge.fileTailService.stopTail(tailId);
    }
  );
}
