import { lowerMode } from "./AppGuard";
import { planApprovalsCover, planCoversCommand } from "./PlanMode";
import crypto from "node:crypto";
import http from "node:http";
import type {
  AgentChange,
  AgentChangeStructuredCheck,
  AgentTask,
  ChatServiceName,
  ClusterSafetyPolicy,
  SafetyPolicyConfig,
  TerminalSession,
} from "../../../shared/types/aiHub";
import { isPlainCommand } from "../../../shared/types/aiHub";
import { CHAT_APP_TOOLS, mayKeepNotes, sensitiveFile, type ChatFenceCheck } from "./chatFence";
import type { TerminalRegistry } from "./TerminalRegistry";
import { isProdTag } from "./safetyPolicy";
import { boundedContext, exactHash, observationHash, forApproval, maskStrings, safeError, clip } from "./privacy";
import { scriptedDemoNote } from "../../sim/scripted";

/** A person's answer, and how it came about when nobody answered. */
interface Answer {
  allowed: boolean;
  how: NonNullable<AgentChange["decidedHow"]>;
  /** What the person said with the answer, for the agent to act on. */
  note?: string;
}

/** A changed service gets this long before a first failing look at its check counts. */
const SETTLE_MS = 3000;

export type ToolErrorCategory =
  | "schema_validation"
  | "precondition"
  | "auth_denied"
  | "execution";

export interface ToolErrorEnvelope {
  category: ToolErrorCategory;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  recoverable?: boolean;
}

/** How long an idempotency key is remembered: long past any retry, and not for as long as the app runs. */
export const IDEMPOTENCY_KEEP_MS = 24 * 3600_000;
const IDEMPOTENCY_PRUNE_EVERY_MS = 10 * 60_000;

/** How many times running one command may give one answer before it is not run again. */
const REPEAT_LIMIT = 3;
/** Only a repeat just now counts: the same check a while later is a new look at a system that may have moved. */
const REPEAT_WITHIN_MS = 90_000;

/** Whether the run's last commands were this one, each with one and the same output, the last of them just now. */
function repeatedWithSameAnswer(task: AgentTask, commandHash: string): boolean {
  const ran = task.changes.filter((c) => c.kind === "command" && (c.status === "completed" || c.status === "failed"));
  const last = ran.slice(-REPEAT_LIMIT);
  if (last.length < REPEAT_LIMIT || Date.now() - last[last.length - 1].at > REPEAT_WITHIN_MS) return false;
  return last.every((c) => c.commandHash === commandHash && c.output === last[0].output && c.exitCode === last[0].exitCode);
}

export class ToolBrokerError extends Error {
  readonly category: ToolErrorCategory;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly recoverable: boolean;
  readonly envelope: ToolErrorEnvelope;

  constructor(
    category: ToolErrorCategory,
    message: string,
    options?: {
      code?: string;
      details?: Record<string, unknown>;
      recoverable?: boolean;
    },
  ) {
    super(message);
    this.name = "ToolBrokerError";
    this.category = category;
    this.code = options?.code ?? category;
    this.details = options?.details;
    this.recoverable = options?.recoverable ?? category !== "auth_denied";
    this.envelope = {
      category: this.category,
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      recoverable: this.recoverable,
    };
  }
}

class ApprovalRequiredSignal extends Error {
  readonly code = "approval_required";
  constructor(readonly change: AgentChange) {
    super("Approval required");
    this.name = "ApprovalRequiredSignal";
  }
}

export type IdempotencyStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "uncertain";

export interface IdempotencyEntry {
  idempotencyKey: string;
  argsHash: string;
  status: IdempotencyStatus;
  result?: unknown;
  error?: string;
  at: number;
}

export type LifecycleHookStage = "pre_change" | "post_change";

export interface LifecycleHookContext {
  stage: LifecycleHookStage;
  task: AgentTask;
  request: ToolRequest;
  change?: AgentChange;
  result?: unknown;
  error?: unknown;
}

export interface LifecycleHookResult {
  allow?: boolean;
  reason?: string;
  patchChange?: Partial<
    Pick<
      AgentChange,
      "blastRadius" | "dryRunOutput" | "preflightSnapshot" | "requiredApprovals"
    >
  >;
}

export interface LifecycleHook {
  id: string;
  stage: LifecycleHookStage;
  when?: {
    actions?: string[];
  };
  run: (
    ctx: LifecycleHookContext,
  ) => Promise<LifecycleHookResult | void> | LifecycleHookResult | void;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function computeArgsHash(request: ToolRequest): string {
  const { idempotencyKey: _ignored, ...rest } = request;
  return crypto.createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

function validateStructuredCheck(
  check: AgentChangeStructuredCheck,
  label: string,
): void {
  if (!check || typeof check !== "object" || Array.isArray(check)) {
    throw new ToolBrokerError(
      "schema_validation",
      `${label} must be an object`,
      { code: "invalid_structured_check" },
    );
  }
  const hasAny =
    check.regex !== undefined ||
    check.maxNumber !== undefined ||
    check.equals !== undefined;
  if (!hasAny) {
    throw new ToolBrokerError(
      "schema_validation",
      `${label} must specify at least one of regex, maxNumber, or equals`,
      { code: "empty_structured_check" },
    );
  }
  if (check.regex !== undefined) {
    if (typeof check.regex !== "string" || !check.regex) {
      throw new ToolBrokerError(
        "schema_validation",
        `${label}.regex must be a non-empty string`,
        { code: "invalid_structured_check" },
      );
    }
    try {
      // eslint-disable-next-line security/detect-non-literal-regexp -- user/agent-supplied structuredCheck regex validated here
      new RegExp(check.regex, "m");
    } catch (error) {
      throw new ToolBrokerError(
        "schema_validation",
        `${label}.regex is not a valid regular expression: ${safeError(error)}`,
        { code: "invalid_structured_check" },
      );
    }
  }
  if (
    check.maxNumber !== undefined &&
    (typeof check.maxNumber !== "number" || !Number.isFinite(check.maxNumber))
  ) {
    throw new ToolBrokerError(
      "schema_validation",
      `${label}.maxNumber must be a finite number`,
      { code: "invalid_structured_check" },
    );
  }
  if (check.equals !== undefined && typeof check.equals !== "string") {
    throw new ToolBrokerError(
      "schema_validation",
      `${label}.equals must be a string`,
      { code: "invalid_structured_check" },
    );
  }
}

/** Terminal text can use either CRLF or LF. A lone CR and other whitespace are significant. */
function normalizeCheckText(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

/**
 * Whether output shows what a check expects: as a whole word or phrase, not
 * inside another word, so "inactive" does not pass for "active", plus optional
 * structured assertions (`regex`, `maxNumber`, `equals`).
 */
export function showsExpected(
  output: string,
  expectedText: string,
  structuredCheck?: AgentChangeStructuredCheck,
): boolean {
  const hasStructured = Boolean(
    structuredCheck &&
      (structuredCheck.regex !== undefined ||
        structuredCheck.maxNumber !== undefined ||
        structuredCheck.equals !== undefined),
  );
  if (!expectedText && !hasStructured) return false;
  const text = normalizeCheckText(output);
  const expected = normalizeCheckText(expectedText);

  if (expected && expected.length > 0) {
    const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The edge is only held to a word boundary where the expected text itself starts or ends with a word character.
    const word = /[A-Za-z0-9_]/;
    const left = word.test(expected[0] ?? "") ? "(?:^|[^A-Za-z0-9_-])" : "";
    const right = word.test(expected.at(-1) ?? "") ? "(?:$|[^A-Za-z0-9_-])" : "";
    // eslint-disable-next-line security/detect-non-literal-regexp -- every special character of `expected` is escaped above
    if (!new RegExp(`${left}${escaped}${right}`, "m").test(text)) {
      return false;
    }
  }

  if (structuredCheck) {
    if (
      structuredCheck.equals !== undefined &&
      text.trim() !== normalizeCheckText(structuredCheck.equals).trim()
    ) {
      return false;
    }
    let regexMatch: RegExpExecArray | null = null;
    if (structuredCheck.regex !== undefined) {
      try {
        // eslint-disable-next-line security/detect-non-literal-regexp -- validated via validateStructuredCheck
        const re = new RegExp(structuredCheck.regex, "m");
        regexMatch = re.exec(output);
        if (!regexMatch) return false;
      } catch {
        return false;
      }
    }
    if (structuredCheck.maxNumber !== undefined) {
      const isPlainNumber = (raw: string): boolean => {
        const t = raw.trim();
        if (!t || /\s/.test(t)) return false;
        return Number.isFinite(Number(t));
      };
      if (regexMatch && regexMatch[1] !== undefined) {
        const n = Number(regexMatch[1].trim());
        if (!isPlainNumber(regexMatch[1]) || n > structuredCheck.maxNumber) return false;
      } else if (regexMatch && isPlainNumber(regexMatch[0])) {
        const n = Number(regexMatch[0].trim());
        if (n > structuredCheck.maxNumber) return false;
      } else {
        const tokens = output
          .replaceAll(/[^0-9eE.+-\s]/g, " ")
          .split(/\s+/)
          .filter(isPlainNumber);
        if (tokens.length === 0) return false;
        for (const token of tokens) {
          const n = Number(token);
          if (!Number.isFinite(n) || n > structuredCheck.maxNumber) return false;
        }
      }
    }
  }

  return true;
}

/** How a look at a change's check after a rollback matched the look before the change. */
export type BaselineComparison = NonNullable<NonNullable<AgentChange["rollback"]>["comparison"]>;

/**
 * A check's output with what is plainly different at every look taken out: dates and times, how long
 * ago something was, process ids, and the counters uptime and systemd print. Two looks at the same
 * state then read the same, where before a clock in the output made every rollback "not as before".
 * Kept short on purpose: a number that may be a setting (`timeout 30s`, a port, a count of workers)
 * is left as it is, and so is anything this does not know.
 */
export function stableObservation(output: string): string {
  return (
    output
      .replace(/\r\n?/g, "\n")
      // uptime's line: the clock, how long the machine has been up, the users and the load.
      .replace(/\bup\s+[^\n]{0,80}?load average:[^\n]*/g, "up <uptime>")
      .replace(/\bload average:[ \d.,]+/g, "load average: <load>")
      // A date with a time of day, a date alone, a time of day alone, and Unix time.
      // eslint-disable-next-line security/detect-unsafe-regex -- every optional part is a fixed, bounded shape after a date; it cannot backtrack
      .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d{1,9})?)?(?: ?(?:Z|UTC|GMT|[+-]\d{2}:?\d{2}|[A-Z]{3,4})\b)?/g, "<time>")
      // eslint-disable-next-line security/detect-unsafe-regex -- anchored on a month name, each optional part bounded; it cannot backtrack
      .replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]{0,6} {1,2}\d{1,2}(?:,? \d{4})?(?: \d{1,2}:\d{2}(?::\d{2})?)?(?: (?:UTC|GMT|[A-Z]{3,4})\b)?(?: \d{4}\b)?/g, "<time>")
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<time>")
      // eslint-disable-next-line security/detect-unsafe-regex -- a fixed shape of digits and colons; it cannot backtrack
      .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?: ?[AP]M\b)?/g, "<time>")
      .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]{0,6},? <time>/g, "<time>")
      .replace(/\b1[5-9]\d{8}\b|\b1[5-9]\d{11}\b/g, "<time>")
      // How long ago: "3s ago", "2min 5s ago", "1 day ago". And docker's "Up 3 minutes".
      // eslint-disable-next-line security/detect-unsafe-regex -- each round begins with a digit and ends with a unit; it cannot backtrack
      .replace(/\b(?:\d+(?:\.\d+)? ?(?:us|ms|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|months?|y|years?)[, ]{0,2}){1,4}ago\b/g, "<ago>")
      .replace(/\bUp (?:About )?(?:an?|\d+) (?:seconds?|minutes?|hours?|days?|weeks?|months?)\b/g, "Up <ago>")
      // Process ids: "PID 1234", "pid=1234", "Main PID: 1234", "nginx[1234]:", systemd's "Process: 1234" and its tree.
      .replace(/\b(pid)(\W{0,3})\d+/gi, "$1$2<pid>")
      .replace(/\b([\w.@-]+)\[\d+\](?=:)/g, "$1[<pid>]")
      .replace(/^(\s*Process:\s*)\d+/gm, "$1<pid>")
      .replace(/([├└│]─)\d+(?=\s)/g, "$1<pid>")
      // What systemd prints about a unit at this moment.
      .replace(/^(\s*(?:Tasks|Memory|CPU|IO|IP):)[^\n]*/gm, "$1 <counter>")
      .replace(/[ \t]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .trim()
  );
}

/** sha256 of a look at a check with the volatile parts left out: kept with the change, so a rollback made later can be compared the same way. */
export const stableObservationHash = (id: string, observation: { exitCode: number; output: string }): string =>
  exactHash(JSON.stringify([id, observation.exitCode, stableObservation(observation.output)]));

/**
 * Whether a look at the check after a rollback reads as the look before the change did, and by
 * which comparison. Tried in this order:
 *
 * - `exact`: the same exit code and the same output.
 * - `stable`: the same exit code, and the same output once what differs at every look is left out
 *   (see `stableObservation`).
 * - `expected`: the card's own word for "it works". The check passed before the change and passes
 *   again. Only that way round: a check that failed before and fails again proves nothing by
 *   itself, because there are many ways to fail.
 *
 * `baseline` is the earlier look when it is still at hand; a rollback made later has its hashes.
 */
export function comparedWithBaseline(args: {
  id: string;
  now: { exitCode: number; output: string };
  baseline?: { exitCode: number; output: string };
  exactHash?: string;
  stableHash?: string;
  /** Whether the check passed before the change. */
  before?: boolean;
  passes: (look: { exitCode: number; output: string }) => boolean;
}): BaselineComparison | undefined {
  const { id, now, baseline } = args;
  if (baseline ? now.exitCode === baseline.exitCode && now.output === baseline.output : args.exactHash !== undefined && observationHash(id, now) === args.exactHash)
    return "exact";
  if (
    baseline
      ? now.exitCode === baseline.exitCode && stableObservation(now.output) === stableObservation(baseline.output)
      : args.stableHash !== undefined && stableObservationHash(id, now) === args.stableHash
  )
    return "stable";
  if (args.before === true && args.passes(now)) return "expected";
  return undefined;
}

/** The comparison, said to the agent and kept in the audit log. */
export const COMPARISON_TEXT: Record<BaselineComparison, string> = {
  exact: "The check reads exactly as it did before the change.",
  stable: "The check reads as it did before the change once times, process ids and counters are left out.",
  expected: "The check passed before the change and passes again. Its output is not the same as before.",
};
const NOT_AS_BEFORE =
  "The check does not read as it did before the change: its output differs also with times, process ids and counters left out, and it did not pass both before the change and now.";

/** A wait in whole minutes, as said to the agent. */
const minutes = (ms: number): string => {
  const n = Math.max(1, Math.round(ms / 60_000));
  return `${n} ${n === 1 ? "minute" : "minutes"}`;
};

export interface ToolRequest {
  action: string;
  command?: string;
  query?: string;
  id?: string;
  path?: string;
  content?: string;
  expected?: string;
  expectedHash?: string;
  edits?: Array<{ oldText: string; newText: string }>;
  structuredCheck?: AgentChangeStructuredCheck;
  /** With `change`: the command that shows the change worked, and what its output must contain. */
  check?: {
    command?: string;
    expected?: string;
    structuredCheck?: AgentChangeStructuredCheck;
  };
  /** With `change`: the command that takes it back. */
  rollback?: string;
  /** With `change`: how long the check has to keep passing. */
  observeSeconds?: number;
  description?: string;
  title?: string;
  text?: string;
  kind?: "memory" | "skill";
  scope?: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  nonInteractive?: boolean;
  preflightCommand?: string;
}
/** Who an approval is from: the account id when there is one, the name otherwise. */
const approverKey = (a: { actor?: string; actorId?: string }): string =>
  (a.actorId?.trim() || a.actor?.trim() || "user").toLowerCase();

/** The next short name for a command in this conversation: c1, c2, … */
export const nextRef = (task: AgentTask): string =>
  `c${task.changes.reduce((max, c) => Math.max(max, Number(/^c(\d+)$/.exec(c.ref ?? "")?.[1] ?? 0)), 0) + 1}`;

export interface ToolDependencies {
  beforeAction?(task: AgentTask): void;
  context(task: AgentTask, query?: string, sessionId?: string): Promise<unknown>;
  memory(task: AgentTask, request: ToolRequest): Promise<unknown>;
  file(
    task: AgentTask,
    request: ToolRequest,
    authorize: (change: AgentChange) => Promise<void>,
    recheck?: (change: AgentChange) => void,
  ): Promise<unknown>;
  appAction?(
    task: AgentTask,
    request: ToolRequest,
    authorize: (change: AgentChange) => Promise<void>,
  ): Promise<unknown>;
  openLocalTerminal?(): Promise<string>;
  activity?(task: AgentTask, change: AgentChange, sessionId?: string): void;
  safetyContext?(
    task: AgentTask,
    targetLabel?: string,
  ): {
    policy?: SafetyPolicyConfig;
    targetTags?: string[];
    clusterPolicy?: ClusterSafetyPolicy;
    /** The person this run acts for: their own approval counts once, never twice. */
    requesterId?: string;
    /**
     * Whether a second person can be asked at all. False where only one identity exists (the
     * desktop app, a server with one account): a change that needs two people is refused at once
     * instead of waiting for an approval nobody can give.
     */
    peerApproval?: boolean;
    canApproveAlone?: boolean;
  };
  peerStillEligible?(actorId: string, tags: string[]): boolean;
  recordIntent?(task: AgentTask, change: AgentChange, rollback: boolean): Promise<void>;
  /** A plain command has been running for a moment and has not ended: written down, without waiting for the write. */
  recordStarted?(task: AgentTask, change: AgentChange): void;
  /** How long a person is given to approve, in milliseconds. Ten minutes unless set. */
  approvalWaitMs?(): number;
  /** Non-interactive fail-fast mode predicate for headless / scripted runs. */
  nonInteractive?(task: AgentTask): boolean;
  /** Declarative lifecycle hooks (`pre_change`, `post_change`). */
  hooks?: LifecycleHook[];
  /** A run has started to wait for a person's answer about this change. */
  asking?(task: AgentTask, change: AgentChange): void;
  /** The run asked for another action after it was told its budget is spent: end it. */
  budgetSpent?(task: AgentTask): void;
  /** Told that a command is not run a fourth time for the same answer, the agent kept asking: the run ends here. */
  stuck?(task: AgentTask, why: string): void;
  /**
   * A person answered a change, or the wait for one ended. `final` is false for an approval that
   * still needs another person's.
   */
  answered?(task: AgentTask, changeId: string, answer: { allowed: boolean; how: NonNullable<AgentChange["decidedHow"]>; final: boolean }): void;
  /** The fence of a run asked for from chat: only its servers, only its own terminals. Undefined for any other run. */
  chatFence?(task: AgentTask): ChatFenceCheck | undefined;
  /** Opens a terminal for a chat run on the server it named, when that server is inside its fence; refuses otherwise. */
  chatTerminal?(task: AgentTask, name: string): Promise<string>;
  changed(): void;
}

/** Said to an agent asked for from chat that reached for something outside what the channel was given. */
const outsideFence = (what: string): ToolBrokerError =>
  new ToolBrokerError("auth_denied", `${what} Nothing ran. Work with the servers and tools this chat was given, or say what a person should do in the app.`, {
    code: "outside_chat_fence",
  });

/**
 * Said to a chat run whose file tool reached for a file that may hold secrets. Only the file tools
 * hold to this: what a command reads is not checked.
 */
export const sensitiveForChat = (fence: ChatFenceCheck): ToolBrokerError =>
  new ToolBrokerError(
    "auth_denied",
    "That file may hold secrets, and the file tools do not read such a file for a chat. It was not read. Say what you would look for, and that a person can read it in the app.",
    { code: fence.reach === "read" ? "chat_read_only" : "sensitive_file" },
  );

/** A random capability is issued to one run. Model-supplied IDs can never rebind its target. */
export class ToolBroker {
  private server?: http.Server;
  private listening?: Promise<void>;
  private grants = new Map<
    string,
    { task: AgentTask; commands: number; refused?: number; repeats?: number; expiresAt: number; busy: boolean }
  >();
  private approvals = new Map<
    string,
    {
      task: AgentTask;
      taskId: string;
      requesterId?: string;
      requiredApprovals: number;
      resolve: (answer: Answer) => void;
      timer?: NodeJS.Timeout;
    }
  >();
  private idempotencyLedgers = new Map<string, Map<string, IdempotencyEntry>>();
  private hooks: LifecycleHook[] = [];

  constructor(
    private readonly terminals: TerminalRegistry,
    private readonly deps: ToolDependencies,
  ) {}

  registerHook(hook: LifecycleHook): () => void {
    this.hooks = this.hooks.filter((h) => h.id !== hook.id);
    this.hooks.push(hook);
    return () => this.unregisterHook(hook.id);
  }

  unregisterHook(id: string): void {
    this.hooks = this.hooks.filter((h) => h.id !== id);
  }

  getIdempotencyEntry(
    taskId: string,
    idempotencyKey: string,
  ): IdempotencyEntry | undefined {
    return this.idempotencyLedgers.get(taskId)?.get(idempotencyKey);
  }

  getIdempotencyLedger(taskId: string): IdempotencyEntry[] {
    return [...(this.idempotencyLedgers.get(taskId)?.values() ?? [])];
  }

  /** When the ledgers were last gone through for entries that are too old to matter. */
  private ledgersPrunedAt = 0;

  /**
   * Drops idempotency entries older than `IDEMPOTENCY_KEEP_MS`, and ledgers that are empty then.
   * A key guards against the same call being made twice by a retry, which happens within minutes.
   * Kept for ever they only grew, until the app closed.
   */
  private pruneLedgers(now = Date.now()): void {
    if (now - this.ledgersPrunedAt < IDEMPOTENCY_PRUNE_EVERY_MS) return;
    this.ledgersPrunedAt = now;
    for (const [taskId, ledger] of this.idempotencyLedgers) {
      for (const [key, entry] of ledger) if (entry.status !== "in_progress" && now - entry.at > IDEMPOTENCY_KEEP_MS) ledger.delete(key);
      if (ledger.size === 0) this.idempotencyLedgers.delete(taskId);
    }
  }

  private getOrCreateLedger(taskId: string): Map<string, IdempotencyEntry> {
    this.pruneLedgers();
    let ledger = this.idempotencyLedgers.get(taskId);
    if (!ledger) {
      ledger = new Map();
      this.idempotencyLedgers.set(taskId, ledger);
    }
    return ledger;
  }

  private matchingHooks(
    stage: LifecycleHookStage,
    request: ToolRequest,
  ): LifecycleHook[] {
    return [...(this.deps.hooks ?? []), ...this.hooks].filter((h) => {
      if (h.stage !== stage) return false;
      if (h.when?.actions?.length && !h.when.actions.includes(request.action))
        return false;
      return true;
    });
  }

  private async executeHooks(
    stage: LifecycleHookStage,
    hooks: LifecycleHook[],
    ctx: Omit<LifecycleHookContext, "stage">,
  ): Promise<LifecycleHookResult | void> {
    for (const hook of hooks) {
      const outcome = await hook.run({ stage, ...ctx });
      if (stage === "pre_change" && outcome) {
        if (outcome.patchChange && ctx.change) {
          const patch = outcome.patchChange;
          if (patch.blastRadius !== undefined)
            ctx.change.blastRadius = patch.blastRadius;
          if (patch.dryRunOutput !== undefined)
            ctx.change.dryRunOutput = patch.dryRunOutput;
          if (patch.preflightSnapshot !== undefined)
            ctx.change.preflightSnapshot = patch.preflightSnapshot;
          if (patch.requiredApprovals !== undefined)
            ctx.change.requiredApprovals = patch.requiredApprovals;
        }
        if (outcome.allow === false) {
          return outcome;
        }
      }
    }
    return undefined;
  }

  private validateRequest(request: ToolRequest, task: AgentTask): void {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new ToolBrokerError("schema_validation", "Invalid tool request", {
        code: "invalid_request",
      });
    }
    if (typeof request.action !== "string" || !request.action.trim()) {
      throw new ToolBrokerError(
        "schema_validation",
        "Tool request requires a non-empty action",
        { code: "missing_action" },
      );
    }
    if (request.idempotencyKey !== undefined) {
      if (
        typeof request.idempotencyKey !== "string" ||
        !request.idempotencyKey.trim() ||
        request.idempotencyKey.length > 256
      ) {
        throw new ToolBrokerError(
          "schema_validation",
          "idempotencyKey must be a non-empty string up to 256 characters",
          { code: "invalid_idempotency_key" },
        );
      }
    }
    if (request.structuredCheck !== undefined) {
      validateStructuredCheck(request.structuredCheck, "structuredCheck");
    }
    if (request.check?.structuredCheck !== undefined) {
      validateStructuredCheck(request.check.structuredCheck, "check.structuredCheck");
    }

    if (
      request.action === "file-read" ||
      request.action === "file-write" ||
      request.action === "file-patch" ||
      request.action === "file_patch"
    ) {
      if (
        (request.action === "file-write" ||
          request.action === "file-patch" ||
          request.action === "file_patch") &&
        task.investigator
      ) {
        throw new ToolBrokerError(
          "auth_denied",
          "An investigator does not change files.",
          { code: "investigator_read_only" },
        );
      }
      if (typeof request.path !== "string" || !request.path.trim()) {
        throw new ToolBrokerError(
          "schema_validation",
          "File action requires a non-empty path",
          { code: "missing_path" },
        );
      }
      if (request.action === "file-write") {
        if (typeof request.content !== "string") {
          throw new ToolBrokerError(
            "schema_validation",
            "file-write requires string content",
            { code: "missing_content" },
          );
        }
      }
      if (request.action === "file-patch" || request.action === "file_patch") {
        const expected = request.expectedHash ?? request.expected;
        if (typeof expected !== "string" || !expected.trim()) {
          throw new ToolBrokerError(
            "schema_validation",
            "Read this file first and provide its expectedHash",
            { code: "missing_expected_hash" },
          );
        }
        if (!Array.isArray(request.edits) || request.edits.length === 0) {
          throw new ToolBrokerError(
            "schema_validation",
            "file_patch requires a non-empty edits array",
            { code: "invalid_edits" },
          );
        }
        for (let i = 0; i < request.edits.length; i++) {
          const edit = request.edits[i];
          if (
            !edit ||
            typeof edit.oldText !== "string" ||
            edit.oldText.length === 0 ||
            typeof edit.newText !== "string"
          ) {
            throw new ToolBrokerError(
              "schema_validation",
              `Invalid patch edit at index ${i}: oldText must be a non-empty string and newText must be a string`,
              { code: "invalid_edits" },
            );
          }
        }
      }
      return;
    }

    if (
      request.action === "context" ||
      request.action === "memory" ||
      request.action === "skills" ||
      request.action === "memory-save" ||
      request.action.startsWith("sshs3_") ||
      request.action.startsWith("mcp__")
    ) {
      return;
    }

    if (
      !["command", "verify", "change"].includes(request.action) ||
      typeof request.command !== "string" ||
      !request.command.trim() ||
      request.command.length > 16_000
    ) {
      throw new ToolBrokerError(
        "schema_validation",
        "Unsupported or invalid tool call",
        { code: "invalid_tool_call" },
      );
    }

    // There is no dry run. A caller that still asks for one is told so and nothing runs: running the
    // real command in its place would be the opposite of what it asked for.
    if ((request as { dryRun?: unknown }).dryRun === true)
      throw new ToolBrokerError(
        "schema_validation",
        "There is no dry run option. Nothing ran. Write the dry run command yourself, for example with --dry-run=server, terraform plan or rsync -n.",
        { code: "dry_run_removed" },
      );

    if (request.action === "verify") {
      const hasExpected =
        typeof request.expected === "string" && request.expected.trim().length > 0;
      const hasStructured = Boolean(request.structuredCheck);
      if (!hasExpected && !hasStructured) {
        throw new ToolBrokerError(
          "schema_validation",
          "Verification needs an explicit expected observation",
          { code: "missing_expected" },
        );
      }
    }

    if (request.action === "change") {
      const checkCommand = request.check?.command?.trim() ?? "";
      const expected = request.check?.expected?.trim() ?? "";
      const hasStructured = Boolean(
        request.check?.structuredCheck ?? request.structuredCheck,
      );
      const rollback = request.rollback?.trim() ?? "";
      if (!checkCommand || (!expected && !hasStructured)) {
        throw new ToolBrokerError(
          "schema_validation",
          "A change needs a check: a command that only looks and exits 0, and what its output must contain, when the change worked.",
          { code: "missing_check" },
        );
      }
      if (!rollback) {
        throw new ToolBrokerError(
          "schema_validation",
          "A change needs a rollback: the command that takes it back.",
          { code: "missing_rollback" },
        );
      }
    }
  }

  async issue(task: AgentTask): Promise<{ url: string; key: string }> {
    if (!this.server) {
      this.server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      this.listening = new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(0, "127.0.0.1", resolve);
      });
      this.server.requestTimeout = 15_000;
      this.server.headersTimeout = 10_000;
    }
    await this.listening;
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Tool service unavailable");
    const key = crypto.randomBytes(32).toString("hex");
    this.grants.set(key, {
      task,
      commands: 0,
      // A run the hub starts has no time limit (maxMinutes 0), its own background calls included.
      // Only a task that still carries one (the native Hermes bridge makes such tasks) expires.
      expiresAt: task.maxMinutes > 0 ? Date.now() + task.maxMinutes * 60_000 : Number.POSITIVE_INFINITY,
      busy: false,
    });
    return { url: `http://127.0.0.1:${address.port}/tool`, key };
  }

  /**
   * Counts one action against the run's budget. Past it, the action is refused
   * and the agent told to report; asking again after that ends the run.
   */
  private spend(
    grant: { commands: number; refused?: number },
    task: AgentTask,
  ): void {
    this.deps.beforeAction?.(task);
    // Actions are counted, for the person to see; there is no limit on how many a run may take
    // (maxCommands 0). A limit is held only where one is set.
    if (!(task.maxCommands > 0) || grant.commands < task.maxCommands) {
      task.commandsUsed = ++grant.commands;
      return;
    }
    task.commandsUsed = task.maxCommands;
    task.budgetStop ??= { kind: "commands", limit: task.maxCommands, at: Date.now() };
    grant.refused = (grant.refused ?? 0) + 1;
    this.deps.changed();
    if (grant.refused > 1) this.deps.budgetSpent?.(task);
    throw new ToolBrokerError(
      "auth_denied",
      `Command budget exhausted: this run may take ${task.maxCommands} actions and has taken them all. Do not call more tools: report what you found and what is left to do.`,
      { code: "budget_exhausted" },
    );
  }

  approve(
    taskId: string,
    changeId: string,
    allowed: boolean,
    note?: string,
    approver?: { actor?: string; actorId?: string; peer?: boolean; adminException?: boolean; via?: ChatServiceName },
  ): boolean {
    const approval = this.approvals.get(changeId);
    if (!approval || approval.taskId !== taskId)
      throw new ToolBrokerError(
        "precondition",
        "Approval expired or belongs to another task",
        { code: "approval_not_found" },
      );

    const approverId = approver?.actorId?.trim() || undefined;
    const change = approval.task.changes.find((c) => c.id === changeId);
    if (change) {
      change.approvals ??= [];
      const actor = approver?.actor ?? change.decidedBy?.name ?? "User";
      const asPeer = { ...(approver?.peer ? { peer: true as const } : {}), ...(approver?.via ? { via: approver.via } : {}) };
      if (!allowed) {
        change.approvals.push({
          actor,
          ...(approverId ? { actorId: approverId } : {}),
          at: Date.now(),
          allowed: false,
          ...asPeer,
          ...(note ? { note } : {}),
        });
      } else {
        // One person counts once, whether or not the caller gave an id: the name stands in for it.
        const key = approverKey({ actor, actorId: approverId });
        if (change.approvals.some((a) => a.allowed && approverKey(a) === key)) {
          throw new ToolBrokerError(
            "auth_denied",
            "You have already approved this change; it needs the approval of another person",
            { code: "duplicate_approver" },
          );
        }
        if (change.adminExceptionAvailable && approval.requiredApprovals === 2) {
          const ctx = this.safetyFor(approval.task, change);
          if (!approver?.adminException || !ctx?.canApproveAlone || ctx.peerApproval !== false || !approverId || approverId !== ctx.requesterId || !note?.trim())
            throw new ToolBrokerError("auth_denied", "Approve this one change in the inbox with an administrator reason.", { code: "admin_reason_required" });
          change.adminException = { actorId: approverId, reason: note.trim(), at: Date.now() };
        }
        change.approvals.push({
          actor,
          ...(approverId ? { actorId: approverId } : {}),
          at: Date.now(),
          allowed: true,
          ...asPeer,
          ...(note ? { note } : {}),
        });
        const approvers = new Set(
          change.approvals.filter((a) => a.allowed).map(approverKey),
        );
        // Two or more approvals: at least one from someone other than the person the run acts for.
        const requester = approval.requesterId?.trim().toLowerCase();
        const peer =
          approval.requiredApprovals < 2 ||
          !requester ||
          [...approvers].some((k) => k !== requester);
        if (!change.adminException && (approvers.size < approval.requiredApprovals || !peer)) {
          this.deps.changed();
          this.deps.answered?.(approval.task, changeId, { allowed: true, how: "person", final: false });
          return false;
        }
      }
      if (approver?.actor) {
        change.decidedBy = { name: approver.actor, at: Date.now(), allowed };
      }
    }

    clearTimeout(approval.timer);
    this.approvals.delete(changeId);
    approval.resolve({ allowed, how: "person", ...(note ? { note } : {}) });
    return true;
  }

  /** Whether a person is asked about this change right now. */
  waitingFor(changeId: string): boolean {
    return this.approvals.has(changeId);
  }

  /** Whether a run has a question out to a person. */
  waitingOnPerson(taskId: string): boolean {
    return [...this.approvals.values()].some((a) => a.taskId === taskId);
  }

  /**
   * Asks the user about an action that does not go through this broker's own
   * tools (an external agent's request). The action is listed on the task as
   * pending; the answer comes through approve() like any other.
   */
  async askApproval(
    task: AgentTask,
    change: AgentChange,
    requesterId?: string,
  ): Promise<boolean> {
    task.changes.push(change);
    task.status = "waiting";
    this.deps.changed();
    // The question is out before anybody is told of it: whoever is told can answer it at once.
    const waiting = this.waitForPerson(
      task,
      change.id,
      Math.max(1, change.requiredApprovals ?? 1),
      requesterId,
    );
    this.deps.asking?.(task, change);
    const answer = await waiting;
    // Stopped while it waited: no answer lets it through. Otherwise the run waits on while
    // another of its questions is still open (an external agent may ask several at once).
    const still = task.status === "waiting" || task.status === "running";
    change.status = answer.allowed && still ? "approved" : "denied";
    change.decidedHow = still ? answer.how : "stopped";
    if (still) task.status = this.waitingOnPerson(task.id) ? "waiting" : "running";
    this.deps.changed();
    this.deps.answered?.(task, change.id, { allowed: answer.allowed, how: answer.how, final: true });
    return answer.allowed && still;
  }

  /**
   * Waits for a person's answer. The time spent waiting is given back to the
   * run: a capability that expires is moved by as long as the run stood still,
   * so an answer that takes twenty minutes does not find a fifteen-minute
   * capability already expired.
   */
  private async waitForPerson(
    task: AgentTask,
    changeId: string,
    requiredApprovals = 1,
    requesterId?: string,
  ): Promise<Answer> {
    const started = Date.now();
    const answer = await new Promise<Answer>((resolve) => {
      // No limit on the wait unless one is set (0 or none: for as long as it takes).
      const waitMs = this.deps.approvalWaitMs?.() ?? 0;
      const timer =
        waitMs > 0
          ? setTimeout(() => {
              this.approvals.delete(changeId);
              resolve({ allowed: false, how: "timeout" });
            }, waitMs)
          : undefined;
      this.approvals.set(changeId, {
        task,
        taskId: task.id,
        requesterId,
        requiredApprovals,
        resolve,
        timer,
      });
    });
    // The run stood still this long waiting for a person: that time is not the run's own.
    const waited = Date.now() - started;
    for (const grant of this.grants.values()) if (grant.task.id === task.id) grant.expiresAt += waited;
    return answer;
  }

  revoke(taskId: string): void {
    for (const [key, grant] of this.grants)
      if (grant.task.id === taskId) this.grants.delete(key);
    for (const [id, approval] of this.approvals) {
      if (approval.taskId !== taskId) continue;
      clearTimeout(approval.timer);
      this.approvals.delete(id);
      approval.resolve({ allowed: false, how: "stopped" });
    }
  }

  async invoke(key: string, request: ToolRequest): Promise<unknown> {
    const grant = this.grants.get(key);
    if (
      !grant ||
      Date.now() >= grant.expiresAt ||
      !["running", "waiting"].includes(grant.task.status)
    )
      throw new ToolBrokerError("auth_denied", "Run capability expired", {
        code: "capability_expired",
      });
    if (grant.busy)
      throw new ToolBrokerError("precondition", "A tool call is already active", {
        code: "grant_busy",
      });
    grant.busy = true;
    this.inFlight.set(grant.task.id, (this.inFlight.get(grant.task.id) ?? 0) + 1);
    try {
      const task = grant.task;
      this.validateRequest(request, task);

      let ledger: Map<string, IdempotencyEntry> | undefined;
      let ledgerEntry: IdempotencyEntry | undefined;
      const idempotencyKey = request.idempotencyKey?.trim();
      if (idempotencyKey) {
        const argsHash = computeArgsHash(request);
        ledger = this.getOrCreateLedger(task.id);
        const existing = ledger.get(idempotencyKey);
        if (existing) {
          if (existing.argsHash !== argsHash) {
            throw new ToolBrokerError(
              "schema_validation",
              `Idempotency key "${idempotencyKey}" was already used with different arguments`,
              { code: "idempotency_conflict", details: { idempotencyKey } },
            );
          }
          if (existing.status === "in_progress") {
            throw new ToolBrokerError(
              "precondition",
              `Operation with idempotency key "${idempotencyKey}" is currently in progress`,
              { code: "idempotency_in_progress", details: { idempotencyKey } },
            );
          }
          if (existing.status === "uncertain") {
            throw new ToolBrokerError(
              "precondition",
              `Operation with idempotency key "${idempotencyKey}" ended in an uncertain state and cannot be replayed blindly`,
              { code: "idempotency_uncertain", details: { idempotencyKey } },
            );
          }
          if (existing.status === "completed") {
            return existing.result;
          }
          if (existing.result !== undefined) {
            return existing.result;
          }
          throw new ToolBrokerError(
            "execution",
            existing.error ?? "Operation previously failed",
            { code: "idempotency_previously_failed", details: { idempotencyKey } },
          );
        }
        ledgerEntry = {
          idempotencyKey,
          argsHash,
          status: "in_progress",
          at: Date.now(),
        };
        ledger.set(idempotencyKey, ledgerEntry);
      }

      const changesBefore = task.changes.length;
      const commandsBefore = grant.commands;
      let activeChange: AgentChange | undefined;

      // Set only for a run asked for from chat: everything below is held to it.
      const fence = this.deps.chatFence?.(task);
      const executeBody = async (): Promise<unknown> => {
        if (request.action === "context")
          return await this.deps.context(task, request.query, request.id);
        // What is said in a channel, or by somebody who is not linked, is not a person's own note: it would
        // be written into the memory every channel's runs read. A run that may only look writes nothing.
        if (request.action === "memory-save" && fence && !mayKeepNotes(fence.origin))
          throw outsideFence("A conversation asked for from chat saves to memory only in a direct message from a linked person.");
        if (
          request.action === "memory" ||
          request.action === "skills" ||
          request.action === "memory-save"
        )
          return await this.deps.memory(task, request);
        if (
          fence &&
          (request.action.startsWith("sshs3_") || request.action.startsWith("mcp__")) &&
          !CHAT_APP_TOOLS.has(request.action)
        )
          throw outsideFence(`${clip(request.action, 80)} is managed in the app, not from chat.`);
        if (
          (request.action.startsWith("sshs3_") ||
            request.action.startsWith("mcp__")) &&
          this.deps.appAction
        ) {
          const res = await this.deps.appAction(task, request, (change) => {
            activeChange = change;
            if (!change.guard) this.spend(grant, task);
            return this.authorize(key, task, change, request);
          });
          this.deps.changed();
          // What the person said with their yes is for the agent to act on: a call to a tool of
          // another system and a settings change carry it as a change card does.
          const note = (activeChange as AgentChange | undefined)?.decisionNote;
          if (note && res && typeof res === "object" && !Array.isArray(res))
            return { ...(res as Record<string, unknown>), personNote: `Approved with a note from the person: ${note}` };
          return res;
        }
        if (
          request.action === "file-read" ||
          request.action === "file-write" ||
          request.action === "file-patch" ||
          request.action === "file_patch"
        ) {
          const isMutatingFile =
            request.action === "file-write" ||
            request.action === "file-patch" ||
            request.action === "file_patch";
          if (isMutatingFile && task.investigator)
            throw new ToolBrokerError(
              "auth_denied",
              "An investigator does not change files.",
              { code: "investigator_read_only" },
            );
          if (fence && (!task.target || !fence.own(task.target.sessionId)))
            throw outsideFence("Files are read on a terminal this chat run opened on one of its servers, and it has none.");
          // The file tools do not hand a chat a file that may hold secrets. This is the file tools' own
          // rule, by path: what a command reads is not checked.
          if (fence && typeof request.path === "string" && sensitiveFile(request.path)) throw sensitiveForChat(fence);
          if (isMutatingFile) this.spend(grant, task);
          const fileRes = await this.deps.file(task, request, (change) => {
            activeChange = change;
            return this.authorize(key, task, change, request);
          }, (change) => this.checkCurrentPolicy(task, change));
          if (isMutatingFile) {
            const lastChange = task.changes.at(-1);
            if (lastChange) {
              activeChange = lastChange;
              this.deps.activity?.(task, lastChange, request.id ?? task.target?.sessionId);
            }
          }
          return fileRes;
        }

        // Resolve target terminal: explicit request.id (sessionId, profileId, or node label) or bound task.target
        let target = task.target;
        if (fence) {
          // A chat run uses only terminals it was given or opened, on its servers. A name of another
          // server inside the fence opens one there; anything else is refused. Never another open
          // terminal of the account, and never a local shell.
          if (target && !fence.own(target.sessionId)) target = undefined;
          if (request.id) {
            const id = request.id.trim();
            const direct = this.terminals.get(id);
            const named = direct
              ? [direct]
              : this.terminals.list().filter((s) => s.profileId === id || s.label.toLowerCase() === id.toLowerCase());
            const mine = named.filter((s) => s.state !== "disconnected" && fence.own(s.id));
            // Several of its own on that server: the one it works in, else the first. Never one more.
            let session: TerminalSession | undefined = mine.find((s) => s.id === task.target?.sessionId) ?? mine[0];
            if (!session) {
              if (!this.deps.chatTerminal) throw outsideFence(`"${clip(id, 80)}" is not a terminal of this chat run.`);
              session = this.terminals.get(await this.deps.chatTerminal(task, id));
            }
            if (!session || session.state === "disconnected" || !fence.own(session.id))
              throw outsideFence(`"${clip(id, 80)}" is not a terminal of this chat run.`);
            target = { sessionId: session.id, generation: session.generation, label: session.label };
            if (!task.target || !fence.own(task.target.sessionId)) task.target = target;
          }
          if (!target)
            throw new ToolBrokerError(
              "precondition",
              "This conversation has no terminal yet. Name the server to run it on in sessionId: one of the servers this chat was given.",
              { code: "no_terminal" },
            );
        } else if (request.id) {
          const id = request.id.trim();
          const direct = this.terminals.get(id);
          const exact = direct ? [direct] : this.terminals.list().filter((s) =>
            s.state !== "disconnected" && (s.profileId === id || s.label.toLowerCase() === id.toLowerCase()),
          );
          if (exact.length !== 1 || exact[0].state === "disconnected")
            throw new ToolBrokerError("precondition", "Choose one connected terminal by its exact ID. Nothing ran.", { code: "target_unavailable" });
          const session = exact[0];
          target = { sessionId: session.id, generation: session.generation, label: session.label };
          if (!task.target) task.target = target;
        }
        if (!target && !fence) {
          const fallbackSession = this.terminals
            .list()
            .find((s) => s.state !== "disconnected");
          if (fallbackSession) {
            target = {
              sessionId: fallbackSession.id,
              generation: fallbackSession.generation,
              label: fallbackSession.label,
            };
            task.target = target;
          } else if (this.deps.openLocalTerminal && task.mode !== "advice") {
            const newSessionId = await this.deps.openLocalTerminal();
            const created = this.terminals.get(newSessionId);
            if (created) {
              target = {
                sessionId: created.id,
                generation: created.generation,
                label: created.label,
              };
              task.target = target;
            }
          }
        }
        if (!target)
          throw new ToolBrokerError(
            "precondition",
            "No terminal was assigned to this task",
            { code: "no_terminal" },
          );
        this.spend(grant, task);

        // Auto-handshake on demand if the terminal has not been armed yet (and was not invalidated)
        if (task.mode !== "advice" || task.investigator || fence?.reach === "read") {
          const live = this.terminals.get(target.sessionId);
          if (
            live &&
            live.generation === target.generation &&
            (live.state !== "ready" || !live.shell)
          ) {
            const ready = await this.terminals.ensureReady(target.sessionId);
            target = {
              sessionId: ready.id,
              generation: ready.generation,
              label: ready.label,
            };
            task.target = target;
          }
          const afterPrepare = this.terminals.get(target.sessionId);
          if (
            afterPrepare &&
            afterPrepare.generation === target.generation &&
            afterPrepare.state === "ready" &&
            afterPrepare.owner !== task.id
          ) {
            this.terminals.claim(target.sessionId, target.generation, task.id);
          }
        }

        if (request.action === "change") {
          return await this.runChange(key, task, target, request, (c) => {
            activeChange = c;
          });
        }

        // The same command with the same answer, three times running and just now: a fourth run would say
        // the same. A model that has stopped thinking its way forward repeats itself until the money is gone
        // (the first real model did, fourteen times). Refused, and after two more tries the run is ended.
        if (repeatedWithSameAnswer(task, exactHash(request.command!.trim()))) {
          grant.repeats = (grant.repeats ?? 0) + 1;
          if (grant.repeats > 2) this.deps.stuck?.(task, "It kept asking for the same command, which printed the same thing each time. Stopped, so it does not go on spending.");
          throw new ToolBrokerError(
            "precondition",
            `You ran this exact command ${REPEAT_LIMIT} times in a row and it printed the same thing each time. It is not run again: the answer would be the same. Use what it showed, try something different, or end with a report of what you found and what stopped you.`,
            { code: "repeated_command" },
          );
        }
        grant.repeats = 0;
        const shown = forApproval(request.command!, 16_000, "command");
        const sc = request.structuredCheck ?? request.check?.structuredCheck;
        const change: AgentChange = {
          id: crypto.randomUUID(),
          kind: "command",
          target: target.label,
          targetKey: JSON.stringify([target.sessionId, target.generation]),
          description: clip(
            request.description || "Run terminal command",
            400,
          ),
          command: shown.text,
          ...(shown.hidden ? { hiddenValues: true } : {}),
          commandHash: exactHash(request.command!.trim()),
          ...(sc ? { structuredCheck: sc } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          status: "pending",
          ref: nextRef(task),
          at: Date.now(),
        };
        task.changes.push(change);
        activeChange = change;
        await this.authorize(key, task, change, request);
        change.status = "running";
        this.deps.changed();
        // Set once the command itself is on its way into the terminal. Until then a failure means it did not run.
        let typed = false;
        try {
          if (request.preflightCommand?.trim()) {
            const snap = await this.terminals.execute(
              target.sessionId,
              target.generation,
              task.id,
              request.preflightCommand.trim(),
            );
            // A second command typed for this call: counted like the first.
            task.commandsUsed = ++grant.commands;
            change.preflightSnapshot = boundedContext(snap.output, 4000);
          }
          this.checkCurrentPolicy(task, change);
          // The registry refuses at once, before it types anything, when the terminal is not this run's
          // to type into. What goes wrong after that comes back through the promise.
          const running = this.terminals.execute(
            target.sessionId,
            target.generation,
            task.id,
            request.command!,
          );
          typed = true;
          // A command is written to the audit log once, when it has ended. One that is still running
          // after a moment is written down as started as well, so that a command that never ends (it
          // hangs, the app closes) is in the log all the same.
          const startedNote = setTimeout(() => this.deps.recordStarted?.(task, change), this.startedNoteMs);
          let result: Awaited<typeof running>;
          try {
            result = await running;
          } finally {
            clearTimeout(startedNote);
          }
          change.status = result.exitCode === 0 ? "completed" : "failed";
          change.exitCode = result.exitCode;
          change.output = result.output;
          const checkPassed =
            request.action === "verify"
              ? result.exitCode === 0 &&
                showsExpected(result.output, request.expected ?? "", sc)
              : undefined;
          if (request.action === "verify")
            task.verification = checkPassed ? "verified" : "incomplete";
          else task.verification = "not-verified";
          const demoNote = scriptedDemoNote(request.command, this.terminals.get(target.sessionId)?.profileId, target.label);
          this.deps.activity?.(task, change, target.sessionId);
          this.deps.changed();
          // What the terminal printed before the command began is not its output: named as what it is.
          const { printedBefore, ...ran } = result;
          return {
            ...ran,
            ...(printedBefore ? { printedBeforeCommand: printedBefore } : {}),
            ...(checkPassed !== undefined ? { checkPassed } : {}),
            // Cite this in the report, in brackets, after what it shows.
            ref: change.ref,
            commandId: change.id,
            ...(change.preflightSnapshot
              ? { preflightSnapshot: change.preflightSnapshot }
              : {}),
            ...(change.decisionNote
              ? {
                  personNote: `Approved with a note from the person: ${change.decisionNote}`,
                }
              : {}),
            // A scripted example server of the demo lab, or an answer from the lab's script: invented, and the model is told so.
            ...(demoNote ? { note: demoNote } : {}),
            source: `terminal:${target.sessionId}`,
            sourceLabel: target.label,
            observedAt: Date.now(),
          };
        } catch (error) {
          if (typed) {
            change.status = "uncertain";
            change.output = safeError(error);
            task.verification = "incomplete";
          } else this.notRun(task, change, error);
          this.deps.changed();
          throw error;
        }
      };

      try {
        const result = await executeBody();
        const latestChange = activeChange ?? task.changes.slice(changesBefore).at(-1);
        if (latestChange) {
          const postHooks = this.matchingHooks("post_change", request);
          if (postHooks.length > 0) {
            await this.executeHooks("post_change", postHooks, {
              task,
              request,
              change: latestChange,
              result,
            });
          }
        }
        if (ledgerEntry) {
          const r = result as { exitCode?: unknown; checkPassed?: unknown; ok?: unknown } | undefined;
          const failedOutcome =
            (typeof r?.exitCode === "number" && r.exitCode !== 0) ||
            r?.checkPassed === false ||
            r?.ok === false;
          ledgerEntry.status = failedOutcome ? "failed" : "completed";
          ledgerEntry.result = result;
        }
        return result;
      } catch (error) {
        if (error instanceof ApprovalRequiredSignal) {
          const c = error.change;
          c.status = "pending";
          delete c.output;
          if (task.status === "waiting") task.status = "running";
          if (grant.commands > commandsBefore) {
            grant.commands = commandsBefore;
            task.commandsUsed = commandsBefore;
          }
          if (ledger && idempotencyKey) {
            ledger.delete(idempotencyKey);
          }
          this.deps.changed();
          return {
            ok: false,
            status: "approval_required",
            approvalRequired: true,
            changeId: c.id,
            ...(c.ref ? { ref: c.ref } : {}),
            kind: c.kind,
            description: c.description,
            ...(c.command ? { command: c.command } : {}),
            requiredApprovals: c.requiredApprovals ?? 1,
            approvalsCount: (c.approvals ?? []).filter((a) => a.allowed).length,
            ...(c.dryRunOutput ? { dryRunOutput: c.dryRunOutput } : {}),
            ...(c.blastRadius ? { blastRadius: c.blastRadius } : {}),
          };
        }

        const latestChange = activeChange ?? task.changes.slice(changesBefore).at(-1);
        if (latestChange) {
          const postHooks = this.matchingHooks("post_change", request);
          if (postHooks.length > 0) {
            try {
              await this.executeHooks("post_change", postHooks, {
                task,
                request,
                change: latestChange,
                error,
              });
            } catch {
              // Never mask the primary failure with a post_change hook error
            }
          }
        }

        if (ledgerEntry) {
          if (latestChange?.status === "uncertain") {
            ledgerEntry.status = "uncertain";
            ledgerEntry.error = safeError(error);
          } else if (latestChange?.status === "failed") {
            ledgerEntry.status = "failed";
            ledgerEntry.error = safeError(error);
          } else if (ledger && idempotencyKey) {
            // Failed before execution (e.g. denied, precondition, validation); do not lock key.
            ledger.delete(idempotencyKey);
          }
        }
        throw error;
      }
    } finally {
      grant.busy = false;
      const left = (this.inFlight.get(grant.task.id) ?? 1) - 1;
      if (left > 0) this.inFlight.set(grant.task.id, left);
      else this.inFlight.delete(grant.task.id);
    }
  }

  /** Tool calls of each run that have begun and not yet returned, also after the run's capability was taken away. */
  private readonly inFlight = new Map<string, number>();

  /**
   * Whether a tool call of this run is still on its way out. A run that was just stopped may have
   * one: it says how its command ended in a moment, and until then nobody else should say it for it.
   */
  working(taskId: string): boolean {
    return this.inFlight.has(taskId);
  }

  /** Between two looks at the check while a change is observed. Replaced in tests. */
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** How long a plain command may run before the audit log is told that it was started. Shortened in tests. */
  startedNoteMs = 5000;

  /**
   * A change that carries its own proof and its own way back. Nothing runs
   * before the change is approved: then the check is looked at (how things
   * stand right before), the change runs, and the check has to pass afterwards
   * and keep passing for the observation time. If it does not, the rollback
   * runs at once, once, and the agent is told what happened instead of being
   * left to notice.
   *
   * Nothing here looks at what the command, the check or the rollback do. The
   * card shows all three in full and the person approves what they read.
   *
   * What it can prove is said as it is: a check that already passed before
   * the change does not show the change did anything, and a rollback that
   * exits 0 has only "taken it back" when the check reads as it did before.
   */
  private async runChange(
    key: string,
    task: AgentTask,
    target: NonNullable<AgentTask["target"]>,
    request: ToolRequest,
    trackChange?: (change: AgentChange) => void,
  ): Promise<unknown> {
    const command = request.command!;
    const checkCommand = request.check?.command?.trim() ?? "";
    const expected = request.check?.expected?.trim() ?? "";
    const sc = request.check?.structuredCheck ?? request.structuredCheck;
    const rollback = request.rollback?.trim() ?? "";
    if (!checkCommand || (!expected && !sc))
      throw new ToolBrokerError(
        "schema_validation",
        "A change needs a check: a command that only looks and exits 0, and what its output must contain, when the change worked.",
        { code: "missing_check" },
      );
    if (!rollback)
      throw new ToolBrokerError(
        "schema_validation",
        "A change needs a rollback: the command that takes it back.",
        { code: "missing_rollback" },
      );
    // Shown in full or refused: the person approves the change, its check and its rollback as one.
    const shown = {
      command: forApproval(command, 16_000, "command"),
      check: forApproval(checkCommand, 2000, "check"),
      expected: forApproval(expected || JSON.stringify(sc), 400, "expected output"),
      rollback: forApproval(rollback, 4000, "rollback"),
    };
    // Every command a card types is counted against the run's budget: its check, each later look
    // at it, and its rollback, not only the change itself. The tool call paid for the first one.
    // A card is never stopped half-way for the budget: what is over is refused at the next call.
    const grant = this.grants.get(key);
    let typed = 0;
    const run = (c: string) => {
      const running = this.terminals.execute(target.sessionId, target.generation, task.id, c);
      if (++typed > 1 && grant) task.commandsUsed = ++grant.commands;
      return running;
    };
    // The rule the model is told in the tool's description: exit code 0 AND the expected text / structuredCheck.
    const passes = (r: { exitCode: number; output: string }): boolean =>
      r.exitCode === 0 && showsExpected(r.output, expected, sc);
    // Why a look at the check did not pass, in the words the agent and the person need to tell the two causes apart.
    const whyNot = (r: { exitCode: number; output: string } | undefined): string | undefined =>
      !r || passes(r)
        ? undefined
        : r.exitCode !== 0 && showsExpected(r.output, expected, sc)
          ? `The check's output contained the expected text, but the check exited with code ${r.exitCode}. A check passes only when it also exits 0.`
          : r.exitCode !== 0
            ? `The check exited with code ${r.exitCode} and its output did not contain the expected text.`
            : "The check exited 0, but its output did not contain the expected text.";

    const change: AgentChange = {
      id: crypto.randomUUID(),
      kind: "command",
      target: target.label,
      targetKey: JSON.stringify([target.sessionId, target.generation]),
      description: clip(request.description || "Make a change", 400),
      command: shown.command.text,
      commandHash: exactHash(command.trim()),
      ...(Object.values(shown).some((x) => x.hidden) ? { hiddenValues: true } : {}),
      ...(sc ? { structuredCheck: sc } : {}),
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      status: "pending",
      check: { command: shown.check.text, expected: shown.expected.text },
      rollback: { command: shown.rollback.text },
      ref: nextRef(task),
      at: Date.now(),
    };
    task.changes.push(change);
    trackChange?.(change);
    await this.authorize(key, task, change, request);
    change.status = "running";
    this.deps.changed();
    // What the person said with their yes is for the agent to act on. A change card is what a person
    // is asked about, so this is where a note arrives.
    const personNote = (): { personNote?: string } =>
      change.decisionNote ? { personNote: `Approved with a note from the person: ${change.decisionNote}` } : {};

    // Optional explicit preflight snapshot immediately prior to execution.
    if (request.preflightCommand?.trim()) {
      try {
        const snap = await run(request.preflightCommand.trim());
        change.preflightSnapshot = boundedContext(snap.output, 4000);
      } catch (error) {
        this.notRun(task, change, error);
        this.deps.changed();
        throw error;
      }
    }

    // Keep the observation in memory. Equality of two failed health checks alone proves nothing.
    let baseline: { output: string; exitCode: number };
    let before: boolean;
    try {
      const beforeRes = await run(checkCommand);
      baseline = beforeRes;
      before = passes(beforeRes);
      if (!change.preflightSnapshot && beforeRes.output) {
        change.preflightSnapshot = boundedContext(beforeRes.output, 4000);
      }
    } catch (error) {
      change.status = "failed";
      change.output = `The check could not be run before the change, so the change was not made: ${safeError(error)}`;
      change.check = { ...change.check!, skipped: "the change was not made" };
      change.rollback = { ...change.rollback!, skipped: "the change was not made" };
      task.verification = "incomplete";
      this.deps.changed();
      throw error;
    }
    change.check = { ...change.check!, before, baselineHash: observationHash(change.id, baseline), baselineStableHash: stableObservationHash(change.id, baseline) };
    this.deps.changed();

    let result: { exitCode: number; output: string; printedBefore?: string } | undefined;
    let last: { exitCode: number; output: string } | undefined;
    let failure: unknown;
    // The rules are looked at once more right before the change, and the registry refuses at once
    // when the terminal is no longer this run's. Stopped at either, the change was not made: that
    // is known, so it is not left as "uncertain".
    let running: Promise<{ exitCode: number; output: string }>;
    try {
      this.checkCurrentPolicy(task, change);
      running = run(command);
    } catch (error) {
      this.notRun(task, change, error);
      this.deps.changed();
      throw error;
    }
    try {
      result = await running;
      change.exitCode = result.exitCode;
      change.output = result.output;
      const observeMs = Math.max(0, Math.min(180, Math.round(request.observeSeconds ?? 0))) * 1000;
      let ok = false;
      if (result.exitCode === 0) {
        const until = Date.now() + observeMs;
        let looks = 0;
        for (;;) {
          last = await run(checkCommand);
          ok = passes(last);
          looks++;
          // A service that was just restarted is given a moment before the first look counts against it.
          if (!ok && looks === 1) {
            await this.wait(SETTLE_MS);
            last = await run(checkCommand);
            ok = passes(last);
          }
          const left = until - Date.now();
          if (!ok || left <= 0) break;
          await this.wait(Math.min(10_000, left));
        }
        const why = whyNot(last);
        change.check = { ...change.check!, after: ok, output: boundedContext(why ? `${last.output}\n[${why}]` : last.output, 2000) };
      } else {
        change.check = { ...change.check!, skipped: `the change command itself failed (exit ${result.exitCode})` };
      }
      if (ok) {
        change.status = "completed";
        // Passing afterwards proves the change only when it did not pass before.
        task.verification = before ? "not-verified" : "verified";
        // Told to the team (and to learning) only once its outcome is known.
        this.deps.activity?.(task, change, target.sessionId);
        this.deps.changed();
        return {
          id: change.id,
          ref: change.ref,
          exitCode: result.exitCode,
          output: result.output,
          ...(result.printedBefore ? { printedBeforeCommand: result.printedBefore } : {}),
          checkPassed: true,
          checkPassedBefore: before,
          observedSeconds: observeMs / 1000,
          ...personNote(),
          ...(change.preflightSnapshot ? { preflightSnapshot: change.preflightSnapshot } : {}),
          ...(before
            ? {
                note: "The check already passed before the change, so passing now does not show that the change did anything. Do not report it as proven: say what else shows it, or that it is not shown.",
              }
            : {}),
        };
      }
    } catch (error) {
      failure = error;
      change.output = [result?.output, safeError(error)].filter(Boolean).join("\n");
      task.verification = "incomplete";
      // Ownership and generation must still match before a rollback can be attempted.
    }

    // The change did not hold: take it back now, once.
    const liveTarget = this.terminals.get(target.sessionId);
    try {
      if (!liveTarget || liveTarget.generation !== target.generation || liveTarget.owner !== task.id || liveTarget.state !== "ready")
        throw new Error("The run no longer controls the original terminal.");
      await this.beforeAction(task, change, true);
    } catch (error) {
      change.status = "uncertain";
      change.rollback = { ...change.rollback!, skipped: safeError(error) };
      this.deps.changed();
      // The agent is told what went wrong first (a command that ran out of time says there whether it
      // may still be running), and then that nothing was taken back.
      if (failure) throw new Error(`${safeError(failure)} The rollback was not run: ${safeError(error)}`, { cause: error });
      throw error;
    }
    let undone: { exitCode: number; output: string };
    let rollbackTyped = false;
    try {
      const running = run(rollback);
      rollbackTyped = true;
      undone = await running;
    } catch (error) {
      if (!rollbackTyped) {
        // Refused before anything was typed: the rollback did not run, and is not recorded as run.
        change.status = "uncertain";
        change.rollback = { ...change.rollback!, skipped: safeError(error) };
        this.deps.changed();
        throw new Error(`${failure ? `${safeError(failure)} ` : ""}The rollback was not run: ${safeError(error)}`, { cause: error });
      }
      undone = { exitCode: -1, output: safeError(error) };
    }
    let checkAfter: boolean | undefined;
    let restored: boolean | undefined;
    let comparison: BaselineComparison | undefined;
    try {
      const observation = await run(checkCommand);
      checkAfter = passes(observation);
      // "Taken back" means the rollback exited 0 and the check reads as before. Not by its exact
      // bytes alone: a time, a process id or a counter in the output differs at every look.
      comparison = undone.exitCode === 0 ? comparedWithBaseline({ id: change.id, now: observation, baseline, before, passes }) : undefined;
      restored = comparison !== undefined;
    } catch {
      checkAfter = undefined;
    }
    change.rollback = {
      command: change.rollback!.command,
      ran: true,
      exitCode: undone.exitCode,
      output: boundedContext(undone.output, 2000),
      checkAfter,
      ...(restored !== undefined ? { restored, comparedWithBaseline: true } : {}),
      ...(comparison ? { comparison } : {}),
    };
    change.status = restored ? "failed" : "uncertain";
    task.verification = "incomplete";
    this.deps.activity?.(task, change, target.sessionId);
    this.deps.changed();
    return {
      id: change.id,
      ref: change.ref,
      exitCode: result?.exitCode ?? -1,
      output: result?.output ?? change.output ?? "",
      ...(result?.printedBefore ? { printedBeforeCommand: result.printedBefore } : {}),
      checkPassed: false,
      checkOutput: last?.output,
      ...(last ? { checkExitCode: last.exitCode } : {}),
      ...(whyNot(last) ? { checkFailedBecause: whyNot(last) } : {}),
      ...personNote(),
      rolledBack: restored === true,
      rollbackAttempted: true,
      rollbackExitCode: undone.exitCode,
      rollbackOutput: undone.output,
      checkPassesAfterRollback: checkAfter,
      backAsBefore: restored,
      // Which comparison says so, in words: the agent reports it as it is.
      ...(restored !== undefined ? { comparedBy: comparison ? COMPARISON_TEXT[comparison] : NOT_AS_BEFORE } : {}),
      next:
        undone.exitCode !== 0
          ? "The change did not pass its check, and the rollback failed too. Stop making changes. Report exactly this state to the person, with the outputs above."
          : restored !== true
            ? "The change did not pass its check. The rollback ran, but the check does not read as it did before the change. Stop making changes and report this state to the person."
            : "The change did not pass its check and was rolled back. Do not make the same change again: find out why the check failed first.",
    };
  }

  /**
   * A change that was stopped after it was allowed and before its command was typed: the rules
   * changed, a freeze began, the run ended, or the terminal was no longer the run's. Nothing ran,
   * and the change says so. "Uncertain" is for a command that was typed and whose end is not known.
   */
  private notRun(task: AgentTask, change: AgentChange, error: unknown): void {
    change.status = "denied";
    // Who decided last: the run's end, or the rules.
    change.decidedHow = ["running", "waiting"].includes(task.status) ? "policy" : "stopped";
    change.output = `Not run: ${safeError(error)}`;
    if (change.check) change.check = { ...change.check, skipped: "the change was not made" };
    if (change.rollback) change.rollback = { ...change.rollback, skipped: "the change was not made" };
  }

  private readonly policyAtDecision = new WeakMap<AgentChange, string>();
  private readonly capabilityAtDecision = new WeakMap<AgentChange, string>();

  private safetyFor(task: AgentTask, change: AgentChange) {
    if (!change.targetKey) return this.deps.safetyContext?.(task, change.target);
    const session = this.terminals.list().find((s) => JSON.stringify([s.id, s.generation]) === change.targetKey);
    if (!session || session.state === "disconnected") throw new Error("The original terminal is no longer connected.");
    return this.deps.safetyContext?.({ ...task, target: { sessionId: session.id, generation: session.generation, label: session.label } }, change.target);
  }

  rememberPolicy(task: AgentTask, change: AgentChange): void {
    const ctx = this.safetyFor(task, change);
    if (ctx) this.policyAtDecision.set(change, canonicalJson(ctx));
  }

  checkCurrentPolicy(task: AgentTask, change: AgentChange): void {
    if (!["running", "waiting"].includes(task.status)) throw new Error("This run has stopped.");
    const key = this.capabilityAtDecision.get(change);
    if (key) {
      const grant = this.grants.get(key);
      if (!grant || Date.now() >= grant.expiresAt) throw new Error("Run capability revoked");
    }
    if (change.kind === "setting") return;
    const ctx = this.safetyFor(task, change);
    if (!ctx) return;
    if (this.deps.peerStillEligible && change.approvals?.some((vote) =>
      vote.allowed && vote.peer && (!vote.actorId || !this.deps.peerStillEligible!(vote.actorId, ctx.targetTags ?? [])))) {
      throw new Error("A second approver no longer has permission for this target. Request approval again.");
    }
    const old = this.policyAtDecision.get(change);
    // A plain command only runs: a freeze and the demand for a check and a rollback are about changes.
    const mutates = !isPlainCommand(change);
    if (mutates && (ctx.clusterPolicy?.frozenUntil ?? 0) > Date.now()) throw new Error("A change freeze now holds on this target.");
    if (mutates && ctx.clusterPolicy?.requireCheckAndRollback && (!change.check || !change.rollback))
      throw new Error("This target requires a checked change with a rollback.");
    if (old && old !== canonicalJson(ctx)) throw new Error("The rules for this target changed. Request approval again.");
    if (ctx.clusterPolicy?.maxMode === "advice") throw new Error("This target only allows advice.");
  }

  async beforeAction(task: AgentTask, change: AgentChange, rollback = false): Promise<void> {
    try {
      this.checkCurrentPolicy(task, change);
      // What is about to change something is written down before it runs. A plain command is
      // written down once, when it has ended (see auditFinishedChanges).
      if (!isPlainCommand(change)) {
        await this.deps.recordIntent?.(task, change, rollback);
        this.checkCurrentPolicy(task, change);
      }
    } catch (error) {
      if (!rollback) {
        change.status = "denied";
        change.output = safeError(error);
        this.deps.changed();
      }
      throw error;
    }
  }

  /**
   * Why a change of a chat run falls outside its fence, or nothing when it is inside. A command or file
   * runs on a terminal the run owns; one sent to several servers names each, and each must be inside.
   * A change to sshs3's own rules is made in the app.
   */
  private outsideChatFence(task: AgentTask, change: AgentChange, fence: ChatFenceCheck): string | undefined {
    if (change.kind === "setting") return "sshs3's own rules are changed in the app, not from chat.";
    if (change.targetProfiles?.length)
      return change.targetProfiles.every((p) => fence.allows(p)) ? undefined : `${change.target} reaches a server this chat was not given.`;
    let sessionId: string | undefined;
    if (change.targetKey) {
      try {
        const parsed: unknown = JSON.parse(change.targetKey);
        if (Array.isArray(parsed) && typeof parsed[0] === "string") sessionId = parsed[0];
      } catch {
        sessionId = undefined;
      }
    } else sessionId = task.target?.sessionId;
    return sessionId && fence.own(sessionId) ? undefined : `${change.target} is not a terminal this chat run opened on its servers.`;
  }

  /**
   * Decides whether an action runs now, waits for a person, or is refused.
   *
   * A plain command (see isPlainCommand) runs at once: nothing looks at what it does and nobody is
   * asked, in every mode that runs commands. What waits is a change card, a file write, a call to a
   * tool of another system and a settings change, as the mode, the target's rules and a plan say.
   * This is a working agreement with the agent, not a lock: it can run as a command what it was
   * told to put on a card.
   */
  private async authorize(
    key: string,
    task: AgentTask,
    change: AgentChange,
    request: ToolRequest,
  ): Promise<void> {
    this.capabilityAtDecision.set(change, key);
    const plain = isPlainCommand(change);
    const fence = this.deps.chatFence?.(task);
    if (fence) {
      const outside = this.outsideChatFence(task, change, fence);
      if (outside) {
        change.status = "denied";
        change.decidedHow = "policy";
        change.output = outside;
        this.deps.changed();
        throw outsideFence(outside);
      }
    }
    // A chat channel that may only look is held to the investigator's rule: advice would refuse even a look.
    const looksOnly = task.investigator || fence?.reach === "read";
    if (looksOnly) {
      // An investigator runs commands and nobody is asked. It is given no change card, no file write
      // and no tool of another system. What its commands do is not checked.
      // A chat run is held to the target's own rules as any run is: a cluster that allows only advice
      // runs nothing from it, a look included.
      if (plain && fence) {
        try {
          this.checkCurrentPolicy(task, change);
        } catch (error) {
          change.status = "denied";
          change.decidedHow = "policy";
          change.output = safeError(error);
          this.deps.changed();
          throw error;
        }
      }
      change.status = plain ? "approved" : "denied";
      change.decidedHow = "policy";
      this.deps.changed();
      if (!plain)
        throw new ToolBrokerError(
          "auth_denied",
          task.investigator
            ? "An investigator only looks. It makes no change card, writes no file and calls no tool of another system. Nothing ran. Report what you found and what a change would need."
            : "This chat may run commands and proposes no change: no change card, no file write, no tool of another system. Nothing ran. Say what you would change, and that a person can do it in the app.",
          { code: task.investigator ? "investigator_read_only" : "chat_read_only" },
        );
      const grant = this.grants.get(key);
      if (!grant || Date.now() >= grant.expiresAt || task.status !== "running")
        throw new ToolBrokerError("auth_denied", "Run capability revoked", {
          code: "capability_revoked",
        });
      return;
    }
    // A conversation that only advises runs nothing and changes no file. A change to sshs3's
    // own rules is another matter: it is the person's to decide, and they are asked below.
    if (task.mode === "advice" && (!change.guard || change.kind !== "setting")) {
      change.status = "denied";
      change.decidedHow = "policy";
      this.deps.changed();
      throw new ToolBrokerError(
        "auth_denied",
        "Advice mode does not execute commands or change files",
        { code: "advice_mode_read_only" },
      );
    }

    const preHooks = this.matchingHooks("pre_change", request);
    if (preHooks.length > 0) {
      const preHookOutcome = await this.executeHooks("pre_change", preHooks, {
        task,
        request,
        change,
      });
      if (preHookOutcome && preHookOutcome.allow === false) {
        change.status = "denied";
        change.decidedHow = "policy";
        this.deps.changed();
        throw new ToolBrokerError(
          "precondition",
          preHookOutcome.reason || "Blocked by pre_change lifecycle hook",
          { code: "pre_change_hook_denied" },
        );
      }
    }

    // A plain command is never asked about. Anything else is, in Ask first and in Plan.
    let requiresApproval = !plain && (task.mode === "assisted" || task.mode === "plan");
    let isProd = false;
    let policy: SafetyPolicyConfig | undefined;
    let clusterPolicy: ClusterSafetyPolicy | undefined;
    let ctxRequesterId: string | undefined;
    let peerApproval: boolean | undefined;
    let adminMayApprove = false;

    if (
      (change.kind === "command" || change.kind === "file") &&
      this.deps.safetyContext
    ) {
      const ctx = this.safetyFor(task, change)!;
      policy = ctx.policy;
      clusterPolicy = ctx.clusterPolicy;
      ctxRequesterId = ctx.requesterId;
      peerApproval = ctx.peerApproval;
      adminMayApprove = ctx.canApproveAlone === true;
      this.rememberPolicy(task, change);
      isProd = (ctx.targetTags ?? []).some(isProdTag);

      // A change freeze stops change cards and file writes, in every mode: not asked about and not run.
      // Commands still run.
      if (
        !plain &&
        clusterPolicy?.frozenUntil &&
        clusterPolicy.frozenUntil > Date.now()
      ) {
        const until = new Date(clusterPolicy.frozenUntil).toISOString();
        change.status = "denied";
        change.decidedHow = "policy";
        change.output = `A change freeze holds here until ${until}. No change card or file write is run here until it ends.`;
        this.deps.changed();
        throw new ToolBrokerError(
          "auth_denied",
          `A change freeze holds on ${change.target} until ${until}: no change card and no file write is run there until then. Commands still run, to look and to check. Tell the user what you would have changed, and do not make the change another way.`,
          { code: "change_freeze" },
        );
      }

      const maxMode = lowerMode(task.mode, clusterPolicy?.maxMode);
      try {
        this.checkCurrentPolicy(task, change);
        if (!plain && maxMode === "plan" && task.mode !== "plan" && task.plan?.status !== "approved")
          throw new Error("This target requires an approved plan.");
      } catch (error) {
        change.status = "denied";
        change.decidedHow = "policy";
        change.output = safeError(error);
        this.deps.changed();
        throw error;
      }
      // Auto runs a change card unasked, except on production while the rule for it is on.
      requiresApproval =
        !plain &&
        (maxMode !== "autonomous" || (isProd && (ctx.policy?.requireApprovalOnProdTags ?? true)));
    }

    // The user approved a plan that lists exactly this command: a change card is not asked about a
    // second time.
    const matchesPlan = (consume = false) => planCoversCommand(task, change.commandHash, Date.now(), {
      targetKey: change.targetKey,
      check: request.check,
      rollback: request.rollback,
      observeSeconds: request.observeSeconds,
      extras: Boolean(request.preflightCommand || request.structuredCheck || request.check?.structuredCheck),
    }, consume);
    let listedInPlan = false;
    if (
      requiresApproval &&
      change.kind === "command" &&
      !change.hiddenValues &&
      matchesPlan()
    ) {
      requiresApproval = false;
      change.decidedHow = "plan";
      listedInPlan = true;
      // Another account's approval of the plan (a person in a chat thread) is that person's, and is
      // checked again just before the step runs, perhaps much later: they may no longer be allowed to.
      if (task.plan?.approvals?.some((vote) => vote.allowed && vote.peer))
        change.approvals = task.plan.approvals.filter((vote) => vote.allowed).map((vote) => ({ ...vote }));
    }
    // A change to the rules themselves is a person's to make: no mode, policy or plan lets it through unasked.
    if (change.guard || change.forceApproval) requiresApproval = true;
    // Asked for from outside sshs3: a person decides every one of these, a plain command too,
    // because nobody here is watching the asker.
    if (task.fromOutside) requiresApproval = true;

    // How many people a change needs. A plain command needs nobody, so neither rule counts for it.
    let requiredApprovals = Math.max(1, change.requiredApprovals ?? 1);
    if (
      !plain &&
      clusterPolicy?.requiredApprovals &&
      clusterPolicy.requiredApprovals > requiredApprovals
    ) {
      requiredApprovals = clusterPolicy.requiredApprovals;
    }
    if (!plain && policy?.requirePeerApprovalOnProd && isProd) {
      requiredApprovals = Math.max(requiredApprovals, 2);
    }
    // A plan that as many people approved covers the change cards it lists for all of them: each of them
    // read the command in the plan. Not one with hidden values, not a change to the rules and not one
    // asked for from outside: those are put to the people themselves.
    // Who approved the plan is looked at first: a step is marked as run only when the plan does cover it.
    const enoughPeople =
      requiredApprovals > 1 && change.kind === "command" && !change.hiddenValues && !change.guard && !task.fromOutside
        ? planApprovalsCover(task.plan, requiredApprovals, ctxRequesterId, isProd)
        : undefined;
    const planPeople =
      enoughPeople && (listedInPlan || (!requiresApproval && matchesPlan()))
        ? enoughPeople
        : undefined;
    if (planPeople) {
      change.requiredApprovals = requiredApprovals;
      change.approvals = planPeople.map((vote) => ({ ...vote }));
      change.decidedHow = "plan";
    } else if (requiredApprovals > 1) {
      change.requiredApprovals = requiredApprovals;
      requiresApproval = true;
      if (peerApproval === false && adminMayApprove && requiredApprovals === 2) {
        change.adminExceptionAvailable = true;
      } else if (peerApproval === false) {
        change.status = "denied";
        change.decidedHow = "policy";
        this.deps.changed();
        throw new ToolBrokerError(
          "auth_denied",
          `This change needs the approval of ${requiredApprovals} different people, and nobody else can be asked here: only one person signs in to this app. Report that the change needs a second person's approval.`,
          { code: "peer_approval_unavailable" },
        );
      }
    }

    // Told once the change says how it was answered (approved, refused, timed out), never before:
    // whoever is told reads the conversation at once.
    let answered: Answer | undefined;
    try {
      if (requiresApproval) {
        const nonInteractive =
          request.nonInteractive === true ||
          this.deps.nonInteractive?.(task) === true;
        if (nonInteractive) {
          this.deps.changed();
          this.deps.asking?.(task, change);
          throw new ApprovalRequiredSignal(change);
        }

        // Never the model's own word: a run cannot name somebody else as the person it acts for.
        const requesterId =
          ctxRequesterId ??
          task.startedAs?.agentId ??
          task.agentId;

        task.status = "waiting";
        this.deps.changed();
        // The question is out before anybody is told of it: whoever is told can answer it at once.
        const waiting = this.waitForPerson(
          task,
          change.id,
          requiredApprovals,
          requesterId,
        );
        this.deps.asking?.(task, change);
        const answer = await waiting;
        answered = answer;
        const allowed = answer.allowed;
        change.decidedHow = answer.how;
        if (answer.note) change.decisionNote = answer.note;
        const grant = this.grants.get(key);
        if (
          !allowed ||
          !grant ||
          Date.now() >= grant.expiresAt ||
          task.status !== "waiting"
        ) {
          change.status = "denied";
          if (grant && task.status === "waiting") task.status = "running";
          this.deps.changed();
          // A refusal with a reason is something to act on: the run goes on, and the agent reads why.
          throw new ToolBrokerError(
            "auth_denied",
            answer.note && answer.how === "person"
              ? `Not approved. The person said: ${answer.note}`
              : answer.how === "timeout"
                ? // Said as it is, with the command: "not approved" read as a person's no, and the report then left out what waited.
                  `Nobody answered within ${minutes(this.deps.approvalWaitMs?.() ?? 0)}, so this did not run: ${change.command ?? change.description}. It was not refused; nobody was there. Do not ask for it again in this run. Go on with what does not need it, and name this command in your report as waiting for a person's approval.`
                : "Action not approved or task stopped",
            { code: answer.how === "timeout" ? "approval_timeout" : "approval_denied" },
          );
        }
        task.status = "running";
      }
      const grant = this.grants.get(key);
      if (!grant || Date.now() >= grant.expiresAt || task.status !== "running") {
        // Never left pending or approved: the run that asked is gone.
        change.status = "denied";
        change.decidedHow = "stopped";
        this.deps.changed();
        throw new ToolBrokerError("auth_denied", "Run capability revoked", {
          code: "capability_revoked",
        });
      }
      await this.beforeAction(task, change);
      if (change.decidedHow === "plan" && !matchesPlan(true)) {
        change.status = "denied";
        throw new Error("The approved plan changed before execution.");
      }
      // A plain command that an approved plan lists: its step is marked as run. The plan decided nothing about it.
      if (plain) matchesPlan(true);
      change.status = "approved";
      change.decidedHow ??= "policy";
      this.deps.changed();
    } finally {
      if (answered) this.deps.answered?.(task, change.id, { allowed: answered.allowed, how: answered.how, final: true });
    }
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // No browser clients, redirects, CORS or cookies. Only the private Python adapter holds a capability.
    if (req.method !== "POST" || req.url !== "/tool" || req.headers.origin) {
      res.writeHead(403).end();
      return;
    }
    const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!this.grants.has(key)) {
      res.writeHead(401).end();
      return;
    }
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 128_000) {
          res.writeHead(413).end();
          return;
        }
      }
      const input: unknown = JSON.parse(body);
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new ToolBrokerError("schema_validation", "Invalid tool request", {
          code: "invalid_request",
        });
      const result = await this.invoke(key, input as ToolRequest);
      res
        .writeHead(200, { "Content-Type": "application/json" })
        // Masked here, for every runtime that reaches tools this way: a file, a page or an output may hold a secret.
        .end(JSON.stringify({ result: maskStrings(result) }));
    } catch (error) {
      const envelope =
        error instanceof ToolBrokerError
          ? maskStrings(error.envelope)
          : { category: "execution" as const, code: "execution", message: safeError(error) };
      res
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: safeError(error), errorEnvelope: envelope }));
    }
  }

  async dispose(): Promise<void> {
    for (const grant of [...this.grants.values()]) this.revoke(grant.task.id);
    this.idempotencyLedgers.clear();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }
}
