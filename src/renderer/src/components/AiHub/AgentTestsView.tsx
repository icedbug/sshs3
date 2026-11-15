import { useMemo, useState } from "react";
import type { AgentMessage, AgentTask, EvalCase, EvalExpectation, EvalRun, HubSnapshot } from "@shared/types/aiHub";
import { ConfirmButton } from "./ConfirmButton";
import { type Act } from "./panelShared";
import { isConversation, tokens } from "./workforceModel";

export type EvalCaseSummary = Omit<EvalCase, "recorded"> & {
  recordedCalls: number;
  tags?: string[];
  turns?: Array<{ role: "user" | "assistant"; text: string }>;
};

export interface EvalRubricScores {
  correctness: number;
  safety: number;
  efficiency: number;
}

type EvalRunWithExtras = EvalRun & {
  rubric?: Partial<{
    correctness: number;
    safety: number;
    efficiency: number;
    conclusionCorrectness: number;
    toolGroundedness: number;
    trajectorySafety: number;
  }>;
  failureMode?: string;
};

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

const empty: Draft = {
  fromTaskId: "",
  title: "",
  mention: "",
  notMention: "",
  mustCall: "",
  mustNotRun: "",
  conclusion: "",
};

const lines = (s: string): string[] =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

function normalizeRubricScale(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  if (raw <= 1) return Math.round(Math.max(0, Math.min(1, raw)) * 100);
  if (raw <= 5) return Math.round((Math.max(0, Math.min(5, raw)) / 5) * 100);
  return Math.round(Math.max(0, Math.min(100, raw)));
}

/** Extracts 0-100 rubric scores (Correctness / Safety / Efficiency) from a run or its check breakdown. */
export function extractRubricScores(
  run: EvalRun,
  evalCase?: Pick<EvalCaseSummary, "expect">,
): EvalRubricScores {
  const extra = (run as EvalRunWithExtras).rubric;
  if (extra) {
    const corr = extra.correctness ?? extra.conclusionCorrectness;
    const safe = extra.safety ?? extra.trajectorySafety;
    const eff = extra.efficiency ?? extra.toolGroundedness;
    if (corr !== undefined && safe !== undefined && eff !== undefined) {
      return {
        correctness: normalizeRubricScale(corr),
        safety: normalizeRubricScale(safe),
        efficiency: normalizeRubricScale(eff),
      };
    }
  }

  const safetyChecks = run.checks.filter(
    (ch) =>
      ch.name.startsWith("never runs") ||
      ch.name.toLowerCase().includes("safety") ||
      ch.name.toLowerCase().includes("does not mention"),
  );
  const toolChecks = run.checks.filter(
    (ch) =>
      ch.name.startsWith("uses ") ||
      ch.name.toLowerCase().includes("grounded") ||
      ch.name.toLowerCase().includes("order") ||
      ch.name.toLowerCase().includes("max"),
  );
  const correctnessChecks = run.checks.filter(
    (ch) => !safetyChecks.includes(ch) && !toolChecks.includes(ch),
  );

  const ratio = (arr: typeof run.checks, fallback: number): number =>
    arr.length === 0 ? fallback : Math.round((arr.filter((c) => c.passed).length / arr.length) * 100);

  const correctness = run.inconclusive
    ? 0
    : ratio(correctnessChecks, run.passed ? 100 : 50);

  const safety = run.inconclusive
    ? 0
    : safetyChecks.length > 0
      ? ratio(safetyChecks, 100)
      : run.passed || (evalCase?.expect.mustNotRun.length ?? 0) === 0
        ? 100
        : 50;

  let efficiency = run.inconclusive ? 0 : ratio(toolChecks, 100);
  if (!run.inconclusive && run.unrecorded > 0) {
    efficiency = Math.max(0, efficiency - Math.min(40, run.unrecorded * 15));
  }

  return { correctness, safety, efficiency };
}

/** Computes pass@k over conclusive runs (newest first). */
export function computePassAtK(
  runs: EvalRun[],
): { k: number; passed: number; ratePct: number } | undefined {
  const conclusive = runs.filter((r) => !r.inconclusive);
  if (conclusive.length === 0) return undefined;
  const passed = conclusive.filter((r) => r.passed).length;
  return {
    k: conclusive.length,
    passed,
    ratePct: Math.round((passed / conclusive.length) * 100),
  };
}

/** Resolves multi-turn conversation messages associated with an eval case. */
export function getEvalTurns(
  evalCase: EvalCaseSummary,
  tasks: AgentTask[],
): Array<{ id: string; role: AgentMessage["role"]; text: string }> {
  if (evalCase.turns?.length) {
    return evalCase.turns.map((t, i) => ({ id: `turn-${i}`, role: t.role, text: t.text }));
  }
  if (evalCase.fromTaskId) {
    const linked = tasks.find((t) => t.id === evalCase.fromTaskId);
    if (linked && linked.messages.length > 0) {
      return linked.messages.filter((m) => m.role === "user" || m.role === "assistant");
    }
  }
  return [{ id: "prompt-0", role: "user", text: evalCase.prompt }];
}

/** Derives filterable experiment tags for an eval case. */
export function evalCaseTags(evalCase: EvalCaseSummary, hub: HubSnapshot): string[] {
  const tags = new Set<string>();
  for (const t of evalCase.tags ?? []) {
    if (t.trim()) tags.add(t.trim());
  }
  tags.add(`mode:${evalCase.mode}`);
  if (evalCase.agentId) {
    const agent = (hub.agents ?? []).find((a) => a.id === evalCase.agentId);
    if (agent) tags.add(`agent:${agent.name}`);
  }
  const latest = evalCase.runs.find((r) => !r.inconclusive);
  const prev = evalCase.runs.filter((r) => !r.inconclusive)[1];
  if (latest?.model) tags.add(`model:${latest.model}`);
  if (latest && !latest.passed) tags.add("failing");
  if (latest && !latest.passed && prev?.passed) tags.add("regression");
  const turns = getEvalTurns(evalCase, hub.tasks);
  if (turns.filter((m) => m.role === "user").length > 1) tags.add("multi-turn");
  const failureMode = (latest as EvalRunWithExtras | undefined)?.failureMode;
  if (failureMode) tags.add(failureMode);
  return Array.from(tags);
}

/**
 * Tests for the agents, made from real conversations (single- or multi-turn).
 * A case is replayed against the agents as they are now, with the tools answering
 * from what was recorded: nothing is run on any system.
 */
export function AgentTestsView({ hub, act }: { hub: HubSnapshot; act: Act }): JSX.Element {
  const [draft, setDraft] = useState<Draft | undefined>();
  const [openId, setOpenId] = useState("");
  const [selectedTag, setSelectedTag] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [promoteTaskId, setPromoteTaskId] = useState("");

  const cases = useMemo<EvalCaseSummary[]>(
    () => (hub.evalCases ?? []) as EvalCaseSummary[],
    [hub.evalCases],
  );
  // A run that could not take place (the model was not reachable) is neither a pass nor a regression.
  const ran = cases
    .map((c) => ({ title: c.title, runs: c.runs.filter((r) => !r.inconclusive) }))
    .filter((c) => c.runs.length > 0);
  const passing = ran.filter((c) => c.runs[0].passed).length;
  const better = ran.filter((c) => c.runs[1] && !c.runs[1].passed && c.runs[0].passed).map((c) => c.title);
  const worse = ran.filter((c) => c.runs[1] && c.runs[1].passed && !c.runs[0].passed).map((c) => c.title);

  const conversations = hub.tasks
    .filter(
      (t) =>
        isConversation(t) &&
        !["queued", "running", "waiting"].includes(t.status) &&
        t.messages.some((m) => m.role === "user"),
    )
    .slice(-30)
    .reverse();

  const failedTasks = useMemo(
    () =>
      hub.tasks
        .filter(
          (t) =>
            (t.status === "failed" ||
              t.status === "cancelled" ||
              t.status === "interrupted" ||
              t.changes.some((ch) => ch.status === "failed" || ch.status === "uncertain")) &&
            t.messages.some((m) => m.role === "user"),
        )
        .slice(-20)
        .reverse(),
    [hub.tasks],
  );

  const promotedTaskIds = useMemo(
    () => new Set(cases.map((c) => c.fromTaskId).filter((id): id is string => Boolean(id))),
    [cases],
  );

  const caseTagMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const c of cases) {
      map.set(c.id, evalCaseTags(c, hub));
    }
    return map;
  }, [cases, hub]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const tags of caseTagMap.values()) {
      for (const tag of tags) set.add(tag);
    }
    return Array.from(set).sort();
  }, [caseTagMap]);

  const filteredCases = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return cases.filter((c) => {
      const tags = caseTagMap.get(c.id) ?? [];
      if (selectedTag !== "all" && !tags.includes(selectedTag)) return false;
      if (q) {
        const hay = `${c.title} ${c.prompt} ${tags.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [cases, caseTagMap, selectedTag, searchQuery]);

  const activeFailedTaskId = promoteTaskId || failedTasks[0]?.id || "";

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
          <button
            type="button"
            className="ai-btn-accent"
            onClick={() => setDraft(draft ? undefined : { ...empty })}
          >
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

      {failedTasks.length > 0 && (
        <article className="ai-card" data-testid="promote-failed-tasks">
          <div className="ai-card-head">
            <div>
              <strong>Promote failed task to eval suite</strong>
              <small>
                Turn a failed or incomplete incident conversation into a regression test case with its recorded tool
                calls.
              </small>
            </div>
            <span className="ai-badge ai-badge-danger">{failedTasks.length} failed</span>
          </div>
          <div className="ai-inline-form">
            <select
              aria-label="Failed task to promote"
              data-testid="promote-failed-task-select"
              value={activeFailedTaskId}
              onChange={(e) => setPromoteTaskId(e.target.value)}
            >
              {failedTasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title} ({t.status}
                  {promotedTaskIds.has(t.id) ? " · already promoted" : ""})
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ai-btn-emerald"
              data-testid="promote-failed-task-btn"
              disabled={!activeFailedTaskId}
              onClick={() => {
                const task = failedTasks.find((t) => t.id === activeFailedTaskId);
                if (!task) return;
                void act({ action: "promote-eval", taskId: task.id, title: task.title });
              }}
            >
              Promote Failed Task to Eval
            </button>
          </div>
        </article>
      )}

      {cases.length > 0 && (
        <div className="ai-form" data-testid="eval-filters">
          <div className="ai-inline-form">
            <input
              aria-label="Filter tests"
              data-testid="eval-search-input"
              placeholder="Filter eval suites by title, prompt, or experiment tag…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          {allTags.length > 0 && (
            <div className="ai-tags" data-testid="eval-tag-filters">
              <button
                type="button"
                className={`ai-chip ${selectedTag === "all" ? "ai-chip-active" : ""}`}
                onClick={() => setSelectedTag("all")}
              >
                All ({cases.length})
              </button>
              {allTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={`ai-chip ${selectedTag === tag ? "ai-chip-active" : ""}`}
                  onClick={() => setSelectedTag(selectedTag === tag ? "all" : tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

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
              <select
                required
                value={draft.fromTaskId}
                onChange={(e) => setDraft({ ...draft, fromTaskId: e.target.value })}
              >
                <option value="">Choose a finished conversation…</option>
                {conversations.map((t) => {
                  const turnCount = t.messages.filter((m) => m.role === "user").length;
                  return (
                    <option key={t.id} value={t.id}>
                      {t.title} ({turnCount} turn{turnCount === 1 ? "" : "s"})
                    </option>
                  );
                })}
              </select>
              <small>Pick one where you know what the right outcome was, whether the agent got there or not.</small>
            </label>
          )}
          <label>
            Name
            <input
              placeholder="As the conversation"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label>
            The conclusion it should reach (judged by the model)
            <textarea
              rows={2}
              placeholder="A scrub running at the same time is what slows the backup."
              value={draft.conclusion}
              onChange={(e) => setDraft({ ...draft, conclusion: e.target.value })}
            />
          </label>
          <div className="ai-form-row">
            <label>
              Must use (a tool or part of a command, one per line)
              <textarea
                rows={3}
                className="ai-mono"
                placeholder={"sshs3_kb_search\nzpool status"}
                value={draft.mustCall}
                onChange={(e) => setDraft({ ...draft, mustCall: e.target.value })}
              />
            </label>
            <label>
              Must never try (part of a command, one per line)
              <textarea
                rows={3}
                className="ai-mono"
                placeholder={"systemctl restart\nzpool scrub -s"}
                value={draft.mustNotRun}
                onChange={(e) => setDraft({ ...draft, mustNotRun: e.target.value })}
              />
            </label>
          </div>
          <div className="ai-form-row">
            <label>
              The answer must mention (one per line)
              <textarea
                rows={2}
                value={draft.mention}
                onChange={(e) => setDraft({ ...draft, mention: e.target.value })}
              />
            </label>
            <label>
              The answer must not mention (one per line)
              <textarea
                rows={2}
                value={draft.notMention}
                onChange={(e) => setDraft({ ...draft, notMention: e.target.value })}
              />
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

      {cases.length > 0 && filteredCases.length === 0 && (
        <p className="ai-empty">No eval cases match the active tag or search filter.</p>
      )}

      {filteredCases.map((c) => {
        const run = c.runs[0];
        const open = openId === c.id;
        const expectations =
          c.expect.mention.length +
          c.expect.notMention.length +
          c.expect.mustCall.length +
          c.expect.mustNotRun.length +
          (c.expect.conclusion ? 1 : 0);
        const turns = getEvalTurns(c, hub.tasks);
        const userTurnCount = turns.filter((t) => t.role === "user").length;
        const passK = computePassAtK(c.runs);
        const rubric = run && !run.inconclusive ? extractRubricScores(run, c) : undefined;
        const tags = caseTagMap.get(c.id) ?? [];

        return (
          <article className="ai-card" key={c.id} data-testid={`eval-${c.id}`}>
            <div className="ai-card-head">
              <div>
                <strong>{c.title}</strong>
                <small>
                  {c.recordedCalls} recorded tool call{c.recordedCalls === 1 ? "" : "s"} · {expectations} expectation
                  {expectations === 1 ? "" : "s"}
                  {run
                    ? ` · last run ${new Date(run.at).toLocaleString()}${run.model ? ` on ${run.model}` : ""} · ${tokens(run.tokens)} tokens`
                    : " · never run"}
                </small>
              </div>
              <div className="ai-tags">
                {userTurnCount > 1 && (
                  <span className="ai-badge ai-badge-purple" data-testid={`eval-turns-${c.id}`}>
                    Multi-turn ({userTurnCount} turns)
                  </span>
                )}
                {passK && (
                  <span
                    className={`ai-badge ${passK.ratePct === 100 ? "ai-badge-success" : passK.ratePct === 0 ? "ai-badge-danger" : ""}`}
                    data-testid={`eval-passk-${c.id}`}
                    title={`Passed ${passK.passed} of ${passK.k} conclusive runs`}
                  >
                    pass@{passK.k}: {passK.ratePct}%
                  </span>
                )}
                <span
                  className={`ai-badge ${
                    hub.evalRunning === c.id || run?.inconclusive
                      ? ""
                      : run
                        ? run.passed
                          ? "ai-badge-success"
                          : "ai-badge-danger"
                        : ""
                  }`}
                >
                  {hub.evalRunning === c.id
                    ? "running"
                    : run
                      ? run.inconclusive
                        ? "could not run"
                        : run.passed
                          ? "passed"
                          : "failed"
                      : "not run"}
                </span>
              </div>
            </div>

            {tags.length > 0 && (
              <div className="ai-tags">
                {tags.map((tag) => (
                  <span key={tag} className="ai-tool-tag">
                    {tag}
                  </span>
                ))}
              </div>
            )}

            {rubric && (
              <div className="ai-form" data-testid={`eval-rubric-${c.id}`}>
                {(
                  [
                    ["Correctness", rubric.correctness],
                    ["Safety", rubric.safety],
                    ["Efficiency", rubric.efficiency],
                  ] as const
                ).map(([axis, score]) => (
                  <div key={axis} className="ai-inline-form">
                    <small style={{ minWidth: 88 }}>{axis}</small>
                    <div
                      role="progressbar"
                      aria-label={`${axis} score for ${c.title}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={score}
                      style={{
                        flex: 1,
                        height: 6,
                        borderRadius: 999,
                        background: "rgba(148, 163, 184, 0.25)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${score}%`,
                          height: "100%",
                          background:
                            score >= 80 ? "var(--ai-emerald, #10b981)" : score >= 50 ? "#f59e0b" : "#ef4444",
                        }}
                      />
                    </div>
                    <small style={{ minWidth: 36, textAlign: "right" }}>{score}%</small>
                  </div>
                ))}
              </div>
            )}

            {expectations === 0 && (
              <small className="ai-last-run">
                It has no expectations yet, so it only shows that the agent reaches an answer. Say what should happen.
              </small>
            )}
            {run && (
              <ul className="ai-eval-checks">
                {run.inconclusive && (
                  <li data-passed="note">The run could not take place, so nothing was tested: {run.inconclusive}</li>
                )}
                {run.checks.map((check, i) => (
                  <li key={i} data-passed={check.passed ? "yes" : "no"}>
                    {check.name}
                    {check.detail ? <small> — {check.detail}</small> : null}
                  </li>
                ))}
                {run.unrecorded > 0 && (
                  <li data-passed="note">
                    {run.unrecorded} tool call{run.unrecorded === 1 ? "" : "s"} had no recording: the agent went
                    somewhere the original conversation did not.
                  </li>
                )}
                {Object.entries(run.live ?? {}).map(([name, count]) => (
                  <li data-passed="note" key={name}>
                    {count} call{count === 1 ? "" : "s"} to {name} were answered by the knowledge base as it is now, not
                    from the recording.
                  </li>
                ))}
              </ul>
            )}
            {open && run && (
              <div className="ai-doc-body">
                {turns.length > 1 && (
                  <div data-testid={`eval-transcript-${c.id}`}>
                    <small>Recorded conversation ({turns.length} messages):</small>
                    <ul className="ai-eval-checks">
                      {turns.map((turn) => (
                        <li key={turn.id} data-passed="note">
                          <strong>{turn.role}:</strong> {turn.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <small>What it did: {run.calls.map((x) => x.name).join(" → ") || "no tool calls"}</small>
                <p className="ai-memory-text">{run.answer || "(no answer)"}</p>
              </div>
            )}
            <div className="ai-card-actions">
              <button
                type="button"
                className="ai-btn-emerald"
                disabled={Boolean(hub.evalRunning)}
                onClick={() => void act({ action: "eval-run", id: c.id })}
              >
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
              <ConfirmButton
                label="Delete"
                confirmLabel="Delete this test?"
                onConfirm={() => void act({ action: "eval-case-delete", id: c.id })}
              />
            </div>
          </article>
        );
      })}
    </>
  );
}
