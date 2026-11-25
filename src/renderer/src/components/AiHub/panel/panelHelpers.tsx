import { dataDestination, isLoopbackHostname } from "@shared/dataDestination";
// Small functions and constants of the chat panel: moved here from AiHubPanel.tsx as they were.
import { type AgentTask, type AgentToolRecord, type HubSnapshot } from "@shared/types/aiHub";
import * as aiHubModule from "../../../lib/aiHub";
import { ALL_HUB_VIEWS, formatCompactTokens, type HubViewId } from "../panelShared";
import { LABS_ENABLED_STORAGE_KEY } from "../panelShared";

export type View = HubViewId;
export const VIEWS: View[] = [...ALL_HUB_VIEWS];
export type Menu = "history" | "target" | "control" | "mention" | "agent" | "views" | null;

export const ESC_CSI = `${String.fromCharCode(27)}[`;

export interface AiHubDeltaEvent {
  taskId: string;
  messageId?: string;
  length?: number;
  delta?: string;
  textDelta?: string;
  text?: string;
  done?: boolean;
  toolRecord?: AgentToolRecord;
  tool?: AgentToolRecord;
}

export interface StreamingTaskState {
  text: string;
  messageId?: string;
  localId: string;
  partial: boolean;
  tools: AgentToolRecord[];
}

export interface DlpRule {
  label: string;
  pattern: RegExp;
}

export const DLP_RULES: DlpRule[] = [
  { label: "Private key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: "API secret key", pattern: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g },
  { label: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { label: "GitLab/Slack/Cloud token", pattern: /\b(?:glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|hv[bs]\.[A-Za-z0-9._-]{16,})\b/g },
  { label: "JWT / Bearer token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g },
  { label: "Webhook URL", pattern: /https:\/\/(?:hooks\.slack\.com\/services|outlook\.office\.com\/webhook)\/[^\s"'<>]+/g },
  { label: "Credential assignment", pattern: /\b(?:password|passwd|secret|token|api_?key)\s*[:=]\s*["']?[A-Za-z0-9_/+.-]{8,}["']?/gi },
];

export function scanSecretsForDlp(text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const rule of DLP_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) {
      found.push(rule.label);
    }
  }
  return found;
}

export function maskSecretsForDlp(text: string): string {
  let masked = text;
  for (const rule of DLP_RULES) {
    rule.pattern.lastIndex = 0;
    masked = masked.replace(rule.pattern, "[REDACTED]");
  }
  return masked;
}

export function readLabsEnabled(): boolean {
  try {
    return window.localStorage.getItem(LABS_ENABLED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** True when a failure text is about the model or its settings, so a way to the settings is offered. */
export function isModelSetupMessage(text: string | undefined): boolean {
  return /AI settings|settings first|API key|No model answered|endpoint missing|key was refused/i.test(text ?? "");
}

/** The last thing the person said: the only message that can be asked again without confusion. */
export function lastUserMessageId(task?: AgentTask): string | undefined {
  return [...(task?.messages ?? [])].reverse().find((m) => m.role === "user")?.id;
}

export function getActiveProfileSummary(hub?: HubSnapshot): {
  label: string;
  provider?: string;
  isLocal: boolean;
  configured: boolean;
  destination: string;
} {
  const activeId = hub?.config.activeProfileByRole?.primary;
  const profile = activeId
    ? (hub?.config.profiles ?? []).find((p) => p.id === activeId)
    : undefined;
  const provider = hub?.config.provider;
  const baseUrl = hub?.config.baseUrl?.trim() ?? "";
  const model = hub?.config.model ?? "";
  const configured = provider === "anthropic" ? Boolean(hub?.config.hasApiKey)
    : provider === "openai-codex" ? Boolean(hub?.config.codexConnected) : Boolean(baseUrl);
  const scripted = Boolean(hub?.demoMode && !configured);
  function onThisMachine(kind?: string, address?: string): boolean {
    if (kind === "openai-codex" || !address) return false;
    try {
      return isLoopbackHostname(new URL(address).hostname);
    } catch {
      return false;
    }
  }
  const visited = new Set<string>();
  const reserves = [...(profile?.fallbackProfileIds ?? [])];
  let isLocal = scripted || onThisMachine(provider, baseUrl);
  while (isLocal && !scripted && reserves.length) {
    const id = reserves.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const spare = hub?.config.profiles?.find((entry) => entry.id === id);
    if (!spare) continue;
    isLocal = onThisMachine(spare.provider, spare.baseUrl);
    reserves.push(...(spare.fallbackProfileIds ?? []));
  }
  return {
    // A model name here would read as "ready" while the assistant is switched off.
    label: !hub?.config.enabled
      ? "AI off"
      : // The demo lab without a model answers from a script: a model's name here would promise one.
        scripted
        ? "Demo answers (no model)"
        : profile?.name || model || "Default profile",
    provider,
    isLocal,
    configured,
    destination: scripted ? "The demo script answers here." : dataDestination(provider ?? "openai-compatible", baseUrl),
  };
}

/**
 * The tokens a conversation used and what they cost, the run going on included: every token sent and
 * answered, the ones read from or written to the prompt cache too (most of a long conversation is read
 * from it, and the cost counts them), and how many of them were the cache's.
 */
export function getTaskUsageSummary(task?: AgentTask): { totalTokens: number; cachedTokens: number; costUsd: number } {
  if (!task) return { totalTokens: 0, cachedTokens: 0, costUsd: 0 };
  const isRunning = ["queued", "running", "waiting"].includes(task.status);
  const run = isRunning ? task.runUsage : undefined;
  const sum = (pick: (u: NonNullable<AgentTask["usage"]>) => number | undefined): number =>
    (task.usage ? pick(task.usage) ?? 0 : 0) + (run ? pick(run) ?? 0 : 0);
  const cachedTokens = sum((u) => u.cacheReadTokens) + sum((u) => u.cacheCreationTokens);
  return {
    totalTokens: sum((u) => u.inputTokens) + sum((u) => u.outputTokens) + cachedTokens,
    cachedTokens,
    costUsd: sum((u) => u.costUsd),
  };
}

/**
 * What the row under the composer says a conversation used: the same count as the header's, the tokens
 * of the prompt cache included, so the two never show different totals for one cost.
 */
export function composerUsage(task?: AgentTask): { label: string; title: string } | undefined {
  if (!task || !(task.usage || task.runUsage)) return undefined;
  const used = getTaskUsageSummary(task);
  if (!used.totalTokens) return undefined;
  const running = ["queued", "running", "waiting"].includes(task.status) && Boolean(task.runUsage);
  const priced = task.usage?.costUsd !== undefined || (running && task.runUsage?.costUsd !== undefined);
  const cost = priced ? ` · $${used.costUsd.toFixed(3)}` : "";
  const cached = used.cachedTokens > 0 ? `, ${formatCompactTokens(used.cachedTokens)} of them read from or written to the prompt cache, which costs less` : "";
  return {
    label: `${formatCompactTokens(used.totalTokens)}${cost}`,
    title: `${used.totalTokens} tokens${cached}${running ? " (the run in progress included)" : ""}`,
  };
}

export function subscribeAiHubDelta(cb: (delta: AiHubDeltaEvent) => void): () => void {
  const modFn = (
    aiHubModule as unknown as {
      onAiHubDelta?: (listener: (ev: AiHubDeltaEvent) => void) => () => void;
    }
  ).onAiHubDelta;
  if (typeof modFn === "function") {
    return modFn(cb);
  }
  const winFn = (
    window.multissh as unknown as {
      onAiHubDelta?: (listener: (ev: AiHubDeltaEvent) => void) => () => void;
    } | undefined
  )?.onAiHubDelta;
  if (typeof winFn === "function") {
    return winFn(cb);
  }
  return () => {};
}

export function normalizeViewTarget(raw?: string): View | undefined {
  if (!raw) return undefined;
  if (raw === "Assistant" || raw === "Workspace" || raw === "Chat") return "Work";
  return VIEWS.find((v) => v === raw);
}

export function formatDurationBadge(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function isDiffToolRecord(rec: AgentToolRecord): boolean {
  const name = rec.name.toLowerCase();
  if (name.includes("patch") || name.includes("diff") || name.includes("edit") || name.includes("write_file")) {
    return true;
  }
  const text = `${rec.output}\n${rec.input}`;
  return (text.includes("--- ") && text.includes("+++ ")) || text.includes("\n@@ ");
}

export function isAnsiToolRecord(rec: AgentToolRecord): boolean {
  if (rec.output.includes(ESC_CSI)) return true;
  const name = rec.name.toLowerCase();
  return name.includes("exec") || name.includes("ssh") || name.includes("terminal") || name.includes("command") || name.includes("kubectl") || name.includes("log");
}

// The same incident as the demo lab's conversation (demoWorkspace.ts), at the point where it is found.
export const DEMO_SHOWCASE_RESPONSE = [
  "## Cluster check: `NetApp-ONTAP-Prod-SE` and `K8s-Trident-CSI-Prod`",
  "",
  "I ran a health check on all 4 nodes of `@cluster:NetApp-ONTAP-Prod-SE` in parallel and compared `/etc/multipath.conf` between `k8s-storage-cp-01` and `k8s-gpu-io-worker-01`.",
  "",
  "### 1. Node status and latency (ONTAP 9.15.1P2)",
  "",
  "| Node | Role | Aggregate / capacity | Highest volume latency | SnapMirror lag | Status |",
  "| :--- | :--- | :--- | :--- | :--- | :--- |",
  "| `netapp-aff-a800-01a` | HA node A (DC1) | `aggr1_nvme_prod` (72% of 220 TB) | `0.38 ms` | `00:03:18` | **ONLINE · HEALTH_OK** |",
  "| `netapp-aff-a800-01b` | HA node B (DC1) | `aggr2_nvme_db` (68% of 180 TB) | `2.45 ms` | `00:02:44` | **ONLINE · QoS warning** |",
  "| `netapp-fas9000-dr-01` | SnapVault DR (DC2) | `aggr_dr_nlsas` (71% of 1.6 PB) | `1.12 ms` | In sync (XDP) | **ONLINE · SNAPMIRRORED** |",
  "| `ontap-aiq-um-01` | Active IQ and Harvest | Prometheus / Grafana | - | - | **TELEMETRY OK** |",
  "",
  "> **Cause:** the scratch volume `vol_ai_scratch_03` (`svm-prod-nfs`) on `netapp-aff-a800-01b` has no QoS policy. Its read peaks (`48 200 IOPS`) drive up the queue depth on `aggr2_nvme_db`, which also holds the production database volume `vol_pg_prod_db01` (`1.88 ms`). On `k8s-gpu-io-worker-01`, multipath uses `multibus` instead of ALUA `group_by_prio`, which the Trident multipath standard in the knowledge base requires.",
  "",
  "### 2. Configuration difference (`/etc/multipath.conf`)",
  "",
  "```diff",
  "--- k8s-storage-cp-01:/etc/multipath.conf",
  "+++ k8s-gpu-io-worker-01:/etc/multipath.conf",
  "@@ -7,7 +7,7 @@",
  "     device {",
  "         vendor \"NETAPP\"",
  "         product \"LUN.*\"",
  "-        path_grouping_policy group_by_prio",
  "+        path_grouping_policy multibus",
  "         path_checker tur",
  "         features \"2 pg_init_retries 50\"",
  "         hardware_handler \"1 alua\"",
  "```",
  "",
  "### 3. Proposed commands",
  "",
  "Put the QoS ceiling `pg-batch-ceiling` (`15 000 IOPS` / `600 MB/s`) on the scratch volume and check the latency again, then switch the GPU worker's multipath to ALUA:",
  "",
  "```bash",
  "# On netapp-aff-a800-01b:",
  "volume modify -vserver svm-prod-nfs -volume vol_ai_scratch_03 -qos-policy-group pg-batch-ceiling",
  "qos statistics volume latency show -iterations 3",
  "# On k8s-gpu-io-worker-01:",
  "sudo multipath -r && sudo multipath -ll",
  "```",
].join("\n");
