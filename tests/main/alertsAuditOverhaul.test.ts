import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { InboxItem } from "../../src/shared/aiHubInbox";
import type {
  AgentSchedule,
  AgentTask,
  InfraGraphEdge,
  MissionAgent,
  WorkTicket,
  WorkspaceServerSummary,
} from "../../src/shared/types/aiHub";
import {
  AlertBurstTrigger,
  appendCorrelatedAlert,
  correlateAlert,
  matchesAlertRule,
  parseAlerts,
  routeAlert,
  shouldTriggerFastTriage,
  topologyNeighbors,
} from "../../src/main/ai/hub/AlertIntake";
import {
  AUTO_PAUSE_MAX_SECONDS,
  AUTO_PAUSE_MIN_SECONDS,
  evaluateAutoPause,
  evaluateEscalations,
  evaluateFlapCooldown,
  evaluateNoiseBudget,
  isQuietHours,
  renderNotification,
  signChatOpsActionToken,
  verifyChatOpsActionToken,
  verifyStandardWebhook,
  type NotifyChannel,
  type NotifyItem,
} from "../../src/main/ai/hub/Notifier";
import { NotifyStore } from "../../src/main/ai/hub/NotifyStore";
import { buildDailyReport } from "../../src/main/ai/hub/DailyReport";
import {
  ANCHORS_READ,
  AuditLog,
  AuditShipper,
  formatAuditOtlpJson,
  formatAuditRfc5424Cef,
  hashEntry,
  type AuditAnchor,
} from "../../src/main/ai/hub/AuditLog";
import type { QueueStore } from "../../src/main/ai/hub/LearningQueue";
import { SessionRecorder } from "../../src/main/ai/hub/SessionRecorder";

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.useRealTimers();
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  disposals.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

function memoryBucket(): QueueStore & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    list: async (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    read: async (p) => files.get(p),
    write: async (p, c) => void files.set(p, c),
    remove: async (p) => void files.delete(p),
  };
}

// ---- 1. AlertIntake --------------------------------------------------------

describe("AlertIntake overhaul", () => {
  const servers = [
    { id: "s1", name: "pg-01", host: "10.0.0.5", cluster: "DB-Prod" },
    { id: "s2", name: "pg-02", host: "10.0.0.6", cluster: "DB-Prod" },
    { id: "s3", name: "web-01", host: "10.0.1.10", cluster: "Edge-Web" },
  ] as WorkspaceServerSummary[];

  const edges = [
    { id: "e1", from: "web-01", to: "DB-Prod", relation: "depends_on", updatedAt: 1 },
    { id: "e2", from: "prom-01", to: "web-01", relation: "monitors", updatedAt: 1 },
    { id: "e3", from: "cache-01", to: "pg-01", relation: "depends_on", proposed: true, updatedAt: 1 },
  ] as InfraGraphEdge[];

  const makeAgent = (id: string, extra: Partial<MissionAgent> = {}): MissionAgent => ({
    id,
    name: id,
    role: "worker",
    mission: "m",
    systemPrompt: "",
    defaultMode: "advice",
    updatedAt: 1,
    ...extra,
  });

  const makeTicket = (id: string, target: string, now: number, extra: Partial<WorkTicket> = {}): WorkTicket => ({
    id,
    title: `Alert: root on ${target}`,
    description: "",
    status: "todo",
    target,
    createdBy: "Alertmanager",
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
    alert: {
      fingerprint: `fp-${id}`,
      name: "RootFailure",
      source: "Alertmanager",
      severity: "warning",
      firstAt: now - 60_000,
      lastAt: now - 30_000,
      count: 1,
    },
    ...extra,
  });

  it("correlates cascading alerts by target, cluster, and confirmed topology onto correlatedAlerts", () => {
    const now = 1_800_000_000_000;
    const dbTicket = makeTicket("t-db", "pg-01", now);

    // Same target within window
    const [sameTargetAlert] = parseAlerts({
      title: "High I/O wait",
      host: "pg-01",
      severity: "warning",
      fingerprint: "fp-io",
    });
    const m1 = correlateAlert(sameTargetAlert, [dbTicket], { servers, edges, now });
    expect(m1).toMatchObject({ ticket: { id: "t-db" }, reason: "same-target" });

    // Same cluster (pg-02 in DB-Prod)
    const [clusterAlert] = parseAlerts({
      title: "Replica lag spike",
      host: "pg-02",
      severity: "critical",
      fingerprint: "fp-lag",
    });
    const m2 = correlateAlert(clusterAlert, [dbTicket], { servers, edges, now });
    expect(m2).toMatchObject({ ticket: { id: "t-db" }, reason: "same-cluster", via: "DB-Prod" });

    // Confirmed topology dependency (web-01 depends_on DB-Prod)
    const [webAlert] = parseAlerts({
      title: "502 Bad Gateway",
      host: "web-01",
      severity: "critical",
      fingerprint: "fp-502",
    });
    const m3 = correlateAlert(webAlert, [dbTicket], { servers, edges, now });
    expect(m3).toMatchObject({ ticket: { id: "t-db" }, reason: "topology" });

    // Proposed or monitors edges are ignored
    const neighbors = topologyNeighbors(["pg-01"], edges);
    expect(neighbors.has("cache-01")).toBe(false);
    expect(topologyNeighbors(["web-01"], edges).has("prom-01")).toBe(false);

    // Expired window does not correlate
    const expired = correlateAlert(webAlert, [dbTicket], { servers, edges, now: now + 30 * 60_000, windowMs: 10 * 60_000 });
    expect(expired).toBeUndefined();

    // Bundling updates correlatedAlerts, deduplicates by fingerprint, and escalates severity
    let bundled = appendCorrelatedAlert(dbTicket, clusterAlert, "same-cluster", now);
    bundled = appendCorrelatedAlert(bundled, clusterAlert, "same-cluster", now + 1000);
    bundled = appendCorrelatedAlert(bundled, webAlert, "topology", now + 2000);
    expect(bundled.correlatedAlerts).toHaveLength(2);
    expect(bundled.alert?.severity).toBe("critical");
  });

  it("supports structured label=value route matching and ops-role fallback", () => {
    const [alert] = parseAlerts({
      alerts: [
        {
          status: "firing",
          fingerprint: "f1",
          labels: { alertname: "Checkout500", env: "prod", team: "payments", severity: "critical", service: "checkout-api" },
          annotations: { summary: "Errors in checkout" },
        },
      ],
    });
    const agents = [
      makeAgent("pay", { role: "Payments" }),
      makeAgent("sre", { role: "On-Call SRE" }),
      makeAgent("dev", { role: "Developer" }),
    ];

    expect(matchesAlertRule(alert, "web-01", "env=prod,severity=critical")).toBe(true);
    expect(matchesAlertRule(alert, "web-01", "service=checkout-* env!=staging")).toBe(true);
    expect(matchesAlertRule(alert, "web-01", "env=staging,severity=critical")).toBe(false);

    expect(routeAlert(alert, "web-01", [{ match: "env=prod,team=payments", agentId: "pay" }], agents)?.id).toBe("pay");
    // Falls back to active ops/SRE role when no rule, cluster, or team lead matches
    expect(routeAlert(alert, undefined, [{ match: "env=staging", agentId: "pay" }], agents)?.id).toBe("sre");
    // Non-ops solo agent still returns undefined
    expect(routeAlert(alert, undefined, [], [makeAgent("solo", { role: "Analyst" })])).toBeUndefined();
  });

  it("fires fast triage telemetry burst hook on critical alert or sliding-window burst with cooldown", async () => {
    const [warnAlert] = parseAlerts({ title: "CPU high", severity: "warning", host: "web-01" });
    const [critAlert] = parseAlerts({ title: "DB down", severity: "critical", host: "pg-01" });

    expect(shouldTriggerFastTriage([warnAlert], [], { now: 1000, threshold: 3 })).toMatchObject({ trigger: false });
    expect(shouldTriggerFastTriage([warnAlert], [500, 800], { now: 1000, threshold: 3 })).toMatchObject({
      trigger: true,
      reason: "burst-threshold",
      countInWindow: 3,
    });
    expect(shouldTriggerFastTriage([critAlert], [], { now: 1000 })).toMatchObject({
      trigger: true,
      reason: "critical-alert",
    });

    const received: string[] = [];
    const monitor = new AlertBurstTrigger({ windowMs: 60_000, threshold: 3, cooldownMs: 30_000 });
    const unsub = monitor.onBurst((ev) => {
      received.push(`${ev.reason}:${ev.target}`);
    });

    expect(monitor.record([warnAlert], { target: "web-01", now: 1000 })).toBeUndefined();
    expect(monitor.record([warnAlert], { target: "web-01", now: 2000 })).toBeUndefined();
    const burst = monitor.record([warnAlert], { target: "web-01", now: 3000 });
    expect(burst?.reason).toBe("burst-threshold");
    // Within cooldown: suppressed
    expect(monitor.record([warnAlert], { target: "web-01", now: 5000 })).toBeUndefined();
    // Different target triggers critical independently
    expect(monitor.record([critAlert], { target: "pg-01", now: 6000 })?.reason).toBe("critical-alert");

    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual(["burst-threshold:web-01", "critical-alert:pg-01"]);
    unsub();
  });
});

// ---- 2. NotifyStore & Notifier ---------------------------------------------

describe("Notifier & NotifyStore overhaul", () => {
  const NOW = 1_800_000_000_000;
  const MIN = 60_000;

  it("enforces per-fingerprint flap cooldown and Auto-Pause cushion (60-120s)", () => {
    let flapState = {};
    expect(evaluateFlapCooldown("fp-1", flapState, NOW, { maxChangesBeforeFlap: 3, cooldownMs: 10 * MIN }).allow).toBe(true);
    let r = evaluateFlapCooldown("fp-1", flapState, NOW, { maxChangesBeforeFlap: 3, cooldownMs: 10 * MIN });
    flapState = r.nextState;
    expect(r.allow).toBe(true);
    r = evaluateFlapCooldown("fp-1", flapState, NOW + MIN, { maxChangesBeforeFlap: 3, cooldownMs: 10 * MIN });
    flapState = r.nextState;
    expect(r.allow).toBe(true);
    // Third transition triggers flap cooldown
    r = evaluateFlapCooldown("fp-1", flapState, NOW + 2 * MIN, { maxChangesBeforeFlap: 3, cooldownMs: 10 * MIN });
    flapState = r.nextState;
    expect(r.allow).toBe(false);
    expect(r.flapping).toBe(true);
    // After cooldown expires and outside window, allowed again
    r = evaluateFlapCooldown("fp-1", flapState, NOW + 25 * MIN, { maxChangesBeforeFlap: 3, cooldownMs: 10 * MIN });
    expect(r.allow).toBe(true);

    // Auto-Pause: clamps cushion to [60, 120]s, holds non-critical transients, passes critical/approval immediately
    const warnItem: InboxItem = { id: "alert:w1", kind: "alert", title: "Transient CPU", at: NOW, since: NOW, risk: "warning" };
    const critItem: InboxItem = { id: "alert:c1", kind: "alert", title: "Disk full", at: NOW, since: NOW, risk: "critical" };
    const ap1 = evaluateAutoPause([warnItem, critItem], {}, NOW + 10_000, { cushionSeconds: 30 }); // clamped to 60s
    expect(ap1.ready.map((i) => i.id)).toEqual(["alert:c1"]);
    expect(ap1.held.map((i) => i.id)).toEqual(["alert:w1"]);
    expect(ap1.pending["alert:w1"].releaseAt).toBe(NOW + AUTO_PAUSE_MIN_SECONDS * 1000);

    // If transient resolves before releaseAt, it drops out without notifying
    const apResolved = evaluateAutoPause([], ap1.pending, NOW + 40_000, { cushionSeconds: 30 });
    expect(apResolved.ready).toEqual([]);
    expect(apResolved.pending).toEqual({});

    // If still active after clamped max (120s), it releases
    const apMax = evaluateAutoPause([warnItem], {}, NOW, { cushionSeconds: 300 });
    expect(apMax.pending["alert:w1"].releaseAt).toBe(NOW + AUTO_PAUSE_MAX_SECONDS * 1000);
    const apReleased = evaluateAutoPause([warnItem], apMax.pending, NOW + 120_000, { cushionSeconds: 300 });
    expect(apReleased.ready.map((i) => i.id)).toEqual(["alert:w1"]);
  });

  it("enforces quiet hours and hourly noise budget with critical bypass", () => {
    // 23:00 UTC
    const nightUtc = Date.UTC(2026, 4, 12, 23, 30, 0);
    const quiet = { enabled: true, startHour: 22, endHour: 7, timezoneOffsetMinutes: 0 };
    expect(isQuietHours(quiet, nightUtc)).toBe(true);
    expect(isQuietHours(quiet, Date.UTC(2026, 4, 12, 12, 0, 0))).toBe(false);

    const warn: NotifyItem = { id: "a1", kind: "alert", title: "Warn", risk: "warning" };
    const crit: NotifyItem = { id: "a2", kind: "alert", title: "Crit", risk: "critical" };
    const qRes = evaluateNoiseBudget([warn, crit], [], nightUtc, { quietHours: quiet });
    expect(qRes.reason).toBe("quiet-hours");
    expect(qRes.allowed.map((i) => i.id)).toEqual(["a2"]);
    expect(qRes.suppressed.map((i) => i.id)).toEqual(["a1"]);

    // Hourly budget exhausted (3 pushes in last hour)
    const dayUtc = Date.UTC(2026, 4, 12, 12, 0, 0);
    const bRes = evaluateNoiseBudget([warn, crit], [dayUtc - 50 * MIN, dayUtc - 30 * MIN, dayUtc - 10 * MIN], dayUtc, {
      maxPushesPerHour: 3,
      quietHours: quiet,
    });
    expect(bRes.reason).toBe("noise-budget");
    expect(bRes.allowed.map((i) => i.id)).toEqual(["a2"]);
    expect(bRes.suppressed.map((i) => i.id)).toEqual(["a1"]);
  });

  it("supports multi-step ack-aware escalation tiers and upgrades NotifyStore without breaking legacy load/save", async () => {
    const dir = await makeTempDir("sshs3-notifystore-");
    const file = path.join(dir, "notify.json");
    // Simulate legacy v1 file without new keys
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, channels: [], seen: { "approval:1": NOW }, reminded: {}, publicUrl: "", reminderMinutes: 5 }),
    );
    const store = new NotifyStore(file);
    await store.load();
    expect(store.data.seen["approval:1"]).toBe(NOW);
    expect(store.data.escalations).toEqual({});

    const items: InboxItem[] = [
      { id: "approval:1", kind: "approval", title: "Restart nginx", at: NOW, since: NOW },
      { id: "approval:2", kind: "approval", title: "Drop temp table", at: NOW, since: NOW },
    ];
    const seen = { "approval:1": NOW, "approval:2": NOW };

    // Step 1 at +5 min
    const step1 = evaluateEscalations(items, seen, {}, NOW + 5 * MIN, { tierMinutes: [5, 15, 30] });
    expect(step1.due.map((d) => [d.item.id, d.tier])).toEqual([
      ["approval:1", 1],
      ["approval:2", 1],
    ]);

    // Acknowledge approval:1 -> stops escalating while approval:2 advances to tier 2 after +15m
    store.data.seen = seen;
    store.data.escalations = step1.escalations;
    store.acknowledge("approval:1", "jacob", NOW + 6 * MIN);
    const step2 = evaluateEscalations(items, store.data.seen, store.data.escalations, NOW + 20 * MIN, { tierMinutes: [5, 15, 30] });
    expect(step2.due.map((d) => [d.item.id, d.tier])).toEqual([["approval:2", 2]]);

    // Persist and reload
    store.data.escalations = step2.escalations;
    store.recordPush(NOW + 20 * MIN);
    await store.save();

    const reloaded = new NotifyStore(file);
    await reloaded.load();
    expect(reloaded.data.escalations?.["approval:1"].ackedBy).toBe("jacob");
    expect(reloaded.data.escalations?.["approval:2"].tier).toBe(2);
    expect(reloaded.data.pushHistory).toHaveLength(1);
  });

  it("generates and verifies signed ChatOps Approve/Deny action payload tokens in webhook payloads", () => {
    const secret = "whsec_" + Buffer.from("super-secret-signing-key").toString("base64");
    const hookChannel: NotifyChannel = {
      id: "w1",
      kind: "webhook",
      name: "chatops",
      url: "https://chatops.example.com/hook",
      secret,
      enabled: true,
      events: ["approval", "alert"],
      includeCommand: true,
      chatOpsActions: true,
    };
    const item: NotifyItem = {
      id: "approval:c1",
      kind: "approval",
      title: "Restart postgres",
      target: "pg-01",
      risk: "modify",
      escalationTier: 2,
      reminder: true,
    };
    const req = renderNotification(hookChannel, [item], {
      chatOps: { enabled: true, ttlSeconds: 600, callbackUrl: "https://sshs3.example.com/api/chatops/act" },
    });
    const parsed = JSON.parse(req.body) as {
      title: string;
      items: Array<{
        id: string;
        escalationTier?: number;
        actions?: {
          approve: { action: string; token: string; url?: string };
          deny: { action: string; token: string; url?: string };
        };
      }>;
    };
    expect(parsed.title).toContain("Still waiting (tier 2):");
    const actions = parsed.items[0].actions!;
    expect(actions.approve.url).toBe("https://sshs3.example.com/api/chatops/act");
    expect(verifyChatOpsActionToken(secret, actions.approve.token)).toMatchObject({
      ok: true,
      payload: { itemId: "approval:c1", action: "approve", target: "pg-01" },
    });
    expect(verifyChatOpsActionToken(secret, actions.deny.token)).toMatchObject({
      ok: true,
      payload: { itemId: "approval:c1", action: "deny", target: "pg-01" },
    });

    // Tampered and expired tokens fail verification
    const tok = signChatOpsActionToken(secret, { itemId: "approval:c1", action: "approve" }, 1_000, 60);
    expect(verifyChatOpsActionToken(secret, tok, 1_061).ok).toBe(false);
    expect(verifyChatOpsActionToken(secret, `${tok.slice(0, -1)}X`, 1_010).ok).toBe(false);
    expect(verifyStandardWebhook(secret, {
      id: req.headers["webhook-id"],
      timestamp: req.headers["webhook-timestamp"],
      signature: req.headers["webhook-signature"],
    }, req.body).ok).toBe(true);
  });
});

// ---- 3. DailyReport --------------------------------------------------------

describe("DailyReport shift-handoff overhaul", () => {
  const NOW = Date.UTC(2026, 4, 12, 8, 0, 0);
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  it("performs novelty filtering, deterministic schedule counts, and server/time-window incident correlation", () => {
    const tickets = [
      {
        id: "t1",
        title: "Alert (critical): High CPU on pg-01",
        status: "in_progress",
        target: "pg-01",
        assigneeName: "DBA",
        updatedAt: NOW - 2 * HOUR,
        alert: { fingerprint: "fp1", source: "Alertmanager", severity: "critical", firstAt: NOW - 2 * HOUR, lastAt: NOW - 2 * HOUR, count: 2 },
        correlatedAlerts: [{ fingerprint: "fp2", summary: "Replica lag spike", at: NOW - 118 * MIN, severity: "warning" }],
      },
      {
        id: "t2",
        title: "Investigate slow queries",
        status: "blocked",
        target: "pg-01",
        result: "Waiting on pg_stat_statements",
        updatedAt: NOW - 115 * MIN,
      },
    ] as unknown as WorkTicket[];

    const tasks = [
      {
        agentName: "DBA",
        changes: [
          { id: "c1", target: "pg-01", description: "Reload postgres config", status: "failed", riskLevel: "modify", at: NOW - 117 * MIN },
        ],
      },
    ] as unknown as AgentTask[];

    const schedules = [
      { id: "s1", title: "Disk Check", enabled: true, lastStatus: "HEARTBEAT_OK" },
      { id: "s2", title: "Cert Expiry", enabled: true, lastStatus: "nominal" },
      { id: "s3", title: "Backup Verify", enabled: true, lastStatus: "failed", lastRunSummary: "exit code 2 on truenas-01" },
      { id: "s4", title: "Disabled Job", enabled: false, lastStatus: "failed" },
    ] as unknown as AgentSchedule[];

    const input = {
      since: NOW - 24 * HOUR,
      now: NOW,
      activity: [],
      tickets,
      tasks,
      pages: [],
      memories: [],
      findings: [],
      schedules,
      serverProblems: ["pg-01: /var/log at 85%", "web-01: nginx worker restart detected"],
      previousProblems: ["pg-01: /var/log at 85%"],
    };

    const report1 = buildDailyReport(input);
    const report2 = buildDailyReport(input);
    expect(report1).toBe(report2); // Strictly deterministic

    // Novelty filtering: repeat unchanged problem suppressed, novel problem kept
    expect(report1).toContain("web-01: nginx worker restart detected");
    expect(report1).not.toContain("pg-01: /var/log at 85%");
    expect(report1).toContain("1 unchanged repeat problem suppressed");

    // Schedule summary counts (disabled excluded)
    expect(report1).toContain("### Schedules");
    expect(report1).toContain("2 nominal, 1 anomaly");
    expect(report1).toContain("Anomaly: Backup Verify (failed) — exit code 2 on truenas-01 [s3]");

    // Server/time-window incident correlation with deterministic UTC timestamps & sorted citations
    expect(report1).toContain("### Correlated incidents");
    expect(report1).toContain("pg-01 (06:00Z–06:05Z, 4 events):");
    expect(report1).toContain("[refs: alert:fp2, change:c1, ticket:t1, ticket:t2]");
  });
});

// ---- 4. AuditLog & SessionRecorder -----------------------------------------

describe("AuditLog & SessionRecorder overhaul", () => {
  it("records structured actor/event metadata under the hash chain and verifies legacy entries", async () => {
    const dir = await makeTempDir("sshs3-audit-meta-");
    const log = new AuditLog(dir, "c1");
    const e1 = await log.append({
      kind: "command",
      actor: "Jacob",
      target: "pg-01",
      what: "pg_dumpall",
      outcome: "completed",
      schemaVersion: 2,
      userId: "usr_123",
      agentId: "agent_dba",
      sourceIp: "198.51.100.7",
    });
    expect(e1).toMatchObject({
      schemaVersion: 2,
      userId: "usr_123",
      agentId: "agent_dba",
      sourceIp: "198.51.100.7",
    });
    expect((await log.verify()).ok).toBe(true);

    // Tampering with userId breaks the hash chain
    const raw = await fs.readFile(log.file, "utf8");
    await fs.writeFile(log.file, raw.replace("usr_123", "usr_999"));
    expect((await log.verify()).ok).toBe(false);

    // Legacy entry without schemaVersion/userId/agentId/sourceIp also verifies
    const legacyDir = await makeTempDir("sshs3-audit-legacy-");
    const legacyFile = path.join(legacyDir, "audit-c1.jsonl");
    const base = { seq: 1, at: 1000, prev: "", kind: "command" as const, actor: "Jacob", what: "uptime" };
    await fs.writeFile(legacyFile, `${JSON.stringify({ ...base, hash: hashEntry(base) })}\n`);
    const legacyLog = new AuditLog(legacyDir, "c1");
    expect(await legacyLog.verify()).toMatchObject({ ok: true, entries: 1 });
  });

  it("ships audit entries out-of-band (OTLP/JSON, RFC 5424 CEF/Syslog, webhook) without blocking append", async () => {
    const dir = await makeTempDir("sshs3-audit-ship-");
    const log = new AuditLog(dir, "c1");

    const receivedHttp: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        receivedHttp.push({ headers: req.headers, body });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    disposals.push(() => new Promise((r) => srv.close(() => r(undefined))));
    const port = (srv.address() as { port: number }).port;

    const cefSent: string[] = [];
    const otlpSent: string[] = [];
    let releaseSlow!: () => void;
    const slowBlocker = new Promise<void>((r) => {
      releaseSlow = r;
    });

    const slowShipper = new AuditShipper({
      format: "otlp",
      send: async ({ body }) => {
        await slowBlocker;
        otlpSent.push(body);
      },
    });
    const cefShipper = new AuditShipper({
      format: "cef",
      hostname: "bastion-01",
      appName: "sshs3-hub",
      send: ({ body }) => {
        cefSent.push(body);
      },
    });
    const webhookShipper = new AuditShipper({
      format: "webhook",
      url: `http://127.0.0.1:${port}/audit`,
      secret: "audit-hook-secret",
      guard: { server: false, allowPrivate: true, allowPlainHttp: true },
    });
    const failingErrors: unknown[] = [];
    const failingShipper = new AuditShipper({
      format: "otlp",
      send: async () => {
        throw new Error("sink down");
      },
      onError: (err) => failingErrors.push(err),
    });

    log.subscribe(slowShipper);
    log.subscribe(cefShipper);
    log.subscribe(webhookShipper);
    log.subscribe(failingShipper);

    // append() resolves immediately even though slowShipper is blocked and failingShipper throws
    const entry = await log.append(
      {
        kind: "approval",
        actor: "Jacob",
        target: "pg-01",
        what: "systemctl restart postgresql",
        outcome: "completed",
        userId: "u1",
        sourceIp: "10.0.0.2",
      },
      1_800_000_000_000,
    );
    expect(entry.seq).toBe(1);
    expect(otlpSent).toHaveLength(0);

    releaseSlow();
    await Promise.all([slowShipper.flush(), cefShipper.flush(), webhookShipper.flush(), failingShipper.flush()]);

    expect(otlpSent).toHaveLength(1);
    const otlp = JSON.parse(otlpSent[0]) as ReturnType<typeof formatAuditOtlpJson>;
    expect(JSON.stringify(otlp)).toContain("systemctl restart postgresql");
    expect(JSON.stringify(otlp)).toContain("enduser.id");

    expect(cefSent).toHaveLength(1);
    expect(cefSent[0]).toBe(formatAuditRfc5424Cef(entry, { hostname: "bastion-01", appName: "sshs3-hub" }));
    expect(cefSent[0]).toMatch(/^<\d+>1 2027-01-15T08:00:00\.000Z bastion-01 sshs3-hub - approval - CEF:0\|Sshs3\|AuditLog\|1\|approval\|/);
    expect(cefSent[0]).toContain("suser=u1");
    expect(cefSent[0]).toContain("src=10.0.0.2");

    expect(receivedHttp).toHaveLength(1);
    expect(receivedHttp[0].headers["x-sshs3-signature"]).toBe(
      `sha256=${crypto.createHmac("sha256", "audit-hook-secret").update(receivedHttp[0].body).digest("hex")}`,
    );
    expect(failingErrors).toHaveLength(1);
  });

  it("paginates verify() beyond ANCHORS_READ = 2000 and catches early-page tampering", async () => {
    expect(ANCHORS_READ).toBe(2000);
    const dir = await makeTempDir("sshs3-audit-paginated-");
    const bucket = memoryBucket();
    const log = new AuditLog(dir, "c1", () => bucket);

    // Write 10 log entries and build 2005 chained anchors across > 1 page of ANCHORS_READ
    const entries = [];
    for (let i = 1; i <= 10; i++) {
      entries.push(await log.append({ kind: "command", actor: "a", what: `cmd-${i}` }, i * 1000));
    }

    let prevAnchorBytes = "";
    for (let n = 1; n <= 2005; n++) {
      const target = entries[Math.min(entries.length - 1, Math.floor((n - 1) / 201))];
      const anchor: AuditAnchor = {
        seq: target.seq,
        hash: target.hash,
        at: target.at,
        client: "c1",
        n,
        prev: prevAnchorBytes ? crypto.createHash("sha256").update(prevAnchorBytes).digest("hex") : "",
      };
      const bytes = JSON.stringify(anchor);
      bucket.files.set(`audit/c1/anchors/n${String(n).padStart(12, "0")}.json`, Buffer.from(bytes, "utf8"));
      prevAnchorBytes = bytes;
    }

    const okRes = await log.verify();
    expect(okRes).toMatchObject({
      ok: true,
      entries: 10,
      anchors: { checked: 2005, held: 2005, pagesChecked: 2 },
    });

    // Deleting an anchor from page 1 (anchor #2, well before the last 2000) is detected!
    bucket.files.delete("audit/c1/anchors/n000000000002.json");
    const broken = await log.verify();
    expect(broken.ok).toBe(false);
    expect(broken.problem?.text).toContain("does not follow anchor 1");
  });

  it("enforces human-session opt-in policy and strictly line-buffered masked o-stream without keystrokes", async () => {
    vi.useFakeTimers();
    const dir = await makeTempDir("sshs3-human-rec-");
    const rec = new SessionRecorder(dir);

    // Must reject human recording without explicit opt-in
    await expect(rec.start({ sessionId: "s-human", label: "prod-web", mode: "human" })).rejects.toThrow("opt-in");

    // Disabled by policy also rejects
    rec.setPolicy({ allowHumanOptIn: false });
    await expect(
      rec.start({ sessionId: "s-human", label: "prod-web", mode: "human", humanOptIn: true }),
    ).rejects.toThrow("disabled by policy");

    rec.setPolicy({ allowHumanOptIn: true });
    const info = await rec.start(
      { sessionId: "s-human", label: "prod-web", mode: "human", humanOptIn: true, actor: "Jacob" },
      0,
    );
    expect(info).toMatchObject({ mode: "human", optIn: true, actor: "Jacob" });

    // Raw keystrokes (such as typed passwords) are never written
    rec.input("s-human", "hunter2-password\r");

    // Partial output without newline is NOT flushed after IDLE_FLUSH_MS in human mode
    rec.output("s-human", "export API_TOKEN=sk-abcdef1234567890", 100);
    await vi.advanceTimersByTimeAsync(500);
    const mid = (await rec.read(info.id))!;
    expect(mid.trim().split("\n")).toHaveLength(1); // header only so far

    // Once newline arrives, line is masked via maskTerminalOutput and written as `o`
    rec.output("s-human", "\r\n", 600);
    await rec.stop("s-human", 1000);
    vi.useRealTimers();

    const raw = (await rec.read(info.id))!;
    expect(raw).not.toContain("hunter2-password");
    expect(raw).not.toContain("sk-abcdef1234567890");
    expect(raw).toContain("[redacted]");
    const parsedLines = raw.trim().split("\n").slice(1).map((l) => JSON.parse(l) as [number, string, string]);
    expect(parsedLines.every(([, kind]) => kind !== "i")).toBe(true);
    expect(parsedLines[0][1]).toBe("o");
  });
});
