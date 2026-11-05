import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('electron', () => {
  const mockObj = {
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    app: { getPath: vi.fn().mockReturnValue('/tmp/user-data-unused') },
    safeStorage: {
      isEncryptionAvailable: vi.fn().mockReturnValue(false),
      encryptString: vi.fn(),
      decryptString: vi.fn(),
    },
    shell: { openPath: vi.fn().mockResolvedValue('') },
  };
  return { ...mockObj, default: mockObj };
});

import { IpcBridge } from '../../src/main/IpcBridge';

function makeBridge() {
  const webContents = Object.assign(new EventEmitter(), {
    id: 1,
    send: vi.fn(),
    isDestroyed: () => false,
  });
  const bridge = new IpcBridge({ getWebContents: () => webContents as never });
  return { bridge, webContents };
}

const hostKeyInfo = { host: 'h', port: 22, fingerprint: 'SHA256:x', keyType: 'ssh-ed25519', status: 'unknown' } as never;

/** The id of the prompt that was just sent to the window. */
const sentId = (webContents: { send: ReturnType<typeof vi.fn> }): string => {
  const payload = webContents.send.mock.calls.at(-1)![1] as { id: string };
  return payload.id;
};

describe('prompts whose window goes away', () => {
  it.each(['render-process-gone', 'destroyed'])(
    'settles every pending prompt with its safe answer when the window reports "%s"',
    async (event) => {
      const { bridge, webContents } = makeBridge();

      const hostKey = bridge.promptHostKeyTrust(hostKeyInfo);
      const pin = bridge.promptForPinDirect('PIN:', 'smartcard');
      const conflict = bridge.promptTransferConflict({ fileName: 'a', targetPath: '/a' } as never);
      const quit = bridge.promptQuitConfirm({ kind: 'confirm-before-quit' } as never);
      const dotfiles = (bridge as unknown as { promptDotfilesSync: (i: never) => Promise<string> }).promptDotfilesSync({} as never);

      webContents.emit(event);

      await expect(hostKey).resolves.toBe(false); // fail closed
      await expect(pin).resolves.toBe('');
      await expect(conflict).resolves.toEqual({ resolution: 'skip', applyToAll: false });
      await expect(quit).resolves.toBe(true); // nobody left to ask: the app can quit
      await expect(dotfiles).resolves.toBe('ignore');
      expect(bridge.pendingHostKeyPrompts.size).toBe(0);
      expect(bridge.pendingAskpass.size).toBe(0);
      expect(bridge.pendingTransferConflicts.size).toBe(0);
      expect(bridge.pendingQuitConfirms.size).toBe(0);
      expect(bridge.pendingDotfilesSyncPrompts.size).toBe(0);
    }
  );

  it('answers at once, with the safe answer, when the window had already crashed before the prompt', async () => {
    const { bridge, webContents } = makeBridge();
    (webContents as unknown as { isCrashed: () => boolean }).isCrashed = () => true;

    await expect(bridge.promptHostKeyTrust(hostKeyInfo)).resolves.toBe(false);
    await expect(bridge.promptQuitConfirm({ kind: 'confirm-before-quit' } as never)).resolves.toBe(true);
    await expect(bridge.promptForPinDirect('PIN:', 'smartcard')).resolves.toBe('');
    expect(bridge.pendingHostKeyPrompts.size).toBe(0);
    expect(bridge.pendingQuitConfirms.size).toBe(0);
    // Nothing is sent to the dead window: a reloaded renderer would otherwise show a dialog nobody can answer.
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it('keeps the user\'s answer, and stops watching the window once a prompt has been answered', async () => {
    const { bridge, webContents } = makeBridge();

    const quit = bridge.promptQuitConfirm({ kind: 'confirm-before-quit' } as never);
    const id = sentId(webContents);
    bridge.pendingQuitConfirms.get(id)!.callback(false); // the user chose not to quit

    await expect(quit).resolves.toBe(false);
    webContents.emit('render-process-gone'); // a crash later must not change that or throw
    expect(webContents.listenerCount('render-process-gone')).toBe(0);
    expect(webContents.listenerCount('destroyed')).toBe(0);
  });
});
