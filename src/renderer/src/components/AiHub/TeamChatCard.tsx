import { useState } from "react";
import type { ChatConnectionView, ChatServiceName, ChatThreadView, HubSnapshot } from "@shared/types/aiHub";
import { ConfirmButton } from "./ConfirmButton";
import type { Act } from "./panelShared";

const NAME: Record<ChatServiceName, string> = { slack: "Slack", mattermost: "Mattermost" };

const ago = (at: number): string => {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 2880 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`;
};
const day = (at: number): string => new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** One service: the bot's connection, and the channels it is in. */
function Service({
  service,
  connection,
  canChange,
  act,
}: {
  service: ChatServiceName;
  connection?: ChatConnectionView;
  canChange: boolean;
  act: Act;
}): JSX.Element {
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState("");
  const [said, setSaid] = useState("");
  const channels = connection?.channels ?? [];
  const reading = channels.filter((c) => c.selected);

  const save = async (): Promise<boolean> => {
    setBusy("save");
    setSaid("");
    const next = await act({
      action: "chat-source-save",
      connection: { service, baseUrl: service === "mattermost" ? baseUrl.trim() : undefined, token: token.trim() || undefined, enabled: true },
    });
    setBusy("");
    if (!next) return false;
    setToken("");
    return true;
  };
  const test = async (): Promise<void> => {
    if (!(await save())) return;
    setBusy("test");
    const result = (await act({ action: "chat-source-test", service }))?.reply?.chatTest;
    setBusy("");
    if (!result) return;
    setSaid(
      result.ok
        ? `Signed in as ${result.bot} in ${result.workspace}. The bot is in ${result.channels} channel${result.channels === 1 ? "" : "s"}: choose below which to read.`
        : `It did not work: ${result.error ?? "no answer"}`,
    );
  };

  return (
    <details className="ai-fold ai-set-fold" data-testid={`chat-${service}`} open={Boolean(connection)}>
      <summary>
        {NAME[service]}
        {connection
          ? connection.lastError
            ? ` · could not be read: ${connection.lastError}`
            : ` · ${connection.bot ?? "connected"}${reading.length ? `, reading ${reading.length} channel${reading.length === 1 ? "" : "s"}` : ", no channel chosen"}`
          : " · not connected"}
      </summary>
      <div className="ai-form">
        <fieldset disabled={!canChange} style={{ border: 0, padding: 0, margin: 0, display: "contents" }}>
          {service === "mattermost" && (
            <label>
              Address of the Mattermost server
              <input type="url" value={baseUrl} placeholder="https://chat.example.com" onChange={(e) => setBaseUrl(e.target.value)} />
            </label>
          )}
          <label>
            {service === "slack" ? "Bot token of the Slack app" : "Access token of the bot account"}
            <input
              type="password"
              value={token}
              autoComplete="new-password"
              placeholder={connection?.hasToken ? "Set. Leave empty to keep it." : service === "slack" ? "xoxb-…" : ""}
              onChange={(e) => setToken(e.target.value)}
            />
            <small>
              {service === "slack"
                ? "Create a Slack app for your workspace with the bot scopes channels:history, groups:history, channels:read, groups:read and users:read, install it, and invite the bot to the channels it should read. "
                : "Create a bot account, give it a personal access token, and add it to the channels it should read. "}
              The token is the team&apos;s: kept encrypted here, never shared through the team bucket, and never shown again.
            </small>
          </label>
          <div className="ai-card-actions">
            <button type="button" className="ai-btn-accent" disabled={Boolean(busy) || (!token.trim() && !connection?.hasToken)} onClick={() => void test()}>
              {busy === "test" ? "Testing…" : busy === "save" ? "Saving…" : connection ? "Save and list the channels again" : "Connect"}
            </button>
            {connection && (
              <>
                <ConfirmButton
                  label="Disconnect"
                  confirmLabel="Disconnect, and keep what was read?"
                  className=""
                  onConfirm={() => void act({ action: "chat-source-disconnect", service })}
                />
                <ConfirmButton
                  label="Disconnect and forget"
                  confirmLabel={`Remove everything read from ${NAME[service]}?`}
                  onConfirm={() => void act({ action: "chat-source-disconnect", service, forget: true })}
                />
              </>
            )}
          </div>
          {said && (
            <p role="status" className="ai-hint" data-testid={`chat-${service}-said`}>
              {said}
            </p>
          )}
          {channels.length > 0 && (
            <ul className="ai-link-list" data-testid={`chat-${service}-channels`}>
              {channels.map((c) => (
                <li key={c.id} className="ai-link">
                  <label className="ai-check">
                    <input
                      type="checkbox"
                      checked={c.selected}
                      aria-label={`Read #${c.name}`}
                      onChange={(e) => void act({ action: "chat-channel-select", service, channelId: c.id, selected: e.target.checked })}
                    />
                    <span>
                      <strong>#{c.name}</strong>
                      {c.private ? " · private" : ""}
                      {c.count
                        ? ` · ${c.count.toLocaleString()} message${c.count === 1 ? "" : "s"} kept${c.oldestAt ? `, from ${day(c.oldestAt)}` : ""}`
                        : c.selected
                          ? " · nothing read yet"
                          : ""}
                      {c.selected && c.lastReadAt ? ` · read ${ago(c.lastReadAt)}` : ""}
                      {c.readingBack ? " · reading further back…" : ""}
                    </span>
                  </label>
                  {c.error && (
                    <small role="alert" className="ai-error">
                      {c.error}
                    </small>
                  )}
                  {c.selected && c.count > 0 && !c.readingBack && (
                    <button type="button" onClick={() => void act({ action: "chat-channel-read-back", service, channelId: c.id, days: 365 })}>
                      Read a year further back
                    </button>
                  )}
                  {c.count > 0 && (
                    <ConfirmButton
                      label="Forget"
                      confirmLabel={`Remove what was read from #${c.name}?`}
                      onConfirm={() => void act({ action: "chat-forget", service, channelId: c.id })}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      </div>
    </details>
  );
}

/** A thread found in the chat, as it is shown wherever one is. */
export function ChatThread({ hit, act }: { hit: Pick<ChatThreadView, "service" | "channelId" | "channel" | "threadId" | "at" | "link"> & { lines: string[]; total?: number }; act?: Act }): JSX.Element {
  const [made, setMade] = useState("");
  return (
    <div className="ai-chat-thread" data-testid="chat-thread">
      <small>
        #{hit.channel} · {new Date(hit.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
        {hit.total && hit.total > hit.lines.length ? ` · ${hit.total} messages in the thread` : ""}
        {hit.link && (
          <>
            {" · "}
            <a href={hit.link} target="_blank" rel="noreferrer noopener">
              Open in {NAME[hit.service]}
            </a>
          </>
        )}
      </small>
      <blockquote>
        {hit.lines.map((l, i) => (
          <p key={i}>{l}</p>
        ))}
      </blockquote>
      {act && (
        <div className="ai-card-actions">
          <button
            type="button"
            disabled={Boolean(made)}
            title="Adds the whole thread to the knowledge base as a source, for pages to be written from"
            onClick={() =>
              void act({ action: "chat-thread-to-kb", service: hit.service, channelId: hit.channelId, threadId: hit.threadId }).then((next) => {
                const result = next?.reply?.ingest;
                if (result) setMade(result.added.length ? "Added to the knowledge base." : "It is in the knowledge base already.");
              })
            }
          >
            {made || "Make a source of this thread"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The context bot: the team's chat as context for the agents. A bot in Slack or Mattermost, the channels
 * it reads, and a way to try what an agent would find. It only reads; the agent bot (AgentInChatCard) is
 * a separate app that answers.
 */
export function TeamChatCard({ hub, act }: { hub: HubSnapshot; act: Act }): JSX.Element {
  const chat = hub.chatSources;
  const canChange = chat?.canChange !== false;
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; hits: ChatThreadView[] } | undefined>();
  const [days, setDays] = useState(chat?.retentionDays ? String(chat.retentionDays) : "");
  const find = (): void => {
    if (!query.trim()) return;
    void act({ action: "chat-search", query: query.trim() }).then((next) => next?.reply?.chatSearch && setFound(next.reply.chatSearch));
  };
  return (
    <article className="ai-card ai-chat-card" data-testid="team-chat-card">
      <div className="ai-card-head">
        <div>
          <strong>
            Context bot <span className="ai-count">{(chat?.total ?? 0).toLocaleString()}</span>
          </strong>
          <small data-testid="context-bot-line">
            {/* A member cannot pick channels: an administrator does. */}
            It only reads the channels {canChange ? "you pick" : "an administrator picks"}, so agents can search what the team wrote.
            {/* The agent bot is only on a web server: the desktop app has no Agent in chat card to point to. */}
            {hub.chatAnswering ? " Talking to the agent goes through the agent bot: see Agent in chat." : ""}
          </small>
          <small>
            What the team says in chat is often the only place something is written down: &ldquo;restarted it last night&rdquo;,
            &ldquo;that alert is known&rdquo;. A bot the team invites to chosen channels lets agents look that up, and puts what
            was said about a server on its alert&apos;s ticket. The bot only reads, and only the channels chosen here; never direct
            messages. Agents are given it as what people said, not as instructions.
          </small>
        </div>
      </div>
      {!canChange && <p className="ai-hint">The bot is the team&apos;s: an administrator of this server sets it up and chooses the channels.</p>}
      <Service service="slack" connection={chat?.connections.find((c) => c.service === "slack")} canChange={canChange} act={act} />
      <Service service="mattermost" connection={chat?.connections.find((c) => c.service === "mattermost")} canChange={canChange} act={act} />

      {(chat?.total ?? 0) > 0 && (
        <>
          <p className="ai-hint" data-testid="team-chat-kept">
            What is read is kept only where the bot is connected, not in the team bucket, with what looks like a password or
            key masked. It is kept{" "}
            {chat?.retentionDays ? `for ${chat.retentionDays} days` : "until you remove it"}, also when a message is later edited or
            deleted in the chat: use Forget to remove it here.
          </p>
          {canChange && (
            <div className="ai-inline-form">
              <label>
                Keep messages for (days; empty: until removed)
                <input
                  aria-label="Days to keep messages"
                  type="number"
                  min={1}
                  max={3650}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    void act({ action: "chat-retention", days: days.trim() ? Number(days) : undefined });
                  }}
                />
              </label>
              <button
                type="button"
                onClick={() => void act({ action: "chat-retention", days: days.trim() ? Number(days) : undefined })}
              >
                Save
              </button>
            </div>
          )}
          <div className="ai-inline-form">
            <input
              aria-label="Search the team's chat"
              placeholder="Try what an agent would find: pg-01 restart"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                find();
              }}
            />
            <button type="button" disabled={!query.trim()} onClick={find}>
              Search
            </button>
          </div>
          {found && (
            <div data-testid="team-chat-found">
              {found.hits.length === 0 && <p className="ai-empty">Nothing in what was read mentions &ldquo;{found.query}&rdquo;.</p>}
              {found.hits.map((hit) => (
                <ChatThread
                  key={`${hit.channelId}:${hit.threadId}`}
                  hit={{ ...hit, lines: hit.messages.map((m) => `${m.author}: ${m.text}`) }}
                  act={act}
                />
              ))}
            </div>
          )}
        </>
      )}
    </article>
  );
}
