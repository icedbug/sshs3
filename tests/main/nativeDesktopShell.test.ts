import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import { NATIVE_HERMES_CHANNELS } from '../../src/shared/types/nativeHermes';

const electronMock = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (...args: any[]) => unknown>(),
  views: [] as any[],
  removeHandler: vi.fn(),
}));

const toolsMock = vi.hoisted(() => ({
  snapshot: vi.fn(() => ({ bindings: [] })),
  selectTerminal: vi.fn(),
  armSelected: vi.fn().mockResolvedValue(undefined),
  approve: vi.fn(),
  takeover: vi.fn(),
  resume: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/main/ai/desktop/nativeTools', () => ({ nativeTools: toolsMock }));
vi.mock('../../src/main/ai/desktop/nativeWindow', () => ({
  getNativeHermesView: (window: MockWindow) => window.hermes,
}));

class MockWebContents extends EventEmitter {
  readonly mainFrame = { url: 'file:///trusted-renderer.html' };
  destroyed = false;
  send = vi.fn();
  loadFile = vi.fn().mockResolvedValue(undefined);
  setWindowOpenHandler = vi.fn();
  setBackgroundThrottling = vi.fn();
  isDestroyed = vi.fn(() => this.destroyed);
  close = vi.fn(() => { this.destroyed = true; });
}

class MockView {
  readonly webContents = new MockWebContents();
  setBounds = vi.fn();
  setVisible = vi.fn();
  constructor(readonly options: unknown) { electronMock.views.push(this); }
}

vi.mock('electron', () => ({
  app: { getPath: () => electronMock.userData },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => unknown) => {
      if (electronMock.handlers.has(channel)) throw new Error('IPC handler registered twice');
      electronMock.handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      electronMock.removeHandler(channel);
      electronMock.handlers.delete(channel);
    },
  },
  WebContentsView: class { constructor(options: unknown) { return new MockView(options); } },
}));

import { NativeDesktopShell } from '../../src/main/ai/desktop/NativeDesktopShell';
import { nativeEvents } from '../../src/main/ai/desktop/nativeEvents';

class MockWindow extends EventEmitter {
  readonly originalPrimary = new MockWebContents();
  readonly hermes = new MockView({ webPreferences: { preload: '/trusted/native-preload.js' } });
  readonly webContents = this.hermes.webContents;
  readonly contentView = { addChildView: vi.fn(), setBackgroundColor: vi.fn() };
  bounds = { x: 0, y: 0, width: 1200, height: 800 };
  destroyed = false;
  getContentBounds = vi.fn(() => this.bounds);
  isDestroyed = vi.fn(() => this.destroyed);
  constructor() { super(); this.contentView.addChildView(this.hermes); }
}

describe('NativeDesktopShell', () => {
  let window: MockWindow;
  let shell: NativeDesktopShell | undefined;
  let directory: string;

  function createShell() {
    shell = new NativeDesktopShell(window as unknown as BrowserWindow, '/trusted/preload.cjs', '/trusted/terminal.html');
    return shell;
  }

  function event(contents: MockWebContents, senderFrame: unknown = contents.mainFrame) {
    return { sender: contents, senderFrame } as unknown as IpcMainInvokeEvent;
  }

  function invoke(channel: string, source: IpcMainInvokeEvent, ...args: unknown[]) {
    const handler = electronMock.handlers.get(channel);
    if (!handler) throw new Error('Missing IPC handler: ' + channel);
    return handler(source, ...args);
  }

  function set(update: unknown) {
    return invoke(NATIVE_HERMES_CHANNELS.set, event(window.webContents), update);
  }

  function terminal() { return shell!.terminal as unknown as MockView; }

  beforeEach(() => {
    vi.useFakeTimers();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-native-shell-'));
    electronMock.userData = directory;
    electronMock.handlers.clear();
    electronMock.views.length = 0;
    electronMock.removeHandler.mockClear();
    for (const mock of Object.values(toolsMock)) mock.mockClear();
    window = new MockWindow();
    shell = undefined;
  });

  afterEach(() => {
    shell?.dispose();
    vi.useRealTimers();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('accepts only the live primary frames of Hermes and the terminal for reading and changing presentation', () => {
    createShell();
    for (const source of [window.webContents, terminal().webContents]) {
      expect(invoke(NATIVE_HERMES_CHANNELS.get, event(source))).toEqual({ mode: 'panel', width: 380 });
      expect(invoke(NATIVE_HERMES_CHANNELS.set, event(source), { width: 400 })).toEqual({ mode: 'panel', width: 400 });
      set({ width: 380 });
    }

    const foreign = new MockWebContents();
    const rejected = [
      event(foreign),
      event(window.originalPrimary),
      event(window.webContents, { url: 'file:///trusted-renderer.html' }), // iframe URL alone confers no access
      event(terminal().webContents, { url: 'file:///trusted-renderer.html' }),
      event(window.webContents, null),
    ];
    for (const source of rejected) {
      expect(() => invoke(NATIVE_HERMES_CHANNELS.get, source)).toThrow('untrusted frame');
      expect(() => invoke(NATIVE_HERMES_CHANNELS.set, source, { mode: 'full' })).toThrow('untrusted frame');
    }
    expect(shell?.current()).toEqual({ mode: 'panel', width: 380 });

    terminal().webContents.destroyed = true;
    expect(() => invoke(NATIVE_HERMES_CHANNELS.get, event(terminal().webContents))).toThrow('untrusted frame');
    expect(invoke(NATIVE_HERMES_CHANNELS.get, event(window.webContents))).toEqual({ mode: 'panel', width: 380 });
  });

  it('keeps one loaded terminal and its webContents through expansion, return, closing and reopening the panel', () => {
    const instance = createShell();
    const contents = instance.getWebContents();
    const nativeContents = window.webContents;
    expect(window.contentView.setBackgroundColor).toHaveBeenCalledWith('#00000000');
    expect(nativeContents.setBackgroundThrottling).toHaveBeenCalledWith(false);
    expect(instance.hermes).toBe(window.hermes);
    expect(window.hermes.setBounds).toHaveBeenLastCalledWith({ x: 820, y: 0, width: 380, height: 800 });
    expect(terminal().options).toEqual({ webPreferences: {
      preload: '/trusted/preload.cjs', sandbox: true, contextIsolation: true, nodeIntegration: false,
      additionalArguments: ['--sshs3-native-hermes'],
    } });
    expect(terminal().webContents.loadFile).toHaveBeenCalledExactlyOnceWith('/trusted/terminal.html');

    set({ mode: 'full' });
    expect(window.hermes.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1200, height: 800 });
    expect(window.hermes.setVisible).toHaveBeenLastCalledWith(true);
    expect(terminal().setVisible).toHaveBeenLastCalledWith(false);
    expect(window.webContents.send).toHaveBeenLastCalledWith(NATIVE_HERMES_CHANNELS.changed, { mode: 'full', width: 1200 });
    expect(terminal().webContents.send).toHaveBeenLastCalledWith(NATIVE_HERMES_CHANNELS.changed, { mode: 'full', width: 1200 });

    set({ mode: 'panel' });
    expect(terminal().setVisible).toHaveBeenLastCalledWith(true);
    expect(terminal().setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 820, height: 800 });
    set({ mode: 'closed' });
    expect(window.hermes.setVisible).toHaveBeenLastCalledWith(false);
    expect(terminal().setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1200, height: 800 });
    set({ mode: 'panel' });

    expect(electronMock.views).toHaveLength(2);
    expect(window.contentView.addChildView.mock.calls).toEqual([[window.hermes], [instance.terminal]]);
    expect(window.webContents).toBe(nativeContents);
    expect(window.hermes.webContents.loadFile).not.toHaveBeenCalled();
    expect(window.hermes.webContents.close).not.toHaveBeenCalled();
    expect(instance.getWebContents()).toBe(contents);
    expect(terminal().webContents.loadFile).toHaveBeenCalledTimes(1);
    expect(terminal().webContents.close).not.toHaveBeenCalled();
  });

  it('fits the terminal and panel after window resize without erasing the preferred panel width', () => {
    const instance = createShell();
    set({ width: 640 });
    window.bounds = { x: 20, y: 10, width: 750, height: 501 };
    window.emit('resize');
    expect(window.hermes.setBounds).toHaveBeenLastCalledWith({ x: 320, y: 0, width: 430, height: 501 });
    expect(terminal().setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 320, height: 501 });
    expect(window.webContents.send).toHaveBeenLastCalledWith(NATIVE_HERMES_CHANNELS.changed, { mode: 'panel', width: 430 });

    window.bounds = { x: 0, y: 0, width: 220, height: 300 };
    window.emit('resize');
    expect(terminal().setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 300 });
    expect(window.webContents.send).toHaveBeenLastCalledWith(NATIVE_HERMES_CHANNELS.changed, { mode: 'panel', width: 220 });
    expect(instance.current()).toEqual({ mode: 'panel', width: 640 });

    window.bounds = { x: 0, y: 0, width: 1400, height: 900 };
    terminal().webContents.emit('did-finish-load');
    expect(terminal().setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 760, height: 900 });
    expect(window.webContents.send).toHaveBeenCalledWith(NATIVE_HERMES_CHANNELS.changed, { mode: 'panel', width: 640 });
  });

  it('persists the panel preference, independently of fullscreen geometry, and restores it on next startup', () => {
    const instance = createShell();
    set({ width: 451 });
    set({ mode: 'full' });
    window.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    window.emit('resize');
    expect(window.webContents.send).toHaveBeenLastCalledWith(NATIVE_HERMES_CHANNELS.changed, { mode: 'full', width: 1920 });
    expect(instance.current()).toEqual({ mode: 'full', width: 451 });
    vi.advanceTimersByTime(250);
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'hermes-shell-layout.json'), 'utf8'))).toEqual({ mode: 'full', width: 451 });
    expect(fs.existsSync(path.join(directory, 'hermes-shell-layout.json.tmp'))).toBe(false);

    instance.dispose();
    window = new MockWindow();
    expect(createShell().current()).toEqual({ mode: 'full', width: 451 });
    set({ mode: 'panel' });
    expect(window.webContents.send).toHaveBeenLastCalledWith(NATIVE_HERMES_CHANNELS.changed, { mode: 'panel', width: 451 });
  });

  it('coalesces drag updates and flushes the last preference when the owning window closes', () => {
    createShell();
    const stateFile = path.join(directory, 'hermes-shell-layout.json');
    set({ width: 410 });
    vi.advanceTimersByTime(200);
    set({ width: 420 });
    vi.advanceTimersByTime(200);
    expect(fs.existsSync(stateFile)).toBe(false);
    window.emit('closed');
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual({ mode: 'panel', width: 420 });
    vi.advanceTimersByTime(1000);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual({ mode: 'panel', width: 420 });
  });

  it('cleans up IPC and terminal exactly once, and does not update a disposed or destroyed window', () => {
    const instance = createShell();
    window.destroyed = true;
    const calls = terminal().setBounds.mock.calls.length;
    window.emit('resize');
    expect(terminal().setBounds).toHaveBeenCalledTimes(calls);
    window.destroyed = false;
    window.emit('closed');
    instance.dispose();
    expect(instance.getWebContents()).toBeNull();
    expect(terminal().webContents.close).toHaveBeenCalledTimes(1);
    expect(window.hermes.webContents.close).not.toHaveBeenCalled();
    expect(electronMock.removeHandler.mock.calls).toEqual(Object.values(NATIVE_HERMES_CHANNELS).map(channel => [channel]));
    expect(electronMock.handlers.size).toBe(0);
    expect(window.listenerCount('resize')).toBe(0);
    expect(nativeEvents.listenerCount('toolsChanged')).toBe(0);
    window.webContents.emit('did-finish-load');
    terminal().webContents.emit('did-finish-load');
    window.emit('resize');
    expect(terminal().setBounds).toHaveBeenCalledTimes(calls);
  });

  it('prevents terminal navigation and popups from introducing another untrusted surface', () => {
    createShell();
    const popupHandler = terminal().webContents.setWindowOpenHandler.mock.calls[0][0];
    expect(popupHandler({ url: 'https://external.example/' })).toEqual({ action: 'deny' });
    const navigate = { preventDefault: vi.fn() };
    terminal().webContents.emit('will-navigate', navigate);
    expect(navigate.preventDefault).toHaveBeenCalledTimes(1);
    expect(shell?.getWebContents()).toBe(terminal().webContents as unknown as WebContents);
  });

  it('rejects untrusted approvals and tool control, and permits target selection only from the terminal', async () => {
    createShell();
    const foreign = event(new MockWebContents());
    const iframe = event(window.webContents, { url: 'file:///trusted-renderer.html' });
    for (const source of [foreign, iframe, event(window.originalPrimary)]) {
      expect(() => invoke(NATIVE_HERMES_CHANNELS.tools, source)).toThrow('untrusted frame');
      expect(() => invoke(NATIVE_HERMES_CHANNELS.approve, source, 'task', 'change', true)).toThrow('untrusted frame');
      expect(() => invoke(NATIVE_HERMES_CHANNELS.takeover, source, 'task')).toThrow('untrusted frame');
      await expect(invoke(NATIVE_HERMES_CHANNELS.arm, source, 'cmd')).rejects.toThrow('untrusted frame');
      await expect(invoke(NATIVE_HERMES_CHANNELS.resume, source, 'task')).rejects.toThrow('untrusted frame');
      expect(() => invoke(NATIVE_HERMES_CHANNELS.select, source, 'session')).toThrow('Only the terminal');
    }
    expect(() => invoke(NATIVE_HERMES_CHANNELS.select, event(window.webContents), 'session')).toThrow('Only the terminal');
    expect(() => invoke(NATIVE_HERMES_CHANNELS.approve, event(window.webContents), 'task', 'change', 'yes')).toThrow('explicit');
    await expect(invoke(NATIVE_HERMES_CHANNELS.arm, event(window.webContents), 'invented-shell')).rejects.toThrow('Unsupported');
    expect(toolsMock.approve).not.toHaveBeenCalled();
    expect(toolsMock.selectTerminal).not.toHaveBeenCalled();
    expect(toolsMock.armSelected).not.toHaveBeenCalled();

    invoke(NATIVE_HERMES_CHANNELS.select, event(terminal().webContents), 'session');
    invoke(NATIVE_HERMES_CHANNELS.approve, event(window.webContents), 'task', 'change', false);
    expect(toolsMock.selectTerminal).toHaveBeenCalledExactlyOnceWith('session');
    expect(toolsMock.approve).toHaveBeenCalledExactlyOnceWith('task', 'change', false);
  });

  it('publishes native tool changes to the same two live renderer surfaces', () => {
    createShell();
    expect(invoke(NATIVE_HERMES_CHANNELS.tools, event(window.webContents))).toEqual({ bindings: [] });
    nativeEvents.emit('toolsChanged');
    for (const contents of [window.webContents, terminal().webContents]) {
      expect(contents.send).toHaveBeenLastCalledWith(NATIVE_HERMES_CHANNELS.toolsChanged, { bindings: [] });
    }
    terminal().webContents.destroyed = true;
    terminal().webContents.send.mockClear();
    nativeEvents.emit('toolsChanged');
    expect(terminal().webContents.send).not.toHaveBeenCalled();
    expect(window.webContents.send).toHaveBeenLastCalledWith(NATIVE_HERMES_CHANNELS.toolsChanged, { bindings: [] });
  });
});
