import { useSyncExternalStore } from "react";
import type { HubRequest, HubSnapshot } from "@shared/types/aiHub";

let snapshot: HubSnapshot | undefined;
let selected = "";
let unsubscribe: (() => void) | undefined;
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
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      unsubscribe?.();
      unsubscribe = undefined;
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
export async function hubRequest(request: HubRequest): Promise<HubSnapshot> {
  const n = ++sent;
  const next = await window.multissh.aiHubRequest(request);
  if (take(n, next)) publish();
  // The caller gets its own answer (its reply), whatever is on screen.
  return next;
}
