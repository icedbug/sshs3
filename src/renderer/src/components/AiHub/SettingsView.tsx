import { useEffect, useMemo, useRef, useState } from "react";
import {
  type HubPreferences,
  type HubSnapshot,
} from "@shared/types/aiHub";
import {
  DEFAULT_AI_MODELS,
  DEFAULT_PROVIDER_MODELS,
  type AiActiveProfileByRole,
  type AiEgressPolicy,
  type AiPiiScrubbingMode,
  type AiProfileRole,
  type AiProvider,
  type AiReasoningEffort,
  type ProviderProfile,
} from "@shared/types/ai";
import { getStoredWebSessionToken, isWebBrowserMode } from "../../lib/webClientBridge";
import { ConfirmButton } from "./ConfirmButton";
import {
  dataDestination,
  describeActiveDataFlow,
  formatEgressPolicyLabel,
  formatPiiScrubbingLabel,
} from "./dataDestination";
import { DEMO_MODE_SET_BY_SERVER, LABS_ENABLED_STORAGE_KEY, type Act } from "./panelShared";
import { McpKeysPanel } from "../McpKeysPanel";
import { NotificationsCard } from "./NotificationsCard";
import { TeamChatCard } from "./TeamChatCard";
import { AgentInChatCard } from "./AgentInChatCard";
import { SafetyPolicyCard } from "./SafetyPolicyCard";
import { sharingText } from "@shared/sharingText";

export { LABS_ENABLED_STORAGE_KEY };

/** The ways data leaves, and where it ends up, in the words the settings use. */
const DATA_CHANNEL_NAMES: Record<string, string> = {
  "llm-inference": "The model",
  "team-s3-sync": "The team bucket",
  "local-storage": "Kept here",
  "team-chat": "The team chat",
};
const DATA_PLACES: Record<string, string> = {
  external: "an outside service",
  eu: "a service in the EU",
  "private-network": "your own network",
  local: "this machine",
  disabled: "not used",
};

export interface SettingsProps {
  hub: HubSnapshot;
  act: Act;
  labsEnabled?: boolean;
  onToggleLabs?: (enabled: boolean) => void;
  /** The last request that failed, as the settings show it at the top: a card can show it next to what was pressed. */
  error?: string;
}

const PROFILE_ROLES: { role: AiProfileRole; label: string; hint: string }[] = [
  {
    role: "primary",
    label: "The chat and the agents (main model)",
    hint: "Conversations, plans, and changes to code and configuration.",
  },
  {
    role: "fastTriage",
    label: "Quick checks (fast model)",
    hint: "Read-only investigations and one-line terminal command suggestions.",
  },
  {
    role: "backgroundDistill",
    label: "Summaries in the background",
    hint: "Learning from finished work, writing knowledge base pages, and checking them for contradictions.",
  },
  {
    role: "embedding",
    label: "Search in the knowledge base",
    hint: "For semantic search, choose an OpenAI-compatible endpoint that serves the embedding model named in the profile.",
  },
];

type ApiProtocol = NonNullable<ProviderProfile["apiProtocol"]>;

function ProtocolSelect({ value, onChange }: { value: ApiProtocol; onChange: (v: ApiProtocol) => void }): JSX.Element {
  return <label>API format
    <select value={value} onChange={(e) => onChange(e.target.value as ApiProtocol)}>
      <option value="auto">Automatic</option>
      <option value="responses">Responses</option>
      <option value="chat-completions">Chat Completions</option>
    </select>
  </label>;
}

interface ProfileDraft {
  id?: string;
  name: string;
  provider: AiProvider;
  model: string;
  baseUrl: string;
  apiProtocol?: ApiProtocol;
  apiKey: string;
  egressPolicy: AiEgressPolicy;
  zdrConfirmed: boolean;
  reasoningEffort: AiReasoningEffort;
  activeRole: "" | AiProfileRole;
}

function readStoredLabsEnabled(): boolean {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    return window.localStorage.getItem(LABS_ENABLED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeStoredLabsEnabled(enabled: boolean): void {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(LABS_ENABLED_STORAGE_KEY, String(enabled));
    }
    if (typeof window !== "undefined") {
      // The panel reads `labsEnabled`: the same key its own toggle sends.
      window.dispatchEvent(new CustomEvent("sshs3:labs-changed", { detail: { labsEnabled: enabled } }));
    }
  } catch {
    // Ignore storage errors in restricted environments.
  }
}

export function Settings({
  hub,
  act,
  labsEnabled: controlledLabs,
  onToggleLabs,
  error,
}: SettingsProps): JSX.Element {
  // The keys panel is written against the team server's HTTP API; on this app the same
  // calls are the hub's own requests.
  const localKeysApi = async <T,>(path: string, options?: RequestInit): Promise<T> => {
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body)) as {
        name: string;
        scopes: string[];
        serverId?: string;
        expiresInDays?: number;
        tools?: string[];
      };
      const next = await act({
        action: "mcp-key-create",
        name: body.name,
        scopes: body.scopes,
        serverId: body.serverId,
        expiresInDays: body.expiresInDays,
        tools: body.tools,
      });
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

  const webMcpKeysApi = async <T,>(path: string, options?: RequestInit): Promise<T> => {
    if (typeof fetch !== "function") return { keys: [] } as T;
    const token = getStoredWebSessionToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((options?.headers as Record<string, string>) || {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, { ...options, credentials: "same-origin", headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
    return data as T;
  };

  const [provider, setProvider] = useState(hub.config.provider);
  const [model, setModel] = useState(hub.config.model);
  const [customModelMode, setCustomModelMode] = useState(false);
  const [apiProtocol, setApiProtocol] = useState<ApiProtocol>(hub.config.apiProtocol ?? "auto");
  const [url, setUrl] = useState(hub.config.baseUrl ?? "");
  const [embeddingModel, setEmbeddingModel] = useState(hub.config.embeddingModel ?? "");
  const [fastModel, setFastModel] = useState(hub.config.fastModel ?? "");
  const [key, setKey] = useState("");
  const [actorName, setActorName] = useState(hub.config.actorName ?? "");
  const sharing = sharingText({ server: isWebBrowserMode(), bucket: Boolean(hub.s3Workspace?.configured), demo: hub.demoMode === true });
  const [enabled, setEnabled] = useState(hub.config.enabled);
  const [egressPolicy, setEgressPolicy] = useState<AiEgressPolicy>(hub.config.egressPolicy ?? "standard");
  const [zdrConfirmed, setZdrConfirmed] = useState<boolean>(Boolean(hub.config.zdrConfirmed));
  const [piiScrubbing, setPiiScrubbing] = useState<AiPiiScrubbingMode>(hub.config.piiScrubbing ?? "standard");
  const [activeProfileByRole, setActiveProfileByRole] = useState<AiActiveProfileByRole>(
    hub.config.activeProfileByRole ?? {},
  );
  const [profileDraft, setProfileDraft] = useState<ProfileDraft | undefined>();
  const [contextWindowTokens, setContextWindowTokens] = useState(hub.config.contextWindowTokens ?? 128000);
  const [terminalContextChars, setTerminalContextChars] = useState(hub.config.terminalContextChars ?? 8000);
  const [maxOutputTokens, setMaxOutputTokens] = useState(hub.config.maxOutputTokens ?? 8192);
  const [maxToolTurns, setMaxToolTurns] = useState(hub.config.maxToolTurns ?? 20);
  const [reasoningEffort, setReasoningEffort] = useState<AiReasoningEffort>(hub.config.reasoningEffort ?? "medium");
  const [temperature, setTemperature] = useState(hub.config.temperature ?? 0.2);
  const [prefs, setPrefs] = useState<HubPreferences>(hub.preferences);
  const [internalLabs, setInternalLabs] = useState<boolean>(() => readStoredLabsEnabled());
  const [savedNotice, setSavedNotice] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState("");
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<{ ok: boolean; detail: string }>();
  const modelInputRef = useRef<HTMLInputElement>(null);

  const labsEnabled = controlledLabs ?? internalLabs;
  const setLabsEnabled = (next: boolean): void => {
    setInternalLabs(next);
    writeStoredLabsEnabled(next);
    onToggleLabs?.(next);
  };

  useEffect(() => {
    setProvider(hub.config.provider);
    setModel(hub.config.model);
    setCustomModelMode(false);
    setUrl(hub.config.baseUrl ?? "");
    setApiProtocol(hub.config.apiProtocol ?? "auto");
    setEmbeddingModel(hub.config.embeddingModel ?? "");
    setFastModel(hub.config.fastModel ?? "");
    setActorName(hub.config.actorName ?? "");
    setEnabled(hub.config.enabled);
    setEgressPolicy(hub.config.egressPolicy ?? "standard");
    setZdrConfirmed(Boolean(hub.config.zdrConfirmed));
    setPiiScrubbing(hub.config.piiScrubbing ?? "standard");
    setActiveProfileByRole(hub.config.activeProfileByRole ?? {});
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
    hub.config.apiProtocol,
    hub.config.embeddingModel,
    hub.config.fastModel,
    hub.config.actorName,
    hub.config.enabled,
    hub.config.egressPolicy,
    hub.config.zdrConfirmed,
    hub.config.piiScrubbing,
    hub.config.activeProfileByRole,
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

  const profiles: ProviderProfile[] = hub.config.profiles ?? [];

  const dataFlow = useMemo(
    () =>
      describeActiveDataFlow(
        {
          provider,
          baseUrl: provider === "openai-codex" ? "" : url,
          model,
          egressPolicy,
          zdrConfirmed,
          piiScrubbing,
        },
        hub.s3Workspace,
      ),
    [provider, url, model, egressPolicy, zdrConfirmed, piiScrubbing, hub.s3Workspace],
  );

  return (
    <form
      className="ai-settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        setSavedNotice(false);
        void act({
          action: "configure",
          config: {
            enabled,
            provider,
            model: model.trim(),
            ...(provider === "openai-compatible" ? { apiProtocol } : {}),
            baseUrl: provider === "openai-codex" ? "" : url.trim(),
            embeddingModel: provider === "openai-compatible" ? embeddingModel.trim() : "",
            fastModel: fastModel.trim(),
            actorName,
            useHermes: false,
            egressPolicy,
            zdrConfirmed,
            piiScrubbing,
            activeProfileByRole,
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
      {/* Only this part scrolls. The save bar sits under it, so it never covers a control. */}
      <div className="ai-scroll ai-form">
      <header className="ai-view-head">
        <h2>Settings</h2>
        <p className="ai-hint">
          The assistant uses the model you connect here. Data also goes to the services you connect yourself: a team
          bucket, notification channels, Jira and Confluence, a chat bot, MCP servers and external agents.
        </p>
      </header>

      <section className="ai-set">
        <h3>Model</h3>
        <label className="ai-check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>
            Assistant on
            <small style={{ display: "block" }}>Off: nothing is collected and no model is called.</small>
          </span>
        </label>
        <label>
          Provider
          <select
            value={provider}
            onChange={(e) => {
              const next = e.target.value as typeof provider;
              // Another provider starts from its own address: a key typed next must not go to the old gateway.
              if (next !== provider) setUrl("");
              setProvider(next);
              setCustomModelMode(false);
              setSavedNotice(false);
              if (next === "openai-codex") {
                const codexDefault = hub.config.codexDefaultModel || DEFAULT_AI_MODELS["openai-codex"];
                const validCodex = hub.config.codexModels ?? DEFAULT_PROVIDER_MODELS["openai-codex"];
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
              } else if (next !== provider) {
                // A model of the other provider must not stay under this one. Going back to the saved provider
                // brings its saved model back; no known default leaves the field empty, with its placeholder.
                const fits =
                  DEFAULT_PROVIDER_MODELS[next].includes(model) || (next === "anthropic" && model.startsWith("claude-"));
                if (!fits) setModel(next === hub.config.provider ? hub.config.model : DEFAULT_AI_MODELS[next]);
              }
            }}
          >
            <option value="openai-codex">
              ChatGPT / Codex (OAuth, {hub.config.codexDefaultModel || "gpt-6.1-sol"})
            </option>
            <option value="anthropic">Anthropic</option>
            <option value="openai-compatible">OpenAI-compatible / local / enterprise</option>
          </select>
        </label>
        <small data-testid="ai-data-destination">{dataDestination(provider, url)}</small>
        {provider === "openai-codex" && (
          <small>
            {hub.config.codexConnected
              ? `Signed in with ChatGPT${hub.config.codexAccountEmail ? ` (${hub.config.codexAccountEmail})` : ""}. No API key needed.`
              : "Uses the ChatGPT / Codex sign-in on this computer. Not signed in yet. To sign in, run `codex login` in a terminal on this computer, then come back here."}
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
                placeholder={
                  provider === "anthropic" ? "https://api.anthropic.com (default)" : "http://localhost:11434/v1"
                }
              />
            </label>
            {provider === "openai-compatible" && <ProtocolSelect value={apiProtocol} onChange={setApiProtocol} />}
            <label>
              API key
              <input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={
                  hub.config.hasApiKey
                    ? "A key is saved · leave blank to keep it"
                    : provider === "anthropic"
                      ? "sk-ant-… (needed)"
                      : "Not needed for local models"
                }
              />
              <small>
                {hub.config.keyStorage === "session"
                  ? "This key is in memory. Enter it again after the app or server restarts."
                  : isWebBrowserMode()
                    ? "Saved keys are encrypted on the app server with its credential key."
                    : "Saved keys are encrypted with help from the operating system. If secure storage is unavailable, the key stays in memory."}
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

      <section className="ai-set" data-testid="provider-profiles-section">
        <div className="ai-section-head">
          <div>
            <h3>
              Saved models, and which one does what <span className="ai-count">{profiles.length}</span>
            </h3>
            <small>
              Save several models (for example Anthropic in the cloud, Ollama on this machine, one in your own network)
              and choose which one the chat, the quick checks, the summaries and the search use.
            </small>
          </div>
          <button
            type="button"
            data-testid="add-profile-btn"
            onClick={() =>
              setProfileDraft(
                profileDraft
                  ? undefined
                  : {
                      name: "",
                      provider: "openai-compatible",
                      model: "",
                      baseUrl: "http://localhost:11434/v1",
                      apiKey: "",
                      egressPolicy: "local-only",
                      zdrConfirmed: false,
                      reasoningEffort: "medium",
                      activeRole: "",
                    },
              )
            }
          >
            {profileDraft ? "Close" : "Add profile"}
          </button>
        </div>

        {profileDraft && (
          <div className="ai-card ai-form" data-testid="profile-form">
            <strong>{profileDraft.id ? "Edit provider profile" : "New provider profile"}</strong>
            <div className="ai-form-row">
              <label>
                Profile name
                <input
                  aria-label="Profile name"
                  placeholder="ollama-local / anthropic-eu"
                  value={profileDraft.name}
                  onChange={(e) => setProfileDraft({ ...profileDraft, name: e.target.value })}
                />
              </label>
              <label>
                Provider
                <select
                  aria-label="Profile provider"
                  value={profileDraft.provider}
                  onChange={(e) => {
                    const provider = e.target.value as AiProvider;
                    setProfileDraft({
                      ...profileDraft, provider,
                      activeRole: profileDraft.activeRole === "embedding" && provider !== "openai-compatible" ? "" : profileDraft.activeRole,
                    });
                  }}
                >
                  <option value="openai-codex">ChatGPT / Codex (OAuth)</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="openai-compatible">OpenAI-compatible / local</option>
                </select>
              </label>
            </div>
            <div className="ai-form-row">
              <label>
                Model ID
                <input
                  aria-label="Profile model"
                  placeholder="qwen3:32b / claude-sonnet-5-5"
                  value={profileDraft.model}
                  onChange={(e) => setProfileDraft({ ...profileDraft, model: e.target.value })}
                />
              </label>
              <label>
                Endpoint URL (optional)
                <input
                  aria-label="Profile base URL"
                  placeholder="http://localhost:11434/v1"
                  value={profileDraft.baseUrl}
                  onChange={(e) => setProfileDraft({ ...profileDraft, baseUrl: e.target.value })}
                />
              </label>
            </div>
            {profileDraft.provider === "openai-compatible" && <ProtocolSelect value={profileDraft.apiProtocol ?? "auto"} onChange={(v) => setProfileDraft({ ...profileDraft, apiProtocol: v })} />}
            <div className="ai-form-row">
              <label>
                Egress policy
                <select
                  aria-label="Profile egress policy"
                  value={profileDraft.egressPolicy}
                  onChange={(e) =>
                    setProfileDraft({ ...profileDraft, egressPolicy: e.target.value as AiEgressPolicy })
                  }
                >
                  <option value="standard">Standard</option>
                  <option value="eu-pinned">EU-pinned</option>
                  <option value="local-only">Local-only</option>
                </select>
              </label>
              <label>
                Assign to role (optional)
                <select
                  aria-label="Profile role"
                  value={profileDraft.activeRole}
                  onChange={(e) =>
                    setProfileDraft({ ...profileDraft, activeRole: e.target.value as "" | AiProfileRole })
                  }
                >
                  <option value="">Do not assign</option>
                  {PROFILE_ROLES.map((r) => (
                    <option key={r.role} value={r.role} disabled={r.role === "embedding" && profileDraft.provider !== "openai-compatible"}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {profileDraft.provider !== "openai-codex" && (
              <label>
                API key (optional)
                <input
                  type="password"
                  autoComplete="off"
                  aria-label="Profile API key"
                  placeholder="Leave blank to keep existing or omit for local"
                  value={profileDraft.apiKey}
                  onChange={(e) => setProfileDraft({ ...profileDraft, apiKey: e.target.value })}
                />
              </label>
            )}
            <label className="ai-check">
              <input
                type="checkbox"
                checked={profileDraft.zdrConfirmed}
                onChange={(e) => setProfileDraft({ ...profileDraft, zdrConfirmed: e.target.checked })}
              />
              <span>Zero Data Retention (ZDR) confirmed for this profile</span>
            </label>
            <div className="ai-card-actions">
              <button
                type="button"
                className="ai-btn-emerald"
                onClick={() => {
                  const name = profileDraft.name.trim();
                  const pModel = profileDraft.model.trim();
                  if (!name || !pModel) return;
                  void act({
                    action: "profile-save",
                    profile: {
                      id: profileDraft.id,
                      name,
                      provider: profileDraft.provider,
                      model: pModel,
                      ...(profileDraft.provider === "openai-compatible" ? { apiProtocol: profileDraft.apiProtocol ?? "auto" } : {}),
                      baseUrl: profileDraft.baseUrl.trim() || undefined,
                      egressPolicy: profileDraft.egressPolicy,
                      zdrConfirmed: profileDraft.zdrConfirmed,
                      reasoningEffort: profileDraft.reasoningEffort,
                    },
                    ...(profileDraft.apiKey ? { apiKey: profileDraft.apiKey } : {}),
                    ...(profileDraft.activeRole ? { activeRole: profileDraft.activeRole } : {}),
                  }).then((next) => {
                    if (next) setProfileDraft(undefined);
                  });
                }}
              >
                Save profile
              </button>
              <button type="button" onClick={() => setProfileDraft(undefined)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {profiles.length > 0 && (
          <div className="ai-grid" data-testid="provider-profiles-list">
            {profiles.map((p) => {
              const assignedRoles = PROFILE_ROLES.filter((r) => activeProfileByRole[r.role] === p.id).map(
                (r) => r.role,
              );
              return (
                <article className="ai-card" key={p.id} data-testid={`profile-card-${p.id}`}>
                  <div className="ai-card-head">
                    <div>
                      <strong>{p.name}</strong>
                      <small className="ai-mono">
                        {p.provider} · {p.model}
                        {p.baseUrl ? ` · ${p.baseUrl}` : ""}
                      </small>
                    </div>
                    <div className="ai-tags">
                      {p.egressPolicy && <span className="ai-badge">{p.egressPolicy}</span>}
                      {p.zdrConfirmed && <span className="ai-badge ai-badge-success">ZDR</span>}
                      {p.hasApiKey && <span className="ai-badge">key saved</span>}
                      {assignedRoles.map((role) => (
                        <span key={role} className="ai-badge ai-badge-purple">
                          {role}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="ai-card-actions">
                    <button
                      type="button"
                      onClick={() =>
                        setProfileDraft({
                          id: p.id,
                          name: p.name,
                          provider: p.provider,
                          model: p.model,
                          baseUrl: p.baseUrl ?? "",
                          apiProtocol: p.apiProtocol,
                          apiKey: "",
                          egressPolicy: p.egressPolicy ?? "standard",
                          zdrConfirmed: Boolean(p.zdrConfirmed),
                          reasoningEffort: p.reasoningEffort ?? "medium",
                          activeRole: "",
                        })
                      }
                    >
                      Edit
                    </button>
                    <span className="ai-spacer" />
                    <ConfirmButton
                      label="Delete"
                      confirmLabel="Remove this profile?"
                      onConfirm={() => void act({ action: "profile-delete", id: p.id })}
                    />
                  </div>
                </article>
              );
            })}
          </div>
        )}

        <div className="ai-form-row" data-testid="role-routing-grid">
          {PROFILE_ROLES.map(({ role, label, hint }) => (
            <label key={role}>
              {label}
              <select
                aria-label={label}
                data-testid={`role-select-${role}`}
                value={activeProfileByRole[role] ?? ""}
                onChange={(e) => {
                  const value = e.target.value;
                  setActiveProfileByRole((prev) => {
                    const next = { ...prev };
                    if (value) next[role] = value;
                    else delete next[role];
                    return next;
                  });
                  setSavedNotice(false);
                }}
              >
                <option value="">Default ({model || "configured model"})</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id} disabled={role === "embedding" && p.provider !== "openai-compatible"}>
                    {p.name} ({p.model})
                  </option>
                ))}
              </select>
              <small>{hint}</small>
            </label>
          ))}
        </div>
      </section>

      <section className="ai-set" data-testid="privacy-residency-section">
        <h3>Where your data may go</h3>
        <div className="ai-form-row">
          <label>
            Where data may be sent
            <select
              aria-label="Where data may be sent"
              data-testid="ai-egress-policy"
              value={egressPolicy}
              onChange={(e) => {
                setEgressPolicy(e.target.value as AiEgressPolicy);
                setSavedNotice(false);
              }}
            >
              <option value="standard">Any service you set up</option>
              <option value="eu-pinned">Only services in the EU</option>
              <option value="local-only">Only this machine and your own network</option>
            </select>
            <small>{formatEgressPolicyLabel(egressPolicy)}</small>
          </label>
          <label>
            What is hidden before anything is sent
            <select
              aria-label="What is hidden before anything is sent"
              data-testid="ai-pii-scrubbing"
              value={piiScrubbing}
              onChange={(e) => {
                setPiiScrubbing(e.target.value as AiPiiScrubbingMode);
                setSavedNotice(false);
              }}
            >
              <option value="off">Secrets only</option>
              <option value="standard">Secrets and personal details</option>
              <option value="strict">Also IP addresses and workspace host names</option>
            </select>
            <small>{formatPiiScrubbingLabel(piiScrubbing)}</small>
          </label>
        </div>

        <label className="ai-check">
          <input
            type="checkbox"
            data-testid="ai-zdr-confirmed"
            checked={zdrConfirmed}
            onChange={(e) => {
              setZdrConfirmed(e.target.checked);
              setSavedNotice(false);
            }}
          />
          <span>
            The model's provider keeps none of what is sent to it
            <small>
              Tick this when your agreement with the provider says it does not keep your prompts and answers, or
              train on them. Until you do, this page reminds you. It stops nothing by itself.
            </small>
          </span>
        </label>

        <article className="ai-card" data-testid="ai-data-flow-card">
          <div className="ai-card-head">
            <div>
              <strong>What leaves this machine</strong>
              <small>{dataFlow.summary}</small>
            </div>
            <span
              className={`ai-badge ${dataFlow.egressValidation.allowed ? "ai-badge-success" : "ai-badge-danger"}`}
              data-testid="data-flow-status-badge"
            >
              {dataFlow.egressValidation.allowed ? "Allowed by these settings" : "Stopped by these settings"}
            </span>
          </div>

          {dataFlow.egressValidation.errors.length > 0 && (
            <ul className="ai-eval-checks" data-testid="data-flow-errors">
              {dataFlow.egressValidation.errors.map((err, i) => (
                <li key={i} data-passed="no">
                  {err}
                </li>
              ))}
            </ul>
          )}

          {dataFlow.egressValidation.warnings.length > 0 && (
            <ul className="ai-eval-checks" data-testid="data-flow-warnings">
              {dataFlow.egressValidation.warnings.map((warn, i) => (
                <li key={i} data-passed="note">
                  {warn}
                </li>
              ))}
            </ul>
          )}

          <div className="ai-tags">
            {dataFlow.channels.map((ch) => (
              <span key={ch.channel} className="ai-tool-tag" title={ch.destination}>
                <span>
                  {DATA_CHANNEL_NAMES[ch.channel] ?? ch.channel}: <strong>{ch.locality === "local" && isWebBrowserMode() ? "the app server" : DATA_PLACES[ch.locality] ?? ch.locality}</strong>
                  {ch.enabled && ch.channel !== "local-storage" ? (ch.encryptedInTransit ? " · encrypted on the way" : " · not encrypted on the way") : ""}
                  {ch.piiScrubbing && ch.piiScrubbing !== "off" ? " · personal details hidden" : ""}
                </span>
              </span>
            ))}
          </div>

          <small data-testid="data-flow-subprocessors">
            {dataFlow.subprocessors.length > 0
              ? `Outside services that receive data: ${dataFlow.subprocessors
                  .map((s) => `${s.name} (${DATA_PLACES[s.locality] ?? s.locality}, ${s.zdrConfirmed ? "confirmed to keep nothing" : "not confirmed to keep nothing"})`)
                  .join("; ")}`
              : "The selected model and team bucket use local or private network addresses."}
          </small>
        </article>
      </section>

      <section className="ai-set">
        <h3>You and the team</h3>
        <label>
          Your name in the team&apos;s activity
          <input
            value={actorName}
            onChange={(e) => setActorName(e.target.value)}
            // Empty means the sign-in name is used: say which one, so the field does not look unset.
            placeholder={hub.signsAs ? `Signs as ${hub.signsAs}` : "Your name"}
          />
        </label>
        {hub.s3Workspace?.configured && (
          <small>
            {`Team bucket: s3://${hub.s3Workspace.bucket}/${hub.s3Workspace.prefix || "sshs3-team"}${
              hub.s3Workspace.lastSyncAt ? ` · synced ${new Date(hub.s3Workspace.lastSyncAt).toLocaleTimeString()}` : ""
            }`}
          </small>
        )}
        {/* What is shared and what is this person's own: the same words wherever it is said (sharingText). */}
        <div className="ai-sharing" data-testid="sharing-summary">
          <small data-testid="sharing-shared">{sharing.shared}</small>
          {sharing.personal && <small data-testid="sharing-personal">{sharing.personal}</small>}
          {sharing.more && <small data-testid="sharing-more">{sharing.more}</small>}
        </div>
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
            value={hub.preferences.approvalWaitMinutes ?? 0}
            onChange={(e) =>
              void act({
                action: "configure",
                config: {},
                preferences: { ...hub.preferences, approvalWaitMinutes: Number(e.target.value) },
              })
            }
          >
            {[0, 10, 20, 30, 45, 60].map((m) => (
              <option key={m} value={m}>
                {m === 0 ? "As long as it takes (default)" : `${m} minutes`}
              </option>
            ))}
          </select>
          <small>
            After that the action counts as denied and the agent goes on without it. The wait does not use up the run&apos;s
            time budget. Longer suits approvals that are answered from a phone.
          </small>
        </label>
      </section>

      <section className="ai-set" data-testid="labs-features-section">
        <h3>More views, and work that starts by itself</h3>
        <label className="ai-check">
          <input
            type="checkbox"
            data-testid="labs-features-toggle"
            checked={labsEnabled}
            onChange={(e) => setLabsEnabled(e.target.checked)}
          />
          <span>
            Show the extra views (Memory &amp; skills, Agents &amp; MCP, Schedules) and the switches for work that starts by itself
            <small>
              Off keeps the workspace to the chat, approvals and runbooks.
            </small>
          </span>
        </label>
        {labsEnabled && (
          <div className="ai-switches" data-testid="labs-features-controls">
            <label className="ai-check">
              <input
                type="checkbox"
                checked={Boolean(prefs.workforceAutopilot)}
                onChange={(e) => setPrefs({ ...prefs, workforceAutopilot: e.target.checked })}
              />
              <span>
                Start tickets by itself
                <small>A timer in the background picks up tickets that wait in &ldquo;To do&rdquo; and starts an agent on them.</small>
              </span>
            </label>
            <label className="ai-check">
              <input
                type="checkbox"
                checked={prefs.proposeMemories !== false}
                onChange={(e) => setPrefs({ ...prefs, proposeMemories: e.target.checked })}
              />
              <span>
                Learn from finished work
                <small>After a finished task, suggest team memories and write what was confirmed into knowledge base pages. With a team bucket, the finished conversation is uploaded there so that a teammate&rsquo;s app can read it. A conversation about a server marked Personal is left out: it is not uploaded and nothing is learned from it.</small>
              </span>
            </label>
            <label className="ai-check">
              <input
                type="checkbox"
                checked={prefs.autoSaveMemories !== false}
                onChange={(e) => setPrefs({ ...prefs, autoSaveMemories: e.target.checked })}
              />
              <span>
                Auto-save verified low-risk memories
                <small>Off: hold all proposed memories in the review queue until explicitly accepted.</small>
              </span>
            </label>
            <label className="ai-check">
              <input
                type="checkbox"
                checked={prefs.recordSessions !== false}
                onChange={(e) => setPrefs({ ...prefs, recordSessions: e.target.checked })}
              />
              <span>
                Record agent-owned terminal sessions
                <small>Save masked asciicast v2 recordings for replay and eval promotion.</small>
              </span>
            </label>
          </div>
        )}
      </section>

      <section className="ai-set">
        <h3>Notifications</h3>
        <NotificationsCard hub={hub} act={act} />
      </section>

      <section className="ai-set">
        <h3>Slack and Mattermost</h3>
        <TeamChatCard hub={hub} act={act} />
        <AgentInChatCard hub={hub} act={act} error={error} />
      </section>

      {/* The app answering this person's own agent: desktop starts a local listener; web server already serves /api/mcp. */}
      {isWebBrowserMode() ? (
        <section className="ai-set" data-testid="web-mcp">
          <h3>Your own agents (MCP)</h3>
          <McpKeysPanel
            api={webMcpKeysApi}
            origin={typeof window !== "undefined" ? window.location.origin : ""}
            title="Your keys for this server"
            intro="Create a personal MCP key to connect Claude Code, Cursor, or another MCP client to this sshS3 server. Each key acts with your permissions and can be revoked at any time."
          />
        </section>
      ) : (
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
            <McpKeysPanel
              api={localKeysApi}
              origin=""
              endpoint={hub.localMcp.address}
              title="Your keys"
              intro="A key is shown once, when you make it. It acts as you and sees what you see; take it back at any time."
            />
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

          </div>
          <div className="ai-form-row">
            <label>
              Reasoning effort
              <select
                aria-label="Reasoning Effort"
                value={reasoningEffort}
                onChange={(e) => setReasoningEffort(e.target.value as AiReasoningEffort)}
              >
                <option value="low">Low: fastest</option>
                <option value="medium">Medium (default)</option>
                <option value="high">High: for hard root-cause work</option>
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
                  setPrefs({
                    ...prefs,
                    background: e.target.checked,
                    autoStart: e.target.checked && prefs.autoStart,
                  })
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
            <small style={{ display: "block", marginTop: 2 }}>
              Only tests that the address responds; nothing is logged in to.
            </small>
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

      <section className="ai-set ai-set-data">
        <h3>Data</h3>
        <div className="ai-card-actions">
          {/* It also brings back what a teammate removed for the team, so it asks. Nothing of your own is overwritten. */}
          <ConfirmButton
            label="Restore built-in agents, runbooks and skills"
            confirmLabel="Bring back the built-in ones that were removed?"
            className=""
            onConfirm={() => {
              setRestoreStatus("");
              void act({ action: "restore-builtins" })
                .then((next) => {
                  const notes = next?.reply?.notes?.join(" ");
                  setRestoreStatus(notes || "Built-in agents, runbooks, and skills restored.");
                })
                .catch((err) => {
                  setRestoreStatus(err instanceof Error ? err.message : "Could not restore built-ins.");
                });
            }}
          />
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
        {restoreStatus && (
          <small role="status" data-testid="restore-builtins-status">
            {restoreStatus}
          </small>
        )}
        <small>Deleting history does not touch team memory or the knowledge base.</small>
      </section>
      </div>

      <div className="ai-set-save">
        <button type="submit" className="ai-btn-emerald">
          Save settings
        </button>
        <button
          type="button"
          data-testid="ai-test-connection"
          disabled={probing}
          title="Asks the saved model whether it answers. Save first to test changes."
          onClick={() => {
            setProbing(true);
            setProbe(undefined);
            void act({ action: "ai-probe" })
              .then((result) =>
                setProbe(result?.reply?.probe ?? { ok: false, detail: "The check could not be made." }),
              )
              .finally(() => setProbing(false));
          }}
        >
          {probing ? "Testing…" : "Test connection"}
        </button>
        {savedNotice && <small role="status">Settings saved.</small>}
        {probe && (
          <small
            data-testid="ai-test-connection-result"
            role={probe.ok ? "status" : "alert"}
            style={{ color: probe.ok ? "var(--ok-fg)" : "var(--danger-fg)" }}
          >
            {probe.detail || (probe.ok ? "The model answers." : "The model did not answer.")}
          </small>
        )}
      </div>
    </form>
  );
}

export { Settings as SettingsView };
