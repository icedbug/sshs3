import { useState } from "react";
import type { EvalExpectation, HubSnapshot } from "@shared/types/aiHub";
import { ConfirmButton } from "./ConfirmButton";
import { type Act } from "./panelShared";
import { isConversation, tokens } from "./workforceModel";

interface Draft {
  id?: string;
  fromTaskId: string;
  title: string;
  mention: string;
  notMention: string;
  mustCall: string;
  mustNotRun: string;
  conclusion: string;
}
const empty: Draft = { fromTaskId: "", title: "", mention: "", notMention: "", mustCall: "", mustNotRun: "", conclusion: "" };
const lines = (s: string): string[] => s.split("\n").map((x) => x.trim()).filter(Boolean);

/**
 * Tests for the agents, made from real conversations. A case is replayed
 * against the agents as they are now, with the tools answering from what was
 * recorded: nothing is run on any system. The knowledge base is the one
 * exception — it is read as it is now, so that changing a page shows in the
 * result, which is usually the point. It shows whether a change to
 * instructions, pages or model made the agents better or worse at the things
 * that actually happened here.
 */
export function AgentTestsView({ hub, act }: { hub: HubSnapshot; act: Act }): JSX.Element {
  const [draft, setDraft] = useState<Draft | undefined>();
  const [openId, setOpenId] = useState("");
  const cases = hub.evalCases ?? [];
  const ran = cases.filter((c) => c.runs.length > 0);
  const passing = ran.filter((c) => c.runs[0].passed).length;
  const better = ran.filter((c) => c.runs[1] && !c.runs[1].passed && c.runs[0].passed).map((c) => c.title);
  const worse = ran.filter((c) => c.runs[1] && c.runs[1].passed && !c.runs[0].passed).map((c) => c.title);
  const conversations = hub.tasks
    .filter((t) => isConversation(t) && !["queued", "running", "waiting"].includes(t.status) && t.messages.some((m) => m.role === "user"))
    .slice(-30)
    .reverse();
  const expectOf = (d: Draft): Partial<EvalExpectation> => ({
    mention: lines(d.mention),
    notMention: lines(d.notMention),
    mustCall: lines(d.mustCall),
    mustNotRun: lines(d.mustNotRun),
    conclusion: d.conclusion.trim() || undefined,
  });

  return (
    <>
      <div className="ai-section-head">
        <h3>
          Agent tests <span className="ai-count">{cases.length}</span>
        </h3>
        <div className="ai-tags">
          {cases.length > 0 && (
            <button
              type="button"
              disabled={Boolean(hub.evalRunning)}
              data-testid="eval-run-all"
              onClick={() => void act({ action: "eval-run" })}
            >
              {hub.evalRunning ? "Running…" : "Run all"}
            </button>
          )}
          <button type="button" className="ai-btn-accent" onClick={() => setDraft(draft ? undefined : { ...empty })}>
            {draft ? "Close" : "New test from a conversation"}
          </button>
        </div>
      </div>
      <p className="ai-hint">
        A test is a real conversation kept with what every tool answered at the time. Running it asks the same
        question of the agents as they are now; the tools answer from the recording and nothing is run on any system.
        The knowledge base is read as it is now, not from the recording, so that changing a page shows here.
        Use it before and after you change an agent&apos;s instructions, a knowledge base page, or the model.
        {ran.length > 0 &&
          ` ${passing} of ${ran.length} passing.${better.length ? ` Better than last time: ${better.join(", ")}.` : ""}${worse.length ? ` Worse than last time: ${worse.join(", ")}.` : ""}`}
      </p>

      {draft && (
        <form
          className="ai-form ai-card"
          data-testid="eval-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.id && !draft.fromTaskId) return;
            void act({
              action: "eval-case-save",
              id: draft.id,
              fromTaskId: draft.id ? undefined : draft.fromTaskId,
              title: draft.title.trim() || undefined,
              expect: expectOf(draft),
            }).then((next) => next && setDraft(undefined));
          }}
        >
          <strong>{draft.id ? "What should happen" : "New test from a conversation"}</strong>
          {!draft.id && (
            <label>
              Conversation
              <select required value={draft.fromTaskId} onChange={(e) => setDraft({ ...draft, fromTaskId: e.target.value })}>
                <option value="">Choose a finished conversation…</option>
                {conversations.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
              <small>Pick one where you know what the right outcome was, whether the agent got there or not.</small>
            </label>
          )}
          <label>
            Name
            <input placeholder="As the conversation" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </label>
          <label>
            The conclusion it should reach (judged by the model)
            <textarea rows={2} placeholder="A scrub running at the same time is what slows the backup." value={draft.conclusion} onChange={(e) => setDraft({ ...draft, conclusion: e.target.value })} />
          </label>
          <div className="ai-form-row">
            <label>
              Must use (a tool or part of a command, one per line)
              <textarea rows={3} className="ai-mono" placeholder={"sshs3_kb_search\nzpool status"} value={draft.mustCall} onChange={(e) => setDraft({ ...draft, mustCall: e.target.value })} />
            </label>
            <label>
              Must never try (part of a command, one per line)
              <textarea rows={3} className="ai-mono" placeholder={"systemctl restart\nzpool scrub -s"} value={draft.mustNotRun} onChange={(e) => setDraft({ ...draft, mustNotRun: e.target.value })} />
            </label>
          </div>
          <div className="ai-form-row">
            <label>
              The answer must mention (one per line)
              <textarea rows={2} value={draft.mention} onChange={(e) => setDraft({ ...draft, mention: e.target.value })} />
            </label>
            <label>
              The answer must not mention (one per line)
              <textarea rows={2} value={draft.notMention} onChange={(e) => setDraft({ ...draft, notMention: e.target.value })} />
            </label>
          </div>
          <div className="ai-card-actions">
            <button type="submit" className="ai-btn-emerald">
              {draft.id ? "Save" : "Make the test"}
            </button>
            <button type="button" onClick={() => setDraft(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {cases.length === 0 && !draft && (
        <p className="ai-empty">
          No tests yet. After an incident where you know what the cause was, make a test of that conversation: from
          then on you can see whether a change makes the agents find it faster, or lose it.
        </p>
      )}

      {cases.map((c) => {
        const run = c.runs[0];
        const open = openId === c.id;
        const expectations = c.expect.mention.length + c.expect.notMention.length + c.expect.mustCall.length + c.expect.mustNotRun.length + (c.expect.conclusion ? 1 : 0);
        return (
          <article className="ai-card" key={c.id} data-testid={`eval-${c.id}`}>
            <div className="ai-card-head">
              <div>
                <strong>{c.title}</strong>
                <small>
                  {c.recordedCalls} recorded tool call{c.recordedCalls === 1 ? "" : "s"} · {expectations} expectation{expectations === 1 ? "" : "s"}
                  {run ? ` · last run ${new Date(run.at).toLocaleString()}${run.model ? ` on ${run.model}` : ""} · ${tokens(run.tokens)} tokens` : " · never run"}
                </small>
              </div>
              <span className={`ai-badge ${hub.evalRunning === c.id ? "" : run ? (run.passed ? "ai-badge-success" : "ai-badge-danger") : ""}`}>
                {hub.evalRunning === c.id ? "running" : run ? (run.passed ? "passed" : "failed") : "not run"}
              </span>
            </div>
            {expectations === 0 && (
              <small className="ai-last-run">It has no expectations yet, so it only shows that the agent reaches an answer. Say what should happen.</small>
            )}
            {run && (
              <ul className="ai-eval-checks">
                {run.checks.map((check, i) => (
                  <li key={i} data-passed={check.passed ? "yes" : "no"}>
                    {check.name}
                    {check.detail ? <small> — {check.detail}</small> : null}
                  </li>
                ))}
                {run.unrecorded > 0 && (
                  <li data-passed="note">
                    {run.unrecorded} tool call{run.unrecorded === 1 ? "" : "s"} had no recording: the agent went somewhere the original conversation did not.
                  </li>
                )}
                {Object.entries(run.live ?? {}).map(([name, count]) => (
                  <li data-passed="note" key={name}>
                    {count} call{count === 1 ? "" : "s"} to {name} were answered by the knowledge base as it is now, not from the recording.
                  </li>
                ))}
              </ul>
            )}
            {open && run && (
              <div className="ai-doc-body">
                <small>What it did: {run.calls.map((x) => x.name).join(" → ") || "no tool calls"}</small>
                <p className="ai-memory-text">{run.answer || "(no answer)"}</p>
              </div>
            )}
            <div className="ai-card-actions">
              <button type="button" className="ai-btn-emerald" disabled={Boolean(hub.evalRunning)} onClick={() => void act({ action: "eval-run", id: c.id })}>
                Run
              </button>
              {run && (
                <button type="button" aria-expanded={open} onClick={() => setOpenId(open ? "" : c.id)}>
                  {open ? "Hide the answer" : "Show the answer"}
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  setDraft({
                    id: c.id,
                    fromTaskId: "",
                    title: c.title,
                    mention: c.expect.mention.join("\n"),
                    notMention: c.expect.notMention.join("\n"),
                    mustCall: c.expect.mustCall.join("\n"),
                    mustNotRun: c.expect.mustNotRun.join("\n"),
                    conclusion: c.expect.conclusion ?? "",
                  })
                }
              >
                What should happen
              </button>
              <span className="ai-spacer" />
              <ConfirmButton label="Delete" confirmLabel="Delete this test?" onConfirm={() => void act({ action: "eval-case-delete", id: c.id })} />
            </div>
          </article>
        );
      })}
    </>
  );
}
