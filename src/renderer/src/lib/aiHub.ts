import { useSyncExternalStore } from "react";
import type { HubRequest, HubSnapshot } from "@shared/types/aiHub";

let snapshot: HubSnapshot | undefined;
let selected = "";
let unsubscribe: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let inflightRefresh: Promise<void> | undefined;
const listeners = new Set<() => void>();
const publish = (): void => {
  for (const listener of listeners) listener();
};
function refresh(): Promise<void> {
  if (!window.multissh?.aiHubRequest) return Promise.resolve();
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    try {
      snapshot = await window.multissh.aiHubRequest({ action: "snapshot" });
      clearTimeout(retryTimer);
      retryTimer = undefined;
      publish();
    } catch {
      if (!snapshot && listeners.size > 0 && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void refresh();
        }, 1000);
      }
    } finally {
      inflightRefresh = undefined;
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
  snapshot = await window.multissh.aiHubRequest(request);
  publish();
  return snapshot;
}
