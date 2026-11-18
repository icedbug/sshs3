import crypto from "node:crypto";
import type {
  HubReply,
  HubSnapshot,
  WorkspaceServerSummary,
  FactProblem,
  ServerFacts,
  ServerFactsView,
} from "../../../../shared/types/aiHub";
import { simFactsOutput } from "../../../sim/facts";
import { simWorld } from "../../../sim/SimWorld";
import { flagStaleMemories, type FactsRecord } from "../FactsStore";
import { buildScript, diffFacts, factsHash, factsSummary, isWatchPath, parseFacts, problems } from "../ServerFacts";
import { demoFactsOutput } from "../demoFacts";
import { isDemoMode } from "../demoWorkspace";
import { isDemoTarget } from "../../../demo/demoMode";
import { boundedContext, clip, safeError } from "../privacy";
import { integer } from "../hubHelpers";
import { log } from "../hubShared";
import type { HubService } from "../HubService";
import type { Handled, RequestsOf } from "./routes";

/**
 * What is on the servers, and what changed.
 *
 * Facts are read from each server on a schedule (factsTick, readFacts), kept per server, compared with
 * the reading before, and shared with the team. Problems found in them (a full disk, a certificate
 * that runs out) are shown and go to the inbox.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
export class FactsPart {
  factsSettings(this: HubService): { enabled: boolean; intervalHours: number; exclude: string[]; watchPaths: string[] } {
    const s = this.store.data.factsSettings ?? {};
    return {
      enabled: s.enabled === true,
      intervalHours: integer(s.intervalHours ?? 6, 1, 168),
      exclude: s.exclude ?? [],
      watchPaths: (s.watchPaths ?? []).filter(isWatchPath),
    };
  }

  /** Problems that are there now and were not dismissed since they appeared. */
  /**
   * The problems a server's last reading shows. A server that stopped
   * answering keeps them (a full disk does not empty itself because nobody can
   * look), said as last seen; one that has not answered three times running is
   * a problem of its own; and a reading older than twice the interval says how
   * old it is.
   */
  factsProblems(this: HubService, record: FactsRecord, now = Date.now()): FactProblem[] {
    if (!record.facts) return [];
    const intervalMs = this.factsSettings().intervalHours * 3_600_000;
    const at = record.collectedAt ?? 0;
    const old = record.status !== "ok" || now - at > 2 * intervalMs;
    const when = new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const found: FactProblem[] = problems(record.facts, now)
      .filter((p) => (record.dismissed?.[p.key] ?? 0) < (record.problemsSince?.[p.key] ?? 1))
      .map((p) => ({
        ...p,
        since: record.problemsSince?.[p.key],
        ...(old ? { text: `${p.text} (last seen ${when}${record.status !== "ok" ? "; the server is not answering" : ""})` } : {}),
      }));
    if (record.status === "failed" && (record.failures ?? 0) >= 3)
      found.push({
        kind: "unreachable",
        key: "unreachable",
        severity: "warning",
        text: `Could not be read ${record.failures} times running${record.error ? `: ${clip(record.error, 120)}` : ""}`,
        since: at,
      });
    return found;
  }

  factsView(this: HubService): NonNullable<HubSnapshot["serverFacts"]> {
    const settings = this.factsSettings();
    const servers = this.getKnownServers().map((server): ServerFactsView => {
      const record = this.factsStore.get(server.id);
      const demo = record?.via === "demo" || isDemoTarget(server.id);
      if (!record) {
        return {
          serverId: server.id,
          name: server.name,
          status: "never",
          ...(demo ? { demo: true } : {}),
          problems: [],
          changes: [],
        };
      }
      const summary = record.facts && !record.facts.unsupported ? factsSummary(record.facts) : undefined;
      return {
        serverId: server.id,
        name: server.name,
        status: record.status,
        ...(demo ? { demo: true } : {}),
        error: record.error,
        collectedAt: record.collectedAt,
        via: record.via,
        os: summary?.os,
        kernel: summary?.kernel,
        bootAt: summary?.bootAt,
        rebootRequired: summary?.rebootRequired,
        packages: summary?.packages,
        listening: summary?.listening,
        services: summary?.services,
        disks: summary?.disks,
        problems: this.factsProblems(record),
        changes: record.changes.slice(0, 20),
      };
    });
    return { ...settings, servers, collecting: [...this.factsCollecting] };
  }

  /**
   * How each server stood when its facts were last read, in a few lines, with
   * how old that reading is: the agent knows the state it starts from, and
   * knows to look again before it acts on a reading that is hours old.
   */
  serverFactsNow(this: HubService, now = Date.now()): { name: string; cluster?: string; collectedAt: number; age: string; lines: string[] }[] {
    const clusters = new Map(this.getKnownServers().map((s) => [s.id, s.cluster]));
    const ago = (ms: number): string =>
      ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} days`;
    return this.factsStore
      .all()
      .filter((r) => r.facts && r.collectedAt)
      .map((r) => {
        const f = r.facts!;
        const lines = [
          f.os?.pretty ? `OS: ${f.os.pretty}${f.kernel ? `, kernel ${f.kernel}` : ""}` : "",
          f.rebootRequired ? "A reboot is pending" : "",
          f.failedServices.length ? `Failed services: ${f.failedServices.slice(0, 10).join(", ")}` : "",
          ...f.disks.filter((d) => d.usedPct >= 80).slice(0, 5).map((d) => `Disk ${d.mount} is ${d.usedPct}% full`),
          ...f.certs
            .filter((c) => c.notAfter - now < 30 * 86_400_000)
            .slice(0, 5)
            .map((c) => (c.notAfter < now ? `Certificate ${c.path} has expired` : `Certificate ${c.path} expires in ${Math.ceil((c.notAfter - now) / 86_400_000)} days`)),
          f.listening.length ? `Listening: ${[...new Set(f.listening.map((l) => `${l.port}/${l.proto}${l.process ? ` (${l.process})` : ""}`))].slice(0, 15).join(", ")}` : "",
        ].filter(Boolean);
        return { name: r.name, cluster: clusters.get(r.serverId), collectedAt: r.collectedAt!, age: ago(now - r.collectedAt!), lines };
      });
  }

  /** The same for one server or cluster by name: what an alert's ticket is given. */
  changesOn(this: HubService, name: string | undefined, withinMs: number, now = Date.now()): string[] {
    const wanted = (name ?? "").trim().toLowerCase();
    if (!wanted) return [];
    return this.recentServerChanges(withinMs, now)
      .filter((r) => r.name.toLowerCase() === wanted || r.cluster?.toLowerCase() === wanted)
      .flatMap((r) => r.lines)
      .sort()
      .reverse()
      .slice(0, 20);
  }

  factsDue(this: HubService, serverId: string, now: number, intervalHours: number): boolean {
    const record = this.factsStore.get(serverId);
    const head = this.factsHeads.get(serverId)?.collectedAt ?? 0;
    const last = Math.max(record?.attemptedAt ?? 0, head);
    if (!last) return true;
    // Spread over ten minutes so a fleet is not read in one burst.
    const jitter = (parseInt(crypto.createHash("sha256").update(serverId).digest("hex").slice(0, 6), 16) % 600) * 1000;
    // No answer twice in a row: once a day is enough, and does not look like someone trying passwords.
    // A system the collection does not know: once a week, in case it was replaced.
    const wait =
      record?.status === "unsupported" && head <= (record.attemptedAt ?? 0)
        ? 7 * 24 * 3_600_000
        : (record?.failures ?? 0) >= 2 && head <= (record?.attemptedAt ?? 0)
          ? 24 * 3_600_000
          : intervalHours * 3_600_000;
    return now - last >= wait + jitter;
  }

  /**
   * Takes over what another installation read since last time, so that no server is read twice.
   * True when a reading was taken over. This is the team's knowledge, not this person's schedule:
   * it runs with the board's sync whether or not readings are switched on here.
   */
  async pullSharedFacts(this: HubService): Promise<boolean> {
    if (!this.s3Workspace.canUseBucket() || isDemoMode()) return false;
    let taken = false;
    const objects = this.s3Workspace.objects;
    const names = (await objects.list("work/facts/heads")).filter((n) => n.endsWith(".json")).slice(0, 1000);
    // Only readings of servers this installation knows as shared: a teammate's personal server is not ours to see.
    const shared = new Set(this.getKnownServers().filter((s) => s.shared).map((s) => s.id));
    for (const name of names) {
      try {
        const head = JSON.parse((await objects.read(`work/facts/heads/${name}`))?.toString("utf8") ?? "null") as { serverId?: string; collectedAt?: number; hash?: string } | null;
        if (!head?.serverId || !head.collectedAt || !shared.has(head.serverId)) continue;
        this.factsHeads.set(head.serverId, { collectedAt: head.collectedAt, hash: head.hash ?? "" });
        const mine = this.factsStore.get(head.serverId);
        if ((mine?.collectedAt ?? 0) >= head.collectedAt) continue;
        const data = JSON.parse((await objects.read(`work/facts/data/${name}`))?.toString("utf8") ?? "null") as FactsRecord | null;
        // Stamped with the head's time: the data is written only when it changed, so it can be older than the reading.
        if (data?.serverId === head.serverId && data.facts) {
          await this.factsStore.put({ ...data, collectedAt: Math.max(data.collectedAt ?? 0, head.collectedAt), dismissed: mine?.dismissed, changes: data.changes ?? [] });
          taken = true;
        }
      } catch {
        // One unreadable object does not stop the rest.
      }
    }
    return taken;
  }
  /**
   * One round: every server that is due, three at a time, until none is left.
   * Rounds do not overlap; one that is asked for while another runs waits for
   * it and then reads what was asked.
   */
  async factsTick(this: HubService, now = Date.now(), asked = false): Promise<void> {
    const settings = this.factsSettings();
    if (!settings.enabled && !asked) return;
    if (this.factsRound) {
      if (!asked) return;
      await this.factsRound.catch(() => undefined);
    } else if (!asked && now - this.lastFactsTick < 5 * 60_000) return;
    this.lastFactsTick = now;
    const round = (async () => {
      await this.pullSharedFacts().catch((e) => log.warn("Reading shared server facts failed", safeError(e)));
      const due = this.getKnownServers()
        .filter((s) => !settings.exclude.includes(s.id) && (asked || this.factsDue(s.id, now, settings.intervalHours)))
        .slice(0, 500);
      for (let i = 0; i < due.length && !this.disposed; i += 3) await Promise.all(due.slice(i, i + 3).map((s) => this.collectFacts(s, now, asked)));
    })();
    this.factsRound = round;
    try {
      await round;
    } finally {
      if (this.factsRound === round) this.factsRound = undefined;
    }
  }

  /** Reads one server: runs the script, compares with last time, keeps the difference. No model is involved. */
  collectFacts(this: HubService, server: WorkspaceServerSummary, now = Date.now(), asked = false): Promise<void> {
    // A reading that is under way is the reading: whoever asks again waits for the same one.
    const running = this.factsInFlight.get(server.id);
    if (running) return running;
    const reading = this.readFacts(server, now, asked).finally(() => this.factsInFlight.delete(server.id));
    this.factsInFlight.set(server.id, reading);
    return reading;
  }

  async readFacts(this: HubService, server: WorkspaceServerSummary, now: number, asked: boolean): Promise<void> {
    this.factsCollecting.add(server.id);
    this.host.changed();
    try {
      const settings = this.factsSettings();
      const sync = isDemoMode() ? undefined : this.work();
      const client = this.clientId();
      if (sync && !asked) {
        const held = await sync.claim(`facts-${server.id}`, { by: await this.resolveActorName(), client }, now).catch(() => undefined);
        if (held && held.client !== client) return; // Another installation is reading it.
      }
      const prev = this.factsStore.get(server.id);
      const base = { serverId: server.id, name: server.name, attemptedAt: now, dismissed: prev?.dismissed };
      const demo = isDemoMode();
      const simHost = demo ? simWorld().host(server.id, server.name, server.host) : undefined;
      const certAnchorAt =
        prev?.demoCertAnchorAt ??
        (prev?.facts && prev.via === "demo" && prev.collectedAt ? prev.collectedAt : now);
      const result = demo
        ? {
            ok: true,
            // A server the lab simulates is read from its state; the others answer as a stable demo baseline.
            stdout: simHost
              ? simFactsOutput(simHost, settings.watchPaths)
              : demoFactsOutput(server, now, 0, certAnchorAt),
            via: "demo" as const,
            error: undefined,
          }
        : this.host.execOnServer
          ? await this.host
              .execOnServer(server.id, buildScript(settings.watchPaths), 60_000)
              .catch((e) => ({ ok: false, stdout: "", error: safeError(e), via: "own-connection" as const }))
          : { ok: false, stdout: "", error: "Reading servers is not available in this installation", via: "own-connection" as const };
      if (!result.ok) {
        await this.factsStore.put({
          ...(prev ?? { changes: [] }),
          ...base,
          status: "failed",
          error: boundedContext(result.error ?? "No answer", 240),
          failures: (prev?.failures ?? 0) + 1,
        });
        return;
      }
      const facts = parseFacts(result.stdout, now);
      const fresh = prev?.facts && !prev.facts.unsupported ? diffFacts(prev.facts, facts) : [];
      const present = problems(facts, now);
      const record: FactsRecord = {
        ...base,
        status: facts.unsupported ? "unsupported" : "ok",
        collectedAt: now,
        via: result.via,
        hash: factsHash(facts),
        facts,
        failures: 0,
        changes: [...fresh, ...(prev?.changes ?? [])].filter((c) => now - c.at < 30 * 24 * 3_600_000).slice(0, 200),
        problemsSince: Object.fromEntries(present.map((p) => [p.key, prev?.problemsSince?.[p.key] ?? now])),
        ...(demo && !simHost ? { demoCertAnchorAt: certAnchorAt } : {}),
      };
      await this.factsStore.put(record);
      const flaggedMemories = flagStaleMemories(this.store.data.memories, record, {
        prevFacts: prev?.facts,
        cluster: server.cluster,
      });
      if (flaggedMemories.some((m, i) => m.staleReason !== this.store.data.memories[i]?.staleReason)) {
        this.store.data.memories = flaggedMemories;
      }
      if (!facts.unsupported) this.proposeEdgesFrom(server, facts, now);
      // A personal server's reading stays on this computer: only shared servers are read for the team.
      if (sync && server.shared) {
        const objects = this.s3Workspace.objects;
        const name = `${server.id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)}.json`;
        // The whole record only when something is different; the small head every time, so others know it was read.
        if (record.hash !== prev?.hash || fresh.length)
          await objects.write(`work/facts/data/${name}`, Buffer.from(JSON.stringify({ ...record, dismissed: undefined }), "utf8")).catch(() => undefined);
        await objects
          .write(`work/facts/heads/${name}`, Buffer.from(JSON.stringify({ serverId: server.id, collectedAt: now, hash: record.hash, client }), "utf8"))
          .catch(() => undefined);
        this.factsHeads.set(server.id, { collectedAt: now, hash: record.hash ?? "" });
      }
    } finally {
      this.factsCollecting.delete(server.id);
      this.changed();
    }
  }

  /**
   * A connection this server holds to another server of the workspace is a
   * dependency somebody may want on the map. It is suggested with what was
   * seen; a person confirms it. A link that exists, or one that was removed,
   * is not suggested again.
   */
  proposeEdgesFrom(this: HubService, server: WorkspaceServerSummary, facts: ServerFacts, now: number): void {
    const others = this.getKnownServers().filter((s) => s.id !== server.id && s.host);
    const edges = (this.store.data.infraEdges ??= []);
    let added = false;
    for (const peer of facts.peers) {
      const at = peer.lastIndexOf(":");
      const [address, port] = [peer.slice(0, at), peer.slice(at + 1)];
      const other = others.find((s) => s.host === address);
      if (!other) continue;
      const id = `edge-facts-${crypto.createHash("sha256").update(`${server.id}|${other.id}`).digest("hex").slice(0, 16)}`;
      if (this.store.data.sharedRemoved?.edges?.[id]) continue;
      if (edges.some((e) => e.id === id || (e.from === server.name && e.to === other.name))) continue;
      edges.push({
        id,
        from: server.name,
        to: other.name,
        relation: "depends_on",
        proposed: true,
        evidence: `${server.name} had a connection open to ${other.name} (${address}:${port}) when it was read.`,
        proposedBy: "Server facts",
        updatedAt: now,
      });
      added = true;
    }
    if (added) this.lastWorkSync = 0;
  }
  /** The requests this part answers. What a case leaves in `reply` goes back with the snapshot. */
  async handleFacts(this: HubService, request: RequestsOf<"facts">): Promise<Handled> {
    let reply: HubReply | undefined;
    switch (request.action) {
      case "facts-configure": {
        const current = (this.store.data.factsSettings ??= {});
        if (request.enabled !== undefined) current.enabled = request.enabled === true;
        if (request.intervalHours !== undefined) current.intervalHours = integer(request.intervalHours, 1, 168);
        if (request.exclude !== undefined) current.exclude = request.exclude.filter((id) => typeof id === "string").slice(0, 500);
        if (request.watchPaths !== undefined) {
          const bad = request.watchPaths.map((p) => p.trim()).filter((p) => p && !isWatchPath(p));
          if (bad.length) throw new Error(`Not a path that can be watched: ${bad[0]}. Use an absolute path of plain characters; * is allowed.`);
          current.watchPaths = request.watchPaths.map((p) => p.trim()).filter(Boolean).slice(0, 40);
        }
        // Switched on: read what is due now, not at the next round.
        this.lastFactsTick = 0;
        if (current.enabled) void this.factsTick().catch((e) => log.warn("Reading server facts failed", safeError(e)));
        break;
      }
      case "facts-collect-now": {
        if (request.serverId) {
          const server = this.getKnownServers().find((x) => x.id === request.serverId);
          if (!server) throw new Error("Server not found");
          await this.collectFacts(server, Date.now(), true);
        } else {
          this.lastFactsTick = 0;
          await this.factsTick(Date.now(), true);
        }
        break;
      }
      case "server-facts-read": {
        const record = this.factsStore.get(request.serverId);
        reply = { serverFacts: { serverId: request.serverId, facts: record?.facts, changes: record?.changes ?? [] } };
        break;
      }
      case "facts-problem-dismiss": {
        const record = this.factsStore.get(request.serverId);
        if (record) {
          // One problem, or everything this server has right now.
          const keys = request.key ? [request.key] : this.factsProblems(record).map((p) => p.key);
          const at = Date.now();
          await this.factsStore.put({ ...record, dismissed: { ...(record.dismissed ?? {}), ...Object.fromEntries(keys.map((k) => [k, at])) } });
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
