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
  openSecretValue,
  sealSecretValue,
  unreadSecretNote,
} from "../../crypto/SecretFieldCrypto";
import { maskContext, safeError } from "./privacy";
import { sharedMemoryRemovals } from "./memory/sharedMemoryRemovals";
import { canonicalJson, removalStandsAt } from "./WorkBoard";
import { createLogger } from "../../log";
import type { ListedObject } from "./LearningQueue";
import { writeFileAtomic } from "../../storage/atomicFile";
import {
  assertOutwardSyncAllowed,
  outwardSyncDisabledReason,
} from "../../demo/outwardSync";

const log = createLogger("s3-workspace");
const SYNC = "S3 team workspace sync";

export const S3_INVITE_PREFIX = "sshs3-s3://";
export const DEFAULT_S3_REQUEST_TIMEOUT_MS = 15_000;
const WORKSPACE_FILENAME = "workspace.json";
/** Where a workspace file that could not be read is kept when it is replaced. */
const BROKEN_WORKSPACE_FILENAME = "workspace.broken.json";
const PRESENCE_DIRNAME = "presence";
const MAX_WORKSPACE_BYTES = 25 * 1024 * 1024;
const PRESENCE_TTL_MS = 45_000;
/** A presence file nobody has refreshed for this long belongs to an installation that is gone. */
const PRESENCE_REMOVE_AFTER_MS = 24 * 60 * 60_000;
const MAX_CAS_ATTEMPTS = 4;
const DEFAULT_MAX_POLL_BACKOFF_MS = 300_000;

interface ConditionalStorageProvider extends IStorageProvider {
  list(remotePath: string, options?: { force?: boolean; signal?: AbortSignal }): Promise<FileEntry[]>;
  stat(remotePath: string, options?: { signal?: AbortSignal }): Promise<FileEntry>;
  delete(remotePath: string, isDirectory: boolean, options?: { signal?: AbortSignal }): Promise<void>;
  writeFile?(
    remotePath: string,
    data: Buffer | Uint8Array,
    options?: {
      size?: number;
      mode?: number;
      exclusive?: boolean;
      ifMatch?: string;
      ifNoneMatch?: string;
      signal?: AbortSignal;
    },
  ): Promise<void>;
  readFile?(
    remotePath: string,
    options?: { ifMatch?: string; ifNoneMatch?: string; signal?: AbortSignal },
  ): Promise<Buffer>;
}

export interface ClientWorkspacePresenceEntry extends WorkspacePresenceEntry {
  clientId?: string;
}

export interface S3WorkspaceInviteValidationResult {
  valid: boolean;
  config?: Partial<S3WorkspaceConfig>;
  error?: string;
}

export function isPreconditionFailedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: unknown;
    Code?: unknown;
    name?: unknown;
    message?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const status = e.$metadata?.httpStatusCode;
  if (status === 412 || status === 409) return true;
  if (e.code === 412 || e.code === 409) return true;
  const codeStr = String(e.code ?? e.Code ?? e.name ?? "");
  if (
    codeStr === "PreconditionFailed" ||
    codeStr === "ConditionalRequestConflict" ||
    codeStr === "EEXIST"
  ) {
    return true;
  }
  // Told by status and name only: a message that merely mentions 412 or If-Match is some other failure,
  // and retrying it as a lost race would hide it.
  return false;
}

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

/**
 * The invite code of a team bucket: where it is and the key that opens it, secret key included. Whoever
 * has the code has the bucket, so it is made only for a person who asked for it (see `inviteCode()`).
 */
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

/**
 * Reads an invite code made by `encodeS3WorkspaceInvite`. Only that kind exists: a code of another
 * version is refused rather than half read, which would connect the bucket without its key.
 */
export function validateS3WorkspaceInvite(inviteCode: string): S3WorkspaceInviteValidationResult {
  const trimmed = inviteCode.trim();
  const rawBase64 = trimmed.startsWith(S3_INVITE_PREFIX)
    ? trimmed.slice(S3_INVITE_PREFIX.length).trim()
    : trimmed;
  if (!rawBase64) {
    return { valid: false, error: "The S3 invite code is empty" };
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
      return { valid: false, error: "The S3 invite code could not be decoded" };
    }
  }
  if (parsed.v !== undefined && parsed.v !== 1) {
    return { valid: false, error: "This S3 invite code is of a kind this app does not read. Ask for a new one." };
  }
  if (
    typeof parsed.bucket !== "string" ||
    !parsed.bucket.trim() ||
    typeof parsed.accessKeyId !== "string" ||
    !parsed.accessKeyId.trim()
  ) {
    return { valid: false, error: "The S3 invite code has no bucket or access key id" };
  }
  const config: Partial<S3WorkspaceConfig> = {
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
    ...(typeof parsed.secretAccessKey === "string" // pragma: allowlist secret
      ? { secretAccessKey: parsed.secretAccessKey }
      : {}),
    forcePathStyle:
      typeof parsed.forcePathStyle === "boolean"
        ? parsed.forcePathStyle
        : true,
  };
  return { valid: true, config };
}

export function decodeS3WorkspaceInvite(inviteCode: string): Partial<S3WorkspaceConfig> {
  const validation = validateS3WorkspaceInvite(inviteCode);
  if (!validation.valid || !validation.config) {
    throw new Error(validation.error ?? "The S3 invite code could not be decoded");
  }
  return validation.config;
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

  // 3–4. Apply the shared deletion rule before merging the surviving copies.
  const removals = sharedMemoryRemovals(local, remote);
  const deletedMemoryIds = removals.deleted;
  changed ||= removals.changed;
  const memMap = new Map<string, MemoryEntry>();
  for (const lm of local.memories ?? []) {
    if (!lm?.id || lm.scope === "personal") continue;
    if (removals.removed(lm)) {
      changed = true;
      continue;
    }
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
    if (removals.removed(rm)) continue;
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
    clientId?: string;
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
  private polling = false;
  private connected = false;
  private lastError?: string;
  /** The secret key as it is stored, when it could not be decrypted on this start: written back unchanged. */
  private unreadSecret?: string;
  /** Something the person should know that is not a fault of the sync now: the workspace file was unreadable and was written again. Kept until the app closes or the bucket changes. */
  private notice?: string;
  private lastKnownRemoteStat?: { size: number; mtime?: string } | null;
  private presenceList: ClientWorkspacePresenceEntry[] = [];
  /** Each teammate's presence file as it was last read, by the mark its listing gave. */
  private readonly presenceSeen = new Map<string, { version: string; entry: ClientWorkspacePresenceEntry }>();
  private pollTimer?: NodeJS.Timeout;
  private presenceTimer?: NodeJS.Timeout;
  private pushDebounceTimer?: NodeJS.Timeout;
  private provider?: IStorageProvider;
  private syncQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private consecutivePollErrors = 0;
  private nextPollAllowedAt = 0;
  private readonly fallbackClientId = crypto.randomUUID().slice(0, 12);

  constructor(
    private readonly configFilePath: string,
    private readonly callbacks: S3WorkspaceSyncCallbacks,
    private readonly options: {
      pollIntervalMs?: number;
      maxPollBackoffMs?: number;
      presenceIntervalMs?: number;
      pushDebounceMs?: number;
      requestTimeoutMs?: number;
      clientId?: string;
      providerFactory?: (cfg: S3WorkspaceConfig) => IStorageProvider;
      /** False for an account the server keeps for itself: it is nobody, so it writes no presence. */
      publishPresence?: boolean;
    } = {},
  ) {}

  async load(): Promise<void> {
    try {
      const raw = (await fs.readFile(this.configFilePath, "utf8"))
        .replace(/^\uFEFF/, "")
        .trim();
      if (!raw) return;
      const stored = JSON.parse(raw) as StoredS3WorkspaceConfig;
      const secret = openSecretValue(stored.secretAccessKeyEncrypted ?? "");
      this.unreadSecret = secret.kept;
      this.config = {
        enabled: Boolean(stored.enabled),
        endpoint: stored.endpoint?.trim() || undefined,
        region: stored.region?.trim() || "eu-north-1",
        bucket: stored.bucket?.trim() || "",
        prefix: (stored.prefix || "sshs3-workspace")
          .trim()
          .replace(/^\/+|\/+$/g, ""),
        accessKeyId: stored.accessKeyId?.trim() || "",
        secretAccessKey: secret.value,
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
    // A key a person entered replaces the one that could not be read.
    if (this.config.secretAccessKey) this.unreadSecret = undefined;
    const stored: StoredS3WorkspaceConfig = {
      enabled: this.config.enabled,
      endpoint: this.config.endpoint?.trim() || undefined,
      region: this.config.region.trim() || "eu-north-1",
      bucket: this.config.bucket.trim(),
      prefix: (this.config.prefix || "sshs3-workspace")
        .trim()
        .replace(/^\/+|\/+$/g, ""),
      accessKeyId: this.config.accessKeyId.trim(),
      // While the key could not be read, what was stored goes back as it was: writing nothing here
      // would lose the key for good after one start with the keyring locked or missing.
      secretAccessKeyEncrypted: sealSecretValue(this.config.secretAccessKey, this.unreadSecret) || undefined,
      forcePathStyle: this.config.forcePathStyle ?? true,
      lastSyncAt: this.lastSyncAt,
    };
    await fs.mkdir(path.dirname(this.configFilePath), {
      recursive: true,
      mode: 0o700,
    });
    // Every person's hub on the team server reads this file: on Windows a rename over it is refused while
    // one of them has it open. Written atomically with retries, and never leaving its temporary file behind.
    await writeFileAtomic(this.configFilePath, JSON.stringify(stored, null, 2), { mode: 0o600 });
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
      // instead of looking connected. So does a bucket whose secret key could not be read on this start:
      // it is not synced with, and would otherwise look as if it had never been set up.
      error:
        (configured ? syncDisabledReason : undefined) ??
        (this.unreadSecret && !this.config.secretAccessKey && this.config.enabled ? unreadSecretNote("The team bucket's secret key") : undefined) ??
        this.lastError,
      ...(syncDisabledReason ? { syncDisabledReason } : {}),
      ...(this.notice && configured ? { notice: this.notice } : {}),
    };
  }

  /**
   * The code a teammate pastes to join this bucket. It holds the bucket's secret key, so it is made
   * only when a person asks for it (the request `workspace-s3-invite`) and is never part of the status:
   * the status goes into every conversation's snapshot and into tool answers.
   */
  inviteCode(): string {
    if (!this.isConfigured()) throw new Error("Connect a team bucket first: there is nothing to invite to.");
    return encodeS3WorkspaceInvite(this.config);
  }

  getPresence(): ClientWorkspacePresenceEntry[] {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    return this.presenceList.filter((p) => p.updatedAt >= cutoff);
  }

  getPollBackoffState(): { consecutiveErrors: number; nextPollAllowedAt: number } {
    return {
      consecutiveErrors: this.consecutivePollErrors,
      nextPollAllowedAt: this.nextPollAllowedAt,
    };
  }

  async configure(
    update?: Partial<S3WorkspaceConfig>,
    inviteCode?: string,
  ): Promise<void> {
    // Refused up front in demo mode (nothing is saved), so connecting a team bucket fails visibly.
    assertOutwardSyncAllowed(SYNC);
    const decoded = inviteCode ? decodeS3WorkspaceInvite(inviteCode) : {};
    const merged = { ...this.config, ...update, ...decoded };
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
    this.notice = undefined;
    this.consecutivePollErrors = 0;
    this.nextPollAllowedAt = 0;
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
    this.consecutivePollErrors = 0;
    this.nextPollAllowedAt = 0;
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
      this.notice = undefined;
      this.consecutivePollErrors = 0;
      this.nextPollAllowedAt = 0;
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
      void this.syncNow().catch((e) =>
        log.warn("Scheduled S3 workspace push failed", safeError(e)),
      );
    }, delayMs);
    this.pushDebounceTimer.unref?.();
  }

  schedulePresenceUpdate(): void {
    if (this.disposed || !this.canReachBucket()) return;
    void this.publishAndRefreshPresence().catch(() => {});
  }

  async syncNow(): Promise<void> {
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
        let lastLocal: Awaited<ReturnType<S3WorkspaceSyncCallbacks["getLocalState"]>> | undefined;

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
          const remote = await this.readRemoteWorkspaceWithMeta(provider, remotePath);
          const local = await this.callbacks.getLocalState();
          lastLocal = local;

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
            remote.payload ?? {},
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
          // asked for after a change here (schedulePush) finds that difference; one that finds none has
          // nothing to send. Writing whenever the merge "changed" something made every installation
          // rewrite the whole object every few seconds for ever, each one's write being the next
          // one's reason to sync.
          const shouldWriteRemote = !remote.payload || remoteChanged;
          if (!shouldWriteRemote) break;

          const buf = Buffer.from(JSON.stringify(merged, null, 2), "utf8");
          // "Nothing there yet" is asked only when nothing is there: an object that is there and could
          // not be read is replaced as the copy that was read, or plainly where the store gives no mark.
          const casOptions = remote.etag
            ? { ifMatch: remote.etag }
            : !remote.stat
              ? { ifNoneMatch: "*" }
              : undefined;
          try {
            if (remote.broken) {
              // What was there is kept beside it, for whoever wants to know what happened to it. One
              // copy, under one name: the newest broken file replaces the one before.
              await this.writeProviderFile(provider, this.objectPath(BROKEN_WORKSPACE_FILENAME), remote.broken).catch((err) =>
                log.warn("Could not keep a copy of the unreadable workspace file", safeError(err)),
              );
            }
            await this.writeProviderFile(provider, remotePath, buf, casOptions);
            if (remote.broken)
              this.notice = `The team's workspace file in the bucket could not be read on ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC: it was not a valid workspace file. A copy of it was kept in the bucket as ${BROKEN_WORKSPACE_FILENAME}, and the file was written again from this installation's copy of the servers, memories and activity. What only the broken file held comes back when the installation that wrote it syncs.`;
            const stat = await this.statOrNull(provider, remotePath);
            this.lastKnownRemoteStat = stat
              ? { size: stat.size, mtime: stat.mtime }
              : null;
            break;
          } catch (err) {
            if (isPreconditionFailedError(err) && attempt + 1 < MAX_CAS_ATTEMPTS) {
              log.warn(
                `S3 workspace CAS conflict (412), retrying merge (attempt ${attempt + 1}/${MAX_CAS_ATTEMPTS})`,
              );
              continue;
            }
            throw err;
          }
        }

        if (lastLocal && this.options.publishPresence !== false) {
          await this.publishAndRefreshPresenceInternal(provider, lastLocal);
        }

        this.connected = true;
        this.lastError = undefined;
        this.consecutivePollErrors = 0;
        this.nextPollAllowedAt = 0;
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
    if (this.disposed || !this.canReachBucket() || this.syncing || this.polling) return;
    if (this.nextPollAllowedAt > 0 && Date.now() < this.nextPollAllowedAt) return;
    this.polling = true;
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
        // Presence has a timer of its own (startTimers). It used to be written and read here as well,
        // so every installation wrote its file and read everybody's twice as often as it was due.
        if (!this.connected || this.lastError) {
          this.connected = true;
          this.lastError = undefined;
          this.callbacks.onStateChanged();
        }
      }
      this.consecutivePollErrors = 0;
      this.nextPollAllowedAt = 0;
    } catch (err) {
      this.consecutivePollErrors += 1;
      const baseMs = Math.max(50, this.options.pollIntervalMs ?? 10_000);
      const maxBackoffMs = Math.max(baseMs, this.options.maxPollBackoffMs ?? DEFAULT_MAX_POLL_BACKOFF_MS);
      const delayMs = Math.min(maxBackoffMs, baseMs * Math.pow(2, this.consecutivePollErrors - 1));
      this.nextPollAllowedAt = Date.now() + delayMs;
      this.connected = false;
      this.lastError = safeError(err);
      this.callbacks.onStateChanged();
    } finally {
      this.polling = false;
    }
  }

  async publishAndRefreshPresence(): Promise<void> {
    if (this.disposed || !this.canReachBucket() || this.options.publishPresence === false) return;
    const provider = await this.getOrCreateProvider();
    const local = await this.callbacks.getLocalState();
    await this.publishAndRefreshPresenceInternal(provider, local);
  }

  private async publishAndRefreshPresenceInternal(
    provider: IStorageProvider,
    local: {
      actor: string;
      clientId?: string;
      activeTerminals: WorkspacePresenceTerminal[];
    },
  ): Promise<void> {
    const actor = (local.actor || "teammate").trim();
    const clientId = (local.clientId || this.options.clientId || this.fallbackClientId).trim();
    const safeActor = actor.replace(/[^a-zA-Z0-9_.-]/g, "_") || "teammate";
    const safeClient = clientId.replace(/[^a-zA-Z0-9_.-]/g, "_") || "client";
    const selfFileName = `${safeActor}--${safeClient}.json`;
    const now = Date.now();
    const selfEntry: ClientWorkspacePresenceEntry = {
      actor,
      clientId,
      updatedAt: now,
      activeTerminals: Array.isArray(local.activeTerminals) ? local.activeTerminals : [],
    };

    const selfPath = `${this.presenceDirPath()}/${selfFileName}`;
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
    const entries: ClientWorkspacePresenceEntry[] = [selfEntry];
    const listedPresence = new Set<string>();
    try {
      const files = await this.withTimeout("S3 presence list", (signal) =>
        (provider as ConditionalStorageProvider).list(this.presenceDirPath(), { signal }),
      );
      const cutoff = now - PRESENCE_TTL_MS;
      for (const file of files) {
        if (file.isDirectory || !file.name.endsWith(".json")) continue;
        if (file.name === selfFileName) continue;
        const filePath = `${this.presenceDirPath()}/${file.name}`;
        listedPresence.add(file.name);
        try {
          // A file whose mark in the listing is as it was has not been written since: somebody who
          // is away. It is not downloaded again at every heartbeat.
          const version = file.etag ? `${file.etag}:${file.size}` : undefined;
          const known = this.presenceSeen.get(file.name);
          let parsed: ClientWorkspacePresenceEntry;
          if (version && known?.version === version) parsed = known.entry;
          else {
            const buf = await this.readProviderFile(provider, filePath, 64_000);
            parsed = JSON.parse(buf.toString("utf8")) as ClientWorkspacePresenceEntry;
            if (version) this.presenceSeen.set(file.name, { version, entry: parsed });
            else this.presenceSeen.delete(file.name);
          }
          if (
            parsed &&
            typeof parsed.actor === "string" &&
            typeof parsed.updatedAt === "number" &&
            parsed.updatedAt >= cutoff
          ) {
            entries.push({
              actor: parsed.actor,
              ...(typeof parsed.clientId === "string" && parsed.clientId.trim()
                ? { clientId: parsed.clientId.trim() }
                : {}),
              updatedAt: parsed.updatedAt,
              activeTerminals: Array.isArray(parsed.activeTerminals)
                ? parsed.activeTerminals
                : [],
            });
          } else if (
            parsed &&
            typeof parsed.updatedAt === "number" &&
            parsed.updatedAt < now - PRESENCE_REMOVE_AFTER_MS
          ) {
            // Nobody has been there for a day: an installation that is gone (or an id from before ids
            // lasted) is taken away, so that the folder does not grow with every start there ever was.
            await provider.delete(filePath, false).catch(() => undefined);
          }
        } catch {
          // Ignore unreadable peer presence file
        }
      }
      for (const name of [...this.presenceSeen.keys()]) if (!listedPresence.has(name)) this.presenceSeen.delete(name);
    } catch {
      // Directory may not exist yet
    }

    const prevJson = JSON.stringify(
      this.presenceList.map((p) => ({
        actor: p.actor,
        clientId: p.clientId,
        terminals: (p.activeTerminals ?? []).map((t) => `${t.targetLabel}:${t.state}`),
      })),
    );
    this.presenceList = entries.sort(
      (a, b) =>
        a.actor.localeCompare(b.actor) ||
        (a.clientId ?? "").localeCompare(b.clientId ?? "") ||
        a.updatedAt - b.updatedAt,
    );
    const nextJson = JSON.stringify(
      this.presenceList.map((p) => ({
        actor: p.actor,
        clientId: p.clientId,
        terminals: (p.activeTerminals ?? []).map((t) => `${t.targetLabel}:${t.state}`),
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

  /** What trying the bucket's conditional writes came to: asked once for a bucket, and again after its settings change. */
  private conditionalWritesTried?: Promise<boolean>;

  /**
   * Whether this bucket really refuses a write whose condition does not hold. Amazon S3 does. Some
   * stores that speak the same protocol take the headers and write anyway, and then a ticket's claim
   * or a "do once" mark that "was written" proves nothing. So it is tried, once: an object is written,
   * then written again asking that nothing be there, and then as the copy of a version it is not.
   * Both must be refused. A try that cannot be made (the network) counts as "no" for now, which is
   * the careful answer, and is made again next time.
   */
  private checkConditionalWrites(): Promise<boolean> {
    if (this.conditionalWritesTried) return this.conditionalWritesTried;
    const tried = (async (): Promise<boolean> => {
      const provider = await this.getOrCreateProvider();
      const at = this.objectPath(`work/probe/conditional-${crypto.randomUUID()}.json`);
      const refused = async (options: { ifMatch?: string; ifNoneMatch?: string }): Promise<boolean> => {
        try {
          await this.writeProviderFile(provider, at, Buffer.from('{"second":true}', "utf8"), options);
          return false;
        } catch (err) {
          if (isPreconditionFailedError(err)) return true;
          throw err;
        }
      };
      try {
        await this.writeProviderFile(provider, at, Buffer.from("{}", "utf8"));
        return (await refused({ ifNoneMatch: "*" })) && (await refused({ ifMatch: '"not-this-objects-version"' }));
      } finally {
        await this.withTimeout("S3 objects delete", (signal) => (provider as ConditionalStorageProvider).delete(at, false, { signal })).catch(() => undefined);
      }
    })();
    this.conditionalWritesTried = tried;
    return tried.then(
      (answer) => {
        if (!answer) log.warn("The team bucket does not refuse conditional writes: ticket claims and marks are checked by reading back.");
        return answer;
      },
      (err) => {
        if (this.conditionalWritesTried === tried) this.conditionalWritesTried = undefined;
        log.warn("Could not try the team bucket's conditional writes", safeError(err));
        return false;
      },
    );
  }

  /**
   * Plain object access under the workspace prefix, for data that lives in
   * the bucket beside the workspace file (the learning queue). Paths are
   * relative to the prefix.
   */
  readonly objects = {
    conditionalWrites: (): Promise<boolean> => this.checkConditionalWrites(),
    list: async (dir: string): Promise<string[]> => {
      const provider = await this.getOrCreateProvider();
      try {
        const entries = await this.withTimeout("S3 objects list", (signal) =>
          (provider as ConditionalStorageProvider).list(this.objectPath(dir), { signal }),
        );
        return entries
          .filter((entry) => !entry.isDirectory)
          .map((entry) => entry.name);
      } catch (err) {
        if (this.isNotFoundError(err)) return [];
        throw err;
      }
    },
    /**
     * The same listing, asked of the bucket afresh, with each object's mark: its ETag. A reader that
     * kept the mark does not download an object that has not changed. A store that gives no ETag gets
     * no mark, so its objects are read: a size and a time to the second do not tell a change apart.
     */
    listWithMeta: async (dir: string): Promise<ListedObject[]> => {
      const provider = await this.getOrCreateProvider();
      try {
        const entries = await this.withTimeout("S3 objects list", (signal) =>
          (provider as ConditionalStorageProvider).list(this.objectPath(dir), { force: true, signal }),
        );
        return entries
          .filter((entry) => !entry.isDirectory)
          .map((entry) => ({ name: entry.name, ...(entry.etag ? { version: `${entry.etag}:${entry.size}` } : {}) }));
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
    readWithMeta: async (
      relative: string,
    ): Promise<{ buffer: Buffer; etag?: string } | undefined> => {
      const provider = await this.getOrCreateProvider();
      const target = this.objectPath(relative);
      try {
        const stat = await this.statOrNull(provider, target);
        if (!stat) return undefined;
        const buffer = await this.readProviderFile(provider, target);
        return { buffer, etag: stat.etag };
      } catch (err) {
        if (this.isNotFoundError(err)) return undefined;
        throw err;
      }
    },
    write: async (
      relative: string,
      content: Buffer,
      options?: { ifMatch?: string; ifNoneMatch?: string },
    ): Promise<void> => {
      const provider = await this.getOrCreateProvider();
      await this.writeProviderFile(provider, this.objectPath(relative), content, options);
    },
    remove: async (relative: string): Promise<void> => {
      const provider = await this.getOrCreateProvider();
      try {
        await this.withTimeout("S3 objects delete", (signal) =>
          (provider as ConditionalStorageProvider).delete(this.objectPath(relative), false, { signal }),
        );
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

  private requestTimeoutMs(): number {
    return Math.max(50, this.options.requestTimeoutMs ?? DEFAULT_S3_REQUEST_TIMEOUT_MS);
  }

  private async withTimeout<T>(
    label: string,
    fn: (signal: AbortSignal) => Promise<T>,
    timeoutMs = this.requestTimeoutMs(),
  ): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        const reason = signal.reason;
        reject(
          reason instanceof Error
            ? reason
            : new Error(`${label} timed out after ${timeoutMs}ms`),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() => fn(signal))
        .then(
          (val) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            resolve(val);
          },
          (err) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            reject(err);
          },
        );
    });
  }

  private async getOrCreateProvider(): Promise<IStorageProvider> {
    // Every bucket connection is made here: never in demo mode, whichever path asked for it.
    assertOutwardSyncAllowed(SYNC);
    if (this.provider) return this.provider;
    if (this.options.providerFactory) {
      const candidate = this.options.providerFactory(this.config);
      await this.withTimeout("S3 provider connect", async () => {
        await (candidate as { connect?: () => Promise<void> }).connect?.();
      });
      this.provider = candidate;
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
    await this.withTimeout("S3 provider connect", async () => {
      await (s3Provider as { connect?: () => Promise<void> }).connect?.();
    });
    this.provider = s3Provider;
    return this.provider;
  }

  private async resetProvider(): Promise<void> {
    const old = this.provider;
    this.provider = undefined;
    // Another bucket, or other settings for this one: what was found out about the old one does not hold.
    this.conditionalWritesTried = undefined;
    if (old) {
      await old.disconnect?.().catch(() => {});
    }
  }

  private async readRemoteWorkspaceWithMeta(
    provider: IStorageProvider,
    remotePath: string,
  ): Promise<{
    payload: Partial<S3WorkspaceRemotePayload> | null;
    etag?: string;
    stat: FileEntry | null;
    /** The object as it was read, when it is there and is not a workspace (not JSON, or not an object). */
    broken?: Buffer;
  }> {
    const stat = await this.statOrNull(provider, remotePath);
    if (!stat) {
      this.lastKnownRemoteStat = null;
      return { payload: null, stat: null };
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
    if (!text) return { payload: null, etag: stat.etag, stat };
    // A file that was cut off or written over by something else must not stop the team's sync for
    // good: every installation has its own copy of what was in it, and the merge puts them together.
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { payload: parsed as Partial<S3WorkspaceRemotePayload>, etag: stat.etag, stat };
    } catch {
      // Not JSON: handled below like JSON that is not a workspace.
    }
    return { payload: null, etag: stat.etag, stat, broken: raw };
  }

  private async statOrNull(
    provider: IStorageProvider,
    remotePath: string,
  ): Promise<FileEntry | null> {
    try {
      return await this.withTimeout("S3 stat", (signal) =>
        (provider as ConditionalStorageProvider).stat(remotePath, { signal }),
      );
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
    return await this.withTimeout("S3 read", async (signal) => {
      const conditional = provider as ConditionalStorageProvider;
      if (typeof conditional.readFile === "function") {
        const data = await conditional.readFile(remotePath, { signal });
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
          signal.removeEventListener("abort", onAbort);
          fn();
        };
        const onAbort = () => {
          (stream as unknown as { destroy?: () => void }).destroy?.();
          finish(() => reject(new Error(`S3 read aborted for ${remotePath}`)));
        };
        signal.addEventListener("abort", onAbort, { once: true });
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
    });
  }

  private async writeProviderFile(
    provider: IStorageProvider,
    remotePath: string,
    buffer: Buffer,
    options?: { ifMatch?: string; ifNoneMatch?: string },
  ): Promise<void> {
    await this.withTimeout("S3 write", async (signal) => {
      const conditional = provider as ConditionalStorageProvider;
      if (typeof conditional.writeFile === "function") {
        await conditional.writeFile(remotePath, buffer, {
          mode: 0o600,
          size: buffer.length,
          ...(options?.ifMatch !== undefined ? { ifMatch: options.ifMatch } : {}),
          ...(options?.ifNoneMatch !== undefined ? { ifNoneMatch: options.ifNoneMatch } : {}),
          signal,
        });
        return;
      }
      const stream = await provider.createWriteStream(remotePath, {
        mode: 0o600,
        size: buffer.length,
      });
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          (stream as unknown as { destroy?: () => void }).destroy?.();
          reject(new Error(`S3 write aborted for ${remotePath}`));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        stream.on("error", (err) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(err);
        });
        stream.end(buffer, () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve();
        });
      });
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
