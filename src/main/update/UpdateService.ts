import { app } from 'electron';
import electronUpdater from 'electron-updater';
import { createLogger } from '../log';
import type { UpdateState, UpdateUnsupportedReason } from '../../shared/types/update';
import { startLinuxRelaunch, type LinuxRelaunchHandle } from './linuxRelaunch';
import { isNsisInstall } from './installKind';

const INITIAL_CHECK_DELAY_MS = 30_000;
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_ERROR_LENGTH = 200;
const log = createLogger('update');

interface UpdateInfoLike {
  version: string;
}

interface ProgressLike {
  percent: number;
}

/** The subset of electron-updater's AppUpdater used here (also what tests mock). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  autoRunAppAfterInstall?: boolean;
  /** electron-updater's own diagnostics (download, install command, relaunch) go here. */
  logger?: unknown;
  on(event: 'checking-for-update', cb: () => void): unknown;
  on(event: 'update-available', cb: (info: UpdateInfoLike) => void): unknown;
  on(event: 'update-not-available', cb: () => void): unknown;
  on(event: 'download-progress', cb: (progress: ProgressLike) => void): unknown;
  on(event: 'update-downloaded', cb: (info: UpdateInfoLike) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateServiceOptions {
  /** Defaults to electron-updater's autoUpdater. */
  updater?: UpdaterLike;
  currentVersion?: string;
  isPackaged?: boolean;
  /** Defaults to process.platform. Windows is unsupported until the installer is code-signed. */
  platform?: NodeJS.Platform;
  /** Administrator switch (SSHS3_DISABLE_UPDATES=1, or the autoCheckUpdates policy set to false): no update traffic at all, including a manual check. */
  disabled?: boolean;
  /** Whether this copy was installed by the NSIS installer (Windows only matters). Defaults to checking the install folder. */
  isNsisInstall?: boolean;
  /** Whether periodic background checks are enabled (user setting). */
  getAutoCheck: () => Promise<boolean> | boolean;
  /**
   * Runs the app's quit confirmation (active transfers, confirm-before-quit)
   * before the installer is started; resolves false if the user cancelled.
   */
  confirmQuit?: () => Promise<boolean>;
  send: (state: UpdateState) => void;
  initialDelayMs?: number;
  pollIntervalMs?: number;
  /**
   * How long to let the renderer paint the "installing" state before the
   * synchronous installer blocks the main process. Defaults to 300 ms; 0 skips the wait.
   */
  paintDelayMs?: number;
  /**
   * Custom Linux relaunch hook (overrides startLinuxRelaunch, e.g. in tests). A returned handle is
   * cancelled when the install fails or is cancelled, so the helper does not relaunch the app later.
   */
  relaunchOnLinux?: () => LinuxRelaunchHandle | boolean | void;
}

/** Reduces an updater error to one short line; never forwards stacks or raw payloads. */
export function sanitizeUpdateError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = raw.split('\n')[0]?.trim() ?? '';
  return (firstLine || 'Update failed').slice(0, MAX_ERROR_LENGTH);
}

/**
 * Polls GitHub Releases via electron-updater. Nothing is downloaded or
 * installed without an explicit user action (autoDownload is off), and a
 * restart only happens through the normal quit flow so active transfers and
 * the quit confirmation are still honoured.
 */
export class UpdateService {
  private readonly updater: UpdaterLike | null;
  private readonly unsupportedReason: UpdateUnsupportedReason | null;
  private readonly options: UpdateServiceOptions;
  private state: UpdateState;
  private initialTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private installing = false;
  private pendingRelaunch?: LinuxRelaunchHandle;

  constructor(options: UpdateServiceOptions) {
    this.options = options;
    const isPackaged = options.isPackaged ?? app.isPackaged;
    this.unsupportedReason = options.disabled
      ? 'disabled'
      : !isPackaged
        ? 'dev'
        : (options.platform ?? process.platform) === 'win32'
          ? (options.isNsisInstall ?? isNsisInstall()) === false
            ? 'not-installer'
            : 'windows-unsigned'
          : null;
    this.state = {
      status: this.unsupportedReason ? 'unsupported' : 'idle',
      currentVersion: options.currentVersion ?? app.getVersion(),
      ...(this.unsupportedReason ? { unsupportedReason: this.unsupportedReason } : {}),
    };

    if (this.unsupportedReason) {
      this.updater = null;
      return;
    }
    const updater = options.updater ?? (electronUpdater.autoUpdater as unknown as UpdaterLike);
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    const updaterLog = createLogger('updater');
    const text = (m: unknown): string => (typeof m === 'string' ? m : m instanceof Error ? m.message : JSON.stringify(m));
    updater.logger = {
      info: (m: unknown) => updaterLog.info(text(m)),
      warn: (m: unknown) => updaterLog.warn(text(m)),
      error: (m: unknown) => updaterLog.error(text(m)),
      debug: (m: unknown) => updaterLog.debug(text(m)),
    };
    this.attach(updater);
    this.updater = updater;
  }

  public getState(): UpdateState {
    return { ...this.state };
  }

  /** Schedules the first check shortly after launch and then a periodic poll. */
  public start(): void {
    if (!this.updater || this.initialTimer || this.pollTimer) return;
    const initialDelay = this.options.initialDelayMs ?? INITIAL_CHECK_DELAY_MS;
    const interval = this.options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.initialTimer = setTimeout(() => void this.backgroundCheck(), initialDelay);
    this.initialTimer.unref?.();
    this.pollTimer = setInterval(() => void this.backgroundCheck(), interval);
    this.pollTimer.unref?.();
  }

  public dispose(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.initialTimer = null;
    this.pollTimer = null;
  }

  /** User-initiated check ("Check now"). */
  public async check(): Promise<UpdateState> {
    if (!this.updater || this.isBusy() || this.state.status === 'available') return this.getState();
    try {
      await this.updater.checkForUpdates();
      // An inactive updater (e.g. missing app-update.yml) resolves without emitting any event.
      if (this.getState().status === 'idle') {
        this.setState({ status: 'error', error: 'Update check is not available for this installation' });
      }
    } catch (err) {
      this.setState({ status: 'error', error: sanitizeUpdateError(err), progress: undefined });
    }
    return this.getState();
  }

  public async download(): Promise<UpdateState> {
    if (!this.updater || this.state.status !== 'available') return this.getState();
    this.setState({ status: 'downloading', progress: 0, error: undefined });
    try {
      await this.updater.downloadUpdate();
      if (this.getState().status === 'downloading') {
        this.setState({ status: 'available', error: 'Download did not complete', progress: undefined });
      }
    } catch (err) {
      // Keep the offered version so the user can simply retry the download.
      this.setState({ status: 'available', error: sanitizeUpdateError(err), progress: undefined });
    }
    return this.getState();
  }

  /**
   * Restarts into the new version. The quit confirmation runs first because
   * quitAndInstall() starts the installer before app.quit(), so a cancel
   * afterwards would be too late.
   */
  public async install(): Promise<void> {
    if (!this.updater || this.state.status !== 'ready' || this.installing) return;
    this.installing = true;
    try {
      if (this.options.confirmQuit && !(await this.options.confirmQuit())) return;
      // electron-updater runs the package manager synchronously (spawnSync), which
      // freezes the main process; show the installing overlay first so the window
      // doesn't hang on the closing confirmation dialog.
      this.setState({ status: 'installing', error: undefined });
      const paintDelay = this.options.paintDelayMs ?? 300;
      if (paintDelay > 0) await new Promise((resolve) => setTimeout(resolve, paintDelay));
      log.info('quitAndInstall', { version: this.state.version });
      if ((this.options.platform ?? process.platform) === 'linux') {
        // A helper from an earlier attempt that did not go through must not stay behind a new one.
        this.cancelPendingRelaunch();
        const relaunch = this.options.relaunchOnLinux ?? (() => startLinuxRelaunch());
        const started = relaunch();
        this.pendingRelaunch = typeof started === 'object' && started !== null ? started : undefined;
        this.updater.autoRunAppAfterInstall = false;
        this.updater.quitAndInstall(false, false);
      } else {
        this.updater.quitAndInstall(false, true);
      }
    } catch (err) {
      this.cancelPendingRelaunch();
      // Like a failed install reported through the updater's 'error' event: stay retryable instead of
      // leaving the installing overlay up for good.
      if (this.getState().status === 'installing') this.setState({ status: 'ready', error: sanitizeUpdateError(err) });
      throw err;
    } finally {
      this.installing = false;
    }
  }

  private cancelPendingRelaunch(): void {
    this.pendingRelaunch?.cancel();
    this.pendingRelaunch = undefined;
  }

  private isBusy(): boolean {
    const { status } = this.state;
    return status === 'checking' || status === 'downloading' || status === 'ready' || status === 'installing';
  }

  private async backgroundCheck(): Promise<void> {
    try {
      if (!(await this.options.getAutoCheck())) return;
    } catch {
      return;
    }
    if (this.state.status === 'available') return;
    await this.check();
  }

  private attach(updater: UpdaterLike): void {
    updater.on('checking-for-update', () => this.setState({ status: 'checking', error: undefined }));
    updater.on('update-available', (info) =>
      this.setState({ status: 'available', version: info.version, progress: undefined })
    );
    updater.on('update-not-available', () =>
      this.setState({ status: 'up-to-date', version: undefined, progress: undefined })
    );
    updater.on('download-progress', (progress) =>
      this.setState({ status: 'downloading', progress: Math.round(progress.percent) })
    );
    updater.on('update-downloaded', (info) =>
      this.setState({ status: 'ready', version: info.version, progress: undefined })
    );
    updater.on('error', (err) => {
      // A failed or cancelled install (e.g. dismissed polkit prompt) keeps the downloaded update retryable.
      const status = this.state.status === 'installing' ? 'ready' : 'error';
      if (this.state.status === 'installing') this.cancelPendingRelaunch();
      this.setState({ status, error: sanitizeUpdateError(err), progress: undefined });
    });
  }

  private setState(patch: Partial<UpdateState>): void {
    const previous = this.state.status;
    this.state = { ...this.state, ...patch };
    if (previous !== this.state.status || patch.error) {
      log.info('state', { from: previous, to: this.state.status, version: this.state.version, error: patch.error });
    }
    this.options.send(this.getState());
  }
}
