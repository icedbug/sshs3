import { openLink } from "../../lib/openLink";
import { useState } from "react";
import { accessRequestUrl, validatedAccessRequest } from "@shared/ticketAccessRequest";
import type { WorkTicket } from "@shared/types/aiHub";
import type { Act } from "./panelShared";

function localTime(at?: number): string {
  if (at === undefined) return "";
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

export function TicketAccessRequestCard({ ticket, act }: { ticket: WorkTicket; act: Act }): JSX.Element {
  const record = ticket.accessRequest;
  const href = accessRequestUrl(record?.url);
  const [draft, setDraft] = useState<{ url: string; resource: string; reviewer: string; expiry: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(remove = false): Promise<void> {
    if (busy || (!draft && !remove)) return;
    setBusy(true);
    setError("");
    try {
      const accessRequest = !remove && draft ? validatedAccessRequest({
        url: draft.url, resource: draft.resource, reviewer: draft.reviewer,
        expiresAt: record && draft.expiry === localTime(record.expiresAt) ? record.expiresAt : new Date(draft.expiry).getTime(),
      }) : null;
      const result = await act({ action: "ticket-access-request", id: ticket.id, accessRequest });
      if (!result) throw new Error("Could not update the access request link.");
      setDraft(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the access request link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Resource access request">
      {record && (
        <div className="ai-hint">
          {href && <a href={href} title={href} target="_blank" rel="noopener noreferrer" onClick={event => {
            event.preventDefault();
            if (!openLink(href)) setError("Could not open the access request.");
          }}>Open access request</a>}
          <div>Resource · {record.resource}</div>
          <div>Reviewer · {record.reviewer}</div>
          <div>Recorded expiry · {new Date(record.expiresAt).toLocaleString()}</div>
        </div>
      )}
      {draft ? (
        <form className="ai-form" onSubmit={e => { e.preventDefault(); void save(); }}>
          <label>Shareable request URL<input type="url" required maxLength={2048} value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} /></label>
          <label>Requested resource<input required maxLength={200} value={draft.resource} onChange={e => setDraft({ ...draft, resource: e.target.value })} /></label>
          <label>Reviewer<input required maxLength={200} value={draft.reviewer} onChange={e => setDraft({ ...draft, reviewer: e.target.value })} /></label>
          <label>Recorded expiry (local time)<input type="datetime-local" step="1" required value={draft.expiry} onChange={e => setDraft({ ...draft, expiry: e.target.value })} /></label>
          <small>These details are shared on the team board. The linked identity system manages access.</small>
          <div className="ai-card-actions">
            <button type="submit" disabled={busy}>Save access request</button>
            <button type="button" disabled={busy} onClick={() => { setDraft(undefined); setError(""); }}>Cancel</button>
            {record && <button type="button" disabled={busy} onClick={() => void save(true)}>Remove link</button>}
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => { setError(""); setDraft({
          url: href ?? "", resource: record?.resource ?? ticket.target ?? "", reviewer: record?.reviewer ?? "", expiry: localTime(record?.expiresAt),
        }); }}>{record ? "Edit access request" : "Link an access request"}</button>
      )}
      {error && <p role="alert" className="ai-error">{error}</p>}
    </section>
  );
}
