/**
 * A conversation, whole, for the window that shows it.
 *
 * Every snapshot carries every conversation, and every change anywhere sends a new snapshot. So a long
 * conversation travels in a snapshot by its last messages only (`task.messagesTail` says what the whole
 * of it is), and a change without its long parts (`change.partial`: its output, a file's diff). The
 * view that shows one conversation asks for all of it once (`task-read`), keeps its text current from
 * the stream of pieces as they arrive, and asks again only when the snapshot says the conversation
 * holds something this copy does not.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { AgentChange, AgentMessage, AgentMessagesTail, AgentTask, HubSnapshot, RunStatus } from "@shared/types/aiHub";
import type { AiHubDeltaEvent, MultiSSHApiWithHubDelta } from "@shared/ipc/createMultiSSHApi";
import { hubSessionActive, onHubSessionReset } from "./aiHubSession";
import { applyDeltaToMessages, STREAMED_MESSAGE_ID } from "./aiHubDelta";

/** The window's own way to the hub. Asked for when it is used: a view can be shown before it is there. */
const api = (): Partial<MultiSSHApiWithHubDelta> | undefined =>
  typeof window === "undefined" ? undefined : (window.multissh as Partial<MultiSSHApiWithHubDelta> | undefined);

/** The conversation whole, as the hub has it now. Reads only: the snapshot that comes back with it is not used. */
async function readTask(taskId: string): Promise<NonNullable<NonNullable<HubSnapshot["reply"]>["task"]> | undefined> {
  const request = api()?.aiHubRequest;
  if (!request) return undefined;
  const got = (await request({ action: "task-read", taskId })).reply?.task;
  return got?.id === taskId ? got : undefined;
}

interface Whole {
  messages: AgentMessage[];
  changes: Map<string, AgentChange>;
  /** Whether anything has been fetched yet. */
  loaded: boolean;
  /** A fetch is on its way. */
  loading: boolean;
  /** The snapshot moved on while it was: one more follows. */
  again: boolean;
}

const whole = new Map<string, Whole>();
const listeners = new Set<() => void>();
let version = 0;
let offDelta: (() => void) | undefined;

const publish = (): void => {
  version++;
  for (const listener of listeners) listener();
};

export function clearFullTaskCache(): void {
  whole.clear();
  publish();
}

onHubSessionReset(clearFullTaskCache);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // The pieces of a streamed answer are put into the whole copy as they are put into the snapshot's.
  offDelta ??= api()?.onAiHubDelta?.((delta: AiHubDeltaEvent) => {
    const entry = whole.get(delta.taskId);
    if (!entry?.loaded || delta.type !== "message.delta" || !delta.delta) return;
    const put = applyDeltaToMessages(entry.messages, delta);
    if (put.fit === "applied") {
      entry.messages = put.messages;
      publish();
    } else if (put.fit === "gap") void load(delta.taskId);
  });
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      offDelta?.();
      offDelta = undefined;
    }
  };
}

const RUNNING: ReadonlySet<RunStatus> = new Set<RunStatus>(["queued", "running", "waiting"]);

/** Whether the whole copy holds every message the snapshot says the conversation has. */
function messagesUpToDate(entry: Whole, tail: AgentMessagesTail, status: RunStatus): boolean {
  if (entry.messages.length !== tail.count) return false;
  const last = entry.messages.at(-1);
  if (!last) return tail.count === 0;
  // A message built here from the stream has an id of its own. It is as good as the hub's while the run
  // goes on; once the run has ended the conversation is fetched, so every message has its real id.
  if (last.id !== tail.lastId && !(last.id.startsWith(STREAMED_MESSAGE_ID) && RUNNING.has(status))) return false;
  if (entry.messages.some((m) => m.id.startsWith(STREAMED_MESSAGE_ID)) && !RUNNING.has(status)) return false;
  return last.text.length >= tail.lastChars;
}

/** Whether the whole copy has, as it now stands, every change the snapshot carries without its long parts. */
function changesUpToDate(entry: Whole, changes: AgentChange[]): boolean {
  return changes.every((c) => !c.partial || entry.changes.get(c.id)?.status === c.status);
}

/** Whether there is anything of this conversation the snapshot does not carry. */
const cut = (task: AgentTask): boolean => Boolean(task.messagesTail) || task.changes.some((c) => c.partial);

function upToDate(entry: Whole | undefined, task: AgentTask): boolean {
  if (!entry?.loaded) return false;
  return (!task.messagesTail || messagesUpToDate(entry, task.messagesTail, task.status)) && changesUpToDate(entry, task.changes);
}

async function load(taskId: string): Promise<boolean> {
  if (!hubSessionActive()) return false;
  const entry = whole.get(taskId) ?? { messages: [], changes: new Map<string, AgentChange>(), loaded: false, loading: false, again: false };
  if (entry.loading) {
    entry.again = true;
    return true;
  }
  entry.loading = true;
  whole.set(taskId, entry);
  try {
    const got = await readTask(taskId);
    if (whole.get(taskId) !== entry) return false;
    if (got) {
      entry.messages = got.messages;
      entry.changes = new Map(got.changes.map((c) => [c.id, c]));
      entry.loaded = true;
      publish();
    }
    return Boolean(got);
  } catch {
    // Gone, or the hub is away: the snapshot's own copy is shown, and the next change asks again.
    if (whole.get(taskId) === entry && !entry.loaded) whole.delete(taskId);
    return false;
  } finally {
    entry.loading = false;
    if (entry.again && whole.get(taskId) === entry) {
      entry.again = false;
      void load(taskId);
    }
  }
}

/** A change with the long parts the snapshot left out, where they have been fetched. */
function wholeChange(change: AgentChange, entry: Whole): AgentChange {
  if (!change.partial) return change;
  const fetched = entry.changes.get(change.id);
  if (!fetched || fetched.status !== change.status) return change;
  const { partial: _partial, ...rest } = change;
  return { ...rest, output: fetched.output, before: fetched.before, after: fetched.after, diff: fetched.diff, dryRunOutput: fetched.dryRunOutput, preflightSnapshot: fetched.preflightSnapshot };
}

/**
 * The conversation with all of its messages and its changes whole. A conversation the snapshot
 * already carries whole is returned as it is. Until a cut one has been fetched, what the snapshot
 * has of it is shown.
 */
export function useFullTask(task: AgentTask | undefined): AgentTask | undefined {
  useSyncExternalStore(subscribe, () => version);
  const wanted = task && cut(task) ? task : undefined;
  const entry = wanted ? whole.get(wanted.id) : undefined;
  const stale = Boolean(wanted && !upToDate(entry, wanted));
  const id = wanted?.id;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!id || !stale) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    void load(id).then((ok) => {
      if (mounted && !ok) timer = setTimeout(() => setAttempt((n) => n + 1), Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
    });
    return () => { mounted = false; clearTimeout(timer); };
  }, [id, stale, attempt]);
  if (!task || !wanted || !entry?.loaded) return task;
  return {
    ...task,
    ...(task.messagesTail && entry.messages.length > 0 ? { messages: entry.messages } : {}),
    changes: task.changes.map((c) => wholeChange(c, entry)),
  };
}

/** How many messages of a conversation a person wrote, whether or not the snapshot carries it whole. */
export function userMessageCount(task: AgentTask): number {
  return task.messagesTail?.users ?? task.messages.reduce((n, m) => n + (m.role === "user" ? 1 : 0), 0);
}
