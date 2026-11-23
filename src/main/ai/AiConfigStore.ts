import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { app } from "electron";
import {
  DEFAULT_AI_CONFIG,
  DEFAULT_AI_MODELS,
  type AiActiveProfileByRole,
  type AiApiProtocol,
  type AiConfig,
  type AiConfigUpdate,
  type AiConfigView,
  type AiEgressPolicy,
  type AiPiiScrubbingMode,
  type AiProfileRole,
  type AiProvider,
  type AiReasoningEffort,
  type ProviderProfile,
} from "../../shared/types/ai";
import { CodexAuthProvider } from "./CodexAuthProvider";
import { isDemoMode } from "../demo/demoMode";
import { writeFileAtomic } from "../storage/atomicFile";
import {
  decryptSecretValue,
  encryptSecretValue,
  isEncryptedSecret,
  isEncryptionAvailable,
} from "../crypto/SecretFieldCrypto";

export type AiProfileRoleAlias = "reasoning" | "fast" | "coding" | "summary";
export type AiProfileRoleInput = AiProfileRole | AiProfileRoleAlias;

interface StoredAiConfig extends AiConfig {
  /** OS-keyring ciphertext. New keys remain session-only if encryption is unavailable. */
  apiKey?: string;
  /** OS-keyring ciphertext keyed by ProviderProfile.id. */
  profileApiKeys?: Record<string, string>;
}

const PROVIDERS: AiProvider[] = ["openai-codex", "anthropic", "openai-compatible"];
const API_PROTOCOLS: AiApiProtocol[] = ["auto", "responses", "chat-completions"];
const EGRESS_POLICIES: AiEgressPolicy[] = ["standard", "local-only", "eu-pinned"];
const PII_SCRUBBING_MODES: AiPiiScrubbingMode[] = ["off", "standard", "strict"];
const REASONING_EFFORTS: AiReasoningEffort[] = ["low", "medium", "high"];
const CANONICAL_ROLES: AiProfileRole[] = ["primary", "fastTriage", "backgroundDistill", "embedding"];

const ROLE_ALIAS_MAP: Record<AiProfileRoleInput, AiProfileRole> = {
  primary: "primary",
  reasoning: "primary",
  coding: "primary",
  fastTriage: "fastTriage",
  fast: "fastTriage",
  backgroundDistill: "backgroundDistill",
  summary: "backgroundDistill",
  embedding: "embedding",
};

/** Maps canonical roles and legacy/friendly aliases (`reasoning|fast|coding|summary`) to `AiProfileRole`. */
export function normalizeAiProfileRole(role: string): AiProfileRole {
  if (Object.prototype.hasOwnProperty.call(ROLE_ALIAS_MAP, role)) {
    return ROLE_ALIAS_MAP[role as AiProfileRoleInput];
  }
  throw new Error(`Unknown AI profile role: ${role}`);
}

function originOf(url?: string): string {
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
}

function clampContextWindow(val: unknown): number {
  return Math.max(4000, Math.min(1_000_000, Math.round(Number(val) || 128000)));
}

function clampMaxOutput(val: unknown): number {
  return Math.max(512, Math.min(65536, Math.round(Number(val) || 8192)));
}

function clampTemperature(val: unknown): number | undefined {
  if (val === undefined || val === null) return undefined;
  const n = Number(val);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(1.5, Math.round(n * 100) / 100));
}

function sanitizeProfile(input: ProviderProfile): ProviderProfile {
  const id = typeof input.id === "string" ? input.id.trim().slice(0, 80) : "";
  if (!id) {
    throw new Error("Provider profile id is required");
  }
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
  if (!name) {
    throw new Error(`Provider profile "${id}" requires a name`);
  }
  if (!PROVIDERS.includes(input.provider)) {
    throw new Error(`Unknown AI provider in profile "${id}"`);
  }
  const model = typeof input.model === "string" ? input.model.trim().slice(0, 200) : "";
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : undefined;
  if (baseUrl) {
    assertHttpUrl(baseUrl);
  }
  if (input.egressPolicy !== undefined && !EGRESS_POLICIES.includes(input.egressPolicy)) {
    throw new Error(`Invalid egressPolicy in profile "${id}"`);
  }

  const sanitized: ProviderProfile = {
    id,
    name,
    provider: input.provider,
    model,
    updatedAt: typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt) ? input.updatedAt : Date.now(),
  };
  if (baseUrl) sanitized.baseUrl = baseUrl;
  if (input.apiProtocol !== undefined) {
    if (!API_PROTOCOLS.includes(input.apiProtocol)) throw new Error("Unknown model API protocol.");
    sanitized.apiProtocol = input.apiProtocol;
  }
  if (input.reasoningEffort && REASONING_EFFORTS.includes(input.reasoningEffort)) {
    sanitized.reasoningEffort = input.reasoningEffort;
  }
  const temp = clampTemperature(input.temperature);
  if (temp !== undefined) sanitized.temperature = temp;
  if (input.maxOutputTokens !== undefined) sanitized.maxOutputTokens = clampMaxOutput(input.maxOutputTokens);
  if (input.contextWindowTokens !== undefined) {
    sanitized.contextWindowTokens = clampContextWindow(input.contextWindowTokens);
  }
  if (typeof input.embeddingModel === "string" && input.embeddingModel.trim()) {
    sanitized.embeddingModel = input.embeddingModel.trim().slice(0, 200);
  }
  if (input.egressPolicy !== undefined) sanitized.egressPolicy = input.egressPolicy;
  if (input.zdrConfirmed !== undefined) sanitized.zdrConfirmed = Boolean(input.zdrConfirmed);
  if (Array.isArray(input.fallbackProfileIds)) {
    const fallbacks = [...new Set(input.fallbackProfileIds.map((x) => String(x).trim()).filter((x) => x && x !== id))];
    if (fallbacks.length > 0) sanitized.fallbackProfileIds = fallbacks;
  }
  return sanitized;
}

/**
 * Persists the AI assistant's configuration in its own file (ai-config.json), not in
 * settings.json: settings are part of remote profile sync, and an API key, or the choice
 * to send terminal text to a third party at all, should stay on the machine where it was made.
 */
export class AiConfigStore {
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private sessionKey = "";
  private sessionProfileKeys = new Map<string, string>();
  /** A workspace with a folder of its own (a tenant on a shared server, a test): its sign-in is looked for there only. */
  private readonly ownFolderOnly: boolean;

  constructor(customPath?: string) {
    this.ownFolderOnly = Boolean(customPath);
    if (customPath) {
      this.filePath = customPath;
    } else {
      let baseDir: string;
      try {
        baseDir = app.getPath("userData");
      } catch {
        baseDir = path.join(os.homedir(), ".sshs3");
      }
      this.filePath = path.join(baseDir, "ai-config.json");
    }
  }

  public getFilePath(): string {
    return this.filePath;
  }

  /**
   * Where the ChatGPT/Codex sign-in is looked for, as the argument to CodexAuthProvider. A workspace
   * with its own folder, and the demo, look in that folder only: never in the host's ~/.codex. The
   * desktop app (undefined) also uses the person's own `codex login`, so the status shown and the
   * sign-in a run uses are the same one.
   */
  public codexAuthDir(): string | undefined {
    return this.ownFolderOnly || isDemoMode() ? path.dirname(this.filePath) : undefined;
  }

  private decryptStoredProfileKey(stored: StoredAiConfig, profileId: string): string {
    const mem = this.sessionProfileKeys.get(profileId);
    if (mem) return mem;
    const cipher = stored.profileApiKeys?.[profileId];
    return cipher ? decryptSecretValue(cipher) : "";
  }

  /** Read destination and secret together so an edited profile cannot send its new key to its old address. */
  public async getConnectionProfile(id: string): Promise<(ProviderProfile & { apiKey: string }) | undefined> {
    const stored = await this.readWithCodexAutoDetect();
    const profile = this.publicFields(stored).profiles?.find((p) => p.id === id);
    return profile && { ...profile, apiKey: this.decryptStoredProfileKey(stored, id) };
  }

  private resolvePrimaryProfile(stored: StoredAiConfig): ProviderProfile | undefined {
    const primaryId = stored.activeProfileByRole?.primary;
    if (!primaryId || !Array.isArray(stored.profiles)) return undefined;
    return stored.profiles.find((p) => p.id === primaryId);
  }

  /** Returns the decrypted API key for a named provider profile. Main process only. */
  public async getProfileSecret(profileId: string): Promise<string> {
    const stored = await this.readWithCodexAutoDetect();
    return this.decryptStoredProfileKey(stored, profileId);
  }

  /**
   * Resolves the active `ProviderProfile` and decrypted `apiKey` for a role (supporting canonical
   * `AiProfileRole` names and `reasoning|fast|coding|summary` aliases). Falls back to `primary`,
   * or synthesizes a profile from legacy single-profile fields when no `profiles` are configured.
   */
  public async resolveProfileForRole(
    role: AiProfileRoleInput,
  ): Promise<(ProviderProfile & { apiKey: string }) | null> {
    const stored = await this.readWithCodexAutoDetect();
    const pub = this.publicFields(stored);
    const canonical = normalizeAiProfileRole(role);
    const assigned = this.profileForRole(stored, pub, canonical);
    if (assigned) return assigned;
    const first = canonical === "primary" && pub.profiles?.[0];
    if (first) return { ...first, apiKey: this.decryptStoredProfileKey(stored, first.id) };
    const apiKey = this.legacyKey(stored);
    const fallbackModel =
      canonical === "fastTriage" && pub.fastModel
        ? pub.fastModel
        : canonical === "embedding" && pub.embeddingModel
          ? pub.embeddingModel
          : pub.model;
    return {
      id: "default",
      name: "Default",
      provider: pub.provider,
      model: fallbackModel,
      baseUrl: pub.baseUrl,
      apiProtocol: pub.apiProtocol,
      reasoningEffort: pub.reasoningEffort,
      temperature: pub.temperature,
      maxOutputTokens: pub.maxOutputTokens,
      contextWindowTokens: pub.contextWindowTokens,
      embeddingModel: pub.embeddingModel,
      egressPolicy: pub.egressPolicy,
      zdrConfirmed: pub.zdrConfirmed,
      hasApiKey: Boolean(apiKey),
      keyStorage: this.sessionKey ? "session" : stored.apiKey ? "encrypted" : undefined,
      apiKey,
    };
  }

  private profileForRole(stored: StoredAiConfig, pub: AiConfig, role: AiProfileRole): (ProviderProfile & { apiKey: string }) | undefined {
    const assigned = pub.activeProfileByRole?.[role];
    const primary = pub.activeProfileByRole?.primary;
    const matched = pub.profiles?.find((profile) => profile.id === assigned) ??
      pub.profiles?.find((profile) => profile.id === primary);
    if (matched) {
      const legacyMatches = matched.id === pub.activeProfileByRole?.primary &&
        matched.provider === pub.provider && originOf(matched.baseUrl) === originOf(pub.baseUrl);
      const apiKey = this.decryptStoredProfileKey(stored, matched.id) || (legacyMatches ? this.legacyKey(stored) : "");
      return { ...matched, apiKey };
    }
    return undefined;
  }

  private legacyKey(stored: StoredAiConfig): string {
    return this.sessionKey || (stored.apiKey ? decryptSecretValue(stored.apiKey) : "");
  }

  private resolveLegacyOrPrimaryKey(stored: StoredAiConfig): string {
    const primaryId = stored.activeProfileByRole?.primary;
    if (primaryId) {
      const profileKey = this.decryptStoredProfileKey(stored, primaryId);
      const profile = this.resolvePrimaryProfile(stored);
      if (profileKey && profile?.provider === stored.provider && originOf(profile.baseUrl) === originOf(stored.baseUrl)) return profileKey;
    }
    return this.sessionKey || (stored.apiKey ? decryptSecretValue(stored.apiKey) : "");
  }

  /** Resolve a model operation from one read of its profile, key and workspace-wide privacy settings. Main process only. */
  public async getConfig(role?: AiProfileRole, useLegacyFastModel = true): Promise<AiConfig & { apiKey: string; profileId?: string; fallbackProfileIds?: string[] }> {
    const stored = await this.readWithCodexAutoDetect();
    const workspace = this.publicFields(stored);
    if (!role) return { ...workspace, apiKey: this.resolveLegacyOrPrimaryKey(stored) };
    const profile = this.profileForRole(stored, workspace, role);
    const explicitlyAssigned = profile !== undefined && profile.id === workspace.activeProfileByRole?.[role];
    const legacyFastRole = role === "fastTriage" || role === "backgroundDistill";
    const fast = useLegacyFastModel && legacyFastRole && !explicitlyAssigned ? workspace.fastModel : undefined;
    if (!profile) return { ...workspace, apiKey: this.resolveLegacyOrPrimaryKey(stored), model: fast || workspace.model };

    // A profile supplies its own credentials and protocol. Global privacy settings still apply.
    const globalPolicy = workspace.egressPolicy ?? "standard";
    const profilePolicy = profile.egressPolicy ?? "standard";
    if (globalPolicy !== "standard" && profilePolicy !== "standard" && globalPolicy !== profilePolicy) {
      throw new Error("The selected profile and workspace require different data residency policies.");
    }
    const sameEndpoint = profile.id === workspace.activeProfileByRole?.primary && profile.provider === workspace.provider &&
      originOf(profile.baseUrl) === originOf(workspace.baseUrl);
    const embeddingModel = role === "embedding" && explicitlyAssigned ? profile.model : sameEndpoint ? workspace.embeddingModel : undefined;
    return {
      ...workspace,
      provider: profile.provider,
      model: fast || profile.model,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      apiProtocol: profile.apiProtocol,
      profileId: profile.id,
      fallbackProfileIds: profile.fallbackProfileIds,
      egressPolicy: globalPolicy === "standard" ? profilePolicy : globalPolicy,
      zdrConfirmed: profile.zdrConfirmed ?? (sameEndpoint ? workspace.zdrConfirmed : false),
      embeddingModel: profile.embeddingModel ?? embeddingModel,
      reasoningEffort: profile.reasoningEffort ?? workspace.reasoningEffort,
      temperature: profile.temperature ?? workspace.temperature,
      maxOutputTokens: profile.maxOutputTokens ?? workspace.maxOutputTokens,
      contextWindowTokens: profile.contextWindowTokens ?? workspace.contextWindowTokens,
    };
  }

  public async getView(): Promise<AiConfigView> {
    const stored = await this.readWithCodexAutoDetect();
    const rest = this.publicFields(stored);
    const apiKey = this.resolveLegacyOrPrimaryKey(stored);
    const codexProvider = new CodexAuthProvider(this.codexAuthDir());
    const codex = await codexProvider.getStatus();
    const codexModels = await codexProvider.getAvailableModels();
    const hasOAuth = rest.provider === "openai-codex" && codex.connected;

    // Annotate profile key metadata without ever returning secret values
    const profiles = rest.profiles?.map((p) => {
      const mem = this.sessionProfileKeys.get(p.id);
      const cipher = stored.profileApiKeys?.[p.id];
      const profileOAuth = p.provider === "openai-codex" && codex.connected;
      const hasSavedKey = Boolean(cipher && !mem && decryptSecretValue(cipher));
      const hasProfileKey = Boolean(mem || hasSavedKey || profileOAuth);
      const keyStorage: ProviderProfile["keyStorage"] = mem
        ? "session"
        : profileOAuth && !hasSavedKey
          ? "oauth"
          : hasSavedKey
            ? "encrypted"
            : undefined;
      return {
        ...p,
        hasApiKey: hasProfileKey,
        keyStorage,
      };
    });

    const primaryId = rest.activeProfileByRole?.primary;
    const primaryProfile = primaryId ? profiles?.find((p) => p.id === primaryId) : undefined;
    const activeSessionKey = primaryId
      ? Boolean(this.sessionProfileKeys.get(primaryId) || this.sessionKey)
      : Boolean(this.sessionKey);

    return {
      ...rest,
      ...(profiles ? { profiles } : {}),
      hasApiKey: Boolean(apiKey) || hasOAuth || Boolean(primaryProfile?.hasApiKey),
      keyStorage: activeSessionKey ? "session" : hasOAuth && !apiKey ? "oauth" : "encrypted",
      codexConnected: codex.connected,
      codexAccountEmail: codex.email,
      codexDefaultModel: codex.defaultModel || DEFAULT_AI_MODELS["openai-codex"],
      codexModels,
    };
  }

  /** Creates or updates a single named provider profile (and optionally its API key). */
  public async upsertProfile(
    profile: Omit<ProviderProfile, "hasApiKey" | "keyStorage"> & { apiKey?: string | null },
  ): Promise<AiConfigView> {
    const { apiKey: nextKey, ...profileFields } = profile;
    // Read and written in one turn of the write queue: the whole list of profiles is saved, so two
    // saves that each read the list before the other wrote would lose one of the two profiles.
    await this.queueMutation(async () => {
      const current = await this.read();
      const existing = Array.isArray(current.profiles) ? [...current.profiles] : [];
      const idx = existing.findIndex((p) => p.id === profileFields.id.trim());
      if (idx >= 0) {
        existing[idx] = profileFields;
      } else {
        existing.push(profileFields);
      }
      const updatePayload: AiConfigUpdate = { profiles: existing };
      if (typeof nextKey === "string" || nextKey === null) {
        updatePayload.profileApiKeys = { [profileFields.id.trim()]: nextKey };
      }
      await this.applyUpdate(updatePayload);
    });
    return this.getView();
  }

  /** Deletes a named provider profile, its encrypted key, and any role bindings referencing it. */
  public async deleteProfile(profileId: string): Promise<AiConfigView> {
    const id = profileId.trim();
    await this.queueMutation(async () => {
      const current = await this.read();
      const nextProfiles = (current.profiles ?? []).filter((p) => p.id !== id);
      const nextRoles: AiActiveProfileByRole = { ...(current.activeProfileByRole ?? {}) };
      for (const role of CANONICAL_ROLES) {
        if (nextRoles[role] === id) {
          delete nextRoles[role];
        }
      }
      await this.applyUpdate({
        profiles: nextProfiles,
        activeProfileByRole: nextRoles,
        profileApiKeys: { [id]: null },
      });
    });
    return this.getView();
  }

  /** Assigns or clears the active profile ID for a given role (supports canonical names and aliases). */
  public async setActiveProfileForRole(
    role: AiProfileRoleInput,
    profileId: string | null,
  ): Promise<AiConfigView> {
    const canonical = normalizeAiProfileRole(role);
    await this.queueMutation(async () => {
      const current = await this.read();
      const nextRoles: AiActiveProfileByRole = { ...(current.activeProfileByRole ?? {}) };
      if (profileId === null || profileId.trim() === "") {
        delete nextRoles[canonical];
      } else {
        nextRoles[canonical] = profileId.trim();
      }
      await this.applyUpdate({ activeProfileByRole: nextRoles });
    });
    return this.getView();
  }

  public async update(update: AiConfigUpdate): Promise<AiConfigView> {
    await this.queueMutation(() => this.applyUpdate(update));
    return this.getView();
  }

  /**
   * Reads what is stored, applies the update and writes it. Only ever called from inside the write
   * queue (`queueMutation`): what it reads is then what the save before it wrote.
   */
  private async applyUpdate(update: AiConfigUpdate): Promise<void> {
    {
      const current = await this.read();
      const next: StoredAiConfig = {
        ...current,
        ...(current.profiles ? { profiles: [...current.profiles] } : {}),
        ...(current.activeProfileByRole ? { activeProfileByRole: { ...current.activeProfileByRole } } : {}),
        ...(current.profileApiKeys ? { profileApiKeys: { ...current.profileApiKeys } } : {}),
      };

      if (update.enabled !== undefined) next.enabled = Boolean(update.enabled);
      if (update.provider !== undefined) {
        if (!PROVIDERS.includes(update.provider))
          throw new Error("Unknown AI provider");
        next.provider = update.provider;
      }
      if (update.model !== undefined) next.model = update.model.trim();
      if (update.actorName !== undefined) {
        const actor = update.actorName.trim().slice(0, 80);
        if (actor) next.actorName = actor;
        else delete next.actorName;
      }
      if (update.contextWindowTokens !== undefined) {
        next.contextWindowTokens = clampContextWindow(update.contextWindowTokens);
      }
      if (update.fastModel !== undefined) {
        const name = String(update.fastModel).trim().slice(0, 200);
        if (name) next.fastModel = name;
        else delete next.fastModel;
      }
      if (update.embeddingModel !== undefined) {
        const name = String(update.embeddingModel).trim().slice(0, 200);
        if (name) next.embeddingModel = name;
        else delete next.embeddingModel;
      }
      if (update.terminalContextChars !== undefined) {
        next.terminalContextChars = Math.max(
          1000,
          Math.min(128000, Math.round(Number(update.terminalContextChars) || 8000)),
        );
      }
      if (update.maxOutputTokens !== undefined) {
        next.maxOutputTokens = clampMaxOutput(update.maxOutputTokens);
      }
      if (update.maxToolTurns !== undefined) {
        next.maxToolTurns = Math.max(
          2,
          Math.min(80, Math.round(Number(update.maxToolTurns) || 20)),
        );
      }
      if (update.reasoningEffort !== undefined) {
        if (REASONING_EFFORTS.includes(update.reasoningEffort)) {
          next.reasoningEffort = update.reasoningEffort;
        }
      }
      if (update.temperature !== undefined) {
        const clamped = clampTemperature(update.temperature);
        if (clamped !== undefined) next.temperature = clamped;
      }
      if (update.useHermes !== undefined)
        next.useHermes = Boolean(update.useHermes);
      if (update.baseUrl !== undefined) {
        const baseUrl = update.baseUrl.trim();
        if (baseUrl) assertHttpUrl(baseUrl);
        next.baseUrl = baseUrl || undefined;
      }

      if (update.apiProtocol !== undefined) {
        if (!API_PROTOCOLS.includes(update.apiProtocol)) throw new Error("Unknown model API protocol.");
        next.apiProtocol = update.apiProtocol;
      }
      if (update.egressPolicy !== undefined) {
        if (!EGRESS_POLICIES.includes(update.egressPolicy)) {
          throw new Error(`Invalid egressPolicy: ${String(update.egressPolicy)}`);
        }
        next.egressPolicy = update.egressPolicy;
      }
      if (update.zdrConfirmed !== undefined) {
        next.zdrConfirmed = Boolean(update.zdrConfirmed);
      }
      if (update.piiScrubbing !== undefined) {
        if (!PII_SCRUBBING_MODES.includes(update.piiScrubbing)) {
          throw new Error(`Invalid piiScrubbing mode: ${String(update.piiScrubbing)}`);
        }
        next.piiScrubbing = update.piiScrubbing;
      }

      // Multi-profile persistence & endpoint-bound secret invalidation
      if (update.profiles !== undefined) {
        const prevById = new Map((current.profiles ?? []).map((p) => [p.id, p]));
        const seenIds = new Set<string>();
        const sanitizedList: ProviderProfile[] = [];
        for (const rawProfile of update.profiles) {
          const clean = sanitizeProfile(rawProfile);
          if (seenIds.has(clean.id)) {
            throw new Error(`Duplicate provider profile id "${clean.id}"`);
          }
          seenIds.add(clean.id);
          sanitizedList.push(clean);

          const prev = prevById.get(clean.id);
          const explicitKeyProvided =
            update.profileApiKeys !== undefined &&
            Object.prototype.hasOwnProperty.call(update.profileApiKeys, clean.id);
          if (
            prev &&
            !explicitKeyProvided &&
            (prev.provider !== clean.provider || originOf(prev.baseUrl) !== originOf(clean.baseUrl))
          ) {
            if (next.profileApiKeys) delete next.profileApiKeys[clean.id];
            this.sessionProfileKeys.delete(clean.id);
          }
        }
        next.profiles = sanitizedList;

        // Clean up keys for deleted profiles
        if (next.profileApiKeys) {
          for (const storedId of Object.keys(next.profileApiKeys)) {
            if (!seenIds.has(storedId)) delete next.profileApiKeys[storedId];
          }
        }
        for (const memId of [...this.sessionProfileKeys.keys()]) {
          if (!seenIds.has(memId)) this.sessionProfileKeys.delete(memId);
        }
        if (next.activeProfileByRole) {
          for (const role of CANONICAL_ROLES) {
            const boundId = next.activeProfileByRole[role];
            if (boundId && !seenIds.has(boundId)) {
              delete next.activeProfileByRole[role];
            }
          }
        }
      }

      if (update.profileApiKeys !== undefined) {
        const keyMap: Record<string, string> = { ...(next.profileApiKeys ?? {}) };
        for (const [rawId, rawSecret] of Object.entries(update.profileApiKeys)) {
          const profileId = rawId.trim();
          if (!profileId) continue;
          if (rawSecret === null || rawSecret === "") {
            delete keyMap[profileId];
            this.sessionProfileKeys.delete(profileId);
          } else if (typeof rawSecret === "string") {
            const trimmedSecret = rawSecret.trim();
            const encrypted = isEncryptionAvailable() ? encryptSecretValue(trimmedSecret) : "";
            if (isEncryptedSecret(encrypted)) {
              keyMap[profileId] = encrypted;
              this.sessionProfileKeys.delete(profileId);
            } else {
              this.sessionProfileKeys.set(profileId, trimmedSecret);
              delete keyMap[profileId];
            }
          }
        }
        if (Object.keys(keyMap).length > 0) next.profileApiKeys = keyMap;
        else delete next.profileApiKeys;
      }

      if (update.activeProfileByRole !== undefined) {
        const normalizedRoles: AiActiveProfileByRole = {};
        const validIds = new Set((next.profiles ?? []).map((p) => p.id));
        for (const [rawRole, rawProfileId] of Object.entries(update.activeProfileByRole)) {
          const canonical = normalizeAiProfileRole(rawRole);
          if (typeof rawProfileId !== "string" || !rawProfileId.trim()) continue;
          const pid = rawProfileId.trim();
          if (next.profiles && next.profiles.length > 0 && !validIds.has(pid)) {
            throw new Error(`Active profile "${pid}" for role "${canonical}" does not exist`);
          }
          normalizedRoles[canonical] = pid;
        }
        if (Object.keys(normalizedRoles).length > 0) next.activeProfileByRole = normalizedRoles;
        else delete next.activeProfileByRole;
      }

      // Sync top-level legacy fields when a primary profile is activated without explicit top-level overrides
      const primaryProfile = this.resolvePrimaryProfile(next);
      if (
        primaryProfile &&
        update.provider === undefined &&
        update.model === undefined &&
        (update.activeProfileByRole !== undefined || update.profiles !== undefined)
      ) {
        next.provider = primaryProfile.provider;
        if (primaryProfile.model) next.model = primaryProfile.model;
        next.baseUrl = primaryProfile.baseUrl;
        if (update.apiProtocol === undefined) next.apiProtocol = primaryProfile.apiProtocol;
        if (primaryProfile.reasoningEffort) next.reasoningEffort = primaryProfile.reasoningEffort;
        if (primaryProfile.temperature !== undefined) next.temperature = primaryProfile.temperature;
        if (primaryProfile.maxOutputTokens !== undefined) next.maxOutputTokens = primaryProfile.maxOutputTokens;
        if (primaryProfile.contextWindowTokens !== undefined) {
          next.contextWindowTokens = primaryProfile.contextWindowTokens;
        }
        if (primaryProfile.embeddingModel !== undefined) next.embeddingModel = primaryProfile.embeddingModel;
        if (primaryProfile.egressPolicy !== undefined && update.egressPolicy === undefined) {
          next.egressPolicy = primaryProfile.egressPolicy;
        }
        if (primaryProfile.zdrConfirmed !== undefined && update.zdrConfirmed === undefined) {
          next.zdrConfirmed = primaryProfile.zdrConfirmed;
        }
      }

      if (next.provider === "openai-codex") {
        if (next.baseUrl && next.baseUrl.includes("openrouter.ai")) {
          delete next.baseUrl;
        }
        if (isStaleOrNonCodexModel(next.model)) {
          const codex = await new CodexAuthProvider(this.codexAuthDir()).getStatus();
          next.model = codex.defaultModel || DEFAULT_AI_MODELS["openai-codex"];
        }
      }

      // A key belongs to the endpoint it was given for. When the provider or
      // the address (its origin) changes and no new key comes with the change,
      // the old key is forgotten rather than sent somewhere new.
      if (
        update.apiKey === undefined &&
        (next.provider !== current.provider || originOf(next.baseUrl) !== originOf(current.baseUrl))
      ) {
        delete next.apiKey;
        this.sessionKey = "";
      }
      if (update.apiKey === null || update.apiKey === "") {
        delete next.apiKey;
        this.sessionKey = "";
      } else if (typeof update.apiKey === "string") { // pragma: allowlist secret
        const encrypted = isEncryptionAvailable()
          ? encryptSecretValue(update.apiKey.trim())
          : "";
        if (isEncryptedSecret(encrypted)) {
          next.apiKey = encrypted;
          this.sessionKey = "";
        } else {
          this.sessionKey = update.apiKey.trim();
          delete next.apiKey;
        }
      }

      await writeFileAtomic(this.filePath, JSON.stringify(next, null, 2), { mode: 0o600 });
    }
  }

  private async readWithCodexAutoDetect(): Promise<StoredAiConfig> {
    try {
      const raw = stripBom(await fs.readFile(this.filePath, "utf-8"));
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new SyntaxError("Invalid AI config JSON");
      }
      const data = parsed as Partial<StoredAiConfig>;
      // What was saved is what holds: the switch, the provider and its address are never changed on
      // reading because a ChatGPT/Codex sign-in happens to be there. Only a Codex model name that
      // Codex does not have is put right, for a configuration that is Codex already.
      const merged = { ...DEFAULT_AI_CONFIG, ...data } as StoredAiConfig;
      if (merged.provider === "openai-codex") {
        if (merged.baseUrl && merged.baseUrl.includes("openrouter.ai")) {
          delete merged.baseUrl;
        }
        if (isStaleOrNonCodexModel(merged.model)) {
          const codex = await new CodexAuthProvider(this.codexAuthDir()).getStatus();
          merged.model = codex.defaultModel || DEFAULT_AI_MODELS["openai-codex"];
        }
      }
      return merged;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError)
      ) {
        throw error;
      }
      // Nothing saved yet: a ChatGPT/Codex sign-in found for this workspace is offered as the
      // provider, but the assistant stays off until a person switches it on.
      const codex = await new CodexAuthProvider(this.codexAuthDir()).getStatus();
      if (codex.connected) {
        return {
          ...DEFAULT_AI_CONFIG,
          provider: "openai-codex",
          model: codex.defaultModel || DEFAULT_AI_MODELS["openai-codex"],
          useHermes: false,
        };
      }
      return { ...DEFAULT_AI_CONFIG };
    }
  }

  private async read(): Promise<StoredAiConfig> {
    try {
      const raw = stripBom(await fs.readFile(this.filePath, "utf-8"));
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new SyntaxError("Invalid AI config JSON");
      }
      const data = parsed as Partial<StoredAiConfig>;
      return { ...DEFAULT_AI_CONFIG, ...data } as StoredAiConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { ...DEFAULT_AI_CONFIG };
    }
  }

  private publicFields(stored: StoredAiConfig): AiConfig {
    const profiles: ProviderProfile[] | undefined = Array.isArray(stored.profiles)
      ? stored.profiles.map((p) => {
          const mem = this.sessionProfileKeys.get(p.id);
          const cipher = stored.profileApiKeys?.[p.id];
          const clean: ProviderProfile = {
            id: p.id,
            name: p.name,
            provider: PROVIDERS.includes(p.provider) ? p.provider : DEFAULT_AI_CONFIG.provider,
            model: typeof p.model === "string" ? p.model : "",
            ...(typeof p.baseUrl === "string" && p.baseUrl ? { baseUrl: p.baseUrl } : {}),
            ...(p.apiProtocol && API_PROTOCOLS.includes(p.apiProtocol) ? { apiProtocol: p.apiProtocol } : {}),
            ...(p.reasoningEffort && REASONING_EFFORTS.includes(p.reasoningEffort)
              ? { reasoningEffort: p.reasoningEffort }
              : {}),
            ...(typeof p.temperature === "number" && Number.isFinite(p.temperature)
              ? { temperature: p.temperature }
              : {}),
            ...(typeof p.maxOutputTokens === "number" && p.maxOutputTokens >= 512
              ? { maxOutputTokens: p.maxOutputTokens }
              : {}),
            ...(typeof p.contextWindowTokens === "number" && p.contextWindowTokens >= 4000
              ? { contextWindowTokens: p.contextWindowTokens }
              : {}),
            ...(typeof p.embeddingModel === "string" && p.embeddingModel
              ? { embeddingModel: p.embeddingModel }
              : {}),
            ...(p.egressPolicy && EGRESS_POLICIES.includes(p.egressPolicy)
              ? { egressPolicy: p.egressPolicy }
              : {}),
            ...(p.zdrConfirmed !== undefined ? { zdrConfirmed: Boolean(p.zdrConfirmed) } : {}),
            ...(Array.isArray(p.fallbackProfileIds) && p.fallbackProfileIds.length > 0
              ? { fallbackProfileIds: [...p.fallbackProfileIds] }
              : {}),
            ...(typeof p.updatedAt === "number" ? { updatedAt: p.updatedAt } : {}),
            hasApiKey: Boolean(mem || cipher),
            ...(mem ? { keyStorage: "session" as const } : cipher ? { keyStorage: "encrypted" as const } : {}),
          };
          return clean;
        })
      : undefined;

    const activeProfileByRole: AiActiveProfileByRole | undefined =
      stored.activeProfileByRole && typeof stored.activeProfileByRole === "object"
        ? Object.fromEntries(
            Object.entries(stored.activeProfileByRole).filter(
              ([k, v]) => CANONICAL_ROLES.includes(k as AiProfileRole) && typeof v === "string" && v.length > 0,
            ),
          )
        : undefined;

    return {
      enabled: stored.enabled === true,
      provider: PROVIDERS.includes(stored.provider)
        ? stored.provider
        : DEFAULT_AI_CONFIG.provider,
      model:
        typeof stored.model === "string" && stored.model
          ? stored.model
          : DEFAULT_AI_CONFIG.model,
      ...(stored.apiProtocol && API_PROTOCOLS.includes(stored.apiProtocol) ? { apiProtocol: stored.apiProtocol } : {}),
      ...(typeof stored.baseUrl === "string" && stored.baseUrl
        ? { baseUrl: stored.baseUrl }
        : {}),
      ...(typeof stored.actorName === "string" && stored.actorName
        ? { actorName: stored.actorName }
        : {}),
      ...(typeof stored.fastModel === "string" && stored.fastModel
        ? { fastModel: stored.fastModel }
        : {}),
      ...(typeof stored.embeddingModel === "string" && stored.embeddingModel
        ? { embeddingModel: stored.embeddingModel }
        : {}),
      contextWindowTokens:
        typeof stored.contextWindowTokens === "number" && stored.contextWindowTokens >= 4000
          ? stored.contextWindowTokens
          : 128000,
      terminalContextChars:
        typeof stored.terminalContextChars === "number" && stored.terminalContextChars >= 1000
          ? stored.terminalContextChars
          : 8000,
      maxOutputTokens:
        typeof stored.maxOutputTokens === "number" && stored.maxOutputTokens >= 512
          ? stored.maxOutputTokens
          : 8192,
      maxToolTurns:
        typeof stored.maxToolTurns === "number" && stored.maxToolTurns >= 2
          ? stored.maxToolTurns
          : 20,
      reasoningEffort:
        stored.reasoningEffort && REASONING_EFFORTS.includes(stored.reasoningEffort)
          ? stored.reasoningEffort
          : "medium",
      temperature:
        typeof stored.temperature === "number" && Number.isFinite(stored.temperature)
          ? stored.temperature
          : 0.2,
      useHermes: stored.useHermes === true,
      ...(profiles ? { profiles } : {}),
      ...(activeProfileByRole && Object.keys(activeProfileByRole).length > 0
        ? { activeProfileByRole }
        : {}),
      egressPolicy:
        stored.egressPolicy && EGRESS_POLICIES.includes(stored.egressPolicy)
          ? stored.egressPolicy
          : "standard",
      zdrConfirmed: stored.zdrConfirmed === true,
      piiScrubbing:
        stored.piiScrubbing && PII_SCRUBBING_MODES.includes(stored.piiScrubbing)
          ? stored.piiScrubbing
          : "standard",
    };
  }

  private queueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const resultPromise = this.writeQueue.then(mutation, mutation);
    this.writeQueue = resultPromise.then(
      () => {},
      () => {},
    );
    return resultPromise;
  }
}

export function isStaleOrNonCodexModel(model?: string): boolean {
  if (!model) return true;
  const trimmed = model.trim();
  if (!trimmed) return true;
  return (
    trimmed === "gpt-sol-latest" ||
    trimmed === "local" ||
    trimmed === "gpt-5.3-codex" ||
    trimmed === "gpt-5.4" ||
    trimmed === "gpt-5.4-mini" ||
    trimmed === "gpt-5.2-codex" ||
    trimmed === "gpt-5.1-codex-max" ||
    trimmed.startsWith("claude-")
  );
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, "");
}

function assertHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "The endpoint must be a full URL, e.g. http://localhost:11434/v1",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The endpoint must use http or https");
  }
  if (url.username || url.password) {
    throw new Error(
      "Put credentials in the API key field, not in the endpoint URL",
    );
  }
}
