import crypto from "node:crypto";
import type {
  MissionAgent,
  WorkforceRun,
  WorkforceStep,
} from "../../../shared/types/aiHub";
import { boundedContext, safeError } from "./privacy";

/** The outcome of one specialist's model run. */
export interface SpecialistResult {
  taskId?: string;
  status: "completed" | "failed";
  /** The model's final answer. */
  text: string;
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
): string {
  return [
    "You are one specialist in a coordinated, read-only review. Other specialists cover other areas; a lead will combine the reports.",
    `Overall objective: ${objective}`,
    `Your area: ${agent.role}${cluster ? ` — ${cluster}` : ""}.`,
    agent.mission ? `Your standing mission: ${agent.mission}` : "",
    "",
    "Investigate with the tools you have (workspace context, knowledge base search, read-only storage listing/reading/diff). You cannot run commands or change anything.",
    "Report, briefly:",
    "1. Findings — each with the evidence it rests on (which terminal output, activity entry, knowledge base document or file).",
    "2. What you could not check with read-only access.",
    "3. Recommended next commands for a human or an assisted agent to run, with the target they apply to.",
    "State plainly when you found nothing relevant. Do not invent node names, metrics or results.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function synthesisPrompt(
  objective: string,
  steps: WorkforceStep[],
): string {
  const reports = steps.map((s) =>
    s.status === "completed"
      ? `## ${s.agentName} (${s.targetCluster || s.role})\n${boundedContext(s.findings, 12_000)}`
      : `## ${s.agentName} (${s.targetCluster || s.role})\nNO REPORT — this specialist failed: ${s.error ?? "unknown error"}`,
  );
  return [
    "You are the lead of a coordinated review. The specialists' reports are below; they are the only evidence you have.",
    `Objective: ${objective}`,
    "",
    "Write the combined result: what was found (attribute each point to its specialist), where reports agree or contradict each other, what remains unchecked — including every specialist that failed — and a short ordered list of next steps.",
    "Do not add findings that are in no report. Do not call anything verified: nothing was executed.",
    "",
    ...reports,
  ].join("\n");
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
  const steps: WorkforceStep[] = agents.map((agent, idx) => {
    const cluster = agent.targetCluster || request.targetCluster || "";
    return {
      id: `${runId}-step-${idx}`,
      agentId: agent.id,
      agentName: agent.name,
      agentIcon: agent.icon || "🤖",
      role: agent.role,
      targetCluster: cluster && cluster !== "ALL" ? cluster : undefined,
      subTask: boundedContext(request.prompt, 400),
      status: "queued",
      findings: "",
    };
  });
  const run: WorkforceRun = {
    id: runId,
    title: boundedContext(request.prompt, 90),
    prompt: boundedContext(request.prompt, 2000),
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
        ),
        agent: agent === GENERAL_SPECIALIST ? undefined : agent,
        agentName: agent.name,
      });
      step.taskId = result.taskId;
      if (result.status === "completed" && result.text.trim()) {
        step.status = "completed";
        step.findings = boundedContext(result.text, 32_000);
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
      prompt: synthesisPrompt(run.prompt, steps),
      agentName: run.leadAgentName,
    });
    if (result.status === "completed" && result.text.trim()) {
      run.synthesis = boundedContext(result.text, 64_000);
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
