import { useState } from "react";
import type { HubSnapshot } from "@shared/types/aiHub";
import { ConfirmButton } from "./ConfirmButton";
import type { Act } from "./panelShared";

const KIND: Record<string, string> = {
  resolved: "checks that the trouble is gone",
  "root-cause": "checks that the cause is fixed",
  "no-damage": "checks that nothing was broken on the way",
  report: "checks the report",
};

/** A check for damage passes from the start: "pass" there would read as progress. */
function verdict(check: { kind: string; pass: boolean }): string {
  if (check.kind === "no-damage") return check.pass ? "ok so far" : "broken";
  return check.pass ? "pass" : "not yet";
}

/**
 * The demo lab's incidents: pick one, start it, and see how it stands while an
 * agent or you work on it. The servers are simulated and hold state; the
 * checks are read off them, not judged by a model.
 */
export function ScenariosCard({
  hub,
  act,
  onOpenTicket,
  onOpenTerminal,
}: {
  hub: HubSnapshot;
  act: Act;
  onOpenTicket?: (ticketId: string) => void;
  onOpenTerminal?: (serverId: string) => void;
}): JSX.Element | null {
  const sim = hub.simulation;
  const [busy, setBusy] = useState("");
  const [shownStory, setShownStory] = useState("");
  if (!sim) return null;
  const running = sim.running;
  const start = (scenarioId: string): void => {
    setBusy(scenarioId);
    void act({ action: "sim-start", scenarioId }).finally(() => setBusy(""));
  };
  const replay = (mode: "careful" | "careless"): void => {
    setBusy(`replay:${mode}`);
    void act({ action: "sim-replay", mode }).finally(() => setBusy(""));
  };
  const openTerminal = (): void => {
    if (!running) return;
    const matchServer =
      running.servers?.find((s) => s.name.toLowerCase() === running.target.toLowerCase()) ??
      running.servers?.[0] ??
      (hub.workspaceServers ?? []).find((s) => s.name.toLowerCase() === running.target.toLowerCase());
    const serverId = matchServer?.id ?? running.target;
    if (onOpenTerminal) {
      onOpenTerminal(serverId);
    } else {
      window.dispatchEvent(new CustomEvent("sshs3:open-cluster-split", { detail: { serverIds: [serverId] } }));
    }
  };
  return (
    <details className="ai-fold ai-set-fold" data-testid="scenarios" open={Boolean(running)}>
      <summary>
        {running ? `Scenario · ${running.title} · ${running.passed === running.total ? "solved" : "not solved yet"} · ${running.passed} of ${running.total} checks pass` : `Scenarios · ${sim.scenarios.length} incident${sim.scenarios.length === 1 ? "" : "s"} to play in the demo lab`}
      </summary>
      <div className="ai-form">
        <p className="ai-hint">
          An incident in the demo lab: simulated servers with a real fault in them, what the team wrote about it in chat, and the
          alert that reports it. Commands run against the servers&apos; state, so the fault is there until it is fixed, and a careless
          fix leaves its marks. The checks below are read off the servers, not judged by a model.
        </p>
        {running ? (
          <>
            {(running.tags ?? []).length > 0 && (
              <div className="ai-tag-list" data-testid="scenario-running-tags">
                {running.tags!.map((tag) => (
                  <span key={tag} className="ai-badge">
                    {tag}
                  </span>
                ))}
              </div>
            )}
            <ul className="ai-link-list" data-testid="scenario-checks">
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
            <small className="ai-hint">
              Work starts on <strong>{running.target}</strong>: open a terminal to it, or start the alert&apos;s ticket.{" "}
              {running.commands} command{running.commands === 1 ? "" : "s"} run so far.
            </small>
            {running.unsupported.length > 0 && (
              <small className="ai-hint" data-testid="scenario-unsupported">
                Asked for and not simulated: <span className="ai-mono">{running.unsupported.join(" · ")}</span>
              </small>
            )}
            <div className="ai-card-actions">
              <button type="button" data-testid="scenario-open-terminal" onClick={openTerminal}>
                Open terminal
              </button>
              {running.ticketId && onOpenTicket && (
                <button type="button" className="ai-btn-accent" onClick={() => onOpenTicket(running.ticketId!)}>
                  Open the alert&apos;s ticket
                </button>
              )}
              <button
                type="button"
                disabled={Boolean(busy)}
                data-testid="scenario-replay-careful"
                onClick={() => replay("careful")}
              >
                {busy === "replay:careful" ? "Running…" : "Watch careful fix (no model)"}
              </button>
              <button
                type="button"
                disabled={Boolean(busy)}
                data-testid="scenario-replay-careless"
                onClick={() => replay("careless")}
              >
                {busy === "replay:careless" ? "Running…" : "Watch careless trap (no model)"}
              </button>
              <button type="button" disabled={Boolean(busy)} onClick={() => start(running.id)}>
                {busy === running.id ? "Starting…" : "Start it over"}
              </button>
              <ConfirmButton label="End the scenario" confirmLabel="Remove its servers and ticket?" className="" onConfirm={() => void act({ action: "sim-reset" })} />
            </div>
            {running.lastReplay && (
              <div className="ai-scenario-replay" data-testid="scenario-replay-transcript">
                <small className="ai-hint">
                  Scripted walkthrough (no AI model): {running.lastReplay.mode} · {running.lastReplay.ran} command
                  {running.lastReplay.ran === 1 ? "" : "s"}
                </small>
                <pre className="ai-code-pre">{running.lastReplay.lines.join("\n")}</pre>
              </div>
            )}
          </>
        ) : (
          <ul className="ai-link-list" data-testid="scenario-list">
            {sim.scenarios.map((s) => (
              <li key={s.id} className="ai-link">
                <span>
                  <strong>{s.title}</strong>
                  {s.target && <small> · {s.target}</small>}
                  {(s.tags ?? []).length > 0 && (
                    <span className="ai-tag-list" data-testid={`scenario-tags-${s.id}`}>
                      {s.tags!.map((tag) => (
                        <span key={tag} className="ai-badge">
                          {tag}
                        </span>
                      ))}
                    </span>
                  )}
                  {/* The story names the cause and the fix: hidden until asked for, so a person can try it first. */}
                  <br />
                  <button
                    type="button"
                    className="ai-chip"
                    aria-expanded={shownStory === s.id}
                    data-testid={`scenario-spoiler-${s.id}`}
                    onClick={() => setShownStory(shownStory === s.id ? "" : s.id)}
                  >
                    {shownStory === s.id ? "Hide what is wrong" : "Show what is wrong (spoiler)"}
                  </button>
                  {shownStory === s.id && (
                    <>
                      <br />
                      <small data-testid={`scenario-story-${s.id}`}>{s.story}</small>
                    </>
                  )}
                </span>
                <button type="button" className="ai-btn-accent" disabled={Boolean(busy)} data-testid={`scenario-start-${s.id}`} onClick={() => start(s.id)}>
                  {busy === s.id ? "Starting…" : "Start"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
