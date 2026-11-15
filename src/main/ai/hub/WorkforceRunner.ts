import crypto from "node:crypto";
import type {
  MissionAgent,
  TargetSelector,
  WorkforceRun,
  WorkforceStep,
} from "../../../shared/types/aiHub";
import { clip, safeError } from "./privacy";

export interface ScratchpadFact {
  id: string;
  text: string;
  evidence: string;
  target?: string;
  addedBy: string;
  at: number;
}

export interface ScratchpadCheckedTarget {
  target: string;
  checkedBy: string;
  summary?: string;
  at: number;
}

export interface ScratchpadHypothesis {
  id: string;
  text: string;
  status: "open" | "confirmed" | "ruled-out";
  addedBy: string;
  at: number;
}

export interface RunScratchpadSnapshot {
  runId: string;
  confirmedFacts: readonly ScratchpadFact[];
  checkedTargets: readonly ScratchpadCheckedTarget[];
  hypotheses: readonly ScratchpadHypothesis[];
}

/**
 * Append-only run-scoped scratchpad shared across parallel specialists so
 * discoveries and already-inspected targets are visible without overwriting
 * earlier observations.
 */
export class RunScratchpad {
  private readonly facts: ScratchpadFact[] = [];
  private readonly targets: ScratchpadCheckedTarget[] = [];
  private readonly hypothesesList: ScratchpadHypothesis[] = [];

  constructor(readonly runId: string) {}

  addFact(input: {
    text: string;
    evidence: string;
    target?: string;
    addedBy: string;
    at?: number;
  }): ScratchpadFact {
    const text = clip(input.text.trim(), 600);
    const evidence = clip(input.evidence.trim(), 600);
    const entry: ScratchpadFact = {
      id: `fact-${this.facts.length + 1}`,
      text,
      evidence,
      ...(input.target?.trim() ? { target: input.target.trim() } : {}),
      addedBy: input.addedBy,
      at: input.at ?? Date.now(),
    };
    if (text) this.facts.push(entry);
    return entry;
  }

  markTargetChecked(input: {
    target: string;
    checkedBy: string;
    summary?: string;
    at?: number;
  }): ScratchpadCheckedTarget {
    const target = input.target.trim();
    const entry: ScratchpadCheckedTarget = {
      target,
      checkedBy: input.checkedBy,
      ...(input.summary?.trim() ? { summary: clip(input.summary.trim(), 400) } : {}),
      at: input.at ?? Date.now(),
    };
    if (target) this.targets.push(entry);
    return entry;
  }

  addHypothesis(input: {
    id?: string;
    text: string;
    status?: "open" | "confirmed" | "ruled-out";
    addedBy: string;
    at?: number;
  }): ScratchpadHypothesis {
    const text = clip(input.text.trim(), 600);
    const entry: ScratchpadHypothesis = {
      id: input.id?.trim() || `hyp-${this.hypothesesList.length + 1}`,
      text,
      status: input.status ?? "open",
      addedBy: input.addedBy,
      at: input.at ?? Date.now(),
    };
    if (text) this.hypothesesList.push(entry);
    return entry;
  }

  hasCheckedTarget(target: string): boolean {
    const norm = target.trim().toLowerCase();
    return this.targets.some((t) => t.target.toLowerCase() === norm);
  }

  checkedTargetNames(): string[] {
    return [...new Set(this.targets.map((t) => t.target))];
  }

  snapshot(): RunScratchpadSnapshot {
    return {
      runId: this.runId,
      confirmedFacts: this.facts.map((f) => ({ ...f })),
      checkedTargets: this.targets.map((t) => ({ ...t })),
      hypotheses: this.hypothesesList.map((h) => ({ ...h })),
    };
  }

  isEmpty(): boolean {
    return (
      this.facts.length === 0 &&
      this.targets.length === 0 &&
      this.hypothesesList.length === 0
    );
  }

  formatForPrompt(): string {
    if (this.isEmpty()) return "";
    const lines: string[] = ["## Shared run scratchpad (append-only)"];
    if (this.targets.length > 0) {
      lines.push(
        `Already checked targets: ${this.targets
          .map((t) => `${t.target} (by ${t.checkedBy}${t.summary ? `: ${t.summary}` : ""})`)
          .join("; ")}`,
      );
    }
    if (this.facts.length > 0) {
      lines.push("Confirmed facts so far:");
      for (const f of this.facts.slice(-20)) {
        lines.push(
          `- [${f.addedBy}${f.target ? ` @ ${f.target}` : ""}] ${f.text} (evidence: ${f.evidence || "none"})`,
        );
      }
    }
    if (this.hypothesesList.length > 0) {
      lines.push("Active hypotheses:");
      for (const h of this.hypothesesList.slice(-20)) {
        lines.push(`- [${h.status}] ${h.text} (by ${h.addedBy})`);
      }
    }
    return lines.join("\n");
  }
}

export interface StructuredSpecialistOutput {
  findings: string[];
  unchecked: string[];
  recommendedCommands: string[];
  confirmedFacts?: Array<{ text: string; evidence: string; target?: string }>;
  checkedTargets?: string[];
  hypotheses?: Array<{ text: string; status?: "open" | "confirmed" | "ruled-out" }>;
}

function normalizeStringList(val: unknown): string[] | null {
  if (Array.isArray(val)) {
    return val
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof val === "string") {
    const clean = val.trim();
    return clean ? [clean] : [];
  }
  return null;
}

function tryParseJsonCandidate(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = [fenceMatch?.[1]?.trim(), trimmed].filter(
    (c): c is string => Boolean(c && c.startsWith("{")),
  );
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try next candidate
    }
  }
  return null;
}

function parseBulletLines(block: string): string[] {
  return block
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

export function parseStructuredSpecialistOutput(
  text: string,
): StructuredSpecialistOutput | null {
  const jsonObj = tryParseJsonCandidate(text);
  if (jsonObj) {
    const findings = normalizeStringList(jsonObj.findings);
    const unchecked = normalizeStringList(jsonObj.unchecked);
    const recommendedCommands = normalizeStringList(jsonObj.recommendedCommands);
    if (!findings || !unchecked || !recommendedCommands) {
      return null;
    }
    const confirmedFacts = Array.isArray(jsonObj.confirmedFacts)
      ? jsonObj.confirmedFacts
          .filter(
            (f): f is { text: string; evidence?: string; target?: string } =>
              Boolean(f && typeof f === "object" && typeof (f as { text?: unknown }).text === "string"),
          )
          .map((f) => ({
            text: f.text.trim(),
            evidence: typeof f.evidence === "string" ? f.evidence.trim() : "",
            ...(typeof f.target === "string" && f.target.trim()
              ? { target: f.target.trim() }
              : {}),
          }))
          .filter((f) => f.text.length > 0)
      : undefined;
    const checkedTargets = normalizeStringList(jsonObj.checkedTargets) ?? undefined;
    const hypotheses = Array.isArray(jsonObj.hypotheses)
      ? jsonObj.hypotheses
          .filter(
            (h): h is { text: string; status?: "open" | "confirmed" | "ruled-out" } =>
              Boolean(h && typeof h === "object" && typeof (h as { text?: unknown }).text === "string"),
          )
          .map((h) => ({
            text: h.text.trim(),
            status:
              h.status === "confirmed" || h.status === "ruled-out" ? h.status : ("open" as const),
          }))
          .filter((h) => h.text.length > 0)
      : undefined;
    return {
      findings,
      unchecked,
      recommendedCommands,
      ...(confirmedFacts?.length ? { confirmedFacts } : {}),
      ...(checkedTargets?.length ? { checkedTargets } : {}),
      ...(hypotheses?.length ? { hypotheses } : {}),
    };
  }

  const findingsMatch =
    /(?:^|\n)\s*(?:#{1,3}\s*|\d+[.)]\s*)Findings\b[^\n]*\n([\s\S]*?)(?=\n\s*(?:#{1,3}\s*|\d+[.)]\s*)(?:Unchecked|What you could not check|Recommended)|\s*$)/i.exec(
      text,
    );
  const uncheckedMatch =
    /(?:^|\n)\s*(?:#{1,3}\s*|\d+[.)]\s*)(?:Unchecked|What you could not check)\b[^\n]*\n([\s\S]*?)(?=\n\s*(?:#{1,3}\s*|\d+[.)]\s*)Recommended|\s*$)/i.exec(
      text,
    );
  const commandsMatch =
    /(?:^|\n)\s*(?:#{1,3}\s*|\d+[.)]\s*)Recommended(?:\s+next\s+commands|\s+commands)\b[^\n]*\n([\s\S]*?)$/i.exec(
      text,
    );
  if (findingsMatch && uncheckedMatch && commandsMatch) {
    return {
      findings: parseBulletLines(findingsMatch[1]),
      unchecked: parseBulletLines(uncheckedMatch[1]),
      recommendedCommands: parseBulletLines(commandsMatch[1]),
    };
  }
  return null;
}

export function validateStructuredSpecialistOutput(
  input: string | Partial<StructuredSpecialistOutput>,
):
  | { ok: true; output: StructuredSpecialistOutput }
  | { ok: false; missing: string[] } {
  if (typeof input === "string") {
    const parsed = parseStructuredSpecialistOutput(input);
    if (parsed) return { ok: true, output: parsed };
    const jsonObj = tryParseJsonCandidate(input);
    if (jsonObj) {
      const missing: string[] = [];
      if (!normalizeStringList(jsonObj.findings)) missing.push("findings");
      if (!normalizeStringList(jsonObj.unchecked)) missing.push("unchecked");
      if (!normalizeStringList(jsonObj.recommendedCommands)) missing.push("recommendedCommands");
      return { ok: false, missing: missing.length ? missing : ["findings", "unchecked", "recommendedCommands"] };
    }
    return { ok: false, missing: ["findings", "unchecked", "recommendedCommands"] };
  }
  const missing: string[] = [];
  const findings = normalizeStringList(input.findings);
  const unchecked = normalizeStringList(input.unchecked);
  const recommendedCommands = normalizeStringList(input.recommendedCommands);
  if (!findings) missing.push("findings");
  if (!unchecked) missing.push("unchecked");
  if (!recommendedCommands) missing.push("recommendedCommands");
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    output: {
      findings: findings!,
      unchecked: unchecked!,
      recommendedCommands: recommendedCommands!,
      ...(input.confirmedFacts ? { confirmedFacts: input.confirmedFacts } : {}),
      ...(input.checkedTargets ? { checkedTargets: input.checkedTargets } : {}),
      ...(input.hypotheses ? { hypotheses: input.hypotheses } : {}),
    },
  };
}

export function formatStructuredSpecialistOutput(
  output: StructuredSpecialistOutput,
): string {
  const section = (title: string, items: string[]): string =>
    `### ${title}\n${items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : "- None"}`;
  return [
    section("Findings", output.findings),
    section("Unchecked", output.unchecked),
    section("Recommended Commands", output.recommendedCommands),
  ].join("\n\n");
}

/** The outcome of one specialist's model run. */
export interface SpecialistResult {
  taskId?: string;
  status: "completed" | "failed";
  /** The model's final answer. */
  text: string;
  structured?: Partial<StructuredSpecialistOutput>;
  error?: string;
}

export interface WorkforceDeps {
  /**
   * Runs one read-only model task to its end and returns what the model
   * answered. Must reject (or return `failed`) when no model can be reached:
   * the runner never writes findings of its own.
   */
  runSpecialist(input: {
    runId: string;
    prompt: string;
    agent?: MissionAgent;
    agentName: string;
    scratchpad?: RunScratchpad;
  }): Promise<SpecialistResult>;
  /** Called after every state change of the run, so it can be stored and shown. */
  onProgress(run: WorkforceRun): void;
  /** True once the user stopped the run; remaining specialists are not started. */
  cancelled?(): boolean;
}

export interface WorkforceRequest {
  prompt: string;
  agents: MissionAgent[];
  targetCluster?: string;
  /** Specialists that run at the same time. */
  concurrency?: number;
  /** When true, fail any specialist whose output lacks `findings`, `unchecked`, and `recommendedCommands`. */
  requireStructuredOutput?: boolean;
}

export const MAX_WORKFORCE_SPECIALISTS = 4;

const GENERAL_SPECIALIST: MissionAgent = {
  id: "default-sre-specialist",
  name: "General Infrastructure SRE",
  role: "Linux, SSH & S3 specialist",
  icon: "🤖",
  mission: "Inspect cluster nodes, services and storage health.",
  systemPrompt: "",
  defaultMode: "advice",
  updatedAt: 0,
};

export function specialistPrompt(
  objective: string,
  agent: MissionAgent,
  cluster: string,
  scratchpad?: RunScratchpad,
): string {
  const scratchpadText = scratchpad?.formatForPrompt() ?? "";
  return [
    "You are one specialist in a coordinated, read-only review. Other specialists cover other areas; a lead will combine the reports.",
    `Overall objective: ${objective}`,
    `Your area: ${agent.role}${cluster ? ` — ${cluster}` : ""}.`,
    agent.mission ? `Your standing mission: ${agent.mission}` : "",
    scratchpadText,
    "",
    "Investigate with the tools you have (workspace context, knowledge base search, read-only storage listing/reading/diff). You cannot run commands or change anything.",
    "Return a structured report (JSON or the exact sections below) covering:",
    "1. Findings — each with the evidence it rests on (which terminal output, activity entry, knowledge base document or file).",
    "2. Unchecked — what you could not check with read-only access.",
    "3. Recommended next commands — concrete commands for a human or an assisted agent to run, with the target they apply to.",
    'If returning JSON, use keys {"findings": string[], "unchecked": string[], "recommendedCommands": string[], "confirmedFacts"?: [{"text": string, "evidence": string, "target"?: string}], "checkedTargets"?: string[], "hypotheses"?: [{"text": string, "status": "open"|"confirmed"|"ruled-out"}]}.',
    "State plainly when you found nothing relevant. Do not invent node names, metrics or results.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function synthesisPrompt(
  objective: string,
  steps: WorkforceStep[],
  scratchpad?: RunScratchpad,
): string {
  const reports = steps.map((s) =>
    s.status === "completed"
      ? `## ${s.agentName} (${s.targetCluster || s.role})\n${clip(s.findings, 12_000)}`
      : `## ${s.agentName} (${s.targetCluster || s.role})\nNO REPORT — this specialist failed: ${s.error ?? "unknown error"}`,
  );
  const scratchpadText = scratchpad?.formatForPrompt() ?? "";
  return [
    "You are the lead of a coordinated review. The specialists' reports are below; they are the only evidence you have.",
    `Objective: ${objective}`,
    scratchpadText ? `\n${scratchpadText}` : "",
    "",
    "Write the combined result: what was found (attribute each point to its specialist), where reports agree or contradict each other, what remains unchecked — including every specialist that failed — and a short ordered list of next steps.",
    "Do not add findings that are in no report. Do not call anything verified: nothing was executed.",
    "",
    ...reports,
    "",
    "That was the last report. Now write the combined result described at the top; do not ask what to do with the reports.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function recordStructuredInScratchpad(
  scratchpad: RunScratchpad,
  agentName: string,
  structured: StructuredSpecialistOutput,
  fallbackTarget?: string,
  now = Date.now(),
): void {
  for (const target of structured.checkedTargets ?? []) {
    scratchpad.markTargetChecked({ target, checkedBy: agentName, at: now });
  }
  for (const fact of structured.confirmedFacts ?? []) {
    scratchpad.addFact({
      text: fact.text,
      evidence: fact.evidence,
      target: fact.target ?? fallbackTarget,
      addedBy: agentName,
      at: now,
    });
  }
  for (const hyp of structured.hypotheses ?? []) {
    scratchpad.addHypothesis({
      text: hyp.text,
      status: hyp.status,
      addedBy: agentName,
      at: now,
    });
  }
}

/**
 * Runs the specialists (bounded concurrency) and then one synthesis run.
 * Everything in the result that reads as a finding was written by a model run;
 * a specialist that cannot run is recorded as failed with its error.
 */
export async function runWorkforce(
  request: WorkforceRequest,
  deps: WorkforceDeps,
): Promise<WorkforceRun> {
  const agents = (
    request.agents.length > 0 ? request.agents : [GENERAL_SPECIALIST]
  ).slice(0, MAX_WORKFORCE_SPECIALISTS);
  const now = Date.now();
  const runId = `wf-${crypto.randomUUID().slice(0, 8)}`;
  const scratchpad = new RunScratchpad(runId);
  const steps: WorkforceStep[] = agents.map((agent, idx) => {
    const cluster = agent.targetCluster || request.targetCluster || "";
    return {
      id: `${runId}-step-${idx}`,
      agentId: agent.id,
      agentName: agent.name,
      agentIcon: agent.icon || "🤖",
      role: agent.role,
      targetCluster: cluster && cluster !== "ALL" ? cluster : undefined,
      subTask: clip(request.prompt, 400),
      status: "queued",
      findings: "",
    };
  });
  const run: WorkforceRun = {
    id: runId,
    title: clip(request.prompt, 90),
    prompt: clip(request.prompt, 2000),
    leadAgentName: "Workforce lead",
    targetCluster: request.targetCluster || "ALL",
    status: "running",
    steps,
    synthesis: "",
    createdAt: now,
    updatedAt: now,
  };
  const progress = (): void => {
    run.updatedAt = Date.now();
    deps.onProgress(run);
  };
  progress();

  const runStep = async (idx: number): Promise<void> => {
    const step = steps[idx];
    const agent = agents[idx];
    if (deps.cancelled?.()) {
      step.status = "failed";
      step.error = "Stopped before this specialist started.";
      progress();
      return;
    }
    step.status = "running";
    progress();
    const started = Date.now();
    try {
      const result = await deps.runSpecialist({
        runId,
        prompt: specialistPrompt(
          run.prompt,
          agent,
          step.targetCluster ?? "",
          scratchpad,
        ),
        agent: agent === GENERAL_SPECIALIST ? undefined : agent,
        agentName: agent.name,
        scratchpad,
      });
      step.taskId = result.taskId;
      if (result.status === "completed" && (result.text.trim() || result.structured)) {
        const structuredCheck = result.structured
          ? validateStructuredSpecialistOutput(result.structured)
          : validateStructuredSpecialistOutput(result.text);
        if (request.requireStructuredOutput && !structuredCheck.ok) {
          step.status = "failed";
          step.error = `Specialist output missing required structured fields: ${structuredCheck.missing.join(", ")}.`;
        } else {
          step.status = "completed";
          if (structuredCheck.ok) {
            if (structuredCheck.output.recommendedCommands.length > 0) {
              step.recommendedCommands = structuredCheck.output.recommendedCommands.map((c) =>
                clip(c, 500),
              );
            }
            recordStructuredInScratchpad(
              scratchpad,
              agent.name,
              structuredCheck.output,
              step.targetCluster,
            );
            const rawTrimmed = result.text.trim();
            const isRawJson = rawTrimmed.startsWith("{") || rawTrimmed.startsWith("```");
            step.findings = clip(
              isRawJson || !rawTrimmed
                ? formatStructuredSpecialistOutput(structuredCheck.output)
                : result.text,
              32_000,
            );
          } else {
            step.findings = clip(result.text, 32_000);
          }
        }
      } else {
        step.status = "failed";
        step.error =
          result.error ?? "The specialist ended without a report.";
      }
    } catch (error) {
      step.status = "failed";
      step.error = safeError(error);
    }
    step.durationMs = Date.now() - started;
    progress();
  };

  let next = 0;
  const workers = Math.max(
    1,
    Math.min(request.concurrency ?? 2, steps.length),
  );
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < steps.length) await runStep(next++);
    }),
  );

  const reported = steps.filter((s) => s.status === "completed");
  if (reported.length === 0) {
    run.status = "failed";
    run.error =
      steps.find((s) => s.error)?.error ?? "No specialist produced a report.";
    progress();
    return run;
  }
  if (deps.cancelled?.()) {
    run.status = "failed";
    run.error = "Stopped before the reports were combined.";
    progress();
    return run;
  }

  if (reported.length === 1 && steps.length === 1) {
    // One report needs no second model run to "combine" it.
    run.synthesis = reported[0].findings;
    run.status = "completed";
    progress();
    return run;
  }

  try {
    const result = await deps.runSpecialist({
      runId,
      prompt: synthesisPrompt(run.prompt, steps, scratchpad),
      agentName: run.leadAgentName,
      scratchpad,
    });
    if (result.status === "completed" && result.text.trim()) {
      run.synthesis = clip(result.text, 64_000);
      run.status = "completed";
    } else {
      run.status = "failed";
      run.error = result.error ?? "The lead ended without a combined result.";
    }
  } catch (error) {
    run.status = "failed";
    run.error = safeError(error);
  }
  progress();
  return run;
}

export interface TargetCandidate {
  id: string;
  name?: string;
  host?: string;
  cluster?: string;
  tags?: string[];
}

export type TargetDispatchStrategy = "canary_then_rolling" | "rolling" | "all_at_once";

export interface TargetDispatchOptions<T extends TargetCandidate = TargetCandidate> {
  selector?: TargetSelector;
  strategy?: TargetDispatchStrategy;
  /** Number of canary targets to run first in `canary_then_rolling` (default 1). */
  canaryCount?: number;
  /** Max concurrent targets within each rolling wave (default 2). */
  concurrency?: number;
  /** Halt dispatching subsequent waves/targets after a failure (default true). */
  stopOnFailure?: boolean;
  /** Optional predicate selecting preferred canary targets first. */
  isCanary?: (target: T) => boolean;
}

export interface TargetDispatchWaves<T extends TargetCandidate = TargetCandidate> {
  targets: T[];
  canary: T[];
  waves: T[][];
  strategy: TargetDispatchStrategy;
  concurrency: number;
  stopOnFailure: boolean;
}

export interface TargetDispatchItemResult<T extends TargetCandidate = TargetCandidate, R = unknown> {
  target: T;
  wave: number;
  phase: "canary" | "rolling";
  ok: boolean;
  result?: R;
  error?: string;
  durationMs: number;
}

export interface TargetDispatchReport<T extends TargetCandidate = TargetCandidate, R = unknown> {
  strategy: TargetDispatchStrategy;
  matchedCount: number;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  haltedOnFailure: boolean;
  results: TargetDispatchItemResult<T, R>[];
  skipped: T[];
}

function matchesGlob(patternRaw: string, valueRaw: string): boolean {
  const pattern = patternRaw.trim().toLowerCase();
  const value = valueRaw.toLowerCase();
  let p = 0;
  let v = 0;
  let star = -1;
  let match = 0;
  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === value[v])) {
      p += 1;
      v += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      match = v;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      match += 1;
      v = match;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/**
 * Resolves fleet candidates matching a `TargetSelector` (`serverIds`, `cluster`, `tags`, `glob`).
 * When `tags` are given, a candidate must carry all requested tags (case-insensitive).
 */
export function resolveTargetSelector<T extends TargetCandidate>(
  candidates: readonly T[],
  selector?: TargetSelector,
): T[] {
  if (!selector) return [...candidates];
  const ids = selector.serverIds?.map((s) => s.trim()).filter(Boolean) ?? [];
  const cluster = selector.cluster?.trim().toLowerCase();
  const tags = selector.tags?.map((t) => t.trim().toLowerCase()).filter(Boolean) ?? [];
  const globPattern = selector.glob?.trim() || undefined;
  const seen = new Set<string>();
  const matched: T[] = [];

  for (const c of candidates) {
    if (!c?.id || seen.has(c.id)) continue;
    if (ids.length > 0 && !ids.includes(c.id)) continue;
    if (cluster && (c.cluster ?? "").trim().toLowerCase() !== cluster) continue;
    if (tags.length > 0) {
      const cTags = new Set((c.tags ?? []).map((t) => t.trim().toLowerCase()));
      if (!tags.every((t) => cTags.has(t))) continue;
    }
    if (globPattern) {
      const candidatesForGlob = [c.name, c.id, c.host].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      if (!candidatesForGlob.some((v) => matchesGlob(globPattern, v))) continue;
    }
    seen.add(c.id);
    matched.push(c);
  }
  return matched;
}

function chunkTargets<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Plans target execution waves for `canary_then_rolling`, `rolling`, or `all_at_once`.
 * Not used by the app yet: a run on several servers goes through the cluster-exec stages in AppActions.
 */
export function planTargetDispatch<T extends TargetCandidate>(
  candidates: readonly T[],
  options: TargetDispatchOptions<T> = {},
): TargetDispatchWaves<T> {
  const targets = resolveTargetSelector(candidates, options.selector);
  const strategy: TargetDispatchStrategy = options.strategy ?? "canary_then_rolling";
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
  const stopOnFailure = options.stopOnFailure ?? true;

  if (targets.length === 0) {
    return { targets: [], canary: [], waves: [], strategy, concurrency, stopOnFailure };
  }
  if (strategy === "all_at_once") {
    return { targets, canary: [], waves: [targets], strategy, concurrency, stopOnFailure };
  }
  if (strategy === "rolling") {
    return {
      targets,
      canary: [],
      waves: chunkTargets(targets, concurrency),
      strategy,
      concurrency,
      stopOnFailure,
    };
  }

  const canaryCount = Math.max(1, Math.min(targets.length, Math.floor(options.canaryCount ?? 1)));
  const ordered = options.isCanary
    ? [
        ...targets.filter((t) => options.isCanary!(t)),
        ...targets.filter((t) => !options.isCanary!(t)),
      ]
    : targets;
  const canary = ordered.slice(0, canaryCount);
  const canaryIds = new Set(canary.map((t) => t.id));
  const remaining = targets.filter((t) => !canaryIds.has(t.id));
  const waves = [canary, ...chunkTargets(remaining, concurrency)];
  return { targets, canary, waves, strategy, concurrency, stopOnFailure };
}

/**
 * Dispatches a runner across resolved `TargetSelector` waves with bounded concurrency,
 * canary verification before rolling waves, and optional `stopOnFailure` circuit breaking.
 * Not used by the app yet (see planTargetDispatch).
 */
export async function dispatchTargets<T extends TargetCandidate, R = unknown>(
  candidates: readonly T[],
  runner: (
    target: T,
    ctx: { wave: number; phase: "canary" | "rolling"; signal?: AbortSignal },
  ) => Promise<R>,
  options: TargetDispatchOptions<T> & {
    cancelled?: () => boolean;
    signal?: AbortSignal;
    isResultOk?: (result: R) => boolean;
  } = {},
): Promise<TargetDispatchReport<T, R>> {
  const plan = planTargetDispatch(candidates, options);
  const results: TargetDispatchItemResult<T, R>[] = [];
  const skipped: T[] = [];
  let haltedOnFailure = false;

  const isAborted = (): boolean =>
    Boolean(options.cancelled?.() || options.signal?.aborted);

  for (let waveIdx = 0; waveIdx < plan.waves.length; waveIdx++) {
    const wave = plan.waves[waveIdx];
    const phase: "canary" | "rolling" =
      plan.strategy === "canary_then_rolling" && waveIdx === 0 ? "canary" : "rolling";

    if (haltedOnFailure || isAborted()) {
      skipped.push(...wave);
      continue;
    }

    let cursor = 0;
    const waveConcurrency = Math.min(plan.concurrency, wave.length);
    await Promise.all(
      Array.from({ length: waveConcurrency }, async () => {
        while (cursor < wave.length) {
          const idx = cursor++;
          const target = wave[idx];
          if (haltedOnFailure || isAborted()) {
            skipped.push(target);
            continue;
          }
          const started = Date.now();
          try {
            const result = await runner(target, {
              wave: waveIdx,
              phase,
              signal: options.signal,
            });
            const ok = options.isResultOk ? options.isResultOk(result) : true;
            results.push({
              target,
              wave: waveIdx,
              phase,
              ok,
              result,
              ...(ok ? {} : { error: "Target check reported failure." }),
              durationMs: Date.now() - started,
            });
            if (!ok && plan.stopOnFailure) {
              haltedOnFailure = true;
            }
          } catch (err) {
            results.push({
              target,
              wave: waveIdx,
              phase,
              ok: false,
              error: safeError(err),
              durationMs: Date.now() - started,
            });
            if (plan.stopOnFailure) {
              haltedOnFailure = true;
            }
          }
        }
      }),
    );
  }

  return {
    strategy: plan.strategy,
    matchedCount: plan.targets.length,
    completedCount: results.filter((r) => r.ok).length,
    failedCount: results.filter((r) => !r.ok).length,
    skippedCount: skipped.length,
    haltedOnFailure,
    results,
    skipped,
  };
}
