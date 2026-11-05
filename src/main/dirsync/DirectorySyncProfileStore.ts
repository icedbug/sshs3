import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import type { DirectorySyncProfile } from '../../shared/types/dirsync';
import { backupCorruptFile, writeFileAtomic } from '../storage/atomicFile';

export class DirectorySyncProfileStore {
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
      this.filePath = path.join(baseDir, 'directory-sync-profiles.json');
    }
  }

  public getFilePath(): string {
    return this.filePath;
  }

  /** Live (not deleted) profiles — what the rest of the app sees. */
  public async list(): Promise<DirectorySyncProfile[]> {
    return (await this.listIncludingTombstones()).filter((p) => !p.deletedAt);
  }

  /**
   * Also returns soft-deleted (tombstoned) profiles. Used by remote profile sync, which has to
   * see and propagate deletions; every other caller should use list().
   */
  public async listIncludingTombstones(): Promise<DirectorySyncProfile[]> {
    let raw: string | undefined;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw);
      return Array.isArray(data.profiles) ? data.profiles : [];
    } catch (err) {
      // [] would make the next save wipe every profile: keep a copy of an unparsable file first.
      if (raw !== undefined && err instanceof SyntaxError) await backupCorruptFile(this.filePath, raw);
      return [];
    }
  }

  private queueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const resultPromise = this.writeQueue.then(mutation, mutation);
    this.writeQueue = resultPromise.then(
      () => {},
      () => {}
    );
    return resultPromise;
  }

  public async save(profile: DirectorySyncProfile): Promise<DirectorySyncProfile> {
    if (!profile || !profile.id || typeof profile.id !== 'string' || !profile.id.trim()) {
      throw new Error('Profile ID is required');
    }

    return this.queueMutation(async () => {
      const profiles = await this.listIncludingTombstones();
      const now = new Date().toISOString();
      const index = profiles.findIndex((p) => p.id === profile.id);
      const { deletedAt: _revived, ...live } = profile;
      const stamped: DirectorySyncProfile = {
        ...live,
        createdAt: index >= 0 ? profiles[index].createdAt : (profile.createdAt ?? now),
        updatedAt: now,
      };
      if (index >= 0) {
        profiles[index] = stamped;
      } else {
        profiles.push(stamped);
      }
      await this.persist(profiles);
      return stamped;
    });
  }

  public async delete(id: string): Promise<void> {
    if (!id) return;
    return this.queueMutation(async () => {
      const profiles = await this.listIncludingTombstones();
      const index = profiles.findIndex((p) => p.id === id);
      if (index < 0 || profiles[index].deletedAt) return;
      const now = new Date().toISOString();
      profiles[index] = { ...profiles[index], updatedAt: now, deletedAt: now };
      await this.persist(profiles);
    });
  }

  /** Replaces the whole set (tombstones included) verbatim — used when remote sync applies a merge. */
  public async replaceAll(profiles: DirectorySyncProfile[]): Promise<void> {
    return this.queueMutation(() => this.persist(profiles));
  }

  /** Read, merge and write as one queued step (see `ProfileStore.mergeAll`); `compute` returns null to write nothing. */
  public async mergeAll(compute: (current: DirectorySyncProfile[]) => DirectorySyncProfile[] | null): Promise<boolean> {
    return this.queueMutation(async () => {
      const next = compute(await this.listIncludingTombstones());
      if (!next) return false;
      await this.persist(next);
      return true;
    });
  }

  private async persist(profiles: DirectorySyncProfile[]): Promise<void> {
    await writeFileAtomic(this.filePath, JSON.stringify({ profiles }, null, 2), { mode: 0o600 });
  }
}
