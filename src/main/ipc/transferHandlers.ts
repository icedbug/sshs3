import { getBaseName, isDirectoryPath, pathExists, resolveNonConflictingPath, joinPaths } from '../transfer/TransferPipeline';
import { SAME_FILE_ERROR, isSameFileOnProvider, resolverFor } from '../transfer/transferPaths';
import { IPC_CHANNELS, type TransferConflictResolution } from '../../shared/types/ipc';
import type { TransferProgress } from '../../shared/types/storage';
import type { IpcBridge } from '../IpcBridge';

/** The part of IpcBridge this handler group may use. */
export type TransferHost = Pick<
  IpcBridge,
  'pendingQuitConfirms' | 'pendingTransferConflicts' | 'promptTransferConflict' | 'registerHandler' | 'settingsStore' | 'storageRegistry' | 'transferQueue'
>;

export function registerTransferHandlers(bridge: TransferHost): void {
  bridge.registerHandler(
    IPC_CHANNELS.TRANSFER_ADD,
    async (
      _event,
      options: {
        sourceProviderId: string;
        sourcePath: string;
        targetProviderId: string;
        targetPath: string;
        conflictPolicy?: TransferConflictResolution;
        verifyIntegrity?: boolean;
        verifyChecksum?: boolean | 'sha256' | 'md5';
        expectedChecksum?: string;
      }
    ): Promise<{
      jobId: string | null;
      skipped?: boolean;
      resolvedPolicy?: TransferConflictResolution;
      appliedToAll?: boolean;
      /** The path the transfer writes to (differs from the requested one after nesting or "rename"). */
      targetPath?: string;
    }> => {
      if (!options?.sourceProviderId || !options?.targetProviderId) {
        throw new Error('sourceProviderId and targetProviderId are required for transfer');
      }
      const sourceProvider = bridge.storageRegistry.get(options.sourceProviderId);
      if (!sourceProvider) {
        throw new Error(`Source storage provider not found: ${options.sourceProviderId}`);
      }
      const targetProvider = bridge.storageRegistry.get(options.targetProviderId);
      if (!targetProvider) {
        throw new Error(`Target storage provider not found: ${options.targetProviderId}`);
      }

      let isDirectory = false;
      let totalBytes: number | undefined;
      let isSpecial = false;
      try {
        const srcStat = await sourceProvider.stat(options.sourcePath);
        isDirectory = Boolean(srcStat.isDirectory);
        totalBytes = srcStat.size;
        isSpecial = Boolean(srcStat.isSpecial);
      } catch {
        // ignore error if stat not available
      }
      if (isSpecial) {
        // A FIFO, socket or device: reading it would block, and there is nothing to copy.
        throw new Error(`Not a regular file: ${getBaseName(options.sourcePath) || options.sourcePath}`);
      }

      let resolvedTargetPath = options.targetPath;
      const sourceBaseName = getBaseName(options.sourcePath);
      if (sourceBaseName && (await isDirectoryPath(targetProvider, resolvedTargetPath))) {
        resolvedTargetPath = joinPaths(targetProvider.type, resolvedTargetPath, sourceBaseName);
      }

      let resolvedPolicy: TransferConflictResolution | undefined;
      let appliedToAll = false;

      if (await pathExists(targetProvider, resolvedTargetPath)) {
        const requestedPolicy = options.conflictPolicy ?? 'ask';
        if (requestedPolicy === 'ask') {
          const response = await bridge.promptTransferConflict({
            sourcePath: options.sourcePath,
            targetPath: resolvedTargetPath,
            fileName: sourceBaseName || resolvedTargetPath,
            isDirectory,
          });
          resolvedPolicy = response.resolution;
          appliedToAll = response.applyToAll;
        } else {
          resolvedPolicy = requestedPolicy;
        }

        if (resolvedPolicy === 'skip') {
          return { jobId: null, skipped: true, resolvedPolicy, appliedToAll, targetPath: resolvedTargetPath };
        }
        if (resolvedPolicy === 'rename') {
          resolvedTargetPath = await resolveNonConflictingPath(
            targetProvider,
            targetProvider.type,
            resolvedTargetPath
          );
        }
        // 'overwrite' proceeds with resolvedTargetPath unchanged.
      }

      // Overwriting a file with itself would truncate it while it is still being read ("rename" has already
      // produced a different path by now, so copying into the same folder still works as a duplicate).
      if (
        options.sourceProviderId === options.targetProviderId &&
        (await isSameFileOnProvider(sourceProvider.type, options.sourcePath, resolvedTargetPath, resolverFor(sourceProvider)))
      ) {
        throw new Error(SAME_FILE_ERROR);
      }

      const settings = await bridge.settingsStore.getSettings();
      const verifyIntegrity = options.verifyIntegrity ?? settings.verifyTransferIntegrity ?? true;

      const job = bridge.transferQueue.addJob({
        sourceProvider,
        sourcePath: options.sourcePath,
        targetProvider,
        targetPath: resolvedTargetPath,
        isDirectory,
        totalBytes,
        verifyIntegrity,
        verifyChecksum: options.verifyChecksum,
        expectedChecksum: options.expectedChecksum,
      });

      return { jobId: job.id, resolvedPolicy, appliedToAll, targetPath: resolvedTargetPath };
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.TRANSFER_CONFLICT_RESPOND,
    async (_event, id: string, resolution: TransferConflictResolution, applyToAll: boolean) => {
      const prompt = bridge.pendingTransferConflicts.get(id);
      if (!prompt) {
        throw new Error(`Transfer conflict prompt with id "${id}" not found or expired`);
      }
      bridge.pendingTransferConflicts.delete(id);
      prompt.callback(resolution, Boolean(applyToAll));
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.QUIT_CONFIRM_RESPOND,
    async (_event, id: string, proceed: boolean) => {
      const prompt = bridge.pendingQuitConfirms.get(id);
      if (!prompt) {
        throw new Error(`Quit confirm prompt with id "${id}" not found or expired`);
      }
      bridge.pendingQuitConfirms.delete(id);
      prompt.callback(Boolean(proceed));
    }
  );

  bridge.registerHandler(IPC_CHANNELS.TRANSFER_PAUSE, async (_event, jobId: string) => {
    bridge.transferQueue.pauseJob(jobId);
  });

  bridge.registerHandler(IPC_CHANNELS.TRANSFER_RESUME, async (_event, jobId: string) => {
    bridge.transferQueue.resumeJob(jobId);
  });

  bridge.registerHandler(IPC_CHANNELS.TRANSFER_CANCEL, async (_event, jobId: string) => {
    bridge.transferQueue.cancelJob(jobId);
  });

  bridge.registerHandler(IPC_CHANNELS.TRANSFER_GET_JOBS, async (): Promise<TransferProgress[]> => {
    return bridge.transferQueue.getJobs().map((j) => j.progress);
  });

  bridge.registerHandler(IPC_CHANNELS.TRANSFER_CLEAR_COMPLETED, async (): Promise<void> => {
    bridge.transferQueue.clearCompleted();
  });
}
