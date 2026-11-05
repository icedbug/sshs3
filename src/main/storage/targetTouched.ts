/**
 * Optional signal on a write stream: `targetTouched` is false until the provider has actually opened (and so
 * truncated) or replaced the target. `TransferPipeline` uses it to decide whether a failed transfer may delete
 * the target: a stream that never touched it must leave an existing file alone (a cancelled S3 overwrite, a
 * read-only local file that could not be opened, an SFTP file whose lazy open never happened).
 */
export interface TargetTouchedSignal {
  readonly targetTouched: boolean;
}

/** Streams without the signal count as touched, which keeps the earlier "clean up the partial file" behaviour. */
export function wasTargetTouched(stream: unknown): boolean {
  const flag = (stream as Partial<TargetTouchedSignal> | null | undefined)?.targetTouched;
  return typeof flag === 'boolean' ? flag : true;
}

/** Longest a failed transfer waits for an open that is on the wire; a hung server must not keep a cancel from finishing. */
export const TARGET_SETTLE_TIMEOUT_MS = 5000;

/**
 * Waits (bounded) for an open that is still in flight, if the stream has one (SFTP opens lazily on the first write).
 * Without this a transfer that fails while the open is on the wire would be judged "untouched" although the server is
 * about to truncate it. On timeout the flag simply keeps its current value (untouched unless the open already succeeded),
 * so an unanswered open never causes a delete of a file we may not have touched.
 */
export async function settleTargetTouched(stream: unknown, timeoutMs = TARGET_SETTLE_TIMEOUT_MS): Promise<boolean> {
  const settle = (stream as { targetSettled?: unknown } | null | undefined)?.targetSettled;
  if (typeof settle !== 'function') return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (settle as () => Promise<void>).call(stream).then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `then` once an open that did not settle in time finally has, so a late truncation can still be cleaned up. */
export function whenTargetSettledLater(stream: unknown, then: () => Promise<void> | void): void {
  const settle = (stream as { targetSettled?: unknown } | null | undefined)?.targetSettled;
  if (typeof settle !== 'function') return;
  void (settle as () => Promise<void>)
    .call(stream)
    .catch(() => {})
    .then(then)
    .catch(() => {});
}

/** Adds the `targetSettled` hook (resolves once the open has succeeded or failed) to a stream object that is not one of our own classes. */
export function defineTargetSettled<T extends object>(stream: T, settled: () => Promise<void>): T {
  Object.defineProperty(stream, 'targetSettled', { value: settled, configurable: true });
  return stream;
}

/** Adds the `targetTouched` getter to a stream object that is not one of our own classes. */
export function defineTargetTouched<T extends object>(stream: T, isTouched: () => boolean): T & TargetTouchedSignal {
  Object.defineProperty(stream, 'targetTouched', { get: isTouched, configurable: true });
  return stream as T & TargetTouchedSignal;
}
