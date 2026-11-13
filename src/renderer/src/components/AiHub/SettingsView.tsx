import { useEffect, useRef, useState } from "react";
import {
  type HubSnapshot,
} from "@shared/types/aiHub";
import {
  DEFAULT_AI_MODELS,
  DEFAULT_PROVIDER_MODELS,
  type AiReasoningEffort,
} from "@shared/types/ai";
import { isWebBrowserMode } from "../../lib/webClientBridge";
import { ConfirmButton } from "./ConfirmButton";
import { DEMO_MODE_SET_BY_SERVER, type Act } from "./panelShared";
import { McpKeysPanel } from "../McpKeysPanel";
import { NotificationsCard } from "./NotificationsCard";
import { SafetyPolicyCard } from "./SafetyPolicyCard";

export function Settings({ hub, act }: { hub: HubSnapshot; act: Act }): JSX.Element {
  // The keys panel is written against the team server's HTTP API; on this app the same
  // calls are the hub's own requests.
  const localKeysApi = async <T,>(path: string, options?: RequestInit): Promise<T> => {
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body)) as { name: string; scopes: string[]; serverId?: string; expiresInDays?: number; tools?: string[] };
      const next = await act({ action: "mcp-key-create", name: body.name, scopes: body.scopes, serverId: body.serverId, expiresInDays: body.expiresInDays, tools: body.tools });
      const made = next?.reply?.mcpKey;
      if (!made) throw new Error("The key could not be made.");
      return made as T;
    }
    if (options?.method === "DELETE") {
      await act({ action: "mcp-key-revoke", id: decodeURIComponent(path.split("/").pop() ?? "") });
      return { ok: true } as T;
    }
    const next = await act({ action: "mcp-key-list" });
    return { keys: next?.localMcp?.keys ?? [] } as T;
  };
  const [provider, setProvider] = useState(hub.config.provider);
  const [model, setModel] = useState(hub.config.model);
  const [customModelMode, setCustomModelMode] = useState(false);
  const [url, setUrl] = useState(hub.config.baseUrl ?? "");
  const [embeddingModel, setEmbeddingModel] = useState(
    hub.config.embeddingModel ?? "",
  );
  const [fastModel, setFastModel] = useState(hub.config.fastModel ?? "");
  const [key, setKey] = useState("");
  const [actorName, setActorName] = useState(hub.config.actorName ?? "");
  const [enabled, setEnabled] = useState(hub.config.enabled);
  const [contextWindowTokens, setContextWindowTokens] = useState(
    hub.config.contextWindowTokens ?? 128000,
  );
  const [terminalContextChars, setTerminalContextChars] = useState(
    hub.config.terminalContextChars ?? 8000,
  );
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    hub.config.maxOutputTokens ?? 8192,
  );
  const [maxToolTurns, setMaxToolTurns] = useState(
    hub.config.maxToolTurns ?? 20,
  );
  const [reasoningEffort, setReasoningEffort] = useState<AiReasoningEffort>(
    hub.config.reasoningEffort ?? "medium",
  );
  const [temperature, setTemperature] = useState(
    hub.config.temperature ?? 0.2,
  );
  const [prefs, setPrefs] = useState(hub.preferences);
  const [savedNotice, setSavedNotice] = useState(false);
  const modelInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setProvider(hub.config.provider);
    setModel(hub.config.model);
    setCustomModelMode(false);
    setUrl(hub.config.baseUrl ?? "");
    setEmbeddingModel(hub.config.embeddingModel ?? "");
    setFastModel(hub.config.fastModel ?? "");
    setActorName(hub.config.actorName ?? "");
    setEnabled(hub.config.enabled);
    setContextWindowTokens(hub.config.contextWindowTokens ?? 128000);
    setTerminalContextChars(hub.config.terminalContextChars ?? 8000);
    setMaxOutputTokens(hub.config.maxOutputTokens ?? 8192);
    setMaxToolTurns(hub.config.maxToolTurns ?? 20);
    setReasoningEffort(hub.config.reasoningEffort ?? "medium");
    setTemperature(hub.config.temperature ?? 0.2);
  }, [
    hub.config.provider,
    hub.config.model,
    hub.config.baseUrl,
    hub.config.embeddingModel,
    hub.config.fastModel,
    hub.config.actorName,
    hub.config.enabled,
    hub.config.contextWindowTokens,
    hub.config.terminalContextChars,
    hub.config.maxOutputTokens,
    hub.config.maxToolTurns,
    hub.config.reasoningEffort,
    hub.config.temperature,
  ]);

  useEffect(() => {
    setPrefs(hub.preferences);
  }, [hub.preferences]);

  const presetModels =
    provider === "openai-codex"
      ? hub.config.codexModels?.length
        ? hub.config.codexModels
        : DEFAULT_PROVIDER_MODELS["openai-codex"]
      : DEFAULT_PROVIDER_MODELS[provider] ?? [];

  return (
    <form
      className="ai-scroll ai-form"
      onSubmit={(e) => {
        e.preventDefault();
        setSavedNotice(false);
        void act({
          action: "configure",
          config: {
            enabled,
            provider,
            model: model.trim(),
            baseUrl: provider === "openai-codex" ? "" : url.trim(),
            embeddingModel:
              provider === "openai-compatible" ? embeddingModel.trim() : "",
            fastModel: fastModel.trim(),
            actorName,
            useHermes: false,
            contextWindowTokens,
            terminalContextChars,
            maxOutputTokens,
            maxToolTurns,
            reasoningEffort,
            temperature,
            ...(key ? { apiKey: key } : {}),
          },
          preferences: prefs,
        }).then((result) => {
          if (result) {
            setKey("");
            setSavedNotice(true);
          }
        });
      }}
    >
      <header className="ai-view-head">
        <h2>Settings</h2>
        <p className="ai-hint">
          The assistant uses the model you connect here. Nothing is sent anywhere else.
        </p>
      </header>

      <section className="ai-set">
        <h3>Model</h3>
        <label className="ai-check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>
            Assistant on
            <small>Off: nothing is collected and no model is called.</small>
          </span>
        </label>
        <label>
          Provider
        <select
          value={provider}
          onChange={(e) => {
            const next = e.target.value as typeof provider;
            setProvider(next);
            setCustomModelMode(false);
            setSavedNotice(false);
            if (next === "openai-codex") {
              const codexDefault =
                hub.config.codexDefaultModel || DEFAULT_AI_MODELS["openai-codex"];
              const validCodex =
                hub.config.codexModels ?? DEFAULT_PROVIDER_MODELS["openai-codex"];
              if (
                !model ||
                model === "local" ||
                model === "gpt-sol-latest" ||
                model.startsWith("claude-") ||
                !validCodex.includes(model)
              ) {
                setModel(codexDefault);
              }
              if (url.includes("openrouter.ai")) {
                setUrl("");
              }
            } else if (next === "anthropic") {
              if (!model || !model.startsWith("claude-")) {
                setModel(DEFAULT_AI_MODELS.anthropic);
              }
            }
          }}
        >
          <option value="openai-codex">
            ChatGPT / Codex (OAuth — {hub.config.codexDefaultModel || "gpt-6.1-sol"})
          </option>
          <option value="anthropic">Anthropic</option>
          <option value="openai-compatible">
            OpenAI-compatible / local / enterprise
          </option>
        </select>
        </label>
        {provider === "openai-codex" && (
          <small>
            {hub.config.codexConnected
              ? `Signed in with ChatGPT${hub.config.codexAccountEmail ? ` (${hub.config.codexAccountEmail})` : ""}. No API key needed.`
              : "Uses the ChatGPT / Codex sign-in on this computer. Not signed in yet."}
          </small>
        )}
        <div className="ai-form-row">
          {presetModels.length > 0 && (
            <label>
              Model preset
              <select
                aria-label="Model preset"
                value={!customModelMode && presetModels.includes(model) ? model : "__custom__"}
                onChange={(e) => {
                  if (e.target.value === "__custom__") {
                    setCustomModelMode(true);
                    setTimeout(() => modelInputRef.current?.focus(), 0);
                  } else {
                    setCustomModelMode(false);
                    setModel(e.target.value);
                    setSavedNotice(false);
                  }
                }}
              >
                {presetModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value="__custom__">
                  Custom{!presetModels.includes(model) && model ? ` (${model})` : " model ID…"}
                </option>
              </select>
            </label>
          )}
          <label>
            Model ID
            <input
              ref={modelInputRef}
              required
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setSavedNotice(false);
              }}
              placeholder={
                provider === "openai-codex"
                  ? hub.config.codexDefaultModel || "gpt-6.1-sol"
                  : "Model offered by your endpoint"
              }
            />
          </label>
        </div>
        {provider !== "openai-codex" && (
          <>
            <label>
              Endpoint
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={provider === "anthropic" ? "https://api.anthropic.com (default)" : "http://localhost:11434/v1"}
              />
            </label>
            <label>
              API key
              <input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={hub.config.hasApiKey ? "A key is saved · leave blank to keep it" : "Not needed for local models"}
              />
              <small>
                {hub.config.keyStorage === "session"
                  ? "No system keyring was found: the key is kept only until the app closes."
                  : "Stored in the operating system keyring, never in the workspace."}
              </small>
            </label>
            {hub.config.hasApiKey && (
              <ConfirmButton
                label="Remove the saved key"
                confirmLabel="Remove the key?"
                className=""
                onConfirm={() => void act({ action: "configure", config: { apiKey: null } })}
              />
            )}
          </>
        )}
        <label>
          Model for background work (optional)
          <input
            data-testid="ai-fast-model-input"
            value={fastModel}
            onChange={(e) => setFastModel(e.target.value)}
            placeholder={provider === "anthropic" ? "claude-haiku-5-5" : "a smaller model from the same provider"}
          />
          <small>
            For what happens behind the conversation: investigators, workforce reviews and reading sessions for team
            memory. Empty: everything uses the model above. A background run that fails on this model is run again on
            the main one.
          </small>
        </label>
        {provider === "openai-compatible" && (
          <label>
            Embedding model (optional)
            <input
              data-testid="ai-embedding-model-input"
              value={embeddingModel}
              onChange={(e) => setEmbeddingModel(e.target.value)}
              placeholder="nomic-embed-text / text-embedding-3-small"
            />
            <small>
              With a model this endpoint serves on <code>/embeddings</code>, the knowledge base is also searched by
              meaning. Runbook text is sent to the endpoint to be embedded.
            </small>
          </label>
        )}
      </section>

      <section className="ai-set">
        <h3>You and the team</h3>
        <label>
          Your name in the team&apos;s activity
          <input
            value={actorName}
            onChange={(e) => setActorName(e.target.value)}
            placeholder={hub.config.codexAccountEmail ? hub.config.codexAccountEmail.split("@")[0] : "jacob"}
          />
        </label>
        <small>
          {hub.s3Workspace?.configured
            ? `Team bucket: s3://${hub.s3Workspace.bucket}/${hub.s3Workspace.prefix || "sshs3-team"}${
                hub.s3Workspace.lastSyncAt
                  ? ` · synced ${new Date(hub.s3Workspace.lastSyncAt).toLocaleTimeString()}`
                  : ""
              }`
            : "No team bucket is connected. Memory, runbooks and activity stay on this computer until one is; connect it from the start page (Invite / team)."}
        </small>
        {/* A path on the computer that runs sshs3: on a shared server that is the administrator's, not the browser's. */}
        {!isWebBrowserMode() && (
          <label>
            Shared workspace file (optional)
            <input
              className="ai-mono"
              value={prefs.sharedWorkspacePath ?? ""}
              onChange={(e) => setPrefs({ ...prefs, sharedWorkspacePath: e.target.value })}
              placeholder="~/team/sshs3-workspace.json"
            />
            <small>A file in a synced folder or a Git checkout, used in addition to the team bucket.</small>
          </label>
        )}
      </section>

      <section className="ai-set">
        <h3>Safety</h3>
        <SafetyPolicyCard hub={hub} act={act} />
        <label>
          How long an agent waits for your approval
          <select
            aria-label="Approval wait"
            value={hub.preferences.approvalWaitMinutes ?? 10}
            onChange={(e) =>
              void act({ action: "configure", config: {}, preferences: { ...hub.preferences, approvalWaitMinutes: Number(e.target.value) } })
            }
          >
            {[10, 20, 30, 45, 60].map((m) => (
              <option key={m} value={m}>
                {m} minutes{m === 10 ? " (default)" : ""}
              </option>
            ))}
          </select>
          <small>
            After that the action counts as denied and the agent goes on without it. The wait does not use up the run's
            time budget. Longer suits approvals that are answered from a phone.
          </small>
        </label>
      </section>

      <section className="ai-set">
        <h3>Notifications</h3>
        <NotificationsCard hub={hub} act={act} />
      </section>

      {/* The app answering this person's own agent. In a browser the team server already
          has its endpoint and the keys live with the account, so this is not shown there. */}
      {!isWebBrowserMode() && (
      <section className="ai-set" data-testid="local-mcp">
        <h3>Your own agents (MCP)</h3>
        <label className="ai-check">
          <input
            type="checkbox"
            checked={Boolean(hub.localMcp?.enabled)}
            aria-label="Let your own agents reach this app"
            onChange={(e) => void act({ action: "mcp-local-set", enabled: e.target.checked })}
          />
          <span>
            Let your own agents reach this app
            <small>
              Claude Code, Cursor or anything else that speaks MCP can then ask this sshs3 about your servers, what
              changed on them and what you have written down. It listens on this computer only (127.0.0.1), it is off
              until you switch it on, and it answers nothing without one of your keys.
            </small>
          </span>
        </label>
        {hub.localMcp?.error && <p className="ai-error">It could not start: {hub.localMcp.error}</p>}
        {hub.localMcp?.enabled && hub.localMcp.address && (
          <>
            <p className="ai-hint">
              It answers at <code>{hub.localMcp.address}</code>.
            </p>
            <McpKeysPanel
              api={localKeysApi}
              origin=""
              endpoint={hub.localMcp.address}
              title="Your keys"
              intro="A key is shown once, when you make it. It acts as you and sees what you see; take it back at any time."
            />
          </>
        )}
      </section>
      )}

      <details className="ai-fold ai-set-fold">
        <summary>Limits and model parameters</summary>
        <div className="ai-form">
          <div className="ai-form-row">
            <label>
              Context window
              <select
                aria-label="Max Context Window"
                value={String(contextWindowTokens)}
                onChange={(e) => setContextWindowTokens(Number(e.target.value))}
              >
                {[16384, 32768, 65536, 128000, 256000, 900000].map((n) => (
                  <option key={n} value={n}>
                    {Math.round(n / 1000)}k tokens{n === 128000 ? " (default)" : ""}
                  </option>
                ))}
              </select>
              <small>Set it to what your model accepts. The conversation is condensed before it is full.</small>
            </label>
            <label>
              Terminal output given per terminal
              <select
                aria-label="Terminal Scrollback Context"
                value={String(terminalContextChars)}
                onChange={(e) => setTerminalContextChars(Number(e.target.value))}
              >
                {[2000, 4000, 8000, 16000, 32000, 64000].map((n) => (
                  <option key={n} value={n}>
                    {n.toLocaleString("en")} characters{n === 8000 ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="ai-form-row">
            <label>
              Longest answer (tokens)
              <input
                type="number"
                min="512"
                max="65536"
                step="512"
                value={maxOutputTokens}
                onChange={(e) => setMaxOutputTokens(Number(e.target.value))}
              />
            </label>
            <label>
              Most tool steps in one run
              <input
                type="number"
                min="1"
                max="100"
                value={maxToolTurns}
                onChange={(e) => setMaxToolTurns(Number(e.target.value))}
              />
            </label>
          </div>
          <div className="ai-form-row">
            <label>
              Reasoning effort
              <select
                aria-label="Reasoning Effort"
                value={reasoningEffort}
                onChange={(e) => setReasoningEffort(e.target.value as AiReasoningEffort)}
              >
                <option value="low">Low — fastest</option>
                <option value="medium">Medium (default)</option>
                <option value="high">High — for hard root-cause work</option>
              </select>
            </label>
            {provider !== "anthropic" && (
              <label>
                Temperature ({temperature.toFixed(2)})
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={temperature}
                  onChange={(e) => setTemperature(Number(e.target.value))}
                />
              </label>
            )}
          </div>
        </div>
      </details>

      <section className="ai-set">
        <h3>App</h3>
        {!isWebBrowserMode() && (
          <>
            <label className="ai-check">
              <input
                type="checkbox"
                checked={prefs.background}
                onChange={(e) =>
                  setPrefs({ ...prefs, background: e.target.checked, autoStart: e.target.checked && prefs.autoStart })
                }
              />
              <span>
                Keep running when the window closes
                <small>Needed for schedules and for learning from the team&apos;s activity while you are away.</small>
              </span>
            </label>
            <label className="ai-check">
              <input
                type="checkbox"
                disabled={!prefs.background}
                checked={prefs.autoStart}
                onChange={(e) => setPrefs({ ...prefs, autoStart: e.target.checked })}
              />
              <span>Start in the background when I log in</span>
            </label>
          </>
        )}
        <label className="ai-check">
          <input
            type="checkbox"
            checked={prefs.inventory}
            onChange={(e) => setPrefs({ ...prefs, inventory: e.target.checked })}
          />
          <span>
            Check every 5 minutes whether saved servers answer
            <small>Only tests that the address responds; nothing is logged in to.</small>
          </span>
        </label>
        <label>
          Keep conversations and terminal history for (days)
          <input
            type="number"
            min="1"
            max="365"
            value={prefs.retentionDays}
            onChange={(e) => setPrefs({ ...prefs, retentionDays: Number(e.target.value) })}
          />
        </label>
      </section>

      <div className="ai-set-save">
        <button type="submit" className="ai-btn-emerald">
          Save settings
        </button>
        {savedNotice && <small role="status">Settings saved.</small>}
      </div>

      <section className="ai-set ai-set-data">
        <h3>Data</h3>
        <div className="ai-card-actions">
          <button
            type="button"
            title="Brings back the agents, runbooks and skills that ship with sshS3 if you removed them"
            onClick={() => void act({ action: "restore-builtins" })}
          >
            Restore built-in agents, runbooks and skills
          </button>
          <button
            type="button"
            title={isWebBrowserMode() ? DEMO_MODE_SET_BY_SERVER : "Restarts sshS3 with invented servers and data"}
            disabled={isWebBrowserMode()}
            onClick={() => void act({ action: "demo-mode-toggle", enabled: !hub.demoMode })}
          >
            {hub.demoMode ? "Turn the demo lab off" : "Turn the demo lab on"}
          </button>
          <ConfirmButton
            label="Delete conversations and terminal history"
            confirmLabel="Delete all of it on this computer?"
            onConfirm={() => void act({ action: "forget-history" })}
          />
          {!isWebBrowserMode() && (
            <ConfirmButton
              label="Quit sshS3 completely"
              confirmLabel="Quit, and stop schedules?"
              className=""
              onConfirm={() => void act({ action: "quit" })}
            />
          )}
        </div>
        <small>Deleting history does not touch team memory or the knowledge base.</small>
      </section>
    </form>
  );
}
