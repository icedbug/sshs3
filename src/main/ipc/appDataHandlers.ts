import { SNIPPET_MAX_NAME_CHARS } from '../../shared/types/snippets';
import { getBuiltinSnippets } from '../ai/hub/demoWorkspace';
import { resolveLogLevel, setLogLevel } from '../log/Logger';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { SessionData } from '../../shared/types/session';
import type { AppSettings } from '../../shared/types/settings';
import type { IpcBridge } from '../IpcBridge';
import type { SmartcardCoordinator } from '../smartcard/SmartcardCoordinator';

/** The part of IpcBridge this handler group may use. */
export type AppDataHost = Pick<
  IpcBridge,
  'clipboardHistoryStore' | 'profileSyncService' | 'registerHandler' | 'scheduleAutoSync' | 'sessionStore' | 'settingsStore' | 'snippetStore'
> & {
  smartcard: Pick<SmartcardCoordinator, 'refreshAgentSshConfig'>;
};

export function registerSessionHandlers(bridge: AppDataHost): void {
  bridge.registerHandler(IPC_CHANNELS.SESSION_GET, async (): Promise<SessionData | null> => {
    return await bridge.sessionStore.getSession();
  });

  bridge.registerHandler(
    IPC_CHANNELS.SESSION_SAVE,
    async (_event, data: SessionData): Promise<void> => {
      await bridge.sessionStore.saveSession(data);
    }
  );
}

export function registerClipboardHistoryHandlers(bridge: AppDataHost): void {
  const isShortString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

  bridge.registerHandler(IPC_CHANNELS.CLIPBOARD_HISTORY_LIST, async (_event, hostKey?: unknown) => {
    if (hostKey !== undefined && !isShortString(hostKey, 1024)) throw new Error('Invalid host key');
    return await bridge.clipboardHistoryStore.list(hostKey);
  });

  bridge.registerHandler(
    IPC_CHANNELS.CLIPBOARD_HISTORY_ADD,
    async (_event, text: unknown, hostKey: unknown, hostLabel: unknown): Promise<void> => {
      if (typeof text !== 'string' || !isShortString(hostKey, 1024) || !isShortString(hostLabel, 1024)) {
        throw new Error('Invalid clipboard history entry');
      }
      await bridge.clipboardHistoryStore.add(text, hostKey, hostLabel);
    }
  );

  bridge.registerHandler(IPC_CHANNELS.CLIPBOARD_HISTORY_DELETE, async (_event, id: unknown): Promise<void> => {
    if (!isShortString(id, 128)) throw new Error('Invalid entry id');
    await bridge.clipboardHistoryStore.delete(id);
  });

  bridge.registerHandler(IPC_CHANNELS.CLIPBOARD_HISTORY_CLEAR, async (): Promise<void> => {
    await bridge.clipboardHistoryStore.clear();
  });
}

export function registerSnippetHandlers(bridge: AppDataHost): void {
  bridge.registerHandler(IPC_CHANNELS.SNIPPETS_LIST, async (_event, hostKey?: unknown) => {
    if (hostKey !== undefined && (typeof hostKey !== 'string' || hostKey.length > 1024)) {
      throw new Error('Invalid host key');
    }
    const list = await bridge.snippetStore.list(hostKey);
    const merged = [...list];
    for (const ds of getBuiltinSnippets()) {
      if (!merged.some((s) => s.id === ds.id)) merged.push(ds);
    }
    return merged;
  });

  bridge.registerHandler(IPC_CHANNELS.SNIPPETS_SAVE, async (_event, input: unknown) => {
    const s = input as Record<string, unknown> | null;
    const optionalString = (v: unknown, max: number): boolean =>
      v === undefined || (typeof v === 'string' && v.length <= max);
    if (
      !s ||
      typeof s.name !== 'string' ||
      s.name.length > SNIPPET_MAX_NAME_CHARS * 2 ||
      typeof s.command !== 'string' ||
      !optionalString(s.id, 128) ||
      !optionalString(s.hostKey, 1024) ||
      !optionalString(s.hostLabel, 1024)
    ) {
      throw new Error('Invalid snippet');
    }
    return await bridge.snippetStore.save({
      id: s.id as string | undefined,
      name: s.name,
      command: s.command,
      hostKey: s.hostKey as string | undefined,
      hostLabel: s.hostLabel as string | undefined,
    });
  });

  bridge.registerHandler(IPC_CHANNELS.SNIPPETS_DELETE, async (_event, id: unknown): Promise<void> => {
    if (typeof id !== 'string' || id.length > 128) throw new Error('Invalid snippet id');
    await bridge.snippetStore.delete(id);
  });
}

export function registerSettingsHandlers(bridge: AppDataHost): void {
  bridge.registerHandler(IPC_CHANNELS.SETTINGS_GET, async (): Promise<AppSettings> => {
    return await bridge.settingsStore.getSettings();
  });

  bridge.registerHandler(
    IPC_CHANNELS.SETTINGS_SAVE,
    async (_event, settings: Partial<AppSettings>): Promise<AppSettings> => {
      const saved = await bridge.settingsStore.saveSettings(settings);
      if ('logLevel' in settings) setLogLevel(resolveLogLevel(saved.logLevel));
      // autoSync refreshes the agent block itself afterwards (and removes it when turned off).
      if ('autoSyncLocalSshConfig' in settings) void bridge.profileSyncService.autoSyncLocalSshConfig();
      else if ('smartcardAuthMode' in settings) bridge.smartcard.refreshAgentSshConfig();
      bridge.scheduleAutoSync();
      return saved;
    }
  );
}
