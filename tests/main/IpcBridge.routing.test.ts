import { describe, it, expect, vi } from 'vitest';

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
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { WindowManager, type ManagedWindow, type WindowActions } from '../../src/main/windows/WindowManager';

function fakeWindow(id: number) {
  const send = vi.fn();
  const frame = {};
  const win: ManagedWindow & { send: typeof send; frame: object } = {
    send,
    frame,
    webContents: { id, mainFrame: frame, isDestroyed: () => false, send },
    isDestroyed: () => false,
  };
  return win;
}

function makeBridge() {
  const windows = new WindowManager();
  const a = fakeWindow(1);
  const b = fakeWindow(2);
  windows.register(a);
  windows.register(b);
  windows.setFocused(1);
  const bridge = new IpcBridge({
    windows,
    isTrustedFrame: (frame) => windows.isTrustedFrame(frame),
    getWebContents: () => windows.focusedWebContents() as never,
  });
  return { bridge, windows, a, b };
}

describe('IpcBridge multi-window routing', () => {
  it('sends session events to the owning window only', () => {
    const { bridge, a, b } = makeBridge();
    bridge.assignSession(b.webContents as never, 'sess-1');

    bridge.sendToSession('sess-1', 'terminal:data', 'sess-1', 'hello');

    expect(b.send).toHaveBeenCalledWith('terminal:data', 'sess-1', 'hello');
    expect(a.send).not.toHaveBeenCalled();
  });

  it('only assigns sessions for senders that are registered windows', () => {
    const { bridge, windows } = makeBridge();
    bridge.assignSession({ id: 99 } as never, 'sess-x');
    bridge.assignSession(undefined, 'sess-y');
    expect(windows.ownerOf('sess-x')).toBeUndefined();
    expect(windows.ownerOf('sess-y')).toBeUndefined();
  });

  it('tells every window that the kubeconfig changed, and gives the exec-auth warning to the focused one only', async () => {
    const { bridge, a, b } = makeBridge();
    bridge.register();
    const k8s = bridge.k8sDiscoveryService as unknown as { pendingExecAuthWarning: string | null; changeListeners: Set<() => void> };
    k8s.pendingExecAuthWarning = 'new exec-auth user';

    for (const listener of [...k8s.changeListeners]) listener();

    expect(a.send).toHaveBeenCalledTimes(1);
    expect(a.send).toHaveBeenCalledWith('k8s:config-changed', 'new exec-auth user');
    expect(b.send).toHaveBeenCalledTimes(1);
    expect(b.send).toHaveBeenCalledWith('k8s:config-changed');
    expect(k8s.pendingExecAuthWarning).toBeNull();
    await bridge.dispose();
  });

  it('sends prompts and ownerless events to the focused window', () => {
    const { bridge, a, b } = makeBridge();
    bridge.sendToFocused('prompt');
    bridge.sendToSession(undefined, 'ownerless');
    expect(a.send).toHaveBeenCalledTimes(2);
    expect(b.send).not.toHaveBeenCalled();
  });

  it('broadcasts app-wide state to every window', () => {
    const { bridge, a, b } = makeBridge();
    bridge.broadcast('update:state', { s: 1 });
    expect(a.send).toHaveBeenCalledWith('update:state', { s: 1 });
    expect(b.send).toHaveBeenCalledWith('update:state', { s: 1 });
  });

  it('replies to the window that issued the request, even when it is not focused', () => {
    const { bridge, a, b } = makeBridge();
    bridge.sendToSender(b.webContents as never, 'search:result', { n: 1 });
    expect(b.send).toHaveBeenCalledWith('search:result', { n: 1 });
    expect(a.send).not.toHaveBeenCalled();
  });

  it('falls back to the focused window when the requesting window is gone', () => {
    const { bridge, a } = makeBridge();
    const gone = { isDestroyed: () => true, send: vi.fn() };
    bridge.sendToSender(gone as never, 'search:done');
    expect(gone.send).not.toHaveBeenCalled();
    expect(a.send).toHaveBeenCalledWith('search:done');
  });

  it('without a window router everything goes to the focused window', () => {
    const bridge = new IpcBridge({});
    const send = vi.fn();
    bridge.getWebContents = () => ({ isDestroyed: () => false, send }) as never;
    bridge.assignSession({ id: 1 } as never, 's');
    bridge.sendToSession('s', 'ch', 1);
    bridge.broadcast('ch2');
    expect(send).toHaveBeenCalledWith('ch', 1);
    expect(send).toHaveBeenCalledWith('ch2');
  });

  describe('moving tabs', () => {
    const handoff = { tab: { id: 't1', type: 'terminal' }, sessions: [] };

    function bridgeWithActions() {
      const { windows, a, b } = makeBridge();
      const actions: WindowActions = {
        open: vi.fn(),
        adopt: vi.fn().mockReturnValue(true),
        takeHandoff: vi.fn().mockReturnValue(handoff),
        list: vi.fn().mockReturnValue([]),
      };
      const bridge = new IpcBridge({ windows, windowActions: actions });
      return { bridge, actions, a, b };
    }

    it('opens a new window for the tab', () => {
      const { bridge, actions, a } = bridgeWithActions();
      bridge.moveTab(a.webContents as never, handoff, 'new');
      expect(actions.open).toHaveBeenCalledWith(handoff);
    });

    it('hands the tab to another existing window', () => {
      const { bridge, actions, a } = bridgeWithActions();
      bridge.moveTab(a.webContents as never, handoff, 2);
      expect(actions.adopt).toHaveBeenCalledWith(2, handoff, 1);
    });

    it('rejects a move from an unknown sender and to a window that is gone', () => {
      const { bridge, actions, a } = bridgeWithActions();
      expect(() => bridge.moveTab({ id: 99 } as never, handoff, 'new')).toThrow();
      (actions.adopt as ReturnType<typeof vi.fn>).mockReturnValue(false);
      expect(() => bridge.moveTab(a.webContents as never, handoff, 2)).toThrow(/no longer available/);
    });

    it('gives a window its handoff only when the sender is a known window', () => {
      const { bridge, a } = bridgeWithActions();
      expect(bridge.takeHandoff(a.webContents as never)).toEqual(handoff);
      expect(bridge.takeHandoff({ id: 99 } as never)).toBeNull();
    });
  });
});

describe('IpcBridge SSH CA status events', () => {
  const statusCalls = (win: { send: ReturnType<typeof vi.fn> }) =>
    win.send.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.SSH_CA_STATUS_CHANGED);

  it('delivers a status change exactly once to every window, the focused one included', async () => {
    const { bridge, a, b } = makeBridge();

    (bridge.sshCaService as any).notifyStatus();

    expect(statusCalls(a)).toHaveLength(1);
    expect(statusCalls(b)).toHaveLength(1);
    await bridge.dispose();
  });

  it('falls back to the focused window once when the bridge has no window router', async () => {
    const win = fakeWindow(1);
    const bridge = new IpcBridge({ getWebContents: () => win.webContents as never });

    (bridge.sshCaService as any).notifyStatus();

    expect(statusCalls(win)).toHaveLength(1);
    await bridge.dispose();
  });

  it('ends the SSH CA session on dispose (removes the certified key and the certificate file)', async () => {
    const sshCaService = {
      logout: vi.fn().mockResolvedValue(undefined),
      onStatusChanged: vi.fn().mockReturnValue(() => {}),
      getStatus: vi.fn().mockReturnValue({ active: false }),
      getActiveCertificateFilePath: vi.fn(),
    };
    const bridge = new IpcBridge({ sshCaService: sshCaService as never });

    await bridge.dispose();

    expect(sshCaService.logout).toHaveBeenCalledTimes(1);
  });
});
