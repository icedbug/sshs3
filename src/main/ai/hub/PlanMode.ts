import crypto from "node:crypto";
import type {
  AgentChange,
  AgentChangeApproval,
  AgentMessage,
  AgentMode,
  AgentPlan,
  AgentPlanStep,
  AgentTask,
  AgentTodo,
  ClusterSafetyPolicy,
  SafetyPolicyConfig,
  WorkspaceActivityEvent,
} from "../../../shared/types/aiHub";
import { isPlainCommand } from "../../../shared/types/aiHub";
import { APP_OPS, type AppOpClass } from "./AppGuard";
import { isProdTag } from "./safetyPolicy";
import { boundedContext, clip, exactHash, maskContext } from "./privacy";

/**
 * Plan first, then act. For a change that is risky or that the user asked to
 * see planned (via `mode === "plan"` or `/plan`), the agent proposes a
 * structured plan, a second run that only looks searches it for what is wrong,
 * and the user decides. While a plan waits, and in a conversation where a plan
 * was asked for and none is approved yet, change cards, file writes, tools of
 * other systems and changing settings are held. Commands are not: nothing looks
 * at what a command does, so the agent is told to make no change with one. None
 * of this calls a model itself.
 */

/** `/plan` as a word of its own in the request asks for a plan before any change. */
const PLAN_FIRST = /(?:^|\s)\/plan\b/i;
export const isPlanMode = (mode?: AgentMode): boolean => mode === "plan";
export const wantsPlanFirst = (text: string, mode?: AgentMode): boolean =>
  isPlanMode(mode) || PLAN_FIRST.test(text);

const REJECTED_PREFIX = "[sshs3] The user did not approve the plan";

export const MAX_PLAN_STEPS = 20;
export const MAX_PLAN_REVISIONS = 3;

export const PLAN_TOOL = {
  name: "sshs3_plan_propose",
  description:
    "Propose a plan before changing anything, for the user to approve. Use it when the user asks for a plan (`/plan`), and on your own for a change that is risky: several steps on production, data that could be lost, something hard to undo. Investigate first, with commands that only look, so the plan rests on what is actually there. Each step names its target, the exact command where there is one, its risk, the check that will show it worked and, for medium or high risk, how to undo it. The plan is reviewed by a second run that only looks and then waits for the user: until they approve, change cards (sshs3_change) and file writes are refused. terminal_command still runs, so change nothing with it. What the approval covers: a change card the plan lists, made with sshs3_change exactly as the step gives it (command, check, checkExpected, rollback), runs without asking the user again. Do not write that each step will be approved separately unless that is what should happen: then set `askBeforeEachChange`, and every change card asks again. After calling this, tell the user the plan briefly, with the review's findings, and stop.",
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
            target: { type: "string", description: "The server the step runs on, by the name its terminal shows, then the file or service on it if that helps: \"web-02: /etc/nginx/nginx.conf\". Leave it out, or give only a path, for a step on the server of this conversation. The approval covers the step only on the server named here." },
            command: { type: "string", description: "The exact command, when the step is one. Made with sshs3_change exactly as listed here, it runs without asking again once the plan is approved." },
            risk: { type: "string", enum: ["low", "medium", "high"] },
            check: { type: "string", description: "The command and expected output that show the step worked. The command must exit with code 0 when the step worked: a check whose last command exits non-zero on success (a `diff` that finds the change, a `grep` that should match nothing) counts as failed and the step is rolled back." },
            checkExpected: { type: "string", description: "For a checked change, supply the exact expected text and give its exact command in check." },
            observeSeconds: { type: "number", description: "Seconds to watch the check after the change, up to 180." },
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
      askBeforeEachChange: {
        type: "boolean",
        description: "True when the user should be asked again before each change card, also the ones this plan lists (the user asked for that). Left out, approving the plan covers the change cards it lists.",
      },
    },
    required: ["goal", "steps"],
    additionalProperties: false,
  },
} as const;

/** A text of the plan that is read from its start: masked, and cut at its end when too long. */
const text = (value: unknown, max: number): string =>
  typeof value === "string" ? clip(value.trim(), max) : "";

/** The longest command, check or rollback a plan step may carry. */
export const MAX_PLAN_FIELD = 2000;

/**
 * A command, check or rollback of a step: what the person approves, so it is
 * shown whole or the plan is refused. Never shortened: an approval of half a
 * check is an approval of something the person did not see.
 */
function whole(value: unknown, step: number, what: string): { text: string } | { error: string } {
  const shown = typeof value === "string" ? maskContext(value.trim()) : "";
  return shown.length > MAX_PLAN_FIELD
    ? {
        error: `Step ${step}: the ${what} is ${shown.length} characters, and at most ${MAX_PLAN_FIELD} can be shown in full for approval. Make it shorter, or split the step.`,
      }
    : { text: shown };
}

/**
 * A plan whose own words say that its approval is not enough for its changes
 * ("separate approval before each modifying command", "plan approval must not
 * substitute"). The person reads those words on the card, so they hold: such
 * a plan's change cards ask again. It only ever makes more be asked.
 */
const PROMISES_TO_ASK = [
  // eslint-disable-next-line security/detect-unsafe-regex -- alternatives of fixed words, each optional group taken at most once; the text is a plan's bounded fields
  /\b(?:separate|individual|explicit|additional|another|further|per[- ](?:command|step|change))\s+(?:user\s+|human\s+|operator\s+)?(?:approvals?|confirmations?|consent|sign[- ]?off)\b/i,
  /\b(?:approv\w*|confirm\w*|ask\w*|consent|sign[- ]?off)\b[^.\n]{0,60}\b(?:before|for|prior to)\s+(?:each|every|any)\b/i,
  // eslint-disable-next-line security/detect-unsafe-regex -- the gap is bounded ({0,60}) and stops at a full stop or line end
  /\b(?:each|every)\s+(?:modifying\s+|changing\s+|mutating\s+)?(?:command|step|change)\b[^.\n]{0,60}\b(?:approved|confirmed|asked about)\s+(?:separately|individually|again|first)\b/i,
  /\bplan approval\b[^.\n]{0,40}\b(?:must|does|will|should|is)\s+not\b/i,
];
export const promisesToAskEach = (plan: Pick<AgentPlan, "goal" | "steps" | "assumptions">): boolean => {
  const said = [plan.goal, ...plan.steps.flatMap((s) => [s.action, s.check, s.rollback ?? ""]), ...(plan.assumptions ?? [])].join("\n");
  return PROMISES_TO_ASK.some((p) => p.test(said));
};

/** The model's `sshs3_plan_propose` argument as a plan (without status or review), or why it is not one. */
export function parsePlan(
  input: unknown,
): { goal: string; steps: AgentPlanStep[]; assumptions: string[]; askEach?: boolean } | { error: string } {
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
    const shownCheck = whole(s.check, n, "check");
    if ("error" in shownCheck) return shownCheck;
    const check = shownCheck.text;
    if (!check)
      return { error: `Step ${n} ("${action.slice(0, 60)}") has no check: say how it will be shown to have worked` };
    const shownRollback = whole(s.rollback, n, "rollback");
    if ("error" in shownRollback) return shownRollback;
    const rollback = shownRollback.text;
    if (risk !== "low" && !rollback)
      return { error: `Step ${n} ("${action.slice(0, 60)}") is ${risk} risk and has no rollback` };
    const rawCommand = typeof s.command === "string" ? s.command.trim() : "";
    const shownCommand = whole(s.command, n, "command");
    if ("error" in shownCommand) return shownCommand;
    const command = shownCommand.text;
    const shownExpected = whole(s.checkExpected, n, "expected check output");
    if ("error" in shownExpected) return shownExpected;
    if (s.observeSeconds !== undefined && (typeof s.observeSeconds !== "number" || !Number.isInteger(s.observeSeconds) || s.observeSeconds < 0 || s.observeSeconds > 180))
      return { error: "The observation time must be a whole number from 0 to 180." };
    const target = text(s.target, 200);
    steps.push({
      action,
      ...(target ? { target } : {}),
      ...(command ? { command, commandHash: exactHash(rawCommand) } : {}),
      risk,
      check,
      ...(rollback ? { rollback } : {}),
      ...(shownExpected.text ? { checkExpected: shownExpected.text } : {}),
      ...(typeof s.observeSeconds === "number" ? { observeSeconds: s.observeSeconds } : {}),
    });
  }
  const assumptions = Array.isArray(p.assumptions)
    ? p.assumptions.map((a) => text(a, 300)).filter(Boolean).slice(0, 12)
    : [];
  const askEach = p.askBeforeEachChange === true || promisesToAskEach({ goal, steps, assumptions });
  return { goal, steps, assumptions, ...(askEach ? { askEach } : {}) };
}

export function newPlan(
  parsed: { goal: string; steps: AgentPlanStep[]; assumptions: string[]; askEach?: boolean },
  previous: AgentPlan | undefined,
  review: AgentPlan["review"],
  now = Date.now(),
  askedFor = false,
): AgentPlan {
  // A revision of a plan that was asked for was asked for too. A plan after an approved one is a new plan.
  const asked = askedFor || (previous?.status !== "approved" && previous?.askedFor === true);
  return {
    id: crypto.randomUUID(),
    goal: parsed.goal,
    steps: parsed.steps,
    ...(parsed.assumptions.length > 0 ? { assumptions: parsed.assumptions } : {}),
    status: "proposed",
    revision: (previous?.revision ?? 0) + 1,
    review,
    createdAt: now,
    ...(parsed.askEach ? { askEach: "plan" as const } : {}),
    ...(asked ? { askedFor: true } : {}),
  };
}

export interface PlanApprovalDecision {
  note?: string;
  /** Explicit user choice to be asked before every change card, also the ones the plan lists. */
  askPerStep?: boolean;
  /** Legacy alias for `askPerStep`. */
  askEach?: boolean;
}

/**
 * What an approval of this plan covers, decided when the person approves and
 * written on the plan. Only an explicit `askPerStep` / `askEach` choice or the
 * plan's own promise sets per-step confirmation: typing a review/revision note
 * never silently flips `askEach` to `true` behind the user's back.
 */
export function approvalAsksEach(
  plan: Pick<AgentPlan, "askEach">,
  decision: PlanApprovalDecision,
): AgentPlan["askEach"] {
  const explicit = decision.askPerStep !== undefined ? decision.askPerStep : decision.askEach;
  if (explicit === true) return "person";
  if (plan.askEach === "plan") return "plan";
  return undefined;
}

/** Explicit boolean view of whether per-step approval is required on approval. */
export function resolveAskPerStep(
  plan: Pick<AgentPlan, "askEach">,
  decision: PlanApprovalDecision = {},
): boolean {
  return Boolean(approvalAsksEach(plan, decision));
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
    `What the user asked for: ${clip(request, 1500)}`,
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

const lastUserText = (task: Pick<AgentTask, "messages">): string =>
  task.messages.filter((m) => m.role === "user").at(-1)?.text ?? "";

/**
 * The words the hub's own messages start with, for a message stored before the hub marked its own
 * (`by`): its word that a plan was approved or sent back, and the line a resumed conversation starts
 * with (areas/conversations.ts, "resume").
 */
const HUB_WRITTEN = /^(?:\[sshs3\] |Resume on this terminal\.|Resume the conversation\.$|You have \d+ more commands and \d+ more minutes\. Continue where you stopped\.)/;

/**
 * A user message the hub wrote itself, not the person. Told by the mark the hub puts on its own;
 * only a message stored before that mark existed is told by its words. A person who types the hub's
 * words is still the person.
 */
export const hubWrote = (message: Pick<AgentMessage, "role" | "text" | "by">): boolean =>
  message.role === "user" && (message.by ? message.by === "hub" : HUB_WRITTEN.test(message.text));

/** What the person last wrote, the hub's own messages left out. */
export const lastPersonText = (task: Pick<AgentTask, "messages">): string =>
  task.messages.filter((m) => m.role === "user" && !hubWrote(m)).at(-1)?.text ?? "";

/** Whether the request a plan is proposed for asked for one (`/plan`). */
export const planAskedFor = (task: Pick<AgentTask, "messages">): boolean => PLAN_FIRST.test(lastPersonText(task));

/**
 * Why an approved plan does not cover a new change any more, if it does not: every step of it
 * has run ("done"), or the person has written since they approved it ("new-request"). An approval
 * is for the plan that was shown, not for whatever the conversation turns to afterwards.
 */
export function approvedPlanOver(task: Pick<AgentTask, "plan" | "messages">): "done" | "new-request" | undefined {
  const plan = task.plan;
  if (plan?.status !== "approved") return undefined;
  if (plan.steps.length > 0 && plan.steps.every((step) => step.ranAt)) return "done";
  const since = plan.decidedAt;
  if (since !== undefined && task.messages.some((m) => m.role === "user" && m.at >= since && !hubWrote(m)))
    return "new-request";
  return undefined;
}

/**
 * Whether the conversation is waiting for, or has been asked for, a plan that is not approved, or
 * was asked for one and the plan that was approved is over.
 */
export function planPending(task: Pick<AgentTask, "mode" | "plan" | "messages">): boolean {
  if (task.plan?.status === "proposed") return true;
  const lastMessage = task.messages.filter((m) => m.role === "user").at(-1);
  const last = lastMessage?.text ?? "";
  // The run that revises a plan the user sent back is still planning.
  if (task.plan?.status === "rejected" && lastMessage && hubWrote(lastMessage) && last.startsWith(REJECTED_PREFIX))
    return true;
  // An approved plan that was asked for, in any mode: once it is over, a new change needs a new plan.
  // The last message is then the hub's word that the plan was approved, which holds no `/plan`.
  if (task.plan?.status === "approved" && (isPlanMode(task.mode) || task.plan.askedFor) && approvedPlanOver(task) !== undefined)
    return true;
  return wantsPlanFirst(last, task.mode) && (task.plan?.status !== "approved" || approvedPlanOver(task) !== undefined);
}

/**
 * Why a tool call may not run now, if it may not: while a plan is pending, a
 * change card, a file write, a tool of another system and a changing setting
 * are held. A command is not held, so the agent can investigate for its plan:
 * nothing looks at what a command does, and the agent is told to change
 * nothing with one.
 */
/** What a management tool's call would do: read, or write something. */
function appOpClass(tool: string, args: Record<string, unknown>): AppOpClass | undefined {
  const spec = APP_OPS[tool];
  if (!spec) return undefined;
  const op = typeof args.operation === "string" && args.operation.trim() ? args.operation.trim() : spec.fallback;
  return spec.ops[op] ?? "change";
}

export function planGate(
  task: Pick<AgentTask, "mode" | "plan" | "messages">,
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  if (!planPending(task)) return undefined;
  const changes =
    tool === "file_write" ||
    // A change is a change whatever its check says.
    tool === "sshs3_change" ||
    // A tool on somebody else's MCP server changes something outside sshs3, unless
    // that server said the tool only looks; the call itself decides below.
    tool.startsWith("mcp__") ||
    // And so does a management tool that writes: saving a server, a schedule, a
    // memory. Only the ones that read are let through while a plan waits.
    appOpClass(tool, args) === "change" ||
    appOpClass(tool, args) === "guard" ||
    appOpClass(tool, args) === "guard-if";
  if (!changes) return undefined;
  const over = approvedPlanOver(task);
  if (over === "done")
    return "Every step of the approved plan has run. A new change needs a new plan: propose it with sshs3_plan_propose and wait for the user's approval. Commands still run; make no change.";
  if (over === "new-request") {
    // What was approved is still approved: a step of the plan that has not run yet is not held. A
    // step with a command is the change card of that command; one without (a file to write) is a
    // file write to the path the step names.
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (tool === "sshs3_change" && command && task.plan!.steps.some((step) => !step.ranAt && step.commandHash === exactHash(command)))
      return undefined;
    const file = tool === "file_write" && typeof args.path === "string" ? args.path.trim() : "";
    if (file && task.plan!.steps.some((step) => !step.ranAt && !step.command && namesPath(step, file)))
      return undefined;
    return "The user has written since they approved the plan. A change that plan does not list needs a new plan: propose it with sshs3_plan_propose and wait for their approval. Commands still run; make no change.";
  }
  if (task.plan?.status === "proposed") {
    return "A plan is waiting for the user's approval. No change card and no file write runs until they approve it. Tell the user the plan and stop. Commands still run; make no change.";
  }
  if (isPlanMode(task.mode) && !PLAN_FIRST.test(lastUserText(task))) {
    return "This conversation is in Plan mode. Propose a plan with sshs3_plan_propose and wait for the user's approval before changing anything. Commands still run; make no change.";
  }
  return "The user asked for a plan first. Propose it with sshs3_plan_propose and wait for their approval before changing anything. Commands still run; make no change.";
}

/**
 * Whether a name stands in a text as a whole word, as a server's name or address does in a plan
 * step's target: "web-02" does in "web-02 (staging): /tmp/x" and in "ops@web-02:/etc", not in
 * "web-020" or in the other host "web-02.example.com". Letters are compared without case.
 */
export function namesWhole(text: string, name: string | undefined): boolean {
  const t = text.toLowerCase();
  const n = name?.trim().toLowerCase();
  if (!n) return false;
  for (let i = t.indexOf(n); i >= 0; i = t.indexOf(n, i + 1)) {
    const before = i > 0 ? t[i - 1] : "";
    const after = t.slice(i + n.length, i + n.length + 2);
    if (!/[a-z0-9_.-]/.test(before) && !/^(?:[a-z0-9_-]|\.[a-z0-9_-])/.test(after)) return true;
  }
  return false;
}

/** What a terminal is to a plan step: where it is open, and which server, when the workspace knows it. */
export interface StepTerminal {
  id: string;
  generation: string;
  label: string;
  profileId?: string;
}

/**
 * The terminal a plan step runs on, from what its target says. A change card the approved plan lists
 * runs without a second question only on that terminal (`planCoversCommand`), so a step that gets none
 * is asked about again, which is the safe way to be wrong.
 *
 * - The server the target names, by a known server's name, address or id, or a terminal's label or id,
 *   standing in it as a whole word ("web-02 (staging): /etc/nginx/nginx.conf" names web-02). That
 *   server's terminal, or the conversation's own one when that server is open in several.
 * - No target, or a target that is only a path: the conversation's own terminal, which is where the
 *   person who approves the plan sees it working.
 * - None when the target names more than one server, a server with no terminal open, a server open in
 *   several terminals none of which is the conversation's, or nothing a server is told by (a service).
 */
export function stepTerminal<T extends StepTerminal>(
  target: string | undefined,
  terminals: readonly T[],
  servers: ReadonlyArray<{ id: string; name?: string; host?: string }>,
  own: { sessionId: string; generation: string } | undefined,
): T | undefined {
  const mine = own ? terminals.find((s) => s.id === own.sessionId && s.generation === own.generation) : undefined;
  const text = target?.trim();
  if (!text) return mine;
  const known = new Set(servers.map((s) => s.id));
  // A terminal on a known server is that server; one the workspace does not know is told by its label.
  const serverOf = (s: T): string => (s.profileId && known.has(s.profileId) ? s.profileId : s.profileId ? `profile:${s.profileId}` : `label:${s.label.toLowerCase()}`);
  const named = new Set<string>();
  for (const server of servers) if ([server.id, server.name, server.host].some((n) => namesWhole(text, n))) named.add(server.id);
  for (const s of terminals) if ([s.id, s.label, s.profileId].some((n) => namesWhole(text, n))) named.add(serverOf(s));
  if (named.size === 0) return /^[~/]\S*$/.test(text) ? mine : undefined;
  if (named.size > 1) return undefined;
  const [server] = named;
  const open = terminals.filter((s) => serverOf(s) === server);
  return open.length === 1 ? open[0] : open.find((s) => s === mine);
}

/** Whether a plan step without a command names this file: in what it does, or as its target. */
function namesPath(step: Pick<AgentPlanStep, "action" | "target">, file: string): boolean {
  return file.length > 1 && (step.action.includes(file) || step.target?.trim() === file);
}

/** A change in these states has run, whatever came of it. */
const RAN: ReadonlySet<AgentChange["status"]> = new Set(["running", "completed", "failed", "uncertain"]);

/**
 * A change card, a plain command or a file write of the run has run: the step of the approved plan it
 * carries out is marked as run, however it was let through. Where the plan covered it, the broker
 * marked it when it let it through (`planCoversCommand`); this marks the rest: a change card the
 * person was asked about (a plan that asks about each change), a plain command of such a plan, and a
 * file write, which no plan covers. A step with a command is matched on that exact command and its
 * terminal; a step without one, on its terminal and the file's path in what the step says.
 */
export function markPlanStepRan(
  task: Pick<AgentTask, "plan">,
  change: Pick<AgentChange, "kind" | "status" | "commandHash" | "targetKey" | "description" | "decidedHow" | "check" | "rollback" | "toolCall">,
  now = Date.now(),
): void {
  const plan = task.plan;
  if (plan?.status !== "approved" || !RAN.has(change.status)) return;
  if (change.decidedHow === "plan") return;
  if (change.kind === "command" && isPlainCommand(change) && !plan.askEach) return;
  const onTarget = (step: AgentPlanStep): boolean => !step.approvedTarget || step.approvedTarget === change.targetKey;
  let step: AgentPlanStep | undefined;
  if (change.kind === "command" && change.commandHash && !change.toolCall)
    step = plan.steps.find((s) => !s.ranAt && s.commandHash === change.commandHash && onTarget(s));
  if (change.kind === "file") {
    // A file write's description starts with its path (FileTools).
    const file = change.description.split(" — ")[0].trim();
    step = plan.steps.find((s) => !s.ranAt && !s.command && onTarget(s) && namesPath(s, file));
  }
  if (step) step.ranAt = now;
}

/**
 * Whether an approved plan covers this command, so it need not be asked about
 * again: the exact command of a step that has not run yet. Marks the step as run.
 */
export function planCoversCommand(
  task: AgentTask,
  commandHash: string | undefined,
  now = Date.now(),
  action?: { targetKey?: string; check?: { command?: string; expected?: string }; rollback?: string; observeSeconds?: number; extras?: boolean },
  consume = true,
): boolean {
  if (!action?.targetKey || action.extras) return false;
  if (task.plan?.status !== "approved" || !commandHash) return false;
  // The plan, or the person approving it, said that every change is asked about.
  if (task.plan.askEach) return false;
  // Matched on the exact command, never on how it looks once its secrets are masked.
  const step = task.plan.steps.find((s) =>
    !s.ranAt && s.approvedTarget === action.targetKey && s.commandHash === commandHash &&
    (action.check
      ? Boolean(s.checkExpected) && s.check === action.check.command?.trim() && s.checkExpected === action.check.expected?.trim() &&
        s.rollback === action.rollback?.trim() && (s.observeSeconds ?? 0) === (action.observeSeconds ?? 0)
      : !s.checkExpected),
  );
  if (!step) return false;
  if (consume) step.ranAt = now;
  return true;
}

/**
 * Whether the people who approved a plan are enough for one of the commands it lists, when that
 * command needs more than one person. They are when as many different people approved the plan as
 * the command needs, one of them is somebody other than the person the run acts for, and, for a
 * command on production, the plan was approved as one for production (so whoever approved it as the
 * second person was somebody who may approve there). Returns the people, or nothing.
 */
export function planApprovalsCover(
  plan: Pick<AgentPlan, "status" | "approvals" | "production"> | undefined,
  needed: number,
  requesterId: string | undefined,
  production: boolean,
): AgentChangeApproval[] | undefined {
  if (plan?.status !== "approved") return undefined;
  if (production && !plan.production) return undefined;
  const seen = new Set<string>();
  const people: AgentChangeApproval[] = [];
  for (const vote of plan.approvals ?? []) {
    if (!vote.allowed) return undefined;
    const key = approverKey(vote);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    people.push(vote);
  }
  if (people.length < Math.max(2, needed)) return undefined;
  const requester = requesterId?.trim().toLowerCase();
  if (requester && !people.some((vote) => approverKey(vote) !== requester)) return undefined;
  return people;
}

/** The task list an approved plan starts from: one item per step, with its check. */
export function todosFromPlan(plan: AgentPlan): AgentTodo[] {
  return plan.steps.map((s, i) => ({
    id: `p${i + 1}`,
    content: clip(
      `${s.action}${s.target ? ` (on ${s.target})` : ""} — check: ${s.check}`,
      300,
    ),
    status: "pending",
  }));
}

const ASKS_EACH_WHY: Record<NonNullable<AgentPlan["askEach"]>, string> = {
  plan: "the plan said so",
  person: "the user chose that when approving",
  note: "the user approved with a note, and the note is theirs to have followed",
};

export function approvalMessage(plan: AgentPlan, note?: string): string {
  return [
    "[sshs3] The user approved your plan. Carry it out now, step by step, in order.",
    "Your task list has been set to the plan's steps. Run each step's check before the next step; if a check fails, stop, do not continue with later steps, and report (roll the step back if the plan says how and it is safe to).",
    plan.askEach
      ? `Every change card is asked about before it runs, also the ones the plan lists: ${ASKS_EACH_WHY[plan.askEach]}. Make them one at a time with sshs3_change and wait for each answer. Commands that only look run as usual. Anything the plan does not list is a deviation: say so.`
      : "Make each change with sshs3_change, exactly as the plan lists it: then it runs without asking the user again. Do not tell the user that each change will be approved separately: it will not. Commands that only look run as usual. Anything else you find you need is a deviation: say so, and it will be asked about as usual.",
    ...(note ? [`The user added: ${boundedContext(note, 1000)}`] : []),
    // The review's findings were on the card the user approved. Without this the agent, told earlier to
    // fix them, refused in the lab to carry out the plan it had been allowed to, and nothing was done.
    ...(plan.review.verdict === "revise" && plan.review.findings.length > 0
      ? [
          `The review's findings were on the plan the user approved: ${plan.review.findings.map((f) => boundedContext(f, 400)).join(" ")}`,
          "The user approved the plan as it stands, so carry it out: do not stop to revise it. Where a finding shows a step would do harm, say so before that step and ask.",
        ]
      : []),
    "",
    renderPlan(plan),
  ].join("\n");
}

export function rejectionMessage(note: string): string {
  return `${REJECTED_PREFIX} and asks for changes: ${boundedContext(note, 2000)}\nRevise the plan and propose it again with sshs3_plan_propose. Change nothing until a plan is approved.`;
}

// ------------------------------------------------ collision & peer-approval checks

export const PLAN_COLLISION_WINDOW_MS = 15 * 60_000;

export interface CollidingChangeWarning {
  target: string;
  actor: string;
  kind: WorkspaceActivityEvent["kind"];
  summary: string;
  at: number;
  ageMinutes: number;
  stepIndexes: number[];
  message: string;
}

const normTarget = (value: string | undefined): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/**
 * Checks recent teammate activity (last 15 minutes by default) on the same
 * target(s) touched by a plan's steps, returning collision warnings.
 */
export function detectCollidingPlanChanges(
  plan: Pick<AgentPlan, "steps">,
  activity: ReadonlyArray<WorkspaceActivityEvent>,
  options?: {
    defaultTarget?: string;
    currentActor?: string;
    includeSelf?: boolean;
    includeNotes?: boolean;
    windowMs?: number;
    now?: number;
  },
): CollidingChangeWarning[] {
  const now = options?.now ?? Date.now();
  const windowMs = Math.max(0, options?.windowMs ?? PLAN_COLLISION_WINDOW_MS);
  const currentActor = normTarget(options?.currentActor);
  const stepsByTarget = new Map<string, { display: string; indexes: number[] }>();

  plan.steps.forEach((step, idx) => {
    const rawTarget = (step.target ?? options?.defaultTarget ?? "").trim();
    const key = normTarget(rawTarget);
    if (!key) return;
    const entry = stepsByTarget.get(key) ?? { display: rawTarget, indexes: [] };
    entry.indexes.push(idx);
    stepsByTarget.set(key, entry);
  });

  if (stepsByTarget.size === 0 || activity.length === 0) return [];

  const warnings: CollidingChangeWarning[] = [];
  for (const event of activity) {
    if (!options?.includeNotes && event.kind === "note") continue;
    if (!options?.includeSelf && currentActor && normTarget(event.actor) === currentActor) continue;
    if (event.at > now + 60_000 || now - event.at > windowMs) continue;

    const labelKey = normTarget(event.targetLabel);
    const profileKey = normTarget(event.profileId);
    const matched = stepsByTarget.get(labelKey) ?? (profileKey ? stepsByTarget.get(profileKey) : undefined);
    if (!matched) continue;

    const ageMinutes = Math.max(0, Math.round((now - event.at) / 60_000));
    const stepNumbers = matched.indexes.map((i) => i + 1);
    const summary = boundedContext(event.summary, 140);
    const actor = boundedContext(event.actor || "A teammate", 80);
    const ageLabel = ageMinutes === 0 ? "just now" : `${ageMinutes}m ago`;
    warnings.push({
      target: matched.display,
      actor,
      kind: event.kind,
      summary,
      at: event.at,
      ageMinutes,
      stepIndexes: matched.indexes,
      message: `Colliding change warning: ${actor} recorded ${event.kind} on ${matched.display} ${ageLabel} ("${summary}") affecting step(s) ${stepNumbers.join(", ")}.`,
    });
  }

  return warnings.sort((a, b) => b.at - a.at);
}

const PROD_NAME_TOKEN = /(?:^|[-_.:/\s])(prod|production|critical)(?:$|[-_.:/\s])/i;

/** Whether a plan targets production/critical infrastructure based on tags or target names. */
export function isProdPlan(
  plan: Pick<AgentPlan, "steps">,
  options?: { targetTags?: readonly string[]; defaultTarget?: string },
): boolean {
  if ((options?.targetTags ?? []).some(isProdTag)) return true;
  if (options?.defaultTarget && PROD_NAME_TOKEN.test(options.defaultTarget)) return true;
  return plan.steps.some((step) => Boolean(step.target && PROD_NAME_TOKEN.test(step.target)));
}

/** Number of distinct approvals required before executing a plan. */
export function requiredPlanApprovals(
  plan: Pick<AgentPlan, "steps">,
  options?: {
    targetTags?: readonly string[];
    defaultTarget?: string;
    requirePeerApprovalOnProd?: boolean;
    policy?: SafetyPolicyConfig;
    clusterPolicy?: ClusterSafetyPolicy;
  },
): number {
  const prod = isProdPlan(plan, options);
  const peerRequired =
    options?.requirePeerApprovalOnProd ??
    options?.policy?.requirePeerApprovalOnProd ??
    (options?.policy ? false : true);
  let required = prod && peerRequired ? 2 : 1;
  const clusterReq = options?.clusterPolicy?.requiredApprovals;
  if (typeof clusterReq === "number" && Number.isFinite(clusterReq) && clusterReq > 0) {
    required = Math.max(required, Math.floor(clusterReq));
  }
  return required;
}

export interface PlanApprovalStatus {
  isProd: boolean;
  requiredApprovals: number;
  validApprovals: AgentChangeApproval[];
  deniedBy?: AgentChangeApproval;
  distinctApprovers: string[];
  satisfied: boolean;
  remainingApprovals: number;
  reason?: string;
}

function approverKey(a: Pick<AgentChangeApproval, "actor" | "actorId">): string {
  return (a.actorId?.trim() || a.actor.trim()).toLowerCase();
}

/**
 * Evaluate single or two-person / multi-party peer approval on a plan.
 * Rejects self-only approval when `requiredApprovals >= 2` and optionally
 * excludes the proposer completely when `requireIndependentApprovers` is set.
 */
export function checkPlanApprovals(
  plan: Pick<AgentPlan, "steps">,
  options?: {
    approvals?: ReadonlyArray<AgentChangeApproval>;
    proposer?: string;
    requireIndependentApprovers?: boolean;
    targetTags?: readonly string[];
    defaultTarget?: string;
    requirePeerApprovalOnProd?: boolean;
    policy?: SafetyPolicyConfig;
    clusterPolicy?: ClusterSafetyPolicy;
  },
): PlanApprovalStatus {
  const isProd = isProdPlan(plan, options);
  const requiredApprovals = requiredPlanApprovals(plan, options);
  const approvals = options?.approvals ?? [];
  const deniedBy = approvals.find((a) => !a.allowed);
  const proposerKey = options?.proposer?.trim().toLowerCase() || "";

  const seen = new Set<string>();
  const validApprovals: AgentChangeApproval[] = [];
  const distinctApprovers: string[] = [];
  let sawProposerOnly = false;

  for (const vote of approvals) {
    if (!vote.allowed) continue;
    const key = approverKey(vote);
    if (!key) continue;
    if (options?.requireIndependentApprovers && proposerKey && key === proposerKey) {
      sawProposerOnly = true;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    validApprovals.push(vote);
    distinctApprovers.push(vote.actorId?.trim() || vote.actor.trim());
  }

  if (deniedBy) {
    return {
      isProd,
      requiredApprovals,
      validApprovals,
      deniedBy,
      distinctApprovers,
      satisfied: false,
      remainingApprovals: Math.max(0, requiredApprovals - distinctApprovers.length),
      reason: `Plan approval denied by ${deniedBy.actor}.`,
    };
  }

  const hasNonProposer =
    !proposerKey ||
    validApprovals.some((v) => approverKey(v) !== proposerKey);
  const countMet = distinctApprovers.length >= requiredApprovals;
  const peerMet = requiredApprovals < 2 || hasNonProposer;
  const satisfied = countMet && peerMet;
  const remainingApprovals = Math.max(0, requiredApprovals - distinctApprovers.length);

  let reason: string | undefined;
  if (!satisfied) {
    if (sawProposerOnly && distinctApprovers.length === 0) {
      reason = `Two-person approval requires ${requiredApprovals} independent peer approval(s); proposer cannot self-approve.`;
    } else if (!peerMet) {
      reason = `Production plan requires peer approval from another operator (${remainingApprovals} more needed).`;
    } else {
      reason = `${isProd ? "Production plan" : "Plan"} requires ${requiredApprovals} distinct approval(s); ${remainingApprovals} more needed.`;
    }
  }

  return {
    isProd,
    requiredApprovals,
    validApprovals,
    distinctApprovers,
    satisfied,
    remainingApprovals,
    ...(reason ? { reason } : {}),
  };
}
