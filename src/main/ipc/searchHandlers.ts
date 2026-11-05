import type { SearchStartOptions } from '../../shared/types/search';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { IpcBridge } from '../IpcBridge';

/** The part of IpcBridge this handler group may use. */
export type SearchHost = Pick<
  IpcBridge,
  'registerHandler' | 'sendToSender' | 'searchOrchestrator' | 'storageRegistry'
>;

export function registerSearchHandlers(bridge: SearchHost): void {
  bridge.registerHandler(
    IPC_CHANNELS.SEARCH_START,
    async (event, options: SearchStartOptions) => {
      const sender = event?.sender;
      return await bridge.searchOrchestrator.startSearch(
        bridge.storageRegistry,
        options,
        (resultEvent) => {
          bridge.sendToSender(sender, IPC_CHANNELS.SEARCH_RESULT, resultEvent);
        },
        (errorEvent) => {
          bridge.sendToSender(sender, IPC_CHANNELS.SEARCH_ERROR, errorEvent);
        },
        (doneEvent) => {
          bridge.sendToSender(sender, IPC_CHANNELS.SEARCH_DONE, doneEvent);
        },
        (progressEvent) => {
          bridge.sendToSender(sender, IPC_CHANNELS.SEARCH_PROGRESS, progressEvent);
        }
      );
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.SEARCH_CANCEL,
    async (_event, searchId: string) => {
      bridge.searchOrchestrator.cancelSearch(searchId);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.SEARCH_PREVIEW,
    async (_event, providerId: string, remotePath: string, lineNumber: number, contextLines: number) => {
      return await bridge.searchOrchestrator.previewLines(
        bridge.storageRegistry,
        providerId,
        remotePath,
        lineNumber,
        contextLines
      );
    }
  );
}
