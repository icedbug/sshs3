import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let configuredDataDir =
  process.env.SSHS3_DATA_DIR || path.join(os.homedir(), '.sshs3-server');

export function setWebDataDir(dir: string): void {
  configuredDataDir = path.resolve(dir);
  cachedMasterKey = null;
}

export const setHeadlessUserDataPath = setWebDataDir;

export function getWebDataDir(): string {
  return configuredDataDir;
}

let cachedMasterKey: Buffer | null = null;

function getOrCreateMasterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;
  if (process.env.SSHS3_MASTER_KEY?.trim()) {
    cachedMasterKey = crypto
      .createHash('sha256')
      .update(process.env.SSHS3_MASTER_KEY.trim(), 'utf8')
      .digest();
    return cachedMasterKey;
  }
  const keyPath = path.join(configuredDataDir, 'server-master.key');
  try {
    fs.mkdirSync(configuredDataDir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(keyPath)) {
      const raw = fs.readFileSync(keyPath, 'utf8').trim();
      const buf = Buffer.from(raw, 'hex');
      if (buf.length === 32) {
        cachedMasterKey = buf;
        return cachedMasterKey;
      }
    }
    const generated = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, generated.toString('hex'), { mode: 0o600 });
    cachedMasterKey = generated;
    return cachedMasterKey;
  } catch {
    cachedMasterKey = crypto
      .createHash('sha256')
      .update(`sshs3-fallback-${os.hostname()}-${os.userInfo().username}`)
      .digest();
    return cachedMasterKey;
  }
}

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return true;
  },
  encryptString(plainText: string): Buffer {
    const key = getOrCreateMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plainText, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]);
  },
  decryptString(encrypted: Buffer): string {
    const buf = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
    if (buf.length < 28) {
      throw new Error('Invalid encrypted payload length');
    }
    const key = getOrCreateMasterKey();
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  },
};

class HeadlessApp extends EventEmitter {
  isPackaged = false;
  private customPaths = new Map<string, string>();

  setName(_name: string): void {}
  setDesktopName(_name: string): void {}
  getVersion(): string {
    return process.env.npm_package_version || '0.96.34';
  }
  getAppPath(): string {
    return process.cwd();
  }
  setPath(name: string, value: string): void {
    this.customPaths.set(name, value);
    if (name === 'userData') {
      setWebDataDir(value);
    }
  }
  getPath(name: string): string {
    const override = this.customPaths.get(name);
    if (override) return override;
    switch (name) {
      case 'userData':
        return configuredDataDir;
      case 'logs':
        return path.join(configuredDataDir, 'logs');
      case 'home':
        return os.homedir();
      case 'temp':
        return os.tmpdir();
      case 'exe':
        return process.execPath;
      default:
        return path.join(configuredDataDir, name);
    }
  }
  requestSingleInstanceLock(): boolean {
    return true;
  }
  disableHardwareAcceleration(): void {}
  setLoginItemSettings(_settings: Record<string, unknown>): void {}
  getLoginItemSettings(): { openAtLogin: boolean } {
    return { openAtLogin: false };
  }
  quit(): void {}
  whenReady(): Promise<void> {
    return Promise.resolve();
  }
}

export const app = new HeadlessApp();

class HeadlessIpcMain extends EventEmitter {
  private rpcHandlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();

  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown,
  ): void {
    this.rpcHandlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.rpcHandlers.delete(channel);
  }

  async invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.rpcHandlers.get(channel);
    if (!handler) {
      throw new Error(`No IPC handler registered for channel: ${channel}`);
    }
    return await handler({ sender: null }, ...args);
  }
}

export const ipcMain = new HeadlessIpcMain();

let clipboardText = '';
export const clipboard = {
  readText(): string {
    return clipboardText;
  },
  writeText(text: string): void {
    clipboardText = String(text ?? '');
  },
};

export const dialog = {
  async showOpenDialog(): Promise<{ canceled: boolean; filePaths: string[] }> {
    return { canceled: true, filePaths: [] };
  },
  async showSaveDialog(): Promise<{ canceled: boolean; filePath?: string }> {
    return { canceled: true, filePath: undefined };
  },
  showMessageBoxSync(): number {
    return 0;
  },
  async showMessageBox(): Promise<{ response: number }> {
    return { response: 0 };
  },
};

export const shell = {
  async openExternal(_url: string): Promise<void> {},
  async openPath(_path: string): Promise<string> {
    return '';
  },
  showItemInFolder(_fullPath: string): void {},
};

export class Notification extends EventEmitter {
  constructor(_options?: Record<string, unknown>) {
    super();
  }
  static isSupported(): boolean {
    return false;
  }
  show(): void {}
  close(): void {}
}

export const powerMonitor = new EventEmitter();

export class BrowserWindow extends EventEmitter {
  static getAllWindows(): BrowserWindow[] {
    return [];
  }
  webContents = {
    send: (_channel: string, ..._args: unknown[]) => {},
    setWindowOpenHandler: () => {},
    on: () => {},
    once: () => {},
  };
  isDestroyed(): boolean {
    return false;
  }
  isMinimized(): boolean {
    return false;
  }
  restore(): void {}
  focus(): void {}
  show(): void {}
  hide(): void {}
  close(): void {}
  setIcon(): void {}
  loadURL(): Promise<void> {
    return Promise.resolve();
  }
  loadFile(): Promise<void> {
    return Promise.resolve();
  }
}

export const Menu = {
  setApplicationMenu(): void {},
  buildFromTemplate(): Record<string, unknown> {
    return {};
  },
};

export const nativeImage = {
  createFromPath(): { isEmpty: () => boolean } {
    return { isEmpty: () => true };
  },
  createEmpty(): { isEmpty: () => boolean } {
    return { isEmpty: () => true };
  },
};

export class Tray extends EventEmitter {
  setToolTip(): void {}
  setContextMenu(): void {}
  destroy(): void {}
}

export const contextBridge = {
  exposeInMainWorld(): void {},
};

export const ipcRenderer = new EventEmitter();

export const webUtils = {
  getPathForFile(file: { path?: string; name?: string }): string {
    return file?.path || file?.name || '';
  },
};

export default {
  app,
  safeStorage,
  ipcMain,
  clipboard,
  dialog,
  shell,
  Notification,
  powerMonitor,
  BrowserWindow,
  Menu,
  nativeImage,
  Tray,
  contextBridge,
  ipcRenderer,
  webUtils,
};
