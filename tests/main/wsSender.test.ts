import { describe, expect, it } from "vitest";
import { createWsSender, type WsSenderSocket } from "../../src/main/web/wsSender";

/**
 * Sending to a websocket client that reads slowly: tested against a socket whose behaviour the test
 * decides. How much a real socket takes before it pushes back is the operating system's business
 * (megabytes, on a machine with large TCP buffers), so nothing here depends on it.
 */

class FakeSocket implements WsSenderSocket {
  destroyed = false;
  writable = true;
  writableLength = 0;
  /** While false, a write is kept (it adds to writableLength) and the writer is told to wait. */
  takes = true;
  written: string[] = [];
  private waiting: Array<() => void> = [];
  write(frame: Buffer): boolean {
    this.written.push(frame.toString("utf8"));
    if (this.takes) return true;
    this.writableLength += frame.length;
    return false;
  }
  once(_event: "drain", listener: () => void): void {
    this.waiting.push(listener);
  }
  /** The client caught up: what the socket held is gone, and whoever waited is told. */
  drain(): void {
    this.takes = true;
    this.writableLength = 0;
    for (const listener of this.waiting.splice(0)) listener();
  }
}

function sender(limits = { highWaterBytes: 100, maxBufferedBytes: 300, maxQueuedResponseBytes: 600 }) {
  const socket = new FakeSocket();
  const counters = { backpressureEvents: 0, droppedStreamFrames: 0 };
  let reaped = 0;
  const made = createWsSender(socket, limits, counters, {
    encode: (text) => Buffer.from(text, "utf8"),
    // In these tests a message is output when it starts with "out".
    droppable: (text) => text.startsWith("out"),
    reap: () => {
      reaped++;
      socket.destroyed = true;
    },
  });
  return { socket, counters, send: made.send, clear: made.clear, queuedBytes: made.queuedBytes, reaped: () => reaped };
}

const bytes = (n: number, prefix: string): string => prefix + "x".repeat(n - prefix.length);

describe("sending to a websocket client", () => {
  it("writes at once while the socket takes it, and counts nothing", () => {
    const { socket, counters, send, queuedBytes } = sender();
    send("one");
    send("two", "response");
    expect(socket.written).toEqual(["one", "two"]);
    expect(counters).toEqual({ backpressureEvents: 0, droppedStreamFrames: 0 });
    expect(queuedBytes()).toBe(0);
  });

  it("queues behind a socket that pushes back, and sends the queue in order when it drains", () => {
    const { socket, counters, send, queuedBytes } = sender();
    socket.takes = false;
    send(bytes(50, "a"));
    // The socket took the frame and asked the writer to wait: that is counted once.
    expect(counters.backpressureEvents).toBe(1);
    send(bytes(50, "b"));
    send(bytes(50, "c"));
    expect(socket.written.map((w) => w[0])).toEqual(["a"]);
    expect(queuedBytes()).toBe(100);

    socket.drain();
    expect(socket.written.map((w) => w[0])).toEqual(["a", "b", "c"]);
    expect(queuedBytes()).toBe(0);
    // Waiting in the queue was not counted again for each frame.
    expect(counters.backpressureEvents).toBe(1);
  });

  it("drops output past the limit, counts it, and keeps the connection", () => {
    const { socket, counters, send, reaped, queuedBytes } = sender();
    socket.takes = false;
    send(bytes(90, "out"));
    send(bytes(90, "out"));
    send(bytes(90, "out"));
    expect(queuedBytes()).toBe(180);
    // 270 bytes wait. Another 90 would pass the 300 limit: it is dropped.
    send(bytes(90, "out"));
    send(bytes(90, "out"));
    expect(counters.droppedStreamFrames).toBe(2);
    expect(queuedBytes()).toBe(180);
    expect(reaped()).toBe(0);
    // What was kept still arrives, in order, once the client catches up.
    socket.drain();
    expect(socket.written).toHaveLength(3);
  });

  it("never drops an answer to a request while it fits under the second limit", () => {
    const { socket, counters, send, reaped } = sender();
    socket.takes = false;
    for (let i = 0; i < 3; i++) send(bytes(90, "out"));
    // Past the first limit: output would be dropped here, an answer is kept.
    send(bytes(200, "answer"), "response");
    expect(reaped()).toBe(0);
    expect(counters.droppedStreamFrames).toBe(0);
    socket.drain();
    expect(socket.written.at(-1)!.startsWith("answer")).toBe(true);
  });

  it("closes a client that is too far behind for a message that cannot be dropped", () => {
    const { socket, send, reaped } = sender();
    socket.takes = false;
    for (let i = 0; i < 3; i++) send(bytes(90, "out"));
    // A notice to the client (not output, not an answer) that does not fit: the client reconnects and asks again.
    send(bytes(90, "notice"));
    expect(reaped()).toBe(1);
    // Nothing more is written to a connection that is gone.
    const before = socket.written.length;
    send("late");
    expect(socket.written).toHaveLength(before);
  });

  it("closes the connection when even an answer is past the second limit", () => {
    const { socket, send, reaped } = sender();
    socket.takes = false;
    for (let i = 0; i < 3; i++) send(bytes(90, "out"));
    send(bytes(200, "answer"), "response");
    expect(reaped()).toBe(0);
    // 470 bytes wait: another 200 passes 600.
    send(bytes(200, "answer"), "response");
    expect(reaped()).toBe(1);
  });

  it("sends a single large message to a client that is not behind, whatever its size", () => {
    const { socket, counters, send, reaped } = sender();
    send(bytes(5000, "answer"), "response");
    send(bytes(5000, "notice"));
    expect(socket.written).toHaveLength(2);
    expect(reaped()).toBe(0);
    expect(counters.droppedStreamFrames).toBe(0);
  });

  it("forgets what waits when the connection has closed", () => {
    const { socket, send, clear, queuedBytes } = sender();
    socket.takes = false;
    send(bytes(50, "a"));
    send(bytes(50, "b"));
    expect(queuedBytes()).toBe(50);
    clear();
    expect(queuedBytes()).toBe(0);
    socket.drain();
    expect(socket.written).toHaveLength(1);
  });
});
