export interface UploadCoalescer {
  /** A change was seen: upload it once things have been quiet for the debounce time. */
  trigger(): void;
  /** Uploads a change that is still waiting and resolves when no upload is running or queued. */
  flush(): Promise<void>;
  /** Forgets pending work; later changes are ignored. A running upload is not interrupted. */
  dispose(): void;
}

/**
 * Serialises auto-uploads of one file. Changes inside the debounce window become one upload, and only one upload
 * runs at a time: a change that arrives while one is running is folded into a single follow-up, which reads the
 * file as it is then. Without this, two uploads could overlap and truncate each other's writes on the remote file.
 * `upload` is expected to report its own errors; a throw is swallowed so the chain keeps going.
 */
export function createUploadCoalescer(upload: () => Promise<void>, debounceMs = 500): UploadCoalescer {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let pending = false;
  let disposed = false;

  const start = (): void => {
    running = (async () => {
      try {
        await upload();
      } catch {
        // reported by `upload` itself
      } finally {
        running = null;
        if (pending && !disposed) {
          pending = false;
          start();
        }
      }
    })();
  };

  const request = (): void => {
    if (disposed) return;
    if (running) pending = true;
    else start();
  };

  return {
    trigger() {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        request();
      }, debounceMs);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        request();
      }
      while (running) await running;
    },
    dispose() {
      disposed = true;
      pending = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
