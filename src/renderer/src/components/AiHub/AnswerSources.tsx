import { useEffect, useId, useState } from "react";
import type { AnswerSource } from "@shared/answerSources";
import type { HubReply } from "@shared/types/aiHub";
import { hubSessionActive, hubSessionGeneration } from "../../lib/aiHubSession";

const kindLabel: Record<AnswerSource["kind"], string> = {
  "kb-page": "KB page",
  "kb-document": "KB document",
  memory: "Memory",
  terminal: "Terminal excerpt",
  "server-reading": "Server reading",
  investigation: "Investigator's report",
};

function Timestamp({ value }: { value: number }): JSX.Element {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <span>Unknown time</span>;
  return <time dateTime={date.toISOString()} title={date.toISOString()}>{date.toLocaleString()}</time>;
}

export function AnswerSourceDetails({ source }: { source: AnswerSource }): JSX.Element {
  const segments = source.segments ?? [];
  const sentChars = segments.reduce((sum, segment) => sum + segment.length, 0);
  const showFull = segments.length > 1 || Boolean(source.excerptTruncated);
  return (
    <div className="ai-receipt-source">
      <div className="ai-receipt-source-heading">
        <strong>{source.label}</strong>
        <small>{kindLabel[source.kind]}{source.attachment ? " · Attached to chat" : ""}{source.indexOnly ? " · Index entry only" : ""}</small>
      </div>
      <div className="ai-receipt-meta">
        <span>ID <code>{source.id}</code></span>
        {source.revision !== undefined && <span>Version {source.revision}</span>}
        {source.updatedAt !== undefined && <span>Updated <Timestamp value={source.updatedAt} /></span>}
        {source.observedAt !== undefined && <span>Observed <Timestamp value={source.observedAt} /></span>}
        <span title={source.digest}>Fingerprint <code>{source.digest.slice(0, 12)}</code></span>
      </div>
      {source.expired && <small>The workspace retention period for this {source.kind === "server-reading" ? "server reading" : "terminal excerpt"} has expired.</small>}
      {!source.expired && (source.excerpt || segments.length > 0) && <>
        {showFull && <small>{source.kind === "server-reading" ? "Server reading preview" : "Terminal preview"}</small>}
        <pre className="ai-receipt-excerpt">{showFull ? source.excerpt : segments[0] ?? source.excerpt}</pre>
        {showFull && segments.length > 0 && <details>
          <summary>Show sent terminal text ({sentChars.toLocaleString()} characters)</summary>
          {segments.map((segment, i) => <div key={i}>
            {segments.length > 1 && <small>Sent segment {i + 1} of {segments.length}</small>}
            <pre className="ai-receipt-excerpt">{segment}</pre>
          </div>)}
        </details>}
      </>}
    </div>
  );
}

type Receipt = NonNullable<HubReply["answerSources"]>;

export function AnswerSources({ taskId, messageId, count, streaming = false }: {
  taskId: string;
  messageId: string;
  count?: number;
  streaming?: boolean;
}): JSX.Element {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  return (
    <section className="ai-answer-sources" aria-label="Sources for this answer">
      <button type="button" className="ai-code-btn" aria-expanded={open} aria-controls={panelId}
        onClick={() => setOpen(value => !value)}>
        {open ? "Hide sources" : "Show sources"}
      </button>
      {open && <div id={panelId} className="ai-receipt-body">
        {count === undefined ? <small>Source details were not recorded for this answer.</small> :
          <SourceCalls key={taskId + ":" + messageId} taskId={taskId} messageId={messageId} count={count} streaming={streaming} />}
      </div>}
    </section>
  );
}

function SourceCalls({ taskId, messageId, count, streaming }: {
  taskId: string; messageId: string; count: number; streaming: boolean;
}): JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<Receipt | "missing" | "error">();
  useEffect(() => {
    let current = true;
    const session = hubSessionGeneration();
    setResult(undefined);
    void (async () => {
      try {
        const response = await window.multissh.aiHubRequest({ action: "task-read", taskId, detail: "answer-sources", messageId });
        const receipt = response.reply?.answerSources;
        if (current && session === hubSessionGeneration() && hubSessionActive())
          setResult(receipt?.messageId === messageId ? receipt : "missing");
      } catch {
        if (current && session === hubSessionGeneration() && hubSessionActive()) setResult("error");
      }
    })();
    return () => { current = false; };
  }, [taskId, messageId, count, streaming, attempt]);

  if (!result) return <small role="status">Loading sources…</small>;
  if (result === "missing") return <small>Source details are unavailable for this answer.</small>;
  if (result === "error") return <div role="status">Sources could not be loaded. <button type="button" className="ai-code-btn" onClick={() => setAttempt(n => n + 1)}>Retry</button></div>;
  const search = query.trim().toLowerCase();
  const filtering = Boolean(search) || filter !== "all";
  const cited = (callId: string, ref: string) => result.citations.some(c => c.callId === callId && c.ref === ref);
  const visible = result.calls.map((call, index) => ({
    call, index,
    sources: call.sources.filter(s => {
      const type = s.kind.startsWith("kb-") ? "kb" : s.kind;
      if (filter === "cited" ? !cited(call.id, s.ref) : filter !== "all" && filter !== type) return false;
      return !search || [s.label, s.id, s.ref].some(value => value.toLowerCase().includes(search));
    }),
  })).filter(group => !filtering || group.sources.length);
  return (<>
    {result.calls.some(call => call.sources.length) && (
      <div className="ai-receipt-filters">
        <label>Show <select aria-label="Source filter" value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="all">All sources</option><option value="cited">Cited in answer</option>
          <option value="kb">Knowledge base</option><option value="memory">Memories</option><option value="terminal">Terminal excerpts</option>
          <option value="server-reading">Server readings</option>
        </select></label>
        <input type="search" aria-label="Find a source" placeholder="Find by name, ID or reference" value={query} onChange={e => setQuery(e.target.value)} />
      </div>
    )}
    {filtering && !visible.length && <small role="status">No matching sources.</small>}
    <ol className="ai-receipt-calls">
      {visible.map(({call, index, sources}) => <li key={call.id}>
        <div className="ai-receipt-call-heading"><strong>Model call {index + 1}</strong> <Timestamp value={call.at} /></div>
        {call.untracedHistory && <p>Earlier conversation history was sent before source tracking was available.</p>}
        {sources.length ? <ul className="ai-receipt-sources">
          {sources.map(source => <li key={source.ref}>
            <div className="ai-receipt-tag"><code>[{source.ref}]</code> {cited(call.id, source.ref) ? "Cited in answer" : "Included in request"}</div>
            <AnswerSourceDetails source={source} />
          </li>)}
        </ul> : <small>{call.untracedHistory ? "No tracked workspace sources in this request." : "This request included no KB pages, documents, memories, terminal excerpts or server readings."}</small>}
      </li>)}
    </ol>
  </>);
}
