import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  openHandler: undefined as undefined | ((details: { url: string }) => { action: string }),
  openExternal: undefined as unknown as ReturnType<typeof import('vitest').vi.fn>,
}));

vi.mock('electron', () => {
  state.openExternal = vi.fn(async () => undefined);
  class BrowserWindow {
    webContents = {
      setWindowOpenHandler: (handler: (details: { url: string }) => { action: string }) => {
        state.openHandler = handler;
      },
      on: vi.fn(),
      toggleDevTools: vi.fn(),
    };
    setIcon = vi.fn();
    maximize = vi.fn();
    loadURL = vi.fn(async () => undefined);
    loadFile = vi.fn(async () => undefined);
  }
  const mock = {
    app: { isPackaged: true },
    BrowserWindow,
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    shell: { openExternal: state.openExternal },
  };
  return { ...mock, default: mock };
});

import { createAppWindow, isSystemLink } from '../../src/main/windows/createAppWindow';

beforeEach(() => {
  state.openHandler = undefined;
  state.openExternal.mockClear();
  createAppWindow({ show: false, preloadPath: '/p/preload.js', iconPath: '/p/icon.png', htmlPath: '/p/index.html' });
});

describe('a link that asks the desktop window for a new window', () => {
  it('never gets a window; a web or mail address is handed to the system', () => {
    for (const url of ['https://example.com/guide', 'http://127.0.0.1:8080/', 'mailto:ops@example.com']) {
      expect(state.openHandler!({ url })).toEqual({ action: 'deny' });
      expect(state.openExternal).toHaveBeenLastCalledWith(url);
    }
    expect(state.openExternal).toHaveBeenCalledTimes(3);
  });

  it('drops every other kind of address', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://share/x', 'about:blank', 'not a url']) {
      expect(state.openHandler!({ url })).toEqual({ action: 'deny' });
    }
    expect(state.openExternal).not.toHaveBeenCalled();
  });

  it('isSystemLink knows the three kinds', () => {
    expect(isSystemLink('https://a.example')).toBe(true);
    expect(isSystemLink('mailto:a@b.example')).toBe(true);
    expect(isSystemLink('ftp://a.example')).toBe(false);
  });
});
