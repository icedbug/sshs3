import { useState } from "react";
import { selectAiTerminal } from "../../../lib/aiHub";
import { ConfirmButton } from "../ConfirmButton";
import type { PanelState } from "./usePanelState";

const KIND: Record<string, string> = {
  resolved: "checks that the trouble is gone",
  "root-cause": "checks that the cause is fixed",
  "no-damage": "checks that nothing was broken on the way",
  report: "checks the report",
};

function verdict(check: { kind: string; pass: boolean }): string {
  if (check.kind === "no-damage") return check.pass ? "ok so far" : "broken";
  return check.pass ? "pass" : "not yet";
}

/**
 * Persistent demo lab scenario bar: stays visible across every tab in demo mode so a user can
 * launch an incident, jump to its terminal or ticket, check live server verdicts, and run
 * scripted walkthroughs without an AI model.
 */
export function ScenarioBar({ p }: { p: PanelState }): JSX.Element | null {
  const { hub, act, mode, setMode, setView, setWorkforceTicketId } = p;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const [busy, setBusy] = useState("");

  if (!hub?.demoMode || !hub.simulation) return null;
  const sim = hub.simulation;
  const running = sim.running;

  const startScenario = (scenarioId: string): void => {
    setBusy(`start:${scenarioId}`);
    void act({ action: "sim-start", scenarioId }).finally(() => {
      setBusy("");
      setPickerOpen(false);
    });
  };

  const runReplay = (replayMode: "careful" | "careless"): void => {
    setBusy(`replay:${replayMode}`);
    void act({ action: "sim-replay", mode: replayMode }).finally(() => setBusy(""));
  };

  const openTargetTerminal = (): void => {
    if (!running) return;
    const matchServer =
      running.servers?.find((s) => s.name.toLowerCase() === running.target.toLowerCase()) ??
      running.servers?.[0] ??
      (hub.workspaceServers ?? []).find((s) => s.name.toLowerCase() === running.target.toLowerCase());
    const serverId = matchServer?.id ?? running.target;
    const existing = hub.sessions.find(
      (s) =>
        s.state !== "disconnected" &&
        (s.id === serverId || s.label.toLowerCase().includes(running.target.toLowerCase())),
    );
    if (existing) {
      selectAiTerminal(existing.id);
    } else {
      window.dispatchEvent(new CustomEvent("sshs3:open-cluster-split", { detail: { serverIds: [serverId] } }));
    }
    if (mode === "hub") setMode("panel");
  };

  if (!running) {
    return (
      <section className="ai-scenario-bar" data-testid="demo-scenario-bar" aria-label="Demo lab incidents">
        <div className="ai-scenario-bar-row">
          <span className="ai-scenario-bar-title">
            Demo lab: {sim.scenarios.length} realistic incident{sim.scenarios.length === 1 ? "" : "s"} ready
          </span>
          <button
            type="button"
            className="ai-chip"
            aria-expanded={pickerOpen}
            data-testid="scenario-bar-picker-toggle"
            onClick={() => setPickerOpen((v) => !v)}
          >
            {pickerOpen ? "Hide incidents" : "Pick an incident"}
          </button>
        </div>
        {pickerOpen && (
          <div className="ai-scenario-bar-drawer" data-testid="scenario-bar-picker">
            <ul className="ai-link-list">
              {sim.scenarios.map((s) => (
                <li key={s.id} className="ai-link">
                  <span>
                    <strong>{s.title}</strong>
                    {s.target && <small> · {s.target}</small>}
                    {(s.tags ?? []).length > 0 && (
                      <span className="ai-tag-list">
                        {s.tags!.map((tag) => (
                          <span key={tag} className="ai-badge">
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                    <br />
                    <small>{s.prompt}</small>
                  </span>
                  <button
                    type="button"
                    className="ai-btn-accent"
                    disabled={Boolean(busy)}
                    data-testid={`scenario-bar-start-${s.id}`}
                    onClick={() => startScenario(s.id)}
                  >
                    {busy === `start:${s.id}` ? "Starting…" : "Start"}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    );
  }

  const solved = running.total > 0 && running.passed === running.total;

  return (
    <section className="ai-scenario-bar ai-scenario-bar-running" data-testid="demo-scenario-bar" aria-label="Active demo incident">
      <div className="ai-scenario-bar-row">
        <div className="ai-scenario-bar-meta">
          <strong className="ai-scenario-bar-title" title={running.title}>
            {running.title}
          </strong>
          <span
            className={`ai-badge ${solved ? "ai-badge-success" : ""}`}
            data-testid="scenario-bar-score"
          >
            {solved ? "Solved" : `${running.passed} of ${running.total} checks pass`}
          </span>
          <small className="ai-mono" data-testid="scenario-bar-target">
            {running.target}
          </small>
        </div>
        <div className="ai-scenario-bar-actions">
          <button
            type="button"
            className="ai-chip"
            data-testid="scenario-bar-open-terminal"
            onClick={openTargetTerminal}
          >
            Open terminal
          </button>
          {running.ticketId && (
            <button
              type="button"
              className="ai-chip"
              data-testid="scenario-bar-open-ticket"
              onClick={() => {
                setWorkforceTicketId(running.ticketId);
                setView("Workforce");
              }}
            >
              Open ticket
            </button>
          )}
          <button
            type="button"
            className={`ai-chip ${checksOpen ? "ai-context-chip-active" : ""}`}
            aria-expanded={checksOpen}
            data-testid="scenario-bar-checks-toggle"
            onClick={() => setChecksOpen((v) => !v)}
          >
            {checksOpen ? "Hide checks" : "Checks"}
          </button>
        </div>
      </div>

      {checksOpen && (
        <div className="ai-scenario-bar-drawer" data-testid="scenario-bar-drawer">
          <ul className="ai-link-list" data-testid="scenario-bar-checks">
            {running.checks.map((c) => (
              <li key={c.id} className="ai-link" data-pass={c.pass}>
                <span>
                  <span className={`ai-badge ${c.pass ? "ai-badge-success" : "ai-badge-danger"}`}>{verdict(c)}</span>{" "}
                  <strong>{c.title}</strong>
                  <small> · {KIND[c.kind] ?? c.kind}</small>
                  <br />
                  <small>{c.why}</small>
                </span>
              </li>
            ))}
          </ul>
          <div className="ai-card-actions">
            <button
              type="button"
              className="ai-btn-accent"
              disabled={Boolean(busy)}
              data-testid="scenario-bar-replay-careful"
              onClick={() => runReplay("careful")}
            >
              {busy === "replay:careful" ? "Running…" : "Watch careful fix (no model)"}
            </button>
            <button
              type="button"
              disabled={Boolean(busy)}
              data-testid="scenario-bar-replay-careless"
              onClick={() => runReplay("careless")}
            >
              {busy === "replay:careless" ? "Running…" : "Watch careless trap (no model)"}
            </button>
            <button
              type="button"
              disabled={Boolean(busy)}
              data-testid="scenario-bar-restart"
              onClick={() => startScenario(running.id)}
            >
              {busy === `start:${running.id}` ? "Starting…" : "Start over"}
            </button>
            <ConfirmButton
              label="End"
              confirmLabel="End incident?"
              className=""
              onConfirm={() => {
                setChecksOpen(false);
                void act({ action: "sim-reset" });
              }}
            />
          </div>
          {running.lastReplay && (
            <div className="ai-scenario-replay" data-testid="scenario-bar-replay-transcript">
              <small className="ai-hint">
                Scripted walkthrough (no AI model): {running.lastReplay.mode} · {running.lastReplay.ran} command
                {running.lastReplay.ran === 1 ? "" : "s"}
              </small>
              <pre className="ai-code-pre">{running.lastReplay.lines.join("\n")}</pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
