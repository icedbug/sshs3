import { useState } from "react";
import type {
  HubSnapshot,
  NotifyChannelInput,
  NotifyChannelKind,
  NotifyChannelView,
  NotifyEventKind,
} from "@shared/types/aiHub";
import { ConfirmButton } from "./ConfirmButton";
import type { Act } from "./panelShared";

const KINDS: Record<NotifyChannelKind, { label: string; address: string; hint: string; secret?: string }> = {
  slack: {
    label: "Slack",
    address: "https://hooks.slack.com/services/…",
    hint: "An incoming webhook of a Slack app: it posts to the channel you chose when you made it.",
  },
  teams: {
    label: "Microsoft Teams",
    address: "https://…webhook.office.com/… or a Workflows address",
    hint: "A webhook of a Teams channel (Workflows: “Post to a channel when a webhook request is received”).",
  },
  ntfy: {
    label: "ntfy (push to your phone)",
    address: "https://ntfy.sh/your-topic",
    hint: "Open source. Subscribe to the same topic in the ntfy app. The address ends with the topic; pick one that cannot be guessed.",
    secret: "Access token (if the topic is protected)",
  },
  webhook: {
    label: "Webhook (JSON)",
    address: "https://example.com/hooks/sshs3",
    hint: "Any address that takes a JSON POST. With a signing key, each request is signed the Standard Webhooks way (webhook-id, webhook-timestamp, webhook-signature) and also carries X-Sshs3-Signature (HMAC SHA-256).",
    secret: "Signing key (optional)",
  },
};

const EVENTS: { kind: NotifyEventKind; label: string }[] = [
  { kind: "approval", label: "A command waits for approval" },
  { kind: "plan", label: "A plan waits for a decision" },
  { kind: "question", label: "An agent asks a question" },
  { kind: "blocked", label: "A run stopped" },
  { kind: "alert", label: "An alert nobody has taken" },
  { kind: "health", label: "A server needs attention (disk, certificate, failed service)" },
  { kind: "review", label: "A ticket is ready for review" },
  { kind: "report", label: "The daily report" },
];
const URGENT: NotifyEventKind[] = ["approval", "plan", "question", "blocked", "alert"];

interface Draft extends NotifyChannelInput {
  url: string;
  secret: string;
}

const blank = (): Draft => ({ kind: "slack", name: "", url: "", secret: "", enabled: true, events: URGENT, includeCommand: true });

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`;
}

/**
 * Where sshs3 tells people that something waits for them. The addresses are
 * secrets: they are typed here and never shown again, only the host is.
 */
export function NotificationsCard({ hub, act }: { hub: HubSnapshot; act: Act }): JSX.Element {
  const settings = hub.notifications ?? { channels: [], publicUrl: "", publicUrlFixed: false, reminderMinutes: 5 };
  const [draft, setDraft] = useState<Draft | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [testing, setTesting] = useState<Record<string, string>>({});
  const editing = draft?.id ? settings.channels.find((c) => c.id === draft.id) : undefined;
  const here = typeof window !== "undefined" && /^https?:$/.test(window.location.protocol) ? window.location.origin : "";

  const edit = (c: NotifyChannelView): void =>
    setDraft({ id: c.id, kind: c.kind, name: c.name, url: "", secret: "", enabled: c.enabled, events: c.events, includeCommand: c.includeCommand, alertMinSeverity: c.alertMinSeverity });

  const save = (): void => {
    if (!draft) return;
    void act({
      action: "notify-channel-save",
      channel: {
        id: draft.id,
        kind: draft.kind,
        name: draft.name.trim() || KINDS[draft.kind].label,
        // Left empty on a channel that exists: keep what is there.
        url: draft.url.trim() || undefined,
        secret: draft.secret.trim() ? draft.secret.trim() : draft.id ? undefined : "",
        enabled: draft.enabled,
        events: draft.events,
        includeCommand: draft.includeCommand,
        alertMinSeverity: draft.alertMinSeverity,
      },
    }).then((next) => next && setDraft(null));
  };

  const test = (id: string): void => {
    setTesting((t) => ({ ...t, [id]: "Sending…" }));
    void act({ action: "notify-channel-test", id }).then((next) => {
      const result = next?.reply?.notifyTest;
      setTesting((t) => ({
        ...t,
        [id]: !result ? "" : result.ok ? "Arrived. Check the channel." : `Not delivered: ${result.error ?? `answer ${result.status}`}`,
      }));
    });
  };

  return (
    <article className="ai-card" data-testid="notifications-card">
      <div className="ai-card-head">
        <div>
          <strong>
            Channels <span className="ai-count">{settings.channels.length}</span>
          </strong>
          <small>
            When something starts to wait for a person, sshs3 tells these channels, once, with what is needed to decide and
            a link to the inbox. Approving still happens in sshs3, signed in.
          </small>
        </div>
        {!draft && (
          <button type="button" onClick={() => setDraft(blank())}>
            Add a channel
          </button>
        )}
      </div>

      {settings.channels.length === 0 && !draft && (
        <p className="ai-empty">
          No channel yet. Without one, an agent that needs an approval waits until someone opens sshs3.
        </p>
      )}

      <div className="ai-rows">
        {settings.channels.map((c) => (
          <div className="ai-row" key={c.id} data-testid={`notify-channel-${c.id}`}>
            <div>
              <strong>{c.name}</strong>{" "}
              <span className="ai-chip">{KINDS[c.kind].label}</span> <small className="ai-muted">{c.host}</small>
              <small>
                {c.enabled ? EVENTS.filter((e) => c.events.includes(e.kind)).length + " kinds of event" : "Switched off"}
                {c.includeCommand ? "" : " · without command text"}
                {c.last && (
                  <>
                    {" · "}
                    <span className={c.last.ok ? "ai-ok" : "ai-bad"}>
                      {c.last.ok ? `last delivered ${ago(c.last.at)}` : `last attempt failed ${ago(c.last.at)}: ${c.last.error ?? c.last.status}`}
                    </span>
                  </>
                )}
              </small>
              {testing[c.id] && <small role="status">{testing[c.id]}</small>}
            </div>
            <div className="ai-card-actions">
              <button type="button" onClick={() => test(c.id)}>
                Send a test
              </button>
              <button type="button" onClick={() => edit(c)}>
                Edit
              </button>
              <ConfirmButton
                label="Remove"
                confirmLabel="Remove channel?"
                className=""
                ariaLabel={`Remove ${c.name}`}
                onConfirm={() => void act({ action: "notify-channel-delete", id: c.id })}
              />
            </div>
          </div>
        ))}
      </div>

      {draft && (
        <div className="ai-form ai-notify-editor" data-testid="notify-editor">
          <div className="ai-form-row">
            <label>
              Kind
              <select
                aria-label="Kind of channel"
                value={draft.kind}
                disabled={Boolean(draft.id)}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as NotifyChannelKind })}
              >
                {Object.entries(KINDS).map(([kind, k]) => (
                  <option key={kind} value={kind}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Name
              <input
                aria-label="Channel name"
                placeholder="e.g. #ops-oncall"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
          </div>
          <label>
            Address
            <input
              aria-label="Channel address"
              type="password"
              autoComplete="off"
              placeholder={editing ? `Kept (${editing.host}). Type a new one to change it.` : KINDS[draft.kind].address}
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            />
            <small>{KINDS[draft.kind].hint} The address is a secret: it is saved encrypted and only its host is shown afterwards.</small>
          </label>
          {KINDS[draft.kind].secret && (
            <label>
              {KINDS[draft.kind].secret}
              <input
                aria-label="Channel secret"
                type="password"
                autoComplete="off"
                placeholder={editing?.hasSecret ? "Kept. Type a new one to change it." : ""}
                value={draft.secret}
                onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
              />
            </label>
          )}
          <fieldset className="ai-switches">
            <legend>Tell this channel when</legend>
            {EVENTS.map((event) => (
              <label key={event.kind}>
                <input
                  type="checkbox"
                  checked={draft.events.includes(event.kind)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      events: e.target.checked ? [...draft.events, event.kind] : draft.events.filter((k) => k !== event.kind),
                    })
                  }
                />
                <span>{event.label}</span>
              </label>
            ))}
          </fieldset>
          <div className="ai-form-row">
            <label>
              Alerts from
              <select
                aria-label="Lowest alert severity"
                value={draft.alertMinSeverity ?? "info"}
                onChange={(e) => setDraft({ ...draft, alertMinSeverity: e.target.value as Draft["alertMinSeverity"] })}
              >
                <option value="info">Any severity</option>
                <option value="warning">Warning and up</option>
                <option value="critical">Critical only</option>
              </select>
            </label>
            <label className="ai-check">
              <input
                type="checkbox"
                checked={draft.includeCommand}
                onChange={(e) => setDraft({ ...draft, includeCommand: e.target.checked })}
              />
              <span>
                Include the command text
                <small>Off: the message says that a command waits, and where, but not what it is.</small>
              </span>
            </label>
          </div>
          <label className="ai-check">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            <span>Switched on</span>
          </label>
          <div className="ai-card-actions">
            <button type="button" className="ai-btn-emerald" onClick={save} disabled={!draft.id && !draft.url.trim()}>
              {draft.id ? "Save channel" : "Add channel"}
            </button>
            <button type="button" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="ai-form ai-notify-links">
        <label>
          Address of this sshs3, for the link in a notification
          <div className="ai-inline-form">
            <input
              aria-label="Public address"
              placeholder="https://sshs3.example.com"
              disabled={settings.publicUrlFixed}
              value={publicUrl ?? settings.publicUrl}
              onChange={(e) => setPublicUrl(e.target.value)}
            />
            {!settings.publicUrlFixed && here && (publicUrl ?? settings.publicUrl) !== here && (
              <button type="button" onClick={() => setPublicUrl(here)}>
                Use this address
              </button>
            )}
            {!settings.publicUrlFixed && publicUrl !== null && publicUrl !== settings.publicUrl && (
              <button
                type="button"
                className="ai-btn-emerald"
                onClick={() => void act({ action: "notify-settings-save", publicUrl }).then((next) => next && setPublicUrl(null))}
              >
                Save address
              </button>
            )}
          </div>
          <small>
            {settings.publicUrlFixed
              ? "Set by the administrator (SSHS3_PUBLIC_URL)."
              : settings.publicUrl
                ? "A notification links to the item in your inbox."
                : "Empty: notifications are sent without a link. The desktop app has no address; a workforce server does."}
          </small>
        </label>
        <label>
          Remind about an unanswered approval
          <select
            aria-label="Reminder"
            value={settings.reminderMinutes}
            onChange={(e) => void act({ action: "notify-settings-save", reminderMinutes: Number(e.target.value) })}
          >
            <option value={0}>Never</option>
            <option value={3}>Once, after 3 minutes</option>
            <option value={5}>Once, after 5 minutes</option>
            <option value={10}>Once, after 10 minutes</option>
            <option value={20}>Once, after 20 minutes</option>
          </select>
          <small>
            An agent waits {hub.preferences?.approvalWaitMinutes ?? 10} min for an answer; a reminder comes at the latest a
            minute before that, and says how long is left.
          </small>
        </label>
      </div>
    </article>
  );
}
