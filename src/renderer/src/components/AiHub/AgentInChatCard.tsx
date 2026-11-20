import { useEffect, useRef, useState } from "react";
import type {
  AgentBotView,
  ChatAnsweringLimits,
  ChatAnsweringSnapshot,
  ChatChannelRule,
  ChatDmRule,
  ChatLineStatus,
  ChatReach,
  ChatRunItem,
  ChatServiceName,
  ChatTaskView,
  ChatTryResult,
  ChatWaitingItem,
  CommandRiskLevel,
  HubSnapshot,
  RunStatus,
} from "@shared/types/aiHub";
import { RISK_LEVEL_TEXT } from "@shared/types/aiHub";
import { copyToClipboard } from "../../lib/clipboard";
import { ConfirmButton } from "./ConfirmButton";
import { RichMarkdownContent } from "./RichMarkdownContent";
import type { Act } from "./panelShared";

const NAME: Record<ChatServiceName, string> = { slack: "Slack", mattermost: "Mattermost" };
const SERVICES: ChatServiceName[] = ["slack", "mattermost"];

const REACH: Record<ChatReach, string> = { read: "Read only", ask: "Ask before changes", plan: "Plan first" };
const REACH_HINT: Record<ChatReach, string> = {
  read: "Only commands that look. Anything that changes something is refused.",
  ask: "Each change waits until a person who may approve it says yes.",
  plan: "The agent writes a plan first. Nothing runs until the plan is approved.",
};

/** The scopes the agent bot's Slack app needs, and no more: it never reads a channel's history. */
export const AGENT_BOT_SLACK_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "im:history",
  "im:read",
  "im:write",
  "channels:read",
  "groups:read",
  "users:read",
] as const;

/** A Slack app manifest for the agent bot: Socket Mode, mentions and direct messages, buttons. */
export const AGENT_BOT_SLACK_MANIFEST = JSON.stringify(
  {
    display_information: { name: "sshs3 agent", description: "Answers questions about your servers. Changes wait for a person." },
    features: {
      app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: "sshs3 agent", always_online: true },
    },
    oauth_config: { scopes: { bot: [...AGENT_BOT_SLACK_SCOPES] } },
    settings: {
      event_subscriptions: { bot_events: ["app_mention", "message.im"] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  },
  null,
  2,
);

/**
 * Slack writes *bold* and <url|label>; the page shows Markdown. Mattermost already writes Markdown.
 * Only for showing what the bot posted in "try it", so it reads as it would in the chat.
 */
export function chatTextAsMarkdown(service: ChatServiceName, text: string): string {
  if (service !== "slack") return text;
  return text
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,:;!?])/gm, "$1**$2**")
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<(https?:\/\/[^|>\s]+)>/g, "$1");
}

const when = (at: number): string => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const clock = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const splitNames = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Prose as a sentence: what the model wrote often ends without a period. */
const sentence = (text: string): string => {
  const t = text.trim();
  return !t || /[.!?…:]$/.test(t) ? t : `${t}.`;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A month as the usage stores it ("2026-11"), as people say it ("November 2026"). */
export function monthText(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month.trim());
  const name = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && name ? `${name} ${m[1]}` : month;
}

/** How far a change goes, in the same words in the waiting list, the Inbox, a conversation and the chat card. */
export function riskText(risk: string | undefined): string {
  if (!risk) return "";
  return RISK_LEVEL_TEXT[risk as CommandRiskLevel] ?? `Risk: ${risk}.`;
}

/** "No approvals yet. 1 needed." or "1 of 2 approvals." The number stays on the line of its word. */
export function approvalsText(approved: number, required: number): string {
  const need = Math.max(1, required, approved);
  return approved === 0 ? `No approvals yet. ${need}\u00a0needed.` : `${approved} of ${need}\u00a0${need === 1 ? "approval" : "approvals"}.`;
}

const RUN_STATUS: Record<RunStatus, string> = {
  queued: "Starting",
  running: "Working on it",
  waiting: "Waiting",
  completed: "Done",
  failed: "Stopped with an error",
  cancelled: "Stopped",
  interrupted: "Stopped when the server restarted",
};
const runStatusText = (status: RunStatus): string => RUN_STATUS[status] ?? status;

const CHANGE_STATUS: Record<string, string> = {
  pending: "Waiting for an answer",
  approved: "Approved",
  denied: "Denied",
  running: "Running",
  completed: "Done",
  failed: "Failed",
  uncertain: "Not sure it worked",
};
const PLAN_STATUS: Record<string, string> = { proposed: "Waiting for an answer", approved: "Approved", rejected: "Denied" };

function statusText(status: ChatLineStatus | undefined, bot: AgentBotView): string {
  if (!bot.enabled) return "Switched off";
  switch (status?.state) {
    case "open":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "waiting":
      return `Waiting to try again${status.retryAt ? ` at ${clock(status.retryAt)}` : ""}${status.error ? `: ${status.error}` : ""}`;
    case "stopped":
      return `Stopped${status.error ? `: ${status.error}` : ""}`;
    default:
      return bot.lastError ? `Not connected: ${bot.lastError}` : "Not running";
  }
}

/** The same state after a "·" in a fold's title, small as "not connected" is there. */
const statusTitle = (status: ChatLineStatus | undefined, bot: AgentBotView): string => {
  const text = statusText(status, bot);
  return text.charAt(0).toLowerCase() + text.slice(1);
};

/**
 * Says where the last failed request of this card went wrong, close to what was pressed. Only the part
 * whose request failed last shows it, with the reason that request gave (AgentInChatCard's failedPart).
 */
function Failed({ shown, error }: { shown: boolean; error?: string }): JSX.Element | null {
  if (!shown) return null;
  return (
    <p role="alert" className="ai-error" data-testid="agent-chat-failed">
      {error || "It did not work. The reason is shown at the top of the settings."}
    </p>
  );
}

// ---- connecting the agent bot ---------------------------------------------------------------------------

function Connect({
  service,
  bot,
  status,
  act,
  error,
  failed,
}: {
  service: ChatServiceName;
  bot?: AgentBotView;
  status?: ChatLineStatus;
  act: Act;
  error?: string;
  failed: boolean;
}): JSX.Element {
  const [token, setToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [baseUrl, setBaseUrl] = useState(bot?.baseUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const connect = async (): Promise<void> => {
    setBusy(true);
    setSaid([]);
    const next = await act({
      action: "chat-answering-connect",
      input: {
        service,
        ...(token.trim() ? { token: token.trim() } : {}),
        ...(service === "slack" && appToken.trim() ? { appToken: appToken.trim() } : {}),
        ...(service === "mattermost" ? { baseUrl: baseUrl.trim() } : {}),
        enabled: true,
      },
    });
    setBusy(false);
    // A token is never kept in the page once it was sent, whether or not it was taken.
    setToken("");
    setAppToken("");
    const done = next?.reply?.chatAgentConnect;
    if (!done) return;
    setSaid([`Connected as ${done.bot}${done.team ? ` in ${done.team}` : ""}.`, ...done.notes]);
  };

  const identity = bot?.identity;
  const ready = service === "slack" ? Boolean((token.trim() || bot?.hasToken) && (appToken.trim() || bot?.hasAppToken)) : Boolean(baseUrl.trim() && (token.trim() || bot?.hasToken));
  return (
    <details className="ai-fold ai-set-fold" data-testid={`agent-bot-${service}`} open={Boolean(bot)}>
      <summary>
        {NAME[service]}
        {bot ? ` · ${statusTitle(status, bot)}` : " · not connected"}
      </summary>
      <div className="ai-form">
        {bot && (
          <p className="ai-hint" data-testid={`agent-bot-${service}-status`}>
            {identity ? `The agent bot is ${identity.name || identity.username || identity.userId}${identity.team ? ` in ${identity.team}` : ""}. ` : ""}
            {statusText(status, bot)}.
            {bot.savedAt ? ` Saved ${when(bot.savedAt)}.` : ""}
          </p>
        )}
        {service === "slack" ? (
          <>
            <small>
              Make a new Slack app from the manifest below, install it to the workspace, and copy its bot token (xoxb-). Then,
              under Basic Information, make an app-level token with the scope connections:write (xapp-). Invite the bot to the
              channels it should answer in. It needs these scopes and no others: {AGENT_BOT_SLACK_SCOPES.join(", ")}. It never
              reads a channel&apos;s history: it sees a message only when someone names it, or writes to it directly.
            </small>
            <details className="ai-fold" data-testid="agent-bot-manifest">
              <summary>The Slack app manifest</summary>
              {/* Unwrapped, so its lines keep their indent: on a phone the box scrolls sideways inside the card. */}
              <pre className="ai-mono" style={{ whiteSpace: "pre", overflowWrap: "normal", maxWidth: "100%", maxHeight: 220, overflow: "auto" }}>
                {AGENT_BOT_SLACK_MANIFEST}
              </pre>
              <button
                type="button"
                onClick={() =>
                  void copyToClipboard(AGENT_BOT_SLACK_MANIFEST).then((ok) => {
                    setCopied(ok);
                    if (ok) setTimeout(() => setCopied(false), 1800);
                  })
                }
              >
                {copied ? "Copied" : "Copy the manifest"}
              </button>
            </details>
          </>
        ) : (
          <>
            <small>
              Make a bot account in Mattermost (System Console, Integrations, Bot Accounts), give it an access token, and add
              it to the team and to the channels it should answer in.
            </small>
            <label>
              Address of the Mattermost server
              <input type="url" value={baseUrl} placeholder="https://chat.example.com" onChange={(e) => setBaseUrl(e.target.value)} />
            </label>
          </>
        )}
        <label>
          {service === "slack" ? "Bot token of the agent bot's app" : "Access token of the agent bot's account"}
          <input
            type="password"
            value={token}
            autoComplete="new-password"
            placeholder={bot?.hasToken ? "Set. Leave empty to keep it." : service === "slack" ? "xoxb-…" : ""}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        {service === "slack" && (
          <label>
            App-level token
            <input
              type="password"
              value={appToken}
              autoComplete="new-password"
              placeholder={bot?.hasAppToken ? "Set. Leave empty to keep it." : "xapp-…"}
              onChange={(e) => setAppToken(e.target.value)}
            />
          </label>
        )}
        <small>
          This is a separate {service === "slack" ? "Slack app" : "bot account"} from the context bot, with tokens of its own.
          The context bot&apos;s token is refused here, so the context bot stays one that only reads. Tokens are kept encrypted
          on this server and never shown again.
        </small>
        <div className="ai-card-actions">
          <button type="button" className="ai-btn-accent" disabled={busy || !ready} onClick={() => void connect()}>
            {busy ? "Connecting…" : bot ? "Save and connect again" : "Connect"}
          </button>
          {bot && (
            <ConfirmButton
              label="Disconnect"
              confirmLabel={`Disconnect the agent bot from ${NAME[service]}?`}
              onConfirm={() => void act({ action: "chat-answering-disconnect", service })}
            />
          )}
        </div>
        {said.length > 0 && (
          <p role="status" className="ai-hint" data-testid={`agent-bot-${service}-said`}>
            {said.join(" ")}
          </p>
        )}
        <Failed shown={failed} error={error} />
      </div>
    </details>
  );
}

// ---- channels ----------------------------------------------------------------------------------------------

interface RowDraft {
  key: string;
  service: ChatServiceName;
  channelId: string;
  channelName: string;
  allServers: boolean;
  servers: string;
  clusters: string;
  reach: ChatReach;
  agentId: string;
  approvers: "linked" | "admins";
  historyFrom: string[];
}

const draftOf = (service: ChatServiceName, rule: ChatChannelRule): RowDraft => ({
  key: `${service}:${rule.channelId}`,
  service,
  channelId: rule.channelId,
  channelName: rule.channelName,
  allServers: rule.servers === "*",
  servers: rule.servers === "*" ? "" : rule.servers.join(", "),
  clusters: rule.clusters.join(", "),
  reach: rule.reach,
  agentId: rule.agentId ?? "",
  approvers: rule.approvers,
  historyFrom: [...rule.historyFrom],
});

const ruleOf = (row: RowDraft): Partial<ChatChannelRule> => ({
  channelId: row.channelId.trim(),
  channelName: row.channelName.trim().replace(/^#/, ""),
  servers: row.allServers ? "*" : splitNames(row.servers),
  clusters: splitNames(row.clusters),
  reach: row.reach,
  ...(row.agentId ? { agentId: row.agentId } : {}),
  approvers: row.approvers,
  // Empty: only this channel. Once another is chosen, this one is in the list too (added when it was chosen).
  historyFrom: row.historyFrom.length === 1 && row.historyFrom[0] === row.channelId.trim() ? [] : row.historyFrom,
});

function Channels({
  hub,
  agents,
  channels,
  act,
  error,
  failed,
  saved,
  setSaved,
}: {
  hub: HubSnapshot;
  /** The chat agent's own agents: its hub runs a channel's conversation, so only these can be chosen. */
  agents: Array<{ id: string; name: string }>;
  channels: Record<ChatServiceName, ChatChannelRule[]>;
  act: Act;
  error?: string;
  failed: boolean;
  saved: boolean;
  setSaved: (saved: boolean) => void;
}): JSX.Element {
  const [rows, setRows] = useState<RowDraft[]>(() => SERVICES.flatMap((s) => (channels[s] ?? []).map((r) => draftOf(s, r))));
  const [adding, setAdding] = useState<{ service: ChatServiceName; channelId: string; channelName: string }>({ service: "slack", channelId: "", channelName: "" });
  const read = (service: ChatServiceName) => hub.chatSources?.connections.find((c) => c.service === service)?.channels.filter((c) => c.selected) ?? [];
  const change = (key: string, patch: Partial<RowDraft>): void => {
    setSaved(false);
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };
  const save = async (list: RowDraft[]): Promise<void> => {
    setSaved(false);
    const next = await act({
      action: "chat-answering-save",
      input: { channels: { slack: list.filter((r) => r.service === "slack").map(ruleOf), mattermost: list.filter((r) => r.service === "mattermost").map(ruleOf) } },
    });
    if (next) setSaved(true);
  };
  const add = (): void => {
    const channelId = adding.channelId.trim();
    if (!channelId) return;
    const row: RowDraft = {
      key: `${adding.service}:${channelId}:${Date.now()}`,
      service: adding.service,
      channelId,
      channelName: adding.channelName.trim().replace(/^#/, "") || channelId,
      allServers: false,
      servers: "",
      clusters: "",
      reach: "read",
      agentId: "",
      approvers: "linked",
      historyFrom: [],
    };
    setRows((list) => [...list, row]);
    setSaved(false);
    setAdding({ ...adding, channelId: "", channelName: "" });
  };

  return (
    <div data-testid="agent-chat-channels">
      <small>
        The agent bot answers in a channel only when someone names it there, and only in the channels listed here. Each row is
        what a conversation started in that channel may reach. A row with no servers and no clusters reaches nothing.
      </small>
      {rows.length === 0 && <p className="ai-empty">No channel yet. The agent bot answers in no channel.</p>}
      {rows.map((row) => {
        const others = read(row.service).filter((c) => c.id !== row.channelId);
        const label = `#${row.channelName || row.channelId}`;
        return (
          // A fieldset is as wide as its widest content unless told otherwise: ai-chat-rule keeps it to the card.
          // Its title is inside the box, not a legend: a long channel id would wrap onto the border.
          <fieldset key={row.key} className="ai-form ai-chat-rule" aria-label={`${label} in ${NAME[row.service]}`} data-testid={`agent-chat-row-${row.channelId}`}>
            <div className="ai-chat-rule-head">
              <strong>
                {label} in {NAME[row.service]}
              </strong>
              <small className="ai-mono">{row.channelId}</small>
            </div>
            <label className="ai-check">
              <input type="checkbox" aria-label={`All servers for ${label}`} checked={row.allServers} onChange={(e) => change(row.key, { allServers: e.target.checked })} />
              <span>All servers of the chat agent</span>
            </label>
            {!row.allServers && (
              <label>
                Servers (names, ids or hosts, separated by commas)
                <input aria-label={`Servers for ${label}`} value={row.servers} placeholder="web-1, db-1" onChange={(e) => change(row.key, { servers: e.target.value })} />
              </label>
            )}
            <label>
              Clusters (every server in them)
              <input aria-label={`Clusters for ${label}`} value={row.clusters} placeholder="staging" onChange={(e) => change(row.key, { clusters: e.target.value })} />
            </label>
            <label>
              What it may do
              <select aria-label={`Reach for ${label}`} value={row.reach} onChange={(e) => change(row.key, { reach: e.target.value as ChatReach })}>
                {(Object.keys(REACH) as ChatReach[]).map((r) => (
                  <option key={r} value={r}>
                    {REACH[r]}
                  </option>
                ))}
              </select>
              <small>{REACH_HINT[row.reach]}</small>
            </label>
            <label>
              Agent
              <select aria-label={`Agent for ${label}`} value={row.agentId} onChange={(e) => change(row.key, { agentId: e.target.value })}>
                <option value="">The chat agent&apos;s default agent</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
                {row.agentId && !agents.some((a) => a.id === row.agentId) && <option value={row.agentId}>{row.agentId} (not one the chat agent has)</option>}
              </select>
              <small>The chat agent&apos;s own agents. Yours are not here: a conversation from a channel runs in the chat agent&apos;s account.</small>
            </label>
            <label>
              Who may approve
              <select aria-label={`Who may approve in ${label}`} value={row.approvers} onChange={(e) => change(row.key, { approvers: e.target.value as RowDraft["approvers"] })}>
                <option value="linked">Anyone who may approve it</option>
                <option value="admins">Administrators only</option>
              </select>
              <small>In chat, only people who linked their chat account can answer. Each person can approve only what their own account may approve.</small>
            </label>
            <div>
              <small>What the team wrote that the agent may search (the context bot&apos;s channels). Nothing chosen: only this channel.</small>
              {others.length === 0 ? (
                <small> The context bot reads no other channel in {NAME[row.service]}.</small>
              ) : (
                <div className="ai-switches">
                  {others.map((c) => (
                    <label key={c.id} className="ai-check">
                      <input
                        type="checkbox"
                        aria-label={`${label} may search #${c.name}`}
                        checked={row.historyFrom.includes(c.id)}
                        onChange={(e) =>
                          change(row.key, {
                            historyFrom: e.target.checked
                              ? [...row.historyFrom.filter((id) => id !== c.id), ...(row.historyFrom.length === 0 ? [row.channelId] : []), c.id]
                              : row.historyFrom.filter((id) => id !== c.id),
                          })
                        }
                      />
                      <span>#{c.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="ai-card-actions">
              <button
                type="button"
                className="ai-btn-danger"
                onClick={() => {
                  setSaved(false);
                  setRows((list) => list.filter((r) => r.key !== row.key));
                }}
              >
                Remove {label}
              </button>
            </div>
          </fieldset>
        );
      })}
      <div className="ai-inline-form">
        <select aria-label="Service of the new channel" value={adding.service} onChange={(e) => setAdding({ ...adding, service: e.target.value as ChatServiceName })}>
          {SERVICES.map((s) => (
            <option key={s} value={s}>
              {NAME[s]}
            </option>
          ))}
        </select>
        <input aria-label="Channel id" placeholder={adding.service === "slack" ? "Channel id, like C0123ABCD" : "Channel id"} value={adding.channelId} onChange={(e) => setAdding({ ...adding, channelId: e.target.value })} />
        <input aria-label="Channel name" placeholder="Channel name, like ops" value={adding.channelName} onChange={(e) => setAdding({ ...adding, channelName: e.target.value })} />
        <button type="button" disabled={!adding.channelId.trim()} onClick={add}>
          Add the channel
        </button>
      </div>
      <small>
        {adding.service === "slack"
          ? "In Slack, the channel id is at the bottom of the channel's details."
          : "In Mattermost, the channel id is under View Info in the channel's menu."}
      </small>
      <div className="ai-card-actions">
        <button type="button" className="ai-btn-accent" onClick={() => void save(rows)}>
          Save the channels
        </button>
        {saved && <small className="ai-ok">Saved.</small>}
      </div>
      <Failed shown={failed} error={error} />
    </div>
  );
}

// ---- direct messages ---------------------------------------------------------------------------------------

function DirectMessages({
  dms,
  act,
  error,
  failed,
  saved,
  setSaved,
}: {
  dms: ChatDmRule;
  act: Act;
  error?: string;
  failed: boolean;
  saved: boolean;
  setSaved: (saved: boolean) => void;
}): JSX.Element {
  const [enabled, setEnabled] = useState(dms.enabled);
  const [unlinked, setUnlinked] = useState(dms.unlinked);
  const [allServers, setAllServers] = useState(dms.servers === "*");
  const [servers, setServers] = useState(dms.servers === "*" ? "" : dms.servers.join(", "));
  const [clusters, setClusters] = useState(dms.clusters.join(", "));
  const save = async (): Promise<void> => {
    setSaved(false);
    const next = await act({
      action: "chat-answering-save",
      input: { dms: { enabled, unlinked, servers: allServers ? "*" : splitNames(servers), clusters: splitNames(clusters) } },
    });
    if (next) setSaved(true);
  };
  return (
    <div className="ai-form" data-testid="agent-chat-dms">
      <label className="ai-check">
        <input type="checkbox" aria-label="Answer direct messages" checked={enabled} onChange={(e) => { setSaved(false); setEnabled(e.target.checked); }} />
        <span>
          Answer direct messages
          <small>
            A person who linked their chat account is answered in their own sshs3 account, with their own servers and rules.
          </small>
        </span>
      </label>
      {enabled && (
        <>
          <label>
            People who did not link their chat account
            <select aria-label="Direct messages from people who did not link" value={unlinked} onChange={(e) => { setSaved(false); setUnlinked(e.target.value as ChatDmRule["unlinked"]); }}>
              <option value="read">Read only</option>
              <option value="off">Not answered</option>
            </select>
          </label>
          {unlinked === "read" && (
            <>
              <label className="ai-check">
                <input type="checkbox" aria-label="All servers for direct messages" checked={allServers} onChange={(e) => { setSaved(false); setAllServers(e.target.checked); }} />
                <span>All servers of the chat agent</span>
              </label>
              {!allServers && (
                <label>
                  Servers they may ask about
                  <input aria-label="Servers for direct messages" value={servers} placeholder="web-1, db-1" onChange={(e) => { setSaved(false); setServers(e.target.value); }} />
                </label>
              )}
              <label>
                Clusters they may ask about
                <input aria-label="Clusters for direct messages" value={clusters} onChange={(e) => { setSaved(false); setClusters(e.target.value); }} />
              </label>
            </>
          )}
        </>
      )}
      <div className="ai-card-actions">
        <button type="button" className="ai-btn-accent" onClick={() => void save()}>
          Save direct messages
        </button>
        {saved && <small className="ai-ok">Saved.</small>}
      </div>
      <Failed shown={failed} error={error} />
    </div>
  );
}

// ---- model, budget and limits ------------------------------------------------------------------------------

const LIMITS: { key: keyof ChatAnsweringLimits; label: string; max: number }[] = [
  { key: "personNewPerHour", label: "New conversations one person may start in an hour", max: 100 },
  { key: "personMessagesPerHour", label: "Messages one person may send in an hour", max: 500 },
  { key: "channelPerHour", label: "Messages one channel may send in an hour", max: 1000 },
  { key: "concurrentRuns", label: "Answers worked on at the same time", max: 16 },
];

function ModelAndLimits({
  admin,
  copyAct,
  saveAct,
  error,
  failed,
  saved,
  setSaved,
}: {
  admin: NonNullable<ChatAnsweringSnapshot["admin"]>;
  /** For "Copy my model" and for the save: each says on its own when it failed. */
  copyAct: Act;
  saveAct: Act;
  error?: string;
  failed: "" | "copy" | "save";
  saved: boolean;
  setSaved: (saved: boolean) => void;
}): JSX.Element {
  const s = admin.settings;
  const [wait, setWait] = useState(String(s.approvalWaitMinutes));
  const [budget, setBudget] = useState(String(s.monthlyTokenBudget));
  const [limits, setLimits] = useState<Record<keyof ChatAnsweringLimits, string>>(
    () => Object.fromEntries(LIMITS.map((l) => [l.key, String(s.limits[l.key])])) as Record<keyof ChatAnsweringLimits, string>,
  );
  const [said, setSaid] = useState("");
  const used = s.usage.tokens;
  const copy = async (): Promise<void> => {
    setSaid("");
    const next = await copyAct({ action: "chat-answering-copy-model" });
    if (next) setSaid(next.reply?.notes?.join(" ") || "The chat agent now uses the same model settings as you.");
  };
  const save = async (): Promise<void> => {
    setSaid("");
    setSaved(false);
    const next = await saveAct({
      action: "chat-answering-save",
      input: {
        approvalWaitMinutes: Number(wait),
        monthlyTokenBudget: Number(budget),
        limits: Object.fromEntries(LIMITS.map((l) => [l.key, Number(limits[l.key])])) as Partial<ChatAnsweringLimits>,
      },
    });
    if (next) setSaved(true);
  };
  return (
    <div className="ai-form" data-testid="agent-chat-model">
      {/* Spaced as the labels below are, so the button does not touch the text around it. */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
        <p className="ai-hint" data-testid="agent-chat-model-now">
          {admin.model.set ? `The chat agent uses ${admin.model.name || "a model"}.` : "The chat agent has no model yet."}
        </p>
        <small>
          The chat agent has a model of its own. It does not follow yours: copy yours to it, and copy again after you change
          yours. This copies your data policy too.
        </small>
        <div className="ai-card-actions">
          <button type="button" onClick={() => void copy()}>
            Copy my model
          </button>
        </div>
        {said && (
          <p role="status" className="ai-hint" data-testid="agent-chat-model-said">
            {said}
          </p>
        )}
        <Failed shown={failed === "copy"} error={error} />
      </div>
      <label>
        How long a change from chat waits for an answer (minutes)
        <input aria-label="Approval wait in minutes" type="number" min={1} max={1440} value={wait} onChange={(e) => { setSaved(false); setWait(e.target.value); }} />
        <small>After that it counts as denied, and the agent goes on without it. At most a day.</small>
      </label>
      <label>
        Tokens the chat answers may use in a month
        <input aria-label="Monthly token budget" type="number" min={10000} step={10000} value={budget} onChange={(e) => { setSaved(false); setBudget(e.target.value); }} />
        <small data-testid="agent-chat-usage">
          Used in {monthText(s.usage.month)}: {used.toLocaleString()} of {s.monthlyTokenBudget.toLocaleString()} tokens
          {used >= s.monthlyTokenBudget ? ". The budget is spent: the agent bot says so and starts nothing new until next month." : "."}
        </small>
      </label>
      {LIMITS.map((l) => (
        <label key={l.key}>
          {l.label}
          <input
            aria-label={l.label}
            type="number"
            min={1}
            max={l.max}
            value={limits[l.key]}
            onChange={(e) => { setSaved(false); setLimits({ ...limits, [l.key]: e.target.value }); }}
          />
        </label>
      ))}
      <div className="ai-card-actions">
        <button type="button" className="ai-btn-accent" onClick={() => void save()}>
          Save the wait, budget and limits
        </button>
      </div>
      {saved && (
        <p role="status" className="ai-ok" data-testid="agent-chat-model-saved">
          Saved.
        </p>
      )}
      <Failed shown={failed === "save"} error={error} />
    </div>
  );
}

// ---- the bot's SSH key -------------------------------------------------------------------------------------

function SshKey({ publicKey, act, error, failed }: { publicKey?: string; act: Act; error?: string; failed: boolean }): JSX.Element {
  const [fresh, setFresh] = useState("");
  const [copied, setCopied] = useState(false);
  const key = fresh || publicKey;
  return (
    <div className="ai-form" data-testid="agent-chat-key">
      <small>
        The chat agent signs in to servers with a key of its own. Add it only on the servers the agent bot may reach, in the
        user&apos;s authorized_keys file. Where it is not added, the agent bot cannot sign in.
      </small>
      {key ? (
        <>
          <pre className="ai-mono" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }} data-testid="agent-chat-public-key">
            {key}
          </pre>
          <div className="ai-card-actions">
            <button
              type="button"
              onClick={() =>
                void copyToClipboard(key).then((ok) => {
                  setCopied(ok);
                  if (ok) setTimeout(() => setCopied(false), 1800);
                })
              }
            >
              {copied ? "Copied" : "Copy the key"}
            </button>
            <ConfirmButton
              label="Make a new key"
              confirmLabel="Make a new key? The old one keeps working on servers until you remove it there."
              onConfirm={() =>
                void act({ action: "chat-answering-rotate-key" }).then((next) => {
                  const made = next?.reply?.chatAgentKey?.publicKey;
                  if (made) setFresh(made);
                })
              }
            />
          </div>
        </>
      ) : (
        <p className="ai-empty">The key is made when the agent bot is first connected.</p>
      )}
      <small>
        Nobody can answer a question to trust a server&apos;s host key for the chat agent. Connect to each such server once
        from sshs3 and trust its key there first. This was not tried with real servers.
      </small>
      <Failed shown={failed} error={error} />
    </div>
  );
}

// ---- conversations from chat ------------------------------------------------------------------------------

function Answer({
  taskId,
  id,
  kind,
  act,
  onDone,
}: {
  taskId: string;
  id: string;
  kind: "change" | "plan";
  act: Act;
  onDone: (message: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const answer = async (approved: boolean): Promise<void> => {
    setBusy(true);
    const next = await act({ action: "chat-answering-answer", taskId, id, kind, approved });
    setBusy(false);
    const done = next?.reply?.chatAnswer;
    if (done) onDone(done.message);
  };
  return (
    <span className="ai-card-actions">
      <button type="button" className="ai-btn-emerald" disabled={busy} onClick={() => void answer(true)}>
        Approve
      </button>
      <button type="button" className="ai-btn-danger" disabled={busy} onClick={() => void answer(false)}>
        Deny
      </button>
    </span>
  );
}

/**
 * What waits for this person's answer: anybody who may approve a change of the chat agent's sees it, in
 * this card and in the Inbox. An answer given here needs no linked chat account.
 */
export function ChatWaitingList({
  items,
  act,
  admin,
  error,
  failed,
}: {
  items: ChatWaitingItem[];
  act: Act;
  /** An administrator can read a whole plan under Conversations from chat before answering. */
  admin?: boolean;
  error?: string;
  failed?: boolean;
}): JSX.Element | null {
  const [said, setSaid] = useState("");
  if (items.length === 0 && !said) return null;
  return (
    <div data-testid="agent-chat-waiting">
      <strong>Waiting for your answer</strong>
      <ul className="ai-link-list">
        {items.map((item) => (
          // A column, so a long command wraps on a phone instead of pushing the buttons off the card.
          <li key={`${item.taskId}:${item.id}`} className="ai-link" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
            <span style={{ overflowWrap: "anywhere", minWidth: 0, maxWidth: "100%" }}>
              <strong>{item.kind === "plan" ? "A plan" : "A change"}</strong> asked by {item.askedBy} in{" "}
              {item.channelName ? `#${item.channelName}` : "a direct message"} ({NAME[item.service]}): {sentence(item.description)}
            </span>
            {item.command && (
              <pre className="ai-mono ai-chat-command" data-testid="agent-chat-waiting-command">
                {item.command}
              </pre>
            )}
            <small>
              {[item.target ? `On ${item.target}.` : "", riskText(item.risk), approvalsText(item.approvedBy.length, item.requiredApprovals)].filter(Boolean).join(" ")}
            </small>
            {item.kind === "plan" && (
              <small>
                {admin
                  ? "Read the whole plan under Conversations from chat before you answer."
                  : "The whole plan is in its thread in the chat."}
              </small>
            )}
            <Answer taskId={item.taskId} id={item.id} kind={item.kind} act={act} onDone={setSaid} />
          </li>
        ))}
      </ul>
      {said && (
        <p role="status" className="ai-hint">
          {said}
        </p>
      )}
      <Failed shown={Boolean(failed)} error={error} />
    </div>
  );
}

/** After an answer, the open conversation is read again this often while its agent still works, so the status matches. */
const FOLLOW_MS = 1000;
const FOLLOW_TRIES = 30;

type ReadEntry =
  | { at: number; message: ChatTaskView["messages"][number]; change?: undefined; plan?: undefined }
  | { at: number; change: ChatTaskView["changes"][number]; message?: undefined; plan?: undefined }
  | { at: number; plan: NonNullable<ChatTaskView["plan"]>; message?: undefined; change?: undefined };

/** A conversation in the order it happened: a change shows before the reply the agent gave after it ran. */
export function readOrder(view: ChatTaskView): ReadEntry[] {
  const entries: ReadEntry[] = [
    ...view.messages.map((message) => ({ at: message.at, message })),
    // A change kept from before changes had a time goes last, where it always was.
    ...view.changes.map((change) => ({ at: change.at ?? Number.POSITIVE_INFINITY, change })),
    ...(view.plan ? [{ at: view.plan.createdAt, plan: view.plan }] : []),
  ];
  // A stable sort: what has the same time keeps the order it was stored in.
  return entries.map((entry, i) => ({ entry, i })).sort((a, b) => a.entry.at - b.entry.at || a.i - b.i).map(({ entry }) => entry);
}

function ReadMessage({ m }: { m: ChatTaskView["messages"][number] }): JSX.Element {
  return (
    <div className="ai-chat-thread" data-testid={`agent-chat-message-${m.role}`}>
      <small>
        {m.role === "user" ? "Asked" : m.role === "assistant" ? "The agent" : "Note"} · {when(m.at)}
      </small>
      <blockquote>
        {m.role === "assistant" ? <RichMarkdownContent text={m.text} /> : <p style={{ whiteSpace: "pre-wrap" }}>{m.text}</p>}
      </blockquote>
      {m.told && (
        <details className="ai-fold" data-testid="agent-chat-told">
          <summary>What the agent was told</summary>
          <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{m.told}</p>
        </details>
      )}
    </div>
  );
}

/** How many approved a change, in the words of the waiting list: said while it waits, and once someone approved. */
function changeApprovals(c: ChatTaskView["changes"][number]): string {
  const approved = (c.approvals ?? []).filter((a) => a.allowed).length || (c.decidedBy?.allowed ? 1 : 0);
  if (c.status !== "pending" && approved === 0) return "";
  return approvalsText(approved, c.requiredApprovals ?? 1);
}

function ReadChange({ c, taskId, act, onDone }: { c: ChatTaskView["changes"][number]; taskId: string; act: Act; onDone: (message: string) => void }): JSX.Element {
  return (
    <div className="ai-chat-thread" data-testid={`agent-chat-change-${c.id}`}>
      <small>
        Change on {c.target}. {CHANGE_STATUS[c.status] ?? c.status}.
      </small>
      <p>{sentence(c.description)}</p>
      {c.command && <pre className="ai-mono ai-chat-command">{c.command}</pre>}
      <small data-testid="agent-chat-change-line">{[riskText(c.riskLevel), changeApprovals(c)].filter(Boolean).join(" ")}</small>
      {c.status === "pending" && <Answer taskId={taskId} id={c.id} kind="change" act={act} onDone={onDone} />}
    </div>
  );
}

function ReadPlan({ plan, taskId, act, onDone }: { plan: NonNullable<ChatTaskView["plan"]>; taskId: string; act: Act; onDone: (message: string) => void }): JSX.Element {
  return (
    <div className="ai-chat-thread" data-testid="agent-chat-plan">
      <small>Plan. {PLAN_STATUS[plan.status] ?? plan.status}.</small>
      <p>{sentence(plan.goal)}</p>
      <ol>
        {plan.steps.map((step, i) => (
          <li key={i}>
            {sentence(step.action)}
            {step.command && <pre className="ai-mono ai-chat-command">{step.command}</pre>}
          </li>
        ))}
      </ol>
      {plan.status === "proposed" && <Answer taskId={taskId} id={plan.id} kind="plan" act={act} onDone={onDone} />}
    </div>
  );
}

function Conversations({ act, error, failed }: { act: Act; error?: string; failed: boolean }): JSX.Element {
  const [runs, setRuns] = useState<ChatRunItem[] | undefined>();
  const [open, setOpen] = useState<ChatTaskView | undefined>();
  const [said, setSaid] = useState("");
  // Each read the person starts, and each answer, starts a new follow: an older one stops.
  const follow = useRef(0);
  useEffect(
    () => () => {
      follow.current += 1;
    },
    [],
  );
  const load = async (): Promise<void> => {
    const next = await act({ action: "chat-answering-runs" });
    if (next?.reply?.chatRuns) setRuns(next.reply.chatRuns);
  };
  const read = async (taskId: string): Promise<ChatTaskView | undefined> => {
    const got = (await act({ action: "chat-answering-task", taskId }))?.reply?.chatTask;
    if (got) setOpen(got);
    return got;
  };
  const show = async (taskId: string): Promise<void> => {
    follow.current += 1;
    setSaid("");
    await read(taskId);
  };
  const answered = (message: string): void => {
    setSaid(message);
    if (!open) return;
    const mine = ++follow.current;
    const taskId = open.taskId;
    // Read again at once, and again while the agent goes on after the answer, until it waits or ends.
    void (async () => {
      for (let i = 0; i < FOLLOW_TRIES; i++) {
        const view = await read(taskId);
        if (follow.current !== mine || !view || (view.status !== "queued" && view.status !== "running")) return;
        await new Promise((resolve) => setTimeout(resolve, FOLLOW_MS));
        if (follow.current !== mine) return;
      }
    })();
  };
  return (
    <div data-testid="agent-chat-runs">
      <small>The conversations the agent bot had in chat, to read. A change or plan that waits can be answered here too.</small>
      <div className="ai-card-actions">
        <button type="button" onClick={() => void load()}>
          {runs ? "Show them again" : "Show the conversations"}
        </button>
      </div>
      {runs && runs.length === 0 && <p className="ai-empty">No conversation from chat yet.</p>}
      {runs && runs.length > 0 && (
        <ul className="ai-link-list">
          {runs.map((r) => (
            <li key={r.taskId} className="ai-link" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
              <button
                type="button"
                aria-label={`Open ${r.title}`}
                style={{ whiteSpace: "normal", textAlign: "left", overflowWrap: "anywhere", maxWidth: "100%" }}
                onClick={() => void show(r.taskId)}
              >
                {r.title}
              </button>
              <small data-testid="agent-chat-run-line">
                {r.kind === "dm" ? "Direct message" : `#${r.channelName}`} in {NAME[r.service]} · asked by {r.askedBy} · {REACH[r.reach]} ·{" "}
                {r.waiting ? `Waiting for ${r.waiting} ${r.waiting === 1 ? "answer" : "answers"}` : runStatusText(r.status)}
                {r.tokens ? ` · ${r.tokens.toLocaleString()} tokens` : ""} · {when(r.updatedAt)}
              </small>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className="ai-form" data-testid="agent-chat-task">
          <strong>{open.title}</strong>
          <small data-testid="agent-chat-task-status">
            {open.chat.kind === "dm" ? "Direct message" : `#${open.chat.channelName}`} in {NAME[open.chat.service]}, asked by{" "}
            {open.chat.askedBy.name}. {REACH[open.chat.fence.reach]}. Status: {runStatusText(open.status)}.
          </small>
          {readOrder(open).map((entry) =>
            entry.message ? (
              <ReadMessage key={`m:${entry.message.id}`} m={entry.message} />
            ) : entry.change ? (
              <ReadChange key={`c:${entry.change.id}`} c={entry.change} taskId={open.taskId} act={act} onDone={answered} />
            ) : (
              <ReadPlan key="plan" plan={entry.plan} taskId={open.taskId} act={act} onDone={answered} />
            ),
          )}
          {said && (
            <p role="status" className="ai-hint" data-testid="agent-chat-answered">
              {said}
            </p>
          )}
          <div className="ai-card-actions">
            <button type="button" onClick={() => void show(open.taskId)}>
              Read it again
            </button>
          </div>
        </div>
      )}
      <Failed shown={failed} error={error} />
    </div>
  );
}

// ---- try it ------------------------------------------------------------------------------------------------

/** In "try it", a direct message from the administrator runs in their own account, as a linked person's does. */
const inOwnAccount = (channel: string, as: "me" | "guest"): boolean => channel === "dm" && as === "me";

function TryIt({
  channels,
  act,
  error,
  failed,
  modelSet,
  mattermostAnswers,
}: {
  channels: Record<ChatServiceName, ChatChannelRule[]>;
  act: Act;
  error?: string;
  failed: boolean;
  /** Whether the chat agent has a model: without one nothing it runs can answer. */
  modelSet: boolean;
  /** How a card is answered in a real Mattermost: with buttons, or with reactions. */
  mattermostAnswers: "buttons" | "reactions";
}): JSX.Element {
  const rows = SERVICES.flatMap((s) => (channels[s] ?? []).map((r) => ({ service: s, rule: r })));
  const [channel, setChannel] = useState(rows[0]?.rule.channelId ?? "dm");
  const [as, setAs] = useState<"me" | "guest">("me");
  const [text, setText] = useState("");
  const [result, setResult] = useState<(ChatTryResult & { service: ChatServiceName; ownAccount: boolean; sent: string; as: "me" | "guest" }) | undefined>();
  const [goOn, setGoOn] = useState(false);
  const [busy, setBusy] = useState(false);
  // A direct message is tried in Slack's form; a channel in the form of the service it is listed for.
  const chosen = rows.find((r) => r.rule.channelId === channel);
  const triedIn: ChatServiceName = chosen?.service ?? "slack";
  // Only a thread of the channel chosen now can be gone on with: never one of another channel.
  const sameThread = Boolean(result && channel !== "dm" && result.channelId === channel);
  const own = inOwnAccount(channel, as);
  const send = async (): Promise<void> => {
    const sent = text.trim();
    if (!sent) return;
    setBusy(true);
    const thread = goOn && sameThread && result ? result.thread : undefined;
    const next = await act({ action: "chat-answering-try", channel, as, text: sent, ...(thread ? { thread } : {}) });
    setBusy(false);
    const got = next?.reply?.chatTry;
    if (got) {
      setResult({ ...got, service: triedIn, ownAccount: own, sent, as });
      setText("");
    }
  };
  return (
    // One column that may be narrower than a long channel name, so the form fits a phone.
    <div className="ai-form" data-testid="agent-chat-try" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      <p className="ai-hint" data-testid="agent-chat-try-simulated">
        This is a simulated chat in this server. Nothing goes to Slack or Mattermost. The agent bot answers with your rules
        above.{" "}
        {own
          ? "A direct message from you runs in your own account, with your own model and servers. A change it asks for waits in that conversation, in your list."
          : "The agent itself really runs, with the chat agent's model and servers."}
      </p>
      {!own && !modelSet && (
        <p className="ai-hint" data-testid="agent-chat-try-no-model">
          The chat agent has no model yet, so nothing answers here. Press Copy my model first, under Model, budget and limits.
        </p>
      )}
      <label>
        Where
        <select
          aria-label="Channel to try"
          value={channel}
          onChange={(e) => {
            setChannel(e.target.value);
            setGoOn(false);
          }}
        >
          {/* Short labels, so a phone shows them whole: what the channel may do is said under it. */}
          {rows.map(({ service, rule }) => (
            <option key={`${service}:${rule.channelId}`} value={rule.channelId}>
              #{rule.channelName}, {NAME[service]}
            </option>
          ))}
          <option value="dm">A direct message</option>
        </select>
        {chosen && <small data-testid="agent-chat-try-reach">There: {REACH[chosen.rule.reach]}.</small>}
      </label>
      <label>
        Who writes
        <select aria-label="Who writes" value={as} onChange={(e) => setAs(e.target.value as "me" | "guest")}>
          <option value="me">You, as if linked</option>
          <option value="guest">Someone not linked</option>
        </select>
        <small>
          {as === "me"
            ? "As you, as if your chat account were linked. This does not link it: that is under Your chat account."
            : "As someone who did not link their chat account."}
        </small>
      </label>
      <label>
        Message to the agent bot
        <textarea aria-label="Message to the agent bot" rows={3} value={text} placeholder="How full is the disk on web-1?" onChange={(e) => setText(e.target.value)} />
      </label>
      {sameThread && (
        <label className="ai-check">
          <input type="checkbox" checked={goOn} onChange={(e) => setGoOn(e.target.checked)} />
          <span>Write in the same thread</span>
        </label>
      )}
      <div className="ai-card-actions">
        <button type="button" className="ai-btn-accent" disabled={busy || !text.trim()} onClick={() => void send()}>
          {busy ? "Waiting for the bot…" : "Send"}
        </button>
      </div>
      {result && (
        <div className="ai-chat-try-result" data-testid="agent-chat-try-result">
          <div className="ai-chat-thread ai-chat-sent" data-testid="agent-chat-try-sent">
            <small>{result.as === "me" ? "You wrote" : "You wrote, as someone not linked"}</small>
            <blockquote>
              <p>{result.sent}</p>
            </blockquote>
          </div>
          {result.posts.length === 0 && <p className="ai-empty">The bot posted nothing.</p>}
          {result.posts.map((p) => (
            <div key={p.id} className="ai-chat-thread" data-testid="agent-chat-try-post">
              <small>
                The agent bot posted{p.edits ? `, edited ${p.edits} time${p.edits === 1 ? "" : "s"}` : ""}
                {p.buttons ? ", with Approve and Deny buttons" : ""}
              </small>
              <blockquote>
                <RichMarkdownContent text={chatTextAsMarkdown(result.service, p.text)} />
              </blockquote>
            </div>
          ))}
          {result.posts.some((p) => p.waitingCard) && (
            <p className="ai-hint" data-testid="agent-chat-try-card-note">
              In Slack this card has Approve and Deny buttons. In Mattermost people answer it with{" "}
              {mattermostAnswers === "buttons" ? "Approve and Deny buttons" : "reactions"}, as set under How Mattermost cards are answered.
              Here nobody can press or react, so answer it{" "}
              {result.ownAccount ? "in that conversation, in your list." : "under Conversations from chat."}
            </p>
          )}
          {result.privateNotes.map((n, i) => (
            <p key={i} className="ai-hint" data-testid="agent-chat-try-private">
              Only the person who wrote saw: {n}
            </p>
          ))}
          {!result.settled && (
            <p className="ai-hint">
              The agent is still working, or waits for an answer. This is what was posted so far.
              {result.posts.some((p) => p.waitingCard)
                ? ""
                : result.ownAccount
                  ? " A change that waits is in that conversation, in your list, as nobody can press or react in this simulated chat."
                  : " A change that waits can be answered under Conversations from chat, as nobody can press or react in this simulated chat."}
            </p>
          )}
        </div>
      )}
      <Failed shown={failed} error={error} />
    </div>
  );
}

// ---- your chat account ---------------------------------------------------------------------------------------

/** For everybody: link this person's own chat account, so their answers in chat count as theirs. */
function YourChatAccount({ chat, act, error, failed }: { chat: ChatAnsweringSnapshot; act: Act; error?: string; failed: boolean }): JSX.Element {
  const [codes, setCodes] = useState<Partial<Record<ChatServiceName, { code: string; expiresAt: number }>>>({});
  const services = SERVICES.filter((s) => chat.services.includes(s) || chat.links.some((l) => l.service === s));
  const getCode = async (service: ChatServiceName): Promise<void> => {
    const made = (await act({ action: "chat-link-code", service }))?.reply?.chatLinkCode;
    if (made) setCodes((c) => ({ ...c, [service]: { code: made.code, expiresAt: made.expiresAt } }));
  };
  return (
    <section className="ai-form" data-testid="your-chat-account">
      <strong>Your chat account</strong>
      <small>
        Link your Slack or Mattermost account to your sshs3 account. Then you can approve the agent bot&apos;s changes in chat,
        as far as your account may approve them here, and your direct messages to it run in your own account.
      </small>
      {services.length === 0 && <p className="ai-empty">The agent bot is not connected to a chat yet.</p>}
      {services.map((service) => {
        const link = chat.links.find((l) => l.service === service);
        const code = codes[service];
        if (link)
          return (
            <div key={service} className="ai-inline-form" data-testid={`your-chat-link-${service}`}>
              <span>
                In {NAME[service]} you are linked as <strong>{link.chatName}</strong>, since {when(link.linkedAt)}.
              </span>
              <ConfirmButton
                label="Unlink"
                confirmLabel={`Unlink your ${NAME[service]} account?`}
                onConfirm={() => void act({ action: "chat-unlink", service })}
              />
            </div>
          );
        return (
          <div key={service} data-testid={`your-chat-code-${service}`}>
            <div className="ai-card-actions">
              <button type="button" onClick={() => void getCode(service)}>
                {code ? `Get a new code for ${NAME[service]}` : `Get a link code for ${NAME[service]}`}
              </button>
            </div>
            {code && (
              <p className="ai-hint" role="status">
                Send <code className="ai-mono">link {code.code}</code> to the agent bot in a direct message. Do not paste it in a
                channel. The code works until {clock(code.expiresAt)}, once.
              </p>
            )}
          </div>
        );
      })}
      <Failed shown={failed} error={error} />
    </section>
  );
}

// ---- the card ----------------------------------------------------------------------------------------------

/**
 * The agent bot: a Slack app or Mattermost bot account of its own, separate from the context bot, that
 * answers when it is named in a channel an administrator chose, or in a direct message. An administrator
 * sets it up here; everybody can link their own chat account. Shown only on a web server.
 */
type CardPart =
  | ""
  | "toggle"
  | "connect-slack"
  | "connect-mattermost"
  | "channels"
  | "dms"
  | "copy"
  | "limits"
  | "key"
  | "waiting"
  | "runs"
  | "try"
  | "account"
  | "linked";

export function AgentInChatCard({ hub, act, error }: { hub: HubSnapshot; act: Act; error?: string }): JSX.Element | null {
  const chat = hub.chatAnswering;
  // Which part's request failed last. Every request of the card clears it first, so only the part whose
  // request failed shows the box, with the reason that request gave (the panel's one `error`).
  const [failedPart, setFailedPart] = useState<CardPart>("");
  const actFor =
    (part: CardPart): Act =>
    async (request) => {
      setFailedPart("");
      const next = await act(request);
      if (!next) setFailedPart(part);
      return next;
    };
  const failed = (part: CardPart): boolean => failedPart === part;
  // Which form was saved last. Kept here: a save changes the settings, and a form whose part changed
  // then starts over from them, so a form of its own could not say "Saved." after it.
  const [savedPart, setSavedPart] = useState<"" | "channels" | "dms" | "limits">("");
  // Open at first only while no agent bot is connected; after that it opens and closes as the person
  // chooses, so connecting a bot does not fold away what it said.
  const [botsOpen] = useState(() => (chat?.admin?.bots.length ?? 0) === 0);
  const savedFor = (part: "channels" | "dms" | "limits") => ({
    saved: savedPart === part,
    setSaved: (yes: boolean) => setSavedPart((now) => (yes ? part : now === part ? "" : now)),
  });
  if (!chat) return null;
  const admin = chat.admin;
  const showAccount = chat.enabled || chat.links.length > 0;
  if (!admin) {
    if (!showAccount && chat.waiting.length === 0) return null;
    return (
      <article className="ai-card ai-chat-card" data-testid="agent-in-chat-card">
        <div className="ai-card-head">
          <div>
            <strong>Agent in chat</strong>
            <small>The agent bot answers in Slack or Mattermost where an administrator of this server allows it.</small>
          </div>
        </div>
        <ChatWaitingList items={chat.waiting} act={actFor("waiting")} error={error} failed={failed("waiting")} />
        {showAccount && <YourChatAccount chat={chat} act={actFor("account")} error={error} failed={failed("account")} />}
      </article>
    );
  }
  const s = admin.settings;
  const refused = admin.dataPolicy.filter((d) => !d.allowed);
  const warned = admin.dataPolicy.filter((d) => d.allowed && d.warnings.length);
  // Each form starts from its own part of what is saved, and starts over only when that part changed:
  // a save of another part, or by another administrator, keeps what is typed here.
  const channelsKey = JSON.stringify(s.channels);
  const dmsKey = JSON.stringify(s.dms);
  const limitsKey = JSON.stringify([s.limits, s.monthlyTokenBudget, s.approvalWaitMinutes]);
  const toggle = async (enabled: boolean): Promise<void> => {
    await actFor("toggle")({ action: "chat-answering-save", input: { enabled } });
  };
  return (
    <article className="ai-card ai-chat-card" data-testid="agent-in-chat-card">
      <div className="ai-card-head">
        <div>
          <strong>Agent in chat</strong>
          <small>
            The agent bot answers in Slack or Mattermost when someone names it in a channel you chose, or writes to it directly.
            It answers in the thread. A change waits until a person who may approve it says yes: in the thread once they linked
            their chat account, or here under Waiting for your answer. Production, the two person rule and change freezes hold
            as in the app.
          </small>
          <small data-testid="agent-chat-stand-ins">
            So far this is tested only against stand-ins for Slack and Mattermost, not against a real workspace.
          </small>
        </div>
        <div className="ai-tags">
          <span className={`ai-badge ${s.enabled ? "ai-badge-success" : ""}`}>{s.enabled ? "Answering" : "Not answering"}</span>
        </div>
      </div>

      <div className="ai-switches">
        <label>
          <input type="checkbox" aria-label="Answer in chat" checked={s.enabled} onChange={(e) => void toggle(e.target.checked)} />
          <span>
            Answer in chat
            <small>When this is off, the agent bot stays connected and answers nobody.</small>
            {s.changedBy && s.changedAt && <small>Last changed by {s.changedBy}, {when(s.changedAt)}.</small>}
          </span>
        </label>
      </div>
      {!admin.model.set && (
        <p role={s.enabled ? "alert" : undefined} className={s.enabled ? "ai-error" : "ai-hint"} data-testid="agent-chat-no-model">
          The chat agent has no model yet. Press Copy my model first, under Model, budget and limits.
          {s.enabled ? ' Until then the agent bot answers every question with an error that says "No model is set up".' : ""}
        </p>
      )}
      {refused.length > 0 && (
        <p role="alert" className="ai-error" data-testid="agent-chat-policy">
          The chat agent&apos;s data policy does not let answers go to{" "}
          {refused.map((r) => `${NAME[r.service]} (${r.errors.join(" ")})`).join(" or ")}.{" "}
          {s.enabled ? "Answers are not posted there while the policy stops it." : "Answering cannot be switched on until the policy allows it."}{" "}
          The chat agent&apos;s data policy comes with its model settings. Change yours under What leaves this machine, then press
          Copy my model.
        </p>
      )}
      {warned.map((w) => (
        <p key={w.service} className="ai-hint">
          {NAME[w.service]}: {w.warnings.join(" ")}
        </p>
      ))}
      <Failed shown={failed("toggle")} error={error} />

      <details className="ai-fold ai-set-fold" open={botsOpen}>
        <summary>The agent bot{admin.bots.length ? ` · ${admin.bots.map((b) => `${NAME[b.service]}: ${statusTitle(admin.status[b.service], b)}`).join(", ")}` : " · not connected"}</summary>
        {SERVICES.map((service) => {
          const bot = admin.bots.find((b) => b.service === service);
          return (
            <Connect
              key={service}
              service={service}
              bot={bot}
              status={admin.status[service]}
              act={actFor(`connect-${service}`)}
              error={error}
              failed={failed(`connect-${service}`)}
            />
          );
        })}
      </details>

      <details className="ai-fold ai-set-fold">
        <summary>Channels · {SERVICES.reduce((n, sv) => n + (s.channels[sv]?.length ?? 0), 0)}</summary>
        <Channels
          key={channelsKey}
          hub={hub}
          agents={admin.agents}
          channels={s.channels}
          act={actFor("channels")}
          error={error}
          failed={failed("channels")}
          {...savedFor("channels")}
        />
      </details>

      <details className="ai-fold ai-set-fold">
        <summary>Direct messages · {s.dms.enabled ? "answered" : "off"}</summary>
        <DirectMessages key={dmsKey} dms={s.dms} act={actFor("dms")} error={error} failed={failed("dms")} {...savedFor("dms")} />
      </details>

      <details className="ai-fold ai-set-fold">
        <summary>
          Model, budget and limits · {s.usage.tokens.toLocaleString()} of {s.monthlyTokenBudget.toLocaleString()} tokens used this month
        </summary>
        <ModelAndLimits
          key={limitsKey}
          admin={admin}
          copyAct={actFor("copy")}
          saveAct={actFor("limits")}
          error={error}
          failed={failed("copy") ? "copy" : failed("limits") ? "save" : ""}
          {...savedFor("limits")}
        />
      </details>

      <details className="ai-fold ai-set-fold">
        <summary>The agent bot&apos;s SSH key</summary>
        <SshKey key={admin.publicKey ?? ""} publicKey={admin.publicKey} act={actFor("key")} error={error} failed={failed("key")} />
      </details>

      <details className="ai-fold ai-set-fold">
        <summary>How Mattermost cards are answered · {admin.mattermostAnswers === "buttons" ? "buttons" : "reactions"}</summary>
        {/* In a form like the other folds: the same padding and the same size of type. */}
        <div className="ai-form">
          <small data-testid="agent-chat-mattermost-answers">
            {admin.mattermostAnswers === "buttons"
              ? "Mattermost cards have Approve and Deny buttons: SSHS3_PUBLIC_URL and SSHS3_MATTERMOST_ACTION_FROM are both set on this server."
              : "Mattermost cards are answered with reactions: ✅ to approve, ❌ to deny. For buttons, set both SSHS3_PUBLIC_URL and SSHS3_MATTERMOST_ACTION_FROM, the IP addresses Mattermost's server posts from, exactly as this server sees them. Host names and ranges are not matched."}{" "}
            Behind a reverse proxy this server sees the proxy&apos;s address, so that is the address the list must hold. In Slack,
            cards have buttons.
          </small>
        </div>
      </details>

      <details className="ai-fold ai-set-fold">
        <summary>Linked people · {admin.linked.length}</summary>
        {admin.linked.length === 0 ? (
          <p className="ai-empty">Nobody has linked a chat account yet.</p>
        ) : (
          <ul className="ai-link-list" data-testid="agent-chat-linked">
            {admin.linked.map((l) => (
              <li key={`${l.service}:${l.chatUserId}`} className="ai-link">
                <span>
                  <strong>{l.chatName}</strong> in {NAME[l.service]} is {l.accountName}, linked {when(l.linkedAt)}.
                </span>
                <ConfirmButton
                  label="Unlink"
                  ariaLabel={`Unlink ${l.chatName}`}
                  confirmLabel={`Unlink ${l.chatName}?`}
                  onConfirm={() => void actFor("linked")({ action: "chat-unlink", service: l.service, chatUserId: l.chatUserId })}
                />
              </li>
            ))}
          </ul>
        )}
        <Failed shown={failed("linked")} error={error} />
      </details>

      <details className="ai-fold ai-set-fold">
        <summary>Conversations from chat</summary>
        <Conversations act={actFor("runs")} error={error} failed={failed("runs")} />
      </details>

      <details className="ai-fold ai-set-fold">
        <summary>Try it</summary>
        {admin.canTry ? (
          <TryIt
            key={channelsKey}
            channels={s.channels}
            act={actFor("try")}
            error={error}
            failed={failed("try")}
            modelSet={admin.model.set}
            mattermostAnswers={admin.mattermostAnswers === "buttons" ? "buttons" : "reactions"}
          />
        ) : (
          <p className="ai-hint">Try it is for the demo, or for before the agent bot is connected. Now ask the agent bot in your chat.</p>
        )}
      </details>

      <ChatWaitingList items={chat.waiting} act={actFor("waiting")} admin error={error} failed={failed("waiting")} />
      {showAccount && <YourChatAccount chat={chat} act={actFor("account")} error={error} failed={failed("account")} />}
    </article>
  );
}
