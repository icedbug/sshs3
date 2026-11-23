import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { openSecretValue, sealSecretValue } from "../../crypto/SecretFieldCrypto";
import { NOTIFY_KINDS, type FlapState, type NotifyChannel, type QuietHoursConfig } from "./Notifier";
import type { InboxKind } from "../../../shared/aiHubInbox";

/**
 * A notification that quiet hours or the hourly limit held back: what it was about, in a line. Kept
 * until the quiet is over, then told with the others in one message. Not the command or its details:
 * those are in the inbox, where the message's link leads.
 */
export interface HeldNotice {
  id: string;
  kind: InboxKind;
  title: string;
  from?: string;
  target?: string;
  risk?: string;
  /** It had been told before: what was held was the reminder that it still waited. */
  reminder?: boolean;
  /** When it was held. */
  at: number;
  /** Since when the item waited: what tells one waiting of a shared ticket from the next, across installations. */
  since: number;
}

/** How many held notifications are kept. More than that happened: the oldest are let go and counted. */
export const MAX_HELD_NOTICES = 50;

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
  /** Recent push timestamps (ms) used to enforce hourly noise budget. */
  pushHistory?: number[];
  /** Optional quiet-hours suppression schedule. */
  quietHours?: QuietHoursConfig;
  /** Maximum pushes allowed per rolling hour (0 or undefined = unlimited). */
  noiseBudgetPerHour?: number;
  /** Per-fingerprint flap suppression duration in ms. */
  flapCooldownMs?: number;
  /** What quiet hours or the hourly limit held back, oldest first, at most MAX_HELD_NOTICES. */
  held?: HeldNotice[];
  /** How many more were held than are kept. */
  heldMore?: number;
}

const empty = (): NotifyData => ({
  version: 1,
  channels: [],
  seen: {},
  reminded: {},
  publicUrl: "",
  reminderMinutes: 5,
  flapCooldown: {},
  pushHistory: [],
  held: [],
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
  /**
   * An address or a signing secret that was stored encrypted and could not be decrypted on this start,
   * by channel id: the ciphertext as it was stored. In memory the value is empty; a save writes the
   * ciphertext back unchanged, so one start without the keyring does not empty the channel for good.
   */
  private readonly unread = new Map<string, { url?: string; secret?: string }>();

  constructor(private readonly file: string) {}

  /** Which of a channel's secrets could not be read on this start. */
  unreadOf(id: string | undefined): { url: boolean; secret: boolean } {
    const kept = id ? this.unread.get(id) : undefined;
    return { url: Boolean(kept?.url), secret: Boolean(kept?.secret) };
  }

  /** A person entered or removed the value: what could not be read is not written back any more. */
  forgetUnread(id: string, field: "url" | "secret"): void {
    const kept = this.unread.get(id);
    if (!kept) return;
    delete kept[field];
    if (!kept.url && !kept.secret) this.unread.delete(id);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      // What earlier versions kept for functions nothing ever called is not carried on.
      const { autoPausePending: _a, escalations: _e, autoPauseSeconds: _s, escalationMinutes: _m, ...raw } = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<NotifyData> & Record<string, unknown>;
      const count = (value: unknown, max: number): number | undefined =>
        typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(max, Math.floor(value)) : undefined;
      const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value ? value.slice(0, max) : undefined);
      const quiet = raw.quietHours;
      this.data = {
        ...empty(),
        ...raw,
        version: 1,
        // The policy settings are read back as what they must be, or not at all.
        quietHours:
          quiet && typeof quiet === "object" && typeof quiet.enabled === "boolean" && count(quiet.startHour, 23) !== undefined && count(quiet.endHour, 23) !== undefined
            ? {
                enabled: quiet.enabled,
                startHour: count(quiet.startHour, 23)!,
                endHour: count(quiet.endHour, 23)!,
                ...(count(quiet.startMinute, 59) !== undefined ? { startMinute: count(quiet.startMinute, 59) } : {}),
                ...(count(quiet.endMinute, 59) !== undefined ? { endMinute: count(quiet.endMinute, 59) } : {}),
                ...(typeof quiet.timezone === "string" && quiet.timezone ? { timezone: quiet.timezone.slice(0, 64) } : {}),
                ...(typeof quiet.timezoneOffsetMinutes === "number" && Number.isFinite(quiet.timezoneOffsetMinutes)
                  ? { timezoneOffsetMinutes: quiet.timezoneOffsetMinutes }
                  : {}),
                ...(typeof quiet.allowCritical === "boolean" ? { allowCritical: quiet.allowCritical } : {}),
              }
            : undefined,
        noiseBudgetPerHour: count(raw.noiseBudgetPerHour, 1000),
        flapCooldownMs: count(raw.flapCooldownMs, 24 * 3_600_000),
        seen: raw.seen && typeof raw.seen === "object" ? raw.seen : {},
        reminded: raw.reminded && typeof raw.reminded === "object" ? raw.reminded : {},
        flapCooldown: raw.flapCooldown && typeof raw.flapCooldown === "object" ? raw.flapCooldown : {},
        pushHistory: Array.isArray(raw.pushHistory) ? raw.pushHistory.filter((n) => typeof n === "number") : [],
        // What was held is read back as what it must be: a kind that is told about, a line, two times.
        held: (Array.isArray(raw.held) ? (raw.held as Partial<HeldNotice>[]) : [])
          .filter((h) => h && typeof h.id === "string" && h.id && NOTIFY_KINDS.includes(h.kind as InboxKind) && typeof h.title === "string")
          .map((h) => ({
            id: h.id!.slice(0, 200),
            kind: h.kind!,
            title: h.title!.slice(0, 200),
            ...(text(h.from, 120) ? { from: text(h.from, 120) } : {}),
            ...(text(h.target, 120) ? { target: text(h.target, 120) } : {}),
            ...(text(h.risk, 40) ? { risk: text(h.risk, 40) } : {}),
            ...(h.reminder === true ? { reminder: true } : {}),
            at: count(h.at, Number.MAX_SAFE_INTEGER) ?? 0,
            since: count(h.since, Number.MAX_SAFE_INTEGER) ?? 0,
          }))
          .slice(-MAX_HELD_NOTICES),
        heldMore: count(raw.heldMore, 1_000_000),
        channels: (raw.channels ?? []).map((c) => {
          const url = openSecretValue(c.url ?? "");
          const secret = c.secret ? openSecretValue(c.secret) : undefined;
          if (url.kept || secret?.kept) this.unread.set(c.id, { url: url.kept, secret: secret?.kept });
          return { ...c, url: url.value, secret: secret?.value || undefined };
        }),
      };
    } catch {
      this.data = empty();
    }
  }

  /**
   * Keeps notifications that were held back, to be told later in one message. One item is kept once,
   * however often it was held. At most MAX_HELD_NOTICES: past that the oldest are let go and counted.
   */
  hold(notices: HeldNotice[]): void {
    if (!notices.length) return;
    const kept = this.data.held ?? [];
    const byId = new Map(kept.map((h) => [h.id, h]));
    for (const notice of notices) if (!byId.has(notice.id)) byId.set(notice.id, notice);
    const all = [...byId.values()];
    const over = Math.max(0, all.length - MAX_HELD_NOTICES);
    this.data.held = all.slice(over);
    if (over) this.data.heldMore = (this.data.heldMore ?? 0) + over;
  }

  /** Takes everything that was held, to be told now: the notices, and how many more there were than were kept. */
  takeHeld(): { notices: HeldNotice[]; more: number } {
    const taken = { notices: this.data.held ?? [], more: this.data.heldMore ?? 0 };
    this.data.held = [];
    delete this.data.heldMore;
    return taken;
  }

  save(): Promise<void> {
    for (const id of [...this.unread.keys()]) if (!this.data.channels.some((c) => c.id === id)) this.unread.delete(id);
    const content = JSON.stringify({
      ...this.data,
      channels: this.data.channels.map((c) => {
        const kept = this.unread.get(c.id);
        return { ...c, url: sealSecretValue(c.url, kept?.url), secret: sealSecretValue(c.secret, kept?.secret) || undefined };
      }),
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
