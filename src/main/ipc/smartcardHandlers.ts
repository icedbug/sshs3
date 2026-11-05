import path from 'node:path';
import { SmartcardDetector } from '../smartcard/SmartcardDetector';
import { applyWindowsAgentPathFix, getWindowsAgentPathStatus } from '../smartcard/WindowsAgentPath';
import { generateFido2Key, listFido2ResidentKeys, deleteFido2ResidentKey } from '../smartcard/Fido2KeyManager';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { GenerateFido2KeyRequest, GeneratedFido2Key, Fido2ResidentKey } from '../../shared/types/ssh';
import type { IpcBridge } from '../IpcBridge';
import type { SmartcardCoordinator } from '../smartcard/SmartcardCoordinator';

/** The part of IpcBridge this handler group may use. */
export type SmartcardHost = Pick<
  IpcBridge,
  'makePresenceNotifier' | 'pendingAskpass' | 'pendingInsertTokens' | 'pendingHostKeyPrompts' | 'promptForPinDirect' | 'registerHandler'
> & {
  smartcard: Pick<
    SmartcardCoordinator,
    'listGlobalSmartcardAgents' | 'lockAllGlobalSmartcardAgents' | 'maybeUnlockSmartcardAtStartup'
  >;
};

export function registerSmartcardHandlers(bridge: SmartcardHost): void {
  bridge.registerHandler(IPC_CHANNELS.SMARTCARD_DETECT, async () => {
    return await SmartcardDetector.detectAvailableLibraries(undefined, { onlyExisting: true });
  });

  // Only modules the app itself detected may be acted on: the fix edits the *system* PATH, so an
  // arbitrary renderer-supplied path must never reach it.
  const requireDetectedLib = async (libPath: string): Promise<string> => {
    const detected = await SmartcardDetector.detectAvailableLibraries(undefined, { onlyExisting: true });
    const match = detected.find((l) => l.path.toLowerCase() === String(libPath).toLowerCase());
    if (!match) throw new Error('Not a detected smartcard library.');
    return match.path;
  };

  bridge.registerHandler(IPC_CHANNELS.SMARTCARD_AGENT_PATH_STATUS, async (_event, libPath: string) => {
    if (process.platform !== 'win32') return { applicable: false, needsFix: false };
    try {
      return await getWindowsAgentPathStatus(await requireDetectedLib(libPath));
    } catch {
      return { applicable: false, needsFix: false };
    }
  });

  bridge.registerHandler(IPC_CHANNELS.SMARTCARD_AGENT_PATH_FIX, async (_event, libPath: string) => {
    const libDir = path.dirname(await requireDetectedLib(libPath));
    await applyWindowsAgentPathFix(libDir);
  });

  bridge.registerHandler(
    IPC_CHANNELS.SMARTCARD_VALIDATE,
    async (_event, libPath: string) => {
      const valid = await SmartcardDetector.validateLibraryPath(libPath);
      if (valid) {
        return { valid: true };
      }
      return { valid: false, error: 'Library file not found or invalid' };
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.ASKPASS_SUBMIT_PIN,
    async (_event, id: string, pin: string) => {
      const prompt = bridge.pendingAskpass.get(id);
      if (!prompt) {
        throw new Error(`Askpass prompt with id "${id}" not found or expired`);
      }
      bridge.pendingAskpass.delete(id);
      prompt.callback(pin);
    }
  );

  bridge.registerHandler(IPC_CHANNELS.INSERT_TOKEN_CANCEL, async (_event, id: string) => {
    // Already finished (token inserted, or cancelled twice): nothing to do.
    if (typeof id === 'string') bridge.pendingInsertTokens.get(id)?.();
  });

  bridge.registerHandler(IPC_CHANNELS.SMARTCARD_LOCK_ALL, async () => {
    return { locked: await bridge.smartcard.lockAllGlobalSmartcardAgents() };
  });

  bridge.registerHandler(IPC_CHANNELS.SMARTCARD_LIST_CACHED, async () => {
    return bridge.smartcard.listGlobalSmartcardAgents();
  });

  bridge.registerHandler(IPC_CHANNELS.SMARTCARD_UNLOCK_AT_STARTUP, async () => {
    return bridge.smartcard.maybeUnlockSmartcardAtStartup();
  });

  bridge.registerHandler(IPC_CHANNELS.SMARTCARD_UNLOCK_NOW, async () => {
    return bridge.smartcard.maybeUnlockSmartcardAtStartup({ force: true });
  });

  bridge.registerHandler(
    IPC_CHANNELS.HOSTKEY_RESPOND,
    async (_event, id: string, trust: boolean) => {
      const prompt = bridge.pendingHostKeyPrompts.get(id);
      if (!prompt) {
        throw new Error(`Host key prompt with id "${id}" not found or expired`);
      }
      bridge.pendingHostKeyPrompts.delete(id);
      prompt.callback(Boolean(trust));
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.FIDO2_GENERATE_KEY,
    async (_event, options: GenerateFido2KeyRequest): Promise<GeneratedFido2Key> => {
      const { onPresenceRequested, onPresenceCleared } = bridge.makePresenceNotifier(
        undefined,
        'Touch your security key to authorize the new SSH key'
      );
      return generateFido2Key({
        ...options,
        promptHandler: (prompt) => bridge.promptForPinDirect(prompt, 'fido2'),
        onPresenceRequested,
        onPresenceCleared,
      });
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.FIDO2_LIST_RESIDENT_KEYS,
    async (): Promise<Fido2ResidentKey[]> => {
      const { onPresenceRequested, onPresenceCleared } = bridge.makePresenceNotifier(
        undefined,
        'Touch your security key to read its stored SSH keys'
      );
      return listFido2ResidentKeys(
        (prompt) => bridge.promptForPinDirect(prompt, 'fido2'),
        { onPresenceRequested, onPresenceCleared }
      );
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.FIDO2_DELETE_RESIDENT_KEY,
    async (_event, credentialId: string): Promise<void> => {
      return deleteFido2ResidentKey(credentialId, (prompt) => bridge.promptForPinDirect(prompt, 'fido2'));
    }
  );
}
