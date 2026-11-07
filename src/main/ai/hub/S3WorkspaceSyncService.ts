import crypto from "node:crypto";
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
import {
  assertOutwardSyncAllowed,
  outwardSyncDisabledReason,
} from "../../demo/outwardSync";

const log = createLogger("s3-workspace");
const SYNC = "S3 team workspace sync";

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

export interface StoredWorkspaceSlot {
  id: string;
  name?: string;
  enabled: boolean;
  endpoint?: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKeyEncrypted?: string;
  forcePathStyle?: boolean;
  lastSyncAt?: number;
  actorName?: string;
}

interface StoredS3WorkspaceConfig {
  id?: string;
  name?: string;
  enabled: boolean;
  endpoint?: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKeyEncrypted?: string;
  forcePathStyle?: boolean;
  lastSyncAt?: number;
  actorName?: string;
  activeWorkspaceId?: string;
  workspaces?: StoredWorkspaceSlot[];
}

interface WorkspaceRuntimeSlot {
  id: string;
  config: S3WorkspaceConfig;
  lastSyncAt?: number;
  syncing: boolean;
  connected: boolean;
  lastError?: string;
  lastKnownRemoteStat?: { size: number; mtime?: string } | null;
  presenceList: WorkspacePresenceEntry[];
  provider?: IStorageProvider;
  serverCount: number;
  memoryCount: number;
}

function slugifySegment(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "default"
  );
}

export function deriveS3WorkspaceId(bucket: string, prefix?: string): string {
  const b = slugifySegment(bucket || "workspace");
  const p = slugifySegment(
    (prefix || "sshs3-workspace").trim().replace(/^\/+|\/+$/g, ""),
  );
  return `ws-${b}-${p}`;
}

export function deriveS3WorkspaceName(
  bucket: string,
  prefix?: string,
  explicitName?: string,
): string {
  if (explicitName && explicitName.trim()) return explicitName.trim();
  const cleanBucket = (bucket || "").trim();
  const cleanPrefix = (prefix || "sshs3-workspace")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!cleanBucket) return "S3 Workspace";
  return cleanPrefix && cleanPrefix !== "sshs3-workspace"
    ? `${cleanBucket}/${cleanPrefix}`
    : cleanBucket;
}

export function encodeS3WorkspaceInvite(config: S3WorkspaceConfig): string {
  const payload: Record<string, unknown> = {
    v: 1,
    ...(config.name?.trim() ? { name: config.name.trim() } : {}),
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
    ...(typeof parsed.name === "string" && parsed.name.trim()
      ? { name: parsed.name.trim() }
      : {}),
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
      typeof parsed.secretAccessKey === "string" // pragma: allowlist secret
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
      ...(lm.sourceCommand ? { sourceCommand: maskContext(lm.sourceCommand) } : {}),
    });
  }
  for (const rm of Array.isArray(remote.memories) ? remote.memories : []) {
    if (!rm || typeof rm.id !== "string" || rm.scope === "personal") continue;
    const rTime = rm.updatedAt ?? 0;
    if ((deletedMemoryIds[rm.id] ?? 0) >= rTime) continue;
    const prev = memMap.get(rm.id);
    if (!prev || rTime > (prev.updatedAt ?? 0)) {
      memMap.set(rm.id, {
        ...prev,
        ...rm,
        id: rm.id,
        kind: rm.kind === "skill" ? "skill" : "memory",
        tier:
          rm.tier === "core" || rm.tier === "archival" || rm.tier === "episodic"
            ? rm.tier
            : prev?.tier,
        cluster: rm.cluster ? String(rm.cluster) : prev?.cluster,
        scope: rm.scope || "workspace",
        title: maskContext(String(rm.title || "")),
        text: maskContext(String(rm.text || "")),
        author: rm.author ? String(rm.author) : prev?.author,
        updatedCount:
          typeof rm.updatedCount === "number" ? rm.updatedCount : prev?.updatedCount,
        confidence:
          typeof rm.confidence === "number" ? rm.confidence : prev?.confidence,
        successCount:
          typeof rm.successCount === "number" ? rm.successCount : prev?.successCount,
        failureCount:
          typeof rm.failureCount === "number" ? rm.failureCount : prev?.failureCount,
        usageCount:
          typeof rm.usageCount === "number" ? rm.usageCount : prev?.usageCount,
        feedbackScore:
          typeof rm.feedbackScore === "number" ? rm.feedbackScore : prev?.feedbackScore,
        autoLearned:
          typeof rm.autoLearned === "boolean" ? rm.autoLearned : prev?.autoLearned,
        sourceCommand: rm.sourceCommand
          ? maskContext(String(rm.sourceCommand))
          : prev?.sourceCommand,
        errorSignature: rm.errorSignature
          ? String(rm.errorSignature)
          : prev?.errorSignature,
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
  getLocalState(
    workspaceId?: string,
    slotConfig?: S3WorkspaceConfig,
  ): Promise<{
    actor: string;
    servers: WorkspaceServerSummary[];
    memories: MemoryEntry[];
    activityLog: WorkspaceActivityEvent[];
    deletedServerIds: Record<string, string>;
    deletedMemoryIds: Record<string, number>;
    activeTerminals: WorkspacePresenceTerminal[];
  }>;
  applyMergedState(
    state: {
      activeServers: WorkspaceServerSummary[];
      memories: MemoryEntry[];
      activityLog: WorkspaceActivityEvent[];
      deletedServerIds: Record<string, string>;
      deletedMemoryIds: Record<string, number>;
      changed: boolean;
    },
    workspaceId?: string,
    slotConfig?: S3WorkspaceConfig,
  ): Promise<void>;
  onStateChanged(): void;
}

function createEmptyConfig(): S3WorkspaceConfig {
  return {
    enabled: false,
    region: "eu-north-1",
    bucket: "",
    prefix: "sshs3-workspace",
    accessKeyId: "",
    secretAccessKey: "",
    forcePathStyle: true,
  };
}

export class S3WorkspaceSyncService {
  private slots = new Map<string, WorkspaceRuntimeSlot>();
  private activeWorkspaceId?: string;
  private pollTimer?: NodeJS.Timeout;
  private presenceTimer?: NodeJS.Timeout;
  private pushDebounceTimer?: NodeJS.Timeout;
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

  private isSlotConfigured(slot: WorkspaceRuntimeSlot | undefined): boolean {
    if (!slot) return false;
    return Boolean(
      slot.config.enabled &&
        slot.config.bucket.trim() &&
        slot.config.accessKeyId.trim() &&
        slot.config.secretAccessKey,
    );
  }

  private getPrimarySlot(): WorkspaceRuntimeSlot | undefined {
    if (this.activeWorkspaceId && this.slots.has(this.activeWorkspaceId)) {
      const active = this.slots.get(this.activeWorkspaceId)!;
      if (this.isSlotConfigured(active)) return active;
    }
    for (const slot of this.slots.values()) {
      if (this.isSlotConfigured(slot)) return slot;
    }
    if (this.activeWorkspaceId && this.slots.has(this.activeWorkspaceId)) {
      return this.slots.get(this.activeWorkspaceId);
    }
    return this.slots.values().next().value;
  }

  private hydrateSlotFromStored(
    item: StoredWorkspaceSlot,
    existing?: WorkspaceRuntimeSlot,
  ): WorkspaceRuntimeSlot {
    const bucket = item.bucket?.trim() || "";
    const prefix = (item.prefix || "sshs3-workspace")
      .trim()
      .replace(/^\/+|\/+$/g, "");
    const id = item.id?.trim() || deriveS3WorkspaceId(bucket, prefix);
    const secret = item.secretAccessKeyEncrypted
      ? decryptSecretValue(item.secretAccessKeyEncrypted)
      : "";
    const config: S3WorkspaceConfig = {
      id,
      ...(item.name?.trim() ? { name: item.name.trim() } : {}),
      enabled: Boolean(item.enabled),
      endpoint: item.endpoint?.trim() || undefined,
      region: item.region?.trim() || "eu-north-1",
      bucket,
      prefix,
      accessKeyId: item.accessKeyId?.trim() || "",
      secretAccessKey: secret,
      forcePathStyle: item.forcePathStyle ?? true,
      ...(item.actorName?.trim() ? { actorName: item.actorName.trim() } : {}),
    };
    const sameTarget =
      existing &&
      existing.config.enabled === config.enabled &&
      existing.config.endpoint === config.endpoint &&
      existing.config.region === config.region &&
      existing.config.bucket === config.bucket &&
      existing.config.prefix === config.prefix &&
      existing.config.accessKeyId === config.accessKeyId &&
      existing.config.secretAccessKey === config.secretAccessKey &&
      existing.config.forcePathStyle === config.forcePathStyle;

    return {
      id,
      config,
      lastSyncAt: item.lastSyncAt ?? existing?.lastSyncAt,
      syncing: sameTarget ? existing.syncing : false,
      connected: sameTarget ? existing.connected : false,
      lastError: sameTarget ? existing.lastError : undefined,
      lastKnownRemoteStat: sameTarget ? existing.lastKnownRemoteStat : undefined,
      presenceList: sameTarget ? existing.presenceList : [],
      provider: sameTarget ? existing.provider : undefined,
      serverCount: existing?.serverCount ?? 0,
      memoryCount: existing?.memoryCount ?? 0,
    };
  }

  async load(): Promise<void> {
    try {
      const raw = (await fs.readFile(this.configFilePath, "utf8"))
        .replace(/^\uFEFF/, "")
        .trim();
      if (!raw) return;
      const stored = JSON.parse(raw) as StoredS3WorkspaceConfig;
      const nextSlots = new Map<string, WorkspaceRuntimeSlot>();

      if (Array.isArray(stored.workspaces) && stored.workspaces.length > 0) {
        for (const ws of stored.workspaces) {
          if (!ws || typeof ws !== "object") continue;
          const bucket = ws.bucket?.trim() || "";
          const prefix = (ws.prefix || "sshs3-workspace")
            .trim()
            .replace(/^\/+|\/+$/g, "");
          const id = ws.id?.trim() || deriveS3WorkspaceId(bucket, prefix);
          const hydrated = this.hydrateSlotFromStored(
            { ...ws, id },
            this.slots.get(id),
          );
          nextSlots.set(hydrated.id, hydrated);
        }
        // If top-level bucket was modified externally and doesn't match any slot, reconcile it
        if (stored.bucket?.trim()) {
          const topPrefix = (stored.prefix || "sshs3-workspace")
            .trim()
            .replace(/^\/+|\/+$/g, "");
          const topId =
            stored.id?.trim() ||
            deriveS3WorkspaceId(stored.bucket.trim(), topPrefix);
          if (!nextSlots.has(topId)) {
            const hydratedTop = this.hydrateSlotFromStored(
              {
                id: topId,
                name: stored.name,
                enabled: Boolean(stored.enabled),
                endpoint: stored.endpoint,
                region: stored.region || "eu-north-1",
                bucket: stored.bucket,
                prefix: topPrefix,
                accessKeyId: stored.accessKeyId || "",
                secretAccessKeyEncrypted: stored.secretAccessKeyEncrypted,
                forcePathStyle: stored.forcePathStyle,
                lastSyncAt: stored.lastSyncAt,
                actorName: stored.actorName,
              },
              this.slots.get(topId),
            );
            nextSlots.set(hydratedTop.id, hydratedTop);
          }
        }
      } else if (stored.bucket?.trim() || stored.enabled) {
        const prefix = (stored.prefix || "sshs3-workspace")
          .trim()
          .replace(/^\/+|\/+$/g, "");
        const id =
          stored.id?.trim() ||
          deriveS3WorkspaceId(stored.bucket?.trim() || "", prefix);
        const hydrated = this.hydrateSlotFromStored(
          {
            id,
            name: stored.name,
            enabled: Boolean(stored.enabled),
            endpoint: stored.endpoint,
            region: stored.region || "eu-north-1",
            bucket: stored.bucket || "",
            prefix,
            accessKeyId: stored.accessKeyId || "",
            secretAccessKeyEncrypted: stored.secretAccessKeyEncrypted,
            forcePathStyle: stored.forcePathStyle,
            lastSyncAt: stored.lastSyncAt,
            actorName: stored.actorName,
          },
          this.slots.get(id),
        );
        nextSlots.set(hydrated.id, hydrated);
      }

      // Close any providers from old slots not reused
      for (const oldSlot of this.slots.values()) {
        const nextSlot = nextSlots.get(oldSlot.id);
        if (oldSlot.provider && (!nextSlot || nextSlot.provider !== oldSlot.provider)) {
          await oldSlot.provider.disconnect?.().catch(() => {});
        }
      }

      this.slots = nextSlots;
      if (stored.activeWorkspaceId && this.slots.has(stored.activeWorkspaceId)) {
        this.activeWorkspaceId = stored.activeWorkspaceId;
      } else {
        this.activeWorkspaceId = this.getPrimarySlot()?.id;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("Failed to load S3 workspace config", safeError(err));
      }
    }
  }

  async save(): Promise<void> {
    const primary = this.getPrimarySlot();
    const pCfg = primary?.config ?? createEmptyConfig();
    const workspaces: StoredWorkspaceSlot[] = Array.from(this.slots.values())
      .filter((s) => s.config.bucket.trim() || s.config.enabled)
      .map((s) => ({
        id: s.id,
        ...(s.config.name?.trim() ? { name: s.config.name.trim() } : {}),
        enabled: s.config.enabled,
        endpoint: s.config.endpoint?.trim() || undefined,
        region: s.config.region.trim() || "eu-north-1",
        bucket: s.config.bucket.trim(),
        prefix: (s.config.prefix || "sshs3-workspace")
          .trim()
          .replace(/^\/+|\/+$/g, ""),
        accessKeyId: s.config.accessKeyId.trim(),
        secretAccessKeyEncrypted: s.config.secretAccessKey
          ? encryptSecretValue(s.config.secretAccessKey)
          : undefined,
        forcePathStyle: s.config.forcePathStyle ?? true,
        lastSyncAt: s.lastSyncAt,
        ...(s.config.actorName?.trim()
          ? { actorName: s.config.actorName.trim() }
          : {}),
      }));

    const stored: StoredS3WorkspaceConfig = {
      ...(primary?.id ? { id: primary.id } : {}),
      ...(pCfg.name?.trim() ? { name: pCfg.name.trim() } : {}),
      enabled: pCfg.enabled,
      endpoint: pCfg.endpoint?.trim() || undefined,
      region: pCfg.region.trim() || "eu-north-1",
      bucket: pCfg.bucket.trim(),
      prefix: (pCfg.prefix || "sshs3-workspace")
        .trim()
        .replace(/^\/+|\/+$/g, ""),
      accessKeyId: pCfg.accessKeyId.trim(),
      secretAccessKeyEncrypted: pCfg.secretAccessKey
        ? encryptSecretValue(pCfg.secretAccessKey)
        : undefined,
      forcePathStyle: pCfg.forcePathStyle ?? true,
      lastSyncAt: primary?.lastSyncAt,
      ...(pCfg.actorName?.trim() ? { actorName: pCfg.actorName.trim() } : {}),
      activeWorkspaceId: this.activeWorkspaceId ?? primary?.id,
      workspaces,
    };

    await fs.mkdir(path.dirname(this.configFilePath), {
      recursive: true,
      mode: 0o700,
    });
    const tmp = `${this.configFilePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await fs.writeFile(tmp, JSON.stringify(stored, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.configFilePath);
  }

  isConfigured(workspaceId?: string): boolean {
    if (workspaceId) {
      return this.isSlotConfigured(this.slots.get(workspaceId));
    }
    for (const slot of this.slots.values()) {
      if (this.isSlotConfigured(slot)) return true;
    }
    return false;
  }

  /**
   * Whether the bucket may be contacted: configured, and not a demo process (a demo workspace never
   * reaches shared state, see demo/outwardSync.ts). Every network path (start, timers, pushes, polls,
   * presence) is gated by this rather than by `isConfigured()` alone.
   */
  private canReachBucket(workspaceId?: string): boolean {
    return this.isConfigured(workspaceId) && !outwardSyncDisabledReason(SYNC);
  }

  private buildSlotStatus(slot: WorkspaceRuntimeSlot | undefined): S3WorkspaceSyncStatus {
    const cfg = slot?.config ?? createEmptyConfig();
    const configured = this.isSlotConfigured(slot);
    const syncDisabledReason = outwardSyncDisabledReason(SYNC);
    const anySyncing = slot
      ? slot.syncing
      : Array.from(this.slots.values()).some((s) => s.syncing);
    const presenceCount = slot ? this.getPresence(slot.id).length : 0;
    const derivedName = slot
      ? deriveS3WorkspaceName(cfg.bucket, cfg.prefix, cfg.name)
      : undefined;

    return {
      ...(slot?.id ? { id: slot.id } : {}),
      ...(derivedName ? { name: derivedName } : {}),
      configured,
      enabled: cfg.enabled,
      connected:
        configured &&
        !syncDisabledReason &&
        Boolean(slot?.connected) &&
        !slot?.lastError,
      endpoint: cfg.endpoint,
      region: cfg.region || "eu-north-1",
      bucket: cfg.bucket,
      prefix: cfg.prefix || "sshs3-workspace",
      accessKeyId: cfg.accessKeyId,
      hasSecretAccessKey: Boolean(cfg.secretAccessKey),
      forcePathStyle: cfg.forcePathStyle ?? true,
      lastSyncAt: slot?.lastSyncAt,
      syncing: anySyncing,
      // A configured bucket this (demo) process will not sync with shows why where sync errors show,
      // instead of looking connected.
      error: (configured ? syncDisabledReason : undefined) ?? slot?.lastError,
      ...(syncDisabledReason ? { syncDisabledReason } : {}),
      inviteCode: configured ? encodeS3WorkspaceInvite(cfg) : undefined,
      ...(slot
        ? {
            serverCount: slot.serverCount,
            memoryCount: slot.memoryCount,
            presenceCount,
          }
        : {}),
    };
  }

  getStatus(workspaceId?: string): S3WorkspaceSyncStatus {
    const slot = workspaceId
      ? this.slots.get(workspaceId)
      : this.getPrimarySlot();
    return this.buildSlotStatus(slot);
  }

  getWorkspacesStatus(): S3WorkspaceSyncStatus[] {
    return Array.from(this.slots.values())
      .filter((slot) => this.isSlotConfigured(slot) || slot.config.bucket.trim().length > 0)
      .map((slot) => this.buildSlotStatus(slot));
  }

  getActiveWorkspaceId(): string | undefined {
    return this.activeWorkspaceId ?? this.getPrimarySlot()?.id;
  }

  setActiveWorkspaceId(workspaceId?: string): void {
    this.activeWorkspaceId = workspaceId;
  }

  updateSlotCounts(
    workspaceId: string,
    counts: { serverCount?: number; memoryCount?: number },
  ): void {
    const slot = this.slots.get(workspaceId);
    if (!slot) return;
    if (counts.serverCount !== undefined) slot.serverCount = counts.serverCount;
    if (counts.memoryCount !== undefined) slot.memoryCount = counts.memoryCount;
  }

  getPresence(workspaceId?: string): WorkspacePresenceEntry[] {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    if (workspaceId && workspaceId !== "ALL") {
      const slot = this.slots.get(workspaceId);
      if (!slot) return [];
      return slot.presenceList.filter((p) => p.updatedAt >= cutoff);
    }
    const merged = new Map<string, WorkspacePresenceEntry>();
    for (const slot of this.slots.values()) {
      for (const p of slot.presenceList) {
        if (p.updatedAt < cutoff) continue;
        const prev = merged.get(p.actor);
        if (!prev || p.updatedAt >= prev.updatedAt) {
          merged.set(p.actor, p);
        }
      }
    }
    return Array.from(merged.values()).sort((a, b) =>
      a.actor.localeCompare(b.actor),
    );
  }

  async configure(
    update?: Partial<S3WorkspaceConfig>,
    inviteCode?: string,
    options?: {
      workspaceId?: string;
      mode?: "add" | "update" | "replace";
    },
  ): Promise<S3WorkspaceSyncStatus> {
    // Refused up front in demo mode (nothing is saved), so connecting a team bucket fails visibly.
    assertOutwardSyncAllowed(SYNC);
    const decoded = inviteCode ? decodeS3WorkspaceInvite(inviteCode) : {};

    const incomingBucket = (decoded.bucket ?? update?.bucket ?? "").trim();
    const incomingPrefix = ((decoded.prefix ?? update?.prefix) || "")
      .trim()
      .replace(/^\/+|\/+$/g, "");
    const explicitId = (
      options?.workspaceId ??
      update?.id ??
      decoded.id ??
      ""
    ).trim();
    const mode = options?.mode;

    // Resolve which existing slot (if any) to update vs creating a new slot
    let targetSlot: WorkspaceRuntimeSlot | undefined;
    if (explicitId && this.slots.has(explicitId)) {
      targetSlot = this.slots.get(explicitId);
    } else if (mode === "replace" && !explicitId) {
      targetSlot = this.getPrimarySlot();
    } else if (mode !== "add") {
      if (incomingBucket) {
        const effectivePrefix = incomingPrefix || "sshs3-workspace";
        for (const slot of this.slots.values()) {
          if (
            slot.config.bucket.trim().toLowerCase() ===
              incomingBucket.toLowerCase() &&
            (slot.config.prefix || "sshs3-workspace").trim().toLowerCase() ===
              effectivePrefix.toLowerCase()
          ) {
            targetSlot = slot;
            break;
          }
        }
        // If only one unconfigured empty slot exists, reuse it
        if (!targetSlot && this.slots.size === 1) {
          const single = this.slots.values().next().value!;
          if (!single.config.bucket.trim()) {
            targetSlot = single;
          }
        }
      } else {
        targetSlot = this.getPrimarySlot();
      }
    }

    const baseConfig = targetSlot?.config ?? createEmptyConfig();
    const merged = { ...baseConfig, ...update, ...decoded };
    const secret =
      decoded.secretAccessKey !== undefined
        ? decoded.secretAccessKey
        : update?.secretAccessKey !== undefined && update.secretAccessKey !== ""
          ? update.secretAccessKey
          : baseConfig.secretAccessKey;

    const bucket = (merged.bucket || "").trim();
    const prefix = (merged.prefix || "sshs3-workspace")
      .trim()
      .replace(/^\/+|\/+$/g, "");

    let slotId =
      explicitId ||
      targetSlot?.id ||
      deriveS3WorkspaceId(bucket, prefix);
    if (!targetSlot && this.slots.has(slotId)) {
      let suffix = 2;
      while (this.slots.has(`${slotId}-${suffix}`)) {
        suffix += 1;
      }
      slotId = `${slotId}-${suffix}`;
    }

    const explicitName = (update?.name ?? decoded.name ?? targetSlot?.config.name)?.trim();
    const nextConfig: S3WorkspaceConfig = {
      id: slotId,
      ...(explicitName ? { name: explicitName } : {}),
      enabled: merged.enabled ?? true,
      endpoint: merged.endpoint?.trim() || undefined,
      region: (merged.region || "eu-north-1").trim(),
      bucket,
      prefix,
      accessKeyId: (merged.accessKeyId || "").trim(),
      secretAccessKey: secret || "",
      forcePathStyle: merged.forcePathStyle ?? true,
      ...(merged.actorName?.trim()
        ? { actorName: merged.actorName.trim() }
        : {}),
    };

    if (targetSlot) {
      await this.resetSlotProvider(targetSlot);
      if (targetSlot.id !== slotId) {
        this.slots.delete(targetSlot.id);
        targetSlot.id = slotId;
      }
      targetSlot.config = nextConfig;
      targetSlot.lastKnownRemoteStat = undefined;
      targetSlot.lastError = undefined;
      this.slots.set(slotId, targetSlot);
    } else {
      targetSlot = {
        id: slotId,
        config: nextConfig,
        syncing: false,
        connected: false,
        presenceList: [],
        serverCount: 0,
        memoryCount: 0,
      };
      this.slots.set(slotId, targetSlot);
    }

    this.activeWorkspaceId = targetSlot.id;
    await this.save();

    if (this.isSlotConfigured(targetSlot)) {
      await this.syncNow({ workspaceId: targetSlot.id });
      this.startTimers();
    } else {
      targetSlot.connected = false;
      if (!this.canReachBucket()) {
        this.stopTimers();
      }
    }
    this.callbacks.onStateChanged();
    return this.buildSlotStatus(targetSlot);
  }

  async disconnect(
    workspaceId?: string,
    opts?: { remove?: boolean },
  ): Promise<void> {
    if (workspaceId && workspaceId !== "ALL") {
      const slot = this.slots.get(workspaceId);
      if (slot) {
        await this.resetSlotProvider(slot);
        slot.config.enabled = false;
        slot.connected = false;
        slot.lastError = undefined;
        slot.presenceList = [];
        if (opts?.remove !== false && (opts?.remove === true || this.slots.size > 1)) {
          this.slots.delete(workspaceId);
        }
      }
      if (this.activeWorkspaceId === workspaceId) {
        this.activeWorkspaceId = this.getPrimarySlot()?.id;
      }
    } else {
      for (const slot of this.slots.values()) {
        await this.resetSlotProvider(slot);
        slot.config.enabled = false;
        slot.connected = false;
        slot.lastError = undefined;
        slot.presenceList = [];
      }
      if (opts?.remove) {
        this.slots.clear();
        this.activeWorkspaceId = undefined;
      }
    }

    if (!this.canReachBucket()) {
      this.stopTimers();
    }
    await this.save();
    this.callbacks.onStateChanged();
  }

  async start(): Promise<void> {
    await this.load();
    if (!this.canReachBucket()) return;
    this.startTimers();
    void this.syncNow().catch((err) =>
      log.warn("Initial S3 workspace sync failed", safeError(err)),
    );
  }

  private serializeSlotsKey(): string {
    return JSON.stringify(
      Array.from(this.slots.values()).map((s) => ({
        id: s.id,
        enabled: s.config.enabled,
        endpoint: s.config.endpoint,
        region: s.config.region,
        bucket: s.config.bucket,
        prefix: s.config.prefix,
        accessKeyId: s.config.accessKeyId,
        secretAccessKey: s.config.secretAccessKey,
        forcePathStyle: s.config.forcePathStyle,
      })),
    );
  }

  async reloadFromDisk(): Promise<void> {
    if (this.disposed) return;
    const prevKey = this.serializeSlotsKey();
    await this.load();
    const nextKey = this.serializeSlotsKey();
    if (prevKey !== nextKey) {
      if (this.canReachBucket()) {
        this.startTimers();
        await this.syncNow().catch((err) =>
          log.warn("Reloaded S3 workspace sync failed", safeError(err)),
        );
      } else {
        this.stopTimers();
        for (const slot of this.slots.values()) {
          await this.resetSlotProvider(slot);
          slot.connected = false;
          slot.presenceList = [];
        }
      }
      this.callbacks.onStateChanged();
    } else if (
      this.canReachBucket() &&
      Array.from(this.slots.values()).some(
        (s) => this.isSlotConfigured(s) && !s.connected,
      )
    ) {
      this.startTimers();
      await this.syncNow().catch((err) =>
        log.warn("Reloaded S3 workspace sync failed", safeError(err)),
      );
    }
  }

  startTimers(): void {
    this.stopTimers();
    if (this.disposed || !this.canReachBucket()) return;
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
    if (this.disposed || !this.canReachBucket()) return;
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
    if (this.disposed || !this.canReachBucket()) return;
    void this.publishAndRefreshPresence().catch(() => {});
  }

  async syncNow(
    opts: { forcePush?: boolean; workspaceId?: string } = {},
  ): Promise<void> {
    // An explicit "sync now" (button, AI tool) in demo mode fails with the reason instead of quietly
    // succeeding; the background paths never get here in demo mode (canReachBucket).
    assertOutwardSyncAllowed(SYNC);
    const targetSlots =
      opts.workspaceId && opts.workspaceId !== "ALL"
        ? [this.slots.get(opts.workspaceId)].filter(
            (s): s is WorkspaceRuntimeSlot => this.isSlotConfigured(s),
          )
        : Array.from(this.slots.values()).filter((s) =>
            this.isSlotConfigured(s),
          );
    if (targetSlots.length === 0) return;

    return this.enqueue(async () => {
      let firstError: unknown;
      for (const slot of targetSlots) {
        slot.syncing = true;
        this.callbacks.onStateChanged();
        try {
          const provider = await this.getOrCreateProvider(slot);
          const remotePath = this.workspaceObjectPath(slot);
          const remotePayload = await this.readRemoteWorkspace(
            slot,
            provider,
            remotePath,
          );
          const local = await this.callbacks.getLocalState(
            slot.id,
            slot.config,
          );

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

          slot.serverCount = activeServers.length;
          slot.memoryCount = merged.memories.length;

          await this.callbacks.applyMergedState(
            {
              activeServers,
              memories: merged.memories,
              activityLog: merged.activityLog,
              deletedServerIds: merged.deletedServerIds ?? {},
              deletedMemoryIds: merged.deletedMemoryIds ?? {},
              changed,
            },
            slot.id,
            slot.config,
          );

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
            slot.lastKnownRemoteStat = stat
              ? { size: stat.size, mtime: stat.mtime }
              : null;
          }

          await this.publishAndRefreshPresenceInternal(slot, provider, local);

          slot.connected = true;
          slot.lastError = undefined;
          slot.lastSyncAt = Date.now();
          await this.save().catch(() => {});
        } catch (err) {
          slot.connected = false;
          slot.lastError = safeError(err);
          firstError ??= err;
        } finally {
          slot.syncing = false;
          this.callbacks.onStateChanged();
        }
      }
      if (firstError) {
        throw firstError;
      }
    });
  }

  async pollOnce(): Promise<void> {
    if (this.disposed || !this.canReachBucket()) return;
    const configuredSlots = Array.from(this.slots.values()).filter(
      (s) => this.isSlotConfigured(s) && !s.syncing,
    );
    for (const slot of configuredSlots) {
      try {
        const provider = await this.getOrCreateProvider(slot);
        const remotePath = this.workspaceObjectPath(slot);
        const stat = await this.statOrNull(provider, remotePath);
        const changedOnS3 =
          (slot.lastKnownRemoteStat === undefined && stat !== null) ||
          (slot.lastKnownRemoteStat === null && stat !== null) ||
          (slot.lastKnownRemoteStat !== null &&
            slot.lastKnownRemoteStat !== undefined &&
            stat !== null &&
            (stat.size !== slot.lastKnownRemoteStat.size ||
              stat.mtime !== slot.lastKnownRemoteStat.mtime));

        if (changedOnS3) {
          await this.syncNow({ workspaceId: slot.id });
        } else {
          const local = await this.callbacks.getLocalState(
            slot.id,
            slot.config,
          );
          await this.publishAndRefreshPresenceInternal(slot, provider, local);
          if (!slot.connected || slot.lastError) {
            slot.connected = true;
            slot.lastError = undefined;
            this.callbacks.onStateChanged();
          }
        }
      } catch (err) {
        slot.connected = false;
        slot.lastError = safeError(err);
        this.callbacks.onStateChanged();
      }
    }
  }

  async publishAndRefreshPresence(): Promise<void> {
    if (this.disposed || !this.canReachBucket()) return;
    const configuredSlots = Array.from(this.slots.values()).filter((s) =>
      this.isSlotConfigured(s),
    );
    for (const slot of configuredSlots) {
      const provider = await this.getOrCreateProvider(slot);
      const local = await this.callbacks.getLocalState(slot.id, slot.config);
      await this.publishAndRefreshPresenceInternal(slot, provider, local);
    }
  }

  private async publishAndRefreshPresenceInternal(
    slot: WorkspaceRuntimeSlot,
    provider: IStorageProvider,
    local: {
      actor: string;
      activeTerminals: WorkspacePresenceTerminal[];
    },
  ): Promise<void> {
    const actor = (slot.config.actorName || local.actor || "teammate").trim();
    const safeActor = actor.replace(/[^a-zA-Z0-9_.-]/g, "_") || "teammate";
    const now = Date.now();
    const wsName = deriveS3WorkspaceName(
      slot.config.bucket,
      slot.config.prefix,
      slot.config.name,
    );
    const selfEntry: WorkspacePresenceEntry = {
      actor,
      updatedAt: now,
      activeTerminals: local.activeTerminals,
      workspaceId: slot.id,
      workspaceName: wsName,
    };

    const dirPath = this.presenceDirPath(slot);
    const selfPath = `${dirPath}/${safeActor}.json`;
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
      const files = await provider.list(dirPath);
      const cutoff = now - PRESENCE_TTL_MS;
      for (const file of files) {
        if (file.isDirectory || !file.name.endsWith(".json")) continue;
        if (file.name === `${safeActor}.json`) continue;
        const filePath = `${dirPath}/${file.name}`;
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
              workspaceId: slot.id,
              workspaceName: wsName,
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
      slot.presenceList.map((p) => ({
        actor: p.actor,
        terminals: p.activeTerminals.map((t) => `${t.targetLabel}:${t.state}`),
      })),
    );
    slot.presenceList = entries.sort((a, b) => a.actor.localeCompare(b.actor));
    const nextJson = JSON.stringify(
      slot.presenceList.map((p) => ({
        actor: p.actor,
        terminals: p.activeTerminals.map((t) => `${t.targetLabel}:${t.state}`),
      })),
    );
    if (prevJson !== nextJson) {
      this.callbacks.onStateChanged();
    }
  }

  private workspaceObjectPath(slot: WorkspaceRuntimeSlot): string {
    const bucket = slot.config.bucket.trim();
    const prefix = (slot.config.prefix || "sshs3-workspace")
      .trim()
      .replace(/^\/+|\/+$/g, "");
    return prefix
      ? `${bucket}/${prefix}/${WORKSPACE_FILENAME}`
      : `${bucket}/${WORKSPACE_FILENAME}`;
  }

  private presenceDirPath(slot: WorkspaceRuntimeSlot): string {
    const bucket = slot.config.bucket.trim();
    const prefix = (slot.config.prefix || "sshs3-workspace")
      .trim()
      .replace(/^\/+|\/+$/g, "");
    return prefix
      ? `${bucket}/${prefix}/${PRESENCE_DIRNAME}`
      : `${bucket}/${PRESENCE_DIRNAME}`;
  }

  private async getOrCreateProvider(
    slot: WorkspaceRuntimeSlot,
  ): Promise<IStorageProvider> {
    // Every bucket connection is made here: never in demo mode, whichever path asked for it.
    assertOutwardSyncAllowed(SYNC);
    if (slot.provider) return slot.provider;
    if (this.options.providerFactory) {
      slot.provider = this.options.providerFactory(slot.config);
      await (
        slot.provider as { connect?: () => Promise<void> }
      ).connect?.();
      return slot.provider;
    }
    const s3Provider = new S3StorageProvider({
      id: `s3-workspace-sync-${slot.id}`,
      name: `S3 Workspace (${slot.config.bucket})`,
      endpoint: slot.config.endpoint?.trim() || undefined,
      region: slot.config.region || "eu-north-1",
      accessKeyId: slot.config.accessKeyId,
      secretAccessKey: slot.config.secretAccessKey || "",
      forcePathStyle: slot.config.forcePathStyle ?? true,
    });
    await (s3Provider as { connect?: () => Promise<void> }).connect?.();
    slot.provider = s3Provider;
    return slot.provider;
  }

  private async resetSlotProvider(slot: WorkspaceRuntimeSlot): Promise<void> {
    const old = slot.provider;
    slot.provider = undefined;
    if (old) {
      await old.disconnect?.().catch(() => {});
    }
  }

  private async readRemoteWorkspace(
    slot: WorkspaceRuntimeSlot,
    provider: IStorageProvider,
    remotePath: string,
  ): Promise<Partial<S3WorkspaceRemotePayload> | null> {
    const stat = await this.statOrNull(provider, remotePath);
    if (!stat) {
      slot.lastKnownRemoteStat = null;
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
    slot.lastKnownRemoteStat = { size: stat.size, mtime: stat.mtime };
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
    for (const slot of this.slots.values()) {
      await this.resetSlotProvider(slot);
    }
  }
}
