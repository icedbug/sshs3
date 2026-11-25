import { nextCronTime } from "@shared/scheduleTiming";
import { useMemo, useState } from "react";
import {
  SHELL_KINDS,
  type AgentMode,
  type AgentSchedule,
  type HubSnapshot,
  type ScheduleEventTrigger,
  type ShellKind,
} from "@shared/types/aiHub";
import { ConfirmButton } from "./ConfirmButton";
import { isWebBrowserMode } from "../../lib/webClientBridge";
import { type Act } from "./panelShared";

interface Draft {
  id?: string;
  title: string;
  prompt: string;
  profileId: string;
  shell: ShellKind;
  minutes: number;
  mode: AgentMode;
  timingMode: "interval" | "cron";
  cron: string;
  timezone: string;
  missedPolicy: "skip" | "run_once";
  quietSentinel: boolean;
  eventKind: "" | ScheduleEventTrigger["kind"];
  eventCooldownMinutes: number;
  runbookId: string;
}

export const SCHEDULE_MODES: Record<AgentMode, string> = {
  advice: "Reports only: runs no commands",
  plan: "Plans first: proposes a plan before a change",
  assisted: "Runs commands. A change card or a file write waits for you",
  autonomous: "Runs commands and change cards on its own",
};

export const QUIET_SENTINEL_PRESET = {
  title: "Health check that tells you only when something is wrong",
  prompt:
    "Check disk space, failed services, memory pressure, and recent errors. If everything is healthy, reply strictly with HEARTBEAT_OK and nothing else. Notify only when an anomaly is found.",
  minutes: 15,
  mode: "advice" as AgentMode,
  quietSentinel: true,
  eventKind: "facts_drift" as ScheduleEventTrigger["kind"],
  eventCooldownMinutes: 30,
};

/** Validates a standard 5-field cron expression (minute hour dom month dow). */
export function isValidCronExpression(expr: string): boolean {
  try {
    nextCronTime(expr, "UTC", Date.now());
    return true;
  } catch {
    return false;
  }
}

const emptyDraft: Draft = {
  title: "",
  prompt: "",
  profileId: "local",
  shell: "bash",
  minutes: 60,
  mode: "advice",
  timingMode: "interval",
  cron: "0 7 * * *",
  timezone: "UTC",
  missedPolicy: "skip",
  quietSentinel: false,
  eventKind: "",
  eventCooldownMinutes: 30,
  runbookId: "",
};

const INTERVALS: [number, string][] = [
  [15, "Every 15 minutes"],
  [60, "Every hour"],
  [360, "Every 6 hours"],
  [1440, "Every day"],
  [10080, "Every week"],
];

const TIMEZONES = [
  "UTC",
  "Europe/Stockholm",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Tokyo",
];

const EVENT_TRIGGERS: { kind: "" | ScheduleEventTrigger["kind"]; label: string }[] = [
  { kind: "", label: "Timer only (no event trigger)" },
  { kind: "facts_drift", label: "On server facts drift (OS / service / port / file change)" },
  { kind: "unreachable", label: "On host unreachable" },
  { kind: "alert", label: "On incoming alert" },
];

interface TargetOption {
  id: string;
  label: string;
  meta?: string;
}

const TARGET_GROUPS: ["sshOptions" | "workspaceOptions" | "k8sOptions", string][] = [
  ["sshOptions", "SSH hosts"],
  ["workspaceOptions", "Workspace servers"],
  ["k8sOptions", "Kubernetes clusters"],
];

function every(minutes: number): string {
  const preset = INTERVALS.find(([m]) => m === minutes);
  if (preset) return preset[1].toLowerCase();
  if (minutes % 1440 === 0) return `every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return `every ${minutes / 60} hours`;
  return `every ${minutes} minutes`;
}

function until(at: number): string {
  const mins = Math.round((at - Date.now()) / 60_000);
  if (mins <= 0) return "due now";
  if (mins < 60) return `in ${mins} min`;
  if (mins < 1440) return `in ${Math.round(mins / 60)} h`;
  return `in ${Math.round(mins / 1440)} days`;
}

export function Schedules({
  hub,
  act,
  onOpenTask,
}: {
  hub: HubSnapshot;
  act: Act;
  onOpenTask?: (taskId: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<Draft | undefined>();
  const [targetFilter, setTargetFilter] = useState("");

  const { targets, groupedTargets } = useMemo(() => {
    const map = new Map<string, string>([["local", "This computer"]]);
    const sshOptions: { id: string; label: string; meta?: string }[] = [];
    const k8sOptions: { id: string; label: string; meta?: string }[] = [];
    const workspaceOptions: { id: string; label: string; meta?: string }[] = [];
    const seen = new Set<string>(["local"]);

    for (const i of hub.inventory) {
      map.set(i.id, i.label);
      if (seen.has(i.id)) continue;
      seen.add(i.id);
      if (i.kind === "ssh") {
        sshOptions.push({ id: i.id, label: i.label, meta: i.address });
      } else if (i.kind === "k8s") {
        k8sOptions.push({ id: i.id, label: i.label, meta: i.address });
      }
    }
    for (const s of hub.workspaceServers ?? []) {
      map.set(s.id, s.name);
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const meta = [s.cluster, ...(s.tags ?? [])].filter(Boolean).join(" · ");
      workspaceOptions.push({
        id: s.id,
        label: meta ? `${s.name} (${meta})` : s.name,
        meta,
      });
    }
    return {
      targets: map,
      groupedTargets: { sshOptions, k8sOptions, workspaceOptions },
    };
  }, [hub.inventory, hub.workspaceServers]);

  const targetName = (id: string): string =>
    targets.get(id) ?? targets.get(id.replace(/^demo-/, "")) ?? id;
  const custom = draft && !INTERVALS.some(([m]) => m === draft.minutes);
  const schedules = [...hub.schedules].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || a.nextRunAt - b.nextRunAt,
  );

  const cronInvalid = Boolean(
    draft && draft.timingMode === "cron" && !isValidCronExpression(draft.cron),
  );

  const save = (existing: AgentSchedule | undefined, d: Draft): ReturnType<Act> => {
    const cron = d.timingMode === "cron" ? d.cron.trim() : undefined;
    const timezone = d.timingMode === "cron" ? d.timezone.trim() || "UTC" : undefined;
    const eventTrigger: ScheduleEventTrigger | undefined = d.eventKind
      ? {
          kind: d.eventKind,
          cooldownMinutes: Math.max(1, d.eventCooldownMinutes || 30),
        }
      : undefined;

    return act({
      action: "schedule-save",
      schedule: {
        // A changed job keeps the model it was created with unless it is new.
        model: existing?.model ?? hub.config.model,
        provider: existing?.provider ?? hub.config.provider,
        baseUrl: existing?.baseUrl ?? hub.config.baseUrl,
        maxCommands: existing?.maxCommands ?? 20,
        maxMinutes: existing?.maxMinutes ?? 15,
        enabled: existing?.enabled ?? true,
        id: d.id,
        title: d.title.trim(),
        prompt: d.prompt.trim(),
        profileId: d.profileId,
        shell: d.shell,
        mode: d.mode,
        intervalMinutes: d.minutes,
        cron,
        timezone,
        missedPolicy: d.missedPolicy,
        quietSentinel: d.quietSentinel || undefined,
        eventTrigger,
        runbookId: d.runbookId || undefined,
        nextRunAt:
          existing &&
          existing.intervalMinutes === d.minutes &&
          existing.cron === cron && existing.timezone === timezone
            ? existing.nextRunAt
            : Date.now() + d.minutes * 60_000,
      },
    });
  };

  const applyQuietSentinelPreset = (): void => {
    setDraft((prev) => ({
      ...(prev ?? freshDraft()),
      title: prev?.title.trim() ? prev.title : QUIET_SENTINEL_PRESET.title,
      prompt: prev?.prompt.trim() ? prev.prompt : QUIET_SENTINEL_PRESET.prompt,
      minutes: QUIET_SENTINEL_PRESET.minutes,
      mode: QUIET_SENTINEL_PRESET.mode,
      quietSentinel: true,
      eventKind: prev?.eventKind || QUIET_SENTINEL_PRESET.eventKind,
      eventCooldownMinutes:
        prev?.eventCooldownMinutes ?? QUIET_SENTINEL_PRESET.eventCooldownMinutes,
    }));
  };

  const tf = targetFilter.trim().toLowerCase();
  const matches = (opt: TargetOption, needle: string): boolean =>
    !needle ||
    opt.label.toLowerCase().includes(needle) ||
    Boolean(opt.meta?.toLowerCase().includes(needle));
  const matchesTargetFilter = (opt: TargetOption): boolean => matches(opt, tf);
  // "This computer" is filtered like any server. Left exempt, it stayed selected
  // while the person typed a server name, and the job saved for the wrong place.
  // On the team's web server there is none: a job runs on one of the team's servers, and the server
  // refuses one that would run on itself.
  const onTeamServer = isWebBrowserMode();
  const allTargets: TargetOption[] = [
    ...(onTeamServer ? [] : [{ id: "local", label: "This computer" }]),
    ...TARGET_GROUPS.flatMap(([key]) => groupedTargets[key]),
  ];
  /** A new job starts on this computer, or, where there is none, on the first of the servers. */
  const freshDraft = (): Draft => ({ ...emptyDraft, profileId: allTargets[0]?.id ?? "local" });
  const shownTargets = allTargets.filter(matchesTargetFilter);
  const shownTargetIds = new Set(shownTargets.map((o) => o.id));
  const localShown = shownTargetIds.has("local");

  const onTargetFilter = (value: string): void => {
    setTargetFilter(value);
    if (!draft) return;
    const needle = value.trim().toLowerCase();
    const left = allTargets.filter((o) => matches(o, needle));
    // One match is the choice; a choice the filter hid moves to the first match.
    if (left.length === 1 || (left.length > 0 && !left.some((o) => o.id === draft.profileId)))
      setDraft({ ...draft, profileId: left[0].id });
  };

  return (
    <div className="ai-scroll">
      <header className="ai-view-head">
        <h2>Schedules</h2>
        <p className="ai-hint">
          Work the assistant does on a timer or event trigger: a health check
          every morning, a capacity report every week, or a quiet sentinel that
          notifies only on anomalies.
        </p>
        {hub.demoMode && (
          <p className="ai-hint" data-testid="schedules-demo-notice">
            Demo lab: seeded jobs are examples for the simulated fleet and do not contact real servers.
          </p>
        )}
      </header>

      <div className="ai-section-head">
        <h3>
          Jobs <span className="ai-count">{hub.schedules.length}</span>
        </h3>
        <div className="ai-tags">
          {!draft && (
            <button
              type="button"
              data-testid="quiet-sentinel-preset-btn"
              onClick={applyQuietSentinelPreset}
            >
              {QUIET_SENTINEL_PRESET.title}
            </button>
          )}
          <button
            type="button"
            className="ai-btn-accent"
            onClick={() => setDraft(draft ? undefined : freshDraft())}
          >
            {draft ? "Close" : "New job"}
          </button>
        </div>
      </div>

      {draft && (
        <form
          className="ai-form ai-card"
          data-testid="schedule-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.title.trim() || !draft.prompt.trim() || cronInvalid) return;
            void save(
              hub.schedules.find((s) => s.id === draft.id),
              draft,
            ).then((next) => {
              if (next) setDraft(undefined);
            });
          }}
        >
          <div className="ai-card-head">
            <strong>{draft.id ? "Edit job" : "New job"}</strong>
            <button
              type="button"
              data-testid="apply-quiet-sentinel-btn"
              onClick={applyQuietSentinelPreset}
            >
              Apply quiet sentinel preset
            </button>
          </div>
          <label>
            Name
            <input
              required
              autoFocus
              placeholder="Morning check of the storage cluster"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label>
            What it should do
            <textarea
              required
              rows={4}
              placeholder="Check capacity and replication on the storage cluster. Report only what needs attention, and say so plainly when everything is fine."
              value={draft.prompt}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
            />
          </label>

          <div className="ai-form-row">
            <div>
              <label>
                Where it runs
                <select
                  aria-label="Where it runs"
                  value={draft.profileId}
                  onChange={(e) => setDraft({ ...draft, profileId: e.target.value })}
                >
                  {!shownTargetIds.has(draft.profileId) && (
                    <option value={draft.profileId}>{targetName(draft.profileId)}</option>
                  )}
                  {localShown && <option value="local">This computer</option>}
                  {TARGET_GROUPS.map(([key, label]) =>
                    groupedTargets[key].some(matchesTargetFilter) ? (
                      <optgroup key={key} label={label}>
                        {groupedTargets[key].filter(matchesTargetFilter).map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </optgroup>
                    ) : null,
                  )}
                </select>
              </label>
              {allTargets.length > 1 && (
                <label style={{ marginTop: 4 }}>
                  Filter the list
                  <input
                    type="search"
                    aria-label="Filter the list"
                    placeholder="Type a host, cluster or tag"
                    value={targetFilter}
                    onChange={(e) => onTargetFilter(e.target.value)}
                  />
                  {tf && shownTargets.length === 0 && (
                    <small role="status">No server matches. The choice above is kept.</small>
                  )}
                </label>
              )}
            </div>
            <label>
              Shell on that machine
              <select
                value={draft.shell}
                onChange={(e) =>
                  setDraft({ ...draft, shell: e.target.value as ShellKind })
                }
              >
                {SHELL_KINDS.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="ai-form-row">
            <label>
              Schedule type
              <select
                aria-label="Schedule type"
                value={draft.timingMode}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    timingMode: e.target.value as "interval" | "cron",
                  })
                }
              >
                <option value="interval">Interval</option>
                <option value="cron">Cron expression (5-field)</option>
              </select>
            </label>
            <label>
              Commands
              <select
                value={draft.mode}
                onChange={(e) =>
                  setDraft({ ...draft, mode: e.target.value as AgentMode })
                }
              >
                {(Object.keys(SCHEDULE_MODES) as AgentMode[]).map((m) => (
                  <option key={m} value={m}>
                    {SCHEDULE_MODES[m]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {draft.timingMode === "interval" ? (
            <div className="ai-form-row">
              <label>
                How often
                <select
                  value={custom ? "custom" : String(draft.minutes)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      minutes:
                        e.target.value === "custom" ? 90 : Number(e.target.value),
                    })
                  }
                >
                  {INTERVALS.map(([m, label]) => (
                    <option key={m} value={m}>
                      {label}
                    </option>
                  ))}
                  <option value="custom">Another interval…</option>
                </select>
              </label>
              {custom && (
                <label>
                  Minutes between runs
                  <input
                    type="number"
                    min={1}
                    max={525600}
                    value={draft.minutes}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        minutes: Math.max(1, Number(e.target.value) || 1),
                      })
                    }
                  />
                </label>
              )}
            </div>
          ) : (
            <div className="ai-form-row">
              <label>
                Cron expression
                <input
                  aria-label="Cron expression"
                  placeholder="30 7 * * 1-5"
                  value={draft.cron}
                  onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
                />
                {cronInvalid && (
                  <small className="ai-bad" role="alert">
                    Enter 5 fields (minute hour day month weekday), e.g. 30 7 * * 1-5.
                  </small>
                )}
              </label>
              <label>
                Timezone
                <input
                  aria-label="Timezone"
                  list="schedule-timezones"
                  value={draft.timezone}
                  placeholder="UTC"
                  onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                />
                <datalist id="schedule-timezones">
                  {TIMEZONES.map((tz) => <option key={tz} value={tz} />)}
                </datalist>
              </label>
            </div>
          )}

          <div className="ai-form-row">
            <label>
              Event trigger
              <select
                aria-label="Event trigger"
                value={draft.eventKind}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    eventKind: e.target.value as Draft["eventKind"],
                  })
                }
              >
                {EVENT_TRIGGERS.map((ev) => (
                  <option key={ev.kind || "none"} value={ev.kind}>
                    {ev.label}
                  </option>
                ))}
              </select>
            </label>
            {draft.eventKind ? (
              <label>
                Event cooldown (minutes)
                <input
                  type="number"
                  aria-label="Event cooldown minutes"
                  min={1}
                  max={1440}
                  value={draft.eventCooldownMinutes}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      eventCooldownMinutes: Math.max(
                        1,
                        Number(e.target.value) || 30,
                      ),
                    })
                  }
                />
              </label>
            ) : (
              <label>
                Missed-run policy
                <select
                  aria-label="Missed-run policy"
                  value={draft.missedPolicy}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      missedPolicy: e.target.value as "skip" | "run_once",
                    })
                  }
                >
                  <option value="skip">Skip missed runs</option>
                  <option value="run_once">Run once if missed while offline</option>
                </select>
              </label>
            )}
          </div>

          {(hub.runbooks?.length ?? 0) > 0 && (
            <label>
              Runbook to follow (optional)
              <select
                aria-label="Runbook"
                value={draft.runbookId}
                onChange={(e) =>
                  setDraft({ ...draft, runbookId: e.target.value })
                }
              >
                <option value="">None: AI prompt only</option>
                {hub.runbooks!.map((rb) => (
                  <option key={rb.id} value={rb.id}>
                    {rb.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="ai-check">
            <input
              type="checkbox"
              checked={draft.quietSentinel}
              onChange={(e) =>
                setDraft({ ...draft, quietSentinel: e.target.checked })
              }
            />
            <span>
              Only tell me when something is wrong
              <small>
                A successful health check stays out of chat history and sends no notification. Its run record remains available.
              </small>
            </span>
          </label>

          <p className="ai-hint">
            Each run opens its own terminal, uses{" "}
            {hub.config.model || "the model set in Settings"}, and runs until it
            is done or somebody stops it.
            {draft.mode === "autonomous" &&
              " Commands and change cards run without asking. By default a change card or a file write on production still waits for a person."}
            {draft.mode === "assisted" &&
              " Commands run without asking. A change card or a file write waits for a person."}
            {draft.mode === "plan" &&
              " It looks around, then proposes a plan. Change cards and file writes wait until the plan is approved."}
          </p>
          <div className="ai-card-actions">
            <button
              type="submit"
              className="ai-btn-emerald"
              disabled={cronInvalid}
            >
              {draft.id ? "Save changes" : "Create job"}
            </button>
            <button type="button" onClick={() => setDraft(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {hub.schedules.length === 0 && !draft && (
        <p className="ai-empty">
          No jobs yet. A good first one only reports: let it look at something
          every morning and tell you what needs attention.
        </p>
      )}

      {schedules.map((s) => (
        <article
          className={`ai-card ${s.enabled ? "" : "ai-card-off"}`}
          key={s.id}
          data-testid={`schedule-${s.id}`}
        >
          <div className="ai-card-head">
            <div>
              <strong>{s.title}</strong>
              <small>
                {targetName(s.profileId)} ·{" "}
                {s.cron
                  ? `cron "${s.cron}" (${s.timezone ?? "UTC"})`
                  : every(s.intervalMinutes)}{" "}
                ·{" "}
                {SCHEDULE_MODES[s.mode].split(": ")[0].split(" (")[0].toLowerCase()}
                {/* The demo lab's own schedules name a model nobody connected: not shown as if it ran them. */}
                {s.id.startsWith("demo-sched-") ? "" : ` · ${s.model}`}
              </small>
            </div>
            <div className="ai-tags">
              {s.quietSentinel && (
                <span className="ai-badge ai-badge-mode">tells only when wrong</span>
              )}
              {s.eventTrigger && (
                <span className="ai-badge">
                  trigger: {s.eventTrigger.kind}
                </span>
              )}
              <span className={`ai-badge ${s.enabled ? "ai-badge-success" : ""}`}>
                {s.enabled ? `next ${until(s.nextRunAt)}` : "paused"}
              </span>
            </div>
          </div>
          <p className="ai-doc-excerpt">
            {s.prompt.length > 240 ? `${s.prompt.slice(0, 240)}…` : s.prompt}
          </p>
          {s.lastRunSummary && (
            <small className="ai-last-run">Summary: {s.lastRunSummary}</small>
          )}
          <small className="ai-last-run">
            {s.lastStatus ? `Last run: ${s.lastStatus}` : "Has not run yet"}
            {s.enabled ? ` · next ${new Date(s.nextRunAt).toLocaleString()}` : ""}
          </small>
          <div className="ai-card-actions">
            {s.lastTaskId &&
              onOpenTask &&
              hub.tasks.some((t) => t.id === s.lastTaskId) && (
                <button
                  type="button"
                  className="ai-btn-accent"
                  onClick={() => onOpenTask(s.lastTaskId!)}
                >
                  Open last run
                </button>
              )}
            <button
              type="button"
              onClick={() =>
                setDraft({
                  id: s.id,
                  title: s.title,
                  prompt: s.prompt,
                  profileId: s.profileId,
                  shell: s.shell,
                  minutes: s.intervalMinutes,
                  mode: s.mode,
                  timingMode: s.cron ? "cron" : "interval",
                  cron: s.cron ?? "0 7 * * *",
                  timezone: s.timezone ?? "UTC",
                  missedPolicy: s.missedPolicy ?? "skip",
                  quietSentinel: Boolean(s.quietSentinel),
                  eventKind: s.eventTrigger?.kind ?? "",
                  eventCooldownMinutes: s.eventTrigger?.cooldownMinutes ?? 30,
                  runbookId: s.runbookId ?? "",
                })
              }
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() =>
                void act({
                  action: "schedule-save",
                  schedule: {
                    ...s,
                    enabled: !s.enabled,
                    // Resuming starts a fresh interval instead of firing at once for the time it was paused.
                    nextRunAt: s.enabled
                      ? s.nextRunAt
                      : Date.now() + s.intervalMinutes * 60_000,
                  },
                })
              }
            >
              {s.enabled ? "Pause" : "Resume"}
            </button>
            <button
              type="button"
              data-testid={`schedule-run-now-${s.id}`}
              disabled={!s.enabled}
              title={s.enabled ? "Run this job once now" : "Resume it first"}
              onClick={() => void act({ action: "schedule-run-now", id: s.id })}
            >
              Run now
            </button>
            <span className="ai-spacer" />
            <ConfirmButton
              label="Delete"
              confirmLabel="Delete this job?"
              onConfirm={() => void act({ action: "schedule-delete", id: s.id })}
            />
          </div>
        </article>
      ))}
    </div>
  );
}
