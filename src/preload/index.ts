import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { MultiSSHApi } from '../shared/types/ipc';
import { createMultiSSHApi } from '../shared/ipc/createMultiSSHApi';

export const api: MultiSSHApi = createMultiSSHApi({
  invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, listener: (_event: any, ...args: any[]) => void) => {
    ipcRenderer.on(channel, listener);
  },
  removeListener: (channel: string, listener: (_event: any, ...args: any[]) => void) => {
    ipcRenderer.removeListener(channel, listener);
  },
  getPathForFile: (file: File) => {
    try {
      return webUtils?.getPathForFile ? webUtils.getPathForFile(file) : (file as any)?.path || '';
    } catch {
      return (file as any)?.path || '';
    }
  },
  enableNativeHermes: typeof process !== 'undefined' && Array.isArray(process.argv) && process.argv.includes('--sshs3-native-hermes'),
});

export function exposePreloadApi(): void {
  try {
    contextBridge.exposeInMainWorld('sshs3', api);
    contextBridge.exposeInMainWorld('multissh', api);
  } catch {
    // Safely ignore when run outside electron preload environment
  }
}

exposePreloadApi();
