import { useEffect, useState } from "react";
import { AlertCircle, Check, Circle, Loader2, X } from "lucide-react";
import type { AgentTodo } from "@shared/types/aiHub";
import { TABULAR_NUMS_CLASS, TABULAR_NUMS_STYLE } from "./panelShared";

export type TaskTodoItem = AgentTodo & {
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  elapsedMs?: number;
};

export interface TaskTodosProps {
  todos?: TaskTodoItem[];
  /** Optional total elapsed time in milliseconds. */
  elapsedMs?: number;
  /** Optional start epoch timestamp in milliseconds for live elapsed timing. */
  startedAt?: number;
}

const LABEL: Record<AgentTodo["status"], string> = {
  pending: "to do",
  in_progress: "in progress",
  completed: "done",
  cancelled: "cancelled",
  blocked: "waiting for you",
};

/** Formats an elapsed millisecond duration into a compact human-readable string. */
function formatTodoElapsed(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  if (safeMs < 1000) return `${safeMs}ms`;
  const totalSec = safeMs / 1000;
  if (totalSec < 60) return `${totalSec < 10 ? totalSec.toFixed(1) : Math.round(totalSec)}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = Math.round(totalSec % 60);
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

function todoElapsedMs(todo: TaskTodoItem, now: number): number | undefined {
  if (typeof todo.durationMs === "number" && todo.durationMs >= 0) return todo.durationMs;
  if (typeof todo.elapsedMs === "number" && todo.elapsedMs >= 0) return todo.elapsedMs;
  if (typeof todo.startedAt === "number") {
    if (typeof todo.completedAt === "number" && todo.completedAt >= todo.startedAt) {
      return todo.completedAt - todo.startedAt;
    }
    if (todo.status === "in_progress") {
      return Math.max(0, now - todo.startedAt);
    }
  }
  return undefined;
}

function StatusIcon({ status }: { status: AgentTodo["status"] }): JSX.Element {
  switch (status) {
    case "in_progress":
      return (
        <Loader2
          size={12}
          className="ai-spin animate-spin"
          data-testid="todo-spinner"
          aria-hidden="true"
        />
      );
    case "completed":
      return <Check size={12} data-testid="todo-icon-completed" aria-hidden="true" />;
    case "blocked":
      return <AlertCircle size={12} data-testid="todo-icon-blocked" aria-hidden="true" />;
    case "cancelled":
      return <X size={12} data-testid="todo-icon-cancelled" aria-hidden="true" />;
    default:
      return <Circle size={12} data-testid="todo-icon-pending" aria-hidden="true" />;
  }
}

/**
 * The agent's own task list for the conversation: what it set out to do, where
 * it is, and what showed each step done. The agent is held to this list, so it
 * is also the honest answer to "is it finished?". Collapsed it is one line
 * with the progress and the step in hand; opened it is the whole list.
 */
export function TaskTodos({ todos, elapsedMs, startedAt }: TaskTodosProps): JSX.Element | null {
  const hasLiveStart = Boolean(
    todos?.some(
      (t) =>
        t.status === "in_progress" &&
        (typeof t.startedAt === "number" || (typeof startedAt === "number" && elapsedMs === undefined)),
    ),
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hasLiveStart) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasLiveStart]);

  if (!todos || todos.length === 0) return null;

  const done = todos.filter((t) => t.status === "completed").length;
  const settled = todos.filter(
    (t) => t.status === "completed" || t.status === "cancelled",
  ).length;
  const current =
    todos.find((t) => t.status === "in_progress") ??
    todos.find((t) => t.status === "blocked") ??
    todos.find((t) => t.status === "pending");
  const percent = Math.round((settled / todos.length) * 100);

  const totalElapsedMs =
    typeof elapsedMs === "number"
      ? elapsedMs
      : typeof startedAt === "number"
        ? Math.max(0, now - startedAt)
        : undefined;

  return (
    <details
      className="ai-todos"
      data-testid="task-todos"
      aria-label="The agent's task list"
      open={todos.length <= 4}
    >
      <summary>
        <span className={`ai-todos-title ${TABULAR_NUMS_CLASS}`} style={TABULAR_NUMS_STYLE}>
          Task list · {done}/{todos.length} done
        </span>
        {current && (
          <span className="ai-todos-current" data-status={current.status}>
            {current.content}
          </span>
        )}
        {totalElapsedMs !== undefined && (
          <span
            className={`ai-badge ai-todos-elapsed ${TABULAR_NUMS_CLASS}`}
            style={TABULAR_NUMS_STYLE}
            data-testid="task-todos-elapsed"
          >
            {formatTodoElapsed(totalElapsedMs)}
          </span>
        )}
        <span
          className="ai-todos-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${done} of ${todos.length} done`}
        >
          <span style={{ width: `${percent}%` }} />
        </span>
      </summary>
      <ul>
        {todos.map((todo) => {
          const itemElapsed = todoElapsedMs(todo, now);
          return (
            <li key={todo.id} data-status={todo.status}>
              <span className="ai-todo-mark" aria-hidden="true">
                <StatusIcon status={todo.status} />
              </span>
              <span className="ai-todo-text">
                {todo.content}
                <small> ({LABEL[todo.status]})</small>
                {itemElapsed !== undefined && (
                  <small
                    className={`ai-todo-elapsed ${TABULAR_NUMS_CLASS}`}
                    style={TABULAR_NUMS_STYLE}
                    data-testid={`todo-elapsed-${todo.id}`}
                  >
                    {" "}· {formatTodoElapsed(itemElapsed)}
                  </small>
                )}
                {todo.note && <small className="ai-todo-note">{todo.note}</small>}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
