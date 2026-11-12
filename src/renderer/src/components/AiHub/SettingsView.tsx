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
import { DEMO_MODE_SET_BY_SERVER, type Act } from "./panelShared";

export function Settings({ hub, act }: { hub: HubSnapshot; act: Act }): JSX.Element {
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
      <h2>Your model, your infrastructure</h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        <button
          type="button"
          title={isWebBrowserMode() ? DEMO_MODE_SET_BY_SERVER : undefined}
          disabled={isWebBrowserMode()}
          onClick={() =>
            void act({
              action: "demo-mode-toggle",
              enabled: !hub.demoMode,
            })
          }
        >
          {hub.demoMode ? "🧪 Turn the demo lab off" : "🧪 Turn the demo lab on"}
        </button>
        <button
          type="button"
          onClick={() => void act({ action: "restore-builtins" })}
        >
          🔄 Restore built-in agents, runbooks and skills
        </button>
      </div>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />{" "}
        Enable AI context collection and model requests
      </label>
      <label>
        Your Team Handle (shown in shared workspace activity)
        <input
          value={actorName}
          onChange={(e) => setActorName(e.target.value)}
          placeholder={
            hub.config.codexAccountEmail
              ? hub.config.codexAccountEmail.split("@")[0]
              : "e.g. jacob"
          }
        />
      </label>
      {hub.s3Workspace?.configured && (
        <small>
          S3 Team Bucket active: s3://{hub.s3Workspace.bucket}/
          {hub.s3Workspace.prefix || "sshs3-team"}
          {hub.s3Workspace.lastSyncAt
            ? ` (synced ${new Date(hub.s3Workspace.lastSyncAt).toLocaleTimeString()})`
            : ""}
        </small>
      )}
      <label>
        Shared Team Workspace File (Git / OneDrive / Shared Folder — optional)
        <input
          value={prefs.sharedWorkspacePath ?? ""}
          onChange={(e) =>
            setPrefs({ ...prefs, sharedWorkspacePath: e.target.value })
          }
          placeholder="e.g. C:\Shared\Project\sshs3-workspace.json (in addition to SFTP/S3/Team Vault)"
        />
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
            ? `Connected via ChatGPT OAuth${hub.config.codexAccountEmail ? ` (${hub.config.codexAccountEmail})` : ""}. No API key needed.`
            : "Uses your local ChatGPT / Codex OAuth session (hermes-native/auth.json)."}
        </small>
      )}
      {presetModels.length > 0 && (
        <label>
          Model preset
          <select
            aria-label="Model preset"
            value={
              !customModelMode && presetModels.includes(model)
                ? model
                : "__custom__"
            }
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
      <label>
        Model for background work (optional)
        <input
          data-testid="ai-fast-model-input"
          value={fastModel}
          onChange={(e) => setFastModel(e.target.value)}
          placeholder={
            provider === "anthropic"
              ? "claude-haiku-5-5"
              : "a smaller model from the same provider"
          }
        />
        <small>
          Used for what the assistant does in the background: its
          investigators, workforce reviews and reading sessions for team
          memory. Your conversations keep the model above. Empty: everything
          uses the model above. If a background run fails on this model it is
          run again on the main one.
        </small>
      </label>
      {provider !== "openai-codex" && (
        <>
          <label>
            Endpoint
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:11434/v1"
            />
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
                With a model that this endpoint serves on <code>/embeddings</code>,
                knowledge base search also ranks by meaning. Without one it
                matches terms only. Runbook text is sent to this endpoint to
                be embedded.
              </small>
            </label>
          )}
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={
                hub.config.hasApiKey
                  ? "Key configured · leave blank to keep"
                  : "Optional for local models"
              }
            />
          </label>
          <small>
            {hub.config.keyStorage === "session"
              ? "OS keyring unavailable: key is retained for this app session only."
              : "Keys use the operating system keyring."}
          </small>
          <button
            type="button"
            onClick={() =>
              void act({ action: "configure", config: { apiKey: null } })
            }
          >
            Remove API key
          </button>
        </>
      )}
      <label>
        <input
          type="checkbox"
          checked={prefs.background}
          onChange={(e) =>
            setPrefs({
              ...prefs,
              background: e.target.checked,
              autoStart: e.target.checked && prefs.autoStart,
            })
          }
        />{" "}
        Keep running when the window closes
      </label>
      <label>
        <input
          type="checkbox"
          disabled={!prefs.background}
          checked={prefs.autoStart}
          onChange={(e) => setPrefs({ ...prefs, autoStart: e.target.checked })}
        />{" "}
        Start in background when I log in
      </label>
      <label>
        <input
          type="checkbox"
          checked={prefs.inventory}
          onChange={(e) => setPrefs({ ...prefs, inventory: e.target.checked })}
        />{" "}
        Check saved endpoints every 5 minutes
      </label>
      <label>
        History retention (days)
        <input
          type="number"
          min="1"
          max="365"
          value={prefs.retentionDays}
          onChange={(e) =>
            setPrefs({ ...prefs, retentionDays: Number(e.target.value) })
          }
        />
      </label>
      <h3>Context Window & Model Parameters</h3>
      <label>
        Max Context Window (tokens)
        <select
          aria-label="Max Context Window"
          value={String(contextWindowTokens)}
          onChange={(e) => setContextWindowTokens(Number(e.target.value))}
        >
          <option value="16384">16k tokens (Fast / Compact)</option>
          <option value="32768">32k tokens (Standard)</option>
          <option value="65536">64k tokens (Extended)</option>
          <option value="128000">128k tokens (Recommended Enterprise)</option>
          <option value="256000">256k tokens (Deep Multi-Cluster)</option>
          <option value="900000">900k tokens (Ultra Long Context)</option>
        </select>
      </label>
      <label>
        Terminal Scrollback Context (chars per terminal)
        <select
          aria-label="Terminal Scrollback Context"
          value={String(terminalContextChars)}
          onChange={(e) => setTerminalContextChars(Number(e.target.value))}
        >
          <option value="2000">2,000 chars (~500 tokens)</option>
          <option value="4000">4,000 chars (~1k tokens)</option>
          <option value="8000">8,000 chars (~2k tokens — default)</option>
          <option value="16000">16,000 chars (~4k tokens)</option>
          <option value="32000">32,000 chars (~8k tokens)</option>
          <option value="64000">64,000 chars (~16k tokens)</option>
        </select>
      </label>
      <label>
        Max Output Tokens
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
        Max Autonomous Tool Turns per Task
        <input
          type="number"
          min="1"
          max="100"
          value={maxToolTurns}
          onChange={(e) => setMaxToolTurns(Number(e.target.value))}
        />
      </label>
      <label>
        Reasoning Effort
        <select
          aria-label="Reasoning Effort"
          value={reasoningEffort}
          onChange={(e) =>
            setReasoningEffort(e.target.value as AiReasoningEffort)
          }
        >
          <option value="low">Low (Fastest response)</option>
          <option value="medium">Medium (Balanced — default)</option>
          <option value="high">High (Deep storage & root-cause analysis)</option>
        </select>
      </label>
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
      <button type="submit">Save settings</button>
      {savedNotice && <small role="status">Settings saved.</small>}
      <button
        type="button"
        onClick={() => void act({ action: "forget-history" })}
      >
        Delete task and terminal history
      </button>
      <button type="button" onClick={() => void act({ action: "quit" })}>
        Quit sshs3 completely
      </button>
    </form>
  );
}
