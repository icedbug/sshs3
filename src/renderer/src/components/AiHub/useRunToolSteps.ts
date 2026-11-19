import { useEffect, useState } from "react";
import type { AgentTask, HubReply } from "@shared/types/aiHub";

type Details = NonNullable<HubReply["taskTools"]>;

/** Only the open drawer reads the retained log. Snapshots and delta messages carry its total. */
export function useRunToolSteps(task?: AgentTask) {
  const id = task?.id;
  const live = task?.toolLog;
  const count = task?.toolStepCount ?? live?.length ?? 0;
  const [details, setDetails] = useState<Details>();
  const [errorKey, setErrorKey] = useState("");
  const [attempt, setAttempt] = useState(0);
  const key = `${id}:${count}:${attempt}`;
  const cached = details?.id === id ? details : undefined;
  const missing = cached ? count - cached.count : count;
  const liveLength = live?.length ?? 0;
  const covered = liveLength >= Math.min(count, 60) || Boolean(cached && missing <= liveLength);

  useEffect(() => {
    if (!id || covered) return;
    let current = true;
    void (async () => {
      try {
        const reply = await window.multissh.aiHubRequest({ action: "task-read", taskId: id, detail: "tools" });
        const result = reply.reply?.taskTools;
        if (!result || result.id !== id || result.count < count) throw new Error("Tool details unavailable");
        if (current) setDetails(result);
      } catch {
        if (current) setErrorKey(key);
      }
    })();
    return () => { current = false; };
  }, [id, count, covered, key]);

  // The inspected data can arrive ahead of the next snapshot.
  const total = Math.max(count, cached?.count ?? 0);
  let steps = live ?? [];
  if (cached && (missing <= 0 || liveLength < Math.min(count, 60))) {
    steps = missing > 0 && missing <= liveLength
      ? [...cached.entries, ...steps.slice(-missing)].slice(-60)
      : cached.entries;
  }
  return { count: total, steps, failed: !covered && errorKey === key, retry: () => setAttempt(n => n + 1) };
}
