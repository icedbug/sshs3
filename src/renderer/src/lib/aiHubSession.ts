/** Desktop keeps its own tab selection. Web selections are namespaced by the authenticated account. */
const OPEN_TASK_KEY = "sshs3.aiHub.openTask";
let account: string | null | undefined;
let generation = 0;
const resetters = new Set<() => void>();

export const hubSessionGeneration = (): number => generation;
export const hubSessionActive = (): boolean => account !== null;

export function onHubSessionReset(reset: () => void): void {
  resetters.add(reset);
}

export function openTaskStorageKey(): string | undefined {
  if (account === null) return undefined;
  return account === undefined ? OPEN_TASK_KEY : OPEN_TASK_KEY + "." + encodeURIComponent(account);
}

/** Called before mounting an authenticated workspace and when its session ends. */
export function setHubWebAccount(next: string | null): void {
  if (account === next) return;
  const oldKey = openTaskStorageKey();
  account = next;
  generation++;
  try {
    // The old unscoped web key has no verified owner.
    if (oldKey) window.sessionStorage.removeItem(oldKey);
  } catch {
    // Storage can be unavailable in a restricted browser.
  }
  for (const reset of resetters) reset();
}
