import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeImage } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { IpcBridge } from '../IpcBridge';
import { DragOutService } from '../dragout/DragOutService';

/** The part of IpcBridge this handler group may use. */
export type DragOutHost = Pick<IpcBridge, 'registerHandler' | 'dragOutService'>;

const MAX_DRAG_OUT_PATHS = 500;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
/** 1x1 transparent PNG used when the app icon cannot be loaded. */
const FALLBACK_ICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * Returns the paths that may be handed to the OS as a drag source: absolute, NUL-free
 * and existing as a regular file or directory. Anything else is dropped.
 */
export async function validateDragOutPaths(input: unknown): Promise<string[]> {
  if (!Array.isArray(input)) return [];
  const valid: string[] = [];
  for (const candidate of input.slice(0, MAX_DRAG_OUT_PATHS)) {
    if (typeof candidate !== 'string' || !candidate || candidate.includes('\0') || !path.isAbsolute(candidate)) {
      continue;
    }
    try {
      const stats = await fs.stat(candidate);
      if (stats.isFile() || stats.isDirectory()) valid.push(candidate);
    } catch {
      // missing or unreadable: not draggable
    }
  }
  return valid;
}

function dragIcon(): Electron.NativeImage {
  const iconPath = process.env.VITE_DEV_SERVER_URL
    ? path.join(moduleDir, '../../build/icon.png')
    : path.join(moduleDir, '../build/icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  // startDrag needs a non-empty icon (an empty one can fail the drag on macOS/Windows), so fall back to a 1x1 pixel
  return icon.isEmpty() ? nativeImage.createFromBuffer(FALLBACK_ICON_PNG) : icon.resize({ width: 48, height: 48 });
}

export function createDragOutService(host: Pick<IpcBridge, 'storageRegistry' | 'transferQueue'>): DragOutService {
  return new DragOutService({
    getSource: (id) => host.storageRegistry.get(id),
    getLocal: () => host.storageRegistry.getOrCreate({ id: 'local', name: 'Local Disk', type: 'local' }),
    queue: host.transferQueue,
  });
}

export function registerDragOutHandlers(bridge: DragOutHost): void {
  // Downloads remote files/folders to a private temp dir so they can be started as a native drag.
  bridge.registerHandler(IPC_CHANNELS.DRAG_OUT_PREPARE, async (_event, providerId: unknown, paths: unknown) =>
    bridge.dragOutService.prepare(providerId, paths)
  );

  // Starts a native OS drag of local files/folders so they can be dropped outside sshs3.
  bridge.registerHandler(IPC_CHANNELS.DRAG_OUT_START, async (event, paths: unknown): Promise<boolean> => {
    const files = await validateDragOutPaths(paths);
    if (files.length === 0) return false;
    event.sender.startDrag({ file: files[0], files, icon: dragIcon() });
    return true;
  });
}
