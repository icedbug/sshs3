import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types/settings';

export class SettingsStore {
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(customPath?: string) {
    if (customPath) {
      this.filePath = customPath;
    } else {
      let baseDir: string;
      try {
        baseDir = app.getPath('userData');
      } catch {
        baseDir = path.join(os.homedir(), '.sshs3');
      }
      this.filePath = path.join(baseDir, 'settings.json');
    }
  }

  public getFilePath(): string {
    return this.filePath;
  }

  private getLegacyFilePath(): string | null {
    try {
      const configDir = path.dirname(this.filePath);
      const parent = path.dirname(configDir);
      const legacyConfig = path.join(parent, 'multissh', 'settings.json');
      const legacyHome = path.join(os.homedir(), '.multissh', 'settings.json');
      return legacyConfig !== this.filePath ? legacyConfig : legacyHome;
    } catch {
      return null;
    }
  }

  public async getSettings(): Promise<AppSettings> {
    try {
      const raw = (await fs.readFile(this.filePath, 'utf-8')).replace(/^\uFEFF/, '');
      const data = JSON.parse(raw);
      return {
        ...DEFAULT_SETTINGS,
        ...data,
      };
    } catch {
      const legacyPath = this.getLegacyFilePath();
      if (legacyPath) {
        try {
          const raw = (await fs.readFile(legacyPath, 'utf-8')).replace(/^\uFEFF/, '');
          const data = JSON.parse(raw);
          const loaded = {
            ...DEFAULT_SETTINGS,
            ...data,
          };
          void this.saveSettings(loaded).catch(() => {});
          return loaded;
        } catch {
          // Ignore legacy read errors
        }
      }
      return { ...DEFAULT_SETTINGS };
    }
  }

  /**
   * @param options.preserveTimestamp When true, don't stamp `updatedAt` with
   *   "now". Used exclusively by remote profile sync when writing back the
   *   winning side's settings object as-is.
   */
  public async saveSettings(
    partial: Partial<AppSettings>,
    options?: { preserveTimestamp?: boolean }
  ): Promise<AppSettings> {
    return this.queueMutation(async () => {
      const current = await this.getSettings();
      const updated: AppSettings = {
        ...current,
        ...partial,
        updatedAt: options?.preserveTimestamp ? (partial.updatedAt ?? current.updatedAt) : new Date().toISOString(),
      };
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(updated, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      try {
        await fs.chmod(this.filePath, 0o600);
      } catch {
        // Ignore chmod failures on non-POSIX filesystems
      }
      return updated;
    });
  }

  private queueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const resultPromise = this.writeQueue.then(mutation, mutation);
    this.writeQueue = resultPromise.then(
      () => {},
      () => {}
    );
    return resultPromise;
  }
}
