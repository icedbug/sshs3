import { useHub, hubRequest } from "../../lib/aiHub";
import { useEffect, useState } from 'react';
import type { NativeToolState } from '@shared/types/nativeHermes';

export function TerminalControl({
  sessionId,
}: {
  sessionId: string | null;
}): JSX.Element | null {
  return window.multissh?.nativeHermes ? <NativeTerminalControl sessionId={sessionId} /> : <LegacyTerminalControl sessionId={sessionId} />;
}

function NativeTerminalControl({ sessionId }: { sessionId: string | null }): JSX.Element | null {
  const api = window.multissh.nativeHermes!;
  const [tools, setTools] = useState<NativeToolState>({ bindings: [] });
  useEffect(() => {
    const unsubscribe = api.onToolsChanged(setTools);
    void api.tools().then(setTools);
    return unsubscribe;
  }, [api]);
  if (!sessionId) return null;
  const task = [...tools.bindings].reverse().find(binding => binding.task.target?.sessionId === sessionId && ['running', 'waiting'].includes(binding.task.status))?.task;
  return <div className="flex shrink-0 items-center justify-between border-b border-divider bg-app-surface px-2 py-1 text-xs">
    <span aria-live="polite">{task ? task.status === 'waiting' ? 'Waiting for you' : 'AI working' : 'You control'}</span>
    {task && <button className="rounded px-2 hover:bg-app-surface-hover" onClick={() => void api.takeover(task.id)}>Take control</button>}
  </div>;
}

function LegacyTerminalControl({ sessionId }: { sessionId: string | null }): JSX.Element | null {
  const hub = useHub();
  const session = hub?.sessions.find((s) => s.id === sessionId);
  if (!hub?.config.enabled || !session) return null;
  const task = hub.tasks.find((t) => t.id === session.owner);
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-divider bg-app-surface px-2 py-1 text-xs">
      <span aria-live="polite">
        {session.owner
          ? task?.status === "waiting"
            ? "Waiting for you"
            : "AI working"
          : "You control"}{" "}
        · {session.label}
      </span>
      {session.owner && (
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
      )}
    </div>
  );
}
