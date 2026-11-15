/**
 * The last line of defence of the multi-user server process. One person's connection that breaks (a
 * browser that resets, an SSH host that drops, a model endpoint that hangs up) must not end everybody's
 * session; an error nobody expected, on the other hand, may have left the process in a state nobody can
 * vouch for, and there the server stops, says why, and lets its supervisor start it again.
 */

/** Error codes of one connection or one outbound call: the process itself is fine. */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_SOCKET_CLOSED',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_ABORTED',
]);

/** Whether an error belongs to one connection (or one call) rather than to the process. */
export function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  if (typeof e.code === 'string' && CONNECTION_ERROR_CODES.has(e.code)) return true;
  if (e.name === 'AbortError') return true;
  // undici ends a body stream whose socket closed with a bare TypeError('terminated').
  if (err instanceof TypeError && e.message === 'terminated') return true;
  return e.cause !== undefined && e.cause !== err && isConnectionError(e.cause);
}

const describe = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);

export interface ProcessGuardOptions {
  /** Where the lines go (the operator's terminal). */
  write: (line: string) => void;
  /** Called once for an error the process cannot vouch for after: stop what can be stopped, then exit. */
  fatal: (err: unknown) => void;
}

export interface ProcessGuards {
  /** The handlers, as installed: for tests and for `remove`. */
  onUncaughtException: (err: unknown) => void;
  onUnhandledRejection: (reason: unknown) => void;
  remove(): void;
}

export function installProcessGuards(options: ProcessGuardOptions, target: NodeJS.Process = process): ProcessGuards {
  let failing = false;
  const onUncaughtException = (err: unknown): void => {
    if (isConnectionError(err)) {
      options.write(`[sshs3-web] A connection failed and was dropped; the server keeps running: ${describe(err)}`);
      return;
    }
    options.write(`[sshs3-web] Unexpected error; the server stops so that it can be started again in a known state: ${describe(err)}`);
    if (failing) return;
    failing = true;
    options.fatal(err);
  };
  // A promise nobody waited for is one request's (or one background job's) failure: what it was doing
  // did not happen, and nothing else is touched. It is written down, not allowed to end the server.
  const onUnhandledRejection = (reason: unknown): void => {
    options.write(`[sshs3-web] A request failed without being handled; the server keeps running: ${describe(reason)}`);
  };
  target.on('uncaughtException', onUncaughtException);
  target.on('unhandledRejection', onUnhandledRejection);
  return {
    onUncaughtException,
    onUnhandledRejection,
    remove: () => {
      target.removeListener('uncaughtException', onUncaughtException);
      target.removeListener('unhandledRejection', onUnhandledRejection);
    },
  };
}
