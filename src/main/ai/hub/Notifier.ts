import crypto from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { InboxItem, InboxKind } from "../../../shared/aiHubInbox";
import type { NotifyChannelKind } from "../../../shared/types/aiHub";
import { clip } from "./privacy";

/** What a channel can be told about. Knowledge base findings are not urgent enough to push to a phone. */
export const NOTIFY_KINDS: InboxKind[] = ["approval", "plan", "question", "blocked", "alert", "health", "review", "report"];

/** A channel as it is kept in memory: the address and the secret in the clear. */
export interface NotifyChannel {
  id: string;
  kind: NotifyChannelKind;
  name: string;
  /** Where to post. A secret: whoever has it can post to the channel. */
  url: string;
  /** ntfy: an access token. Webhook: the key the body is signed with. */
  secret?: string;
  enabled: boolean;
  events: InboxKind[];
  /** Whether the command text itself may leave the installation. */
  includeCommand: boolean;
  alertMinSeverity?: "info" | "warning" | "critical";
  last?: { at: number; ok: boolean; status?: number; error?: string };
}

/** One inbox item with what a person needs to decide, taken from the run it belongs to. */
export interface NotifyItem {
  id: string;
  kind: InboxKind;
  title: string;
  detail?: string;
  from?: string;
  target?: string;
  /** An alert's or a health finding's severity. */
  risk?: string;
  command?: string;
  check?: string;
  rollback?: string;
  /** How long the agent waits for an answer before it gives up. */
  waitsMinutes?: number;
  link?: string;
  /** Sent a second time because nobody answered. */
  reminder?: boolean;
  /** Escalation step (>= 1) when multi-step escalation tiers are used. */
  escalationTier?: number;
  /** Optional fingerprint for per-fingerprint flap cooldown tracking. */
  fingerprint?: string;
  /** Said instead of the kind's own headline (a test message). */
  headline?: string;
}

export interface NotifyContext {
  /** The person whose installation this is: on a shared server, only they can approve. */
  owner?: string;
  inboxLink?: string;
  /**
   * The message's own first line, for a message that is a list whatever the number of its items: what
   * was held back while notifications were quiet, told afterwards. One item is then a list of one.
   */
  heading?: string;
  /** How many more there were than are listed: said in the list's last line. */
  more?: number;
}

const SEVERITY = { info: 0, warning: 1, critical: 2 } as const;

/** Whether this channel wants this item. */
export function channelWants(channel: Pick<NotifyChannel, "enabled" | "events" | "alertMinSeverity">, item: Pick<NotifyItem, "kind" | "risk">): boolean {
  // A teammate's change that needs a second person is an approval that is asked for: whoever wants to be told of approvals is told.
  if (!channel.enabled || !channel.events.includes(item.kind === "peer" ? "approval" : item.kind)) return false;
  if (item.kind !== "alert" || !channel.alertMinSeverity) return true;
  const have = SEVERITY[(item.risk as keyof typeof SEVERITY) ?? "warning"] ?? 1;
  return have >= SEVERITY[channel.alertMinSeverity];
}

/**
 * Which inbox items are new since last time. An item that is already old when
 * it is first seen (the app was closed, or channels were just switched on) is
 * taken note of without a notification: nobody wants yesterday's inbox pushed
 * to their phone. An item that leaves the inbox is forgotten, so it notifies
 * again if it comes back.
 */
export function diffInbox(
  items: InboxItem[],
  seen: Record<string, number>,
  now: number,
  staleAfterMs = 15 * 60_000,
): { fresh: InboxItem[]; seen: Record<string, number> } {
  const next: Record<string, number> = {};
  const fresh: InboxItem[] = [];
  for (const item of items) {
    if (seen[item.id] !== undefined) {
      next[item.id] = seen[item.id];
      continue;
    }
    next[item.id] = now;
    if (now - (item.since ?? item.at) <= staleAfterMs) fresh.push(item);
  }
  return { fresh, seen: next };
}

// ---- alert noise control & escalation policies --------------------------------

export interface FlapState {
  lastAt: number;
  count: number;
  suppressedUntil?: number;
}

export interface FlapCooldownOptions {
  /** Sliding window in which repeated transitions count toward flapping (default 10 min). */
  windowMs?: number;
  /** Number of transitions within windowMs before cooldown triggers (default 3). */
  maxChangesBeforeFlap?: number;
  /** How long notifications for a flapping fingerprint are suppressed (default 10 min). */
  cooldownMs?: number;
  /** Whether critical items bypass flap suppression (default false). */
  allowCriticalBypass?: boolean;
}

/**
 * Tracks per-fingerprint notification transitions and suppresses rapid flapping
 * once a fingerprint recurs `maxChangesBeforeFlap` times within `windowMs`.
 */
export function evaluateFlapCooldown(
  fingerprint: string,
  state: Record<string, FlapState>,
  now: number,
  options: FlapCooldownOptions & { severity?: string } = {},
): { allow: boolean; flapping: boolean; nextState: Record<string, FlapState>; suppressedUntil?: number } {
  const windowMs = options.windowMs ?? 10 * 60_000;
  const maxChanges = options.maxChangesBeforeFlap ?? 3;
  const cooldownMs = options.cooldownMs ?? 10 * 60_000;
  const nextState: Record<string, FlapState> = { ...state };
  const prev = nextState[fingerprint];

  if (options.allowCriticalBypass && options.severity === "critical") {
    nextState[fingerprint] = { lastAt: now, count: (prev?.count ?? 0) + 1, suppressedUntil: prev?.suppressedUntil };
    return { allow: true, flapping: false, nextState };
  }

  if (prev?.suppressedUntil !== undefined && now < prev.suppressedUntil) {
    nextState[fingerprint] = { ...prev, lastAt: now, count: prev.count + 1 };
    return { allow: false, flapping: true, nextState, suppressedUntil: prev.suppressedUntil };
  }

  const withinWindow = prev !== undefined && now - prev.lastAt <= windowMs;
  const count = withinWindow ? prev.count + 1 : 1;
  if (count >= maxChanges) {
    const suppressedUntil = now + cooldownMs;
    nextState[fingerprint] = { lastAt: now, count, suppressedUntil };
    return { allow: false, flapping: true, nextState, suppressedUntil };
  }

  nextState[fingerprint] = { lastAt: now, count };
  return { allow: true, flapping: false, nextState };
}

export interface QuietHoursConfig {
  enabled: boolean;
  /** Hour [0..23] when quiet hours begin. */
  startHour: number;
  /** Hour [0..23] when quiet hours end. */
  endHour: number;
  /** Minutes past `startHour` / `endHour` (0 unless set). */
  startMinute?: number;
  endMinute?: number;
  /** Optional UTC offset in minutes for deterministic evaluation (e.g. 60 for UTC+1). */
  timezoneOffsetMinutes?: number;
  /** A time zone by name (e.g. "Europe/Berlin"), as the settings card sets it. Wins over the offset. */
  timezone?: string;
  /** Whether critical items bypass quiet hours (default true). */
  allowCritical?: boolean;
}

/** Whether `now` falls inside the configured quiet-hours window. */
export function isQuietHours(config: QuietHoursConfig | undefined, now: number): boolean {
  if (!config?.enabled) return false;
  const minuteOf = (hour: number, minute = 0): number =>
    ((((Math.trunc(hour) % 24) + 24) % 24) * 60 + Math.min(59, Math.max(0, Math.trunc(minute))));
  const start = minuteOf(config.startHour, config.startMinute);
  const end = minuteOf(config.endHour, config.endMinute);
  if (start === end) return true;
  let current: number | undefined;
  if (config.timezone) {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(now));
      current = (Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24) * 60 + Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    } catch {
      current = undefined;
    }
  }
  if (current === undefined) {
    const at = config.timezoneOffsetMinutes !== undefined ? new Date(now + config.timezoneOffsetMinutes * 60_000) : new Date(now);
    current =
      config.timezoneOffsetMinutes !== undefined
        ? at.getUTCHours() * 60 + at.getUTCMinutes()
        : at.getHours() * 60 + at.getMinutes();
  }
  return start < end ? current >= start && current < end : current >= start || current < end;
}

/**
 * Applies quiet hours and an hourly push budget (`maxPushesPerHour`) to outgoing
 * notifications. Critical items bypass suppression unless `allowCritical` is false.
 */
export function evaluateNoiseBudget<T extends Pick<NotifyItem, "id" | "kind" | "risk">>(
  items: T[],
  pushHistory: number[],
  now: number,
  options: { maxPushesPerHour?: number; quietHours?: QuietHoursConfig; allowCriticalBypass?: boolean } = {},
): { allowed: T[]; suppressed: T[]; reason?: "quiet-hours" | "noise-budget"; nextPushHistory: number[] } {
  const oneHourAgo = now - 3600_000;
  const recentPushes = pushHistory.filter((ts) => ts >= oneHourAgo && ts <= now);
  const quiet = isQuietHours(options.quietHours, now);
  const maxPerHour = options.maxPushesPerHour ?? 0;
  const budgetExhausted = maxPerHour > 0 && recentPushes.length >= maxPerHour;
  const allowCritical = (options.quietHours?.allowCritical ?? true) && (options.allowCriticalBypass ?? true);

  if (!quiet && !budgetExhausted) {
    return {
      allowed: items,
      suppressed: [],
      nextPushHistory: items.length > 0 ? [...recentPushes, now] : recentPushes,
    };
  }

  const allowed: T[] = [];
  const suppressed: T[] = [];
  for (const item of items) {
    if (allowCritical && item.risk === "critical") {
      allowed.push(item);
    } else {
      suppressed.push(item);
    }
  }
  return {
    allowed,
    suppressed,
    reason: quiet ? "quiet-hours" : "noise-budget",
    nextPushHistory: allowed.length > 0 ? [...recentPushes, now] : recentPushes,
  };
}

const HEADLINE: Record<InboxKind, string> = {
  approval: "Approval needed",
  peer: "A teammate's change needs a second person",
  plan: "A plan to decide",
  question: "An agent has a question",
  blocked: "A run stopped",
  alert: "An alert nobody has taken",
  health: "A server needs attention",
  review: "Ready for review",
  report: "Daily report",
  knowledge: "Knowledge base",
};

const shorten = (text: string | undefined, max: number): string => clip((text ?? "").trim(), max);

/** The lines of one item, plain: every channel builds on these. */
function lines(item: NotifyItem, channel: Pick<NotifyChannel, "includeCommand">, context: NotifyContext): { head: string; body: string[]; command?: string } {
  const where = [item.from, item.target && !item.from?.includes(item.target) ? `on ${item.target}` : ""].filter(Boolean).join(" ");
  const waitPrefix = item.escalationTier && item.escalationTier > 1
    ? `Still waiting (tier ${item.escalationTier}): `
    : item.reminder
      ? "Still waiting: "
      : "";
  const head = `${waitPrefix}${item.headline ?? HEADLINE[item.kind]}${where ? ` — ${shorten(where, 80)}` : ""}`;
  const body: string[] = [];
  const command = channel.includeCommand && item.command ? shorten(item.command, 600) : undefined;
  if (item.title && item.title !== item.command) body.push(shorten(item.title, 200));
  else if (!command && item.command) body.push("A command (its text is not sent to this channel).");
  if (item.detail && item.detail !== item.command && item.kind !== "approval") body.push(shorten(item.detail, 300));
  if ((item.kind === "alert" || item.kind === "health") && item.risk) body.push(`Severity: ${item.risk}`);
  if (channel.includeCommand && item.check) body.push(`Check: ${shorten(item.check, 160)}`);
  if (channel.includeCommand && item.rollback) body.push(`Way back: ${shorten(item.rollback, 160)}`);
  if (item.waitsMinutes && ["approval", "plan", "question"].includes(item.kind))
    body.push(`The agent waits ${item.waitsMinutes} min${context.owner ? ` for ${context.owner}` : ""}.`);
  else if (context.owner && ["approval", "plan", "question"].includes(item.kind)) body.push(`Waiting for ${context.owner}.`);
  return { head, body, command };
}

/** `&`, `<` and `>` are Slack's control characters: escaped, a pasted `<!channel>` pings nobody. */
const slack = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface OutgoingRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * The request that tells a channel about these items. One item is told in
 * full; several that came together are one message with a line each. With a
 * heading of its own (`context.heading`) the message is such a list also for
 * one item: what was held back, told afterwards.
 */
export function renderNotification(channel: NotifyChannel, items: NotifyItem[], context: NotifyContext = {}): OutgoingRequest {
  const one = items.length === 1 && !context.heading ? items[0] : undefined;
  const link = one?.link ?? context.inboxLink;
  const single = one ? lines(one, channel, context) : undefined;
  const title = single ? single.head : (context.heading ?? `${items.length} things are waiting in sshs3`);
  const rows = single
    ? single.body
    : items.slice(0, 12).map((item) => {
        const l = lines(item, channel, context);
        return `${l.head}${item.title && item.title !== item.command ? `: ${shorten(item.title, 120)}` : ""}`;
      });
  const unlisted = Math.max(0, items.length - 12) + (context.more ?? 0);
  if (!single && unlisted > 0) rows.push(`…and ${unlisted} more`);
  const json = { "Content-Type": "application/json" };

  if (channel.kind === "slack") {
    const text = [`*${slack(title)}*`, ...(single?.command ? [`\`\`\`${slack(single.command.replace(/```/g, "'''"))}\`\`\``] : []), ...rows.map((r) => (single ? slack(r) : `• ${slack(r)}`))].join("\n");
    return {
      url: channel.url,
      headers: json,
      body: JSON.stringify({
        text: slack(title),
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } },
          ...(link ? [{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in sshs3" }, url: link }] }] : []),
        ],
      }),
    };
  }

  if (channel.kind === "teams") {
    return {
      url: channel.url,
      headers: json,
      body: JSON.stringify({
        type: "message",
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
              $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
              type: "AdaptiveCard",
              version: "1.4",
              body: [
                { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true },
                ...(single?.command ? [{ type: "TextBlock", text: single.command, fontType: "Monospace", wrap: true }] : []),
                ...rows.map((r) => ({ type: "TextBlock", text: r, wrap: true })),
              ],
              ...(link ? { actions: [{ type: "Action.OpenUrl", title: "Open in sshs3", url: link }] } : {}),
            },
          },
        ],
      }),
    };
  }

  if (channel.kind === "ntfy") {
    // https://host/topic: the topic is the last part of the path, the rest is the server.
    const at = new URL(channel.url);
    const parts = at.pathname.split("/").filter(Boolean);
    const topic = decodeURIComponent(parts.pop() ?? "");
    at.pathname = `/${parts.join("/")}`;
    at.search = "";
    const top = items.reduce((max, item) => Math.max(max, item.kind === "alert" ? (item.risk === "critical" ? 5 : 4) : ["approval", "peer", "plan", "question"].includes(item.kind) ? 4 : item.kind === "report" ? 2 : 3), 1);
    const tag: Record<InboxKind, string> = { approval: "lock", peer: "busts_in_silhouette", plan: "clipboard", question: "question", blocked: "octagonal_sign", alert: "rotating_light", health: "warning", review: "eyes", report: "memo", knowledge: "books" };
    return {
      url: at.toString(),
      headers: { ...json, ...(channel.secret ? { Authorization: `Bearer ${channel.secret}` } : {}) },
      body: JSON.stringify({
        topic,
        title,
        message: [...(single?.command ? [single.command] : []), ...rows].join("\n") || title,
        priority: top,
        tags: [tag[one?.kind ?? items[0].kind]],
        ...(link ? { click: link, actions: [{ action: "view", label: "Open in sshs3", url: link }] } : {}),
      }),
    };
  }

  const body = JSON.stringify({
    version: 1,
    event: "inbox",
    at: Date.now(),
    title,
    owner: context.owner,
    link,
    items: items.map((item) => {
      // Without the command text, nothing that carries it goes either: an approval's or a teammate's
      // detail (the command, a file change's diff, or a plan's steps), nor a title that is the command.
      const sendsCommand = channel.includeCommand || !item.command;
      const repeats = (text: string | undefined) => Boolean(text && item.command && text.trim() === item.command.trim());
      const detail = sendsCommand || (item.kind !== "approval" && item.kind !== "peer" && !repeats(item.detail)) ? item.detail : undefined;
      return {
        id: item.id,
        kind: item.kind,
        title: !sendsCommand && repeats(item.title) ? "A command (its text is not sent to this channel)." : shorten(item.title, 300),
        detail: detail ? shorten(detail, 600) : undefined,
        from: item.from,
        target: item.target,
        risk: item.risk,
        command: channel.includeCommand && item.command ? shorten(item.command, 2000) : undefined,
        link: item.link,
        reminder: item.reminder || undefined,
        ...(item.escalationTier !== undefined ? { escalationTier: item.escalationTier } : {}),
      };
    }),
  });
  return {
    url: channel.url,
    headers: {
      ...json,
      ...(channel.secret
        ? {
            "X-Sshs3-Signature": `sha256=${crypto.createHmac("sha256", channel.secret).update(body).digest("hex")}`,
            ...standardWebhookHeaders(channel.secret, body),
          }
        : {}),
    },
    body,
  };
}

// ---- signed webhooks (Standard Webhooks) ----------------------------------------
//
// A webhook with a signing key carries, besides the older X-Sshs3-Signature
// (sha256=<hex HMAC-SHA256 of the body>), the Standard Webhooks headers
// (https://www.standardwebhooks.com):
//   webhook-id:        msg_<random>, new for each message, the same on a retry
//   webhook-timestamp: unix seconds when the message was made
//   webhook-signature: v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">
// The HMAC key is the signing key as UTF-8 bytes, or, for a key written as
// whsec_<base64>, the decoded bytes (so the standard libraries verify it as is).
// A receiver checks the signature, refuses a timestamp more than 5 minutes off,
// and drops an id it has already seen: a copied request cannot be sent again.

/** The bytes a signing key stands for. */
export function webhookKey(secret: string): Buffer {
  return secret.startsWith("whsec_") ? Buffer.from(secret.slice("whsec_".length), "base64") : Buffer.from(secret, "utf8");
}

/** The v1 signature of one message. */
export function standardWebhookSignature(secret: string, id: string, timestamp: number, body: string): string {
  return `v1,${crypto.createHmac("sha256", webhookKey(secret)).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/** The three Standard Webhooks headers for this body. */
export function standardWebhookHeaders(
  secret: string,
  body: string,
  id = `msg_${crypto.randomUUID().replace(/-/g, "")}`,
  timestamp = Math.floor(Date.now() / 1000),
): Record<string, string> {
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": standardWebhookSignature(secret, id, timestamp, body),
  };
}

/** How far a signed message's timestamp may be from now. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * Whether a signed message is genuine and fresh. The signature header may hold
 * several space-separated signatures; one matching v1 is enough. Says why not
 * when it is not.
 */
export function verifyStandardWebhook(
  secret: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; reason: string } {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: "The webhook-id, webhook-timestamp and webhook-signature headers must all be present." };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "The webhook-timestamp must be unix seconds." };
  const at = Number(timestamp);
  if (Math.abs(nowSeconds - at) > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: "The webhook-timestamp is more than 5 minutes off." };
  const expected = Buffer.from(standardWebhookSignature(secret, id, at, body));
  const match = signature
    .split(" ")
    .filter(Boolean)
    .some((given) => {
      const buf = Buffer.from(given);
      return buf.length === expected.length && crypto.timingSafeEqual(buf, expected);
    });
  return match ? { ok: true } : { ok: false, reason: "The webhook-signature does not match." };
}

// ---- where a notification may be sent ----------------------------------------

/** An IPv6 address as its eight 16-bit groups, whichever way it is written (shortened, in full, with a dotted IPv4 tail). */
function groupsOf(address: string): number[] | undefined {
  if (!net.isIPv6(address)) return undefined;
  let text = address.split("%")[0].toLowerCase();
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) text = `${text.slice(0, tail.index)}${((Number(tail[1]) << 8) | Number(tail[2])).toString(16)}:${((Number(tail[3]) << 8) | Number(tail[4])).toString(16)}`;
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const fill = text.includes("::") ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array<string>(Math.max(0, fill)).fill("0"), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

/**
 * The IPv4 address an IPv6 address carries, when it carries one: mapped
 * (::ffff:a.b.c.d, or the same in hex, ::ffff:7f00:1, which is how a URL parser
 * and a DNS answer write it), translated (::ffff:0:a.b.c.d), NAT64
 * (64:ff9b::/96), the old compatible form (::a.b.c.d) and 6to4 (2002:AABB:CCDD::/48).
 * Such an address goes where its IPv4 address goes, and is judged as that.
 */
function embeddedIPv4(groups: number[]): string | undefined {
  const dotted = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (g0 === 0x2002) return dotted(g1, g2);
  if (g0 === 0x64 && g1 === 0xff9b && !(g2 | g3 | g4 | g5)) return dotted(g6, g7);
  if (g0 | g1 | g2 | g3) return undefined;
  if (g4 === 0 && g5 === 0xffff) return dotted(g6, g7);
  if (g4 === 0xffff && g5 === 0) return dotted(g6, g7);
  // The compatible form. `::` and `::1` are not IPv4 addresses.
  if (g4 === 0 && g5 === 0 && (g6 !== 0 || g7 > 1)) return dotted(g6, g7);
  return undefined;
}

/**
 * Where a cloud keeps what only the machine itself should read (credentials, keys, its own settings),
 * beside 169.254.169.254, which is link-local and refused as that: Alibaba Cloud, Azure's wire server
 * and Oracle Cloud. Never a destination, on a desktop or on a server.
 */
const CLOUD_METADATA_IPV4 = new Set(["100.100.100.200", "168.63.129.16", "192.0.0.192"]);

type AddressClass = "public" | "private" | "loopback" | "link-local" | "never";

/** What kind of place an IP address is. */
export function addressClass(address: string): AddressClass {
  const bare = address.replace(/^\[|\]$/g, "");
  const groups = groupsOf(bare);
  const ip = (groups && embeddedIPv4(groups)) ?? bare;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (CLOUD_METADATA_IPV4.has(ip)) return "never";
    if (a === 127) return "loopback";
    if (a === 169 && b === 254) return "link-local";
    if (a === 0 || a >= 224) return "never";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "private";
    return "public";
  }
  if (!groups) return "never";
  const [g0, g1, g2] = groups;
  if (groups.every((g, i) => g === (i === 7 ? 1 : 0))) return "loopback";
  if (groups.every((g) => g === 0) || g0 >> 8 === 0xff) return "never";
  // Amazon's metadata and its other instance services (fd00:ec2::254 and the rest of the prefix).
  if (g0 === 0xfd00 && g1 === 0xec2) return "never";
  // NAT64 for local use (64:ff9b:1::/48): it leads to an IPv4 address, and where in it that address
  // stands is the network's own choice, so it cannot be read here to be judged.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return "never";
  if ((g0 & 0xffc0) === 0xfe80) return "link-local";
  // Unique local (fc00::/7), and the old site-local prefix (fec0::/10).
  if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfec0) return "private";
  return "public";
}

export interface GuardOptions {
  /** A shared server: its own loopback is never a destination, and its private network only if the administrator said so. */
  server: boolean;
  allowPrivate: boolean;
  /** A page that is only read may be plain http; an address something is posted to may not. */
  allowPlainHttp?: boolean;
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
}

export interface GuardedTarget {
  url: URL;
  address: string;
  family: number;
}

/**
 * Checks where an address the user typed really leads before sshs3 calls it
 * (a notification, a page fetched into the knowledge base), and fixes the IP
 * address so that what was checked is what is used. On a shared server a user
 * must not be able to make the server call its own loopback, the cloud
 * metadata address, or (unless allowed) the private network around it.
 */
export async function guardUrl(raw: string, options: GuardOptions): Promise<GuardedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That is not an address. It should look like https://…");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https addresses can be used.");
  if (url.username || url.password) throw new Error("Put the token in its own field, not in the address.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const found = net.isIP(host)
    ? [{ address: host, family: net.isIPv6(host) ? 6 : 4 }]
    : await (options.lookup ?? ((h: string) => dns.lookup(h, { all: true })))(host).catch(() => {
        throw new Error(`${host} could not be found.`);
      });
  if (!found.length) throw new Error(`${host} could not be found.`);
  for (const { address } of found) {
    const kind = addressClass(address);
    if (kind === "never" || kind === "link-local") throw new Error(`${host} leads to an address that sshs3 never calls (${address}).`);
    if (kind === "loopback" && options.server) throw new Error("A shared server does not call itself.");
    if (kind === "private" && options.server && !options.allowPrivate)
      throw new Error(`${host} is on the server's private network. The administrator allows that with SSHS3_ALLOW_PRIVATE_ADDRESSES=1.`);
    if (kind === "public" && url.protocol !== "https:" && !options.allowPlainHttp) throw new Error("An address on the internet has to be https.");
  }
  return { url, address: found[0].address, family: found[0].family };
}

/**
 * Returns only the single validated address so Node 24 autoSelectFamily ({ all: true }) cannot pick an unpinned IP or receive a string instead of an array.
 * Exported for the WebSocket client, which opens its connection the same way.
 */
export function pinnedLookup(target: GuardedTarget): NonNullable<http.RequestOptions["lookup"]> {
  return (_host, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    const wantsAll = typeof options === "object" && options !== null && Boolean(options.all);
    if (wantsAll) {
      (cb as (e: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void)(
        null,
        [{ address: target.address, family: target.family }],
      );
    } else {
      (cb as (e: NodeJS.ErrnoException | null, address: string, family: number) => void)(
        null,
        target.address,
        target.family,
      );
    }
  };
}

/** Posts to the checked address. Redirects are not followed and the answer's body is never passed on. */
export function post(target: GuardedTarget, request: OutgoingRequest, timeoutMs = 8000): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(request.url);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: { ...request.headers, "Content-Length": Buffer.byteLength(request.body), "User-Agent": "sshs3-notifier" },
        timeout: timeoutMs,
        // The address that was checked, not whatever the name resolves to now.
        lookup: pinnedLookup(target),
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("timeout", () => req.destroy(new Error("No answer in time")));
    req.on("error", reject);
    req.end(request.body);
  });
}

/**
 * Fetches from the checked address. A redirect is returned to the caller, who
 * checks where it leads before following it. Stops reading at `maxBytes`.
 */
export function get(
  target: GuardedTarget,
  headers: Record<string, string>,
  maxBytes: number,
  timeoutMs = 25_000,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: Buffer }> {
  return new Promise((resolve, reject) => {
    const url = target.url;
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        timeout: timeoutMs,
        lookup: pinnedLookup(target),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) return void req.destroy(new Error("The page is too large."));
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, data: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("No answer in time")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * A request with a body and an answer that is read, to the checked address:
 * for a service sshs3 talks with (an issue tracker, a wiki), not only posts
 * to. Redirects are not followed; the answer is cut off at `maxBytes`.
 */
export function request(
  target: GuardedTarget,
  options: { method: string; headers: Record<string, string>; body?: string },
  maxBytes = 4 * 1024 * 1024,
  timeoutMs = 25_000,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const url = target.url;
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers: {
          ...options.headers,
          ...(options.body !== undefined ? { "Content-Length": Buffer.byteLength(options.body) } : {}),
          "User-Agent": "sshs3",
        },
        timeout: timeoutMs,
        lookup: pinnedLookup(target),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) return void req.destroy(new Error("The answer is too large."));
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("No answer in time")));
    req.on("error", reject);
    req.end(options.body);
  });
}

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Sends, and tries again twice when the other side is down or busy. A refusal (4xx) is not retried. */
export async function deliver(
  request: OutgoingRequest,
  guard: GuardOptions,
  options: { waits?: number[]; send?: typeof post; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DeliveryResult> {
  const waits = options.waits ?? [1500, 6000];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let target: GuardedTarget;
  try {
    target = await guardUrl(request.url, guard);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  let last: DeliveryResult = { ok: false, error: "Not sent" };
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    try {
      const status = await (options.send ?? post)(target, request);
      if (status >= 200 && status < 300) return { ok: true, status };
      last = { ok: false, status, error: `The channel answered ${status}` };
      if (status < 500 && status !== 429) return last;
    } catch (error) {
      last = { ok: false, error: clip(error instanceof Error ? error.message : String(error), 200) };
    }
    if (attempt < waits.length) await sleep(waits[attempt]);
  }
  return last;
}

/** Only the host of an address is ever shown: the rest is the secret. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
