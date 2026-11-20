import type { AgentTask } from "@shared/types/aiHub";

const NAME = { slack: "Slack", mattermost: "Mattermost" } as const;

/**
 * A small mark on a conversation that came from a direct message to the agent bot: it runs in this
 * person's own hub. Answers to what was written in chat go back there; what is written in the app stays
 * in the app. Nothing for any other conversation.
 */
export function ChatOriginBadge({ task }: { task: Pick<AgentTask, "chat"> }): JSX.Element | null {
  const chat = task.chat;
  if (!chat || chat.kind !== "dm") return null;
  const service = NAME[chat.service] ?? chat.service;
  return (
    <span
      className="ai-badge ai-badge-mode"
      data-testid="chat-origin-badge"
      title={`You asked for this in a direct message to the agent bot in ${service}. Answers to what you write there go back there. What you write here stays in sshs3.`}
      style={{ fontSize: 10, padding: "1px 6px", marginLeft: 4 }}
    >
      from {service}
    </span>
  );
}
