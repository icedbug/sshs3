import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebPreferences } from 'electron';

const state = vi.hoisted(() => ({ views: [] as any[] }));
const handoffs = process as EventEmitter;
const handoffListeners = () => handoffs.listeners('sshs3:hermes:main-window') as ((...args: any[]) => void)[];

class MockWebContents {
  destroyed = false;
  loadFile = vi.fn();
  send = vi.fn();
  isDestroyed = vi.fn(() => this.destroyed);
  close = vi.fn(() => { this.destroyed = true; });
}

class MockView {
  readonly webContents = new MockWebContents();
  constructor(readonly options: unknown) { state.views.push(this); }
}

vi.mock('electron', () => ({
  WebContentsView: class { constructor(options: unknown) { return new MockView(options); } },
}));

class MockWindow extends EventEmitter {
  readonly primary = new MockWebContents();
  readonly contentView = { addChildView: vi.fn() };
  get webContents() { return this.primary; }
}

describe('the explicit native Hermes window handoff', () => {
  let originalListeners: Set<(...args: any[]) => void>;
  let native: typeof import('../../src/main/ai/desktop/nativeWindow');
  const preferences: WebPreferences = {
    preload: '/native/original-preload.js',
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    additionalArguments: ['--native-profile'],
  };

  beforeEach(async () => {
    originalListeners = new Set(handoffListeners());
    state.views.length = 0;
    vi.resetModules();
    native = await import('../../src/main/ai/desktop/nativeWindow');
  });

  afterEach(() => {
    for (const listener of handoffListeners()) {
      if (!originalListeners.has(listener)) handoffs.removeListener('sshs3:hermes:main-window', listener);
    }
  });

  it('preserves the real BrowserWindow while routing original renderer calls to one fresh child before loading', async () => {
    const window = new MockWindow();
    handoffs.emit('sshs3:hermes:main-window', window, preferences);
    expect(await native.getNativeWindow()).toBe(window);
    const view = native.getNativeHermesView(window as unknown as BrowserWindow) as unknown as MockView;
    expect(state.views).toEqual([view]);
    expect(window.contentView.addChildView).toHaveBeenCalledExactlyOnceWith(view);
    expect(view.options).toEqual({ webPreferences: {
      ...preferences,
      additionalArguments: ['--native-profile', '--sshs3-hermes-host'],
    } });
    expect(window.webContents).toBe(view.webContents);
    expect(window.webContents).not.toBe(window.primary);
    expect(window.primary.close).not.toHaveBeenCalled();
    expect(view.webContents.loadFile).not.toHaveBeenCalled();

    // These are the unchanged Hermes factory's calls after emitting the handoff.
    window.webContents.loadFile('/native/original-index.html');
    window.webContents.send('original-hermes-channel', { session: 'same-session' });
    expect(view.webContents.loadFile).toHaveBeenCalledExactlyOnceWith('/native/original-index.html');
    expect(view.webContents.send).toHaveBeenCalledExactlyOnceWith('original-hermes-channel', { session: 'same-session' });
    expect(window.primary.loadFile).not.toHaveBeenCalled();
    expect(window.primary.send).not.toHaveBeenCalled();
  });

  it('does not mistake an unrelated popup for the native main renderer', async () => {
    const main = new MockWindow();
    const popup = new MockWindow();
    expect(() => native.getNativeHermesView(popup as unknown as BrowserWindow)).toThrow('not attached');
    expect(state.views).toHaveLength(0);
    handoffs.emit('sshs3:hermes:main-window', main, preferences);
    expect(() => handoffs.emit('sshs3:hermes:main-window', popup, preferences)).toThrow('changed unexpectedly');
    expect(state.views).toHaveLength(1);
    expect(popup.webContents).toBe(popup.primary);
    expect(popup.contentView.addChildView).not.toHaveBeenCalled();
    expect(await native.getNativeWindow()).toBe(main);
  });

  it('leaves ownership of native renderer shutdown with the original window lifecycle', () => {
    const window = new MockWindow();
    handoffs.emit('sshs3:hermes:main-window', window, preferences);
    const nativeContents = window.webContents;
    window.emit('closed');
    window.emit('closed');
    expect(nativeContents.close).toHaveBeenCalledTimes(1);
    expect(window.primary.close).not.toHaveBeenCalled();
  });
});
