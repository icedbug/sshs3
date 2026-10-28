import { WebContentsView, type BrowserWindow, type WebPreferences } from 'electron';

let nativeWindow: BrowserWindow | undefined;
const views = new WeakMap<BrowserWindow, WebContentsView>();
let resolveWindow: ((window: BrowserWindow) => void) | undefined;
const ready = new Promise<BrowserWindow>(resolve => { resolveWindow = resolve; });

/** The pinned main-window factory explicitly hands over its window, never a splash or OAuth popup. */
process.on('sshs3:hermes:main-window', (window: BrowserWindow, preferences: WebPreferences) => {
  if (nativeWindow && nativeWindow !== window) throw new Error('Hermes main window changed unexpectedly');
  // Keep the real BrowserWindow identity for native Hermes' IPC and lifecycle,
  // and route its renderer methods to a normal child view alongside sshs3.
  // The original blank primary is retained for Electron's native close/focus machinery.
  const view = new WebContentsView({ webPreferences: {
    ...preferences,
    additionalArguments: [...(preferences.additionalArguments ?? []), '--sshs3-hermes-host'],
  } });
  window.contentView.addChildView(view);
  Object.defineProperty(window, 'webContents', { value: view.webContents, configurable: true });
  views.set(window, view);
  window.once('closed', () => { if (!view.webContents.isDestroyed()) view.webContents.close(); });
  nativeWindow = window;
  resolveWindow?.(window);
});

export function getNativeWindow(): Promise<BrowserWindow> { return ready; }
export function getNativeHermesView(window: BrowserWindow): WebContentsView {
  const view = views.get(window);
  if (!view) throw new Error('Hermes renderer was not attached to its native host');
  return view;
}
