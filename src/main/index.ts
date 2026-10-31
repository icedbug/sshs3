import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';
import { createHub } from './ai/hub/createHub';
import { NativeDesktopShell } from './ai/desktop/NativeDesktopShell';
import { getNativeWindow } from './ai/desktop/nativeWindow';
import { nativeTools, setNativeHub } from './ai/desktop/nativeTools';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IpcBridge } from './IpcBridge';
import { showSplash, type SplashController } from './splash/SplashWindow';
import { SystemTrustStore } from './crypto/SystemTrustStore';
import { AgentLifecycleManager } from './ssh/AgentLifecycleManager';
import { applyLoginShellEnv } from './ssh/LoginShellEnv';
import { configureRegistryDir } from './ssh/AgentRegistry';
import { isEncryptionAvailable } from './crypto/SecretFieldCrypto';
import { configureLogging, createLogger, flushLogs, resolveLogLevel, setLogLevel } from './log';

app.setName('sshs3');
if (process.platform === 'linux') {
  app.setDesktopName('sshs3.desktop');
}

// Redirect userData to <exe-dir>/data if running as a portable executable (set by electron-builder)
// or if a local 'data' folder exists next to the executable (e.g. portable ZIP distribution).
// This ensures true portability (data travels with the exe) and avoids collision with any installed
// sshs3 instance sharing the default %APPDATA%\sshs3 directory.
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data'));
} else if (process.platform === 'win32' && !process.env.VITE_DEV_SERVER_URL) {
  const localDataDir = path.join(path.dirname(process.execPath), 'data');
  if (fs.existsSync(localDataDir)) {
    app.setPath('userData', localDataDir);
  }
}

// Enforce single-instance lock: if an instance is already running with the same userData directory,
// focus the existing window and immediately terminate the new instance.
let hasSingleInstanceLock = true;
const nativeHermes = process.env.SSHS3_NATIVE_HERMES === '1';
const demoMode = process.env.SSHS3_DEMO === '1' || process.argv.includes('--demo');
if (!nativeHermes && !demoMode && process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();
        mainWindow.show();
      }
    });
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Only the instance that owns the single-instance lock writes the log file.
if (hasSingleInstanceLock && process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  configureLogging({ dir: app.getPath('logs'), mirrorToConsole: !app.isPackaged && !nativeHermes });
}
const log = createLogger('app');
const quitLog = createLogger('quit');
log.info('starting', {
  version: app.getVersion(),
  electron: process.versions.electron,
  platform: process.platform,
  arch: process.arch,
  pid: process.pid,
  packaged: app.isPackaged,
  // Only whether it was inherited, never the surrounding environment: relaunch after an update inherits it.
  inheritedSshAuthSock: process.env.SSH_AUTH_SOCK ?? null,
});

// Some Linux GPU drivers crash Chromium's GPU process (see the "Linux GPU crash" fix). Rather than
// disabling hardware acceleration for every Linux user unconditionally — which forces all
// compositing, including CSS blur/backdrop-filter used throughout the UI, onto the CPU and makes
// the app noticeably laggy at higher resolutions — we only disable it on machines where a GPU
// crash has actually been observed, persisted via this marker file so it survives to the next
// launch (the current session has already fallen back to software rendering on its own).
const gpuCrashMarkerPath = path.join(app.getPath('userData'), '.gpu-crash-detected');

if (process.platform === 'linux' && fs.existsSync(gpuCrashMarkerPath)) {
  app.disableHardwareAcceleration();
}

app.on('child-process-gone', (_event, details) => {
  log.warn('child process gone', { type: details.type, reason: details.reason, exitCode: details.exitCode });
  if (details.type === 'GPU') {
    log.warn('GPU process exited; continuing with software rendering');
    if (process.platform === 'linux') {
      try {
        fs.writeFileSync(gpuCrashMarkerPath, '');
      } catch {
        // Best-effort; worst case the crash simply recurs and we try again next time.
      }
    }
  }
});

// A desktop GUI app doesn't normally receive SIGINT/SIGTERM in everyday use, but it does when
// killed from the command line (`kill`/`pkill`), by a process manager, or during a session/system
// shutdown script. Without an explicit handler here, Node's default disposition for an unhandled
// SIGINT/SIGTERM is immediate termination — bypassing Electron's entire app-quit lifecycle, so
// `before-quit`/`will-quit` never fire and nothing gets a chance to clean up: standalone SSH
// tunnels, private ssh-agents, Kubernetes port-forwards, and any other spawned child process are
// all left running as orphans. Routing the signal through `app.quit()` instead reuses the exact
// same graceful shutdown path (including the `before-quit` handler's `ipcBridge.dispose()`) a
// normal window-close or Cmd+Q already goes through.
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  const handleTerminationSignal = (): void => {
    app.quit();
  };
  process.once('SIGINT', handleTerminationSignal);
  process.once('SIGTERM', handleTerminationSignal);
}

process.on('uncaughtException', (err) => {
  // Gracefully log undici/HTTP2 stream termination and transient socket aborts
  // instead of crashing Electron with an unexpected error dialog.
  if (err instanceof TypeError && err.message === 'terminated') {
    log.warn('ignored stream termination error', err);
    return;
  }
  if (err && typeof err === 'object' && 'code' in err && (err.code === 'ECONNRESET' || err.code === 'EPIPE')) {
    log.warn('ignored transient socket error', err);
    return;
  }
  log.error('uncaught exception in main process', err);
});

process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection in main process', reason);
});

let mainWindow: BrowserWindow | null = null;
let nativeShell: NativeDesktopShell | null = null;
let backgroundTray: Tray | null = null;
// Windows-only startup progress window (null elsewhere); see ./splash/SplashWindow.
let splash: SplashController | null = null;
let ipcBridge: IpcBridge | null = null;
let isQuitting = false;
// Set once the user has cleared any quit confirmation, so a quit that was
// confirmed via the window's 'close' handler doesn't get asked about again
// when the resulting app.quit() call reaches 'before-quit' below.
let quitConfirmed = false;

// UX audit finding #2: both confirmations below used to be native
// `dialog.showMessageBoxSync` boxes — the one part of the app that didn't
// look or behave like the rest of it (no default-focused Cancel, no themed
// styling). They now go through `ipcBridge.promptQuitConfirm`, which asks
// the renderer to show the same `ConfirmDialog` used everywhere else in the
// app and awaits its result over IPC.
async function confirmQuitIfActiveTransfers(): Promise<boolean> {
  const activeCount = ipcBridge?.transferQueue.getActiveTransferCount() ?? 0;
  if (activeCount > 0 && ipcBridge) {
    const proceed = await ipcBridge.promptQuitConfirm({
      kind: 'active-transfers',
      activeTransferCount: activeCount,
    });
    if (!proceed) return false;
  }
  return true;
}

/**
 * Resolves whether it's OK to proceed with quitting: always confirms if
 * transfers are active, and additionally asks a plain "are you sure?"
 * question when the user has opted into `confirmBeforeQuit` in settings.
 * Cached via `quitConfirmed` so the same quit attempt is never asked twice
 * across the 'close' -> app.quit() -> 'before-quit' chain below.
 */
async function confirmQuit(): Promise<boolean> {
  if (quitConfirmed) return true;

  if (!(await confirmQuitIfActiveTransfers())) {
    return false;
  }

  try {
    const settings = await ipcBridge?.settingsStore.getSettings();
    if (settings?.confirmBeforeQuit && ipcBridge) {
      const proceed = await ipcBridge.promptQuitConfirm({ kind: 'confirm-before-quit' });
      if (!proceed) return false;
    }
  } catch {
    // If settings can't be read, don't block quitting over it.
  }

  quitConfirmed = true;
  return true;
}

async function createWindow(): Promise<BrowserWindow> {
  if (nativeHermes) {
    mainWindow = await getNativeWindow();
    if (!nativeShell) nativeShell = new NativeDesktopShell(mainWindow, path.join(__dirname, 'index.cjs'), path.join(__dirname, '../dist/index.html'));
    mainWindow.once('closed', () => { nativeShell = null; mainWindow = null; });
    return mainWindow;
  }
  const iconPath = process.env.VITE_DEV_SERVER_URL
    ? path.join(__dirname, '../../build/icon.png')
    : path.join(__dirname, '../build/icon.png');
  const appIcon = nativeImage.createFromPath(iconPath);

  mainWindow = new BrowserWindow({
    width: demoMode ? 1480 : 1200,
    height: demoMode ? 920 : 800,
    icon: appIcon,
    // On Windows the splash stays up until the renderer has loaded, so the main
    // window is created hidden instead of flashing an empty frame.
    show: process.platform !== 'win32' && !(process.argv.includes('--background') && ipcBridge?.aiHub?.background),
    webPreferences: {
      preload: path.join(__dirname, 'index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (!appIcon.isEmpty()) {
    mainWindow.setIcon(appIcon);
  }

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (process.env.VITE_DEV_SERVER_URL && navigationUrl.startsWith(process.env.VITE_DEV_SERVER_URL)) {
      return;
    }
    event.preventDefault();
  });

  mainWindow.webContents.on('will-redirect', (event, navigationUrl) => {
    // Same dev-server carve-out as will-navigate above (LOW finding, code
    // review) — blocking every redirect unconditionally has no effect today
    // (nothing in the app currently redirects), but would silently break a
    // future redirect-based flow (e.g. an in-window OAuth callback) even in
    // dev, where Vite's own HMR/dev-server traffic should be allowed through.
    if (process.env.VITE_DEV_SERVER_URL && navigationUrl.startsWith(process.env.VITE_DEV_SERVER_URL)) {
      return;
    }
    event.preventDefault();
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    if (ipcBridge?.aiHub?.background) { event.preventDefault(); mainWindow?.hide(); return; }
    // Always defer to app.quit() (handled by 'before-quit' below) instead of
    // letting the window close on its own, so a plain window-close ("X" the
    // window) goes through the same graceful shutdown — ipcBridge.dispose(),
    // killing SSH tunnels/agents — as Cmd+Q or the app menu, rather than
    // tearing everything down hard.
    event.preventDefault();
    void (async () => {
      if (!(await confirmQuit())) return;
      app.quit();
    })();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.platform === 'win32') {
    const window = mainWindow;
    let revealed = false;
    const reveal = (): void => {
      if (revealed) return;
      revealed = true;
      clearTimeout(fallback);
      splash?.setProgress(100, 'Ready');
      if (!window.isDestroyed() && !process.argv.includes('--background')) {
        window.show();
        window.focus();
        if (demoMode) {
          window.setAlwaysOnTop(true);
          window.focus();
          setTimeout(() => {
            if (!window.isDestroyed()) window.setAlwaysOnTop(false);
          }, 500);
        }
      }
      splash?.close();
      splash = null;
    };
    // Never leave the user stuck on the splash if the renderer fails to load.
    const fallback = setTimeout(reveal, 30_000);
    window.webContents.on('did-start-loading', () => splash?.setProgress(70, 'Loading interface…'));
    window.webContents.on('dom-ready', () => splash?.setProgress(85, 'Starting interface…'));
    window.webContents.once('did-finish-load', reveal);
    window.webContents.once('did-fail-load', reveal);
    window.once('closed', () => {
      clearTimeout(fallback);
      splash?.close();
      splash = null;
    });
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    const url = demoMode
      ? `${process.env.VITE_DEV_SERVER_URL}${process.env.VITE_DEV_SERVER_URL.includes('?') ? '&' : '?'}demo=1`
      : process.env.VITE_DEV_SERVER_URL;
    mainWindow.loadURL(url);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, '../dist/index.html'),
      demoMode ? { query: { demo: '1' } } : undefined,
    );
  }

  return mainWindow;
}

// Initialize IPC bridge before or when app is ready
async function initializeApp(): Promise<void> {
  splash?.setProgress(10, 'Starting…');

  // Loaded lazily so the splash is already on screen while the (large) service
  // layer is parsed, instead of showing nothing until it is done.
  const { IpcBridge } = await import('./IpcBridge');
  splash?.setProgress(35, 'Loading services…');

  // Set registry directory for ssh-agents
  configureRegistryDir(path.join(app.getPath('userData'), 'runtime-agents'));

  // Remove default dead application menu
  if (!nativeHermes) Menu.setApplicationMenu(null);

  // Initialize and register IPC bridge
  ipcBridge = new IpcBridge({
    getWebContents: () => nativeHermes ? nativeShell?.getWebContents() : mainWindow?.webContents,
    confirmQuit,
  });
  ipcBridge.aiHub = createHub(ipcBridge, {
    show: () => { mainWindow?.show(); mainWindow?.focus(); },
    backgroundChanged: async (enabled, autoStart) => {
      if (enabled && !backgroundTray) {
        const icon = nativeImage.createFromPath(app.isPackaged
          ? path.join(process.resourcesPath, 'ai-hub-icon.png')
          : path.join(app.getAppPath(), 'build/icon.png'));
        backgroundTray = new Tray(icon.resize({ width: 16, height: 16 }));
        backgroundTray.setToolTip('sshs3 — running in background');
        backgroundTray.setContextMenu(Menu.buildFromTemplate([
          { label: 'Open sshs3', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
          { label: 'Quit sshs3 completely', click: () => { mainWindow?.show(); app.quit(); } },
        ]));
        backgroundTray.on('double-click', () => mainWindow?.show());
      } else if (!enabled && backgroundTray) { backgroundTray.destroy(); backgroundTray = null; }
      if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: enabled && autoStart, args: ['--background'] });
      if (process.platform === 'linux') {
        const autoDir = path.join(process.env.XDG_CONFIG_HOME || path.join(app.getPath('home'), '.config'), 'autostart');
        const target = path.join(autoDir, 'sshs3-background.desktop');
        if (enabled && autoStart) {
          fs.mkdirSync(autoDir, { recursive: true });
          const exe = process.execPath.replace(/(["`$\\])/g, '\\$1');
          fs.writeFileSync(target, `[Desktop Entry]\nType=Application\nName=sshs3 Background\nExec="${exe}" --background\nTerminal=false\n`, { mode: 0o600 });
        } else if (fs.existsSync(target)) fs.unlinkSync(target);
      }
    },
  });
  ipcBridge.register();
  if (nativeHermes) setNativeHub(ipcBridge.aiHub);
  await ipcBridge.aiHub.initialize().catch((error) => log.warn('AI Hub initialization failed', error));
  void ipcBridge.settingsStore
    .getSettings()
    .then((settings) => setLogLevel(resolveLogLevel(settings.logLevel)))
    .catch(() => {});
  splash?.setProgress(55, 'Creating window…');
  // A previous run may have crashed before it could empty the clipboard history on exit.
  void ipcBridge.clearClipboardHistoryIfConfigured().catch(() => {});

  // Create the main window immediately so the UI starts loading without waiting for subshells
  await createWindow();
  if (!nativeHermes) ipcBridge.startUpdateChecks();

  // Run background tasks (orphan cleanup, login shell environment, trust store, ~/.ssh/config sync)
  // in parallel with window loading so startup time is not penalized
  void Promise.all([
    AgentLifecycleManager.cleanupOrphanedResources(),
    applyLoginShellEnv().then(() => {
      void SystemTrustStore.init();
    }),
    // Syncs the managed block, then (via onLocalSshConfigSynced) clears any agent block a crashed run left behind.
    ipcBridge.profileSyncService.autoSyncLocalSshConfig(),
  ]).catch((err) => {
    log.warn('background initialization error', err);
  });

  void AgentLifecycleManager.ensureAgent();

  if (!isEncryptionAvailable()) {
    log.warn(
      'no OS keyring available (safeStorage.isEncryptionAvailable() === false): ' +
        'saved credentials will be stored in PLAINTEXT on disk instead of encrypted'
    );
  }
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  if (!nativeHermes) splash = showSplash();
  return initializeApp();
});

app.on('before-quit', (event) => {
  if (!hasSingleInstanceLock) return;
  if (!isQuitting) {
    quitLog.info('before-quit: confirming and disposing');
    event.preventDefault();
    void (async () => {
      if (!(await confirmQuit())) {
        quitLog.info('quit cancelled by user');
        return;
      }
      isQuitting = true;
      if (ipcBridge) {
        try {
          if (nativeHermes) await nativeTools.dispose();
          await ipcBridge.dispose();
        } catch {
          // ignore
        }
        ipcBridge = null;
        AgentLifecycleManager.killAllPrivateAgents();
        quitLog.info('dispose finished; quitting');
        // Bounded so a stuck disk can never block quit (or the relaunch that follows an update).
        await Promise.race([flushLogs(), new Promise((resolve) => setTimeout(resolve, 1000))]);
        app.quit();
      } else {
        AgentLifecycleManager.killAllPrivateAgents();
        app.quit();
      }
    })();
  }
});

app.on('will-quit', () => {
  if (!hasSingleInstanceLock) return;
  AgentLifecycleManager.killAllPrivateAgents();
  quitLog.info('will-quit');
});

app.on('window-all-closed', () => {
  if (!hasSingleInstanceLock) return;
  AgentLifecycleManager.killAllPrivateAgents();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (!nativeHermes && BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

export { createWindow, ipcBridge };
