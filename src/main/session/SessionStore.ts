import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import type { SessionData } from '../../shared/types/session';
import { sanitizePaneNode } from '../../shared/sessionSanitize';

export function sanitizeSessionData(data: SessionData): SessionData {
  if (!data || !Array.isArray(data.tabs)) {
    return data;
  }
  return {
    ...data,
    tabs: data.tabs.map((tab) => {
      if (!tab.paneTree) return tab;
      return {
        ...tab,
        paneTree: sanitizePaneNode(tab.paneTree),
      };
    }),
  };
}

export class SessionStore {
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

    return this.queueMutation(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(cleanData, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      try {
        await fs.chmod(this.filePath, 0o600);
      } catch {
        // Ignore chmod failures on non-POSIX filesystems
      }
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
