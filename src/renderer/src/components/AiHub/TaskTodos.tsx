import type { AgentTodo } from "@shared/types/aiHub";

const MARK: Record<AgentTodo["status"], string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  cancelled: "✕",
  blocked: "⏸",
};
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
 * is also the honest answer to "is it finished?".
 */
export function TaskTodos({ todos }: { todos?: AgentTodo[] }): JSX.Element | null {
  if (!todos || todos.length === 0) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <section
      className="ai-card"
      data-testid="task-todos"
      aria-label="The agent's task list"
      style={{ margin: "8px 0", padding: "8px 10px" }}
    >
      <strong style={{ fontSize: 12 }}>
        Task list · {done}/{todos.length} done
      </strong>
      <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "grid", gap: 4 }}>
        {todos.map((todo) => (
          <li
            key={todo.id}
            data-status={todo.status}
            style={{
              fontSize: 12,
              opacity: todo.status === "completed" || todo.status === "cancelled" ? 0.7 : 1,
            }}
          >
            <span aria-hidden="true" style={{ marginRight: 6 }}>
              {MARK[todo.status]}
            </span>
            <span
              style={{
                textDecoration: todo.status === "cancelled" ? "line-through" : undefined,
                fontWeight: todo.status === "in_progress" ? 600 : undefined,
              }}
            >
              {todo.content}
            </span>
            <small style={{ marginLeft: 6, opacity: 0.75 }}>({LABEL[todo.status]})</small>
            {todo.note && (
              <small style={{ display: "block", marginLeft: 20, opacity: 0.8 }}>
                {todo.note}
              </small>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
