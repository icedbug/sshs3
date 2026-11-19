/**
 * A piece of a streamed answer, put where it belongs in a copy of the conversation. On its own (no
 * state, nothing of the window) so that both the snapshot's copy and a fetched whole copy use it.
 */
import type { AgentMessage } from "@shared/types/aiHub";
import type { AiHubDeltaEvent } from "@shared/ipc/createMultiSSHApi";

/** Fallback for older senders that omit the persisted message ID. */
export const STREAMED_MESSAGE_ID = "delta-";

/**
 * A piece of streamed text put into a conversation's messages.
 *
 * The piece says how long the message is once it is added (`delta.length`), so it is added only where
 * this copy ends exactly before it: `have` when the copy already holds it (the snapshot was newer than
 * the piece), `gap` when pieces before it are missing here (the caller then fetches the conversation).
 * `lastChars` is the last message's whole length where `messages` holds only the end of its text (the
 * tail a snapshot carries of a long conversation). A piece without a length is added as it comes.
 */
export function applyDeltaToMessages(
  messages: AgentMessage[],
  delta: AiHubDeltaEvent,
  lastChars?: number,
): { messages: AgentMessage[]; fit: "applied" | "have" | "gap"; added: boolean } {
  const piece = delta.delta ?? "";
  const last = messages.at(-1);
  const continues = Boolean(last && last.role === "assistant");
  if (delta.messageId && last?.id !== delta.messageId) {
    if (messages.some((m) => m.id === delta.messageId)) return { messages, fit: "have", added: false };
    // A new reply follows a user's turn. Fetch that turn if this copy still ends at a different reply.
    if (continues) return { messages, fit: "gap", added: false };
  }
  if (delta.length !== undefined) {
    const have = continues ? (lastChars ?? last!.text.length) : 0;
    const before = delta.length - piece.length;
    // A message the hub has cut to its limit no longer grows there: nothing to add, nothing missing.
    if (have >= delta.length) return { messages, fit: "have", added: false };
    if (have !== before) return { messages, fit: "gap", added: false };
  }
  const next = [...messages];
  if (continues) {
    next[next.length - 1] = { ...last!, text: `${last!.text}${piece}`.slice(-128_000) };
    return { messages: next, fit: "applied", added: false };
  }
  next.push({
    id: delta.messageId ?? `${STREAMED_MESSAGE_ID}${delta.taskId}-${delta.at}-${next.length}`,
    role: "assistant",
    text: piece.slice(-128_000),
    at: delta.at,
  });
  return { messages: next, fit: "applied", added: true };
}
