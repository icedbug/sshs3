import crypto from 'node:crypto';
import { app, BrowserWindow, dialog, Menu, nativeImage, safeStorage, screen, Tray } from 'electron';
import { createHub } from './ai/hub/createHub';
import { DEMO_ENV_VARS, demoModeRelaunchArgs, demoWorkspaceDir, isDemoMode } from './demo/demoMode';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { IpcBridge } from './IpcBridge';
import { showSplash, type SplashController } from './splash/SplashWindow';
import { SystemTrustStore } from './crypto/SystemTrustStore';
import { AgentLifecycleManager } from './ssh/AgentLifecycleManager';
import { applyLoginShellEnv } from './ssh/LoginShellEnv';
import { configureRegistryDir } from './ssh/AgentRegistry';
import { isEncryptionAvailable } from './crypto/SecretFieldCrypto';
import { WindowManager } from './windows/WindowManager';
import { createAppWindow } from './windows/createAppWindow';
import { placeNewWindow, resolveWindowBounds, type Rect } from './windows/windowBounds';
import type { WindowActions } from './windows/WindowManager';
import { IPC_CHANNELS, type TabHandoff } from '../shared/types/ipc';
import { restorableWindows } from './session/windowSessions';
import type { SessionData } from '../shared/types/session';
import { configureLogging, createLogger, flushLogs, resolveLogLevel, setLogLevel } from './log';
import { resolvePasswordStore } from './crypto/passwordStore';
import { loadPolicy } from './policy/loadPolicy';
import { startLinuxRelaunch } from './update/linuxRelaunch';

app.setName('sshs3');
if (process.platform === 'linux') {
  app.setDesktopName('sshs3.desktop');
  // Chromium's os_crypt auto-detection picks the native 'kwallet6' backend on a KDE session
  // (safeStorage.isEncryptionAvailable() === true, getSelectedStorageBackend() === 'kwallet6'),
  // but on at least one real KDE Plasma 6 / kwalletd6 setup that backend never actually writes
  // the encryption key into KWallet — confirmed by inspecting KWallet's on-disk store directly
  // (~/.local/share/kwalletd/kdewallet_attributes.json) before and after an encrypt call: no
  // entry appears, and no file mtime changes, even though encryptString() "succeeds". The key
  // then lives only in that process's memory, so every restart gets a fresh one and everything
  // encrypted in a prior run (saved passwords, Team Vault's S3 secret, ...) becomes
  // undecryptable — surfacing downstream as garbage credentials (e.g. AWS SignatureDoesNotMatch).
  //
  // Forcing 'gnome-libsecret' instead routes through ksecretd (KWallet's freedesktop Secret
  // Service compatibility layer) via libsecret, verified via `secret-tool search` to actually
  // persist the key and survive a restart. This used to be gated on detecting a KDE session via
  // XDG_CURRENT_DESKTOP/KDE_FULL_SESSION, but that's unreliable: a real user's app process
  // (launched via `npm run dev:prod` from their own terminal) had neither variable in its
  // environment at all, despite genuinely running on KDE, so the override silently never
  // applied and the bug kept recurring. Apply it unconditionally on Linux instead:
  // gnome-libsecret is also the normal, already-working backend on a vanilla GNOME session, and
  // if no Secret-Service-compatible store exists at all, Chromium just falls back to
  // 'basic_text', which the `!isEncryptionAvailable()` check below already warns about.
  app.commandLine.appendSwitch('password-store', resolvePasswordStore(process.env, app.isPackaged));
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

// Demo mode (decided once at launch from --demo or SSHS3_DEMO=1, see ./demo/demoMode) keeps everything in
// its own data directory inside the normal one. Set before anything reads userData (the single-instance
// lock, the log file, every store, the renderer's Chromium profile), so a demo instance never reads or
// writes the real profile, and has its own lock: a demo and a normal instance can run side by side.
if (isDemoMode()) {
  const demoUserData = demoWorkspaceDir(app.getPath('userData'));
  fs.mkdirSync(demoUserData, { recursive: true });
  app.setPath('userData', demoUserData);
  // macOS keeps app logs outside userData (~/Library/Logs/sshs3); keep the demo's with its own data.
  app.setAppLogsPath(path.join(demoUserData, 'logs'));
}

// Enforce single-instance lock: if an instance is already running with the same userData directory,
// focus the existing window and immediately terminate the new instance.
let hasSingleInstanceLock = true;
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      const win = windowManager.focused();
      if (win) {
        if (win.isMinimized()) {
          win.restore();
        }
        win.focus();
        win.show();
      }
    });
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Only the instance that owns the single-instance lock writes the log file.
if (hasSingleInstanceLock && process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  configureLogging({ dir: app.getPath('logs'), mirrorToConsole: !app.isPackaged });
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
  demoMode: isDemoMode(),
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

// Every renderer window; routes IPC events to the right one (see windows/WindowManager).
const windowManager = new WindowManager<BrowserWindow>();
// Secondary windows whose close was confirmed (or needs no confirmation) and may now go through.
const closeConfirmed = new Set<number>();
// The main window (key null); used by the AI Hub and its tray.
let mainWindow: BrowserWindow | null = null;
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

/** How long a demo-mode restart waits for the graceful shutdown before it exits regardless. */
const DEMO_RELAUNCH_EXIT_TIMEOUT_MS = 15_000;

/**
 * The Demo-Lab toggle (an AI Hub request, see HubHost.relaunchForDemoMode). Demo mode is decided at launch
 * (./demo/demoMode), so switching it restarts the app with `--demo` added or removed, after the user has
 * confirmed. Resolves false when nothing happens (same mode, declined, or already quitting).
 */
async function relaunchForDemoMode(demoMode: boolean): Promise<boolean> {
  if (demoMode === isDemoMode() || isQuitting || !ipcBridge) return false;
  if (!(await confirmDemoModeRelaunch(demoMode))) return false;
  if (isQuitting || !(await confirmQuitIfActiveTransfers())) return false;
  quitLog.info('relaunching to switch demo mode', { demoMode });
  // The new instance takes its mode from its command line alone, never from an inherited environment.
  for (const name of DEMO_ENV_VARS) delete process.env[name];
  // Started on purpose by the user, so it shows its window even if this instance was autostarted hidden.
  const args = demoModeRelaunchArgs(process.argv.slice(1).filter((arg) => arg !== '--background'), demoMode);
  scheduleRelaunch(args);
  // The restart is already confirmed: before-quit must not ask again, but still shuts down gracefully
  // (sessions, tunnels, agents, logs). On the next turn, so the AI Hub request that asked is answered first.
  quitConfirmed = true;
  setImmediate(() => app.quit());
  // Should that graceful shutdown stall, exit anyway: the relaunch scheduled above happens on exit.
  setTimeout(() => app.exit(0), DEMO_RELAUNCH_EXIT_TIMEOUT_MS).unref();
  return true;
}

/** Asks before a demo-mode restart; Cancel is the default, so a stray Enter never restarts the app. */
async function confirmDemoModeRelaunch(demoMode: boolean): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: [demoMode ? 'Restart in Demo Mode' : 'Restart in Normal Mode', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'sshs3',
    message: demoMode ? 'Restart sshs3 in demo mode?' : 'Restart sshs3 in normal mode?',
    detail: demoMode
      ? 'sshs3 will restart in demo mode — your real profile is not touched. Open sessions and tunnels will be closed.'
      : 'sshs3 will restart in normal mode. Open sessions and tunnels will be closed.',
  };
  const parent = windowManager.focused() ?? mainWindow;
  const { response } =
    parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === 0;
}

/** Starts the app again with `args` once this process has exited. */
function scheduleRelaunch(args: string[]): void {
  // Packaged Linux builds come back through the desktop session like after an update (a fresh systemd scope,
  // so sudo/PAM keep working in the integrated terminal; AppImage-aware). A direct re-exec is the fallback.
  if (process.platform === 'linux' && app.isPackaged && startLinuxRelaunch({ args })) return;
  // A portable Windows build runs from a temporary extraction that is removed on exit: relaunch the portable exe.
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
  app.relaunch(portableExe ? { args, execPath: portableExe } : { args });
}

/** Bounds changes are saved after the window has been still for this long. */
const BOUNDS_SAVE_DEBOUNCE_MS = 500;

function currentWorkAreas(): { workAreas: Rect[]; primary: Rect } {
  return {
    workAreas: screen.getAllDisplays().map((d) => d.workArea),
    primary: screen.getPrimaryDisplay().workArea,
  };
}

/** Bounds for a new window: on the monitor the pointer is on, cascaded from the focused window. */
function boundsForNewWindow(): Rect {
  const cursorWorkArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const focused = windowManager.focused();
  const focusedInfo =
    focused && !focused.isDestroyed()
      ? { bounds: focused.getNormalBounds(), workArea: screen.getDisplayMatching(focused.getBounds()).workArea }
      : null;
  return placeNewWindow(cursorWorkArea, focusedInfo);
}

/**
 * Creates a window. `key` is its persistence key: null for the main window (whose tabs are the
 * top-level session fields), a string for secondary windows. Saved bounds are checked against the
 * monitors that are connected now, so a window saved on an unplugged monitor reopens on the primary.
 */
function createWindow(key: string | null = null, saved?: { bounds?: Rect; maximized?: boolean }): BrowserWindow {
  const isMain = key === null;
  const { workAreas, primary } = currentWorkAreas();
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || undefined;

  const htmlPath = path.join(__dirname, '../dist/index.html');
  // Demo mode: the renderer detects it via ?demo=1, so the page is loaded with that query
  // (as a file:// URL in production, since createAppWindow's loadFile takes no query).
  const loadUrl = isDemoMode()
    ? devServerUrl
      ? `${devServerUrl}${devServerUrl.includes('?') ? '&' : '?'}demo=1`
      : `${pathToFileURL(htmlPath).href}?demo=1`
    : devServerUrl;

  const win = createAppWindow({
    bounds: saved?.bounds ? resolveWindowBounds(saved.bounds, workAreas, primary) : undefined,
    maximized: saved?.maximized,
    // On Windows the splash stays up until the renderer has loaded, so the main
    // window is created hidden instead of flashing an empty frame.
    show:
      !(isMain && process.platform === 'win32') &&
      !(isMain && process.argv.includes('--background') && ipcBridge?.aiHub?.background),
    preloadPath: path.join(__dirname, 'index.cjs'),
    iconPath: devServerUrl ? path.join(__dirname, '../../build/icon.png') : path.join(__dirname, '../build/icon.png'),
    devServerUrl: loadUrl,
    htmlPath,
  });

  if (isDemoMode() && isMain && !saved?.bounds) {
    win.setSize(1480, 920);
    win.center();
  }

  const windowId = win.webContents.id;
  windowManager.register(win, key);
  if (isMain) mainWindow = win;
  win.on('focus', () => windowManager.setFocused(windowId));

  // Remember where the window is (debounced; the normal bounds, so un-maximizing restores them).
  // Demo mode leaves the real session untouched, like SESSION_SAVE does.
  let boundsTimer: NodeJS.Timeout | undefined;
  const saveBounds = (): void => {
    if (isDemoMode() || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    void ipcBridge?.sessionStore.saveWindowBounds(key, win.getNormalBounds(), win.isMaximized()).catch(() => {});
  };
  const scheduleSaveBounds = (): void => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBounds, BOUNDS_SAVE_DEBOUNCE_MS);
  };
  win.on('resize', scheduleSaveBounds);
  win.on('move', scheduleSaveBounds);
  win.once('ready-to-show', saveBounds);

  win.on('close', (event) => {
    clearTimeout(boundsTimer);
    saveBounds();
    if (isQuitting || closeConfirmed.has(windowId)) return;
    event.preventDefault();
    if (isMain) {
      if (ipcBridge?.aiHub?.background) { win.hide(); return; }
      // Always defer to app.quit() (handled by 'before-quit' below) instead of
      // letting the window close on its own, so a plain window-close ("X" the
      // window) goes through the same graceful shutdown — ipcBridge.dispose(),
      // killing SSH tunnels/agents — as Cmd+Q or the app menu, rather than
      // tearing everything down hard. Closing the main window therefore closes
      // every other window too.
      void (async () => {
        if (!(await confirmQuit())) return;
        app.quit();
      })();
    } else {
      void closeSecondaryWindow(win, key);
    }
  });

  win.on('closed', () => {
    clearTimeout(boundsTimer);
    closeConfirmed.delete(windowId);
    if (mainWindow === win) mainWindow = null;
    // Whatever way the window went away, the sessions it owned have nobody left to show them.
    endSessions(windowManager.unregister(windowId));
  });

  if (isMain && process.platform === 'win32') {
    let revealed = false;
    const reveal = (): void => {
      if (revealed) return;
      revealed = true;
      clearTimeout(fallback);
      splash?.setProgress(100, 'Ready');
      if (!win.isDestroyed() && !process.argv.includes('--background')) {
        win.show();
        win.focus();
        if (isDemoMode()) {
          win.setAlwaysOnTop(true);
          win.focus();
          setTimeout(() => {
            if (!win.isDestroyed()) win.setAlwaysOnTop(false);
          }, 500);
        }
      }
      splash?.close();
      splash = null;
    };
    // Never leave the user stuck on the splash if the renderer fails to load.
    const fallback = setTimeout(reveal, 30_000);
    win.webContents.on('did-start-loading', () => splash?.setProgress(70, 'Loading interface…'));
    win.webContents.on('dom-ready', () => splash?.setProgress(85, 'Starting interface…'));
    win.webContents.once('did-finish-load', reveal);
    win.webContents.once('did-fail-load', reveal);
    win.once('closed', () => {
      clearTimeout(fallback);
      splash?.close();
      splash = null;
    });
  }

  return win;
}

/** Ends terminal/log sessions (each manager ignores ids that are not its own). */
function endSessions(sessionIds: string[]): void {
  for (const sessionId of sessionIds) {
    ipcBridge?.sshPtyManager.kill(sessionId);
    ipcBridge?.k8sTerminalManager.kill(sessionId);
    ipcBridge?.k8sLogManager.stop(sessionId);
  }
}

/**
 * Closing a secondary window ends its sessions and removes it from the saved layout (the main
 * window and the app keep running). Asks first when it still has live sessions.
 */
async function closeSecondaryWindow(win: BrowserWindow, key: string | null): Promise<void> {
  const windowId = win.webContents.id;
  const sessionIds = windowManager.sessionsOf(windowId);
  if (sessionIds.length > 0 && ipcBridge) {
    if (!win.isDestroyed()) win.focus();
    const proceed = await ipcBridge.promptQuitConfirm({ kind: 'close-window', sessionCount: sessionIds.length });
    if (!proceed) return;
  }
  if (win.isDestroyed()) return;
  if (key !== null && !isDemoMode()) void ipcBridge?.sessionStore.forgetWindow(key).catch(() => {});
  endSessions(sessionIds);
  closeConfirmed.add(windowId);
  win.close();
}

/** Opens a window on the monitor the pointer is on; with a handoff it opens for that moved tab. */
function openNewWindow(handoff?: TabHandoff): void {
  const key = `w-${crypto.randomUUID().slice(0, 8)}`;
  const win = createWindow(key, { bounds: boundsForNewWindow() });
  if (handoff) {
    const windowId = win.webContents.id;
    windowManager.setHandoff(windowId, handoff);
    windowManager.reserve(handoff.sessions.map((s) => s.sessionId), windowId);
  }
}

const windowActions: WindowActions = {
  open: openNewWindow,
  adopt(targetWindowId, handoff, fromWindowId) {
    const target = windowManager.get(targetWindowId);
    if (!target || target.isDestroyed() || targetWindowId === fromWindowId) return false;
    windowManager.reserve(handoff.sessions.map((s) => s.sessionId), targetWindowId);
    target.webContents.send(IPC_CHANNELS.WINDOW_ADOPT_TAB, handoff);
    if (target.isMinimized()) target.restore();
    target.focus();
    return true;
  },
  takeHandoff: (windowId) => (windowManager.takeHandoff(windowId) as TabHandoff | undefined) ?? null,
  list: (currentWindowId) =>
    windowManager.describe().map((w, index) => ({
      id: w.id,
      label: `Window ${index + 1}`,
      current: w.id === currentWindowId,
    })),
};

/** Reopens the windows of the last run: the main one first, then the saved secondary ones. */
async function restoreWindows(): Promise<void> {
  let session: SessionData | null = null;
  // Demo mode opens a clean Demo Workspace: no previous windows (or their tabs) are restored.
  // isDemoMode() (decided at launch, see ./demo/demoMode) matches SESSION_GET.
  if (!isDemoMode()) {
    try {
      session = (await ipcBridge?.sessionStore.getSession()) ?? null;
    } catch {
      // Unreadable session: just open one default window.
    }
  }
  createWindow(null, { bounds: session?.mainBounds, maximized: session?.mainMaximized });
  for (const saved of restorableWindows(session)) {
    createWindow(saved.key, { bounds: saved.bounds, maximized: saved.maximized });
  }
}

// Initialize IPC bridge before or when app is ready
async function initializeApp(): Promise<void> {
  splash?.setProgress(10, 'Starting…');

  // Loaded lazily so the splash is already on screen while the (large) service
  // layer is parsed, instead of showing nothing until it is done.
  const { IpcBridge } = await import('./IpcBridge');
  splash?.setProgress(35, 'Loading services…');

  // Read the machine policy before any store exists, so every settings read already sees it.
  const policy = await loadPolicy();
  for (const warning of policy.warnings) log.warn(warning);

  // Set registry directory for ssh-agents
  configureRegistryDir(path.join(app.getPath('userData'), 'runtime-agents'));

  // Remove default dead application menu
  Menu.setApplicationMenu(null);

  // Initialize and register IPC bridge
  ipcBridge = new IpcBridge({
    policy,
    getWebContents: () => windowManager.focusedWebContents() as Electron.WebContents | undefined,
    isTrustedFrame: (frame: Electron.WebFrameMain | null) => windowManager.isTrustedFrame(frame),
    windows: windowManager,
    windowActions,
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
      // Login items are per machine and belong to the real installation: a demo instance (with its own,
      // fresh preferences) must neither add nor remove them.
      if (isDemoMode()) return;
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
    relaunchForDemoMode,
  });
  ipcBridge.register();
  await ipcBridge.aiHub.initialize().catch((error) => log.warn('AI Hub initialization failed', error));
  void ipcBridge.settingsStore
    .getSettings()
    .then((settings) => setLogLevel(resolveLogLevel(settings.logLevel)))
    .catch(() => {});
  splash?.setProgress(55, 'Creating window…');
  // A previous run may have crashed before it could empty the clipboard history on exit.
  void ipcBridge.clearClipboardHistoryIfConfigured().catch(() => {});

  // Create the main window immediately so the UI starts loading without waiting for subshells
  await restoreWindows();
  ipcBridge.startUpdateChecks();

  // Run background tasks (orphan cleanup, login shell environment, trust store, ~/.ssh/config sync)
  // in parallel with window loading so startup time is not penalized
  void Promise.all([
    AgentLifecycleManager.cleanupOrphanedResources(),
    applyLoginShellEnv().then(() => {
      void SystemTrustStore.init();
    }),
    // Syncs the managed block, then (via onLocalSshConfigSynced) clears any agent block a crashed run left behind.
    // Not in demo mode: the demo's own profile store must never rewrite the real ~/.ssh/config.
    isDemoMode() ? undefined : ipcBridge.profileSyncService.autoSyncLocalSshConfig(),
  ]).catch((err) => {
    log.warn('background initialization error', err);
  });

  void AgentLifecycleManager.ensureAgent();

  if (!isEncryptionAvailable()) {
    log.warn(
      'no OS keyring available (safeStorage.isEncryptionAvailable() === false): ' +
        'saved credentials will be stored in PLAINTEXT on disk instead of encrypted'
    );
  } else {
    // On Linux, safeStorage auto-selects a keyring backend (gnome_libsecret/kwallet*/basic_text)
    // at startup unless pinned via `--password-store=...` (pinned above on Linux) — if the
    // backend selected differs between runs (e.g. depending on which keyring daemon happens to be
    // reachable at the exact moment Electron starts), a secret encrypted under one backend's key
    // can silently fail to decrypt under a different one chosen on a later run (see
    // decryptSecretValue's empty-string-on-failure fallback). Logged every startup specifically so
    // a future "my saved credentials stopped working" report can be checked against this.
    try {
      log.info(`OS keyring backend for encrypted credentials: ${safeStorage.getSelectedStorageBackend?.() ?? '(unknown — Electron API unavailable)'}`);
    } catch (err) {
      log.warn('Failed to read the selected OS keyring backend (non-fatal):', err);
    }
  }
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  splash = showSplash();
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
          await ipcBridge.dispose();
        } catch {
          // ignore
        }
        ipcBridge = null;
        AgentLifecycleManager.killAllPrivateAgents();
        quitLog.info('dispose finished; quitting');
        // Bounded so a stuck disk can never block quit (or the relaunch that follows an update).
        await Promise.race([flushLogs(), new Promise((resolve) => setTimeout(resolve, 1000))]);
        if (hasSingleInstanceLock) {
          hasSingleInstanceLock = false;
          try {
            app.releaseSingleInstanceLock();
          } catch {
            // ignore
          }
        }
        app.quit();
      } else {
        AgentLifecycleManager.killAllPrivateAgents();
        if (hasSingleInstanceLock) {
          hasSingleInstanceLock = false;
          try {
            app.releaseSingleInstanceLock();
          } catch {
            // ignore
          }
        }
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
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

export { createWindow, ipcBridge };
