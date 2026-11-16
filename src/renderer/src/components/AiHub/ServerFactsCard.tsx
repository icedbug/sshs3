import { useState } from "react";
import type { FactChange, HubSnapshot, ServerFacts, ServerFactsView } from "@shared/types/aiHub";
import type { Act } from "./panelShared";

export type ResourceSeverityClass = "ai-bar-ok" | "ai-bar-warning" | "ai-bar-critical";

export type ServerFactsEntry = ServerFactsView & {
  cpuPct?: number | null;
  memPct?: number | null;
  ramPct?: number | null;
  psi?: { cpu?: number; mem?: number; io?: number } | string;
  oomKills?: number;
  oomCount?: number;
  oomDetected?: boolean;
};

export interface QuickDiagnosticTemplate {
  id: string;
  label: string;
  command: string;
  description: string;
}

export const QUICK_DIAGNOSTIC_TEMPLATES: QuickDiagnosticTemplate[] = [
  {
    id: "journalctl-err",
    label: "journalctl -p err",
    command: "journalctl -p err -n 100 --no-pager",
    description: "Recent system errors from systemd journal",
  },
  {
    id: "dmesg",
    label: "dmesg -T",
    command: "dmesg -T | tail -n 80",
    description: "Timestamped kernel ring buffer (OOM, I/O, hardware)",
  },
  {
    id: "ss",
    label: "ss -tulpn",
    command: "ss -tulpn",
    description: "Listening TCP/UDP sockets and owning processes",
  },
  {
    id: "mem-psi",
    label: "free & PSI",
    command: "free -m && head -n 5 /proc/pressure/*",
    description: "Memory usage and Linux PSI pressure stall metrics",
  },
  {
    id: "disk-inodes",
    label: "df -hT & inodes",
    command: "df -hT && df -Pi",
    description: "Filesystem capacity and inode exhaustion check",
  },
];

/** Returns CSS severity class for a 0-100 resource percentage (`>=90` critical, `>=75` warning). */
export function resourceSeverityClass(pct: number): ResourceSeverityClass {
  if (pct >= 90) return "ai-bar-critical";
  if (pct >= 75) return "ai-bar-warning";
  return "ai-bar-ok";
}

/** True when collected facts are older than `2 * intervalHours` (minimum 2 hours). */
export function isFactsStale(
  collectedAt: number | undefined,
  intervalHours: number,
  now = Date.now(),
): boolean {
  if (!collectedAt) return false;
  const maxAgeMs = Math.max(intervalHours, 1) * 2 * 3_600_000;
  return now - collectedAt > maxAgeMs;
}

function resourceBarColor(cls: ResourceSeverityClass): string {
  if (cls === "ai-bar-critical") return "#f43f5e";
  if (cls === "ai-bar-warning") return "#f59e0b";
  return "#10b981";
}

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

function formatPsiBadge(psi: ServerFactsEntry["psi"], problems: ServerFactsView["problems"]): string | null {
  if (typeof psi === "string" && psi.trim()) return `PSI pressure: ${psi.trim()}`;
  if (psi && typeof psi === "object") {
    const parts: string[] = [];
    if (typeof psi.cpu === "number" && psi.cpu > 0) parts.push(`cpu ${psi.cpu.toFixed(1)}%`);
    if (typeof psi.mem === "number" && psi.mem > 0) parts.push(`mem ${psi.mem.toFixed(1)}%`);
    if (typeof psi.io === "number" && psi.io > 0) parts.push(`io ${psi.io.toFixed(1)}%`);
    if (parts.length > 0) return `PSI pressure: ${parts.join(" · ")}`;
  }
  const psiProblem = problems.find((p) => /\bpsi\b|pressure/i.test(p.text) || /psi/i.test(p.key));
  return psiProblem ? `PSI pressure: ${psiProblem.text}` : null;
}

function formatOomBadge(server: ServerFactsEntry): string | null {
  const count = server.oomKills ?? server.oomCount;
  if (typeof count === "number" && count > 0) return `OOM alert ×${count}`;
  if (server.oomDetected) return "OOM alert";
  const oomProblem = server.problems.find((p) => /\boom\b|out of memory/i.test(p.text) || /oom/i.test(p.key));
  return oomProblem ? `OOM alert: ${oomProblem.text}` : null;
}

function ResourceMeter({
  label,
  pct,
  testId,
}: {
  label: string;
  pct: number;
  testId?: string;
}): JSX.Element {
  const clamped = Math.min(100, Math.max(0, Math.round(pct)));
  const severity = resourceSeverityClass(clamped);
  const color = resourceBarColor(severity);
  return (
    <div
      className={`ai-resource-bar ${severity}`}
      data-testid={testId}
      style={{ display: "grid", gap: 2, minWidth: 110 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
        <span>{label}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          height: 5,
          borderRadius: 999,
          background: "rgba(148, 163, 184, 0.22)",
          overflow: "hidden",
        }}
      >
        <div
          className={`ai-resource-fill ${severity}`}
          style={{
            width: `${clamped}%`,
            height: "100%",
            backgroundColor: color,
            borderRadius: 999,
          }}
        />
      </div>
    </div>
  );
}

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
      <div data-testid="facts-disks">
        <strong>Disks</strong>
        {facts.disks?.length ? (
          <ul className="ai-facts-changes">
            {facts.disks.map((d) => (
              <li key={d.mount}>
                {d.mount} <small>{d.usedPct} % used</small>
              </li>
            ))}
          </ul>
        ) : (
          <small className="ai-muted"> None were read.</small>
        )}
      </div>
      {/* Said also when there are none: a missing heading does not tell whether it was looked at. */}
      <div data-testid="facts-failed-services">
        {facts.failedServices.length > 0 ? (
          <>
            <strong>Failed services</strong>
            <div className="ai-tags">
              {facts.failedServices.map((s) => (
                <span className="ai-chip ai-bad" key={s}>
                  {s}
                </span>
              ))}
            </div>
          </>
        ) : (
          <span>Failed services: none</span>
        )}
      </div>
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
export function ServerFactsCard({
  hub,
  act,
  onRunDiagnostic,
}: {
  hub: HubSnapshot;
  act: Act;
  onRunDiagnostic?: (command: string, server: ServerFactsView, templateId: string) => void;
}): JSX.Element {
  const facts = hub.serverFacts ?? { enabled: false, intervalHours: 6, exclude: [], watchPaths: [], servers: [], collecting: [] };
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, { facts?: ServerFacts; changes: FactChange[] }>>({});
  const [paths, setPaths] = useState<string | null>(null);
  const [allRecent, setAllRecent] = useState(false);
  const [staged, setStaged] = useState<{ serverId: string; label: string; command: string } | null>(null);
  const everyChange = facts.servers.flatMap((s) => s.changes.map((c) => ({ ...c, server: s.name }))).sort((a, b) => b.at - a.at);
  const recent = everyChange.slice(0, allRecent ? 100 : 10);
  const read = facts.servers.filter((s) => s.status === "ok").length;
  const isDemoLab = Boolean(hub.demoMode || facts.servers.some((s) => s.demo || s.via === "demo"));

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
            {isDemoLab && (
              <span className="ai-badge" data-testid="facts-demo-badge" style={{ marginLeft: 8 }}>
                Demo lab (simulated)
              </span>
            )}
          </strong>
          <small>
            Reads each server on a schedule: system and kernel, packages, services, listening ports, disks, certificates
            and a list of configuration files. Only commands that look; no model is involved. What is different from last
            time is given to an agent that troubleshoots there, and put into an alert&apos;s ticket.
          </small>
          {isDemoLab && (
            <small className="ai-hint" data-testid="facts-demo-note" style={{ display: "block", marginTop: 4 }}>
              Simulated demo readings. Real servers are read with read-only commands over SSH.
            </small>
          )}
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
      {!facts.enabled && (
        <p className="ai-hint" data-testid="facts-off-note">
          Off. Nothing is read from your servers until you switch this on. It runs read-only commands only.
        </p>
      )}

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
            {facts.servers.map((rawServer) => {
              const s = rawServer as ServerFactsEntry;
              const left = facts.exclude.includes(s.serverId);
              const busy = facts.collecting.includes(s.serverId);
              const ramPct = s.memPct ?? s.ramPct;
              const hasCpu = typeof s.cpuPct === "number" && Number.isFinite(s.cpuPct);
              const hasRam = typeof ramPct === "number" && Number.isFinite(ramPct);
              const disks = (s.disks ?? []).slice(0, 4);
              const hasResources = !left && (hasCpu || hasRam || disks.length > 0);
              const psiText = !left ? formatPsiBadge(s.psi, s.problems) : null;
              const oomText = !left ? formatOomBadge(s) : null;
              const stale = !left && s.status === "ok" && isFactsStale(s.collectedAt, facts.intervalHours);

              return (
                <div key={s.serverId} className="ai-facts-server" data-testid={`facts-server-${s.serverId}`}>
                  <div className="ai-row">
                    <div style={{ flex: 1, minWidth: 0 }}>
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
                      {stale && (
                        <span
                          className="ai-badge ai-badge-mode"
                          data-testid={`facts-stale-${s.serverId}`}
                          style={{ marginLeft: 6 }}
                          title={`Last read ${ago(s.collectedAt)}; interval is ${facts.intervalHours}h`}
                        >
                          Stale · {ago(s.collectedAt)}
                        </span>
                      )}
                      {(s.demo || s.via === "demo") && (
                        <span
                          className="ai-badge"
                          data-testid={`facts-demo-${s.serverId}`}
                          style={{ marginLeft: 6 }}
                          title="Simulated demo server reading, not collected over SSH"
                        >
                          Demo (simulated)
                        </span>
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

                      {(!left && (s.problems.length > 0 || psiText || oomText)) && (
                        <div className="ai-tags" style={{ marginTop: 4 }}>
                          {psiText && (
                            <span className="ai-badge ai-badge-mode" data-testid={`facts-psi-${s.serverId}`}>
                              {psiText}
                            </span>
                          )}
                          {oomText && (
                            <span className="ai-badge ai-badge-danger" data-testid={`facts-oom-${s.serverId}`}>
                              {oomText}
                            </span>
                          )}
                          {s.problems.map((p) => (
                            <span key={p.key} className={`ai-badge ${p.severity === "critical" ? "ai-badge-danger" : "ai-badge-mode"}`}>
                              {p.text}
                            </span>
                          ))}
                        </div>
                      )}

                      {hasResources && (
                        <div
                          className="ai-tags"
                          data-testid={`facts-resources-${s.serverId}`}
                          style={{ marginTop: 6, gap: 10 }}
                        >
                          {hasCpu && (
                            <ResourceMeter
                              label={`CPU ${Math.round(s.cpuPct!)}%`}
                              pct={s.cpuPct!}
                              testId={`facts-bar-cpu-${s.serverId}`}
                            />
                          )}
                          {hasRam && (
                            <ResourceMeter
                              label={`RAM ${Math.round(ramPct!)}%`}
                              pct={ramPct!}
                              testId={`facts-bar-ram-${s.serverId}`}
                            />
                          )}
                          {disks.map((d) => (
                            <ResourceMeter
                              key={d.mount}
                              label={`${d.mount} ${d.usedPct} %`}
                              pct={d.usedPct}
                              testId={`facts-bar-disk-${s.serverId}-${d.mount}`}
                            />
                          ))}
                        </div>
                      )}

                      {!left && s.status !== "unsupported" && (
                        <div
                          className="ai-tags"
                          data-testid={`facts-diag-${s.serverId}`}
                          style={{ marginTop: 6 }}
                        >
                          <small className="ai-muted">Quick diagnostics:</small>
                          {QUICK_DIAGNOSTIC_TEMPLATES.map((tpl) => (
                            <button
                              key={tpl.id}
                              type="button"
                              className="ai-chip ai-mono"
                              title={`${tpl.description}: ${tpl.command}`}
                              data-testid={`facts-diag-btn-${s.serverId}-${tpl.id}`}
                              onClick={() => {
                                setStaged({ serverId: s.serverId, label: tpl.label, command: tpl.command });
                                onRunDiagnostic?.(tpl.command, s, tpl.id);
                              }}
                            >
                              {tpl.label}
                            </button>
                          ))}
                        </div>
                      )}

                      {staged && staged.serverId === s.serverId && (
                        <small className="ai-hint" role="status" data-testid={`facts-staged-${s.serverId}`}>
                          Staged diagnostic ({staged.label}): <code className="ai-mono">{staged.command}</code>
                        </small>
                      )}
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
