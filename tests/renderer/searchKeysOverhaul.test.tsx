// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DEFAULT_SETTINGS, DEFAULT_SHORTCUTS, SHORTCUT_DEFINITIONS } from '../../src/shared/types/settings';
import type { HubSnapshot } from '../../src/shared/types/aiHub';
import type { Snippet } from '../../src/shared/types/snippets';
import { ALL_HUB_VIEWS, CORE_VIEWS, getHubViewLabel } from '../../src/renderer/src/components/AiHub/panelShared';
import {
  AI_HUB_VIEW_ITEMS,
  buildAgentEntries,
  buildAiTaskEntries,
  buildAiViewEntries,
  buildCommandActionEntries,
  buildKbPageEntries,
  buildSnippetEntries,
  buildUnifiedCommandEntries,
  searchAiPaletteEntries,
} from '../../src/renderer/src/lib/globalActions';
import { parseSearchQuery } from '../../src/renderer/src/lib/searchQuery';
import {
  expandSnippet,
  getDefaultSnippetValues,
  getMissingSnippetVariables,
  hasSnippetVariables,
  parseSnippetVariables,
} from '../../src/renderer/src/lib/snippets';
import {
  FOCUS_AI_COMPOSER_EVENT,
  FOCUS_TERMINAL_EVENT,
  useAppKeyboard,
  type AppKeyboardContext,
} from '../../src/renderer/src/lib/useAppKeyboard';
import { GlobalSearchPalette } from '../../src/renderer/src/components/GlobalSearchPalette';
import { SnippetPaletteModal } from '../../src/renderer/src/components/SnippetPaletteModal';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';
import { TERMINAL_ACTION_EVENT } from '../../src/renderer/src/lib/terminalActionEvents';
import type { AppTab } from '../../src/renderer/src/lib/tabs';

const sampleSnapshot: HubSnapshot = {
  config: {
    enabled: true,
    useHermes: false,
    provider: 'openai',
    model: 'gpt-5',
    hasApiKey: true,
    baseUrl: 'https://api.openai.com/v1',
  } as unknown as HubSnapshot['config'],
  preferences: {} as HubSnapshot['preferences'],
  runtime: { bundled: false },
  sessions: [],
  tasks: [
    {
      id: 'task-old',
      title: 'Check disk usage on db-01',
      mode: 'advice',
      status: 'completed',
      messages: [],
      changes: [],
      sources: [],
      createdAt: 1000,
      updatedAt: 2000,
      maxCommands: 5,
      maxMinutes: 5,
      verification: 'verified',
    },
    {
      id: 'task-recent',
      title: 'Diagnose nginx 502 gateway',
      agentName: 'NetOps',
      target: { sessionId: 's1', generation: 'g1', label: 'web-prod-01' },
      mode: 'plan',
      status: 'waiting',
      messages: [],
      changes: [],
      sources: [],
      createdAt: 3000,
      updatedAt: 9000,
      maxCommands: 5,
      maxMinutes: 5,
      verification: 'not-verified',
    },
    {
      id: 'task-internal-workforce',
      title: 'Internal subagent run',
      workforceRunId: 'wf-1',
      mode: 'assisted',
      status: 'running',
      messages: [],
      changes: [],
      sources: [],
      createdAt: 5000,
      updatedAt: 10000,
      maxCommands: 5,
      maxMinutes: 5,
      verification: 'not-verified',
    },
  ],
  memories: [],
  schedules: [],
  inventory: [],
  agents: [
    {
      id: 'agent-sre',
      name: 'SRE Triage',
      role: 'On-call investigator',
      mission: 'Triage incidents',
      systemPrompt: 'Investigate carefully.',
      targetCluster: 'prod-eu',
      defaultMode: 'plan',
      updatedAt: 5000,
    },
  ],
  kbPages: [
    {
      id: 'kb-pg-1',
      kind: 'procedure',
      title: 'PostgreSQL Replication Lag Runbook',
      when: 'When replica lag exceeds 10s',
      body: 'Check pg_stat_replication',
      targets: ['prod-db'],
      sources: [],
      revision: 1,
      createdAt: 1000,
      updatedAt: 4000,
      updatedBy: 'alice',
      history: [],
      keys: ['pg_stat_replication', 'lag'],
    },
  ],
};

const sampleSnippets: Snippet[] = [
  {
    id: 'snip-1',
    name: 'Restart K8s Deployment',
    command: 'kubectl rollout restart deployment/{{deploy}} -n {{namespace=default}}',
  },
  {
    id: 'snip-2',
    name: 'Check Host Uptime',
    command: 'uptime && uname -a # {{host}}',
  },
];

describe('Task 1: globalActions & GlobalSearchPalette Command & AI Palette', () => {
  beforeEach(() => {
    vi.useRealTimers();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { multissh?: unknown }).multissh;
    window.sessionStorage.clear();
  });

  it('indexes all ALL_HUB_VIEWS with canonical/compact labels and respects includeLabs=false', () => {
    expect(AI_HUB_VIEW_ITEMS.map((v) => v.id)).toEqual([...ALL_HUB_VIEWS]);
    const allViews = buildAiViewEntries();
    expect(allViews).toHaveLength(ALL_HUB_VIEWS.length);
    for (const view of ALL_HUB_VIEWS) {
      const item = allViews.find((e) => e.viewId === view)!;
      expect(item.title).toContain(getHubViewLabel(view));
    }
    const coreOnly = buildAiViewEntries({ includeLabs: false });
    expect(coreOnly.map((e) => e.viewId)).toEqual([...CORE_VIEWS]);

    const compactViews = buildAiViewEntries({ compact: true });
    const infra = compactViews.find((e) => e.viewId === 'Infrastructure')!;
    expect(infra.title).toContain('Infra');
  });

  it('indexes recent user conversations, agents, KB pages, snippets, and quick actions', () => {
    const tasks = buildAiTaskEntries(sampleSnapshot.tasks);
    expect(tasks.map((t) => t.ref)).toEqual(['task-recent', 'task-old']);

    const agents = buildAgentEntries(sampleSnapshot.agents ?? []);
    expect(agents[0]).toMatchObject({ kind: 'agent', title: 'SRE Triage', ref: 'agent-sre' });

    const kb = buildKbPageEntries(sampleSnapshot.kbPages ?? []);
    expect(kb[0]).toMatchObject({ kind: 'kb-page', title: 'PostgreSQL Replication Lag Runbook', ref: 'kb-pg-1' });

    const snips = buildSnippetEntries(sampleSnippets);
    expect(snips[0]).toMatchObject({ kind: 'snippet', badge: 'FLOW' });
    expect(snips[0].subtitle).toContain('2 params');
    expect(snips[1]).toMatchObject({ kind: 'snippet', badge: 'SNIP' });

    const cmds = buildCommandActionEntries({ labsEnabled: true, compactMode: false });
    expect(cmds.map((c) => c.ref)).toEqual(
      expect.arrayContaining(['newAiTask', 'switchAiView', 'toggleLabs', 'openCommandRunner'])
    );
    expect(cmds.find((c) => c.ref === 'toggleLabs')?.subtitle).toContain('On');

    const unified = buildUnifiedCommandEntries({
      snapshot: sampleSnapshot,
      snippets: sampleSnippets,
      labsEnabled: true,
    });
    const matches = searchAiPaletteEntries(unified, parseSearchQuery('replication'));
    expect(matches[0].entry.id).toBe('kb-page:kb-pg-1');
  });

  function setupPalette(overrides: Partial<React.ComponentProps<typeof GlobalSearchPalette>> = {}) {
    const multissh = {
      profilesGet: vi.fn().mockResolvedValue({
        ssh: [{ id: 'web-01', name: 'web-01', host: 'web-01.example.com', username: 'deploy', authType: 'password' }],
        s3: [],
      }),
      teamVaultList: vi.fn().mockResolvedValue([]),
      teamVaultGetPayload: vi.fn().mockResolvedValue(null),
      settingsGet: vi.fn().mockResolvedValue({ labsEnabled: false, compactMode: false }),
      settingsSave: vi.fn().mockResolvedValue(undefined),
      aiHubRequest: vi.fn().mockResolvedValue(sampleSnapshot),
      snippetsList: vi.fn().mockResolvedValue(sampleSnippets),
      profilesSaveSSH: vi.fn().mockResolvedValue(undefined),
      profilesSaveS3: vi.fn().mockResolvedValue(undefined),
    };
    (window as unknown as { multissh: unknown }).multissh = multissh;

    const handlers = {
      onClose: vi.fn(),
      onConnectSSH: vi.fn(),
      onOpenSFTP: vi.fn(),
      onConnectS3: vi.fn(),
      onSelectTab: vi.fn(),
      onOpenConnectionManager: vi.fn(),
      onRunAction: vi.fn(),
      onConnectSystem: vi.fn(),
      ...overrides,
    };

    render(
      <GlobalSearchPalette
        tabs={[{ id: 't1', type: 'terminal', title: 'Prod shell' } as AppTab]}
        shortcuts={undefined}
        {...handlers}
      />
    );
    return { multissh, handlers, input: screen.getByRole('combobox') };
  }

  it('indexes AI Hub views, tasks, agents, KB pages, and snippets in GlobalSearchPalette', async () => {
    const aiOpenEvents: Array<{ mode?: string; view?: string; taskId?: string; agentId?: string; pageId?: string }> = [];
    const onAiOpen = (e: Event) => aiOpenEvents.push((e as CustomEvent).detail);
    window.addEventListener('sshs3:ai-open', onAiOpen);

    try {
      const { input, handlers } = setupPalette({ labsEnabled: true });

      // Search KB page
      fireEvent.change(input, { target: { value: 'Replication' } });
      await waitFor(() =>
        expect(screen.getAllByRole('option').some((o) => o.textContent?.includes('PostgreSQL Replication Lag Runbook'))).toBe(true)
      );
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(handlers.onClose).toHaveBeenCalledTimes(1);
      expect(aiOpenEvents.at(-1)).toMatchObject({ mode: 'hub', view: 'Knowledge Base', pageId: 'kb-pg-1' });

      // Search AI Hub view
      fireEvent.change(input, { target: { value: 'Schedules' } });
      await waitFor(() =>
        expect(screen.getAllByRole('option').some((o) => o.textContent?.includes('Schedules'))).toBe(true)
      );
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(aiOpenEvents.at(-1)).toMatchObject({ mode: 'hub', view: 'Schedules' });

      // Search Agent
      fireEvent.change(input, { target: { value: 'SRE Triage' } });
      await waitFor(() =>
        expect(screen.getAllByRole('option').some((o) => o.textContent?.includes('SRE Triage'))).toBe(true)
      );
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(aiOpenEvents.at(-1)).toMatchObject({ mode: 'panel', view: 'Work', agentId: 'agent-sre' });

      // Search Recent AI task
      fireEvent.change(input, { target: { value: 'nginx 502' } });
      await waitFor(() =>
        expect(screen.getAllByRole('option').some((o) => o.textContent?.includes('Diagnose nginx 502 gateway'))).toBe(true)
      );
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(aiOpenEvents.at(-1)).toMatchObject({ mode: 'panel', view: 'Work', taskId: 'task-recent' });
      expect(window.sessionStorage.getItem('sshs3.aiHub.openTask')).toBe('task-recent');
    } finally {
      window.removeEventListener('sshs3:ai-open', onAiOpen);
    }
  });

  it('supports quick actions in > mode (toggle Labs, new AI task, open command runner) and AI filter tab', async () => {
    const settingsEvents: Array<Record<string, unknown>> = [];
    const terminalActions: string[] = [];
    const onSettings = (e: Event) => settingsEvents.push((e as CustomEvent).detail);
    const onTermAction = (e: Event) => terminalActions.push((e as CustomEvent).detail);
    window.addEventListener('sshs3:settings-updated', onSettings);
    window.addEventListener(TERMINAL_ACTION_EVENT, onTermAction);

    try {
      const onToggleLabs = vi.fn();
      const onNewAiTask = vi.fn();
      const { input, multissh, handlers } = setupPalette({ onToggleLabs, onNewAiTask });

      // Toggle Labs via > quick action
      fireEvent.change(input, { target: { value: '>toggle labs' } });
      await waitFor(() =>
        expect(screen.getAllByRole('option').some((o) => o.textContent?.includes('Toggle Labs Views'))).toBe(true)
      );
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(multissh.settingsSave).toHaveBeenCalledWith({ labsEnabled: true });
      expect(onToggleLabs).toHaveBeenCalledWith(true);
      expect(settingsEvents.at(-1)).toEqual({ labsEnabled: true });

      // Open Command Runner via > quick action
      fireEvent.change(input, { target: { value: '>command runner' } });
      await waitFor(() =>
        expect(screen.getAllByRole('option').some((o) => o.textContent?.includes('Open Command Runner'))).toBe(true)
      );
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(terminalActions).toContain('snippets');

      // New AI Task via > quick action
      fireEvent.change(input, { target: { value: '>new ai task' } });
      await waitFor(() =>
        expect(screen.getAllByRole('option').some((o) => o.textContent?.includes('New AI Task'))).toBe(true)
      );
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onNewAiTask).toHaveBeenCalledTimes(1);

      // Tab cycles through AI & Commands filter pill
      fireEvent.change(input, { target: { value: '' } });
      const group = screen.getByRole('group', { name: 'Show' });
      fireEvent.keyDown(input, { key: 'Tab' });
      expect(within(group).getByRole('button', { name: 'Profiles' })).toHaveAttribute('aria-pressed', 'true');
      fireEvent.keyDown(input, { key: 'Tab' });
      expect(within(group).getByRole('button', { name: 'Open tabs' })).toHaveAttribute('aria-pressed', 'true');
      fireEvent.keyDown(input, { key: 'Tab' });
      expect(within(group).getByRole('button', { name: 'AI & Commands' })).toHaveAttribute('aria-pressed', 'true');
      await waitFor(() => expect(screen.getByText('Restart K8s Deployment')).toBeInTheDocument());
      expect(handlers.onClose).toHaveBeenCalled();
    } finally {
      window.removeEventListener('sshs3:settings-updated', onSettings);
      window.removeEventListener(TERMINAL_ACTION_EVENT, onTermAction);
    }
  });
});

describe('Task 2: useAppKeyboard & settings.ts (Ctrl+Shift+A focus bounce + Ctrl+L preservation)', () => {
  afterEach(() => {
    cleanup();
  });

  function KeyboardHarness({
    shortcuts,
    onFocusAiComposer,
    onFocusTerminal,
    setGlobalSearchOpen = vi.fn(),
  }: {
    shortcuts?: Record<string, string>;
    onFocusAiComposer?: () => void;
    onFocusTerminal?: () => void;
    setGlobalSearchOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  }) {
    const ctx: AppKeyboardContext = {
      tabs: [{ id: 'tab-1', type: 'terminal', title: 'Term 1', activePaneId: 'pane-1' } as AppTab],
      activeTabId: 'tab-1',
      tabBarFocused: false,
      anyTopLevelModalOpen: false,
      settings: { ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SHORTCUTS, ...(shortcuts ?? {}) } },
      setActiveTabId: vi.fn(),
      setTabBarFocused: vi.fn(),
      setSettings: vi.fn(),
      setProfilesModalOpen: vi.fn(),
      setSettingsModalOpen: vi.fn(),
      setGlobalSearchOpen,
      openTopLevelModal: (open) => open(),
      handleNewTab: vi.fn(),
      handleCloseTab: vi.fn(),
      handleMoveTabToNewWindow: vi.fn(),
      handleSplitPane: vi.fn(),
      handleClosePane: vi.fn(),
      handleToggleZoom: vi.fn(),
      handleSelectPane: vi.fn(),
      openShortcutsHelp: vi.fn(),
      focusActiveTabContent: vi.fn(),
      onFocusAiComposer,
      onFocusTerminal,
    };
    useAppKeyboard(ctx);
    return (
      <div>
        <div data-testid="terminal-view">
          <div data-testid="terminal-pane-pane-1">
            <textarea className="xterm-helper-textarea" aria-label="Terminal input" />
          </div>
        </div>
        <div className="ai-composer">
          <textarea data-testid="ai-composer" aria-label="AI composer" />
        </div>
      </div>
    );
  }

  it('defines focusAiBounce shortcut and optional labsEnabled/compactMode settings defaults', () => {
    const def = SHORTCUT_DEFINITIONS.find((d) => d.id === 'focusAiBounce');
    expect(def).toMatchObject({ id: 'focusAiBounce', defaultKeys: 'Ctrl+Shift+A', category: 'General' });
    expect(DEFAULT_SETTINGS.labsEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.compactMode).toBe(false);
  });

  it('bounces focus between Terminal and AI Composer on Ctrl+Shift+A and supports custom binding', () => {
    const onFocusAiComposer = vi.fn();
    const onFocusTerminal = vi.fn();
    const focusAiEvents: number[] = [];
    const focusTermEvents: number[] = [];
    const onAiEv = () => focusAiEvents.push(1);
    const onTermEv = () => focusTermEvents.push(1);
    window.addEventListener(FOCUS_AI_COMPOSER_EVENT, onAiEv);
    window.addEventListener(FOCUS_TERMINAL_EVENT, onTermEv);

    try {
      render(
        <KeyboardHarness
          onFocusAiComposer={onFocusAiComposer}
          onFocusTerminal={onFocusTerminal}
        />
      );
      const termInput = screen.getByLabelText('Terminal input');
      const aiInput = screen.getByLabelText('AI composer');

      termInput.focus();
      expect(document.activeElement).toBe(termInput);

      // Terminal -> AI Composer
      fireEvent.keyDown(termInput, { key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true });
      expect(onFocusAiComposer).toHaveBeenCalledTimes(1);
      expect(focusAiEvents).toHaveLength(1);
      expect(document.activeElement).toBe(aiInput);

      // AI Composer -> Terminal (even though AI Composer is a <textarea>)
      fireEvent.keyDown(aiInput, { key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true });
      expect(onFocusTerminal).toHaveBeenCalledTimes(1);
      expect(focusTermEvents).toHaveLength(1);
      expect(document.activeElement).toBe(termInput);
    } finally {
      window.removeEventListener(FOCUS_AI_COMPOSER_EVENT, onAiEv);
      window.removeEventListener(FOCUS_TERMINAL_EVENT, onTermEv);
    }
  });

  it('never swallows bare Ctrl+L inside terminal even if a shortcut tries to bind Ctrl+L, while Ctrl+Shift+L still runs snippets', () => {
    const termActions: string[] = [];
    const onTermAction = (e: Event) => termActions.push((e as CustomEvent).detail);
    window.addEventListener(TERMINAL_ACTION_EVENT, onTermAction);

    try {
      render(<KeyboardHarness shortcuts={{ focusAiBounce: 'Ctrl+L' }} />);
      const termInput = screen.getByLabelText('Terminal input');
      termInput.focus();

      const notPrevented = fireEvent.keyDown(termInput, { key: 'l', code: 'KeyL', ctrlKey: true });
      expect(notPrevented).toBe(true);

      fireEvent.keyDown(termInput, { key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true });
      expect(termActions).toEqual(['snippets']);
    } finally {
      window.removeEventListener(TERMINAL_ACTION_EVENT, onTermAction);
    }
  });

  it('opens Command & AI palette on Cmd+K (metaKey) when inline terminal AI button is absent, without hijacking Ctrl+K', () => {
    const setGlobalSearchOpen = vi.fn();
    render(<KeyboardHarness setGlobalSearchOpen={setGlobalSearchOpen} />);
    const termInput = screen.getByLabelText('Terminal input');
    termInput.focus();

    fireEvent.keyDown(termInput, { key: 'k', code: 'KeyK', ctrlKey: true });
    expect(setGlobalSearchOpen).not.toHaveBeenCalled();

    fireEvent.keyDown(termInput, { key: 'k', code: 'KeyK', metaKey: true });
    expect(setGlobalSearchOpen).toHaveBeenCalledWith(true);
  });
});

describe('Task 3: parameterized workflow snippets (snippets.ts & SnippetPaletteModal.tsx)', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { multissh?: unknown }).multissh;
  });

  it('parses {{var}} and {{var=default}} placeholders, excludes built-ins, and expands with values + defaults', () => {
    const cmd = 'kubectl logs -n {{ namespace = default }} {{pod}} --tail={{lines=100}} --host={{host}}';
    expect(hasSnippetVariables(cmd)).toBe(true);
    expect(hasSnippetVariables('echo {{host}} {{user}} {{date}}')).toBe(false);

    expect(parseSnippetVariables(cmd)).toEqual([
      { name: 'namespace', defaultValue: 'default' },
      { name: 'pod' },
      { name: 'lines', defaultValue: '100' },
    ]);

    expect(getDefaultSnippetValues(cmd)).toEqual({
      namespace: 'default',
      pod: '',
      lines: '100',
    });

    expect(getMissingSnippetVariables(cmd, { namespace: 'default', pod: '', lines: '100' })).toEqual(['pod']);
    expect(getMissingSnippetVariables(cmd, { namespace: 'prod', pod: 'api-1', lines: '50' })).toEqual([]);

    expect(
      expandSnippet(cmd, { host: 'k8s-01', user: 'ops' }, new Date(2026, 0, 1, 12, 0), {
        namespace: 'prod',
        pod: 'api-0',
      })
    ).toBe('kubectl logs -n prod api-0 --tail=100 --host=k8s-01');
  });

  it('renders live fill-in preview form in SnippetPaletteModal and supports Stage in Terminal and Run in AI', async () => {
    const onInsert = vi.fn();
    const onRunInAi = vi.fn();
    const onClose = vi.fn();
    window.multissh = {
      snippetsList: vi.fn().mockResolvedValue(sampleSnippets),
      snippetsSave: vi.fn(),
      snippetsDelete: vi.fn(),
    } as unknown as typeof window.multissh;

    render(
      <ConfirmProvider>
        <SnippetPaletteModal
          hostKey="k8s-prod"
          hostLabel="k8s-prod"
          context={{ host: 'k8s-prod', user: 'deploy' }}
          onInsert={onInsert}
          onRunInAi={onRunInAi}
          onClose={onClose}
        />
      </ConfirmProvider>
    );

    await waitFor(() => expect(screen.getByText('Restart K8s Deployment')).toBeInTheDocument());
    expect(screen.getByText('2 params')).toBeInTheDocument();

    // Opening parameterized snippet reveals fill-in form with default values & live preview
    fireEvent.click(screen.getByText('Restart K8s Deployment'));
    expect(screen.getByTestId('snippet-fill-form')).toBeInTheDocument();
    expect(screen.getByTestId('snippet-live-preview')).toHaveTextContent(
      'kubectl rollout restart deployment/{{deploy}} -n default'
    );
    expect(screen.getByText('Unfilled: deploy')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('deploy'), { target: { value: 'web-api' } });
    fireEvent.change(screen.getByLabelText('namespace'), { target: { value: 'production' } });

    expect(screen.getByTestId('snippet-live-preview')).toHaveTextContent(
      'kubectl rollout restart deployment/web-api -n production'
    );
    expect(screen.queryByText(/Unfilled:/)).not.toBeInTheDocument();

    // Stage in Terminal
    fireEvent.click(screen.getByRole('button', { name: 'Stage in Terminal' }));
    expect(onInsert).toHaveBeenCalledWith(
      'kubectl rollout restart deployment/web-api -n production',
      false
    );

    // Run in AI
    fireEvent.click(screen.getByRole('button', { name: 'Run in AI' }));
    expect(onRunInAi).toHaveBeenCalledWith(
      'kubectl rollout restart deployment/web-api -n production',
      sampleSnippets[0]
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dispatches sshs3:ai-attach when Run in AI is clicked without custom onRunInAi callback', async () => {
    const aiAttachEvents: Array<{ label?: string; text?: string; prompt?: string }> = [];
    const onAiAttach = (e: Event) => aiAttachEvents.push((e as CustomEvent).detail);
    window.addEventListener('sshs3:ai-attach', onAiAttach);

    window.multissh = {
      snippetsList: vi.fn().mockResolvedValue(sampleSnippets),
    } as unknown as typeof window.multissh;

    try {
      const onClose = vi.fn();
      render(
        <ConfirmProvider>
          <SnippetPaletteModal
            hostKey="web-01"
            hostLabel="web-01"
            context={{ host: 'web-01', user: 'alice' }}
            onInsert={vi.fn()}
            onClose={onClose}
          />
        </ConfirmProvider>
      );

      await waitFor(() => expect(screen.getByText('Check Host Uptime')).toBeInTheDocument());
      const uptimeRow = screen.getByText('Check Host Uptime').closest('li')!;
      fireEvent.click(within(uptimeRow).getByRole('button', { name: 'Run in AI' }));

      expect(aiAttachEvents).toEqual([
        {
          label: 'Check Host Uptime',
          text: 'uptime && uname -a # web-01',
          prompt: 'uptime && uname -a # web-01',
        },
      ]);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('sshs3:ai-attach', onAiAttach);
    }
  });
});
