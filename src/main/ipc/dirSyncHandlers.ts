import { computeDiff as computeDirSyncDiff, apply as applyDirSync } from '../dirsync/DirectorySyncService';
import { IPC_CHANNELS, type DirSyncComputeDiffOptions, type DirSyncApplyOptions } from '../../shared/types/ipc';
import type { DirectoryDiffResult, DirectorySyncApplyResult, DirectorySyncProfile } from '../../shared/types/dirsync';
import type { IpcBridge } from '../IpcBridge';

/** The part of IpcBridge this handler group may use. */
export type DirSyncHost = Pick<
  IpcBridge,
  'directorySyncProfileStore' | 'registerHandler' | 'sendToSender' | 'storageRegistry'
>;
import { resolveDirSyncTargetRoot } from './ipcHelpers';

export function registerDirSyncHandlers(bridge: DirSyncHost): void {
  bridge.registerHandler(
    IPC_CHANNELS.DIR_SYNC_COMPUTE_DIFF,
    async (event, options: DirSyncComputeDiffOptions): Promise<DirectoryDiffResult> => {
      const sender = event?.sender;
      if (!options?.sourceProviderId || !options?.targetProviderId) {
        throw new Error('sourceProviderId and targetProviderId are required for directory sync');
      }
      const sourceProvider = bridge.storageRegistry.get(options.sourceProviderId);
      if (!sourceProvider) {
        throw new Error(`Source storage provider not found: ${options.sourceProviderId}`);
      }
      const targetProvider = bridge.storageRegistry.get(options.targetProviderId);
      if (!targetProvider) {
        throw new Error(`Target storage provider not found: ${options.targetProviderId}`);
      }

      const targetRoot = resolveDirSyncTargetRoot(
        options.sourcePath,
        targetProvider.type,
        options.targetPath
      );

      return computeDirSyncDiff(
        sourceProvider,
        options.sourcePath,
        targetProvider,
        targetRoot,
        (side, filesCount, currentItem) => {
          bridge.sendToSender(sender, IPC_CHANNELS.DIR_SYNC_SCAN_PROGRESS, { side, filesCount, currentItem });
        }
      );
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.DIR_SYNC_APPLY,
    async (event, options: DirSyncApplyOptions): Promise<DirectorySyncApplyResult> => {
      const sender = event?.sender;
      if (!options?.sourceProviderId || !options?.targetProviderId) {
        throw new Error('sourceProviderId and targetProviderId are required for directory sync apply');
      }
      const sourceProvider = bridge.storageRegistry.get(options.sourceProviderId);
      if (!sourceProvider) {
        throw new Error(`Source storage provider not found: ${options.sourceProviderId}`);
      }
      const targetProvider = bridge.storageRegistry.get(options.targetProviderId);
      if (!targetProvider) {
        throw new Error(`Target storage provider not found: ${options.targetProviderId}`);
      }

      const targetRoot = resolveDirSyncTargetRoot(
        options.sourcePath,
        targetProvider.type,
        options.targetPath
      );

      const result = await applyDirSync(
        options.entries ?? [],
        sourceProvider,
        targetProvider,
        targetRoot,
        { deleteExtraneous: Boolean(options.deleteExtraneous) },
        (progress) => {
          bridge.sendToSender(sender, IPC_CHANNELS.DIR_SYNC_APPLY_PROGRESS, progress);
        }
      );

      // Piggyback a synthetic "completed" TRANSFER_PROGRESS event so any
      // open pane auto-refreshes its listing, same as a regular transfer.
      bridge.sendToSender(sender, IPC_CHANNELS.TRANSFER_PROGRESS, {
        jobId: 'dirsync-apply',
        fileName: '',
        transferredBytes: 0,
        totalBytes: 0,
        percentage: 100,
        bytesPerSecond: 0,
        status: 'completed',
      });

      return result;
    }
  );

  bridge.registerHandler(IPC_CHANNELS.DIR_SYNC_PROFILE_LIST, async (): Promise<DirectorySyncProfile[]> => {
    return bridge.directorySyncProfileStore.list();
  });

  bridge.registerHandler(
    IPC_CHANNELS.DIR_SYNC_PROFILE_SAVE,
    async (_event, profile: DirectorySyncProfile): Promise<DirectorySyncProfile> => {
      return bridge.directorySyncProfileStore.save(profile);
    }
  );

  bridge.registerHandler(IPC_CHANNELS.DIR_SYNC_PROFILE_DELETE, async (_event, id: string): Promise<void> => {
    await bridge.directorySyncProfileStore.delete(id);
  });
}
