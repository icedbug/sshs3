import fs from 'node:fs/promises';
import { backupCorruptFile, writeFileAtomic } from '../storage/atomicFile';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import { parseK8sProfile, parseStoredK8sProfile } from '../ipc/ipcHelpers';
import type { K8sProfile } from '../../shared/types/kubernetes';

/**
 * Saved clusters, kept apart from profiles.json (whose store only knows SSH and S3). A profile carries
 * no secret: the token only lives in the kubeconfig. Deletes are tombstones so profile sync can
 * propagate them; every other caller sees only live profiles through list().
 */
export class K8sProfileStore {
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
      this.filePath = path.join(baseDir, 'k8s-profiles.json');
    }
  }

  /** Live (not deleted) profiles — what the rest of the app sees. */
  public async list(): Promise<K8sProfile[]> {
    return (await this.listIncludingTombstones()).filter((p) => !p.deletedAt);
  }

  /** Also returns soft-deleted profiles; only remote profile sync needs these. */
  public async listIncludingTombstones(): Promise<K8sProfile[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch {
      return [];
    }
    try {
      const data = JSON.parse(raw);
      const entries: unknown[] = Array.isArray(data?.profiles) ? data.profiles : [];
      const profiles: K8sProfile[] = [];
      for (const entry of entries) {
        try {
          profiles.push(parseStoredK8sProfile(entry));
        } catch {
          // Skip an entry that no longer validates rather than failing the whole list.
        }
      }
      return profiles;
    } catch {
      await backupCorruptFile(this.filePath, raw);
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

  public async save(profile: K8sProfile): Promise<K8sProfile> {
    // parseK8sProfile drops deletedAt, so saving also revives a deleted profile.
    const validated = parseK8sProfile(profile);
    return this.queueMutation(async () => {
      const profiles = await this.listIncludingTombstones();
      const stamped: K8sProfile = { ...validated, updatedAt: new Date().toISOString() };
      const index = profiles.findIndex((p) => p.id === stamped.id);
      if (index >= 0) profiles[index] = stamped;
      else profiles.push(stamped);
      await this.persist(profiles);
      return stamped;
    });
  }

  public async delete(id: string): Promise<void> {
    if (typeof id !== 'string' || !id) return;
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
  public async replaceAll(profiles: K8sProfile[]): Promise<void> {
    return this.queueMutation(() => this.persist(profiles));
  }

  /** Read, merge and write as one queued step (see `ProfileStore.mergeAll`); `compute` returns null to write nothing. */
  public async mergeAll(compute: (current: K8sProfile[]) => K8sProfile[] | null): Promise<boolean> {
    return this.queueMutation(async () => {
      const next = compute(await this.listIncludingTombstones());
      if (!next) return false;
      await this.persist(next);
      return true;
    });
  }

  private async persist(profiles: K8sProfile[]): Promise<void> {
    await writeFileAtomic(this.filePath, JSON.stringify({ profiles }, null, 2), { mode: 0o600 });
  }
}
