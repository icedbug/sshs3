import type { AgentMode, HubRequest, HubSnapshot } from "@shared/types/aiHub";

/** The panel's request helper: it shows a failed request in the panel and resolves with nothing. */
export type Act = (request: HubRequest) => Promise<HubSnapshot | undefined>;

/**
 * The Demo-Lab toggles: on the desktop, main asks for confirmation and then restarts sshs3 in the other
 * mode; in web mode demo mode is fixed when the server starts, so they are shown disabled with this title.
 */
export const DEMO_MODE_SET_BY_SERVER =
  "Demo mode is set when the sshs3 server starts and can't be changed here.";

export const modes: Record<AgentMode, string> = {
  // "Ask" next to "Ask first" was read as the same thing.
  advice: "Advice",
  assisted: "Ask first",
  autonomous: "Auto",
  plan: "Plan",
};

/** Internal view identifiers used across AiHub navigation and view routing. */
export type HubViewId =
  | "Work"
  | "Inbox"
  | "Workforce"
  | "Infrastructure"
  | "Knowledge Base"
  | "Changes"
  | "Memory & skills"
  | "Agents & MCP"
  | "Schedules";

/** Canonical human-facing labels for every AiHub view. */
export type CanonicalViewLabel =
  | "Chat"
  | "Inbox"
  | "Workforce"
  | "Infrastructure"
  | "Knowledge Base"
  | "Changes"
  | "Memory & skills"
  | "Agents & MCP"
  | "Schedules";

export const CANONICAL_VIEW_LABELS: Record<HubViewId, CanonicalViewLabel> = {
  Work: "Chat",
  Inbox: "Inbox",
  Workforce: "Workforce",
  Infrastructure: "Infrastructure",
  "Knowledge Base": "Knowledge Base",
  Changes: "Changes",
  "Memory & skills": "Memory & skills",
  "Agents & MCP": "Agents & MCP",
  Schedules: "Schedules",
};

export const COMPACT_VIEW_LABELS: Record<HubViewId, string> = {
  Work: "Chat",
  Inbox: "Inbox",
  Workforce: "Workforce",
  Infrastructure: "Infra",
  "Knowledge Base": "Runbooks",
  Changes: "Changes",
  "Memory & skills": "Memory",
  "Agents & MCP": "Agents & MCP",
  Schedules: "Schedules",
};

/** Core day-to-day views shown by default in progressive disclosure navigation. */
export const CORE_VIEWS: readonly HubViewId[] = [
  "Work",
  "Inbox",
  "Workforce",
  "Infrastructure",
  "Knowledge Base",
  "Changes",
];

/** Advanced / configuration / automation views revealed when Labs / More views are expanded. */
export const LABS_VIEWS: readonly HubViewId[] = [
  "Memory & skills",
  "Agents & MCP",
  "Schedules",
];

export const ALL_HUB_VIEWS: readonly HubViewId[] = [...CORE_VIEWS, ...LABS_VIEWS];

const CORE_VIEW_SET = new Set<HubViewId>(CORE_VIEWS);
const LABS_VIEW_SET = new Set<HubViewId>(LABS_VIEWS);

export function isCoreView(view: HubViewId): boolean {
  return CORE_VIEW_SET.has(view);
}

export function isLabsView(view: HubViewId): boolean {
  return LABS_VIEW_SET.has(view);
}

export function getVisibleHubViews(includeLabs: boolean): readonly HubViewId[] {
  return includeLabs ? ALL_HUB_VIEWS : CORE_VIEWS;
}

export function getHubViewLabel(view: HubViewId, options?: { compact?: boolean }): string {
  if (options?.compact) return COMPACT_VIEW_LABELS[view] ?? CANONICAL_VIEW_LABELS[view];
  return CANONICAL_VIEW_LABELS[view];
}

export const TABULAR_NUMS_CLASS = "ai-tabular-nums";
export const TABULAR_NUMS_STYLE = { fontVariantNumeric: "tabular-nums" } as const;

/** Formats a token count into a compact tabular-friendly string (e.g. 850, 1.2k, 128k, 1.5M). */
export function formatCompactTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (count >= 100_000) {
    return `${Math.round(count / 1_000)}k`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(Math.round(count));
}

/** Formats a USD cost cleanly for compact badges/toolbars, returning "" when absent. */
export function formatUsdCost(costUsd: number | undefined | null): string {
  if (costUsd === undefined || costUsd === null || !Number.isFinite(costUsd) || costUsd < 0) {
    return "";
  }
  if (costUsd === 0) return "$0.00";
  if (costUsd < 0.001) return "<$0.001";
  if (costUsd < 1) return `$${costUsd.toFixed(3)}`;
  return `$${costUsd.toFixed(2)}`;
}

/** Formats combined input/output token count and optional USD cost for tabular display. */
export function formatTokenUsage(
  inputTokens: number,
  outputTokens = 0,
  costUsd?: number | null,
): string {
  const total =
    (Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0) +
    (Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0);
  const tok = formatCompactTokens(total);
  const cost = formatUsdCost(costUsd);
  return cost ? `${tok} · ${cost}` : tok;
}
