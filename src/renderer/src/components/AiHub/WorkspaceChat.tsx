import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { HubRequest, HubSnapshot, WorkspaceActivityEvent } from '@shared/types/aiHub';

const GENERAL = 'general';
const MAX_CHAT_TEXT = 4000;
const AI_MENTION = /(?:^|[\s(>])@ai\b/i;

interface WorkspaceChatProps {
  hub: HubSnapshot | undefined | null;
  /** Sends a hub request; rejects with the hub's own error. */
  request: (request: HubRequest) => Promise<unknown>;
  channel?: string;
  /**
   * Whether messages reach teammates. Left out, it follows the S3 team workspace status; the caller
   * sets it when it knows of another shared transport.
   */
  teamShared?: boolean;
}

function timeLabel(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return now - at < 20 * 3_600_000 && new Date(now).getDate() === date.getDate()
    ? time
    : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

/**
 * The workspace's shared chat. Messages are `chat` events on the team activity log, so they reach
 * teammates through the same sync as the rest of the workspace (S3 team workspace, Team Vault, shared
 * file). A message that mentions `@ai` is answered in the channel by the workspace assistant.
 */
export function WorkspaceChat({ hub, request, channel = GENERAL, teamShared }: WorkspaceChatProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const messages = useMemo(
    () =>
      (hub?.activityLog ?? [])
        .filter((e) => e.kind === 'chat' && (e.channel?.trim() || GENERAL) === channel)
        .sort((a, b) => a.at - b.at),
    [hub?.activityLog, channel]
  );
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  // The assistant is answering while a read-only run for one of this channel's messages is active.
  const answering = useMemo(
    () =>
      (hub?.tasks ?? []).some(
        (t) =>
          t.chatMessageId &&
          byId.has(t.chatMessageId) &&
          (t.status === 'queued' || t.status === 'running' || t.status === 'waiting')
      ),
    [hub?.tasks, byId]
  );

  const lastId = messages.at(-1)?.id;
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [lastId, answering]);

  const aiEnabled = hub?.config.enabled === true;
  const sync = hub?.s3Workspace;
  const shared = teamShared ?? Boolean(sync?.enabled && sync.configured);
  const mentionsAi = AI_MENTION.test(draft);
  const tooLong = draft.length > MAX_CHAT_TEXT;
  const now = Date.now();

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sending || tooLong) return;
    setSending(true);
    setError(null);
    try {
      await request({ action: 'chat-post', text, channel });
      setDraft('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const addMention = (): void => {
    setDraft((value) => (AI_MENTION.test(value) ? value : `@ai ${value}`));
    inputRef.current?.focus();
  };

  return (
    <div data-testid="workspace-chat" className="flex min-h-0 flex-col gap-2">
      <div
        ref={listRef}
        role="log"
        aria-label="Workspace chat"
        aria-live="polite"
        // Fills the height the page has left, so the conversation is the main thing in the team column.
        className="h-[calc(100vh-430px)] max-h-[640px] min-h-[200px] space-y-2 overflow-y-auto pr-1"
      >
        {messages.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-subtle p-3 text-xs text-txt-muted">
            <p className="font-semibold text-txt-secondary">No messages yet.</p>
            <p className="mt-1">
              Write to the team here. Mention <code className="text-sky-300">@ai</code> to ask the
              assistant: it reads the team's activity log, servers, memories and knowledge base, and
              answers in the channel where everyone sees it.
            </p>
          </div>
        ) : (
          messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              question={message.replyTo ? byId.get(message.replyTo) : undefined}
              now={now}
            />
          ))
        )}
        {answering && (
          <p data-testid="workspace-chat-answering" className="px-1 text-[11px] text-sky-300">
            The assistant is reading the workspace and writing an answer…
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
          The message was not sent: {error}
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="rounded-lg border border-border-subtle bg-app-card p-2"
      >
        <textarea
          ref={inputRef}
          data-testid="workspace-chat-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          aria-label="Message to the team"
          placeholder="Write to the team… (@ai to ask the assistant)"
          className="w-full resize-none rounded border border-border-subtle bg-app px-2 py-1.5 text-xs text-txt-primary outline-none placeholder:text-txt-muted focus:border-sky-500/60"
        />
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={addMention}
            data-testid="workspace-chat-mention-ai"
            className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] font-semibold text-sky-300 hover:bg-sky-500/20"
          >
            @ai
          </button>
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-txt-muted">
            {tooLong
              ? `Too long: ${draft.length}/${MAX_CHAT_TEXT} characters`
              : mentionsAi && !aiEnabled
                ? 'AI is not enabled. Turn it on in the AI settings to get an answer.'
                : shared
                  ? 'Shared with the team.'
                  : 'No team sync is on: messages are kept here only.'}
          </span>
          <button
            type="submit"
            data-testid="workspace-chat-send"
            disabled={sending || !draft.trim() || tooLong}
            className="rounded bg-sky-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-sky-500 disabled:opacity-40"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ChatMessage({
  message,
  question,
  now,
}: {
  message: WorkspaceActivityEvent;
  question?: WorkspaceActivityEvent;
  now: number;
}): JSX.Element {
  const ai = message.actorKind === 'ai';
  return (
    <article
      data-testid={ai ? 'workspace-chat-ai-message' : 'workspace-chat-message'}
      className={`rounded-lg border p-2 text-xs ${
        ai ? 'border-sky-500/30 bg-sky-500/5' : 'border-border-subtle bg-app-card'
      }`}
    >
      <header className="flex items-baseline justify-between gap-2">
        <span className={`font-semibold ${ai ? 'text-sky-300' : 'text-txt-primary'}`}>
          {ai ? 'Assistant' : message.actor}
        </span>
        <time dateTime={new Date(message.at).toISOString()} className="shrink-0 text-[10px] text-txt-muted">
          {timeLabel(message.at, now)}
        </time>
      </header>
      {question && (
        <p className="mt-0.5 truncate border-l-2 border-border-subtle pl-1.5 text-[10.5px] text-txt-muted">
          Reply to {question.actor}: {question.summary}
        </p>
      )}
      {ai ? (
        <div className="prose prose-invert prose-sm mt-1 max-w-none break-words text-xs text-txt-secondary">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.summary}</ReactMarkdown>
        </div>
      ) : (
        <p className="mt-1 whitespace-pre-wrap break-words text-txt-secondary">{message.summary}</p>
      )}
    </article>
  );
}
