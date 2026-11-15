import { useEffect, useState } from "react";
import { AlertTriangle, Check, PauseCircle, ShieldAlert, ShieldCheck, X } from "lucide-react";
import type { AgentChange, AgentTask, HubRequest, HubSnapshot, ShellKind } from "@shared/types/aiHub";
import type { NativeToolState } from "@shared/types/nativeHermes";
import { hubRequest, useHub } from "../../lib/aiHub";
import { HighlightedCode } from "./DiffViewer";

export interface TerminalControlProps {
  sessionId: string | null;
  /** Optional snapshot override (primarily for tests); defaults to `useHub()`. */
  hub?: HubSnapshot;
  /** Optional request handler override; defaults to `hubRequest`. */
  onRequest?: (request: HubRequest) => Promise<HubSnapshot | undefined>;
  /** Optional callback invoked when the user clicks "Step-by-step". */
  onStepByStep?: (taskId: string) => void;
  /** Optional callback invoked when the user clicks "Always Allow Prefix". */
  onAllowPrefix?: (prefix: string, task: AgentTask, change: AgentChange) => void;
}

const MULTI_SUBCOMMAND_BINARIES = new Set([
  "systemctl",
  "journalctl",
  "kubectl",
  "docker",
  "podman",
  "git",
  "service",
  "helm",
  "aws",
  "az",
  "gcloud",
  "apt",
  "apt-get",
  "dnf",
  "yum",
  "ufw",
  "ip",
  "nginx",
  "pg_ctl",
  "redis-cli",
]);

const SHELL_CHAIN_PATTERN = /&&|\|\||[;|`]|\$\(/;
const SECRET_ARG_PATTERN = /(token|secret|password|passwd|apikey|api_key|key=|:=|:\/\/)/i;

/**
 * Derives a safe normalized command prefix (1-2 tokens, no flags or secrets) for
 * "Always Allow Prefix" inline approvals, or returns null if the command is compound/unsafe.
 */
function deriveSafeCommandPrefix(
  command?: string,
  parsedSubcommands?: string[],
): string | null {
  if (parsedSubcommands && parsedSubcommands.length === 1 && parsedSubcommands[0].trim()) {
    return SECRET_ARG_PATTERN.test(parsedSubcommands[0]) ? null : parsedSubcommands[0].trim();
  }
  if (!command) return null;
  const trimmed = command.trim();
  if (!trimmed || SHELL_CHAIN_PATTERN.test(trimmed) || SECRET_ARG_PATTERN.test(trimmed)) return null;
  if (parsedSubcommands && parsedSubcommands.length > 1) return null;

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  let idx = 0;
  while (idx < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]) || tokens[idx] === "sudo")) {
    idx++;
  }
  const binary = tokens[idx];
  if (!binary || binary.startsWith("-") || SECRET_ARG_PATTERN.test(binary)) return null;

  const next = tokens[idx + 1];
  if (
    MULTI_SUBCOMMAND_BINARIES.has(binary) &&
    next &&
    !next.startsWith("-") &&
    !next.startsWith("/") &&
    !SECRET_ARG_PATTERN.test(next) &&
    /^[A-Za-z0-9_.-]+$/.test(next)
  ) {
    return `${binary} ${next}`;
  }

  return binary;
}

function codeLangForShell(shell?: ShellKind): string {
  if (shell === "powershell" || shell === "pwsh") return "powershell";
  return "bash";
}

function riskBadgeClass(risk?: AgentChange["riskLevel"]): string {
  if (risk === "destructive") return "ai-badge ai-badge-danger";
  if (risk === "safe") return "ai-badge ai-badge-success";
  return "ai-badge ai-badge-mode";
}

interface ControlBarViewProps {
  sessionLabel?: string;
  shell?: ShellKind;
  task?: AgentTask;
  pending?: AgentChange;
  stepModeActive: boolean;
  busy: boolean;
  onReturnControl: () => void;
  onStepByStep: () => void;
  onApproveOnce: () => void;
  onAllowPrefix?: (prefix: string) => void;
  onDeny: () => void;
}

function TerminalControlBar({
  sessionLabel,
  shell,
  task,
  pending,
  stepModeActive,
  busy,
  onReturnControl,
  onStepByStep,
  onApproveOnce,
  onAllowPrefix,
  onDeny,
}: ControlBarViewProps): JSX.Element {
  const safePrefix =
    pending &&
    pending.kind === "command" &&
    pending.riskLevel !== "destructive" &&
    !pending.guard
      ? deriveSafeCommandPrefix(pending.command, pending.parsedSubcommands)
      : null;

  const statusText = pending
    ? "Waiting for approval"
    : task
      ? task.status === "waiting"
        ? "Waiting for you"
        : stepModeActive
          ? "AI step-by-step"
          : "AI working"
      : "You control";

  const reasonText = pending?.riskReason || pending?.description;
  const targetLabel = pending?.target || task?.target?.label || sessionLabel;

  return (
    <div
      className="flex shrink-0 flex-col border-b border-divider bg-app-surface text-xs"
      data-testid="terminal-control"
    >
      <div
        className="flex items-center justify-between gap-2 px-2 py-1"
        data-testid="terminal-control-bar"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span aria-live="polite" className="font-medium">
            {statusText}
            {sessionLabel ? ` · ${sessionLabel}` : ""}
          </span>
          {pending && (
            <span className={riskBadgeClass(pending.riskLevel)} data-testid="terminal-approval-risk">
              {pending.riskLevel ?? "modify"}
            </span>
          )}
          {pending?.guard && (
            <span className="ai-badge ai-badge-danger" data-testid="terminal-approval-guard">
              Guard
            </span>
          )}
        </div>
        {task && (
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-2 py-0.5 hover:bg-app-surface-hover"
              data-testid="terminal-step-by-step-btn"
              aria-pressed={stepModeActive}
              disabled={busy}
              onClick={onStepByStep}
            >
              <PauseCircle size={12} aria-hidden="true" />
              Step-by-step
            </button>
            <button
              type="button"
              className="rounded px-2 py-0.5 font-medium hover:bg-app-surface-hover"
              data-testid="terminal-return-control-btn"
              disabled={busy}
              onClick={onReturnControl}
            >
              Return Control
            </button>
          </div>
        )}
      </div>

      {pending && (
        <div
          className="flex flex-col gap-1.5 border-t border-divider bg-app-surface-raised/60 px-2 py-1.5"
          data-testid="terminal-approval-bar"
          role="region"
          aria-label="Pending command approval"
        >
          <div className="flex flex-wrap items-center gap-2">
            {targetLabel && (
              <span className="ai-chip" data-testid="terminal-approval-target">
                Host: {targetLabel}
              </span>
            )}
            {pending.blastRadius && (
              <span
                className="inline-flex items-center gap-1 text-amber-300"
                data-testid="terminal-approval-blast"
              >
                <AlertTriangle size={12} aria-hidden="true" />
                {pending.blastRadius}
              </span>
            )}
            {reasonText && (
              <span className="text-app-ink-soft" data-testid="terminal-approval-reason">
                {reasonText}
              </span>
            )}
          </div>

          {pending.command ? (
            <pre
              className="m-0 overflow-x-auto rounded bg-black/40 px-2 py-1 font-mono text-[11px]"
              data-testid="terminal-approval-command"
            >
              <HighlightedCode code={pending.command} lang={codeLangForShell(shell)} />
            </pre>
          ) : pending.diff ? (
            <pre
              className="m-0 max-h-24 overflow-auto rounded bg-black/40 px-2 py-1 font-mono text-[11px]"
              data-testid="terminal-approval-command"
            >
              <code>{pending.diff}</code>
            </pre>
          ) : null}

          {pending.dryRunOutput && (
            <small className="text-app-ink-faint" data-testid="terminal-approval-dryrun">
              Preflight: {pending.dryRunOutput}
            </small>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className="ai-btn-emerald inline-flex items-center gap-1 rounded px-2 py-0.5"
              data-testid="terminal-approve-once-btn"
              disabled={busy}
              onClick={onApproveOnce}
            >
              <Check size={12} aria-hidden="true" />
              Approve Once
            </button>

            {safePrefix && onAllowPrefix && (
              <button
                type="button"
                className="ai-btn-accent inline-flex items-center gap-1 rounded px-2 py-0.5"
                data-testid="terminal-allow-prefix-btn"
                title={`Always allow commands matching "${safePrefix}"`}
                disabled={busy}
                onClick={() => onAllowPrefix(safePrefix)}
              >
                <ShieldCheck size={12} aria-hidden="true" />
                Always Allow Prefix ({safePrefix})
              </button>
            )}

            {pending.riskLevel === "destructive" && (
              <span className="inline-flex items-center gap-1 text-[11px] text-rose-300">
                <ShieldAlert size={12} aria-hidden="true" />
                Destructive action requires single-run approval
              </span>
            )}

            <button
              type="button"
              className="ai-btn-danger inline-flex items-center gap-1 rounded px-2 py-0.5"
              data-testid="terminal-deny-btn"
              disabled={busy}
              onClick={onDeny}
            >
              <X size={12} aria-hidden="true" />
              Deny
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Compact control bar and inline approval banner docked above the active terminal.
 * Shows who controls the PTY, active blast radius / reason / syntax-highlighted command
 * preview when an approval is pending, and 1-click Approve Once / Allow Prefix / Deny /
 * Return Control / Step-by-step controls.
 */
export function TerminalControl(props: TerminalControlProps): JSX.Element | null {
  if (props.hub === undefined && window.multissh?.nativeHermes) {
    return <NativeTerminalControl {...props} />;
  }
  return <LegacyTerminalControl {...props} />;
}

function NativeTerminalControl({
  sessionId,
  onRequest,
  onStepByStep,
  onAllowPrefix,
}: TerminalControlProps): JSX.Element | null {
  const api = window.multissh.nativeHermes!;
  const [tools, setTools] = useState<NativeToolState>({ bindings: [] });
  const [busy, setBusy] = useState(false);
  const [stepRequested, setStepRequested] = useState(false);

  useEffect(() => {
    const unsubscribe = api.onToolsChanged(setTools);
    void api.tools().then(setTools);
    return unsubscribe;
  }, [api]);

  if (!sessionId) return null;

  const task = [...tools.bindings]
    .reverse()
    .find(
      (binding) =>
        binding.task.target?.sessionId === sessionId &&
        ["running", "waiting"].includes(binding.task.status),
    )?.task;
  const pending = task?.changes.find((c) => c.status === "pending");

  return (
    <TerminalControlBar
      sessionLabel={tools.selected?.id === sessionId ? tools.selected.label : task?.target?.label}
      shell={tools.selected?.id === sessionId ? tools.selected.shell : undefined}
      task={task}
      pending={pending}
      stepModeActive={Boolean(task && (stepRequested || task.mode === "assisted" || task.plan?.askEach))}
      busy={busy}
      onReturnControl={() => {
        if (!task) return;
        setBusy(true);
        void api.takeover(task.id).finally(() => setBusy(false));
      }}
      onStepByStep={() => {
        if (!task) return;
        setStepRequested(true);
        onStepByStep?.(task.id);
      }}
      onApproveOnce={() => {
        if (!task || !pending) return;
        setBusy(true);
        void api.approve(task.id, pending.id, true).finally(() => setBusy(false));
      }}
      onAllowPrefix={(prefix) => {
        if (!task || !pending) return;
        if (onAllowPrefix) {
          onAllowPrefix(prefix, task, pending);
          return;
        }
        setBusy(true);
        const dispatch =
          onRequest ?? (typeof window.multissh?.aiHubRequest === "function" ? hubRequest : undefined);
        const persist = dispatch
          ? dispatch({ action: "safety-policy-save", policy: { commandAllowPrefixes: [prefix] } }).catch(
              () => undefined,
            )
          : Promise.resolve();
        void persist
          .then(() => api.approve(task.id, pending.id, true))
          .finally(() => setBusy(false));
      }}
      onDeny={() => {
        if (!task || !pending) return;
        setBusy(true);
        void api.approve(task.id, pending.id, false).finally(() => setBusy(false));
      }}
    />
  );
}

function LegacyTerminalControl({
  sessionId,
  hub: hubProp,
  onRequest,
  onStepByStep,
  onAllowPrefix,
}: TerminalControlProps): JSX.Element | null {
  const storeHub = useHub();
  const hub = hubProp ?? storeHub;
  const dispatch = onRequest ?? hubRequest;
  const [busy, setBusy] = useState(false);
  const [stepRequested, setStepRequested] = useState(false);

  const session = hub?.sessions.find((s) => s.id === sessionId);
  if (!hub?.config.enabled || !session) return null;

  const task =
    hub.tasks.find((t) => t.id === session.owner) ??
    hub.tasks.find(
      (t) =>
        t.target?.sessionId === session.id &&
        (t.status === "running" || t.status === "waiting"),
    );
  const pending = task?.changes.find((c) => c.status === "pending");

  return (
    <TerminalControlBar
      sessionLabel={session.label}
      shell={session.shell}
      task={task}
      pending={pending}
      stepModeActive={Boolean(task && (stepRequested || task.mode === "assisted" || task.plan?.askEach))}
      busy={busy}
      onReturnControl={() => {
        setBusy(true);
        void dispatch({ action: "takeover", sessionId: session.id })
          .catch(() => {})
          .finally(() => setBusy(false));
      }}
      onStepByStep={() => {
        if (!task) return;
        setStepRequested(true);
        if (onStepByStep) {
          onStepByStep(task.id);
          return;
        }
        if (task.plan?.status === "proposed") {
          setBusy(true);
          void dispatch({ action: "plan-decide", taskId: task.id, approved: true, askEach: true })
            .catch(() => {})
            .finally(() => setBusy(false));
        } else if (task.status === "running") {
          setBusy(true);
          void dispatch({ action: "stop", taskId: task.id })
            .catch(() => {})
            .finally(() => setBusy(false));
        }
      }}
      onApproveOnce={() => {
        if (!task || !pending) return;
        setBusy(true);
        void dispatch({
          action: "approve",
          taskId: task.id,
          changeId: pending.id,
          approved: true,
        })
          .catch(() => {})
          .finally(() => setBusy(false));
      }}
      onAllowPrefix={(prefix) => {
        if (!task || !pending) return;
        if (onAllowPrefix) {
          onAllowPrefix(prefix, task, pending);
          return;
        }
        const existing = hub.safetyPolicy?.commandAllowPrefixes ?? [];
        const nextPrefixes = existing.includes(prefix) ? existing : [...existing, prefix];
        setBusy(true);
        void dispatch({
          action: "safety-policy-save",
          policy: { commandAllowPrefixes: nextPrefixes },
        })
          .catch(() => {})
          .then(() =>
            dispatch({
              action: "approve",
              taskId: task.id,
              changeId: pending.id,
              approved: true,
            }).catch(() => {}),
          )
          .finally(() => setBusy(false));
      }}
      onDeny={() => {
        if (!task || !pending) return;
        setBusy(true);
        void dispatch({
          action: "approve",
          taskId: task.id,
          changeId: pending.id,
          approved: false,
        })
          .catch(() => {})
          .finally(() => setBusy(false));
      }}
    />
  );
}
