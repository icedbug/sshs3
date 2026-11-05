import { app, BrowserWindow, nativeImage, screen } from 'electron';
import { DEFAULT_WINDOW_SIZE, minimumSizeFor, type Rect } from './windowBounds';

export interface AppWindowOptions {
  bounds?: Rect;
  maximized?: boolean;
  /** False keeps the window hidden until the caller shows it (Windows splash hand-over). */
  show: boolean;
  preloadPath: string;
  iconPath: string;
  /** Vite dev server URL in development; otherwise `htmlPath` is loaded from disk. */
  devServerUrl?: string;
  htmlPath: string;
}

/**
 * Creates one renderer window with the app's hardened settings. Every window goes through here so
 * a second window can never end up with weaker sandboxing or navigation rules than the first.
 */
export function createAppWindow(options: AppWindowOptions): BrowserWindow {
  const appIcon = nativeImage.createFromPath(options.iconPath);
  const size = options.bounds ?? DEFAULT_WINDOW_SIZE;
  const display = options.bounds ? screen.getDisplayMatching(options.bounds) : screen.getPrimaryDisplay();
  const min = minimumSizeFor(display.workArea);

  const win = new BrowserWindow({
    ...(options.bounds ? { x: options.bounds.x, y: options.bounds.y } : {}),
    width: size.width,
    height: size.height,
    minWidth: min.width,
    minHeight: min.height,
    icon: appIcon,
    show: options.show,
    webPreferences: {
      preload: options.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true,
    },
  });

  if (!appIcon.isEmpty()) {
    win.setIcon(appIcon);
  }
  if (options.maximized) {
    win.maximize();
  }

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // The application menu is removed (see initializeApp), which also removes its DevTools
  // accelerators — give unpackaged builds F12 / Ctrl+Shift+I back so a renderer problem can be
  // inspected. Packaged releases keep DevTools unreachable.
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const isToggle = input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i');
      if (isToggle) {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  const allowDevServer = (url: string): boolean =>
    !!options.devServerUrl && url.startsWith(options.devServerUrl);

  win.webContents.on('will-navigate', (event, navigationUrl) => {
    if (allowDevServer(navigationUrl)) return;
    event.preventDefault();
  });

  win.webContents.on('will-redirect', (event, navigationUrl) => {
    // Same dev-server carve-out as will-navigate above (LOW finding, code
    // review) — blocking every redirect unconditionally has no effect today
    // (nothing in the app currently redirects), but would silently break a
    // future redirect-based flow (e.g. an in-window OAuth callback) even in
    // dev, where Vite's own HMR/dev-server traffic should be allowed through.
    if (allowDevServer(navigationUrl)) return;
    event.preventDefault();
  });

  if (options.devServerUrl) {
    void win.loadURL(options.devServerUrl);
  } else {
    void win.loadFile(options.htmlPath);
  }

  return win;
}
