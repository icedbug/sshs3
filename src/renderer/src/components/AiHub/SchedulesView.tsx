import { useState } from "react";
import {
  SHELL_KINDS,
  type AgentMode,
  type AgentSchedule,
  type HubSnapshot,
  type ShellKind,
} from "@shared/types/aiHub";
import { ConfirmButton } from "./ConfirmButton";
import { type Act } from "./panelShared";

interface Draft {
  id?: string;
  title: string;
  prompt: string;
  profileId: string;
  shell: ShellKind;
  minutes: number;
  mode: AgentMode;
}

const emptyDraft: Draft = { title: "", prompt: "", profileId: "local", shell: "bash", minutes: 60, mode: "advice" };

const INTERVALS: [number, string][] = [
  [15, "Every 15 minutes"],
  [60, "Every hour"],
  [360, "Every 6 hours"],
  [1440, "Every day"],
  [10080, "Every week"],
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

const MODES: Record<AgentMode, string> = {
  advice: "Reports only — runs no commands",
  assisted: "Asks before each command (waits for you)",
  autonomous: "Runs commands on its own",
};

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
  const targets = new Map<string, string>([["local", "This computer"]]);
  for (const i of hub.inventory) if (i.kind === "ssh") targets.set(i.id, i.label);
  for (const s of hub.workspaceServers ?? []) targets.set(s.id, s.name);
  const targetName = (id: string): string => targets.get(id) ?? targets.get(id.replace(/^demo-/, "")) ?? id;
  const custom = draft && !INTERVALS.some(([m]) => m === draft.minutes);
  const schedules = [...hub.schedules].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.nextRunAt - b.nextRunAt);

  const save = (existing: AgentSchedule | undefined, d: Draft): ReturnType<Act> =>
    act({
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
        nextRunAt:
          existing && existing.intervalMinutes === d.minutes ? existing.nextRunAt : Date.now() + d.minutes * 60_000,
      },
    });

  return (
    <div className="ai-scroll">
      <header className="ai-view-head">
        <h2>Schedules</h2>
        <p className="ai-hint">
          Work the assistant does on a timer: a health check every morning, a capacity report every week. A job runs
          only while sshS3 is running on this computer; a run that was missed is noted and not made up for.
        </p>
      </header>

      <div className="ai-section-head">
        <h3>
          Jobs <span className="ai-count">{hub.schedules.length}</span>
        </h3>
        <button
          type="button"
          className="ai-btn-accent"
          onClick={() => setDraft(draft ? undefined : { ...emptyDraft })}
        >
          {draft ? "Close" : "New job"}
        </button>
      </div>

      {draft && (
        <form
          className="ai-form ai-card"
          data-testid="schedule-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.title.trim() || !draft.prompt.trim()) return;
            void save(
              hub.schedules.find((s) => s.id === draft.id),
              draft,
            ).then((next) => {
              if (next) setDraft(undefined);
            });
          }}
        >
          <strong>{draft.id ? "Edit job" : "New job"}</strong>
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
            <label>
              Where
              <select value={draft.profileId} onChange={(e) => setDraft({ ...draft, profileId: e.target.value })}>
                {!targets.has(draft.profileId) && <option value={draft.profileId}>{draft.profileId}</option>}
                {[...targets.entries()].map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Shell on that machine
              <select value={draft.shell} onChange={(e) => setDraft({ ...draft, shell: e.target.value as ShellKind })}>
                {SHELL_KINDS.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="ai-form-row">
            <label>
              How often
              <select
                value={custom ? "custom" : String(draft.minutes)}
                onChange={(e) =>
                  setDraft({ ...draft, minutes: e.target.value === "custom" ? 90 : Number(e.target.value) })
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
            {custom ? (
              <label>
                Minutes between runs
                <input
                  type="number"
                  min={1}
                  max={525600}
                  value={draft.minutes}
                  onChange={(e) => setDraft({ ...draft, minutes: Math.max(1, Number(e.target.value) || 1) })}
                />
              </label>
            ) : (
              <label>
                Commands
                <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as AgentMode })}>
                  {(Object.keys(MODES) as AgentMode[]).map((m) => (
                    <option key={m} value={m}>
                      {MODES[m]}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {custom && (
            <label>
              Commands
              <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as AgentMode })}>
                {(Object.keys(MODES) as AgentMode[]).map((m) => (
                  <option key={m} value={m}>
                    {MODES[m]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="ai-hint">
            Each run opens its own terminal, uses {hub.config.model || "the model set in Settings"}, and stops after 20
            commands or 15 minutes.
            {draft.mode === "autonomous" &&
              " On its own it still stops for destructive commands and, by default, for changes on production."}
            {draft.mode === "assisted" && " If nobody is there to approve, the run waits until it times out."}
          </p>
          <div className="ai-card-actions">
            <button type="submit" className="ai-btn-emerald">
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
          No jobs yet. A good first one only reports: let it look at something every morning and tell you what needs
          attention.
        </p>
      )}

      {schedules.map((s) => (
        <article className={`ai-card ${s.enabled ? "" : "ai-card-off"}`} key={s.id} data-testid={`schedule-${s.id}`}>
          <div className="ai-card-head">
            <div>
              <strong>{s.title}</strong>
              <small>
                {targetName(s.profileId)} · {every(s.intervalMinutes)} · {MODES[s.mode].split(" — ")[0].split(" (")[0].toLowerCase()} ·{" "}
                {s.model}
              </small>
            </div>
            <span className={`ai-badge ${s.enabled ? "ai-badge-success" : ""}`}>
              {s.enabled ? `next ${until(s.nextRunAt)}` : "paused"}
            </span>
          </div>
          <p className="ai-doc-excerpt">{s.prompt.length > 240 ? `${s.prompt.slice(0, 240)}…` : s.prompt}</p>
          <small className="ai-last-run">
            {s.lastStatus ? `Last run: ${s.lastStatus}` : "Has not run yet"}
            {s.enabled ? ` · next ${new Date(s.nextRunAt).toLocaleString()}` : ""}
          </small>
          <div className="ai-card-actions">
            {s.lastTaskId && onOpenTask && hub.tasks.some((t) => t.id === s.lastTaskId) && (
              <button type="button" className="ai-btn-accent" onClick={() => onOpenTask(s.lastTaskId!)}>
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
                    nextRunAt: s.enabled ? s.nextRunAt : Date.now() + s.intervalMinutes * 60_000,
                  },
                })
              }
            >
              {s.enabled ? "Pause" : "Resume"}
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
