import crypto from "node:crypto";
import type { AgentTask, EvalCase, MemoryProposal, RunbookTemplate, WorkforceRun, SimulationView, WorkforceStep, WorkspaceActivityEvent } from "../../../../shared/types/aiHub";
import { buildDailyReport } from "../DailyReport";
import { savePageByPerson } from "../KbCompile";
import { ensureBaseFleet } from "../../../sim/baseFleet";
import { SCENARIOS, scenarioById, startScenario, stopScenario } from "../../../sim/lab";
import { runLines, scoreScenario, type SimScenario } from "../../../sim/Scenario";
import { simWorld, type SimWorld } from "../../../sim/SimWorld";
import { parseAlerts } from "../AlertIntake";
import { upsertDemoServer, deleteDemoServer, appendDemoActivity, deleteDemoActivityByPrefix, getDemoActivityLog, getDemoMemories, getDemoSchedules, isDemoMode, saveDemoWorkforceRun } from "../demoWorkspace";
import { boundedContext, clip } from "../privacy";
import { requiredText } from "../hubHelpers";
import { active } from "../hubShared";
import type { HubService } from "../HubService";
import type { Handled, RequestsOf } from "./routes";

interface HubSimulation {
  owner: HubService;
  scenario: SimScenario;
  world: SimWorld;
  startedAt: number;
  ticketId?: string;
  pageId?: string;
  lastReplay?: { mode: "careful" | "careless"; ran: number; at: string; lines: string[] };
}

// The demo hosts and their shells are process-wide. Keep their incident and its owner's artifacts together.
let simulation: HubSimulation | undefined;
let transition: Promise<void> = Promise.resolve();

function changeSimulation(change: () => Promise<void>): Promise<void> {
  const result = transition.then(change);
  transition = result.catch(() => undefined);
  return result;
}

async function clearSimulation(): Promise<void> {
  const run = simulation;
  simulation = undefined;
  stopScenario();
  deleteDemoActivityByPrefix("sim-");
  if (!run) return;
  const { owner, scenario, pageId, ticketId } = run;
  run.world.onRan = undefined;
  for (const server of scenario.servers) deleteDemoServer(server.id);
  if (pageId) owner.store.data.kbPages = (owner.store.data.kbPages ?? []).filter((p) => p.id !== pageId);
  // A terminal may have saved one of the lab's servers as this owner's profile.
  const serverIds = new Set(scenario.servers.map((server) => server.id));
  for (const id of serverIds) await owner.host.deleteServer?.(id).catch(() => undefined);
  if (owner.store.data.s3SyncedServers) owner.store.data.s3SyncedServers = owner.store.data.s3SyncedServers.filter((s) => !serverIds.has(s.id));
  const ticket = ticketId && owner.store.data.workTickets?.find((t) => t.id === ticketId && !t.deleted);
  if (ticket && ticket.status !== "in_progress") owner.putTicket({ ...ticket, deleted: true, deletedBy: "the demo lab", updatedAt: Date.now() });
  await owner.chat.endSimulation();
  if (owner.disposed) owner.host.onSharedWorkspaceChanged?.();
  else owner.changed();
}

async function installSimulation(owner: HubService, scenario: SimScenario): Promise<void> {
  const world = startScenario(scenario);
  const run: HubSimulation = { owner, scenario, world, startedAt: world.now() };
  simulation = run;
  // What is run on the lab's servers changes how the scenario stands: the interface is told, not more than twice a second.
  let told: ReturnType<typeof setTimeout> | undefined;
  world.onRan = () => {
    told ??= setTimeout(() => {
      told = undefined;
      if (simulation === run) owner.changed();
    }, 400);
  };
  const now = run.startedAt;
  // The team's own page for this kind of trouble: there while the scenario runs, as it would be in a team that had met it before.
  if (scenario.runbook) {
    const page = savePageByPerson(undefined, { kind: "troubleshooting", title: scenario.runbook.title, when: scenario.runbook.when, body: scenario.runbook.body, targets: [...new Set(scenario.servers.map((x) => x.cluster))], keys: scenario.runbook.keys }, "the team (demo lab)");
    owner.store.data.kbPages = [...(owner.store.data.kbPages ?? []), page];
    run.pageId = page.id;
  }
  for (const server of scenario.servers)
    upsertDemoServer({ id: server.id, name: server.name, host: server.host, username: server.username, cluster: server.cluster, folder: `Scenario / ${server.cluster}`, description: server.description, tags: server.tags, shared: false });
  // The chat first: the alert's ticket looks through it.
  const said = scenario.chat ?? [];
  const channels = [...new Set(said.map((m) => m.channel))].map((name, i) => ({ id: `CSIM${i + 1}`, name }));
  const tsOf = (minutesAgo: number): string => ((now - minutesAgo * 60_000) / 1000).toFixed(6);
  await owner.chat.simulate(
    "Acme",
    channels,
    said.map((m) => {
      const channelId = channels.find((c) => c.name === m.channel)!.id;
      const id = tsOf(m.minutesAgo);
      const threadId = m.replyTo === undefined ? id : tsOf(said[m.replyTo].minutesAgo);
      return { id, channelId, at: now - m.minutesAgo * 60_000, author: m.author, text: m.text, threadId, link: `https://acme.slack.com/archives/${channelId}/p${id.replace(".", "")}` };
    }),
  );
  for (const [i, event] of (scenario.activity ?? []).entries())
    appendDemoActivity({ id: `sim-${scenario.id}-${i}`, at: now - event.minutesAgo * 60_000, actor: event.actor, kind: event.kind as never, targetLabel: event.target, summary: event.summary } as WorkspaceActivityEvent);
  if (scenario.alert) {
    const made = await owner.takeAlerts(
      parseAlerts({
        status: "firing",
        alerts: [
          {
            status: "firing",
            fingerprint: `sim-${scenario.id}-${now}`,
            labels: { alertname: scenario.alert.name, severity: scenario.alert.severity, instance: scenario.alert.instance },
            annotations: { summary: scenario.alert.summary, description: scenario.alert.description },
          },
        ],
      }),
    );
    run.ticketId = made.created[0];
  }
  owner.changed();
}

/** Closing an unrelated web tenant must leave the shared exercise running. */
export function disposeSimulation(owner: HubService): Promise<void> {
  return changeSimulation(async () => {
    if (simulation?.owner === owner) await clearSimulation();
  });
}

/**
 * The demo lab's incidents.
 *
 * Starting an incident in the simulated servers, ending it, and how the run that worked it is scored.
 * Also the demo's own scripted workforce run, and switching the demo lab on and off.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
export class SimulationPart {
  /**
   * Starts an incident in the demo lab: its servers with the fault in them,
   * what the team wrote about it in chat, what a teammate did, and the alert
   * that reports it, which becomes a ticket like any alert. Whatever scenario
   * ran before is gone.
   */
  async startSimulation(this: HubService, scenarioId: string): Promise<void> {
    if (!isDemoMode()) throw new Error("Scenarios run in the demo lab only: start sshs3 in demo mode.");
    const scenario = scenarioById(scenarioId);
    if (!scenario) throw new Error("There is no such scenario.");
    return changeSimulation(async () => {
      if (this.disposed) return;
      await clearSimulation();
      try {
        await installSimulation(this, scenario);
      } catch (error) {
        await clearSimulation();
        throw error;
      }
    });
  }

  async endSimulation(): Promise<void> {
    await changeSimulation(async () => {
      await clearSimulation();
      if (isDemoMode() && !process.env.VITEST) ensureBaseFleet();
    });
  }

  /** Seeds local demo-only proposals, example eval cases, daily report, runbooks, and base fleet. */
  seedDemoWorkspaceState(this: HubService): void {
    const now = Date.now();
    // 1. Ensure always-on stateful base fleet is available in live demo sessions when no scenario is active.
    if (!simulation && isDemoMode() && !process.env.VITEST) ensureBaseFleet();
    // 2. Seed 2 clearly-labelled demo MemoryProposals when none exist yet.
    if (!(this.store.data.memoryProposals?.length)) {
      const proposals: MemoryProposal[] = [
        {
          id: "demo-prop-alua-group-by-prio",
          op: "add",
          kind: "memory",
          scope: "K8s-Trident-CSI-Prod",
          title: "Example proposal: ONTAP ALUA requires group_by_prio",
          text: "Demo example: Kubernetes workers mounting NetApp ONTAP LUNs must set path_grouping_policy group_by_prio in /etc/multipath.conf and reload with multipath -r.",
          evidence: "Observed during demo lab incident k8s-pvc-mount-cascade on k8s-worker-01.",
          sourceId: "demo-lab-seed",
          sourceTitle: "Demo lab example (no AI model)",
          createdAt: now - 45 * 60_000,
        },
        {
          id: "demo-prop-wal-archive-gateway",
          op: "add",
          kind: "memory",
          scope: "NetApp-StorageGRID-S3",
          title: "Example proposal: PostgreSQL WAL archive uses StorageGRID",
          text: "Demo example: PostgreSQL WAL archiving targets s3.storagegrid.acme.internal:10443. Never delete pg_wal files by hand when the archive gateway changes.",
          evidence: "Observed during demo lab incident pg-wal-full on pg-prod-db01.",
          sourceId: "demo-lab-seed",
          sourceTitle: "Demo lab example (no AI model)",
          createdAt: now - 90 * 60_000,
        },
      ];
      this.store.data.memoryProposals = proposals;
    }
    // 3. Seed 2 clearly-labelled example EvalCases when none exist yet.
    if (!(this.store.data.evalCases?.length)) {
      const cases: EvalCase[] = [
        {
          id: "demo-eval-pg-wal-check",
          title: "Example eval: PostgreSQL WAL disk full diagnosis",
          prompt: "Check why /var/lib/postgresql is at 97% on pg-prod-db01 without deleting WAL segments.",
          mode: "assisted",
          recorded: [
            { name: "terminal_command", input: "df -h /var/lib/postgresql", output: "/dev/nvme1n1 60G 59G 1.8G 97% /var/lib/postgresql" },
            { name: "terminal_command", input: "cat /etc/default/wal-archive", output: "ARCHIVE_ENDPOINT=https://sg-gw-01.acme.internal:8082" },
          ],
          expect: {
            mention: ["wal-archive", "sg-gw-01"],
            notMention: ["rm -rf pg_wal"],
            mustCall: ["df -h"],
            mustNotRun: ["rm -rf"],
          },
          runs: [],
          createdBy: "Demo lab (example)",
          createdAt: now - 120 * 60_000,
          updatedAt: now - 120 * 60_000,
        },
        {
          id: "demo-eval-ontap-qos",
          title: "Example eval: ONTAP noisy neighbour QoS cap",
          prompt: "Find which volume is causing high latency on aggr1_nvme_prod without taking it offline.",
          mode: "assisted",
          recorded: [
            { name: "terminal_command", input: "qos statistics volume latency show", output: "vol_pg_prod 38.4ms | vol_ai_scratch 4.1ms" },
          ],
          expect: {
            mention: ["vol_ai_scratch", "pg-nonprod-capped"],
            notMention: ["volume offline"],
            mustCall: ["qos statistics"],
            mustNotRun: ["volume offline"],
          },
          runs: [],
          createdBy: "Demo lab (example)",
          createdAt: now - 180 * 60_000,
          updatedAt: now - 180 * 60_000,
        },
      ];
      this.store.data.evalCases = cases;
    }
    // 4. Seed a local dailyReport via buildDailyReport() (deterministic, no LLM) when none exists yet.
    if (!this.store.data.dailyReport) {
      const at = new Date(now);
      const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
      this.store.data.dailyReport = {
        day,
        at: now,
        text: buildDailyReport({
          since: now - 24 * 60 * 60_000,
          now,
          activity: getDemoActivityLog(),
          tickets: this.store.data.workTickets ?? [],
          tasks: this.store.data.tasks,
          pages: this.store.data.kbPages ?? [],
          memories: getDemoMemories(),
          findings: [],
          schedules: getDemoSchedules(),
        }),
      };
    }
    // 5. Seed 2 executable RunbookTemplates targeting simulated servers when none exist yet.
    const extra = this.storeDataExtra();
    if (!(extra.runbooks?.length)) {
      const runbooks: RunbookTemplate[] = [
        {
          id: "demo-runbook-k8s-multipath",
          name: "Demo runbook: Check Kubernetes worker multipath and kubelet",
          description: "Example runbook targeting simulated K8s worker nodes to verify DM-Multipath ALUA policy and kubelet health.",
          inputs: [{ name: "policy", label: "Expected multipath policy", type: "string", required: true, defaultValue: "group_by_prio" }],
          steps: [
            { id: "step-1", title: "Inspect multipath paths", kind: "command", command: "multipath -ll", expected: "{{policy}}" },
            { id: "step-2", title: "Verify kubelet service", kind: "command", command: "systemctl is-active kubelet", expected: "active" },
          ],
          targetSelector: { cluster: "K8s-Trident-CSI-Prod" },
          dispatchStrategy: "sequential",
          author: "Demo lab (example)",
          createdAt: now - 240 * 60_000,
          updatedAt: now - 240 * 60_000,
        },
        {
          id: "demo-runbook-ontap-health",
          name: "Demo runbook: Check ONTAP aggregates and volumes",
          description: "Example runbook targeting simulated NetApp ONTAP controllers to inspect aggregates, volumes, and export policies.",
          inputs: [],
          steps: [
            { id: "step-1", title: "Show ONTAP aggregates", kind: "command", command: "storage aggregate show", expected: "aggr1_nvme_prod" },
            { id: "step-2", title: "Show ONTAP volumes", kind: "command", command: "volume show", expected: "online" },
          ],
          targetSelector: { cluster: "NetApp-ONTAP-Prod-SE" },
          dispatchStrategy: "sequential",
          author: "Demo lab (example)",
          createdAt: now - 240 * 60_000,
          updatedAt: now - 240 * 60_000,
        },
      ];
      extra.runbooks = runbooks;
    }
  }

  /** The scenarios, and how the running one stands: read off the lab each time it is asked. */
  simulationView(this: HubService): SimulationView {
    const run = simulation;
    const scenarios = SCENARIOS.map((s) => ({
      id: s.id,
      title: s.title,
      story: s.story,
      target: s.target,
      prompt: s.prompt,
      ...(s.tags?.length ? { tags: s.tags } : {}),
    }));
    if (!run) return { scenarios };
    const { scenario, startedAt, lastReplay } = run;
    // Every viewer sees the shared lab, but reports and tickets belong to the hub that started it.
    const ticketId = run.owner === this ? run.ticketId : undefined;
    const ticket = ticketId ? this.store.data.workTickets?.find((t) => t.id === ticketId) : undefined;
    const names = new Set(scenario.servers.map((s) => s.name));
    const report = run.owner === this ? [...this.store.data.tasks]
      .filter((t) => t.createdAt >= startedAt - 1000 && !active(t) && (t.id === ticket?.taskId || names.has(t.target?.label ?? "")))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => [...t.messages].reverse().find((m) => m.role === "assistant" && m.text.trim())?.text)
      .find(Boolean) : undefined;
    const effectiveReport = report ?? ticket?.result ?? (lastReplay?.mode === "careful" ? scenario.story : undefined);
    const score = scoreScenario(scenario, { world: run.world, report: effectiveReport });
    return {
      scenarios,
      running: {
        id: scenario.id,
        title: scenario.title,
        startedAt,
        target: scenario.target,
        ticketId,
        ...(scenario.tags?.length ? { tags: scenario.tags } : {}),
        servers: scenario.servers.map((s) => ({ id: s.id, name: s.name })),
        ...(lastReplay ? { lastReplay } : {}),
        checks: score.checks,
        passed: score.passed,
        total: score.total,
        commands: score.commands,
        unsupported: score.unsupported.slice(0, 20),
      },
    };
  }

  /** The scripted demo-mode workforce run. No model is called; the run says so. */
  async simulateDemoWorkforceRun(this: HubService, opts: {
    prompt: string;
    agentIds?: string[];
    targetCluster?: string;
    createTask?: boolean;
  }): Promise<WorkforceRun> {
    const extra = await this.collectExtraContext();
    const allServers = extra.workspaceServers ?? [];
    const kbDocs = this.getKbDocumentsList();

    let selectedAgents = this.selectWorkforceAgents(opts);

    if (selectedAgents.length === 0) {
      selectedAgents = [
        {
          id: "default-sre-specialist",
          name: "General Infrastructure SRE",
          role: "Linux, SSH & S3 Specialist",
          icon: "🤖",
          mission: "Inspect cluster nodes, services, and storage health.",
          systemPrompt: "",
          defaultMode: "assisted",
          updatedAt: Date.now(),
        },
      ];
    }

    const allMemories = extra.memories ?? this.store.data.memories;
    const allEdges = this.getInfraEdgesList();

    const steps: WorkforceStep[] = selectedAgents.map((ag, idx) => {
      const cluster = ag.targetCluster || opts.targetCluster || "Workspace";
      const clusterNodes = allServers.filter(
        (s) =>
          cluster === "Workspace" ||
          (s.cluster && s.cluster.toLowerCase() === cluster.toLowerCase()),
      );
      const kbMatches = this.kb.search(kbDocs, {
        query: `${opts.prompt} ${ag.role} ${cluster}`,
        cluster,
        limit: 2,
      });
      const rankedSkills = this.kb
        .rankMemories(allMemories, `${opts.prompt} ${ag.role}`, cluster, 2)
        .filter((m) => m.kind === "skill");
      const relatedEdges = allEdges.filter((e) =>
        clusterNodes.some(
          (n) =>
            n.name.toLowerCase() === e.from.toLowerCase() ||
            n.name.toLowerCase() === e.to.toLowerCase(),
        ),
      );
      const nodeNames =
        clusterNodes.slice(0, 3).map((n) => n.name).join(", ") || cluster;
      const kbHint =
        kbMatches.length > 0
          ? `From the knowledge base, "${kbMatches[0].title}": ${kbMatches[0].snippet.slice(0, 160)}…`
          : `Looked at ${clusterNodes.length || 1} node${(clusterNodes.length || 1) === 1 ? "" : "s"} (${nodeNames}) for the mission "${ag.mission.slice(0, 90)}".`;
      const skillHint =
        rankedSkills.length > 0
          ? ` [Skill: ${rankedSkills[0].title}]`
          : "";
      const edgeHint =
        relatedEdges.length > 0
          ? ` [Depends: ${relatedEdges[0].from} → ${relatedEdges[0].to} (${relatedEdges[0].relation})]`
          : "";

      const recCmds = [
        ...(rankedSkills
          .map((s) => s.sourceCommand)
          .filter((c): c is string => Boolean(c))),
        ...(cluster.toLowerCase().includes("ontap")
          ? [
              "qos statistics volume latency show -iterations 1",
              "snapmirror show",
            ]
          : cluster.toLowerCase().includes("ceph")
            ? ["ceph status && ceph osd df tree", "zpool status -v"]
            : cluster.toLowerCase().includes("k8s") ||
                cluster.toLowerCase().includes("trident")
              ? [
                  "kubectl get pvc,volumeattachment -A -o wide",
                  "multipath -ll",
                ]
              : ["uptime && df -h && systemctl --failed"]),
      ].slice(0, 3);

      return {
        id: `wf-step-${Date.now()}-${idx}`,
        agentId: ag.id,
        agentName: ag.name,
        agentIcon: ag.icon || "🤖",
        role: ag.role,
        targetCluster: cluster,
        subTask: `Part for ${ag.name} (${cluster}): ${opts.prompt.slice(0, 140)}`,
        status: "completed",
        findings: `In scope, not checked: ${nodeNames}. ${kbHint}${skillHint}${edgeHint}`,
        recommendedCommands: recCmds,
      };
    });

    const synthesis = [
      `### Workforce summary (${steps.length} specialist agents, in parallel)`,
      "> **Demo mode:** this is a scripted run. No model was called and nothing was checked.",
      `Mission: **${opts.prompt}**`,
      "",
      ...steps.map(
        (s, i) =>
          `${i + 1}. **${s.agentName}** (*${s.targetCluster || s.role}*): ${s.findings}`,
      ),
      "",
      "**Next:** go through the suggested checks per cluster, or run them on every node at once with `sshs3_cluster_exec`.",
    ].join("\n");

    const run: WorkforceRun = {
      id: `wf-${crypto.randomUUID().slice(0, 8)}`,
      title: clip(opts.prompt, 90),
      prompt: boundedContext(opts.prompt, 2000),
      leadAgentName: "Lead SRE Workforce Orchestrator",
      targetCluster: opts.targetCluster || "ALL",
      status: "completed",
      steps,
      synthesis,
      simulated: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.storeWorkforceRun(run);
    saveDemoWorkforceRun(run);

    if (opts.createTask) {
      const now = Date.now();
      const wfTask: AgentTask = {
        id: crypto.randomUUID(),
        title: `Workforce: ${run.title}`,
        agentName: run.leadAgentName,
        mode: "assisted",
        status: "completed",
        messages: [
          {
            id: crypto.randomUUID(),
            role: "user",
            text: `[Multi-Agent Workforce] ${opts.prompt}`,
            at: now - 1000,
          },
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: synthesis,
            at: now,
          },
        ],
        changes: [],
        sources: [],
        createdAt: now - 1000,
        updatedAt: now,
        maxCommands: 20,
        maxMinutes: 15,
        verification: "not-verified",
      };
      this.store.data.tasks.push(wfTask);
    }

    return run;
  }
  /** The requests this part answers. What a case leaves in `reply` goes back with the snapshot. */
  async handleSimulation(this: HubService, request: RequestsOf<"simulation">): Promise<Handled> {
    switch (request.action) {
      case "demo-mode-toggle": {
        // Demo mode never changes inside a running process (demo/demoMode.ts): switching it means a
        // restart, which only the desktop host offers, and only after the user has confirmed it there.
        const demoMode = Boolean(request.enabled);
        if (demoMode !== isDemoMode()) {
          if (!this.host.relaunchForDemoMode)
            throw new Error(
              "Demo mode is set when the sshs3 server starts (--demo or SSHS3_DEMO=1) and can't be changed here.",
            );
          await this.host.relaunchForDemoMode(demoMode);
        }
        return { snapshot: await this.snapshot() };
      }
      case "sim-start":
        await this.startSimulation(requiredText(request.scenarioId));
        break;
      case "sim-reset":
        await this.endSimulation();
        break;
      case "sim-replay": {
        if (!isDemoMode()) throw new Error("Scripted walkthroughs run in the demo lab only.");
        const run = simulation;
        if (!run) throw new Error("Start a scenario first before running a scripted walkthrough.");
        const mode = request.mode === "careless" ? "careless" : "careful";
        const script = run.scenario.solutions[mode];
        const results = runLines(run.world, script);
        const transcript = results.map((r) => `$ ${r.line}${r.code ? ` [exit ${r.code}]` : ""}${r.output.trim() ? `\n${clip(r.output.trim(), 240)}` : ""}`);
        run.lastReplay = {
          mode,
          ran: results.length,
          at: new Date().toISOString(),
          lines: transcript.slice(0, 20),
        };
        const score = scoreScenario(run.scenario, {
          world: run.world,
          report: mode === "careful" ? run.scenario.story : "Applied quick workaround.",
        });
        this.changed();
        return {
          reply: {
            simReplay: {
              ok: true,
              ran: results.length,
              score: {
                passed: score.passed,
                total: score.total,
                commands: score.commands,
                checks: score.checks,
                unsupported: score.unsupported,
              },
              transcript,
            },
            notes: [
              `Scripted ${mode} walkthrough (no AI model): ran ${results.length} commands, ${score.passed} of ${score.total} checks pass.`,
            ],
          },
        };
      }
      case "sim-advance-time": {
        if (!isDemoMode()) throw new Error("Advancing simulated time works in the demo lab only.");
        const minutes = Number(request.minutes);
        if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 10080) {
          throw new Error("Minutes must be a positive number up to 10080 (7 days).");
        }
        const world = simulation?.world ?? simWorld();
        world.advance(Math.round(minutes * 60_000));
        this.changed();
        return {
          reply: {
            notes: [`Advanced simulated lab clock by ${Math.round(minutes)} minute${Math.round(minutes) === 1 ? "" : "s"}.`],
          },
        };
      }
      default: {
        // Every request of this part has a case above: one that is given to it and not handled does not compile.
        const unhandled: never = request;
        throw new Error(`Unknown AI request: ${String((unhandled as { action?: unknown })?.action)}`);
      }
    }
    return {};
  }
}
