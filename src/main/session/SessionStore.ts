import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import type { SavedTab, SavedWindowBounds, SessionData } from '../../shared/types/session';
import { sanitizePaneNode, sanitizeTabConfigs } from '../../shared/sessionSanitize';
import {
  mergeWindowBounds,
  mergeWindowSave,
  removeWindow,
  sessionViewForWindow,
  type WindowKey,
} from './windowSessions';
import { writeFileAtomic } from '../storage/atomicFile';

export function sanitizeSessionData(data: SessionData): SessionData {
  if (!data || !Array.isArray(data.tabs)) {
    return data;
  }
  return {
    ...data,
    tabs: sanitizeTabs(data.tabs),
    ...(Array.isArray(data.windows)
      ? { windows: data.windows.map((w) => ({ ...w, tabs: sanitizeTabs(Array.isArray(w.tabs) ? w.tabs : []) })) }
      : {}),
  };
}

function sanitizeTabs(tabs: SavedTab[]): SavedTab[] {
  return tabs.map((rawTab) => {
    const tab = sanitizeTabConfigs(rawTab);
    if (!tab.paneTree) return tab;
    return {
      ...tab,
      paneTree: sanitizePaneNode(tab.paneTree),
    };
  });
}

export class SessionStore {
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  /** Keys of windows closed on purpose; a save still in flight from one must not bring it back. */
  private readonly forgottenWindows = new Set<string>();

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
      this.filePath = path.join(baseDir, 'session.json');
    }
  }

  public getFilePath(): string {
    return this.filePath;
  }

  public async getSession(): Promise<SessionData | null> {
    try {
      const raw = (await fs.readFile(this.filePath, 'utf-8')).replace(/^\uFEFF/, '');
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.tabs)) {
        return null;
      }
      return sanitizeSessionData(data as SessionData);
    } catch {
      return null;
    }
  }

  public async saveSession(data: SessionData): Promise<void> {
    if (!data) return;
    const cleanData = sanitizeSessionData(data);

    return this.queueMutation(() => this.writeData(cleanData));
  }

  /** The session as one window's renderer sees it (its own tabs, shared lastPaths/panes). */
  public async getSessionForWindow(key: WindowKey): Promise<SessionData | null> {
    return sessionViewForWindow(await this.getSession(), key);
  }

  /** Saves one window's tabs without clobbering the others; the read happens inside the write queue. */
  public async saveSessionForWindow(key: WindowKey, data: SessionData): Promise<void> {
    if (!data || !Array.isArray(data.tabs)) return;
    if (key !== null && this.forgottenWindows.has(key)) return;
    const cleanData = sanitizeSessionData(data);
    return this.queueMutation(async () => {
      await this.writeData(mergeWindowSave(await this.getSession(), key, cleanData));
    });
  }

  public async saveWindowBounds(key: WindowKey, bounds: SavedWindowBounds, maximized: boolean): Promise<void> {
    if (key !== null && this.forgottenWindows.has(key)) return;
    return this.queueMutation(async () => {
      await this.writeData(mergeWindowBounds(await this.getSession(), key, bounds, maximized));
    });
  }

  /** Drops a secondary window the user closed on purpose, so it is not reopened next start. */
  public async forgetWindow(key: string): Promise<void> {
    this.forgottenWindows.add(key);
    return this.queueMutation(async () => {
      const next = removeWindow(await this.getSession(), key);
      if (next) await this.writeData(next);
    });
  }

  private async writeData(data: SessionData): Promise<void> {
    await writeFileAtomic(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
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
