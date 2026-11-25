import type { AgentMessage } from "./types/aiHub";

/**
 * The words the hub's own messages start with, for a message stored before the hub marked its own
 * (`by`): its word that a plan was approved or sent back, and the line a resumed conversation starts
 * with (areas/conversations.ts, "resume").
 */
const HUB_WRITTEN = /^(?:\[sshs3\] |Resume on this terminal\.|Resume the conversation\.$|You have \d+ more commands and \d+ more minutes\. Continue where you stopped\.)/;

/**
 * A user message the hub wrote itself, not the person. Told by the mark the hub puts on its own;
 * only a message stored before that mark existed is told by its words. A person who types the hub's
 * words is still the person. Shared, so the chat shows such a message as the hub's, too.
 */
export const hubWrote = (message: Pick<AgentMessage, "role" | "text" | "by">): boolean =>
  message.role === "user" && (message.by ? message.by === "hub" : HUB_WRITTEN.test(message.text));
