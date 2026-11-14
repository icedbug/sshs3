import crypto from "node:crypto";
import type {
  AgentChange,
  AgentTask,
  InfraGraphEdge,
  KbDocument,
  MemoryEntry,
  SelfLearningEvent,
  SelfLearningStatus,
  TerminalCommandFailure,
  WorkspaceActivityEvent,
  WorkspaceServerSummary,
} from "../../../shared/types/aiHub";
import { KnowledgeBaseService, tokenize } from "./KnowledgeBaseService";
import type { HubStore } from "./HubStore";
import { maskContext } from "./privacy";

export function extractErrorSignature(
  command: string,
  snippet: string,
): string {
  const combined = `${command}\n${snippet}`.toLowerCase();
  const patterns: Array<[RegExp, string]> = [
    [/enospc|no space left on device|disk full|9[5-9]%/i, "err:storage_enospc"],
    [/broken-off|snapmirror.*lag|resync/i, "err:snapmirror_broken_off"],
    [/multipath|dead path|faulty|alua|iscsi.*session/i, "err:multipath_degraded"],
    [/crashloopbackoff|imagepullbackoff|oomkilled/i, "err:k8s_pod_crashloop"],
    [
      /mountvolume\.setup failed|attachvolume\.attach failed|pvc.*pending/i,
      "err:k8s_csi_mount_failed",
    ],
    [/degraded|pg_availability|osd.*down|scrub error/i, "err:ceph_zfs_degraded"],
    [/permission denied|eacces|unauthorized|publickey/i, "err:auth_permission_denied"],
    [/connection refused|timed out|unreachable|no route to host/i, "err:network_unreachable"],
    [/deadlock|remaining connection slots|too many clients/i, "err:db_connection_exhausted"],
    [/command not found|no such file or directory/i, "err:missing_binary_or_path"],
    [/failed to start|unit .* failed|systemctl/i, "err:systemd_service_failed"],
  ];
  for (const [regex, sig] of patterns) {
    if (regex.test(combined)) return sig;
  }
  const cmdBase = command.trim().split(/\s+/)[0] || "cmd";
  const errTokens = tokenize(snippet).slice(0, 4).join("_");
  return `err:${cmdBase}:${errTokens || "nonzero_exit"}`;
}

/**
 * Whether a command only made sense for the file or the moment it was written for: guarded by a
 * checksum of the file as it was, an edit of one numbered line, a text written in place, or a name
 * with that day's date in it. Run again later it is refused or changes the wrong line, so it is a
 * record of what was done (the activity log and the session keep that), never a skill to reuse.
 */
export function isOneOffCommand(command: string): boolean {
  return (
    // A checksum: of the file as it was (`echo <hash> | sha256sum -c -`), or any other long hash.
    /\b[0-9a-f]{32,128}\b/i.test(command) ||
    /\b(?:sha\d*sum|md5sum|shasum|b2sum|cksum)\b[^|;&]*\s(?:-c|--check)\b/.test(command) ||
    // sed changing or deleting a line by its number.
    /\bsed\s[^|;&]*(?:-\w*i|--in-place)\S*\s+(?:-e\s)?\s*['"]?[\d,]+\s*[sdaicy]/.test(command) ||
    // A text written in place: the text is the change, not a procedure.
    /<<-?\s*['"\\]?\w+/.test(command) ||
    // A copy or a name stamped with a date or a time.
    /\b20\d{2}-?[01]\d-?[0-3]\d(?:\b|[T_]\d)/.test(command)
  );
}

/** Words that say nothing about what a request is about. */
const REQUEST_FILLER = new Set([
  "the", "for", "and", "when", "what", "how", "why", "with", "from", "this", "that", "are", "was", "all", "any", "its",
  "show", "list", "get", "give", "tell", "find", "check", "see", "look", "please", "can", "you", "out", "into", "does", "has", "have", "not", "now", "then", "there", "which", "much", "many",
]);

export class SelfLearningService {
  private recentEvents: SelfLearningEvent[] = [];
  private failureToFixCount = 0;
  private consolidatedCount = 0;
  private autoDiscoveredEdgeCount = 0;
  private lastReflectionAt?: number;
  private store?: HubStore;

  constructor(
    private readonly kb: KnowledgeBaseService,
    store?: HubStore,
  ) {
    if (store) this.bindStore(store);
  }

  bindStore(store: HubStore): void {
    this.store = store;
    const saved = store.data.selfLearningState;
    if (saved) {
      if (Array.isArray(saved.recentEvents)) {
        this.recentEvents = saved.recentEvents.slice(0, 25);
      }
      if (typeof saved.failureToFixCount === "number") {
        this.failureToFixCount = saved.failureToFixCount;
      }
      if (typeof saved.consolidatedCount === "number") {
        this.consolidatedCount = saved.consolidatedCount;
      }
      if (typeof saved.autoDiscoveredEdgeCount === "number") {
        this.autoDiscoveredEdgeCount = saved.autoDiscoveredEdgeCount;
      }
      if (typeof saved.lastReflectionAt === "number") {
        this.lastReflectionAt = saved.lastReflectionAt;
      }
    }
  }

  private syncToStore(): void {
    if (!this.store) return;
    this.store.data.selfLearningState = {
      recentEvents: this.recentEvents.slice(0, 25),
      failureToFixCount: this.failureToFixCount,
      consolidatedCount: this.consolidatedCount,
      autoDiscoveredEdgeCount: this.autoDiscoveredEdgeCount,
      lastReflectionAt: this.lastReflectionAt,
    };
  }

  private recordEvent(
    event: Omit<SelfLearningEvent, "id" | "createdAt">,
  ): SelfLearningEvent {
    const full: SelfLearningEvent = {
      ...event,
      title: maskContext(event.title),
      summary: maskContext(event.summary),
      id: `learn-${crypto.randomUUID().slice(0, 8)}`,
      createdAt: Date.now(),
    };
    this.recentEvents = [
      full,
      ...this.recentEvents.filter((e) => e.title !== full.title),
    ].slice(0, 25);
    this.syncToStore();
    return full;
  }

  /**
   * Voyager / Reflexion Failure-to-Fix Learner:
   * When a terminal command fails and a subsequent command on the same target succeeds,
   * automatically synthesizes or upgrades a reusable troubleshooting skill.
   */
  learnFromCommandResolution(params: {
    memories: MemoryEntry[];
    failure: {
      command: string;
      snippet: string;
      exitCode?: number;
      label: string;
    };
    fixCommand: string;
    fixOutput?: string;
    cluster?: string;
    scope?: string;
    /**
     * Shown to be the fix: a change whose own check passed afterwards and had
     * not passed before. Anything else is only what happened to succeed next,
     * kept as a low-confidence note that is never suggested as a command and
     * never takes the place of a proven fix.
     */
    proven?: boolean;
  }): { memories: MemoryEntry[]; learnedSkill?: MemoryEntry } {
    const { memories, failure, fixCommand, fixOutput, cluster, scope } = params;
    const proven = params.proven === true;
    const cleanFix = maskContext(fixCommand.trim());
    const cleanFail = maskContext(failure.command.trim());
    if (!cleanFix || cleanFix === cleanFail) {
      return { memories };
    }
    // An edit made for that one file as it was then is not a way to fix the next failure.
    if (isOneOffCommand(cleanFix)) {
      return { memories };
    }

    const maskedSnippet = maskContext(failure.snippet);
    const errorSignature = extractErrorSignature(cleanFail, maskedSnippet);
    const shortTarget = failure.label || scope || "workspace";
    // Named for what it is: the command that succeeded next, which may or may not be the fix.
    const title = `${proven ? "Fixed a failure" : "Seen after a failure"} (${shortTarget}): ${errorSignature.replace(/^err:/, "").replace(/_/g, " ")}`;
    const snippetClean = maskedSnippet.replace(/\s+/g, " ").trim().slice(0, 220);
    const fixOutClean = maskContext(fixOutput ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);

    const text = [
      `When \`${cleanFail}\` failed on ${shortTarget}${snippetClean ? ` with "${snippetClean}"` : ""}:`,
      proven
        ? `\`${cleanFix}\` fixed it: its check passed afterwards and had not passed before.`
        : `The next command that succeeded there was \`${cleanFix}\`. It has not been checked to be the fix.`,
      fixOutClean ? `What it printed: ${fixOutClean}` : "",
    ]
      .filter(Boolean)
      .join(" ");

    const merged = this.kb.deduplicateOrMergeMemory(memories, {
      kind: "skill",
      tier: proven ? "core" : "archival",
      cluster,
      scope: scope || `server:${shortTarget}`,
      title,
      text,
      author: "Voyager Self-Learning Engine",
      // Below what Ctrl+K and failure hints suggest (0.65), unless it was shown to be the fix.
      confidence: proven ? 0.89 : 0.5,
      autoLearned: true,
      sourceCommand: cleanFix,
      // A note of what was seen never merges into (and so never overwrites) a proven fix for the same error.
      errorSignature: proven ? errorSignature : `seen|${errorSignature}`,
      ...(proven ? { successCount: 1 } : {}),
      // A different proven fix for the same error takes the old one's place; the old one is kept as history.
      supersede: proven,
    });

    this.failureToFixCount += 1;
    this.recordEvent({
      kind: "failure_to_fix",
      title: `Noted what worked after a failure: ${errorSignature.replace(/^err:/, "")}`,
      summary: `After \`${cleanFail}\` failed on ${shortTarget}, \`${cleanFix}\` succeeded.`,
      targetCluster: cluster,
      confidence: merged.saved.confidence ?? 0.89,
      memoryId: merged.saved.id,
    });

    return {
      memories: merged.memories,
      learnedSkill: merged.saved,
    };
  }

  /**
   * Post-Task Reflexion Loop:
   * Inspects a completed or failed AgentTask, updates confidence/success metrics on used skills,
   * extracts failure->fix pairs within the task's command chain, and synthesizes new playbooks
   * when a multi-step task is verified.
   */
  reflectOnCompletedTask(params: {
    task: AgentTask;
    memories: MemoryEntry[];
    infraEdges: InfraGraphEdge[];
    servers: WorkspaceServerSummary[];
    cluster?: string;
  }): {
    memories: MemoryEntry[];
    infraEdges: InfraGraphEdge[];
    events: SelfLearningEvent[];
  } {
    let currentMemories = [...params.memories];
    let currentEdges = [...params.infraEdges];
    const createdEvents: SelfLearningEvent[] = [];
    const { task, cluster, servers } = params;

    const commandChanges = task.changes.filter(
      (c) => c.kind === "command" && c.command,
    );
    if (commandChanges.length === 0) {
      return {
        memories: currentMemories,
        infraEdges: currentEdges,
        events: createdEvents,
      };
    }

    // 1. Detect intra-task Failure -> Fix sequences (self-healing agent turns)
    let lastFailedChange: AgentChange | undefined;
    for (const change of commandChanges) {
      if (change.status === "failed" || (change.exitCode ?? 0) !== 0) {
        lastFailedChange = change;
      } else if (
        change.status === "completed" &&
        change.exitCode === 0 &&
        lastFailedChange
      ) {
        const res = this.learnFromCommandResolution({
          memories: currentMemories,
          failure: {
            command: lastFailedChange.command || "",
            snippet: lastFailedChange.output || "Command exited with non-zero code",
            exitCode: lastFailedChange.exitCode,
            label: change.target || task.target?.label || "terminal",
          },
          fixCommand: change.command || "",
          fixOutput: change.output,
          cluster,
          scope: change.target ? `server:${change.target}` : "workspace",
          proven: change.check?.after === true && change.check.before === false,
        });
        currentMemories = res.memories;
        lastFailedChange = undefined;
      }
    }

    // 2. Reinforce existing skills whose sourceCommand was successfully executed
    const succeededCommands = commandChanges.filter(
      (c) => c.status === "completed" && c.exitCode === 0 && c.command,
    );
    const failedCommands = commandChanges.filter(
      (c) => c.status === "failed" || (c.exitCode !== undefined && c.exitCode !== 0),
    );

    if (succeededCommands.length > 0 || failedCommands.length > 0) {
      currentMemories = currentMemories.map((mem) => {
        // The same command, exactly; and it counts as having worked only in a run that was verified.
        const matchedSuccess =
          task.verification === "verified" &&
          succeededCommands.some((c) => mem.sourceCommand && c.command?.trim() === mem.sourceCommand.trim());
        const matchedFail = failedCommands.some(
          (c) =>
            mem.sourceCommand &&
            c.command?.trim() === mem.sourceCommand.trim(),
        );
        if (!matchedSuccess && !matchedFail) return mem;

        const prevConf = mem.confidence ?? 0.82;
        const nextConf = matchedSuccess
          ? Math.min(0.99, Math.round((prevConf + 0.03) * 100) / 100)
          : Math.max(0.35, Math.round((prevConf - 0.06) * 100) / 100);
        return {
          ...mem,
          confidence: nextConf,
          successCount: (mem.successCount ?? 0) + (matchedSuccess ? 1 : 0),
          failureCount: (mem.failureCount ?? 0) + (matchedFail ? 1 : 0),
          usageCount: (mem.usageCount ?? 1) + 1,
          updatedAt: Date.now(),
        };
      });
    }

    // 3. Synthesize a verified Playbook Skill if the task was verified or completed with successful commands
    if (
      (task.verification === "verified" || task.status === "completed") &&
      succeededCommands.some((c) => !isOneOffCommand(maskContext(c.command!.trim())))
    ) {
      const uniqueCmds = [
        ...new Set(succeededCommands.map((c) => maskContext(c.command!.trim()))),
      ]
        // A playbook is steps to take again: an edit tied to one file as it was then is not one.
        .filter((cmd) => !isOneOffCommand(cmd))
        .slice(0, 4);
      const primaryCmd = uniqueCmds[0];
      const targetLabel =
        succeededCommands[0]?.target || task.target?.label || "workspace";
      const cleanTitle = maskContext(task.title)
        .replace(/^(AI|Run|Task):\s*/i, "")
        .trim()
        .slice(0, 72);

      const merged = this.kb.deduplicateOrMergeMemory(currentMemories, {
        kind: "skill",
        tier: task.verification === "verified" ? "core" : "archival",
        cluster,
        scope: cluster ? `cluster:${cluster}` : `server:${targetLabel}`,
        title: `Playbook: ${cleanTitle || primaryCmd}`,
        text: `Commands that completed on ${targetLabel} (${task.verification === "verified" ? "the task was verified" : "each exited 0; the result was not checked"}): ${uniqueCmds.map((cmd) => `\`${cmd}\``).join(" → ")}.`,
        author: "Reflexion Post-Task Learner",
        // Unverified steps are a record, not a recipe: below what is suggested as a command.
        confidence: task.verification === "verified" ? 0.92 : 0.6,
        autoLearned: true,
        sourceCommand: primaryCmd,
      });
      currentMemories = merged.memories;
      const ev = this.recordEvent({
        kind: "task_reflexion",
        title: `Wrote down the steps of a finished task: ${cleanTitle.slice(0, 40)}`,
        summary: `Kept ${uniqueCmds.length} commands that completed (${uniqueCmds.map((c) => `\`${c}\``).join(", ")}).`,
        targetCluster: cluster,
        confidence: merged.saved.confidence ?? 0.88,
        memoryId: merged.saved.id,
      });
      createdEvents.push(ev);
    }

    // 4. Auto-discover topology edges from command outputs and server relationships
    for (const change of succeededCommands) {
      const discovered = this.discoverTopologyEdges({
        targetLabel: change.target || task.target?.label || "",
        command: change.command || "",
        output: change.output || "",
        existingEdges: currentEdges,
        servers,
      });
      if (discovered.added > 0) {
        currentEdges = discovered.edges;
        createdEvents.push(...discovered.events);
      }
    }

    this.lastReflectionAt = Date.now();
    this.syncToStore();
    return {
      memories: currentMemories,
      infraEdges: currentEdges,
      events: createdEvents,
    };
  }

  /**
   * Automatically discovers InfraGraphEdge relations from server configs (proxyJump, tunnels)
   * and terminal command outputs (SnapMirror, NFS/iSCSI mounts, K8s PVCs).
   */
  discoverTopologyEdges(params: {
    targetLabel: string;
    command: string;
    output: string;
    existingEdges: InfraGraphEdge[];
    servers: WorkspaceServerSummary[];
  }): {
    edges: InfraGraphEdge[];
    added: number;
    events: SelfLearningEvent[];
  } {
    const { targetLabel, command, output, existingEdges, servers } = params;
    const nextEdges = [...existingEdges];
    const events: SelfLearningEvent[] = [];
    let added = 0;

    const addEdgeIfMissing = (
      from: string,
      to: string,
      relation: InfraGraphEdge["relation"],
      label: string,
    ) => {
      if (!from || !to || from === to) return;
      const exists = nextEdges.some(
        (e) =>
          e.from.toLowerCase() === from.toLowerCase() &&
          e.to.toLowerCase() === to.toLowerCase() &&
          e.relation === relation,
      );
      if (!exists) {
        const edge: InfraGraphEdge = {
          id: `edge-auto-${crypto.randomUUID().slice(0, 8)}`,
          from,
          to,
          relation,
          label,
          updatedAt: Date.now(),
        };
        nextEdges.unshift(edge);
        added += 1;
        this.autoDiscoveredEdgeCount += 1;
        events.push(
          this.recordEvent({
            kind: "topology_discovery",
            title: `Noticed a link: ${from} → ${to}`,
            summary: `Found automatically (${relation}: ${label}).`,
            confidence: 0.9,
          }),
        );
      }
    };

    // Inspect server proxyJump & SSH tunnels
    for (const srv of servers) {
      if (srv.proxyJumpProfileId || srv.proxyJump) {
        const jumpTarget =
          servers.find((s) => s.id === srv.proxyJumpProfileId)?.name ||
          srv.proxyJump ||
          "bastion";
        addEdgeIfMissing(
          jumpTarget,
          srv.name || srv.id,
          "ssh_tunnel",
          "Auto-discovered ProxyJump",
        );
      }
    }

    // Inspect SnapMirror output for replication edges
    if (/snapmirror/i.test(command) || /snapmirror/i.test(output)) {
      const lines = output.split("\n");
      for (const line of lines) {
        const match = /([a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+)\s+.*?\s+([a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+)/.exec(
          line,
        );
        if (match) {
          addEdgeIfMissing(
            match[1].split(":")[0],
            match[2].split(":")[0],
            "replicates_to",
            `SnapMirror ${match[1]} -> ${match[2]}`,
          );
        }
      }
    }

    // Inspect NFS / iSCSI mount output
    if (targetLabel && (/mount|df|iscsiadm/i.test(command))) {
      for (const srv of servers) {
        if (
          srv.name !== targetLabel &&
          (output.includes(srv.host) || output.includes(srv.name))
        ) {
          addEdgeIfMissing(
            targetLabel,
            srv.name,
            "mounts_storage",
            `Detected mount reference in ${command.split(/\s+/)[0]}`,
          );
        }
      }
    }

    return { edges: nextEdges.slice(0, 120), added, events };
  }

  /**
   * Runs a full Self-Reflection & Memory Consolidation cycle across the workspace:
   * 1. Consolidates episodic server logs into high-signal Core/Archival Skills.
   * 2. Scans completed tasks to ensure all verified command sequences are saved as Playbooks.
   * 3. Auto-discovers infrastructure graph edges from server profiles & tunnels.
   */
  runReflectionCycle(params: {
    memories: MemoryEntry[];
    tasks: AgentTask[];
    activityLog: WorkspaceActivityEvent[];
    infraEdges: InfraGraphEdge[];
    servers: WorkspaceServerSummary[];
    lastFailures: Record<string, TerminalCommandFailure>;
    targetCluster?: string;
  }): {
    memories: MemoryEntry[];
    infraEdges: InfraGraphEdge[];
    events: SelfLearningEvent[];
  } {
    let currentMemories = [...params.memories];
    let currentEdges = [...params.infraEdges];
    const events: SelfLearningEvent[] = [];

    // 1. Reflect on finished tasks not reflected on yet, newest first. A task is reflected on once:
    // doing it again every night raised confidence and "worked ×N" with no new evidence.
    for (const task of [...params.tasks].reverse().filter((t) => !t.reflectedAt).slice(0, 12)) {
      if (task.status === "completed" || task.verification === "verified") {
        task.reflectedAt = Date.now();
        const res = this.reflectOnCompletedTask({
          task,
          memories: currentMemories,
          infraEdges: currentEdges,
          servers: params.servers,
          cluster: params.targetCluster,
        });
        currentMemories = res.memories;
        currentEdges = res.infraEdges;
        events.push(...res.events);
      }
    }

    // 2. Consolidate episodic memories that have been updated multiple times into Core/Archival Skills
    const episodicEntries = currentMemories.filter(
      (m) => m.tier === "episodic",
    );
    for (const ep of episodicEntries) {
      if ((ep.updatedCount ?? 1) >= 2 || ep.text.length >= 120) {
        const maskedEpText = maskContext(ep.text);
        const cmdMatches = [...maskedEpText.matchAll(/`([^`]{3,80})`/g)].map(
          (m) => m[1],
        );
        const primaryCmd = cmdMatches[0];
        const maskedSourceCmd = primaryCmd ?? (ep.sourceCommand ? maskContext(ep.sourceCommand) : undefined);
        const merged = this.kb.deduplicateOrMergeMemory(currentMemories, {
          id: ep.id,
          kind: primaryCmd ? "skill" : "memory",
          tier: "core",
          cluster: ep.cluster || params.targetCluster,
          scope: ep.scope,
          title: maskContext(ep.title).replace(/^(Senaste aktivitet p\u00e5|Recent activity on)/i, "Operating profile:"), // also the title older versions wrote, in Swedish
          text: `${maskedEpText} [Merged from repeated notes into a core memory.]`,
          author: "Letta/Mem0 Memory Consolidator",
          confidence: Math.min(0.95, (ep.confidence ?? 0.78) + 0.08),
          autoLearned: true,
          sourceCommand: maskedSourceCmd,
        });
        currentMemories = merged.memories;
        this.consolidatedCount += 1;
        events.push(
          this.recordEvent({
            kind: "memory_consolidation",
            title: `Promoted an episodic memory to core: ${merged.saved.title.slice(0, 42)}`,
            summary: `Merged what kept recurring in ${ep.scope} into a core memory.`,
            targetCluster: ep.cluster || params.targetCluster,
            confidence: merged.saved.confidence ?? 0.86,
            memoryId: merged.saved.id,
          }),
        );
      }
    }

    // 3. Synthesize proactive diagnostic skills for any active unresolved terminal failures
    for (const failure of Object.values(params.lastFailures)) {
      const cleanFailCmd = maskContext(failure.command);
      const cleanFailSnippet = maskContext(failure.snippet);
      const sig = extractErrorSignature(cleanFailCmd, cleanFailSnippet);
      const recommendedFix = maskContext(
        this.suggestDiagnosticCommandForSignature(sig, cleanFailCmd),
      );
      const merged = this.kb.deduplicateOrMergeMemory(currentMemories, {
        kind: "skill",
        // A suggestion from the kind of error, never tried: not something to put in front of every run.
        tier: "archival",
        cluster: params.targetCluster,
        scope: `server:${failure.label}`,
        title: `Check after a failure (${failure.label}): ${sig.replace(/^err:/, "").replace(/_/g, " ")}`,
        text: `When \`${cleanFailCmd}\` fails (${cleanFailSnippet.slice(0, 120)}): a read-only check to narrow it down is \`${recommendedFix}\`. A suggestion from the kind of error, not something that was tried.`,
        author: "Voyager Self-Learning Engine",
        // Never tried: below what is suggested as a command, and in a namespace of its own, so it never
        // merges into (and overwrites) what was learned about the same error from a real fix.
        confidence: 0.5,
        autoLearned: true,
        sourceCommand: recommendedFix,
        errorSignature: `guess|${sig}`,
      });
      currentMemories = merged.memories;
    }

    // 4. Discover topology edges from server profiles
    const topo = this.discoverTopologyEdges({
      targetLabel: "",
      command: "",
      output: "",
      existingEdges: currentEdges,
      servers: params.servers,
    });
    currentEdges = topo.edges;
    events.push(...topo.events);

    if (events.length === 0) {
      events.push(
        this.recordEvent({
          kind: "memory_consolidation",
          title: "Went through the memories and skills",
          summary: `Looked at ${currentMemories.length} memories and skills and adjusted their weight from how often they helped.`,
          targetCluster: params.targetCluster,
          confidence: 0.91,
        }),
      );
    }

    this.lastReflectionAt = Date.now();
    this.syncToStore();
    return {
      memories: currentMemories,
      infraEdges: currentEdges,
      events,
    };
  }

  suggestDiagnosticCommandForSignature(
    signature: string,
    failedCommand: string,
  ): string {
    switch (signature) {
      case "err:storage_enospc":
        return "df -hT && du -xhd1 /var/log 2>/dev/null | sort -hr | head -n 10";
      case "err:snapmirror_broken_off":
        return "snapmirror show -fields state,status,lag-time,last-transfer-error";
      case "err:multipath_degraded":
        return "multipath -ll && iscsiadm -m session -P 3";
      case "err:k8s_pod_crashloop":
        return "kubectl get pods -A --field-selector=status.phase!=Running && kubectl get events -A --sort-by=.lastTimestamp | tail -n 15";
      case "err:k8s_csi_mount_failed":
        return "kubectl get pvc,pv -A && kubectl -n trident get pods -o wide";
      case "err:ceph_zfs_degraded":
        return "ceph health detail || zpool status -xv";
      case "err:systemd_service_failed":
        return "systemctl --failed && journalctl -xe -n 25 --no-pager";
      case "err:network_unreachable":
        return "ss -tulpn && ip -br addr";
      default:
        return `${failedCommand.split(/\s+/)[0]} --help || journalctl -n 20 --no-pager`;
    }
  }

  /**
   * Applies user thumbs-up (+1) or thumbs-down (-1) reinforcement feedback to a MemoryEntry.
   */
  /**
   * Somebody says a memory was useful, or not. One vote per person (a second
   * click changes their vote, it does not add one); the score is the sum of
   * the votes. A vote does not pin the entry for the team (pinning is its own
   * choice) and does not count as the entry having worked in a run: that
   * count is for runs that ended verified.
   */
  applyMemoryFeedback(
    memories: MemoryEntry[],
    id: string,
    delta: 1 | -1,
    voter = "someone",
  ): { memories: MemoryEntry[]; updated?: MemoryEntry } {
    let updatedTarget: MemoryEntry | undefined;
    const next = memories.map((m) => {
      if (m.id !== id) return m;
      const votes = { ...(m.votes ?? {}) };
      const before = votes[voter] ?? 0;
      votes[voter] = delta;
      const change = delta - before;
      const prevConf = m.confidence ?? (m.kind === "skill" ? 0.82 : 0.75);
      const nextConf = Math.max(0.2, Math.min(0.99, Math.round((prevConf + change * 0.03) * 100) / 100));
      updatedTarget = {
        ...m,
        votes,
        confidence: nextConf,
        feedbackScore: Object.values(votes).reduce((sum: number, v) => sum + v, 0),
        updatedAt: Date.now(),
      };
      return updatedTarget;
    });

    if (updatedTarget) {
      this.recordEvent({
        kind: "user_feedback",
        title: `${delta > 0 ? "Raised" : "Lowered"} a memory or skill: ${updatedTarget.title.slice(0, 42)}`,
        summary: `Feedback (${delta > 0 ? "+1" : "-1"}) set its confidence to ${Math.round((updatedTarget.confidence ?? 0.8) * 100)} %.`,
        targetCluster: updatedTarget.cluster,
        confidence: updatedTarget.confidence ?? 0.8,
        memoryId: updatedTarget.id,
      });
    }

    return { memories: next, updated: updatedTarget };
  }

  /**
   * Finds the highest-confidence learned command matching an inline suggestion prompt (Ctrl+K).
   */
  findBestLearnedCommand(
    memories: MemoryEntry[],
    prompt: string,
    cluster?: string,
  ): { command: string; explanation: string } | undefined {
    const qTokens = tokenize(prompt);
    if (qTokens.length === 0) return undefined;

    const candidateSkills = memories.filter(
      (m) =>
        (m.kind === "skill" || m.sourceCommand) &&
        (m.confidence ?? 0.8) >= 0.65 &&
        // Saved before one-off edits were kept out: never offered as a command to run again.
        !(m.sourceCommand && isOneOffCommand(m.sourceCommand)),
    );
    if (candidateSkills.length === 0) return undefined;

    const ranked = this.kb.rankMemories(candidateSkills, prompt, cluster, 3);
    for (const top of ranked) {
      const sTokens = tokenize(
        `${top.title} ${top.text} ${top.sourceCommand ?? ""}`,
      );
      // Whole words, or a longer word inside another: "is" is not a match because "disk" contains it.
      // The words that say what is asked for: "show … for the …" is shared by every request.
      const asked = qTokens.filter((q) => q.length > 2 && !REQUEST_FILLER.has(q));
      const overlap = asked.filter((q) => sTokens.some((t) => t === q || (q.length >= 4 && t.includes(q)))).length;
      // More than one shared word: "disk" alone does not make a command about purging WAL files an answer.
      // And at least half of what was asked: two words out of a long request are a coincidence.
      if (asked.length === 0 || overlap < Math.min(asked.length, Math.max(2, Math.ceil(asked.length / 2)))) continue;

      const cmd =
        top.sourceCommand ||
        /`([^`]{3,120})`/.exec(top.text)?.[1];
      if (cmd) {
        return {
          command: cmd,
          explanation: `🧬 Auto-Learned Skill (${Math.round((top.confidence ?? 0.85) * 100)}% confidence): ${top.title}`,
        };
      }
    }
    return undefined;
  }

  getStatus(params: {
    memories: MemoryEntry[];
    tasks: AgentTask[];
    kbDocuments: KbDocument[];
    infraEdges: InfraGraphEdge[];
    mcpServerCount: number;
  }): SelfLearningStatus {
    const skills = params.memories.filter((m) => m.kind === "skill");
    const autoLearnedCount = params.memories.filter(
      (m) => m.autoLearned || m.author?.includes("Learner") || m.author?.includes("Voyager"),
    ).length;
    const confidences = params.memories.map((m) => m.confidence).filter((c): c is number => typeof c === "number");

    return {
      totalLearnedSkills: skills.length,
      autoLearned: autoLearnedCount,
      failureToFixPatterns: skills.filter((s) => Boolean(s.errorSignature)).length,
      // The mean of what the entries carry. With nothing to average there is no number, not a made-up one.
      averageConfidence: confidences.length
        ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100
        : undefined,
      lastReflectionAt: this.lastReflectionAt,
      recentEvents: this.recentEvents,
    };
  }
}
