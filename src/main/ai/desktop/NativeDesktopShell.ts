import fs from 'node:fs';
import path from 'node:path';
import { app, ipcMain, WebContentsView, type BrowserWindow, type WebContents, type IpcMainInvokeEvent } from 'electron';
import { NATIVE_HERMES_CHANNELS, type NativeHermesState } from '../../../shared/types/nativeHermes';
import { desktopGeometry, parseDesktopState } from './layout';
import { nativeTools } from './nativeTools';
import { nativeEvents } from './nativeEvents';
import { getNativeHermesView } from './nativeWindow';
import { SHELL_KINDS, type ShellKind } from '../../../shared/types/aiHub';

/** Hermes owns its original window and renderer; sshs3 owns this kept-alive terminal view. */
export class NativeDesktopShell {
  readonly terminal: WebContentsView;
  readonly hermes: WebContentsView;
  private state: NativeHermesState;
  private readonly stateFile: string;
  private disposed = false;
  private saveTimer?: NodeJS.Timeout;

  constructor(readonly window: BrowserWindow, preload: string, renderer: string) {
    this.stateFile = path.join(app.getPath('userData'), 'hermes-shell-layout.json');
    try { this.state = parseDesktopState(JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))); }
    catch { this.state = parseDesktopState(undefined); }
    this.hermes = getNativeHermesView(window);
    // Both visible surfaces are siblings; neither intercepts the other's input.
    window.contentView.setBackgroundColor('#00000000');
    window.webContents.setBackgroundThrottling(false);
    this.terminal = new WebContentsView({ webPreferences: {
      preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
      additionalArguments: ['--sshs3-native-hermes'],
    } });
    window.contentView.addChildView(this.terminal);
    this.terminal.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.terminal.webContents.on('will-navigate', event => event.preventDefault());
    ipcMain.handle(NATIVE_HERMES_CHANNELS.get, event => { this.requireOwner(event); return this.current(); });
    ipcMain.handle(NATIVE_HERMES_CHANNELS.set, (event, update: unknown) => {
      this.requireOwner(event);
      this.state = parseDesktopState({ ...this.state, ...(update && typeof update === 'object' ? update : {}) });
      this.apply();
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(this.save, 250);
      return this.current();
    });
    ipcMain.handle(NATIVE_HERMES_CHANNELS.tools, event => { this.requireOwner(event); return nativeTools.snapshot(); });
    ipcMain.handle(NATIVE_HERMES_CHANNELS.select, (event, id?: string) => {
      if (event.senderFrame !== this.terminal.webContents.mainFrame) throw new Error('Only the terminal can select the AI target');
      nativeTools.selectTerminal(id);
    });
    ipcMain.handle(NATIVE_HERMES_CHANNELS.arm, async (event, shell: ShellKind) => {
      this.requireOwner(event);
      if (!SHELL_KINDS.includes(shell)) throw new Error('Unsupported terminal shell');
      await nativeTools.armSelected(shell);
    });
    ipcMain.handle(NATIVE_HERMES_CHANNELS.approve, (event, task: string, change: string, allowed: boolean) => {
      this.requireOwner(event);
      if (typeof allowed !== 'boolean') throw new Error('Approval must be explicit');
      nativeTools.approve(task, change, allowed);
    });
    ipcMain.handle(NATIVE_HERMES_CHANNELS.takeover, (event, task: string) => { this.requireOwner(event); nativeTools.takeover(task); });
    ipcMain.handle(NATIVE_HERMES_CHANNELS.resume, async (event, task: string) => { this.requireOwner(event); await nativeTools.resume(task); });
    nativeEvents.on('toolsChanged', this.publishTools);
    window.on('resize', this.apply);
    window.webContents.on('did-finish-load', this.apply);
    this.terminal.webContents.on('did-finish-load', this.apply);
    window.webContents.on('did-finish-load', this.publishTools);
    this.terminal.webContents.on('did-finish-load', this.publishTools);
    window.once('closed', this.dispose);
    this.apply();
    void this.terminal.webContents.loadFile(renderer);
  }

  current(): NativeHermesState { return { ...this.state }; }

  private readonly save = (): void => {
    fs.writeFileSync(this.stateFile + '.tmp', JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(this.stateFile + '.tmp', this.stateFile);
    this.saveTimer = undefined;
  };

  private requireOwner(event: IpcMainInvokeEvent): void {
    const owned = [this.window.webContents, this.terminal.webContents];
    if (!owned.some(contents => !contents.isDestroyed() && event.senderFrame === contents.mainFrame)) {
      throw new Error('Native Hermes IPC rejected an untrusted frame');
    }
  }

  readonly apply = (): void => {
    if (this.disposed || this.window.isDestroyed()) return;
    const geometry = desktopGeometry(this.state, this.window.getContentBounds());
    this.hermes.setBounds({ x: this.state.mode === 'full' ? 0 : geometry.terminal.width,
      y: 0, width: geometry.chatWidth, height: geometry.terminal.height });
    this.hermes.setVisible(this.state.mode !== 'closed');
    this.terminal.setBounds(geometry.terminal);
    this.terminal.setVisible(geometry.visible);
    const layout = { ...this.current(), width: geometry.chatWidth };
    for (const contents of [this.window.webContents, this.terminal.webContents]) {
      if (!contents.isDestroyed()) contents.send(NATIVE_HERMES_CHANNELS.changed, layout);
    }
  };

  getWebContents(): WebContents | null { return this.disposed ? null : this.terminal.webContents; }

  private readonly publishTools = (): void => {
    if (this.disposed) return;
    const state = nativeTools.snapshot();
    for (const contents of [this.window.webContents, this.terminal.webContents]) {
      if (!contents.isDestroyed()) contents.send(NATIVE_HERMES_CHANNELS.toolsChanged, state);
    }
  };

  readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.save(); }
    for (const channel of Object.values(NATIVE_HERMES_CHANNELS)) ipcMain.removeHandler(channel);
    nativeEvents.removeListener('toolsChanged', this.publishTools);
    this.window.removeListener('resize', this.apply);
    if (!this.terminal.webContents.isDestroyed()) this.terminal.webContents.close();
  };
}
