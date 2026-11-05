import { describeIpcError } from './format';

/**
 * Saves `changed` one at a time, in order, then reloads the list. The first failure stops the run: what
 * was saved is reloaded and only then is the error reported (reloading usually clears the error that
 * is showing). Resolves true when every profile was saved.
 */
export async function saveInOrder<T>(
  changed: readonly T[],
  save: (profile: T) => Promise<unknown>,
  reload: () => Promise<void>,
  onError: (message: string) => void,
  failure: string
): Promise<boolean> {
  let message: string | null = null;
  try {
    for (const profile of changed) await save(profile);
  } catch (err) {
    message = describeIpcError(err, failure);
  }
  await reload();
  if (message !== null) onError(message);
  return message === null;
}
