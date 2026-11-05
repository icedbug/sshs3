/**
 * Runs async operations one at a time, in the order they were queued, and lets a caller cancel everything
 * that is queued or running (used by logout: a sign-in that is still pending must not log the user back in).
 */
export class OperationQueue {
  /** Tail of the queue; it never rejects, so one failed operation does not stop the next. */
  private tail: Promise<void> = Promise.resolve();
  /** Bumped by cancelAll(): operations queued before it are dropped when their turn comes. */
  private epoch = 0;
  private running: AbortController | null = null;

  constructor(private readonly cancelMessage = 'Operation was cancelled') {}

  /**
   * Queues `task`. Its signal is aborted by cancelAll() or by `external`; an operation cancelled before it
   * started never runs and rejects with the cancel message.
   */
  public run<T>(task: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    const epoch = this.epoch;
    const result = this.tail.then(async () => {
      if (epoch !== this.epoch || external?.aborted) {
        throw new Error(this.cancelMessage);
      }
      const controller = new AbortController();
      const onExternalAbort = () => controller.abort();
      external?.addEventListener('abort', onExternalAbort, { once: true });
      this.running = controller;
      try {
        return await task(controller.signal);
      } finally {
        external?.removeEventListener('abort', onExternalAbort);
        if (this.running === controller) this.running = null;
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** Aborts the running operation and drops everything queued so far; operations queued afterwards run normally. */
  public cancelAll(): void {
    this.epoch++;
    this.running?.abort();
  }
}
