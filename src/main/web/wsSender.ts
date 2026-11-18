/**
 * How frames are sent to one websocket client without the server's memory growing behind a client
 * that reads slowly or not at all.
 *
 * A frame is written at once while the socket takes it. Once the socket pushes back, frames wait in
 * a queue and go out in order when it drains. Past a hard limit of bytes waiting (in the socket and
 * in the queue together) something has to give:
 *
 * - terminal and log output is dropped and counted: the next output replaces it;
 * - an answer to a request is never dropped (its request would wait for ever), and is kept until it
 *   too is past a second, larger limit;
 * - anything else that cannot be kept means the client is too far behind: the connection is closed,
 *   and the client reconnects and asks again.
 *
 * This is on its own, with only what it needs of a socket, so that it can be tested without one:
 * how much a real socket takes before it pushes back is up to the operating system.
 */

/** What the sender needs of a socket. */
export interface WsSenderSocket {
  readonly destroyed: boolean;
  readonly writable: boolean;
  /** Bytes written to the socket that it has not passed on yet. */
  readonly writableLength: number;
  /** False when the socket wants the writer to wait for 'drain'. */
  write(frame: Buffer): boolean;
  once(event: 'drain', listener: () => void): unknown;
}

export interface WsSenderLimits {
  /** Bytes waiting in the socket from which new frames are queued instead of written. */
  highWaterBytes: number;
  /** Bytes waiting (socket and queue) past which output is dropped and a client that is too far behind is closed. */
  maxBufferedBytes: number;
  /** Bytes waiting past which not even an answer to a request is kept. */
  maxQueuedResponseBytes: number;
}

/** Counted per connection, and added up in the server's statistics. */
export interface WsSenderCounters {
  backpressureEvents: number;
  droppedStreamFrames: number;
}

export interface WsSenderHooks {
  /** A message as the websocket frame that carries it. */
  encode(jsonText: string): Buffer;
  /** Whether the message is output that may be dropped when the client is behind. */
  droppable(jsonText: string): boolean;
  /** Closes the connection of a client that is too far behind. */
  reap(): void;
}

export type WsSend = (jsonText: string, kind?: 'response' | 'other') => void;

export interface WsSender {
  send: WsSend;
  /** Forgets what is still waiting: for a connection that has closed. */
  clear(): void;
  /** Bytes waiting in the queue (not counting what the socket itself holds). */
  queuedBytes(): number;
}

export function createWsSender(socket: WsSenderSocket, limits: WsSenderLimits, counters: WsSenderCounters, hooks: WsSenderHooks): WsSender {
  const { highWaterBytes, maxBufferedBytes, maxQueuedResponseBytes } = limits;
  const queuedFrames: Array<{ buf: Buffer; bytes: number }> = [];
  let queuedBytes = 0;
  let draining = false;

  const flushQueued = (): void => {
    draining = false;
    while (queuedFrames.length > 0 && !socket.destroyed && socket.writable) {
      if (socket.writableLength >= highWaterBytes) {
        draining = true;
        socket.once('drain', flushQueued);
        return;
      }
      const next = queuedFrames.shift()!;
      queuedBytes -= next.bytes;
      const ok = socket.write(next.buf);
      if (!ok) {
        draining = true;
        socket.once('drain', flushQueued);
        return;
      }
    }
  };

  const send: WsSend = (jsonText, kind = 'other') => {
    if (socket.destroyed || !socket.writable) return;
    const frame = hooks.encode(jsonText);
    const inFlight = socket.writableLength + queuedBytes;

    if (inFlight > 0 && inFlight + frame.length > maxBufferedBytes) {
      counters.backpressureEvents += 1;
      if (kind !== 'response' && hooks.droppable(jsonText)) {
        counters.droppedStreamFrames += 1;
        return;
      }
      // A response is never dropped: its request would wait for ever. Past this much queued it is the
      // connection that goes (the client then fails what it was waiting for at once).
      if (kind !== 'response' || inFlight + frame.length > maxQueuedResponseBytes) {
        hooks.reap();
        return;
      }
    }

    if (!draining && queuedFrames.length === 0 && socket.writableLength < highWaterBytes) {
      const ok = socket.write(frame);
      if (!ok) {
        counters.backpressureEvents += 1;
        draining = true;
        socket.once('drain', flushQueued);
      }
      return;
    }

    if (!draining) {
      counters.backpressureEvents += 1;
      draining = true;
      socket.once('drain', flushQueued);
    }
    queuedFrames.push({ buf: frame, bytes: frame.length });
    queuedBytes += frame.length;
  };

  return {
    send,
    clear: () => {
      queuedFrames.length = 0;
      queuedBytes = 0;
    },
    queuedBytes: () => queuedBytes,
  };
}
