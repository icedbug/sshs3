import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { decryptSecretValue, encryptSecretValue } from "../../crypto/SecretFieldCrypto";
import type {
  AutoPauseEntry,
  EscalationEntry,
  FlapState,
  NotifyChannel,
  QuietHoursConfig,
} from "./Notifier";

export interface NotifyData {
  version: 1;
  channels: NotifyChannel[];
  /** Inbox items already handled, by id, with when they were first seen. */
  seen: Record<string, number>;
  /** Items already reminded about. */
  reminded: Record<string, number>;
  publicUrl: string;
  reminderMinutes: number;
  /** Per-fingerprint flap cooldown tracking state. */
  flapCooldown?: Record<string, FlapState>;
  /** Non-critical transient items buffered during the Auto-Pause cushion window. */
  autoPausePending?: Record<string, AutoPauseEntry>;
  /** Recent push timestamps (ms) used to enforce hourly noise budget. */
  pushHistory?: number[];
  /** Multi-step acknowledgement-aware escalation state per item id. */
  escalations?: Record<string, EscalationEntry>;
  /** Optional quiet-hours suppression schedule. */
  quietHours?: QuietHoursConfig;
  /** Maximum pushes allowed per rolling hour (0 or undefined = unlimited). */
  noiseBudgetPerHour?: number;
  /** Auto-Pause cushion duration in seconds (clamped 60-120s when active). */
  autoPauseSeconds?: number;
  /** Per-fingerprint flap suppression duration in ms. */
  flapCooldownMs?: number;
  /** Multi-step escalation intervals in minutes. */
  escalationMinutes?: number[];
}

const empty = (): NotifyData => ({
  version: 1,
  channels: [],
  seen: {},
  reminded: {},
  publicUrl: "",
  reminderMinutes: 5,
  flapCooldown: {},
  autoPausePending: {},
  pushHistory: [],
  escalations: {},
});

/**
 * Where notification channels are kept: a file of its own beside the hub's
 * store, readable by the owner only, with the addresses encrypted where the
 * system can. Not in the hub's store, which rewrites anything that looks like
 * a secret when it saves, and not in the team bucket: an address is the key
 * to its channel.
 */
export class NotifyStore {
  data: NotifyData = empty();
  private writes: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<NotifyData>;
      this.data = {
        ...empty(),
        ...raw,
        version: 1,
        seen: raw.seen && typeof raw.seen === "object" ? raw.seen : {},
        reminded: raw.reminded && typeof raw.reminded === "object" ? raw.reminded : {},
        flapCooldown: raw.flapCooldown && typeof raw.flapCooldown === "object" ? raw.flapCooldown : {},
        autoPausePending: raw.autoPausePending && typeof raw.autoPausePending === "object" ? raw.autoPausePending : {},
        pushHistory: Array.isArray(raw.pushHistory) ? raw.pushHistory.filter((n) => typeof n === "number") : [],
        escalations: raw.escalations && typeof raw.escalations === "object" ? raw.escalations : {},
        channels: (raw.channels ?? []).map((c) => ({
          ...c,
          url: decryptSecretValue(c.url ?? ""),
          secret: c.secret ? decryptSecretValue(c.secret) : undefined,
        })),
      };
    } catch {
      this.data = empty();
    }
  }

  /** Marks an inbox item acknowledged so further multi-step escalation tiers stop. */
  acknowledge(itemId: string, by?: string, now = Date.now()): void {
    this.data.seen[itemId] ??= now;
    this.data.escalations ??= {};
    const prev = this.data.escalations[itemId];
    this.data.escalations[itemId] = {
      tier: prev?.tier ?? 0,
      lastTierAt: prev?.lastTierAt ?? now,
      ackedAt: now,
      ...(by ? { ackedBy: by } : {}),
    };
  }

  /** Records an outbound notification push timestamp for hourly noise-budget accounting. */
  recordPush(now = Date.now()): void {
    const oneHourAgo = now - 3600_000;
    const prev = this.data.pushHistory ?? [];
    this.data.pushHistory = [...prev.filter((ts) => ts >= oneHourAgo && ts <= now), now];
  }

  /** Prunes stale policy tracking state for items no longer active. */
  prunePolicyState(activeItemIds: Set<string>, now = Date.now()): void {
    const oneHourAgo = now - 3600_000;
    this.data.pushHistory = (this.data.pushHistory ?? []).filter((ts) => ts >= oneHourAgo && ts <= now);
    if (this.data.autoPausePending) {
      this.data.autoPausePending = Object.fromEntries(
        Object.entries(this.data.autoPausePending).filter(([id]) => activeItemIds.has(id)),
      );
    }
    if (this.data.escalations) {
      this.data.escalations = Object.fromEntries(
        Object.entries(this.data.escalations).filter(([id]) => activeItemIds.has(id)),
      );
    }
    if (this.data.flapCooldown) {
      this.data.flapCooldown = Object.fromEntries(
        Object.entries(this.data.flapCooldown).filter(
          ([, v]) => (v.suppressedUntil !== undefined && v.suppressedUntil > now) || now - v.lastAt <= 3600_000,
        ),
      );
    }
  }

  save(): Promise<void> {
    const content = JSON.stringify({
      ...this.data,
      channels: this.data.channels.map((c) => ({
        ...c,
        url: encryptSecretValue(c.url),
        secret: c.secret ? encryptSecretValue(c.secret) : undefined,
      })),
    });
    const write = async (): Promise<void> => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.tmp-${process.pid}-${crypto.randomUUID()}`;
      await fs.writeFile(temporary, content, { mode: 0o600 });
      await fs.rename(temporary, this.file);
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }
}
