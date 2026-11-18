import crypto from "node:crypto";
import { Notification } from "electron";
import type { HubReply, HubSnapshot, NotifyEventKind } from "../../../../shared/types/aiHub";
import { inboxItems, type InboxFilterOptions, type InboxItem } from "../../../../shared/aiHubInbox";
import {
  NOTIFY_KINDS,
  channelWants,
  deliver,
  diffInbox,
  evaluateFlapCooldown,
  evaluateNoiseBudget,
  guardUrl,
  hostOf,
  renderNotification,
  type NotifyChannel,
  type NotifyItem,
} from "../Notifier";
import { isDemoMode } from "../demoWorkspace";
import { clip, safeError } from "../privacy";
import { live } from "../WorkBoard";
import { requiredText, integer } from "../hubHelpers";
import { worksOnItsOwn } from "../DirectAgentRuntime";
import { log } from "../hubShared";
import type { HubService } from "../HubService";
import type { Handled, RequestsOf } from "./routes";

/**
 * The inbox and what is sent out of it.
 *
 * What waits for a person (inboxNow), the notification channels and their settings, and the telling
 * itself: a channel is told once when something starts to wait, and reminded once about an approval
 * nobody answered. Also this computer's own notification.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
export class InboxPart {
  publicUrl(this: HubService): string {
    return (process.env.SSHS3_PUBLIC_URL?.trim() || this.notifyStore.data.publicUrl || "").replace(/\/+$/, "");
  }

  inboxLink(this: HubService, itemId?: string): string | undefined {
    const base = this.publicUrl();
    return base ? `${base}/?view=Inbox${itemId ? `&item=${encodeURIComponent(itemId)}` : ""}` : undefined;
  }

  notificationsView(this: HubService): NonNullable<HubSnapshot["notifications"]> {
    const quiet = this.notifyStore.data.quietHours;
    const hhmm = (h: number, m = 0): string => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    // What the settings card reads back (it is not in the shared type yet): quiet hours as it sends them.
    const policy = {
      ...(quiet
        ? {
            quietHours: {
              enabled: quiet.enabled,
              start: hhmm(quiet.startHour, quiet.startMinute),
              end: hhmm(quiet.endHour, quiet.endMinute),
              timezone: quiet.timezone ?? "UTC",
              bypassCritical: quiet.allowCritical !== false,
            },
          }
        : {}),
      ...(this.notifyStore.data.noiseBudgetPerHour ? { noiseBudgetPerHour: this.notifyStore.data.noiseBudgetPerHour } : {}),
    };
    return {
      ...policy,
      channels: this.notifyStore.data.channels.map((c) => ({
        id: c.id,
        kind: c.kind,
        name: c.name,
        host: hostOf(c.url),
        hasSecret: Boolean(c.secret),
        enabled: c.enabled,
        events: c.events.filter((e): e is NotifyEventKind => e !== "knowledge"),
        includeCommand: c.includeCommand,
        alertMinSeverity: c.alertMinSeverity,
        last: c.last,
      })),
      publicUrl: this.publicUrl(),
      publicUrlFixed: Boolean(process.env.SSHS3_PUBLIC_URL?.trim()),
      reminderMinutes: this.notifyStore.data.reminderMinutes,
    };
  }

  /** What waits for a person right now, from the store itself: no snapshot is built for this. */
  inboxNow(this: HubService, options?: InboxFilterOptions): InboxItem[] {
    return inboxItems({
      tasks: this.store.data.tasks,
      workTickets: live(this.store.data.workTickets),
      dailyReport: this.store.data.dailyReport,
      // Other members' changes that need a second person and that this member may answer.
      ...(this.host.peerWaiting ? { peerApprovals: this.host.peerWaiting() } : {}),
      // A snoozed item is out of the inbox until its time: nobody is told about it, or reminded.
      inboxState: this.storeDataExtra().inboxState,
      serverFacts: {
        // Only servers this installation still has and has not left alone: a deleted or excluded server reports nothing.
        servers: this.factsStore
          .all()
          .filter((r) => this.getKnownServers().some((s) => s.id === r.serverId) && !this.factsSettings().exclude.includes(r.serverId))
          .map((r) => ({ serverId: r.serverId, name: r.name, status: r.status, collectedAt: r.collectedAt, problems: this.factsProblems(r), changes: [] })),
      },
    }, options).filter((item) => item.kind === "peer" || NOTIFY_KINDS.includes(item.kind));
  }

  /**
   * A snooze or an acknowledgement is about one item: once the item has left the inbox it is forgotten,
   * so the list does not grow for ever and an item that comes back is news again. Knowledge-base items
   * are not built here; theirs are kept for a month.
   */
  pruneInboxState(this: HubService, now = Date.now()): void {
    const extra = this.storeDataExtra();
    const state = extra.inboxState;
    if (!state || !Object.keys(state).length) return;
    const present = new Set(this.inboxNow({ snoozeFilter: "all", now }).map((i) => i.id));
    const kept = Object.entries(state).filter(
      ([id, s]) =>
        present.has(id) ||
        (id.startsWith("knowledge:") && Math.max(s.snoozedUntil ?? 0, (s.acknowledgedAt ?? 0) + 30 * 86_400_000) > now),
    );
    if (kept.length !== Object.keys(state).length) extra.inboxState = Object.fromEntries(kept);
  }

  /** Something changed: look at the inbox shortly. Cheap, because every change in the hub comes through here. */
  pokeInbox(this: HubService): void {
    this.inboxDirty = true;
    if (this.inboxTimer || this.disposed || !this.initialized) return;
    this.inboxTimer = setTimeout(() => {
      this.inboxTimer = undefined;
      void this.flushInbox().catch((e) => log.warn("Notifications failed", safeError(e)));
    }, 3000);
    this.inboxTimer.unref?.();
  }

  /** The item with what a person needs to decide, from the run it belongs to. */
  notifyItem(this: HubService, item: InboxItem): NotifyItem {
    const task = item.taskId ? this.store.data.tasks.find((t) => t.id === item.taskId) : undefined;
    const change = item.changeId ? task?.changes.find((c) => c.id === item.changeId) : undefined;
    // A teammate's plan is said to be one: it is read whole before it is answered.
    const peerPlan =
      item.kind === "peer" && this.host.peerWaiting?.().some((p) => p.ownerId === item.ownerId && p.changeId === item.changeId && p.plan);
    return {
      id: item.id,
      kind: item.kind,
      ...(peerPlan ? { headline: "A teammate's plan needs a second person" } : {}),
      title: item.title,
      detail: item.detail,
      from: item.kind === "approval" ? task?.agentName || "Assistant" : item.from,
      target: item.target,
      risk: item.risk,
      reason: change?.riskReason,
      // A teammate's change is not in this member's own conversations: the item carries its command.
      command: change?.command ?? (item.kind === "peer" ? (item.detail ?? item.title) : undefined),
      check: change?.check?.command,
      rollback: change?.rollback?.command,
      // What is left of the wait, not the whole of it: a reminder comes when part of it has gone.
      waitsMinutes:
        item.kind === "approval" && this.approvalWaitMinutes() > 0
          ? Math.max(1, Math.round(this.approvalWaitMinutes() - (Date.now() - (item.since ?? item.at)) / 60_000))
          : undefined,
      link: this.inboxLink(item.id),
    };
  }

  /**
   * Tells the channels about what is new in the inbox, and reminds once about
   * an approval nobody answered. What blocks a running agent also gives a
   * desktop notification, which until now nothing did.
   */
  async flushInbox(this: HubService, now = Date.now()): Promise<void> {
    if (this.flushingInbox || this.disposed || isDemoMode()) return;
    this.flushingInbox = true;
    this.inboxDirty = false;
    let out: NotifyItem[];
    let since: Map<string, number>;
    try {
      const data = this.notifyStore.data;
      const items = this.inboxNow();
      const before = JSON.stringify([data.seen, data.reminded, data.flapCooldown, data.pushHistory]);
      this.pruneInboxState(now);
      const { fresh: arrived, seen } = diffInbox(items, data.seen, now);
      data.seen = seen;
      // An alert that keeps resolving and firing again is told about until it flaps, then quiet for a while.
      let flaps = data.flapCooldown ?? {};
      const fresh = arrived.filter((i) => {
        if (i.acknowledgedAt !== undefined) return false;
        if (i.kind !== "alert" && i.kind !== "health") return true;
        const verdict = evaluateFlapCooldown(i.id, flaps, now, {
          ...(data.flapCooldownMs ? { cooldownMs: data.flapCooldownMs } : {}),
          severity: i.risk,
          allowCriticalBypass: true,
        });
        flaps = verdict.nextState;
        return verdict.allow;
      });
      data.flapCooldown = flaps;
      // A reminder comes before the agent stops waiting, or it would never come: at most a minute before the end.
      const wait = this.approvalWaitMinutes();
      const remindAfter = (wait > 0 ? Math.min(data.reminderMinutes, Math.max(1, wait - 1)) : data.reminderMinutes) * 60_000;
      const reminders =
        remindAfter > 0
          ? items.filter(
              (i) =>
                i.kind === "approval" &&
                !arrived.includes(i) &&
                // Acknowledged in the inbox: somebody has it, nobody is reminded.
                i.acknowledgedAt === undefined &&
                !data.reminded[i.id] &&
                now - (i.since ?? i.at) >= remindAfter,
            )
          : [];
      data.reminded = Object.fromEntries(Object.entries(data.reminded).filter(([id]) => seen[id] !== undefined));
      for (const item of reminders) data.reminded[item.id] = now;
      data.flapCooldown = Object.fromEntries(
        Object.entries(data.flapCooldown).filter(([, v]) => (v.suppressedUntil ?? 0) > now || now - v.lastAt <= 3_600_000),
      );
      const blocking = fresh.filter((i) => ["approval", "peer", "plan", "question"].includes(i.kind));
      if (blocking.length) {
        const first = blocking[0];
        const run = first.taskId && first.kind !== "peer" ? this.store.data.tasks.find((t) => t.id === first.taskId) : undefined;
        // The command itself, not only what the agent called it: on this computer's own screen, for the person to decide on.
        const command = first.kind === "approval" ? run?.changes.find((c) => c.id === first.changeId)?.command : first.kind === "peer" ? first.detail : undefined;
        this.notify(
          blocking.length === 1
            ? first.kind === "approval"
              ? run && worksOnItsOwn(run)
                ? "A run nobody is watching waits for your approval"
                : "Approval needed"
              : first.kind === "peer"
                ? "A teammate's change needs a second person"
                : "An agent is waiting for you"
            : `${blocking.length} things are waiting for you`,
          `${first.from ?? "Assistant"}: ${command && command !== first.title ? `${command} (${first.title})` : first.title}`,
        );
      }
      out = [...fresh.map((i) => this.notifyItem(i)), ...reminders.map((i) => ({ ...this.notifyItem(i), reminder: true }))];
      // Quiet hours and the hourly limit hold back what goes to the channels (a critical alert still goes);
      // what is held back stays in the inbox. This computer's own notification above is not held back.
      if (out.length && (data.quietHours?.enabled || (data.noiseBudgetPerHour ?? 0) > 0)) {
        const budget = evaluateNoiseBudget(out, data.pushHistory ?? [], now, {
          maxPushesPerHour: data.noiseBudgetPerHour,
          quietHours: data.quietHours,
        });
        out = budget.allowed;
        data.pushHistory = budget.nextPushHistory;
      }
      since = new Map(items.map((i) => [i.id, i.since ?? i.at]));
      if (before !== JSON.stringify([data.seen, data.reminded, data.flapCooldown, data.pushHistory])) await this.notifyStore.save();
    } finally {
      // Released before anything is sent: a channel that does not answer must not hold up what comes next.
      this.flushingInbox = false;
    }
    if (out.length) {
      await this.sendToChannels(out, since);
      await this.notifyStore.save();
    }
    if (this.inboxDirty) this.pokeInbox();
  }

  async sendToChannels(this: HubService, items: NotifyItem[], since: Map<string, number>): Promise<void> {
    const channels = this.notifyStore.data.channels.filter((c) => c.enabled);
    if (!channels.length) return;
    // On a shared server only the person whose installation this is can answer: the message says who.
    const owner = this.host.alertHookOwner ? await this.resolveActorName() : undefined;
    const sync = this.work();
    const client = this.clientId();
    const hash = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");
    await Promise.all(
      channels.map(async (channel) => {
        let mine = items.filter((item) => channelWants(channel, item));
        if (sync) {
          // A ticket is on every installation that shares the bucket: one of them tells the channel.
          const kept: NotifyItem[] = [];
          for (const item of mine) {
            const shared = ["review", "blocked", "alert", "health"].includes(item.kind);
            if (
              !shared ||
              (await sync
                .markOnce(hash(`${item.id}|${since.get(item.id) ?? 0}|${hash(channel.url).slice(0, 16)}`), client, this.notifySettle)
                .catch(() => true))
            )
              kept.push(item);
          }
          mine = kept;
        }
        if (!mine.length) return;
        const result = await deliver(renderNotification(channel, mine, { owner, inboxLink: this.inboxLink() }), this.outboundGuard(), {
          waits: this.notifyWaits,
        });
        channel.last = { at: Date.now(), ...result };
        if (!result.ok) log.warn("A notification was not delivered", `${channel.name}: ${result.error ?? result.status}`);
      }),
    );
    this.host.changed();
  }

  notify(this: HubService, title: string, body: string): void {
    // Absent where there is no desktop to notify (the web server's Electron stand-in).
    if (Notification?.isSupported?.()) {
      const notification = new Notification({
        title: `sshs3 · ${title}`,
        body: clip(body, 160),
      });
      notification.on("click", this.host.show);
      notification.show();
    }
  }
  /** The requests this part answers. What a case leaves in `reply` goes back with the snapshot. */
  async handleInbox(this: HubService, request: RequestsOf<"inbox">): Promise<Handled> {
    let reply: HubReply | undefined;
    switch (request.action) {
      case "notify-channel-save": {
        const input = request.channel;
        const channels = this.notifyStore.data.channels;
        const existing = input.id ? channels.find((c) => c.id === input.id) : undefined;
        if (input.id && !existing) throw new Error("Channel not found");
        if (!["slack", "teams", "ntfy", "webhook"].includes(input.kind)) throw new Error("Unknown kind of channel");
        const url = (input.url ?? "").trim() || existing?.url || "";
        if (!url) throw new Error("The channel needs an address to post to");
        // Checked now so a wrong address is said at once, and again each time something is sent.
        const target = await guardUrl(url, this.outboundGuard());
        if (input.kind === "ntfy" && !target.url.pathname.split("/").filter(Boolean).length)
          throw new Error("An ntfy address ends with the topic, like https://ntfy.sh/my-topic");
        const events = (input.events ?? []).filter((e) => NOTIFY_KINDS.includes(e));
        const saved: NotifyChannel = {
          id: existing?.id ?? crypto.randomUUID(),
          kind: input.kind,
          name: requiredText(input.name).slice(0, 80),
          url,
          // undefined keeps what is there; an empty text removes it.
          secret: input.secret === undefined ? existing?.secret : input.secret.trim() || undefined,
          enabled: input.enabled !== false,
          events: events.length ? events : ["approval", "plan", "question", "blocked", "alert"],
          includeCommand: input.includeCommand !== false,
          alertMinSeverity: ["info", "warning", "critical"].includes(input.alertMinSeverity ?? "") ? input.alertMinSeverity : undefined,
          last: existing?.url === url ? existing?.last : undefined,
        };
        this.notifyStore.data.channels = [...channels.filter((c) => c.id !== saved.id), saved];
        // What already waits is not news to a channel that was just added.
        for (const item of this.inboxNow()) this.notifyStore.data.seen[item.id] ??= Date.now();
        await this.notifyStore.save();
        break;
      }
      case "notify-channel-delete":
        this.notifyStore.data.channels = this.notifyStore.data.channels.filter((c) => c.id !== request.id);
        await this.notifyStore.save();
        break;
      case "notify-channel-test": {
        const channel = this.notifyStore.data.channels.find((c) => c.id === request.id);
        if (!channel) throw new Error("Channel not found");
        const link = this.inboxLink();
        const result = await deliver(
          renderNotification(
            channel,
            [{ id: "test", kind: "report", headline: "A test from sshs3", title: "If you can read this, the channel works.", link }],
            { inboxLink: link },
          ),
          this.outboundGuard(),
          { waits: [] },
        );
        channel.last = { at: Date.now(), ...result };
        await this.notifyStore.save();
        reply = { notifyTest: result };
        break;
      }
      case "notify-settings-save": {
        if (request.publicUrl !== undefined && !process.env.SSHS3_PUBLIC_URL) {
          const raw = request.publicUrl.trim();
          if (raw) {
            let parsed: URL;
            try {
              parsed = new URL(raw);
            } catch {
              throw new Error("That is not an address. It should look like https://sshs3.example.com");
            }
            if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
              throw new Error("The address has to be http or https, without a user name in it");
            this.notifyStore.data.publicUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
          } else this.notifyStore.data.publicUrl = "";
        }
        if (request.reminderMinutes !== undefined) this.notifyStore.data.reminderMinutes = integer(request.reminderMinutes, 0, 60);
        // Quiet hours as the settings card sends them: "22:00" to "07:00" in a named time zone.
        const policy = request as { quietHours?: unknown; noiseBudgetPerHour?: unknown };
        if (policy.quietHours !== undefined) {
          const q = policy.quietHours as { enabled?: unknown; start?: unknown; end?: unknown; timezone?: unknown; bypassCritical?: unknown } | null;
          const time = (v: unknown): [number, number] | undefined => {
            const m = typeof v === "string" ? /^(\d{1,2}):(\d{2})$/.exec(v.trim()) : null;
            return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? [Number(m[1]), Number(m[2])] : undefined;
          };
          if (!q || typeof q !== "object" || !q.enabled) {
            delete this.notifyStore.data.quietHours;
          } else {
            const start = time(q.start);
            const end = time(q.end);
            if (!start || !end) throw new Error('Quiet hours are a start and an end time, like "22:00" and "07:00".');
            const timezone = typeof q.timezone === "string" && q.timezone.trim() ? q.timezone.trim().slice(0, 64) : "UTC";
            try {
              new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
            } catch {
              throw new Error(`"${timezone}" is not a time zone this computer knows.`);
            }
            this.notifyStore.data.quietHours = {
              enabled: true,
              startHour: start[0],
              startMinute: start[1],
              endHour: end[0],
              endMinute: end[1],
              timezone,
              allowCritical: q.bypassCritical !== false,
            };
          }
        }
        if (policy.noiseBudgetPerHour !== undefined)
          this.notifyStore.data.noiseBudgetPerHour = integer(policy.noiseBudgetPerHour as number, 0, 1000);
        await this.notifyStore.save();
        break;
      }
      case "snooze-inbox": {
        const itemId = requiredText(request.itemId);
        const now = Date.now();
        const durationMin = request.durationMinutes !== undefined
          ? integer(request.durationMinutes, 1, 7 * 24 * 60)
          : 60;
        const snoozedUntil =
          typeof request.until === "number" && Number.isFinite(request.until)
            ? request.until
            : now + durationMin * 60_000;
        const extra = this.storeDataExtra();
        const prev = extra.inboxState ?? {};
        extra.inboxState = {
          ...prev,
          [itemId]: { ...prev[itemId], snoozedUntil },
        };
        break;
      }
      case "ack-inbox": {
        const itemId = requiredText(request.itemId);
        const extra = this.storeDataExtra();
        const prev = extra.inboxState ?? {};
        const entry = { ...prev[itemId] };
        if (request.acknowledged === false) {
          delete entry.acknowledgedAt;
        } else {
          entry.acknowledgedAt = Date.now();
        }
        if (entry.snoozedUntil === undefined && entry.acknowledgedAt === undefined) {
          const next = { ...prev };
          delete next[itemId];
          extra.inboxState = next;
        } else {
          extra.inboxState = { ...prev, [itemId]: entry };
        }
        break;
      }
      default: {
        // Every request of this part has a case above: one that is given to it and not handled does not compile.
        const unhandled: never = request;
        throw new Error(`Unknown AI request: ${String((unhandled as { action?: unknown })?.action)}`);
      }
    }
    return reply ? { reply } : {};
  }
}
