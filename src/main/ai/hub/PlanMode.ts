import crypto from "node:crypto";
import type {
  AgentPlan,
  AgentPlanStep,
  AgentTask,
  AgentTodo,
} from "../../../shared/types/aiHub";
import { analyzeCommandSafety } from "./CommandSafetyService";
import { boundedContext } from "./privacy";

/**
 * Plan first, then act. For a change that is risky or that the user asked to
 * see planned, the agent proposes a structured plan, a second read-only run
 * looks for what is wrong with it, and the user decides. While a plan waits,
 * and in a conversation where a plan was asked for and none is approved yet,
 * nothing that changes a system runs. None of this calls a model itself.
 */

/** `/plan` as a word of its own in the request asks for a plan before any change. */
const PLAN_FIRST = /(?:^|\s)\/plan\b/i;
export const wantsPlanFirst = (text: string): boolean => PLAN_FIRST.test(text);

const REJECTED_PREFIX = "[sshs3] The user did not approve the plan";

export const MAX_PLAN_STEPS = 20;
export const MAX_PLAN_REVISIONS = 3;

export const PLAN_TOOL = {
  name: "sshs3_plan_propose",
  description:
    "Propose a plan before changing anything, for the user to approve. Use it when the user asks for a plan (`/plan`), and on your own for a change that is risky: several steps on production, data that could be lost, something hard to undo. Investigate first (read-only) so the plan rests on what is actually there. Each step names its target, the exact command where there is one, its risk, the check that will show it worked and, for medium or high risk, how to undo it. The plan is reviewed by a second read-only run and then waits for the user: until they approve, commands that change something and file writes are refused. After calling this, tell the user the plan briefly, with the review's findings, and stop.",
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string", description: "What will be true when the plan is done, in the user's terms." },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: MAX_PLAN_STEPS,
        items: {
          type: "object",
          properties: {
            action: { type: "string", description: "What is done, in one sentence." },
            target: { type: "string", description: "The server, cluster, file or service." },
            command: { type: "string", description: "The exact command, when the step is one. An approved plan's commands run without asking again." },
            risk: { type: "string", enum: ["low", "medium", "high"] },
            check: { type: "string", description: "The command and expected output that show the step worked." },
            rollback: { type: "string", description: "How to undo the step. Required for medium and high risk." },
          },
          required: ["action", "risk", "check"],
          additionalProperties: false,
        },
      },
      assumptions: {
        type: "array",
        items: { type: "string" },
        description: "What the plan takes for granted and you have not checked.",
      },
    },
    required: ["goal", "steps"],
    additionalProperties: false,
  },
} as const;

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? boundedContext(value.trim(), max) : "";

/** The model's `sshs3_plan_propose` argument as a plan (without status or review), or why it is not one. */
export function parsePlan(
  input: unknown,
): { goal: string; steps: AgentPlanStep[]; assumptions: string[] } | { error: string } {
  const p = (input ?? {}) as Record<string, unknown>;
  const goal = text(p.goal, 600);
  if (!goal) return { error: "A plan needs a `goal`" };
  if (!Array.isArray(p.steps) || p.steps.length === 0)
    return { error: "A plan needs at least one step" };
  if (p.steps.length > MAX_PLAN_STEPS)
    return { error: `At most ${MAX_PLAN_STEPS} steps; a longer job is several plans` };
  const steps: AgentPlanStep[] = [];
  for (const [index, raw] of p.steps.entries()) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const n = index + 1;
    const action = text(s.action, 400);
    if (!action) return { error: `Step ${n} has no action` };
    const risk = s.risk;
    if (risk !== "low" && risk !== "medium" && risk !== "high")
      return { error: `Step ${n}: risk must be low, medium or high` };
    const check = text(s.check, 500);
    if (!check)
      return { error: `Step ${n} ("${action.slice(0, 60)}") has no check: say how it will be shown to have worked` };
    const rollback = text(s.rollback, 500);
    if (risk !== "low" && !rollback)
      return { error: `Step ${n} ("${action.slice(0, 60)}") is ${risk} risk and has no rollback` };
    const command = text(s.command, 2000);
    // A command that deletes or overwrites is never "low risk", whatever the plan calls it.
    if (command && risk === "low" && analyzeCommandSafety(command).riskLevel === "destructive")
      return { error: `Step ${n}: \`${command.slice(0, 80)}\` is destructive; it cannot be low risk, and it needs a rollback` };
    const target = text(s.target, 200);
    steps.push({
      action,
      ...(target ? { target } : {}),
      ...(command ? { command } : {}),
      risk,
      check,
      ...(rollback ? { rollback } : {}),
    });
  }
  const assumptions = Array.isArray(p.assumptions)
    ? p.assumptions.map((a) => text(a, 300)).filter(Boolean).slice(0, 12)
    : [];
  return { goal, steps, assumptions };
}

export function newPlan(
  parsed: { goal: string; steps: AgentPlanStep[]; assumptions: string[] },
  previous: AgentPlan | undefined,
  review: AgentPlan["review"],
  now = Date.now(),
): AgentPlan {
  return {
    id: crypto.randomUUID(),
    goal: parsed.goal,
    steps: parsed.steps,
    ...(parsed.assumptions.length > 0 ? { assumptions: parsed.assumptions } : {}),
    status: "proposed",
    revision: (previous?.revision ?? 0) + 1,
    review,
    createdAt: now,
  };
}

export function renderPlan(plan: Pick<AgentPlan, "goal" | "steps" | "assumptions">): string {
  return [
    `Goal: ${plan.goal}`,
    ...plan.steps.map((s, i) =>
      [
        `${i + 1}. [${s.risk} risk] ${s.action}${s.target ? ` (on ${s.target})` : ""}`,
        ...(s.command ? [`   command: ${s.command}`] : []),
        `   check: ${s.check}`,
        ...(s.rollback ? [`   rollback: ${s.rollback}`] : []),
      ].join("\n"),
    ),
    ...(plan.assumptions?.length
      ? ["Assumptions (not checked):", ...plan.assumptions.map((a) => `- ${a}`)]
      : []),
  ].join("\n");
}

// --------------------------------------------------------------------- review

export function reviewerPrompt(
  plan: Pick<AgentPlan, "goal" | "steps" | "assumptions">,
  request: string,
): string {
  return [
    "You review an operations plan before it is shown to the person who must approve it. Another agent wrote it; you are the check that it is safe and complete. You change nothing.",
    `What the user asked for: ${boundedContext(request, 1500)}`,
    "",
    "Use your tools to test the plan against the workspace: `workspace_context` (the servers, the team's recent activity, the team's memory), `sshs3_kb_search` (runbooks for this kind of change), `sshs3_storage_ops` (the configuration files the plan touches).",
    "Report only real problems, each in one sentence that names the step:",
    "- a check that would pass even if the step had failed, or that does not test the original symptom;",
    "- a medium or high risk step whose rollback would not actually restore the previous state;",
    "- steps in an order that causes an outage or loses data;",
    "- an assumption the workspace contradicts (a colleague's recent change, a team note, the file as it is);",
    "- a step the goal does not need, or a step the goal needs that is missing;",
    "- a command that does something other than its step says.",
    "Do not rewrite the plan and do not list matters of taste. A sound plan has no findings.",
    "",
    'Answer with JSON only: {"verdict":"approve"|"revise","findings":["…"]}. `revise` means at least one finding must be fixed before a person should approve this.',
    "",
    "The plan:",
    renderPlan(plan),
  ].join("\n");
}

/** The reviewer's answer; `unreviewed` with the reason when it is not the requested JSON. */
export function parseReview(answer: string): AgentPlan["review"] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(answer);
  const body = (fenced ? fenced[1] : answer).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  try {
    if (start < 0 || end <= start) throw new Error("no JSON");
    const value = JSON.parse(body.slice(start, end + 1)) as {
      verdict?: unknown;
      findings?: unknown;
    };
    const findings = Array.isArray(value.findings)
      ? value.findings
          .filter((f): f is string => typeof f === "string" && f.trim() !== "")
          .map((f) => boundedContext(f.trim(), 400))
          .slice(0, 8)
      : [];
    if (value.verdict !== "approve" && value.verdict !== "revise")
      throw new Error("no verdict");
    // "approve" with findings is not an approval.
    return { verdict: findings.length > 0 ? "revise" : value.verdict, findings };
  } catch {
    return {
      verdict: "unreviewed",
      findings: ["The reviewer did not answer in the requested form; this plan has not been reviewed."],
    };
  }
}

// ----------------------------------------------------------------------- gate

const lastUserText = (task: AgentTask): string =>
  task.messages.filter((m) => m.role === "user").at(-1)?.text ?? "";

/** Whether the conversation is waiting for, or has been asked for, a plan that is not approved. */
export function planPending(task: AgentTask): boolean {
  if (task.plan?.status === "proposed") return true;
  const last = lastUserText(task);
  // The run that revises a plan the user sent back is still planning.
  if (task.plan?.status === "rejected" && last.startsWith(REJECTED_PREFIX))
    return true;
  return wantsPlanFirst(last) && task.plan?.status !== "approved";
}

/**
 * Why a tool call may not run now, if it may not: while a plan is pending,
 * nothing that changes a system does. Reading is always allowed, so the agent
 * can investigate for its plan.
 */
export function planGate(
  task: AgentTask,
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  if (!planPending(task)) return undefined;
  const command = typeof args.command === "string" ? args.command : "";
  const changes =
    tool === "file_write" ||
    ((tool === "terminal_command" || tool === "sshs3_cluster_exec") &&
      command !== "" &&
      analyzeCommandSafety(command).riskLevel !== "safe");
  if (!changes) return undefined;
  return task.plan?.status === "proposed"
    ? "A plan is waiting for the user's approval. Nothing that changes a system runs until they approve it. Tell the user the plan and stop; read-only checks are still allowed."
    : "The user asked for a plan first. Propose it with sshs3_plan_propose and wait for their approval before changing anything; read-only checks are allowed.";
}

/**
 * Whether an approved plan covers this command, so it need not be asked about
 * again: the exact command of a step that has not run yet, and not a
 * destructive one. Marks the step as run.
 */
export function planCoversCommand(
  task: AgentTask,
  command: string | undefined,
  riskLevel: string | undefined,
  now = Date.now(),
): boolean {
  if (task.plan?.status !== "approved" || !command) return false;
  if (riskLevel === "destructive") return false;
  const wanted = command.trim();
  const step = task.plan.steps.find(
    (s) => !s.ranAt && s.command?.trim() === wanted,
  );
  if (!step) return false;
  step.ranAt = now;
  return true;
}

/** The task list an approved plan starts from: one item per step, with its check. */
export function todosFromPlan(plan: AgentPlan): AgentTodo[] {
  return plan.steps.map((s, i) => ({
    id: `p${i + 1}`,
    content: boundedContext(
      `${s.action}${s.target ? ` (on ${s.target})` : ""} — check: ${s.check}`,
      300,
    ),
    status: "pending",
  }));
}

export function approvalMessage(plan: AgentPlan, note?: string): string {
  return [
    "[sshs3] The user approved your plan. Carry it out now, step by step, in order.",
    "Your task list has been set to the plan's steps. Run each step's check before the next step; if a check fails, stop, do not continue with later steps, and report (roll the step back if the plan says how and it is safe to).",
    "Commands exactly as the plan lists them run without asking the user again. Anything else you find you need is a deviation: say so, and it will be asked about as usual.",
    ...(note ? [`The user added: ${boundedContext(note, 1000)}`] : []),
    "",
    renderPlan(plan),
  ].join("\n");
}

export function rejectionMessage(note: string): string {
  return `${REJECTED_PREFIX} and asks for changes: ${boundedContext(note, 2000)}\nRevise the plan and propose it again with sshs3_plan_propose. Change nothing until a plan is approved.`;
}
