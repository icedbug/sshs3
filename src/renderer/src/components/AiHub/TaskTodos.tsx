import type { AgentTodo } from "@shared/types/aiHub";

const LABEL: Record<AgentTodo["status"], string> = {
  pending: "to do",
  in_progress: "in progress",
  completed: "done",
  cancelled: "cancelled",
  blocked: "waiting for you",
};

/**
 * The agent's own task list for the conversation: what it set out to do, where
 * it is, and what showed each step done. The agent is held to this list, so it
 * is also the honest answer to "is it finished?". Collapsed it is one line
 * with the progress and the step in hand; opened it is the whole list.
 */
export function TaskTodos({ todos }: { todos?: AgentTodo[] }): JSX.Element | null {
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
  return (
    <details
      className="ai-todos"
      data-testid="task-todos"
      aria-label="The agent's task list"
      open={todos.length <= 4}
    >
      <summary>
        <span className="ai-todos-title">
          Task list · {done}/{todos.length} done
        </span>
        {current && (
          <span className="ai-todos-current" data-status={current.status}>
            {current.content}
          </span>
        )}
        <span
          className="ai-todos-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </span>
      </summary>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id} data-status={todo.status}>
            <span className="ai-todo-mark" aria-hidden="true" />
            <span className="ai-todo-text">
              {todo.content}
              <small> ({LABEL[todo.status]})</small>
              {todo.note && <small className="ai-todo-note">{todo.note}</small>}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
