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
import { canonicalJson, removalStandsAt } from "./WorkBoard";
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
  /** Who removed a server or memory, by id: what a teammate who edits it is told. */
  deletedServerBy?: Record<string, string>;
  deletedMemoryBy?: Record<string, string>;
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
    throw new Error("The S3 invite code is empty");
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
      throw new Error("The S3 invite code could not be decoded");
    }
  }
  if (
    typeof parsed.bucket !== "string" ||
    !parsed.bucket.trim() ||
    typeof parsed.accessKeyId !== "string" ||
    !parsed.accessKeyId.trim()
  ) {
    throw new Error("The S3 invite code has no bucket or access key id");
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
    // The version this edit started from: a teammate's removal made after it wins over the edit.
    ...(s.baseAt ? { baseAt: String(s.baseAt).trim() } : {}),
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
 * Fields a newer copy of a memory takes away by no longer having them. Laying the newer copy over
 * the older one would bring them back: undoing a learned update (which removes `supersededBy` from
 * the memory it replaced) then never reached a teammate, and their original stayed hidden.
 */
const CLEARED_BY_NEWER = ["supersededBy", "supersededAt"] as const;

type Votes = Record<string, 1 | -1>;
const cleanVotes = (votes: unknown): Votes | undefined => {
  if (!votes || typeof votes !== "object") return undefined;
  const out: Votes = {};
  for (const [who, v] of Object.entries(votes as Record<string, unknown>).slice(0, 500))
    if (who && (v === 1 || v === -1)) out[who] = v;
  return Object.keys(out).length ? out : undefined;
};
const sameVotes = (a: Votes | undefined, b: Votes | undefined): boolean => {
  const [ka, kb] = [Object.keys(a ?? {}), Object.keys(b ?? {})];
  return ka.length === kb.length && ka.every((k) => a![k] === b?.[k]);
};
/**
 * Votes are one per person, so two copies' votes are put together per person instead of one copy's
 * replacing the other's: two people who vote at about the same time both keep their vote. Where both
 * copies have the same person's vote, the newer copy's counts (equally new: the lower one, so that
 * both sides pick the same).
 */
function mergeVotes(older: Votes | undefined, newer: Votes | undefined, tie: boolean): Votes | undefined {
  if (!older && !newer) return undefined;
  const out: Votes = { ...(older ?? {}), ...(newer ?? {}) };
  if (tie) for (const [who, v] of Object.entries(older ?? {})) if (out[who] !== v) out[who] = -1;
  return out;
}
const score = (votes: Votes): number => Object.values(votes).reduce((sum: number, v) => sum + v, 0);

/**
 * Two copies with the same `updatedAt` and different content. Neither is newer, and "mine wins"
 * makes each installation write its own copy over the other's for ever. They are put together
 * field by field instead, by a rule that gives the same answer whichever side asks: a field only
 * one copy has is kept, and of two different values the larger one (a number by size, anything
 * else by its text).
 */
export function mergeEqualCopies<T extends object>(a: T, b: T, skip: readonly string[] = []): T {
  const out = { ...b, ...a } as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (skip.includes(key)) continue;
    const [x, y] = [(a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]];
    if (x === undefined || y === undefined) continue;
    if (typeof x === "number" && typeof y === "number") out[key] = Math.max(x, y);
    else if (canonicalJson(y) > canonicalJson(x)) out[key] = y;
  }
  return out as T;
}
/** Votes are put together by their own rule (mergeVotes), and the score follows from them. */
const MEMORY_TIE_SKIP = ["votes", "feedbackScore"] as const;

/** What the bucket's workspace object holds, without the time it was written. */
function workspaceContent(payload: Partial<S3WorkspaceRemotePayload>): string {
  return canonicalJson({
    servers: payload.servers ?? [],
    memories: payload.memories ?? [],
    activityLog: payload.activityLog ?? [],
    deletedServerIds: payload.deletedServerIds ?? {},
    deletedMemoryIds: payload.deletedMemoryIds ?? {},
    deletedServerBy: payload.deletedServerBy ?? {},
    deletedMemoryBy: payload.deletedMemoryBy ?? {},
  });
}

/**
 * Who removed each item that is removed after a merge (`kept`): the name that goes with the newer of
 * the two removals, and of two equally new ones the same name on both sides.
 */
function mergeRemovedBy(
  kept: Record<string, unknown>,
  local: { at?: Record<string, string | number>; by?: Record<string, string> },
  remote: { at?: Record<string, string | number>; by?: Record<string, string> },
): Record<string, string> {
  const out: Record<string, string> = {};
  const name = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : undefined);
  for (const id of Object.keys(kept)) {
    const [l, r] = [name(local.by?.[id]), name(remote.by?.[id])];
    const [lt, rt] = [parseTimeMs(local.at?.[id]), parseTimeMs(remote.at?.[id])];
    const pick = !l ? r : !r ? l : rt > lt ? r : lt > rt ? l : r > l ? r : l;
    if (pick) out[id] = pick;
  }
  return out;
}

/**
 * Two copies of one shared memory. The newer one decides its text and everything else, including
 * what it no longer has; votes are kept from both.
 */
export function mergeMemoryCopies(local: MemoryEntry, remote: MemoryEntry): MemoryEntry {
  const [lt, rt] = [local.updatedAt ?? 0, remote.updatedAt ?? 0];
  const [newer, older] = rt > lt ? [remote, local] : [local, remote];
  const out: MemoryEntry = lt === rt ? mergeEqualCopies(local, remote, MEMORY_TIE_SKIP) : { ...older, ...newer };
  if (lt !== rt) for (const key of CLEARED_BY_NEWER) if (newer[key] === undefined) delete out[key];
  const votes = mergeVotes(cleanVotes(older.votes), cleanVotes(newer.votes), lt === rt);
  if (votes) {
    out.votes = votes;
    out.feedbackScore = score(votes);
  }
  return out;
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
  /** The merged state differs from what this installation had. */
  changed: boolean;
  /** The merged state differs from what the bucket holds, so it has to be written there. */
  remoteChanged: boolean;
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
    // The same moment spelled in two ways (a number, an ISO text) is one removal: both sides keep
    // the same spelling of it, or each would write its own back for ever.
    if (nextMs > prevMs || (nextMs > 0 && nextMs === prevMs && String(delIso) > String(deletedServerIds[id]))) {
      deletedServerIds[id] = String(delIso);
      if (nextMs > prevMs) changed = true;
    }
  }

  // 2. Merge servers by id + updatedAt, respecting tombstones
  const serverMap = new Map<string, WorkspaceServerSummary>();
  const remoteServerTime = new Map<string, string>();
  for (const rs of Array.isArray(remote.servers) ? remote.servers : [])
    if (rs && typeof rs.id === "string" && typeof rs.updatedAt === "string") remoteServerTime.set(rs.id, rs.updatedAt);
  for (const ls of local.servers ?? []) {
    if (!ls?.id || !ls?.host) continue;
    // A server saved without a time is not "changed just now" on every sync: it takes the time the
    // team already has for it, and is stamped once when the team has none.
    const clean = sanitizeServerForS3(
      ls.updatedAt ? ls : { ...ls, updatedAt: remoteServerTime.get(String(ls.id).trim()) },
    );
    if (clean.deletedAt) {
      const delMs = parseTimeMs(clean.deletedAt);
      if (delMs > parseTimeMs(deletedServerIds[clean.id])) {
        deletedServerIds[clean.id] = clean.deletedAt;
      }
    }
    serverMap.set(clean.id, clean);
  }
  // What this installation had, to tell afterwards whether the merge changed anything for it. A
  // server the team removed stays in the bucket's list as a removal and is not kept here: finding
  // it there again on every sync is not a change, and used to make every sync write the bucket.
  const liveServers = (list: WorkspaceServerSummary[]): string =>
    canonicalJson(list.filter((srv) => !srv.deletedAt).sort((a, b) => a.id.localeCompare(b.id)));
  const serversBefore = liveServers([...serverMap.values()]);

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
    } else {
      const tLocal = parseTimeMs(existing.updatedAt);
      const tRemote = parseTimeMs(cleanRemote.updatedAt);
      if (tRemote > tLocal) serverMap.set(cleanRemote.id, cleanRemote);
      else if (tRemote === tLocal) serverMap.set(cleanRemote.id, mergeEqualCopies(existing, cleanRemote));
    }
  }

  const allMergedServers: WorkspaceServerSummary[] = [];
  const activeServers: WorkspaceServerSummary[] = [];
  for (const srv of serverMap.values()) {
    let delIso = deletedServerIds[srv.id] || srv.deletedAt;
    let delMs = parseTimeMs(delIso);
    const updMs = parseTimeMs(srv.updatedAt);
    // Edited on a view from before a teammate removed it: the removal stands, one step above the edit.
    const standing = delMs > 0 && delMs < updMs && srv.baseAt
      ? removalStandsAt(delMs, { id: srv.id, updatedAt: updMs, baseAt: parseTimeMs(srv.baseAt) || undefined })
      : undefined;
    if (standing !== undefined) {
      delIso = new Date(standing).toISOString();
      deletedServerIds[srv.id] = delIso;
      delMs = standing;
    }
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
  // In the order of their ids, so that two installations write the same list.
  allMergedServers.sort((a, b) => a.id.localeCompare(b.id));
  activeServers.sort((a, b) => a.id.localeCompare(b.id));
  if (liveServers(activeServers) !== serversBefore) changed = true;

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
  /**
   * Whether a removal stands over this copy: a removal at or after it, or one made after the version
   * its edit started from (moved one step above the edit, so that every installation drops it).
   */
  const memoryRemoved = (m: MemoryEntry): boolean => {
    const removedAt = deletedMemoryIds[m.id] ?? 0;
    if (removedAt >= (m.updatedAt ?? 0)) return true;
    const at = removalStandsAt(removedAt, { id: m.id, updatedAt: m.updatedAt ?? 0, baseAt: m.baseAt });
    if (at === undefined) return false;
    deletedMemoryIds[m.id] = at;
    changed = true;
    return true;
  };
  const memMap = new Map<string, MemoryEntry>();
  for (const lm of local.memories ?? []) {
    if (!lm?.id || lm.scope === "personal") continue;
    if (memoryRemoved(lm)) continue;
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
    if (memoryRemoved(rm)) continue;
    const prev = memMap.get(rm.id);
    const tie = Boolean(prev) && rTime === (prev!.updatedAt ?? 0);
    if (!prev || rTime > (prev.updatedAt ?? 0) || tie) {
      const incoming: MemoryEntry = {
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
      };
      // Equally new and not the same: put together by a rule both sides apply alike, so that
      // neither keeps writing its own copy over the other's.
      const next = tie ? mergeEqualCopies(prev!, incoming, MEMORY_TIE_SKIP) : incoming;
      if (!tie || canonicalJson({ ...next, votes: 0, feedbackScore: 0 }) !== canonicalJson({ ...prev, votes: 0, feedbackScore: 0 })) {
        memMap.set(rm.id, next);
        changed = true;
      }
    }
    const kept = memMap.get(rm.id);
    if (prev && kept) {
      const pTime = prev.updatedAt ?? 0;
      // What the newer copy no longer has is gone, not kept from the older one.
      if (rTime > pTime) for (const key of CLEARED_BY_NEWER) if (rm[key] === undefined) delete kept[key];
      const theirs = cleanVotes(rm.votes);
      const votes = rTime > pTime ? mergeVotes(prev.votes, theirs, false) : mergeVotes(theirs, prev.votes, rTime === pTime);
      if (votes) {
        kept.votes = votes;
        kept.feedbackScore = score(votes);
      } else delete kept.votes;
      // Either side is missing a vote the other has: it is applied here and written back.
      if (!sameVotes(votes, prev.votes) || !sameVotes(votes, theirs)) changed = true;
    }
  }
  // Remove any local memory that was tombstoned by remote
  for (const [id, m] of memMap.entries()) {
    if (memoryRemoved(m)) {
      memMap.delete(id);
      changed = true;
    }
  }

  // 5. Merge activityLog by id
  const actMap = new Map<string, WorkspaceActivityEvent>();
  for (const a of local.activityLog ?? []) {
    // Masked like a teammate's event is on arrival: an event that one side masks and the other
    // does not is two different events for ever, and each side writes its own.
    if (a?.id)
      actMap.set(a.id, {
        ...a,
        summary: maskContext(String(a.summary || "")),
        detail: a.detail ? maskContext(String(a.detail)) : undefined,
      });
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
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .slice(-500);

  const merged: S3WorkspaceRemotePayload = {
    version: 1,
    updatedAt: Date.now(),
    servers: allMergedServers,
    memories: Array.from(memMap.values()).sort((a, b) => a.id.localeCompare(b.id)),
    activityLog: mergedActivity,
    deletedServerIds,
    deletedMemoryIds,
    deletedServerBy: mergeRemovedBy(
      deletedServerIds,
      { at: local.deletedServerIds, by: local.deletedServerBy },
      { at: remote.deletedServerIds, by: remote.deletedServerBy },
    ),
    deletedMemoryBy: mergeRemovedBy(
      deletedMemoryIds,
      { at: local.deletedMemoryIds, by: local.deletedMemoryBy },
      { at: remote.deletedMemoryIds, by: remote.deletedMemoryBy },
    ),
  };
  // Compared by what it holds, not by when it was made: an idle team's sync then finds the bucket
  // as it would write it, and writes nothing.
  const remoteChanged = workspaceContent(merged) !== workspaceContent(remote);
  if (!remoteChanged && typeof remote.updatedAt === "number") merged.updatedAt = remote.updatedAt;
  return { merged, activeServers, changed, remoteChanged };
}

export interface S3WorkspaceSyncCallbacks {
  getLocalState(): Promise<{
    actor: string;
    servers: WorkspaceServerSummary[];
    memories: MemoryEntry[];
    activityLog: WorkspaceActivityEvent[];
    deletedServerIds: Record<string, string>;
    deletedMemoryIds: Record<string, number>;
    deletedServerBy?: Record<string, string>;
    deletedMemoryBy?: Record<string, string>;
    activeTerminals: WorkspacePresenceTerminal[];
  }>;
  applyMergedState(state: {
    activeServers: WorkspaceServerSummary[];
    memories: MemoryEntry[];
    activityLog: WorkspaceActivityEvent[];
    deletedServerIds: Record<string, string>;
    deletedMemoryIds: Record<string, number>;
    deletedServerBy?: Record<string, string>;
    deletedMemoryBy?: Record<string, string>;
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

  /**
   * Whether the bucket may be contacted: configured, and not a demo process (a demo workspace never
   * reaches shared state, see demo/outwardSync.ts). Every network path (start, timers, pushes, polls,
   * presence) is gated by this rather than by `isConfigured()` alone.
   */
  private canReachBucket(): boolean {
    return this.isConfigured() && !outwardSyncDisabledReason(SYNC);
  }

  getStatus(): S3WorkspaceSyncStatus {
    const configured = this.isConfigured();
    const syncDisabledReason = outwardSyncDisabledReason(SYNC);
    return {
      configured,
      enabled: this.config.enabled,
      connected:
        configured && !syncDisabledReason && this.connected && !this.lastError,
      endpoint: this.config.endpoint,
      region: this.config.region || "eu-north-1",
      bucket: this.config.bucket,
      prefix: this.config.prefix || "sshs3-workspace",
      accessKeyId: this.config.accessKeyId,
      hasSecretAccessKey: Boolean(this.config.secretAccessKey),
      forcePathStyle: this.config.forcePathStyle ?? true,
      lastSyncAt: this.lastSyncAt,
      syncing: this.syncing,
      // A configured bucket this (demo) process will not sync with shows why where sync errors show,
      // instead of looking connected.
      error: (configured ? syncDisabledReason : undefined) ?? this.lastError,
      ...(syncDisabledReason ? { syncDisabledReason } : {}),
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
    // Refused up front in demo mode (nothing is saved), so connecting a team bucket fails visibly.
    assertOutwardSyncAllowed(SYNC);
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
    if (!this.canReachBucket()) return;
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
      if (this.canReachBucket()) {
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
    } else if (this.canReachBucket() && !this.connected) {
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

  async syncNow(_opts: { forcePush?: boolean } = {}): Promise<void> {
    // An explicit "sync now" (button, AI tool) in demo mode fails with the reason instead of quietly
    // succeeding; the background paths never get here in demo mode (canReachBucket).
    assertOutwardSyncAllowed(SYNC);
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
          // Sanitized by the merge, which also gives a server without a time the team's time for it.
          servers: local.servers,
          memories: local.memories.filter((m) => m.scope !== "personal"),
          activityLog: local.activityLog,
          deletedServerIds: local.deletedServerIds,
          deletedMemoryIds: local.deletedMemoryIds,
          deletedServerBy: local.deletedServerBy,
          deletedMemoryBy: local.deletedMemoryBy,
        };

        const { merged, activeServers, changed, remoteChanged } = mergeS3WorkspacePayload(
          localPayload,
          remotePayload ?? {},
        );

        await this.callbacks.applyMergedState({
          activeServers,
          memories: merged.memories,
          activityLog: merged.activityLog,
          deletedServerIds: merged.deletedServerIds ?? {},
          deletedMemoryIds: merged.deletedMemoryIds ?? {},
          deletedServerBy: merged.deletedServerBy ?? {},
          deletedMemoryBy: merged.deletedMemoryBy ?? {},
          changed,
        });

        // The bucket is written when it does not hold what the merge came to, and only then. A push
        // asked for after a change here (`forcePush`) finds that difference; one that finds none has
        // nothing to send. Writing whenever the merge "changed" something made every installation
        // rewrite the whole object every few seconds for ever, each one's write being the next
        // one's reason to sync.
        const shouldWriteRemote = !remotePayload || remoteChanged;

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
    if (this.disposed || !this.canReachBucket() || this.syncing) return;
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
    if (this.disposed || !this.canReachBucket()) return;
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

  /** Whether this process may use the bucket now: configured, enabled, and not a demo process. */
  canUseBucket(): boolean {
    return !this.disposed && this.canReachBucket();
  }

  private objectPath(relative: string): string {
    const bucket = this.config.bucket.trim();
    const prefix = (this.config.prefix || "sshs3-workspace")
      .trim()
      .replace(/^\/+|\/+$/g, "");
    const clean = relative.replace(/^\/+|\/+$/g, "");
    return prefix ? `${bucket}/${prefix}/${clean}` : `${bucket}/${clean}`;
  }

  /**
   * Plain object access under the workspace prefix, for data that lives in
   * the bucket beside the workspace file (the learning queue). Paths are
   * relative to the prefix.
   */
  readonly objects = {
    list: async (dir: string): Promise<string[]> => {
      const provider = await this.getOrCreateProvider();
      try {
        return (await provider.list(this.objectPath(dir)))
          .filter((entry) => !entry.isDirectory)
          .map((entry) => entry.name);
      } catch (err) {
        if (this.isNotFoundError(err)) return [];
        throw err;
      }
    },
    read: async (relative: string): Promise<Buffer | undefined> => {
      const provider = await this.getOrCreateProvider();
      try {
        return await this.readProviderFile(provider, this.objectPath(relative));
      } catch (err) {
        if (this.isNotFoundError(err)) return undefined;
        throw err;
      }
    },
    write: async (relative: string, content: Buffer): Promise<void> => {
      const provider = await this.getOrCreateProvider();
      await this.writeProviderFile(provider, this.objectPath(relative), content);
    },
    remove: async (relative: string): Promise<void> => {
      const provider = await this.getOrCreateProvider();
      try {
        await provider.delete(this.objectPath(relative), false);
      } catch (err) {
        if (!this.isNotFoundError(err)) throw err;
      }
    },
  };

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
    // Every bucket connection is made here: never in demo mode, whichever path asked for it.
    assertOutwardSyncAllowed(SYNC);
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
