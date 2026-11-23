import type { HubReply } from "../../../../shared/types/aiHub";
import { searchPages } from "../KbCompile";
import {
  alertTarget,
  alertName,
  alertTicketText,
  appendCorrelatedAlert,
  correlateAlert,
  hookSecretMatches,
  newHookSecret,
  parseAlerts,
  parsePastedAlert,
  routeAlert,
  type IncomingAlert,
} from "../AlertIntake";
import { boundedContext, clip } from "../privacy";
import { withComment, live } from "../WorkBoard";
import { requiredText } from "../hubHelpers";
import type { HubService } from "../HubService";
import type { Handled, RequestsOf } from "./routes";

/**
 * Alerts in.
 *
 * An alert from a monitoring system becomes a ticket for the agent it is routed to; the same alert
 * firing again is counted on its ticket, and a resolve is noted. Also the address alerts are posted to
 * and the routing rules.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
export class AlertsPart {
  // ---- alerts in -----------------------------------------------------------

  /**
   * A posted alert, from the web server. Returns undefined when the secret is
   * wrong or alerts are off: the caller answers as if nothing were there.
   */
  async receiveAlert(this: HubService,
    secret: string,
    body: unknown,
  ): Promise<{ created: string[]; updated: string[] } | undefined> {
    await this.initialize();
    const hook = this.store.data.alertHook;
    if (!hook || !hookSecretMatches(secret, hook.hash)) return undefined;
    const alerts = parseAlerts(body);
    if (alerts.length > 0) {
      hook.lastAt = Date.now();
      hook.received += alerts.length;
    }
    const result = await this.takeAlerts(alerts);
    await this.store.save().catch(() => undefined);
    this.changed();
    return result;
  }

  /**
   * The page for an alert: one a run on an earlier ticket for the same alert
   * worked from, else the troubleshooting page that best matches its words.
   * The ticket names it, so the agent opens it instead of starting from nothing.
   */
  pagesForAlert(this: HubService, alert: IncomingAlert, target?: string): { id: string; title: string; known: boolean }[] {
    const pages = this.pagesWithUse();
    const name = alertName(alert).toLowerCase();
    const bound = pages.filter((p) => (p.alerts ?? []).some((a) => a.toLowerCase() === name));
    if (bound.length)
      return bound
        .sort((a, b) => (b.proven ?? 0) - (a.proven ?? 0))
        .slice(0, 2)
        .map((p) => ({ id: p.id, title: p.title, known: true }));
    return searchPages(
      pages.filter((p) => p.kind === "troubleshooting"),
      `${alert.title} ${target ?? ""}`,
      1,
    ).map((h) => ({ id: h.page.id, title: h.page.title, known: false }));
  }

  /**
   * Alerts become tickets. The same alert firing again raises the count on
   * its open ticket instead of making another; a resolved one is noted. A
   * closed ticket is not reopened: the alert firing again later is new work.
   */
  takeAlerts(this: HubService, alerts: IncomingAlert[]): Promise<{ created: string[]; updated: string[] }> {
    // One post at a time: two posts of one alert that arrive together (a retry, two hooks) would each
    // look for its open ticket before the other had made it, and make two.
    const run = this.alertIntake.then(() => this.takeAlertsNow(alerts));
    this.alertIntake = run.catch(() => undefined);
    return run;
  }

  async takeAlertsNow(this: HubService, alerts: IncomingAlert[]): Promise<{ created: string[]; updated: string[] }> {
    const servers = (await this.collectExtraContext()).workspaceServers ?? [];
    const agents = this.getAgentsList();
    const created: string[] = [];
    const updated: string[] = [];
    const now = Date.now();
    const affected = new Set<string>();
    const noteFiring = (alert: IncomingAlert): void => {
      const target = alertTarget(alert, servers);
      if (target) for (const server of servers) if (server.name === target || server.id === target || server.cluster === target) affected.add(server.id);
    };
    for (const alert of alerts.slice(0, 50)) {
      const open = live(this.store.data.workTickets).find(
        (t) => t.alert?.fingerprint === alert.fingerprint && t.status !== "done",
      );
      if (open) {
        const was = open.alert!;
        // What this post is: over, a new firing (after it had resolved, or with a new start), or only the
        // same firing sent again (Alertmanager re-sends a whole group on every change and every repeat
        // interval; PagerDuty sends acknowledgements and notes). Only the first two are news.
        const resolved = alert.status === "resolved";
        const refired =
          !resolved &&
          !alert.update &&
          (Boolean(was.resolvedAt) || (alert.startsAt !== undefined && was.startsAt !== undefined && alert.startsAt !== was.startsAt));
        if (refired) noteFiring(alert);
        const note = resolved
          ? was.resolvedAt
            ? undefined
            : `${alert.source} says this has resolved.`
          : refired
            ? `Fired again${was.resolvedAt ? " after it had resolved" : ""} (${was.count + 1} times).`
            : undefined;
        const alertNow = {
          ...was,
          lastAt: now,
          count: was.count + (refired ? 1 : 0),
          resolvedAt: resolved ? (was.resolvedAt ?? now) : refired || !was.resolvedAt ? undefined : was.resolvedAt,
          ...(refired && was.resolvedAt ? { firingSince: now } : {}),
          ...(alert.startsAt ? { startsAt: alert.startsAt } : {}),
        };
        // Over before anybody started on it: out of the heartbeat's way, and back when it fires again.
        const park = resolved && !was.resolvedAt && open.status === "todo";
        const unpark = refired && was.parked === true && open.status === "backlog";
        const text = park ? `${note} Moved to Backlog: nothing is firing. Move it back if it should still be looked at.` : note;
        this.putTicket({
          ...(text ? withComment(open, alert.source, text, now) : { ...open, updatedAt: now }),
          ...(park ? { status: "backlog" as const } : unpark ? { status: "todo" as const } : {}),
          alert: { ...alertNow, parked: park ? true : unpark || !resolved ? undefined : was.parked },
        });
        updated.push(open.id);
        continue;
      }
      // An alert that is already over when it arrives is nothing to work on.
      if (alert.status === "resolved") continue;
      // A symptom of an incident already open (the same server, its cluster, or what it depends on,
      // within ten minutes) goes on that incident's ticket instead of opening another.
      // One already put on an incident is the same alert sent again: noted there, without another comment.
      const bundled = live(this.store.data.workTickets).find(
        (t) => t.status !== "done" && t.alert && t.correlatedAlerts?.some((c) => c.fingerprint === alert.fingerprint),
      );
      const related = bundled
        ? undefined
        : correlateAlert(alert, live(this.store.data.workTickets), {
            servers,
            edges: this.getInfraEdgesList(),
            now,
          });
      if (bundled) {
        // The reason it was bundled for the first time, as its line says.
        const reason = (/\[([a-z-]+)\]$/.exec(bundled.correlatedAlerts?.find((c) => c.fingerprint === alert.fingerprint)?.summary ?? "")?.[1] ??
          "same-target") as Parameters<typeof appendCorrelatedAlert>[2];
        this.putTicket(appendCorrelatedAlert(bundled, alert, reason, now));
        updated.push(bundled.id);
        continue;
      }
      noteFiring(alert);
      if (related && related.reason !== "fingerprint") {
        this.putTicket(
          withComment(
            appendCorrelatedAlert(related.ticket, alert, related.reason, now),
            alert.source,
            `Related alert${related.via ? ` (${related.via})` : ""}: ${clip(alert.title, 200)}`,
            now,
          ),
        );
        updated.push(related.ticket.id);
        continue;
      }
      const target = alertTarget(alert, servers);
      const agent = routeAlert(alert, target, this.store.data.alertRules ?? [], agents, servers);
      const pages = this.pagesForAlert(alert, target);
      const ticket = await this.saveTicketFrom(
        {
          title: clip(`${alert.severity === "critical" ? "Alert (critical)" : "Alert"}: ${alert.title}`, 200),
          description: alertTicketText(alert, this.changesOn(target, 24 * 3_600_000), pages),
          assigneeAgentId: agent?.id,
          target,
          outside: `an alert from ${alert.source}`,
        },
        alert.source,
      );
      // What the team said about this server or this alert lately, when a bot reads their chat here.
      const said = this.chat.active() ? this.chatAbout([target, alertName(alert)], now) : undefined;
      this.putTicket({
        ...ticket,
        ...(pages.length ? { kbPages: pages } : {}),
        alert: {
          fingerprint: alert.fingerprint,
          name: clip(alertName(alert), 160),
          source: alert.source,
          severity: alert.severity,
          firstAt: now,
          lastAt: now,
          count: 1,
          ...(alert.startsAt ? { startsAt: alert.startsAt } : {}),
        },
        ...(said ? { chatLookedAt: now } : {}),
        ...(said?.length ? { chatRefs: said } : {}),
      });
      created.push(ticket.id);
    }
    if (affected.size) await this.scheduleEvent("alert", [...affected]);
    if (created.length) this.notify("New alert", `${created.length} ticket${created.length === 1 ? "" : "s"} on the board`);
    return { created, updated };
  }
  /** The requests this part answers. What a case leaves in `reply` goes back with the snapshot. */
  async handleAlerts(this: HubService, request: RequestsOf<"alerts">): Promise<Handled> {
    let reply: HubReply | undefined;
    switch (request.action) {
      case "alert-hook-create": {
        const { secret, hash } = newHookSecret();
        this.store.data.alertHook = { hash, createdAt: Date.now(), received: 0 };
        // Shown this once. On the web server the address names the user; the desktop app has no address to post to.
        reply = {
          alertHook: { path: this.host.alertHookOwner ? `/api/hooks/${this.host.alertHookOwner}.${secret}` : "" },
        };
        break;
      }
      case "alert-hook-disable": {
        const hadHook = Boolean(this.store.data.alertHook);
        delete this.store.data.alertHook;
        reply = {
          notes: [
            hadHook
              ? "Alert webhook turned off. The previous webhook URL no longer works."
              : "Alert webhook was already turned off.",
          ],
        };
        break;
      }
      case "alert-rules-save": {
        const asked = (request.rules ?? []).map((r) => ({
          match: boundedContext(String(r.match ?? "").trim(), 80),
          agentId: String(r.agentId ?? "").trim(),
        }));
        const known = (r: { agentId: string }): boolean => this.getAgentsList().some((a) => a.id === r.agentId);
        const kept = asked.filter((r) => r.match && known(r));
        this.store.data.alertRules = kept.slice(0, 40);
        const notes: string[] = [];
        const unselected = asked.filter((r) => r.match && !r.agentId);
        if (unselected.length) {
          notes.push(
            unselected.length === 1
              ? `Not saved: choose an agent for rule "${unselected[0].match}".`
              : `Not saved: choose an agent for ${unselected.map((r) => `rule "${r.match}"`).join(", ")}.`,
          );
        }
        const unknownAgent = asked.filter((r) => r.match && r.agentId && !known(r));
        if (unknownAgent.length) {
          notes.push(
            unknownAgent.length === 1
              ? `Not saved, because the agent "${unknownAgent[0].agentId}" does not exist (rule "${unknownAgent[0].match}").`
              : `Not saved, because these agents do not exist: ${unknownAgent.map((r) => `"${r.agentId}" (rule "${r.match}")`).join(", ")}.`,
          );
        }
        const empty = asked.filter((r) => !r.match).length;
        if (empty) notes.push(`${empty} rule${empty === 1 ? "" : "s"} with no text to match ${empty === 1 ? "was" : "were"} left out.`);
        if (kept.length > 40) notes.push("Only the first 40 rules were saved.");
        if (notes.length) reply = { notes };
        break;
      }
      case "alert-paste": {
        const alerts = parsePastedAlert(requiredText(request.text));
        if (alerts.length === 0) throw new Error("No alert could be made of that.");
        reply = { alerts: await this.takeAlerts(alerts) };
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
