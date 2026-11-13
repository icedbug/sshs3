import { useState } from "react";
import type { FactChange, HubSnapshot, ServerFacts, ServerFactsView } from "@shared/types/aiHub";
import type { Act } from "./panelShared";

function ago(at?: number): string {
  if (!at) return "never";
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

const VIA: Record<NonNullable<ServerFactsView["via"]>, string> = {
  "open-tab": "over the open terminal's connection",
  "own-connection": "over a connection of its own",
  local: "on this computer",
  demo: "demo data",
};

const STATUS: Record<ServerFactsView["status"], string> = {
  ok: "",
  never: "Not read yet",
  failed: "Could not be read",
  unsupported: "Not a system this can read",
};

/** Everything that was read from one server, shown when its row is opened. */
function Details({ facts, changes }: { facts?: ServerFacts; changes: FactChange[] }): JSX.Element {
  if (!facts || facts.unsupported)
    return <p className="ai-empty">Nothing to show: the system did not answer what the collection asks.</p>;
  const files = Object.entries(facts.files);
  return (
    <div className="ai-facts-details">
      {changes.length > 0 && (
        <div>
          <strong>What changed here</strong>
          <ul className="ai-facts-changes">
            {changes.slice(0, 40).map((c, i) => (
              <li key={`${c.at}-${i}`}>
                <small>{ago(c.at)}</small> {c.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <strong>Listening</strong>
        {facts.listening.length ? (
          <div className="ai-tags">
            {facts.listening.map((l) => (
              <span className="ai-chip" key={`${l.proto}-${l.port}`}>
                {l.proto}/{l.port}
                {l.process ? ` ${l.process}` : ""}
              </span>
            ))}
          </div>
        ) : (
          <small className="ai-muted"> Nothing seen (the account may not be allowed to see other users' sockets).</small>
        )}
      </div>
      {facts.failedServices.length > 0 && (
        <div>
          <strong>Failed services</strong>
          <div className="ai-tags">
            {facts.failedServices.map((s) => (
              <span className="ai-chip ai-bad" key={s}>
                {s}
              </span>
            ))}
          </div>
        </div>
      )}
      {facts.certs.length > 0 && (
        <div>
          <strong>Certificates</strong>
          <ul className="ai-facts-changes">
            {facts.certs.map((c) => (
              <li key={c.path}>
                {c.path} <small>valid to {new Date(c.notAfter).toISOString().slice(0, 10)}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <strong>Watched files</strong>
        {files.length ? (
          <ul className="ai-facts-changes">
            {files.map(([path, hash]) => (
              <li key={path}>
                {path} <small>{hash === "unreadable" ? "there, but may not be read" : hash.slice(0, 12)}</small>
              </li>
            ))}
          </ul>
        ) : (
          <small className="ai-muted"> None of the watched files exist here.</small>
        )}
      </div>
      <small className="ai-muted">
        {Object.keys(facts.packages ?? {}).length} packages ({facts.packageManager ?? "no package manager found"}),{" "}
        {facts.runningServices.length} running services. The whole list is compared at every reading; only differences are
        shown.
      </small>
    </div>
  );
}

/**
 * What is on the servers and what changed there, read on a schedule without a
 * model. Off until switched on: it runs commands, read-only ones, on servers.
 */
export function ServerFactsCard({ hub, act }: { hub: HubSnapshot; act: Act }): JSX.Element {
  const facts = hub.serverFacts ?? { enabled: false, intervalHours: 6, exclude: [], watchPaths: [], servers: [], collecting: [] };
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, { facts?: ServerFacts; changes: FactChange[] }>>({});
  const [paths, setPaths] = useState<string | null>(null);
  const [allRecent, setAllRecent] = useState(false);
  const everyChange = facts.servers.flatMap((s) => s.changes.map((c) => ({ ...c, server: s.name }))).sort((a, b) => b.at - a.at);
  const recent = everyChange.slice(0, allRecent ? 100 : 10);
  const read = facts.servers.filter((s) => s.status === "ok").length;

  const toggle = (serverId: string): void => {
    if (open === serverId) return setOpen(null);
    setOpen(serverId);
    void act({ action: "server-facts-read", serverId }).then((next) => {
      const reply = next?.reply?.serverFacts;
      if (reply) setDetail((d) => ({ ...d, [serverId]: { facts: reply.facts, changes: reply.changes } }));
    });
  };

  return (
    <article className="ai-card" data-testid="server-facts-card">
      <div className="ai-card-head">
        <div>
          <strong>
            What is on the servers{" "}
            {facts.enabled && (
              <span className="ai-count">
                {read}/{facts.servers.length}
              </span>
            )}
          </strong>
          <small>
            Reads each server on a schedule: system and kernel, packages, services, listening ports, disks, certificates
            and a list of configuration files. Only commands that look; no model is involved. What is different from last
            time is given to an agent that troubleshoots there, and put into an alert's ticket.
          </small>
        </div>
        {facts.enabled && facts.servers.length > 0 && (
          <button type="button" disabled={facts.collecting.length > 0} onClick={() => void act({ action: "facts-collect-now" })}>
            {facts.collecting.length ? `Reading ${facts.collecting.length}…` : "Read all now"}
          </button>
        )}
      </div>

      <div className="ai-switches">
        <label>
          <input
            type="checkbox"
            checked={facts.enabled}
            aria-label="Read facts from the servers"
            onChange={(e) => void act({ action: "facts-configure", enabled: e.target.checked })}
          />
          <span>
            Read the servers on a schedule
            <small>
              Uses the connection of a terminal you have open, or connects on its own with a key or an agent. A server that
              asks for a password, a smartcard or a touch is read only while its terminal is open.
            </small>
          </span>
        </label>
      </div>

      {facts.enabled && (
        <>
          <div className="ai-form ai-form-row">
            <label>
              How often
              <select
                aria-label="Reading interval"
                value={facts.intervalHours}
                onChange={(e) => void act({ action: "facts-configure", intervalHours: Number(e.target.value) })}
              >
                {[1, 3, 6, 12, 24].map((h) => (
                  <option key={h} value={h}>
                    Every {h === 1 ? "hour" : `${h} hours`}
                    {h === 6 ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              More files to watch, one path per line
              <textarea
                aria-label="Extra watched files"
                rows={2}
                placeholder={"/etc/myapp/config.yaml\n/opt/app/conf/*.conf"}
                value={paths ?? facts.watchPaths.join("\n")}
                onChange={(e) => setPaths(e.target.value)}
                onBlur={() => {
                  if (paths === null) return;
                  const list = paths.split("\n").map((p) => p.trim()).filter(Boolean);
                  void act({ action: "facts-configure", watchPaths: list }).then((next) => next && setPaths(null));
                }}
              />
            </label>
          </div>

          {recent.length > 0 && (
            <div data-testid="facts-recent">
              <strong>Changed recently</strong>
              <ul className="ai-facts-changes">
                {recent.map((c, i) => (
                  <li key={`${c.server}-${c.at}-${i}`}>
                    <small>{ago(c.at)}</small> <b>{c.server}</b> {c.text}
                  </li>
                ))}
              </ul>
              {everyChange.length > 10 && (
                <button type="button" className="ai-link-button" onClick={() => setAllRecent((v) => !v)}>
                  {allRecent ? "Show fewer" : `Show all ${Math.min(everyChange.length, 100)}`}
                </button>
              )}
            </div>
          )}

          <div className="ai-rows">
            {facts.servers.map((s) => {
              const left = facts.exclude.includes(s.serverId);
              const busy = facts.collecting.includes(s.serverId);
              return (
                <div key={s.serverId} className="ai-facts-server" data-testid={`facts-server-${s.serverId}`}>
                  <div className="ai-row">
                    <div>
                      <strong>{s.name}</strong>{" "}
                      {left ? (
                        <span className="ai-chip">left alone</span>
                      ) : s.status === "ok" ? (
                        <small className="ai-muted">
                          {s.os ?? "unknown system"}
                          {s.kernel ? ` · ${s.kernel}` : ""}
                        </small>
                      ) : (
                        <span className={`ai-chip ${s.status === "failed" ? "ai-bad" : ""}`}>{STATUS[s.status]}</span>
                      )}
                      {!left && s.status === "ok" && (
                        <small>
                          {s.packages} packages · {s.services} services · {s.listening} listening
                          {s.bootAt ? ` · up since ${ago(s.bootAt)}` : ""}
                          {s.rebootRequired ? " · restart required" : ""} · read {ago(s.collectedAt)}
                          {s.via ? `, ${VIA[s.via]}` : ""}
                        </small>
                      )}
                      {!left && s.status === "failed" && <small className="ai-bad">{s.error}</small>}
                      {!left && (s.disks?.length || s.problems.length) ? (
                        <div className="ai-tags">
                          {s.problems.map((p) => (
                            <span key={p.key} className={`ai-badge ${p.severity === "critical" ? "ai-badge-danger" : "ai-badge-mode"}`}>
                              {p.text}
                            </span>
                          ))}
                          {(s.disks ?? [])
                            .filter((d) => d.usedPct < 90)
                            .slice(0, 4)
                            .map((d) => (
                              <span className="ai-chip" key={d.mount}>
                                {d.mount} {d.usedPct} %
                              </span>
                            ))}
                        </div>
                      ) : null}
                    </div>
                    <div className="ai-card-actions">
                      {!left && (s.status === "ok" || (s.status === "failed" && s.collectedAt)) && (
                        <button type="button" aria-expanded={open === s.serverId} onClick={() => toggle(s.serverId)}>
                          {open === s.serverId ? "Close" : "Details"}
                        </button>
                      )}
                      {!left && (
                        <button type="button" disabled={busy} onClick={() => void act({ action: "facts-collect-now", serverId: s.serverId })}>
                          {busy ? "Reading…" : "Read now"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          void act({
                            action: "facts-configure",
                            exclude: left ? facts.exclude.filter((id) => id !== s.serverId) : [...facts.exclude, s.serverId],
                          })
                        }
                      >
                        {left ? "Read this one too" : "Leave alone"}
                      </button>
                    </div>
                  </div>
                  {open === s.serverId && <Details facts={detail[s.serverId]?.facts} changes={detail[s.serverId]?.changes ?? s.changes} />}
                </div>
              );
            })}
          </div>
          {facts.servers.length === 0 && <p className="ai-empty">No servers in the workspace yet.</p>}
        </>
      )}
    </article>
  );
}
