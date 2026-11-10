import { useHub, hubRequest } from "../../lib/aiHub";

export function TerminalControl({
  sessionId,
}: {
  sessionId: string | null;
}): JSX.Element | null {
  const hub = useHub();
  const session = hub?.sessions.find((s) => s.id === sessionId);
  if (!hub?.config.enabled || !session || !session.owner) return null;
  const task = hub.tasks.find((t) => t.id === session.owner);
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-divider bg-app-surface px-2 py-1 text-xs">
      <span aria-live="polite">
        {task?.status === "waiting" ? "Waiting for you" : "AI working"} · {session.label}
      </span>
      <button
          className="rounded px-2 hover:bg-app-surface-hover"
          onClick={() => {
            void hubRequest({
              action: "takeover",
              sessionId: session.id,
            }).catch(() => {});
          }}
        >
          Take control
        </button>
    </div>
  );
}
