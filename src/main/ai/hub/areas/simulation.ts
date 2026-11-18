import crypto from "node:crypto";
import type { AgentTask, WorkforceRun, SimulationView, WorkforceStep, WorkspaceActivityEvent } from "../../../../shared/types/aiHub";
import { savePageByPerson } from "../KbCompile";
import { runningScenario, SCENARIOS, scenarioById, scoreRunning, startScenario, stopScenario } from "../../../sim/lab";
import { parseAlerts } from "../AlertIntake";
import { upsertDemoServer, deleteDemoServer, appendDemoActivity, isDemoMode, saveDemoWorkforceRun } from "../demoWorkspace";
import { boundedContext, clip } from "../privacy";
import { requiredText } from "../hubHelpers";
import { active } from "../hubShared";
import type { HubService } from "../HubService";
import type { Handled, RequestsOf } from "./routes";

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
    await this.endSimulation();
    const world = startScenario(scenario);
    // What is run on the lab's servers changes how the scenario stands: the interface is told, not more than twice a second.
    let told: ReturnType<typeof setTimeout> | undefined;
    world.onRan = () => {
      told ??= setTimeout(() => {
        told = undefined;
        if (!this.disposed) this.changed();
      }, 400);
    };
    const now = world.now();
    // The team's own page for this kind of trouble: there while the scenario runs, as it would be in a team that had met it before.
    let pageId: string | undefined;
    if (scenario.runbook) {
      const page = savePageByPerson(undefined, { kind: "troubleshooting", title: scenario.runbook.title, when: scenario.runbook.when, body: scenario.runbook.body, targets: [...new Set(scenario.servers.map((x) => x.cluster))], keys: scenario.runbook.keys }, "the team (demo lab)");
      this.store.data.kbPages = [...(this.store.data.kbPages ?? []), page];
      pageId = page.id;
    }
    for (const server of scenario.servers)
      upsertDemoServer({ id: server.id, name: server.name, host: server.host, username: server.username, cluster: server.cluster, folder: `Scenario / ${server.cluster}`, description: server.description, tags: server.tags, shared: false });
    // The chat first: the alert's ticket looks through it.
    const said = scenario.chat ?? [];
    const channels = [...new Set(said.map((m) => m.channel))].map((name, i) => ({ id: `CSIM${i + 1}`, name }));
    const tsOf = (minutesAgo: number): string => ((now - minutesAgo * 60_000) / 1000).toFixed(6);
    await this.chat.simulate(
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
    this.simulation = { startedAt: now, servers: scenario.servers.map((s) => s.id), pageId };
    if (scenario.alert) {
      const made = await this.takeAlerts(
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
      this.simulation.ticketId = made.created[0];
    }
    this.changed();
  }

  /** Takes the lab back to having no scenario: its servers, its chat and its ticket go. */
  async endSimulation(this: HubService): Promise<void> {
    const had = this.simulation;
    stopScenario();
    await this.chat.endSimulation();
    if (!had) return;
    this.simulation = undefined;
    for (const id of had.servers) deleteDemoServer(id);
    if (had.pageId) this.store.data.kbPages = (this.store.data.kbPages ?? []).filter((p) => p.id !== had.pageId);
    // Opening a terminal to one saved it as a profile of this person's: that goes too.
    for (const id of had.servers) await this.host.deleteServer?.(id).catch(() => undefined);
    // Nothing of the lab stays in what the team shares.
    if (this.store.data.s3SyncedServers?.some((x) => had.servers.includes(x.id))) this.store.data.s3SyncedServers = this.store.data.s3SyncedServers.filter((x) => !had.servers.includes(x.id));
    const ticket = had.ticketId ? this.store.data.workTickets?.find((t) => t.id === had.ticketId && !t.deleted) : undefined;
    if (ticket && ticket.status !== "in_progress") this.putTicket({ ...ticket, deleted: true, deletedBy: "the demo lab", updatedAt: Date.now() });
    this.changed();
  }

  /** The scenarios, and how the running one stands: read off the lab each time it is asked. */
  simulationView(this: HubService): SimulationView {
    const scenario = runningScenario();
    const scenarios = SCENARIOS.map((s) => ({ id: s.id, title: s.title, story: s.story, target: s.target, prompt: s.prompt }));
    if (!scenario || !this.simulation) return { scenarios };
    // What whoever worked on it said at the end: the latest finished conversation about its server or its ticket.
    const ticket = this.simulation.ticketId ? this.store.data.workTickets?.find((t) => t.id === this.simulation!.ticketId) : undefined;
    const names = new Set(scenario.servers.map((s) => s.name));
    const report = [...this.store.data.tasks]
      .filter((t) => t.createdAt >= this.simulation!.startedAt - 1000 && !active(t) && (t.id === ticket?.taskId || names.has(t.target?.label ?? "")))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => [...t.messages].reverse().find((m) => m.role === "assistant" && m.text.trim())?.text)
      .find(Boolean);
    const score = scoreRunning(report ?? ticket?.result)!;
    return {
      scenarios,
      running: {
        id: scenario.id,
        title: scenario.title,
        startedAt: this.simulation.startedAt,
        target: scenario.target,
        ticketId: this.simulation.ticketId,
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
      default: {
        // Every request of this part has a case above: one that is given to it and not handled does not compile.
        const unhandled: never = request;
        throw new Error(`Unknown AI request: ${String((unhandled as { action?: unknown })?.action)}`);
      }
    }
    return {};
  }
}
