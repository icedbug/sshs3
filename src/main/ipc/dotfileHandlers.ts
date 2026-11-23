import os from 'node:os';
import { dialog as electronDialog } from 'electron';
import { defaultDotfileRemotePath } from '../../shared/dotfilePath';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { DotfilePool, DotfilesSyncResolution } from '../../shared/types/dotfiles';
import type { IpcBridge } from '../IpcBridge';

/** The part of IpcBridge this handler group may use. */
export type DotfileHost = Pick<
  IpcBridge,
  'dotfilePoolStore' | 'localFilesDir' | 'pendingDotfilesSyncPrompts' | 'registerHandler' | 'scheduleAutoSync' | 'storageRegistry'
>;

export function registerDotfileHandlers(bridge: DotfileHost): void {
  bridge.registerHandler(IPC_CHANNELS.DOTFILES_POOLS_GET, async (): Promise<DotfilePool[]> => {
    return await bridge.dotfilePoolStore.getPools();
  });

  bridge.registerHandler(IPC_CHANNELS.DOTFILES_POOLS_SAVE, async (_event, pool: DotfilePool) => {
    await bridge.dotfilePoolStore.savePool(pool);
    bridge.scheduleAutoSync();
  });

  bridge.registerHandler(IPC_CHANNELS.DOTFILES_POOLS_DELETE, async (_event, id: string) => {
    await bridge.dotfilePoolStore.deletePool(id);
    bridge.scheduleAutoSync();
  });

  bridge.registerHandler(IPC_CHANNELS.DOTFILES_OPEN_FOLDER, async (_event, poolId: string) => {
    return await bridge.dotfilePoolStore.openPoolFolder(poolId);
  });

  bridge.registerHandler(IPC_CHANNELS.DOTFILES_SELECT_FILES, async () => {
    const result = await electronDialog.showOpenDialog({
      title: 'Select files to add to the pool',
      defaultPath: os.homedir(),
      properties: ['openFile', 'multiSelections', 'showHiddenFiles'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }
    return await bridge.dotfilePoolStore.importLocalFiles(result.filePaths);
  });

  // Re-reads local source files of pooled entries (status check / Refresh).
  // Files that are missing or no longer importable are simply absent.
  bridge.registerHandler(IPC_CHANNELS.DOTFILES_READ_SOURCES, async (_event, paths: string[]) => {
    if (!Array.isArray(paths) || paths.length > 500 || !paths.every((p) => typeof p === 'string')) {
      throw new Error('Invalid source path list');
    }
    return await bridge.dotfilePoolStore.importLocalFiles(paths);
  });

  bridge.registerHandler(
    IPC_CHANNELS.DOTFILES_ADD_FROM_STORAGE,
    async (
      _event,
      options: {
        poolId: string;
        providerId: string;
        filePath: string;
        targetRemotePath?: string;
      }
    ) => {
      const provider = bridge.storageRegistry.get(options.providerId);
      if (!provider) {
        throw new Error(`Storage provider not found: ${options.providerId}`);
      }
      const stream = await provider.createReadStream(options.filePath);
      const chunks: Buffer[] = [];
      const content = await new Promise<string>((resolve, reject) => {
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        stream.on('error', reject);
      });

      let mode: string | undefined;
      try {
        const stat = await provider.stat(options.filePath);
        if (stat.permissions) {
          mode = stat.permissions;
        }
      } catch {
        // Ignore stat error
      }

      const remotePath =
        options.targetRemotePath || defaultDotfileRemotePath(options.filePath, bridge.localFilesDir ?? os.homedir());

      const added = await bridge.dotfilePoolStore.addFileToPool(options.poolId, {
        remotePath,
        content,
        mode,
        sourcePath: provider.type === 'local' ? options.filePath : undefined,
      });
      bridge.scheduleAutoSync();
      return added;
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.DOTFILES_SYNC_RESPOND,
    async (_event, id: string, resolution: DotfilesSyncResolution) => {
      const prompt = bridge.pendingDotfilesSyncPrompts.get(id);
      if (!prompt) {
        throw new Error(`Dotfiles sync prompt with id "${id}" not found or expired`);
      }
      bridge.pendingDotfilesSyncPrompts.delete(id);
      prompt.callback(resolution);
    }
  );
}
