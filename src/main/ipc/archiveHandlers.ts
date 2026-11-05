import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { IpcBridge } from '../IpcBridge';
import { compressEntries, extractArchive } from '../archive/ArchiveService';
import { isSafeSegment, type ArchiveFormat } from '../archive/archiveCommands';

/** The part of IpcBridge this handler group may use. */
export type ArchiveHost = Pick<IpcBridge, 'registerHandler' | 'storageRegistry'>;

const MAX_ARCHIVE_ENTRIES = 5000;

function requireProvider(bridge: ArchiveHost, providerId: unknown) {
  const provider = typeof providerId === 'string' ? bridge.storageRegistry.get(providerId) : undefined;
  if (!provider) throw new Error(`Storage provider not found: ${String(providerId)}`);
  return provider;
}

export function registerArchiveHandlers(bridge: ArchiveHost): void {
  bridge.registerHandler(
    IPC_CHANNELS.ARCHIVE_COMPRESS,
    async (_event, providerId: string, parentDir: string, names: string[], format: ArchiveFormat): Promise<string> => {
      if (
        typeof parentDir !== 'string' ||
        parentDir.includes('\0') ||
        !Array.isArray(names) ||
        names.length === 0 ||
        names.length > MAX_ARCHIVE_ENTRIES ||
        !names.every(isSafeSegment) ||
        (format !== 'tar.gz' && format !== 'zip')
      ) {
        throw new Error('Invalid arguments');
      }
      return await compressEntries(requireProvider(bridge, providerId), parentDir, names, format);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.ARCHIVE_EXTRACT,
    async (_event, providerId: string, archivePath: string): Promise<string> => {
      if (typeof archivePath !== 'string' || !archivePath || archivePath.includes('\0')) {
        throw new Error('Invalid arguments');
      }
      return await extractArchive(requireProvider(bridge, providerId), archivePath);
    }
  );
}
