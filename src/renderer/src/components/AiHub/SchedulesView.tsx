import { useState } from "react";
import {
  SHELL_KINDS,
  type AgentMode,
  type HubSnapshot,
  type ShellKind,
} from "@shared/types/aiHub";
import { type Act } from "./panelShared";

export function Schedules({ hub, act }: { hub: HubSnapshot; act: Act }): JSX.Element {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [profileId, setProfile] = useState("local");
  const [shell, setShell] = useState<ShellKind>("bash");
  const [minutes, setMinutes] = useState(60);
  const [mode, setMode] = useState<AgentMode>("assisted");
  return (
    <div className="ai-scroll">
      <h2>Scheduled work</h2>
      <p className="ai-hint">
        Each job gets its own terminal and a fixed model. Missed runs are
        recorded without catch-up. Assisted commands wait for approval.
      </p>
      <form
        className="ai-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act({
            action: "schedule-save",
            schedule: {
              title,
              prompt,
              profileId,
              shell,
              mode,
              intervalMinutes: minutes,
              nextRunAt: Date.now() + minutes * 60_000,
              enabled: true,
              model: hub.config.model,
              provider: hub.config.provider,
              baseUrl: hub.config.baseUrl,
              maxCommands: 20,
              maxMinutes: 15,
            },
          });
        }}
      >
        <label>
          Name
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Task
          <textarea
            required
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <label>
          Target
          <select
            value={profileId}
            onChange={(e) => setProfile(e.target.value)}
          >
            <option value="local">Local machine</option>
            {hub.inventory
              .filter((i) => i.kind === "ssh")
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label}
                </option>
              ))}
          </select>
        </label>
        <label>
          Shell
          <select
            value={shell}
            onChange={(e) => setShell(e.target.value as ShellKind)}
          >
            {SHELL_KINDS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Every (minutes)
          <input
            type="number"
            min="1"
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </label>
        <label>
          Control
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as AgentMode)}
          >
            <option value="assisted">Assisted</option>
            <option value="autonomous">
              Autonomous · 20 commands / 15 min
            </option>
          </select>
        </label>
        <p>{hub.config.model} · 20 commands · 15 minutes maximum</p>
        <button>Add schedule</button>
      </form>
      {hub.schedules.map((s) => (
        <article className="ai-card" key={s.id}>
          <strong>{s.title}</strong>
          <p>
            {s.profileId} · {s.model} · {s.mode}
          </p>
          <p>Next: {new Date(s.nextRunAt).toLocaleString()}</p>
          <p>{s.lastStatus ?? "Not run yet"}</p>
          <button
            onClick={() =>
              void act({
                action: "schedule-save",
                schedule: { ...s, enabled: !s.enabled },
              })
            }
          >
            {s.enabled ? "Disable" : "Enable"}
          </button>
          <button
            onClick={() => void act({ action: "schedule-delete", id: s.id })}
          >
            Delete
          </button>
        </article>
      ))}
    </div>
  );
}
