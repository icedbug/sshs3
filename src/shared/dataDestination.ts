import type { AiEgressPolicy, AiPiiScrubbingMode, AiProvider } from "./types/ai";
import type { S3WorkspaceConfig } from "./types/aiHub";

/**
 * Where data may be sent, and what is said about it.
 *
 * One piece of code for both sides: a run asks it before it calls a model (DirectAgentRuntime), and
 * the settings show its answer (SettingsView). There were two copies once, and the one the settings
 * used asked a stricter question than the one a run asks, so the page said "blocked" about a model
 * that runs were using.
 */

/** Masking is done in the main process (privacy.ts maskContext) on everything sent to a model. */
export const MASKED =
  "Secrets the app recognises, such as keys, tokens and passwords, are masked first.";

export type EgressPolicyMode = AiEgressPolicy;

export interface EgressPolicyConfig {
  provider: AiProvider;
  baseUrl?: string;
  model?: string;
  egressPolicy?: EgressPolicyMode;
  zdrConfirmed?: boolean;
  piiScrubbing?: AiPiiScrubbingMode;
  /** Additional enterprise-approved EU hostnames or wildcard patterns (e.g. `*.llm.corp.eu`). */
  euAllowedHosts?: string[];
}

export interface EgressValidationOptions {
  /** Whether non-local cloud endpoints require `zdrConfirmed === true`. Defaults to `true`. */
  requireZdr?: boolean;
}

export interface EgressValidationResult {
  allowed: boolean;
  policy: EgressPolicyMode;
  endpoint: string;
  host: string;
  isLoopback: boolean;
  isPrivateNetwork: boolean;
  isEuEndpoint: boolean;
  zdrConfirmed: boolean;
  errors: string[];
  warnings: string[];
}

export interface DataFlowChannel {
  channel: "llm-inference" | "team-s3-sync" | "local-storage";
  enabled: boolean;
  destination: string;
  host: string;
  region?: string;
  locality: "local" | "private-network" | "eu" | "external" | "disabled";
  encryptedInTransit: boolean;
  secretsMasked: boolean;
  piiScrubbing?: AiPiiScrubbingMode;
  dataTypes: string[];
  notes: string[];
}

export interface SubprocessorInfo {
  name: string;
  purpose: string;
  endpoint: string;
  locality: DataFlowChannel["locality"];
  zdrConfirmed: boolean;
}

export interface ActiveDataFlowDescription {
  summary: string;
  egressValidation: EgressValidationResult;
  channels: DataFlowChannel[];
  subprocessors: SubprocessorInfo[];
}

const DEFAULT_ANTHROPIC_ENDPOINT = "https://api.anthropic.com";
const DEFAULT_CODEX_ENDPOINT = "https://chatgpt.com/backend-api";

export const DEFAULT_EU_PINNED_HOSTS: readonly string[] = [
  "eu.api.openai.com",
  "eu.api.anthropic.com",
  "api.mistral.ai",
  "*.eu.anthropic.com",
  "bedrock-runtime.eu-*.amazonaws.com",
  "europe-*-aiplatform.googleapis.com",
  "eu-*-aiplatform.googleapis.com",
  "*.eu.openai.azure.com",
  "*.westeurope.openai.azure.com",
  "*.northeurope.openai.azure.com",
  "*.swedencentral.openai.azure.com",
  "*.germanywestcentral.openai.azure.com",
  "*.francecentral.openai.azure.com",
  "*.italynorth.openai.azure.com",
  "*.spaincentral.openai.azure.com",
  "*.polandcentral.openai.azure.com",
  "*.switzerlandnorth.openai.azure.com",
];

function hostOf(url: string | undefined): string {
  const text = url?.trim();
  if (!text) return "";
  try {
    return new URL(text).host;
  } catch {
    return "";
  }
}

function normalizeHostname(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (host.startsWith("::ffff:")) {
    host = host.slice("::ffff:".length);
  }
  return host;
}

function parseIpv4Octets(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return [nums[0], nums[1], nums[2], nums[3]];
}

export function isLoopbackHostname(rawHostname: string): boolean {
  const host = normalizeHostname(rawHostname);
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") {
    return true;
  }
  const octets = parseIpv4Octets(host);
  return octets !== null && octets[0] === 127;
}

export function isPrivateNetworkHostname(rawHostname: string): boolean {
  const host = normalizeHostname(rawHostname);
  if (!host) return false;
  if (isLoopbackHostname(host)) return true;

  const octets = parseIpv4Octets(host);
  if (octets) {
    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  return /^(?:fc|fd)[0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host);
}

/** Matches hostname patterns where `*` spans one DNS label segment (`[a-z0-9-]+`). */
function matchesHostPattern(hostname: string, pattern: string): boolean {
  const host = normalizeHostname(hostname);
  const pat = normalizeHostname(pattern);
  if (!host || !pat) return false;
  if (!pat.includes("*")) return host === pat;

  const parts = pat.split("*");
  let cursor = 0;
  for (let i = 0; i < parts.length; i++) {
    const literal = parts[i];
    if (i === 0) {
      if (!host.startsWith(literal)) return false;
      cursor = literal.length;
    } else if (i === parts.length - 1) {
      if (!host.endsWith(literal)) return false;
      const wildcardSpan = host.slice(cursor, host.length - literal.length);
      if (!/^[a-z0-9-]+$/i.test(wildcardSpan)) return false;
      cursor = host.length;
    } else {
      const idx = host.indexOf(literal, cursor);
      if (idx < 0) return false;
      const wildcardSpan = host.slice(cursor, idx);
      if (!/^[a-z0-9-]+$/i.test(wildcardSpan)) return false;
      cursor = idx + literal.length;
    }
  }
  return cursor === host.length;
}

export function isEuPinnedHostname(
  rawHostname: string,
  extraAllowedHosts: string[] = [],
): boolean {
  const host = normalizeHostname(rawHostname);
  if (!host) return false;
  for (const pattern of DEFAULT_EU_PINNED_HOSTS) {
    if (matchesHostPattern(host, pattern)) return true;
  }
  for (const pattern of extraAllowedHosts) {
    if (matchesHostPattern(host, pattern)) return true;
  }
  return false;
}

function resolveEffectiveEndpoint(config: EgressPolicyConfig): string {
  const custom = config.baseUrl?.trim();
  if (config.provider === "openai-codex") {
    return custom || DEFAULT_CODEX_ENDPOINT;
  }
  if (config.provider === "anthropic") {
    return custom || DEFAULT_ANTHROPIC_ENDPOINT;
  }
  return custom || "";
}

/** Validates an AI provider configuration against egress residency, transport security, and ZDR policy. */
export function validateEgressPolicy(
  config: EgressPolicyConfig,
  options: EgressValidationOptions = {},
): EgressValidationResult {
  const policy: EgressPolicyMode = config.egressPolicy ?? "standard";
  const requireZdr = options.requireZdr ?? true;
  const zdrConfirmed = Boolean(config.zdrConfirmed);
  const endpoint = resolveEffectiveEndpoint(config);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!endpoint) {
    errors.push("The model needs an address (base URL).");
    return {
      allowed: false,
      policy,
      endpoint: "",
      host: "",
      isLoopback: false,
      isPrivateNetwork: false,
      isEuEndpoint: false,
      zdrConfirmed,
      errors,
      warnings,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    errors.push(`"${endpoint}" is not an address. It should look like https://…`);
    return {
      allowed: false,
      policy,
      endpoint,
      host: "",
      isLoopback: false,
      isPrivateNetwork: false,
      isEuEndpoint: false,
      zdrConfirmed,
      errors,
      warnings,
    };
  }

  const host = parsed.host;
  const hostname = normalizeHostname(parsed.hostname);
  const isLoopback = isLoopbackHostname(hostname);
  const isPrivateNetwork = isPrivateNetworkHostname(hostname);
  const isEuEndpoint = isEuPinnedHostname(hostname, config.euAllowedHosts ?? []);

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    errors.push(`The model's address has to start with https:// (http:// only on this machine). This one starts with ${parsed.protocol}//.`);
  } else if (!isLoopback && parsed.protocol !== "https:") {
    errors.push(`A model on another machine has to be reached over https. This address is not: ${parsed.protocol}//${host}.`);
  }

  if (policy === "local-only") {
    if (config.provider === "openai-codex") {
      errors.push("You chose to send nothing outside your own network. ChatGPT / Codex is an outside service.");
    } else if (!isLoopback && !isPrivateNetwork) {
      errors.push(`You chose to send nothing outside your own network, and ${host} is outside it.`);
    }
  }

  if (policy === "eu-pinned") {
    if (config.provider === "openai-codex") {
      errors.push("You chose to send data only to services in the EU. ChatGPT / Codex is not one of them.");
    } else if (!isEuEndpoint) {
      errors.push(`You chose to send data only to services in the EU, and ${host} is not on that list.`);
    }
  }

  if (!isLoopback && !isPrivateNetwork) {
    if (requireZdr && !zdrConfirmed) {
      errors.push(`You have not confirmed that ${host} keeps none of what is sent to it, and here that has to be confirmed first.`);
    } else if (!zdrConfirmed) {
      warnings.push(`You have not confirmed that ${host} keeps none of what is sent to it.`);
    }
  }

  return {
    allowed: errors.length === 0,
    policy,
    endpoint,
    host,
    isLoopback,
    isPrivateNetwork,
    isEuEndpoint,
    zdrConfirmed,
    errors,
    warnings,
  };
}

/** One plain line saying where prompts and terminal output go for this provider. */
export function dataDestination(provider: AiProvider, baseUrl?: string): string {
  const what = "Prompts, terminal output you share and tool results are sent to";
  const host = hostOf(baseUrl);
  if (provider === "openai-codex") return `${what} OpenAI under your ChatGPT account. ${MASKED}`;
  if (provider === "anthropic")
    return host && host !== "api.anthropic.com"
      ? `${what} the address set below (${host}). ${MASKED}`
      : `${what} Anthropic's API. ${MASKED}`;
  return `${what} the address set below${host ? ` (${host})` : ""}. A local server keeps them on your network. ${MASKED}`;
}

function classifyS3Locality(
  syncConfig: Partial<S3WorkspaceConfig>,
): { locality: DataFlowChannel["locality"]; host: string; encrypted: boolean; endpoint: string } {
  const rawEndpoint = syncConfig.endpoint?.trim();
  if (rawEndpoint) {
    try {
      const parsed = new URL(rawEndpoint);
      const isLoopback = isLoopbackHostname(parsed.hostname);
      const isPrivate = isPrivateNetworkHostname(parsed.hostname);
      const region = syncConfig.region?.trim() ?? "";
      const locality: DataFlowChannel["locality"] = isLoopback
        ? "local"
        : isPrivate
          ? "private-network"
          : region.toLowerCase().startsWith("eu-")
            ? "eu"
            : "external";
      return {
        locality,
        host: parsed.host,
        encrypted: parsed.protocol === "https:",
        endpoint: rawEndpoint,
      };
    } catch {
      return {
        locality: "external",
        host: rawEndpoint,
        encrypted: rawEndpoint.startsWith("https://"),
        endpoint: rawEndpoint,
      };
    }
  }

  const region = syncConfig.region?.trim() || "us-east-1";
  const host = `s3.${region}.amazonaws.com`;
  return {
    locality: region.toLowerCase().startsWith("eu-") ? "eu" : "external",
    host,
    encrypted: true,
    endpoint: `https://${host}`,
  };
}

function providerDisplayName(
  provider: AiProvider,
  host: string,
  locality: DataFlowChannel["locality"],
): string {
  if (provider === "openai-codex") return "OpenAI (ChatGPT / Codex)";
  if (provider === "anthropic") {
    return !host || host === "api.anthropic.com" ? "Anthropic" : `Custom Anthropic gateway (${host})`;
  }
  if (locality === "local" || locality === "private-network") {
    return `Local / Private LLM (${host || "unconfigured"})`;
  }
  return `OpenAI-compatible endpoint (${host || "unconfigured"})`;
}

export function formatEgressPolicyLabel(policy: AiEgressPolicy): string {
  if (policy === "local-only") return "Nothing is sent outside this machine and your own network.";
  if (policy === "eu-pinned") return "Data is sent only to services in the EU.";
  return "Data may be sent to any service you set up, over an encrypted connection.";
}

export function formatPiiScrubbingLabel(mode: AiPiiScrubbingMode): string {
  if (mode === "strict") return "Hides secrets, personal details, host names and anything that looks like a key.";
  if (mode === "off") return "Hides secrets only: keys, tokens and passwords.";
  return "Hides secrets, e-mail addresses, IP addresses and phone numbers.";
}

/**
 * Produces a structured breakdown of every active data flow (LLM inference,
 * S3 team workspace sync, and local persistence) plus subprocessor inventory
 * and egress policy compliance status.
 */
export function describeActiveDataFlow(
  config: EgressPolicyConfig,
  syncConfig?: Partial<S3WorkspaceConfig> | null,
): ActiveDataFlowDescription {
  // Asked the way a run asks it (DirectAgentRuntime): not having confirmed that a service keeps nothing
  // is said as a note, because it stops no run. Saying "stopped" here about a model that runs use was wrong.
  const egressValidation = validateEgressPolicy(config, { requireZdr: false });
  const piiScrubbing: AiPiiScrubbingMode = config.piiScrubbing ?? "standard";
  const llmLocality: DataFlowChannel["locality"] = egressValidation.isLoopback
    ? "local"
    : egressValidation.isPrivateNetwork
      ? "private-network"
      : egressValidation.isEuEndpoint
        ? "eu"
        : "external";

  const llmEncrypted = egressValidation.endpoint.startsWith("https://");
  const llmChannel: DataFlowChannel = {
    channel: "llm-inference",
    enabled: true,
    destination: dataDestination(config.provider, config.baseUrl),
    host: egressValidation.host,
    locality: llmLocality,
    encryptedInTransit: llmEncrypted,
    secretsMasked: true,
    piiScrubbing,
    dataTypes: ["prompts", "shared terminal output", "tool results", "knowledge base snippets"],
    notes: [
      `Before anything is sent: ${formatPiiScrubbingLabel(piiScrubbing)}`,
      ...egressValidation.errors,
      ...egressValidation.warnings,
    ],
  };

  const s3Enabled = Boolean(syncConfig?.enabled && syncConfig?.bucket?.trim());
  const s3Info = s3Enabled && syncConfig ? classifyS3Locality(syncConfig) : null;
  const s3Channel: DataFlowChannel =
    s3Enabled && syncConfig && s3Info
      ? {
          channel: "team-s3-sync",
          enabled: true,
          destination: `S3 bucket "${syncConfig.bucket}" (${syncConfig.region || "default region"}) at ${s3Info.host}`,
          host: s3Info.host,
          region: syncConfig.region,
          locality: s3Info.locality,
          encryptedInTransit: s3Info.encrypted,
          secretsMasked: true,
          dataTypes: ["shared server topology", "team memories", "work tickets", "activity log"],
          notes: s3Info.encrypted ? [] : [`S3 endpoint ${s3Info.host} is not using HTTPS.`],
        }
      : {
          channel: "team-s3-sync",
          enabled: false,
          destination: "Disabled (workspace data stays on this device)",
          host: "",
          locality: "disabled",
          encryptedInTransit: true,
          secretsMasked: true,
          dataTypes: [],
          notes: [],
        };

  const localChannel: DataFlowChannel = {
    channel: "local-storage",
    enabled: true,
    destination: "Local application data directory",
    host: "localhost",
    locality: "local",
    encryptedInTransit: true,
    secretsMasked: true,
    dataTypes: ["conversations", "hash-chained audit log", "terminal recordings", "local memories"],
    notes: [],
  };

  const subprocessors: SubprocessorInfo[] = [];
  if (llmLocality !== "local" && llmLocality !== "private-network") {
    subprocessors.push({
      name: providerDisplayName(config.provider, egressValidation.host, llmLocality),
      purpose: "AI inference & tool reasoning",
      endpoint: egressValidation.endpoint,
      locality: llmLocality,
      zdrConfirmed: egressValidation.zdrConfirmed,
    });
  }
  if (s3Enabled && s3Info && s3Info.locality !== "local" && s3Info.locality !== "private-network") {
    subprocessors.push({
      name: `S3 Object Storage (${s3Info.host})`,
      purpose: "Team workspace sync & audit anchoring",
      endpoint: s3Info.endpoint,
      locality: s3Info.locality,
      zdrConfirmed: false,
    });
  }

  return {
    summary: dataDestination(config.provider, config.baseUrl),
    egressValidation,
    channels: [llmChannel, s3Channel, localChannel],
    subprocessors,
  };
}
