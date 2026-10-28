import fs from "node:fs/promises";
import path from "node:path";
import type {
  MemoryEntry,
  S3WorkspaceConfig,
  S3WorkspaceSyncStatus,
  WorkspaceActivityEvent,
  WorkspacePresenceEntry,
  WorkspacePresenceTerminal,
  WorkspaceServerSummary,
} from "../../../shared/types/aiHub";
import type { FileEntry, IStorageProvider } from "../../../shared/types/storage";
import { S3StorageProvider } from "../../storage/S3StorageProvider";
import {
  decryptSecretValue,
  encryptSecretValue,
} from "../../crypto/SecretFieldCrypto";
import { maskContext, safeError } from "./privacy";
import { createLogger } from "../../log";

const log = createLogger("s3-workspace");

export const S3_INVITE_PREFIX = "sshs3-s3://";
const WORKSPACE_FILENAME = "workspace.json";
const PRESENCE_DIRNAME = "presence";
const MAX_WORKSPACE_BYTES = 25 * 1024 * 1024;
const PRESENCE_TTL_MS = 45_000;

export interface S3WorkspaceRemotePayload {
  version: 1;
  updatedAt: number;
  servers: WorkspaceServerSummary[];
  memories: MemoryEntry[];
  activityLog: WorkspaceActivityEvent[];
  deletedServerIds?: Record<string, string>;
  deletedMemoryIds?: Record<string, number>;
}

interface StoredS3WorkspaceConfig {
  enabled: boolean;
  endpoint?: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKeyEncrypted?: string;
  forcePathStyle?: boolean;
  lastSyncAt?: number;
}

export function encodeS3WorkspaceInvite(config: S3WorkspaceConfig): string {
  const payload = {
    v: 1,
    endpoint: config.endpoint?.trim() || undefined,
    region: config.region.trim() || "eu-north-1",
    bucket: config.bucket.trim(),
    prefix: (config.prefix || "sshs3-workspace").trim(),
    accessKeyId: config.accessKeyId.trim(),
    secretAccessKey: config.secretAccessKey || "",
    forcePathStyle: config.forcePathStyle ?? true,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${S3_INVITE_PREFIX}${encoded}`;
}

export function decodeS3WorkspaceInvite(
  inviteCode: string,
): Partial<S3WorkspaceConfig> {
  const trimmed = inviteCode.trim();
  const rawBase64 = trimmed.startsWith(S3_INVITE_PREFIX)
    ? trimmed.slice(S3_INVITE_PREFIX.length).trim()
    : trimmed;
  if (!rawBase64) {
    throw new Error("Tom S3 invite-kod");
  }
  let parsed: Record<string, unknown>;
  try {
    const json = Buffer.from(rawBase64, "base64url").toString("utf8");
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    try {
      const json = Buffer.from(rawBase64, "base64").toString("utf8");
      parsed = JSON.parse(json) as Record<string, unknown>;
    } catch {
      throw new Error("Ogiltig S3 invite-kod (kunde inte avkoda)");
    }
  }
  if (
    typeof parsed.bucket !== "string" ||
    !parsed.bucket.trim() ||
    typeof parsed.accessKeyId !== "string" ||
    !parsed.accessKeyId.trim()
  ) {
    throw new Error("S3 invite-koden saknar bucket eller accessKeyId");
  }
  return {
    enabled: true,
    endpoint:
      typeof parsed.endpoint === "string" && parsed.endpoint.trim()
        ? parsed.endpoint.trim()
        : undefined,
    region:
      typeof parsed.region === "string" && parsed.region.trim()
        ? parsed.region.trim()
        : "eu-north-1",
    bucket: parsed.bucket.trim(),
    prefix:
      typeof parsed.prefix === "string" && parsed.prefix.trim()
        ? parsed.prefix.trim().replace(/^\/+|\/+$/g, "")
        : "sshs3-workspace",
    accessKeyId: parsed.accessKeyId.trim(),
    secretAccessKey:
      typeof parsed.secretAccessKey === "string"
        ? parsed.secretAccessKey
        : undefined,
    forcePathStyle:
      typeof parsed.forcePathStyle === "boolean"
        ? parsed.forcePathStyle
        : true,
  };
}

/**
 * Strips any local/secret fields from a server summary before it is written to S3.
 * Only topology, cluster, roles, tags, default username, and description are shared.
 */
export function sanitizeServerForS3(
  s: WorkspaceServerSummary,
): WorkspaceServerSummary {
  return {
    id: String(s.id).trim(),
    name: String(s.name || s.host).trim(),
    host: String(s.host).trim(),
    port: Number(s.port) || 22,
    username: String(s.username || "root").trim(),
    ...(s.folder ? { folder: String(s.folder).trim() } : {}),
    ...(s.group ? { group: String(s.group).trim() } : {}),
    ...(s.cluster ? { cluster: String(s.cluster).trim() } : {}),
    ...(s.nodeRole ? { nodeRole: String(s.nodeRole).trim() } : {}),
    ...(s.description ? { description: maskContext(String(s.description).trim()) } : {}),
    ...(s.role ? { role: String(s.role).trim() } : {}),
    ...(Array.isArray(s.tags) && s.tags.length
      ? { tags: s.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20) }
      : {}),
    shared: true,
    updatedAt: s.updatedAt || new Date().toISOString(),
    ...(s.updatedBy ? { updatedBy: String(s.updatedBy).trim() } : {}),
    ...(s.deletedAt ? { deletedAt: String(s.deletedAt).trim() } : {}),
  };
}

function parseTimeMs(value?: string | number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Deterministic CRDT-style merge of two S3 workspace payloads (local & remote).
 * Supports per-item `updatedAt` timestamps and tombstone maps (`deletedServerIds`, `deletedMemoryIds`).
 */
export function mergeS3WorkspacePayload(
  local: S3WorkspaceRemotePayload,
  remote: Partial<S3WorkspaceRemotePayload>,
): {
  merged: S3WorkspaceRemotePayload;
  activeServers: WorkspaceServerSummary[];
  changed: boolean;
} {
  let changed = false;

  // 1. Merge deletedServerIds tombstones
  const deletedServerIds: Record<string, string> = {
    ...(local.deletedServerIds ?? {}),
  };
  for (const [id, delIso] of Object.entries(remote.deletedServerIds ?? {})) {
    if (!id || (typeof delIso !== "string" && typeof delIso !== "number")) continue;
    const prevMs = parseTimeMs(deletedServerIds[id]);
    const nextMs = parseTimeMs(delIso);
    if (nextMs > prevMs) {
      deletedServerIds[id] = String(delIso);
      changed = true;
    }
  }

  // 2. Merge servers by id + updatedAt, respecting tombstones
  const serverMap = new Map<string, WorkspaceServerSummary>();
  for (const ls of local.servers ?? []) {
    if (!ls?.id || !ls?.host) continue;
    const clean = sanitizeServerForS3(ls);
    if (clean.deletedAt) {
      const delMs = parseTimeMs(clean.deletedAt);
      if (delMs > parseTimeMs(deletedServerIds[clean.id])) {
        deletedServerIds[clean.id] = clean.deletedAt;
      }
    }
    serverMap.set(clean.id, clean);
  }

  for (const rs of Array.isArray(remote.servers) ? remote.servers : []) {
    if (!rs || typeof rs.id !== "string" || !rs.host) continue;
    const cleanRemote = sanitizeServerForS3(rs);
    if (cleanRemote.deletedAt) {
      const delMs = parseTimeMs(cleanRemote.deletedAt);
      if (delMs > parseTimeMs(deletedServerIds[cleanRemote.id])) {
        deletedServerIds[cleanRemote.id] = cleanRemote.deletedAt;
        changed = true;
      }
    }
    const existing = serverMap.get(cleanRemote.id);
    if (!existing) {
      serverMap.set(cleanRemote.id, cleanRemote);
      changed = true;
    } else {
      const tLocal = parseTimeMs(existing.updatedAt);
      const tRemote = parseTimeMs(cleanRemote.updatedAt);
      if (tRemote > tLocal) {
        serverMap.set(cleanRemote.id, cleanRemote);
        changed = true;
      }
    }
  }

  const allMergedServers: WorkspaceServerSummary[] = [];
  const activeServers: WorkspaceServerSummary[] = [];
  for (const srv of serverMap.values()) {
    const delIso = deletedServerIds[srv.id] || srv.deletedAt;
    const delMs = parseTimeMs(delIso);
    const updMs = parseTimeMs(srv.updatedAt);
    if (delMs > 0 && delMs >= updMs) {
      allMergedServers.push({ ...srv, deletedAt: String(delIso) });
    } else {
      if (deletedServerIds[srv.id]) {
        delete deletedServerIds[srv.id];
      }
      const { deletedAt: _del, ...activeSrv } = srv;
      allMergedServers.push(activeSrv);
      activeServers.push(activeSrv);
    }
  }

  // 3. Merge deletedMemoryIds tombstones
  const deletedMemoryIds: Record<string, number> = {
    ...(local.deletedMemoryIds ?? {}),
  };
  for (const [id, delMs] of Object.entries(remote.deletedMemoryIds ?? {})) {
    if (!id || typeof delMs !== "number") continue;
    if (delMs > (deletedMemoryIds[id] ?? 0)) {
      deletedMemoryIds[id] = delMs;
      changed = true;
    }
  }

  // 4. Merge shared memories by id + updatedAt, respecting tombstones
  const memMap = new Map<string, MemoryEntry>();
  for (const lm of local.memories ?? []) {
    if (!lm?.id || lm.scope === "personal") continue;
    if ((deletedMemoryIds[lm.id] ?? 0) >= (lm.updatedAt ?? 0)) continue;
    memMap.set(lm.id, {
      ...lm,
      title: maskContext(lm.title),
      text: maskContext(lm.text),
    });
  }
  for (const rm of Array.isArray(remote.memories) ? remote.memories : []) {
    if (!rm || typeof rm.id !== "string" || rm.scope === "personal") continue;
    const rTime = rm.updatedAt ?? 0;
    if ((deletedMemoryIds[rm.id] ?? 0) >= rTime) continue;
    const prev = memMap.get(rm.id);
    if (!prev || rTime > (prev.updatedAt ?? 0)) {
      memMap.set(rm.id, {
        id: rm.id,
        kind: rm.kind === "skill" ? "skill" : "memory",
        scope: rm.scope || "workspace",
        title: maskContext(String(rm.title || "")),
        text: maskContext(String(rm.text || "")),
        author: rm.author ? String(rm.author) : undefined,
        updatedAt: rTime,
      });
      changed = true;
    }
  }
  // Remove any local memory that was tombstoned by remote
  for (const [id, m] of memMap.entries()) {
    if ((deletedMemoryIds[id] ?? 0) >= (m.updatedAt ?? 0)) {
      memMap.delete(id);
      changed = true;
    }
  }

  // 5. Merge activityLog by id
  const actMap = new Map<string, WorkspaceActivityEvent>();
  for (const a of local.activityLog ?? []) {
    if (a?.id) actMap.set(a.id, a);
  }
  for (const ra of Array.isArray(remote.activityLog) ? remote.activityLog : []) {
    if (!ra || typeof ra.id !== "string") continue;
    if (!actMap.has(ra.id)) {
      actMap.set(ra.id, {
        ...ra,
        summary: maskContext(String(ra.summary || "")),
        detail: ra.detail ? maskContext(String(ra.detail)) : undefined,
      });
      changed = true;
    }
  }
  const mergedActivity = Array.from(actMap.values())
    .sort((a, b) => a.at - b.at)
    .slice(-500);

  return {
    merged: {
      version: 1,
      updatedAt: Date.now(),
      servers: allMergedServers,
      memories: Array.from(memMap.values()),
      activityLog: mergedActivity,
      deletedServerIds,
      deletedMemoryIds,
    },
    activeServers,
    changed,
  };
}

export interface S3WorkspaceSyncCallbacks {
  getLocalState(): Promise<{
    actor: string;
    servers: WorkspaceServerSummary[];
    memories: MemoryEntry[];
    activityLog: WorkspaceActivityEvent[];
    deletedServerIds: Record<string, string>;
    deletedMemoryIds: Record<string, number>;
    activeTerminals: WorkspacePresenceTerminal[];
  }>;
  applyMergedState(state: {
    activeServers: WorkspaceServerSummary[];
    memories: MemoryEntry[];
    activityLog: WorkspaceActivityEvent[];
    deletedServerIds: Record<string, string>;
    deletedMemoryIds: Record<string, number>;
    changed: boolean;
  }): Promise<void>;
  onStateChanged(): void;
}

export class S3WorkspaceSyncService {
  private config: S3WorkspaceConfig = {
    enabled: false,
    region: "eu-north-1",
    bucket: "",
    prefix: "sshs3-workspace",
    accessKeyId: "",
    secretAccessKey: "",
    forcePathStyle: true,
  };
  private lastSyncAt?: number;
  private syncing = false;
  private connected = false;
  private lastError?: string;
  private lastKnownRemoteStat?: { size: number; mtime?: string } | null;
  private presenceList: WorkspacePresenceEntry[] = [];
  private pollTimer?: NodeJS.Timeout;
  private presenceTimer?: NodeJS.Timeout;
  private pushDebounceTimer?: NodeJS.Timeout;
  private provider?: IStorageProvider;
  private syncQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly configFilePath: string,
    private readonly callbacks: S3WorkspaceSyncCallbacks,
    private readonly options: {
      pollIntervalMs?: number;
      presenceIntervalMs?: number;
      pushDebounceMs?: number;
      providerFactory?: (cfg: S3WorkspaceConfig) => IStorageProvider;
    } = {},
  ) {}

  async load(): Promise<void> {
    try {
      const raw = (await fs.readFile(this.configFilePath, "utf8"))
        .replace(/^\uFEFF/, "")
        .trim();
      if (!raw) return;
      const stored = JSON.parse(raw) as StoredS3WorkspaceConfig;
      this.config = {
        enabled: Boolean(stored.enabled),
        endpoint: stored.endpoint?.trim() || undefined,
        region: stored.region?.trim() || "eu-north-1",
        bucket: stored.bucket?.trim() || "",
        prefix: (stored.prefix || "sshs3-workspace")
          .trim()
          .replace(/^\/+|\/+$/g, ""),
        accessKeyId: stored.accessKeyId?.trim() || "",
        secretAccessKey: stored.secretAccessKeyEncrypted
          ? decryptSecretValue(stored.secretAccessKeyEncrypted)
          : "",
        forcePathStyle: stored.forcePathStyle ?? true,
      };
      this.lastSyncAt = stored.lastSyncAt;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("Failed to load S3 workspace config", safeError(err));
      }
    }
  }

  async save(): Promise<void> {
    const stored: StoredS3WorkspaceConfig = {
      enabled: this.config.enabled,
      endpoint: this.config.endpoint?.trim() || undefined,
      region: this.config.region.trim() || "eu-north-1",
      bucket: this.config.bucket.trim(),
      prefix: (this.config.prefix || "sshs3-workspace")
        .trim()
        .replace(/^\/+|\/+$/g, ""),
      accessKeyId: this.config.accessKeyId.trim(),
      secretAccessKeyEncrypted: this.config.secretAccessKey
        ? encryptSecretValue(this.config.secretAccessKey)
        : undefined,
      forcePathStyle: this.config.forcePathStyle ?? true,
      lastSyncAt: this.lastSyncAt,
    };
    await fs.mkdir(path.dirname(this.configFilePath), {
      recursive: true,
      mode: 0o700,
    });
    const tmp = `${this.configFilePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await fs.writeFile(tmp, JSON.stringify(stored, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.configFilePath);
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.enabled &&
        this.config.bucket.trim() &&
        this.config.accessKeyId.trim() &&
        this.config.secretAccessKey,
    );
  }

  getStatus(): S3WorkspaceSyncStatus {
    const configured = this.isConfigured();
    return {
      configured,
      enabled: this.config.enabled,
      connected: configured && this.connected && !this.lastError,
      endpoint: this.config.endpoint,
      region: this.config.region || "eu-north-1",
      bucket: this.config.bucket,
      prefix: this.config.prefix || "sshs3-workspace",
      accessKeyId: this.config.accessKeyId,
      hasSecretAccessKey: Boolean(this.config.secretAccessKey),
      forcePathStyle: this.config.forcePathStyle ?? true,
      lastSyncAt: this.lastSyncAt,
      syncing: this.syncing,
      error: this.lastError,
      inviteCode: configured ? encodeS3WorkspaceInvite(this.config) : undefined,
    };
  }

  getPresence(): WorkspacePresenceEntry[] {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    return this.presenceList.filter((p) => p.updatedAt >= cutoff);
  }

  async configure(
    update?: Partial<S3WorkspaceConfig>,
    inviteCode?: string,
  ): Promise<void> {
    const decoded = inviteCode ? decodeS3WorkspaceInvite(inviteCode) : {};
    const merged = { ...this.config, ... update, ...decoded };
    const secret =
      decoded.secretAccessKey !== undefined
        ? decoded.secretAccessKey
        : update?.secretAccessKey !== undefined && update.secretAccessKey !== ""
          ? update.secretAccessKey
          : this.config.secretAccessKey;

    this.config = {
      enabled: merged.enabled ?? true,
      endpoint: merged.endpoint?.trim() || undefined,
      region: (merged.region || "eu-north-1").trim(),
      bucket: (merged.bucket || "").trim(),
      prefix: (merged.prefix || "sshs3-workspace")
        .trim()
        .replace(/^\/+|\/+$/g, ""),
      accessKeyId: (merged.accessKeyId || "").trim(),
      secretAccessKey: secret || "",
      forcePathStyle: merged.forcePathStyle ?? true,
    };

    await this.resetProvider();
    this.lastKnownRemoteStat = undefined;
    this.lastError = undefined;
    await this.save();

    if (this.isConfigured()) {
      await this.syncNow();
      this.startTimers();
    } else {
      this.stopTimers();
      this.connected = false;
    }
    this.callbacks.onStateChanged();
  }

  async disconnect(): Promise<void> {
    this.stopTimers();
    await this.resetProvider();
    this.config.enabled = false;
    this.connected = false;
    this.lastError = undefined;
    this.presenceList = [];
    await this.save();
    this.callbacks.onStateChanged();
  }

  async start(): Promise<void> {
    await this.load();
    if (!this.isConfigured()) return;
    this.startTimers();
    void this.syncNow().catch((err) =>
      log.warn("Initial S3 workspace sync failed", safeError(err)),
    );
  }

  async reloadFromDisk(): Promise<void> {
    if (this.disposed) return;
    const prevKey = JSON.stringify({
      enabled: this.config.enabled,
      endpoint: this.config.endpoint,
      region: this.config.region,
      bucket: this.config.bucket,
      prefix: this.config.prefix,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      forcePathStyle: this.config.forcePathStyle,
    });
    await this.load();
    const nextKey = JSON.stringify({
      enabled: this.config.enabled,
      endpoint: this.config.endpoint,
      region: this.config.region,
      bucket: this.config.bucket,
      prefix: this.config.prefix,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      forcePathStyle: this.config.forcePathStyle,
    });
    if (prevKey !== nextKey) {
      await this.resetProvider();
      this.lastKnownRemoteStat = undefined;
      this.lastError = undefined;
      if (this.isConfigured()) {
        this.startTimers();
        await this.syncNow().catch((err) =>
          log.warn("Reloaded S3 workspace sync failed", safeError(err)),
        );
      } else {
        this.stopTimers();
        this.connected = false;
        this.presenceList = [];
      }
      this.callbacks.onStateChanged();
    } else if (this.isConfigured() && !this.connected) {
      this.startTimers();
      await this.syncNow().catch((err) =>
        log.warn("Reloaded S3 workspace sync failed", safeError(err)),
      );
    }
  }

  startTimers(): void {
    this.stopTimers();
    if (this.disposed || !this.isConfigured()) return;
    const pollMs = this.options.pollIntervalMs ?? 10_000;
    const presenceMs = this.options.presenceIntervalMs ?? 15_000;

    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch((e) =>
        log.warn("S3 workspace poll failed", safeError(e)),
      );
    }, pollMs);
    this.pollTimer.unref?.();

    this.presenceTimer = setInterval(() => {
      void this.publishAndRefreshPresence().catch((e) =>
        log.warn("S3 presence heartbeat failed", safeError(e)),
      );
    }, presenceMs);
    this.presenceTimer.unref?.();
  }

  stopTimers(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = undefined;
    }
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer);
      this.pushDebounceTimer = undefined;
    }
  }

  schedulePush(delayMs = this.options.pushDebounceMs ?? 1_200): void {
    if (this.disposed || !this.isConfigured()) return;
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer);
    }
    this.pushDebounceTimer = setTimeout(() => {
      this.pushDebounceTimer = undefined;
      void this.syncNow({ forcePush: true }).catch((e) =>
        log.warn("Scheduled S3 workspace push failed", safeError(e)),
      );
    }, delayMs);
    this.pushDebounceTimer.unref?.();
  }

  schedulePresenceUpdate(): void {
    if (this.disposed || !this.isConfigured()) return;
    void this.publishAndRefreshPresence().catch(() => {});
  }

  async syncNow(opts: { forcePush?: boolean } = {}): Promise<void> {
    if (!this.isConfigured()) return;
    return this.enqueue(async () => {
      this.syncing = true;
      this.callbacks.onStateChanged();
      try {
        const provider = await this.getOrCreateProvider();
        const remotePath = this.workspaceObjectPath();
        const remotePayload = await this.readRemoteWorkspace(provider, remotePath);
        const local = await this.callbacks.getLocalState();

        const localPayload: S3WorkspaceRemotePayload = {
          version: 1,
          updatedAt: Date.now(),
          servers: local.servers.map(sanitizeServerForS3),
          memories: local.memories.filter((m) => m.scope !== "personal"),
          activityLog: local.activityLog,
          deletedServerIds: local.deletedServerIds,
          deletedMemoryIds: local.deletedMemoryIds,
        };

        const { merged, activeServers, changed } = mergeS3WorkspacePayload(
          localPayload,
          remotePayload ?? {},
        );

        await this.callbacks.applyMergedState({
          activeServers,
          memories: merged.memories,
          activityLog: merged.activityLog,
          deletedServerIds: merged.deletedServerIds ?? {},
          deletedMemoryIds: merged.deletedMemoryIds ?? {},
          changed,
        });

        // Write merged state back to S3 if remote didn't exist, if merge produced changes, or if forcePush
        const shouldWriteRemote =
          !remotePayload ||
          opts.forcePush ||
          changed ||
          (localPayload.servers.length > 0 &&
            (remotePayload.servers?.length ?? 0) !== merged.servers.length);

        if (shouldWriteRemote) {
          const buf = Buffer.from(JSON.stringify(merged, null, 2), "utf8");
          await this.writeProviderFile(provider, remotePath, buf);
          const stat = await this.statOrNull(provider, remotePath);
          this.lastKnownRemoteStat = stat
            ? { size: stat.size, mtime: stat.mtime }
            : null;
        }

        await this.publishAndRefreshPresenceInternal(provider, local);

        this.connected = true;
        this.lastError = undefined;
        this.lastSyncAt = Date.now();
        await this.save().catch(() => {});
      } catch (err) {
        this.connected = false;
        this.lastError = safeError(err);
        throw err;
      } finally {
        this.syncing = false;
        this.callbacks.onStateChanged();
      }
    });
  }

  async pollOnce(): Promise<void> {
    if (this.disposed || !this.isConfigured() || this.syncing) return;
    try {
      const provider = await this.getOrCreateProvider();
      const remotePath = this.workspaceObjectPath();
      const stat = await this.statOrNull(provider, remotePath);
      const changedOnS3 =
        (this.lastKnownRemoteStat === undefined && stat !== null) ||
        (this.lastKnownRemoteStat === null && stat !== null) ||
        (this.lastKnownRemoteStat !== null &&
          this.lastKnownRemoteStat !== undefined &&
          stat !== null &&
          (stat.size !== this.lastKnownRemoteStat.size ||
            stat.mtime !== this.lastKnownRemoteStat.mtime));

      if (changedOnS3) {
        await this.syncNow();
      } else {
        await this.publishAndRefreshPresence();
        if (!this.connected || this.lastError) {
          this.connected = true;
          this.lastError = undefined;
          this.callbacks.onStateChanged();
        }
      }
    } catch (err) {
      this.connected = false;
      this.lastError = safeError(err);
      this.callbacks.onStateChanged();
    }
  }

  async publishAndRefreshPresence(): Promise<void> {
    if (this.disposed || !this.isConfigured()) return;
    const provider = await this.getOrCreateProvider();
    const local = await this.callbacks.getLocalState();
    await this.publishAndRefreshPresenceInternal(provider, local);
  }

  private async publishAndRefreshPresenceInternal(
    provider: IStorageProvider,
    local: {
      actor: string;
      activeTerminals: WorkspacePresenceTerminal[];
    },
  ): Promise<void> {
    const actor = (local.actor || "teammate").trim();
    const safeActor = actor.replace(/[^a-zA-Z0-9_.-]/g, "_") || "teammate";
    const now = Date.now();
    const selfEntry: WorkspacePresenceEntry = {
      actor,
      updatedAt: now,
      activeTerminals: local.activeTerminals,
    };

    const selfPath = `${this.presenceDirPath()}/${safeActor}.json`;
    try {
      await this.writeProviderFile(
        provider,
        selfPath,
        Buffer.from(JSON.stringify(selfEntry), "utf8"),
      );
    } catch (err) {
      log.warn("Failed to write presence heartbeat", safeError(err));
    }

    // List all presence files in S3
    const entries: WorkspacePresenceEntry[] = [selfEntry];
    try {
      const files = await provider.list(this.presenceDirPath());
      const cutoff = now - PRESENCE_TTL_MS;
      for (const file of files) {
        if (file.isDirectory || !file.name.endsWith(".json")) continue;
        if (file.name === `${safeActor}.json`) continue;
        const filePath = `${this.presenceDirPath()}/${file.name}`;
        try {
          const buf = await this.readProviderFile(provider, filePath, 64_000);
          const parsed = JSON.parse(
            buf.toString("utf8"),
          ) as WorkspacePresenceEntry;
          if (
            parsed &&
            typeof parsed.actor === "string" &&
            typeof parsed.updatedAt === "number" &&
            parsed.updatedAt >= cutoff
          ) {
            entries.push({
              actor: parsed.actor,
              updatedAt: parsed.updatedAt,
              activeTerminals: Array.isArray(parsed.activeTerminals)
                ? parsed.activeTerminals
                : [],
            });
          }
        } catch {
          // Ignore unreadable peer presence file
        }
      }
    } catch {
      // Directory may not exist yet
    }

    const prevJson = JSON.stringify(
      this.presenceList.map((p) => ({
        actor: p.actor,
        terminals: p.activeTerminals.map((t) => `${t.targetLabel}:${t.state}`),
      })),
    );
    this.presenceList = entries.sort((a, b) => a.actor.localeCompare(b.actor));
    const nextJson = JSON.stringify(
      this.presenceList.map((p) => ({
        actor: p.actor,
        terminals: p.activeTerminals.map((t) => `${t.targetLabel}:${t.state}`),
      })),
    );
    if (prevJson !== nextJson) {
      this.callbacks.onStateChanged();
    }
  }

  private workspaceObjectPath(): string {
    const bucket = this.config.bucket.trim();
    const prefix = (this.config.prefix || "sshs3-workspace")
      .trim()
      .replace(/^\/+|\/+$/g, "");
    return prefix
      ? `${bucket}/${prefix}/${WORKSPACE_FILENAME}`
      : `${bucket}/${WORKSPACE_FILENAME}`;
  }

  private presenceDirPath(): string {
    const bucket = this.config.bucket.trim();
    const prefix = (this.config.prefix || "sshs3-workspace")
      .trim()
      .replace(/^\/+|\/+$/g, "");
    return prefix
      ? `${bucket}/${prefix}/${PRESENCE_DIRNAME}`
      : `${bucket}/${PRESENCE_DIRNAME}`;
  }

  private async getOrCreateProvider(): Promise<IStorageProvider> {
    if (this.provider) return this.provider;
    if (this.options.providerFactory) {
      this.provider = this.options.providerFactory(this.config);
      await (
        this.provider as { connect?: () => Promise<void> }
      ).connect?.();
      return this.provider;
    }
    const s3Provider = new S3StorageProvider({
      id: "s3-workspace-sync",
      name: `S3 Workspace (${this.config.bucket})`,
      endpoint: this.config.endpoint?.trim() || undefined,
      region: this.config.region || "eu-north-1",
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey || "",
      forcePathStyle: this.config.forcePathStyle ?? true,
    });
    await (s3Provider as { connect?: () => Promise<void> }).connect?.();
    this.provider = s3Provider;
    return this.provider;
  }

  private async resetProvider(): Promise<void> {
    const old = this.provider;
    this.provider = undefined;
    if (old) {
      await old.disconnect?.().catch(() => {});
    }
  }

  private async readRemoteWorkspace(
    provider: IStorageProvider,
    remotePath: string,
  ): Promise<Partial<S3WorkspaceRemotePayload> | null> {
    const stat = await this.statOrNull(provider, remotePath);
    if (!stat) {
      this.lastKnownRemoteStat = null;
      return null;
    }
    if (stat.size > MAX_WORKSPACE_BYTES) {
      throw new Error("Remote S3 workspace.json exceeds maximum size limit");
    }
    const raw = await this.readProviderFile(
      provider,
      remotePath,
      MAX_WORKSPACE_BYTES,
    );
    this.lastKnownRemoteStat = { size: stat.size, mtime: stat.mtime };
    const text = raw.toString("utf8").replace(/^\uFEFF/, "").trim();
    if (!text) return null;
    return JSON.parse(text) as Partial<S3WorkspaceRemotePayload>;
  }

  private async statOrNull(
    provider: IStorageProvider,
    remotePath: string,
  ): Promise<FileEntry | null> {
    try {
      return await provider.stat(remotePath);
    } catch (err: any) {
      if (this.isNotFoundError(err)) return null;
      throw err;
    }
  }

  private isNotFoundError(err: any): boolean {
    if (!err) return false;
    const code = err.code || err.$metadata?.httpStatusCode;
    if (
      code === "ENOENT" ||
      code === 2 ||
      code === 404 ||
      code === "NotFound" ||
      code === "NoSuchKey"
    ) {
      return true;
    }
    const name = err.name || "";
    if (name === "NoSuchKey" || name === "NotFound") return true;
    const msg = typeof err.message === "string" ? err.message.toLowerCase() : "";
    if (
      msg.includes("no such file") ||
      msg.includes("file does not exist") ||
      msg.includes("does not exist") ||
      msg.includes("not found") ||
      msg.includes("nosuchkey")
    ) {
      if (
        msg.includes("host not found") ||
        msg.includes("getaddrinfo") ||
        msg.includes("connect")
      ) {
        return false;
      }
      return true;
    }
    return false;
  }

  private async readProviderFile(
    provider: IStorageProvider,
    remotePath: string,
    maxBytes = MAX_WORKSPACE_BYTES,
  ): Promise<Buffer> {
    if (typeof provider.readFile === "function") {
      const data = await provider.readFile(remotePath);
      if (data.length > maxBytes) {
        throw new Error(`Remote file exceeds ${maxBytes} bytes`);
      }
      return data;
    }
    const stream = await provider.createReadStream(remotePath);
    const chunks: Buffer[] = [];
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      stream.on("data", (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          (stream as unknown as { destroy?: () => void }).destroy?.();
          finish(() => reject(new Error(`Remote file exceeds ${maxBytes} bytes`)));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => finish(resolve));
      stream.on("error", (err) => finish(() => reject(err)));
    });
    return Buffer.concat(chunks);
  }

  private async writeProviderFile(
    provider: IStorageProvider,
    remotePath: string,
    buffer: Buffer,
  ): Promise<void> {
    if (typeof provider.writeFile === "function") {
      await provider.writeFile(remotePath, buffer, {
        mode: 0o600,
        size: buffer.length,
      });
      return;
    }
    const stream = await provider.createWriteStream(remotePath, {
      mode: 0o600,
      size: buffer.length,
    });
    await new Promise<void>((resolve, reject) => {
      stream.on("error", reject);
      stream.end(buffer, () => resolve());
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.syncQueue.then(fn, fn);
    this.syncQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopTimers();
    await this.resetProvider();
  }
}
