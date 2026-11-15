import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { app } from 'electron';
import {
  CLIPBOARD_HISTORY_MAX_ENTRIES,
  CLIPBOARD_HISTORY_MAX_ENTRY_CHARS,
  type ClipboardHistoryEntry,
} from '../../shared/types/clipboard';
import { decryptSecretValue, encryptSecretValue, isEncryptionAvailable } from '../crypto/SecretFieldCrypto';
import {
  detectHighEntropySecrets,
  maskHighEntropySecrets,
  maskSecrets,
} from '../ai/hub/privacy';

const ENCRYPTED_PREFIX = 'enc:v1:';
export const DEFAULT_CLIPBOARD_SECRET_TTL_MS = 20_000;

export type ClipboardSecretPolicy = 'ttl-redact' | 'filter';

export interface ClipboardSecretClassification {
  sensitive: boolean;
  reason?: 'pattern' | 'high-entropy';
  redactedPreview: string;
}

export interface ClipboardHistoryRecord extends ClipboardHistoryEntry {
  sensitive?: boolean;
  redactedPreview?: string;
  expiresAt?: string;
}

export interface ClipboardHistoryStoreOptions {
  customPath?: string;
  /** How detected secrets are handled: 'ttl-redact' (default: short TTL + redacted preview) or 'filter' (drop). */
  secretPolicy?: ClipboardSecretPolicy;
  /** Short TTL in ms for sensitive entries when secretPolicy is 'ttl-redact' (default: 20_000). */
  secretTtlMs?: number;
}

/**
 * Classifies clipboard text using pattern-based secret detection and Shannon high-entropy
 * detection so sensitive copies can be filtered or given a short TTL + redacted preview.
 */
export function classifyClipboardSecret(text: string): ClipboardSecretClassification {
  if (!text) {
    return { sensitive: false, redactedPreview: text };
  }
  const patternMasked = maskSecrets(text);
  if (patternMasked !== text) {
    return {
      sensitive: true,
      reason: 'pattern',
      redactedPreview: maskHighEntropySecrets(patternMasked),
    };
  }
  const entropyMatches = detectHighEntropySecrets(text);
  if (entropyMatches.length > 0) {
    return {
      sensitive: true,
      reason: 'high-entropy',
      redactedPreview: maskHighEntropySecrets(text),
    };
  }
  return { sensitive: false, redactedPreview: text };
}

function isExpiredEntry(entry: ClipboardHistoryRecord, now = Date.now()): boolean {
  if (!entry.expiresAt) return false;
  const ts = Date.parse(entry.expiresAt);
  return Number.isFinite(ts) && ts <= now;
}

/**
 * Persistent history of terminal selections. Copied text routinely contains
 * passwords and tokens, so the whole list is encrypted with the OS keyring
 * (safeStorage) before it touches disk. Fail closed: with no keyring available
 * the history stays in memory only and nothing is written.
 */
export class ClipboardHistoryStore {
  private filePath: string;
  private secretPolicy: ClipboardSecretPolicy;
  private secretTtlMs: number;
  private writeQueue: Promise<void> = Promise.resolve();
  private cache: ClipboardHistoryRecord[] | null = null;
  private loading: Promise<ClipboardHistoryRecord[]> | null = null;

  constructor(customPathOrOptions?: string | ClipboardHistoryStoreOptions) {
    const opts: ClipboardHistoryStoreOptions =
      typeof customPathOrOptions === 'string'
        ? { customPath: customPathOrOptions }
        : customPathOrOptions ?? {};

    this.secretPolicy = opts.secretPolicy ?? 'ttl-redact';
    this.secretTtlMs =
      typeof opts.secretTtlMs === 'number' && opts.secretTtlMs > 0
        ? opts.secretTtlMs
        : DEFAULT_CLIPBOARD_SECRET_TTL_MS;

    if (opts.customPath) {
      this.filePath = opts.customPath;
    } else {
      let baseDir: string;
      try {
        baseDir = app.getPath('userData');
      } catch {
        baseDir = path.join(os.homedir(), '.sshs3');
      }
      this.filePath = path.join(baseDir, 'clipboard-history.json');
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

  private isEntry(value: unknown): value is ClipboardHistoryRecord {
    const e = value as ClipboardHistoryRecord;
    return (
      !!e &&
      typeof e.id === 'string' &&
      typeof e.text === 'string' &&
      typeof e.copiedAt === 'string' &&
      typeof e.hostKey === 'string' &&
      typeof e.hostLabel === 'string' &&
      (e.sensitive === undefined || typeof e.sensitive === 'boolean') &&
      (e.redactedPreview === undefined || typeof e.redactedPreview === 'string') &&
      (e.expiresAt === undefined || typeof e.expiresAt === 'string')
    );
  }

  // One shared read: a second caller must not overwrite a cache a mutation has updated meanwhile.
  private load(): Promise<ClipboardHistoryRecord[]> {
    if (this.cache) return Promise.resolve(this.cache);
    this.loading ??= this.readFromDisk().then((entries) => {
      this.cache ??= entries;
      this.loading = null;
      return this.cache;
    });
    return this.loading;
  }

  private async readFromDisk(): Promise<ClipboardHistoryRecord[]> {
    let entries: ClipboardHistoryRecord[] = [];
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf-8'));
      const payload = typeof raw?.data === 'string' ? decryptSecretValue(raw.data) : '';
      const parsed = payload ? JSON.parse(payload) : [];
      const now = Date.now();
      if (Array.isArray(parsed)) {
        entries = parsed.filter((e): e is ClipboardHistoryRecord => this.isEntry(e) && !isExpiredEntry(e, now));
      }
    } catch {
      // Missing, corrupted or undecryptable file: start with an empty history.
    }
    return entries;
  }

  private async removeFile(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
    await fs.rm(`${this.filePath}.tmp`, { force: true });
  }

  private async persist(entries: ClipboardHistoryRecord[]): Promise<void> {
    // encryptSecretValue falls back to plaintext when encryption fails, so verify the result
    // really is ciphertext before writing. Anything else must never reach the disk; also drop a
    // file left over from a time when a keyring was available, so it can't outlive "clear".
    const encrypted = isEncryptionAvailable() ? encryptSecretValue(JSON.stringify(entries)) : '';
    if (!encrypted.startsWith(ENCRYPTED_PREFIX)) {
      await this.removeFile();
      return;
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const body = JSON.stringify({ version: 1, data: encrypted });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, body, { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }

  /** Removes expired sensitive entries from memory and persisted storage. Returns the number removed. */
  public async purgeExpired(now = Date.now()): Promise<number> {
    return this.queueMutation(async () => {
      const current = await this.load();
      const active = current.filter((e) => !isExpiredEntry(e, now));
      const removed = current.length - active.length;
      if (removed > 0) {
        this.cache = active;
        await this.persist(this.cache);
      }
      return removed;
    });
  }

  /** Newest first. With `hostKey`, only entries copied on that host. */
  public async list(hostKey?: string): Promise<ClipboardHistoryRecord[]> {
    await this.writeQueue;
    const entries = await this.load();
    const now = Date.now();
    if (entries.some((e) => isExpiredEntry(e, now))) {
      await this.purgeExpired(now);
    }
    const active = (this.cache ?? entries).filter((e) => !isExpiredEntry(e, now));
    return hostKey !== undefined ? active.filter((e) => e.hostKey === hostKey) : [...active];
  }

  public async add(text: string, hostKey: string, hostLabel: string): Promise<void> {
    if (!text || text.length > CLIPBOARD_HISTORY_MAX_ENTRY_CHARS) return;
    const classification = classifyClipboardSecret(text);
    if (classification.sensitive && this.secretPolicy === 'filter') {
      return;
    }
    return this.queueMutation(async () => {
      const now = Date.now();
      const entries = (await this.load()).filter(
        (e) => !isExpiredEntry(e, now) && !(e.text === text && e.hostKey === hostKey)
      );
      const record: ClipboardHistoryRecord = {
        id: crypto.randomUUID(),
        text,
        copiedAt: new Date(now).toISOString(),
        hostKey,
        hostLabel,
      };
      if (classification.sensitive) {
        record.sensitive = true;
        record.redactedPreview = classification.redactedPreview;
        record.expiresAt = new Date(now + this.secretTtlMs).toISOString();
      }
      entries.unshift(record);
      this.cache = entries.slice(0, CLIPBOARD_HISTORY_MAX_ENTRIES);
      await this.persist(this.cache);
    });
  }

  public async delete(id: string): Promise<void> {
    return this.queueMutation(async () => {
      const now = Date.now();
      this.cache = (await this.load()).filter((e) => e.id !== id && !isExpiredEntry(e, now));
      await this.persist(this.cache);
    });
  }

  public async clear(): Promise<void> {
    return this.queueMutation(async () => {
      this.cache = [];
      await this.persist(this.cache);
    });
  }
}
