import { useSyncExternalStore } from "react";
import type { AgentTask, HubRequest, HubSnapshot } from "@shared/types/aiHub";
import type {
  AiHubDeltaEvent,
  MultiSSHApiWithHubDelta,
} from "@shared/ipc/createMultiSSHApi";

export type { AiHubDeltaEvent };

let snapshot: HubSnapshot | undefined;
let selected = "";
let unsubscribe: (() => void) | undefined;
let unsubscribeDelta: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let inflightRefresh: Promise<void> | undefined;
/**
 * Each request is numbered when it is sent. An answer older than the one on
 * screen is dropped, so a refresh that started before an action cannot put
 * the panel back to how it was before the action.
 */
let sent = 0;
let shown = 0;
/** A change came in while a refresh was on its way: one more refresh follows it. */
let refreshAgain = false;
const take = (n: number, next: HubSnapshot): boolean => {
  if (n < shown) return false;
  shown = n;
  snapshot = next;
  return true;
};
const listeners = new Set<() => void>();
const publish = (): void => {
  for (const listener of listeners) listener();
};
function refresh(): Promise<void> {
  if (!window.multissh?.aiHubRequest) return Promise.resolve();
  if (inflightRefresh) {
    refreshAgain = true;
    return inflightRefresh;
  }
  inflightRefresh = (async () => {
    const n = ++sent;
    try {
      const next = await window.multissh.aiHubRequest({ action: "snapshot" });
      clearTimeout(retryTimer);
      retryTimer = undefined;
      if (take(n, next)) publish();
    } catch {
      if (!snapshot && listeners.size > 0 && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void refresh();
        }, 1000);
      }
    } finally {
      inflightRefresh = undefined;
      if (refreshAgain) {
        refreshAgain = false;
        void refresh();
      }
    }
  })();
  return inflightRefresh;
}
export function applyAiHubDelta(
  current: HubSnapshot | undefined,
  delta: AiHubDeltaEvent,
): HubSnapshot | undefined {
  if (!current) return current;
  const idx = current.tasks.findIndex((t) => t.id === delta.taskId);
  if (idx < 0) return current;
  const task = current.tasks[idx];
  let nextTask: AgentTask | undefined;

  if (delta.type === "message.delta" && delta.delta) {
    const messages = [...task.messages];
    const last = messages.at(-1);
    if (last && last.role === "assistant") {
      messages[messages.length - 1] = {
        ...last,
        text: `${last.text}${delta.delta}`.slice(-128_000),
      };
    } else {
      messages.push({
        id: `delta-${delta.taskId}-${delta.at}-${messages.length}`,
        role: "assistant",
        text: delta.delta.slice(-128_000),
        at: delta.at,
      });
    }
    nextTask = { ...task, messages, updatedAt: delta.at };
  } else if (delta.type === "tool.result" && delta.tool) {
    const toolLog = [...(task.toolLog ?? []), delta.tool].slice(-60);
    nextTask = { ...task, toolLog, updatedAt: delta.at };
  } else if (delta.type === "usage.updated" && delta.usage) {
    nextTask = {
      ...task,
      runUsage: {
        inputTokens: delta.usage.inputTokens,
        outputTokens: delta.usage.outputTokens,
        ...(delta.usage.cacheReadTokens !== undefined
          ? { cacheReadTokens: delta.usage.cacheReadTokens }
          : {}),
        ...(delta.usage.cacheCreationTokens !== undefined
          ? { cacheCreationTokens: delta.usage.cacheCreationTokens }
          : {}),
        ...(delta.usage.costUsd !== undefined
          ? { costUsd: delta.usage.costUsd }
          : {}),
      },
      ...(delta.usage.contextTokens !== undefined
        ? { contextTokens: delta.usage.contextTokens }
        : {}),
      updatedAt: delta.at,
    };
  } else if (delta.type === "run.retrying" && delta.retry) {
    const text =
      delta.retry.text ||
      `Retrying request (attempt ${delta.retry.attempt ?? 1}/${delta.retry.maxAttempts ?? 1})...`;
    const messages = [...task.messages];
    const last = messages.at(-1);
    if (last && last.role === "system" && last.id.startsWith("retry-")) {
      messages[messages.length - 1] = { ...last, text, at: delta.at };
    } else {
      messages.push({
        id: `retry-${delta.taskId}-${delta.at}`,
        role: "system",
        text,
        at: delta.at,
      });
    }
    nextTask = { ...task, messages, updatedAt: delta.at };
  } else if (delta.type === "run.degraded" && delta.degraded) {
    const text =
      delta.degraded.text ||
      `Model degraded${delta.degraded.toModel ? ` to ${delta.degraded.toModel}` : ""}${delta.degraded.error ? `: ${delta.degraded.error}` : ""}`;
    nextTask = {
      ...task,
      ...(delta.degraded.toModel ? { model: delta.degraded.toModel } : {}),
      messages: [
        ...task.messages,
        {
          id: `degraded-${delta.taskId}-${delta.at}`,
          role: "system",
          text,
          at: delta.at,
        },
      ],
      updatedAt: delta.at,
    };
  }

  if (!nextTask) return current;
  const tasks = [...current.tasks];
  tasks[idx] = nextTask;
  return { ...current, tasks };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!unsubscribe && window.multissh?.onAiHubChanged) {
    unsubscribe = window.multissh.onAiHubChanged(() => {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          void refresh();
        }, 100);
    });
    void refresh();
  } else if (!snapshot) {
    void refresh();
  }
  const api = window.multissh as Partial<MultiSSHApiWithHubDelta> | undefined;
  if (!unsubscribeDelta && api?.onAiHubDelta) {
    unsubscribeDelta = api.onAiHubDelta((delta) => {
      const patched = applyAiHubDelta(snapshot, delta);
      if (patched && patched !== snapshot) {
        snapshot = patched;
        publish();
      }
    });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      unsubscribe?.();
      unsubscribe = undefined;
      unsubscribeDelta?.();
      unsubscribeDelta = undefined;
      clearTimeout(timer);
      timer = undefined;
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };
}
export function useHub(): HubSnapshot | undefined {
  return useSyncExternalStore(subscribe, () => snapshot);
}
export function useSelectedTerminal(): string {
  return useSyncExternalStore(subscribe, () => selected);
}
export function selectAiTerminal(id: string): void {
  selected = id;
  if (window.multissh?.nativeHermes) {
    void window.multissh.nativeHermes.selectTerminal(id || undefined).catch(() => {});
  }
  publish();
}
export function onAiHubDelta(
  callback: (delta: AiHubDeltaEvent) => void,
): () => void {
  const api = (typeof window !== "undefined" ? window.multissh : undefined) as
    | Partial<MultiSSHApiWithHubDelta>
    | undefined;
  if (typeof api?.onAiHubDelta === "function") {
    return api.onAiHubDelta(callback);
  }
  return () => {};
}
export async function hubRequest(request: HubRequest): Promise<HubSnapshot> {
  const n = ++sent;
  const next = await window.multissh.aiHubRequest(request);
  if (take(n, next)) publish();
  // The caller gets its own answer (its reply), whatever is on screen.
  return next;
}
