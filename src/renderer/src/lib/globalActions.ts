import { SHORTCUT_DEFINITIONS } from '@shared/types/settings';
import type { AgentTask, HubSnapshot, KbPage, MissionAgent } from '@shared/types/aiHub';
import type { Snippet } from '@shared/types/snippets';
import type { TabType } from '../components/TabBar';
import {
  ALL_HUB_VIEWS,
  getHubViewLabel,
  getVisibleHubViews,
  isLabsView,
  type HubViewId,
} from '../components/AiHub/panelShared';
import { isConversation } from '../components/AiHub/workforceModel';
import { fuzzyMatch } from './fuzzyMatch';
import type { SearchEntry } from './globalSearchIndex';
import type { ParsedSearch } from './searchQuery';
import { getShortcutKeys } from './shortcuts';
import { parseSnippetVariables } from './snippets';

/**
 * The shortcut actions that do the same thing wherever the focus is: they open a tab, a dialog or a
 * window and read nothing from the focused terminal, pane or overlay. Those can be started from the
 * keyboard and from the global search alike. Everything tied to the focus (closing or splitting a
 * pane, moving between panes, terminal-only keys) stays in `useAppKeyboard`.
 */
export const GLOBAL_ACTION_IDS = [
  'newTerminal',
  'newFileManager',
  'newRemoteFileManager',
  'newWindow',
  'openProfiles',
  'openSettings',
  'showShortcuts',
] as const;

export type GlobalActionId = (typeof GLOBAL_ACTION_IDS)[number];

export function isGlobalActionId(id: string): id is GlobalActionId {
  return (GLOBAL_ACTION_IDS as readonly string[]).includes(id);
}

/** What each caller wires up; the mapping from action to handler lives in `runGlobalAction`. */
export interface GlobalActionHandlers {
  newTab: (type?: TabType, options?: { remote?: boolean }) => void;
  openProfiles: () => void;
  openSettings: () => void;
  newWindow: () => void;
  showShortcuts: () => void;
}

export function runGlobalAction(id: GlobalActionId, handlers: GlobalActionHandlers): void {
  switch (id) {
    case 'newTerminal':
      handlers.newTab('terminal');
      break;
    case 'newFileManager':
      handlers.newTab('filemanager');
      break;
    case 'newRemoteFileManager':
      handlers.newTab('filemanager', { remote: true });
      break;
    case 'newWindow':
      handlers.newWindow();
      break;
    case 'openProfiles':
      handlers.openProfiles();
      break;
    case 'openSettings':
      handlers.openSettings();
      break;
    case 'showShortcuts':
      handlers.showShortcuts();
      break;
  }
}

/** The actions as search entries: named like their shortcut, with the user's current key combination as the subtitle. */
export function buildActionEntries(shortcuts: Record<string, string> | undefined): SearchEntry[] {
  return GLOBAL_ACTION_IDS.map((id) => {
    const definition = SHORTCUT_DEFINITIONS.find((d) => d.id === id);
    return {
      id: `action:${id}`,
      kind: 'action' as const,
      title: definition?.name ?? id,
      subtitle: getShortcutKeys(id, shortcuts),
      tags: [],
      source: '',
      ref: id,
      sftp: false,
    };
  });
}

export const COMMAND_ACTION_IDS = [
  'newAiTask',
  'switchAiView',
  'toggleLabs',
  'toggleCompactMode',
  'openCommandRunner',
  'focusAiBounce',
] as const;

export type CommandActionId = (typeof COMMAND_ACTION_IDS)[number];

export interface AiViewItem {
  id: HubViewId;
  label: string;
  compactLabel: string;
  labsOnly: boolean;
  keywords: string[];
}

const VIEW_KEYWORDS: Record<HubViewId, string[]> = {
  Work: ['chat', 'assistant', 'ai', 'composer', 'conversation'],
  Inbox: ['triage', 'approvals', 'alerts', 'notifications'],
  Workforce: ['tickets', 'board', 'goals', 'runs'],
  Infrastructure: ['infra', 'servers', 'clusters', 'k8s', 'facts'],
  'Knowledge Base': ['kb', 'runbooks', 'docs', 'pages'],
  Changes: ['diff', 'rollback', 'audit', 'history'],
  'Memory & skills': ['memory', 'skills', 'learning', 'labs'],
  'Agents & MCP': ['agents', 'mcp', 'tools', 'models', 'labs'],
  Schedules: ['cron', 'schedules', 'timers', 'labs'],
};

/** Canonical AI Hub view metadata derived from `ALL_HUB_VIEWS` and `getHubViewLabel`. */
export const AI_HUB_VIEW_ITEMS: AiViewItem[] = ALL_HUB_VIEWS.map((id) => ({
  id,
  label: getHubViewLabel(id),
  compactLabel: getHubViewLabel(id, { compact: true }),
  labsOnly: isLabsView(id),
  keywords: VIEW_KEYWORDS[id] ?? [],
}));

export type AiPaletteEntryKind =
  | 'command-action'
  | 'ai-view'
  | 'ai-task'
  | 'agent'
  | 'kb-page'
  | 'snippet';

export interface AiPaletteEntry {
  id: string;
  kind: AiPaletteEntryKind;
  title: string;
  subtitle: string;
  tags: string[];
  keywords: string[];
  ref: string;
  badge: string;
  updatedAt?: number;
  viewId?: HubViewId;
  snippet?: Snippet;
}

export interface AiPaletteSearchResult {
  entry: AiPaletteEntry;
  score: number;
  titleIndices: number[];
}

/** Indexes AI Hub views using `ALL_HUB_VIEWS` / `getHubViewLabel`. */
export function buildAiViewEntries(options?: {
  includeLabs?: boolean;
  compact?: boolean;
}): AiPaletteEntry[] {
  const views = options?.includeLabs === false ? getVisibleHubViews(false) : ALL_HUB_VIEWS;
  return views.map((viewId) => {
    const label = getHubViewLabel(viewId, { compact: options?.compact });
    const fullLabel = getHubViewLabel(viewId);
    const labs = isLabsView(viewId);
    return {
      id: `ai-view:${viewId}`,
      kind: 'ai-view',
      title: fullLabel === label ? label : `${label} (${fullLabel})`,
      subtitle: labs ? 'AI Hub View · Labs' : 'AI Hub View',
      tags: labs ? ['ai', 'view', 'labs'] : ['ai', 'view'],
      keywords: [...(VIEW_KEYWORDS[viewId] ?? []), viewId, fullLabel, label],
      ref: viewId,
      badge: 'VIEW',
      viewId,
    };
  });
}

/** Indexes recent user-facing AI tasks (excluding internal workforce/eval/distill runs). */
export function buildAiTaskEntries(tasks: AgentTask[], limit = 15): AiPaletteEntry[] {
  return [...tasks]
    .filter((t) => isConversation(t))
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .slice(0, limit)
    .map((task) => {
      const parts: string[] = [task.status, task.mode];
      if (task.agentName) parts.push(task.agentName);
      if (task.target?.label) parts.push(task.target.label);
      const tags: string[] = [task.status, task.mode];
      if (task.agentName) tags.push(task.agentName);
      return {
        id: `ai-task:${task.id}`,
        kind: 'ai-task',
        title: task.title || 'Untitled AI task',
        subtitle: parts.join(' · '),
        tags,
        keywords: [task.title, task.agentName ?? '', task.target?.label ?? '', task.status, task.mode].filter(Boolean),
        ref: task.id,
        badge: 'TASK',
        updatedAt: task.updatedAt || task.createdAt,
      };
    });
}

/** Indexes configured AI agents from the Hub snapshot. */
export function buildAgentEntries(agents: MissionAgent[]): AiPaletteEntry[] {
  return agents.map((agent) => {
    const parts = [agent.role || 'Agent'];
    if (agent.targetCluster) parts.push(agent.targetCluster);
    if (agent.enabled === false) parts.push('Paused');
    return {
      id: `agent:${agent.id}`,
      kind: 'agent',
      title: agent.name,
      subtitle: parts.join(' · '),
      tags: [agent.defaultMode, ...(agent.targetCluster ? [agent.targetCluster] : [])],
      keywords: [agent.name, agent.role, agent.mission, agent.targetCluster ?? ''].filter(Boolean),
      ref: agent.id,
      badge: 'AGENT',
      updatedAt: agent.updatedAt,
    };
  });
}

/** Indexes compiled Knowledge Base pages. */
export function buildKbPageEntries(pages: KbPage[]): AiPaletteEntry[] {
  return pages.map((page) => ({
    id: `kb-page:${page.id}`,
    kind: 'kb-page',
    title: page.title,
    subtitle: page.when || page.kind,
    tags: [page.kind, ...(page.targets ?? [])],
    keywords: [page.title, page.when, page.kind, ...(page.targets ?? []), ...(page.keys ?? [])].filter(Boolean),
    ref: page.id,
    badge: 'KB',
    updatedAt: page.updatedAt,
  }));
}

/** Indexes saved snippets and parameterized workflows. */
export function buildSnippetEntries(snippets: Snippet[]): AiPaletteEntry[] {
  return snippets.map((snippet) => {
    const vars = parseSnippetVariables(snippet.command);
    const singleLine = snippet.command.replace(/\s+/g, ' ').trim();
    const preview = singleLine.length > 90 ? `${singleLine.slice(0, 90)}…` : singleLine;
    const prefix = vars.length > 0 ? `${vars.length} param${vars.length === 1 ? '' : 's'} · ` : '';
    const hostSuffix = snippet.hostLabel ? ` (${snippet.hostLabel})` : '';
    return {
      id: `snippet:${snippet.id}`,
      kind: 'snippet',
      title: snippet.name,
      subtitle: `${prefix}${preview}${hostSuffix}`,
      tags: vars.length > 0 ? ['workflow', 'snippet'] : ['snippet'],
      keywords: [snippet.name, snippet.command, snippet.hostLabel ?? '', ...vars.map((v) => v.name)].filter(Boolean),
      ref: snippet.id,
      badge: vars.length > 0 ? 'FLOW' : 'SNIP',
      snippet,
    };
  });
}

/** Quick actions surfaced in the Command & AI Palette. */
export function buildCommandActionEntries(options?: {
  shortcuts?: Record<string, string>;
  labsEnabled?: boolean;
  compactMode?: boolean;
}): AiPaletteEntry[] {
  const labsLabel = options?.labsEnabled ? 'On' : 'Off';
  const compactLabel = options?.compactMode ? 'On' : 'Off';
  return [
    {
      id: 'cmd:newAiTask',
      kind: 'command-action',
      title: 'New AI Task',
      subtitle: 'Start a fresh AI conversation in AI Hub',
      tags: ['ai', 'task'],
      keywords: ['new ai task', 'chat', 'ask', 'assistant', 'prompt'],
      ref: 'newAiTask',
      badge: 'AI',
    },
    {
      id: 'cmd:switchAiView',
      kind: 'command-action',
      title: 'Switch AI Hub View',
      subtitle: 'Open full AI Hub workspace',
      tags: ['ai', 'view'],
      keywords: ['switch view', 'ai hub', 'full view', 'workspace'],
      ref: 'switchAiView',
      badge: 'AI',
    },
    {
      id: 'cmd:toggleLabs',
      kind: 'command-action',
      title: 'Toggle Labs Views',
      subtitle: `Show experimental Labs views: ${labsLabel}`,
      tags: ['labs', 'settings'],
      keywords: ['toggle labs', 'labs', 'experimental'],
      ref: 'toggleLabs',
      badge: 'LABS',
    },
    {
      id: 'cmd:toggleCompactMode',
      kind: 'command-action',
      title: 'Toggle Compact Mode',
      subtitle: `Compact navigation labels: ${compactLabel}`,
      tags: ['compact', 'settings'],
      keywords: ['toggle compact', 'dense', 'layout'],
      ref: 'toggleCompactMode',
      badge: 'UI',
    },
    {
      id: 'cmd:openCommandRunner',
      kind: 'command-action',
      title: 'Open Command Runner',
      subtitle: `Snippets & Workflows (${getShortcutKeys('snippets', options?.shortcuts)})`,
      tags: ['snippets', 'runner', 'workflow'],
      keywords: ['open command runner', 'snippets', 'workflow', 'run'],
      ref: 'openCommandRunner',
      badge: 'RUN',
    },
    {
      id: 'cmd:focusAiBounce',
      kind: 'command-action',
      title: 'Toggle Focus: Terminal / AI Composer',
      subtitle: getShortcutKeys('focusAiBounce', options?.shortcuts),
      tags: ['focus', 'terminal', 'ai'],
      keywords: ['focus', 'bounce', 'composer', 'terminal'],
      ref: 'focusAiBounce',
      badge: 'KEY',
    },
  ];
}

/** Builds the combined AI & Command palette entries from a Hub snapshot, snippets, and settings. */
export function buildUnifiedCommandEntries(input: {
  snapshot?: HubSnapshot;
  snippets?: Snippet[];
  shortcuts?: Record<string, string>;
  labsEnabled?: boolean;
  compactMode?: boolean;
}): AiPaletteEntry[] {
  return [
    ...buildCommandActionEntries({
      shortcuts: input.shortcuts,
      labsEnabled: input.labsEnabled,
      compactMode: input.compactMode,
    }),
    ...buildAiViewEntries({
      includeLabs: input.labsEnabled !== false,
      compact: input.compactMode,
    }),
    ...buildAiTaskEntries(input.snapshot?.tasks ?? []),
    ...buildAgentEntries(input.snapshot?.agents ?? []),
    ...buildKbPageEntries(input.snapshot?.kbPages ?? []),
    ...buildSnippetEntries(input.snippets ?? []),
  ];
}

const AI_FIELD_BONUS = {
  title: 2,
  tags: 1.5,
  keywords: 1.3,
  subtitle: 1.1,
};

function matchAiWord(word: string, entry: AiPaletteEntry): { score: number; titleIndices: number[] } | null {
  let best: { score: number; titleIndices: number[] } | null = null;
  const consider = (text: string | undefined, bonus: number, isTitle: boolean) => {
    if (!text) return;
    const m = fuzzyMatch(word, text);
    if (!m) return;
    const score = m.score + bonus;
    if (!best || score > best.score) {
      best = { score, titleIndices: isTitle ? m.indices : [] };
    }
  };
  consider(entry.title, AI_FIELD_BONUS.title, true);
  for (const tag of entry.tags) consider(tag, AI_FIELD_BONUS.tags, false);
  for (const kw of entry.keywords) consider(kw, AI_FIELD_BONUS.keywords, false);
  consider(entry.subtitle, AI_FIELD_BONUS.subtitle, false);
  return best;
}

/** Searches AI Hub views, tasks, agents, KB pages, snippets, and quick actions. */
export function searchAiPaletteEntries(
  entries: AiPaletteEntry[],
  query: ParsedSearch
): AiPaletteSearchResult[] {
  const results: AiPaletteSearchResult[] = [];
  for (const entry of entries) {
    if (
      !query.tags.every((tag) =>
        entry.tags.some((t) => t.toLowerCase().includes(tag))
      )
    ) {
      continue;
    }
    if (query.terms.length === 0) {
      results.push({ entry, score: 0, titleIndices: [] });
      continue;
    }
    let score = 0;
    const highlighted = new Set<number>();
    let matched = true;
    for (const word of query.terms) {
      const hit = matchAiWord(word, entry);
      if (!hit) {
        matched = false;
        break;
      }
      score += hit.score;
      hit.titleIndices.forEach((i) => highlighted.add(i));
    }
    if (matched) {
      results.push({
        entry,
        score,
        titleIndices: [...highlighted].sort((a, b) => a - b),
      });
    }
  }
  return results.sort(
    (a, b) =>
      b.score - a.score ||
      (b.entry.updatedAt ?? 0) - (a.entry.updatedAt ?? 0) ||
      a.entry.title.localeCompare(b.entry.title)
  );
}
