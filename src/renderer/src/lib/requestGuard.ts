/**
 * Tells a component whether the result of an async start is still wanted. Starting something (a search, a log
 * stream, a tail) takes a round trip to the main process; if the user cancels, restarts or closes in the
 * meantime, the result arrives for nobody and whatever it started keeps running there. `begin()` hands out a
 * token, `invalidate()` (cancel, close, unmount) and any later `begin()` make earlier tokens stale.
 */
export interface RequestGuard {
  begin(): number;
  isCurrent(token: number): boolean;
  invalidate(): void;
}

export function createRequestGuard(): RequestGuard {
  let current = 0;
  return {
    begin: () => ++current,
    isCurrent: (token) => token === current,
    invalidate: () => {
      current++;
    },
  };
}

/**
 * Runs `start`. If the guard moved on before it finished, the result goes to `discard` (stop whatever it
 * started) and undefined is returned; a failure of such a request is swallowed, since nobody is waiting for it.
 */
export async function startGuarded<T>(
  guard: RequestGuard,
  token: number,
  start: () => Promise<T>,
  discard: (value: T) => void
): Promise<{ value: T } | undefined> {
  let value: T;
  try {
    value = await start();
  } catch (err) {
    if (!guard.isCurrent(token)) return undefined;
    throw err;
  }
  if (!guard.isCurrent(token)) {
    discard(value);
    return undefined;
  }
  return { value };
}
