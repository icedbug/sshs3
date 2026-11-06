import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Columns2, FolderTree, Maximize2, Minimize2, RefreshCw, Rows2, X } from 'lucide-react';
import { TerminalView } from './TerminalView';
import { K8sLogView } from './K8sLogView';
import { DualPaneExplorer } from './FileManager/DualPaneExplorer';
import { ConfirmProvider } from './ConfirmDialog';
import { SessionTelemetryPill } from './SessionTelemetryPill';
import {
  collectLeaves,
  consumePendingHostWorkspaceSplit,
  findLeaf,
  getLeafSshConfig,
  isSftpLeaf,
} from '../lib/paneTree';
import { getShortcutKeys } from '../lib/shortcuts';
import type { AppSettings } from '@shared/types/settings';
import { DEFAULT_PERF_ITEMS } from '@shared/types/perf';
import type { LocalShellType, SSHConnectionConfig } from '@shared/types/ssh';
import type { PaneLeaf, PaneNode, PaneOrientation } from '@shared/types/session';
import { UnconnectedPanePlaceholder } from './UnconnectedPanePlaceholder';
import { SplitDivider } from './ui/SplitDivider';

function ensureStorageBridgeDefaults(): void {
  if (typeof window === 'undefined') return;
  const win = window as unknown as { multissh?: Record<string, unknown> };
  if (!win.multissh) win.multissh = {};
  const m = win.multissh;
  if (typeof m.connectStorage !== 'function') {
    m.connectStorage = async (cfg?: { id?: string }) => ({ id: cfg?.id ?? 'local' });
  }
  if (typeof m.storageList !== 'function') {
    m.storageList = async () => [];
  }
  if (typeof m.getHomeDir !== 'function') {
    m.getHomeDir = async () => '/home/user';
  }
  if (typeof m.storageGetHomeDir !== 'function') {
    m.storageGetHomeDir = async () => '/home/user';
  }
  if (typeof m.sessionGet !== 'function') {
    m.sessionGet = async () => null;
  }
  if (typeof m.sessionSave !== 'function') {
    m.sessionSave = async () => undefined;
  }
  if (typeof m.profilesGet !== 'function') {
    m.profilesGet = async () => ({ ssh: [], s3: [] });
  }
  if (typeof m.transferGetJobs !== 'function') {
    m.transferGetJobs = async () => [];
  }
  if (typeof m.transferList !== 'function') {
    m.transferList = async () => [];
  }
  if (typeof m.onTransferProgress !== 'function') {
    m.onTransferProgress = () => () => {};
  }
  if (typeof m.onSearchResult !== 'function') {
    m.onSearchResult = () => () => {};
  }
  if (typeof m.onSearchProgress !== 'function') {
    m.onSearchProgress = () => () => {};
  }
  if (typeof m.onSearchError !== 'function') {
    m.onSearchError = () => () => {};
  }
  if (typeof m.onSearchDone !== 'function') {
    m.onSearchDone = () => () => {};
  }
}

interface SftpSplitStateEntry {
  splitId: string;
  sftpLeafId: string;
  config?: SSHConnectionConfig;
  sftpInitialPath?: string;
  weights: number[];
}

function findSiblingSftpLeafInNode(node: PaneNode, terminalPaneId: string): PaneLeaf | null {
  if (node.type === 'leaf') return null;
  const hasTarget = node.children.some((c) => c.type === 'leaf' && c.id === terminalPaneId);
  if (hasTarget) {
    const sftpSibling = node.children.find(
      (c): c is PaneLeaf => c.type === 'leaf' && c.id !== terminalPaneId && isSftpLeaf(c)
    );
    if (sftpSibling) return sftpSibling;
  }
  for (const child of node.children) {
    const found = findSiblingSftpLeafInNode(child, terminalPaneId);
    if (found) return found;
  }
  return null;
}

function injectSftpSplits(
  node: PaneNode,
  sftpSplits: Record<string, SftpSplitStateEntry>,
  rootNode: PaneNode
): PaneNode {
  if (node.type === 'leaf') {
    const splitEntry = sftpSplits[node.id];
    if (!splitEntry || isSftpLeaf(node) || findSiblingSftpLeafInNode(rootNode, node.id)) {
      return node;
    }
    const effectiveConfig = splitEntry.config ?? getLeafSshConfig(node);
    const sftpLeaf: PaneLeaf = {
      type: 'leaf',
      id: splitEntry.sftpLeafId,
      surfaceType: 'sftp',
      leafType: 'sftp',
      config: effectiveConfig,
      sshConfig: effectiveConfig,
      sftpInitialPath: splitEntry.sftpInitialPath ?? node.sftpInitialPath,
      local: node.local,
    };
    return {
      type: 'split',
      id: splitEntry.splitId,
      orientation: 'row',
      weights: splitEntry.weights,
      children: [node, sftpLeaf],
    };
  }

  let changed = false;
  const children = node.children.map((c) => {
    const next = injectSftpSplits(c, sftpSplits, rootNode);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

export interface PaneTreeViewProps {
  node: PaneNode;
  isActive: boolean;
  activePaneId?: string;
  totalPanes: number;
  settings: AppSettings;
  platform: string;
  onSelectPane: (paneId: string) => void;
  onSplitPane: (paneId: string, orientation: PaneOrientation) => void;
  /** Optional callback when splitting a pane into a Host Workspace (SSH + SFTP) split view. */
  onSplitSftp?: (paneId: string, config?: SSHConnectionConfig) => void;
  /** Sets a 2-child split node's relative pane sizes (§23) — the divider drag handler. */
  onResizeSplit?: (splitId: string, weights: number[]) => void;
  onClosePane: (paneId: string) => void;
  /** Pane shown alone, full-size (the other panes keep running hidden); undefined = normal layout. */
  zoomedPaneId?: string;
  onToggleZoom?: (paneId: string) => void;
  onChangeConnection: (paneId: string) => void;
  onOpenLocalTerminal: (paneId: string, shellType?: LocalShellType, wslDistro?: string) => void;
  onCloseTab: () => void;
  onTitleChange?: (paneId: string, title: string) => void;
  onOpenRemotePath?: (config: SSHConnectionConfig, path: string) => void;
  onOpenLocalPath?: (path: string) => void;
  /** Remote directory to `cd` into once this specific pane's shell prompt appears. */
  initialCwdPaneId?: string;
  initialCwd?: string;
  onNavigateToTabBar?: () => void;
  /** Local shells share one perf bar in the tab header, so they skip their own bar and sampling. */
  hoistLocalPerf?: boolean;
}

interface PaneTreeLayoutProps extends PaneTreeViewProps {
  getPaneContainer: (paneId: string) => HTMLDivElement;
  primaryTerminalPaneId?: string;
  hasSftpSplit: (paneId: string) => boolean;
  onToggleSftpSplit: (paneId: string) => void;
}

const PaneSlot: React.FC<{
  paneId: string;
  getPaneContainer: (paneId: string) => HTMLDivElement;
  onSelectPane: (paneId: string) => void;
}> = ({ paneId, getPaneContainer, onSelectPane }) => {
  const slotRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const slotEl = slotRef.current;
    const container = getPaneContainer(paneId);
    if (slotEl && container) {
      if (container.parentElement !== slotEl) {
        slotEl.appendChild(container);
      }
    }
  });

  return (
    <div
      ref={slotRef}
      onMouseDownCapture={() => onSelectPane(paneId)}
      className="flex-1 min-h-0 relative"
    />
  );
};

const PaneTreeLayout: React.FC<PaneTreeLayoutProps> = (props) => {
  const { node } = props;
  const splitContainerRef = useRef<HTMLDivElement>(null);

  if (node.type === 'split') {
    // Only the common 2-child case is user-resizable (§23) — a 3+-child split still renders
    // equally sized panes, same as before.
    if (node.children.length === 2) {
      const [a, b] = node.children;
      const weights = node.weights?.length === 2 ? node.weights : [1, 1];
      const ratio = weights[0] / (weights[0] + weights[1]);
      return (
        <div
          ref={splitContainerRef}
          className={`flex h-full w-full ${node.orientation === 'row' ? 'flex-row' : 'flex-col'}`}
        >
          <div style={{ flexGrow: ratio, flexBasis: 0, minHeight: 0, minWidth: 0 }} className="flex flex-col overflow-hidden">
            <PaneTreeLayout {...props} node={a} />
          </div>
          <SplitDivider
            orientation={node.orientation === 'row' ? 'vertical' : 'horizontal'}
            ratio={ratio}
            onChange={(r) => props.onResizeSplit?.(node.id, [r, 1 - r])}
            containerRef={splitContainerRef}
            label="Resize terminal panes"
          />
          <div style={{ flexGrow: 1 - ratio, flexBasis: 0, minHeight: 0, minWidth: 0 }} className="flex flex-col overflow-hidden">
            <PaneTreeLayout {...props} node={b} />
          </div>
        </div>
      );
    }
    return (
      <div className={`flex h-full w-full ${node.orientation === 'row' ? 'flex-row' : 'flex-col'}`}>
        {node.children.map((child, i) => (
          <div
            key={child.id}
            className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${
              i > 0
                ? node.orientation === 'row'
                  ? 'border-l border-divider'
                  : 'border-t border-divider'
                : ''
            }`}
          >
            <PaneTreeLayout {...props} node={child} />
          </div>
        ))}
      </div>
    );
  }

  const { activePaneId, totalPanes } = props;
  const isSole = totalPanes === 1;
  const isFocused = activePaneId === node.id;
  const isSftp = isSftpLeaf(node);
  const sshConfig = getLeafSshConfig(node);
  const isPrimaryTerminal = node.id === props.primaryTerminalPaneId && props.isActive !== false;
  const isSftpOpenForLeaf = !isSftp && props.hasSftpSplit(node.id);

  const baseName =
    sshConfig?.name ||
    sshConfig?.host ||
    (node.k8sTarget && `${node.k8sTarget.podName} / ${node.k8sTarget.containerName}`) ||
    (node.k8sLogTarget && `Logs: ${node.k8sLogTarget.podName} / ${node.k8sLogTarget.containerName}`) ||
    (node.local
      ? node.shellType === 'wsl'
        ? node.wslDistro
          ? `WSL: ${node.wslDistro}`
          : 'WSL'
        : 'Local Shell'
      : 'No connection');
  const displayTitle = node.dynamicHost ? `${baseName} → ${node.dynamicHost}` : baseName;

  return (
    <div
      data-testid={`terminal-pane-${node.id}`}
      data-surface-type={isSftp ? 'sftp' : 'terminal'}
      onMouseDownCapture={() => props.onSelectPane(node.id)}
      className={`relative flex h-full w-full flex-col overflow-hidden transition-all duration-150 ${
        isFocused && !isSole
          ? 'ring-1 ring-inset ring-sky-500/60 shadow-[inset_0_0_12px_rgba(14,165,233,0.06)]'
          : ''
      }`}
    >
      <div
        className={`flex h-7 shrink-0 items-center justify-between border-b px-2 text-xs transition-colors ${
          isFocused && !isSole
            ? 'border-sky-500/50 bg-sky-500/5 text-txt-primary font-medium'
            : 'border-border-subtle bg-app-surface text-txt-muted'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0 mr-2">
          {isFocused && !isSole && (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="relative inline-flex rounded-full h-2 w-2 bg-sky-500" />
            </span>
          )}
          {isSftp && <FolderTree className="h-3.5 w-3.5 text-amber-400 shrink-0" />}
          <span className="truncate font-mono">
            {isSftp ? `SFTP · ${displayTitle}` : displayTitle}
          </span>

          {!isSftp && (
            <SessionTelemetryPill
              paneId={node.id}
              config={sshConfig}
              local={node.local}
              k8sTarget={node.k8sTarget}
              k8sLogTarget={node.k8sLogTarget}
              hostLabel={displayTitle}
              disconnected={
                !sshConfig && !node.local && !node.k8sTarget && !node.k8sLogTarget
              }
              isSftpSplitActive={isSftpOpenForLeaf}
              testId={
                isPrimaryTerminal
                  ? 'session-telemetry-pill'
                  : `session-telemetry-pill-${node.id}`
              }
              onSplitSftp={() => props.onToggleSftpSplit(node.id)}
              onOpenFleet={props.onNavigateToTabBar}
            />
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          {!isSftp && (
            <>
              <button
                aria-label="Split SFTP"
                type="button"
                title={
                  isSftpOpenForLeaf
                    ? 'Close SFTP Split'
                    : 'Split SFTP side-by-side (Host Workspace)'
                }
                data-testid={`pane-split-sftp-${node.id}`}
                aria-pressed={isSftpOpenForLeaf}
                onClick={() => props.onToggleSftpSplit(node.id)}
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono transition-colors ${
                  isSftpOpenForLeaf
                    ? 'border border-sky-500/40 bg-sky-500/20 text-sky-300'
                    : 'text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
                }`}
              >
                <span
                  data-testid={isPrimaryTerminal ? 'pane-split-sftp' : undefined}
                  className="inline-flex items-center gap-1"
                >
                  <FolderTree className="h-3 w-3 text-amber-400" />
                  <span>SFTP Split</span>
                </span>
              </button>
              <button
                aria-label="Change connection"
                type="button"
                title="Change connection"
                data-testid={`change-pane-${node.id}`}
                onClick={() => props.onChangeConnection(node.id)}
                className="rounded p-1.5 hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              >
                <RefreshCw className="h-3 w-3" />
              </button>
            </>
          )}
          {!isSole && props.onToggleZoom && (
            <button
              type="button"
              title={`${props.zoomedPaneId === node.id ? 'Restore' : 'Zoom'} pane (${getShortcutKeys('zoomPane', props.settings.shortcuts)})`}
              data-testid={`zoom-pane-${node.id}`}
              onClick={() => props.onToggleZoom?.(node.id)}
              className="rounded p-1.5 hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
            >
              {props.zoomedPaneId === node.id ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
            </button>
          )}
          {!isSftp && (
            <>
              <button
                aria-label="Split right"
                type="button"
                title="Split right"
                data-testid={`split-row-${node.id}`}
                onClick={() => props.onSplitPane(node.id, 'row')}
                className="rounded p-1.5 hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              >
                <Columns2 className="h-3 w-3" />
              </button>
              <button
                aria-label="Split down"
                type="button"
                title="Split down"
                data-testid={`split-column-${node.id}`}
                onClick={() => props.onSplitPane(node.id, 'column')}
                className="rounded p-1.5 hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              >
                <Rows2 className="h-3 w-3" />
              </button>
            </>
          )}
          {!isSole && (
            <button
              aria-label="Close this pane"
              type="button"
              title="Close this pane"
              data-testid={`close-pane-${node.id}`}
              onClick={() => props.onClosePane(node.id)}
              className="rounded p-1.5 hover:bg-red-500/20 hover:text-red-400 transition-colors"
            >
              <span data-testid={isSftp ? 'close-sftp-split' : undefined}>
                <X className="h-3 w-3" />
              </span>
            </button>
          )}
        </div>
      </div>

      <PaneSlot paneId={node.id} getPaneContainer={props.getPaneContainer} onSelectPane={props.onSelectPane} />
    </div>
  );
};

const PaneLeafContent: React.FC<{
  leaf: PaneLeaf;
  isActive: boolean;
  totalPanes: number;
  settings: AppSettings;
  platform: string;
  initialCwdPaneId?: string;
  initialCwd?: string;
  onCloseTab: () => void;
  onClosePane: (paneId: string) => void;
  onChangeConnection: (paneId: string) => void;
  onOpenLocalTerminal: (paneId: string, shellType?: LocalShellType, wslDistro?: string) => void;
  onTitleChange?: (paneId: string, title: string) => void;
  onOpenRemotePath?: (config: SSHConnectionConfig, path: string) => void;
  onOpenLocalPath?: (path: string) => void;
  onSelectPane: (paneId: string) => void;
  onNavigateToTabBar?: () => void;
  hoistLocalPerf?: boolean;
}> = ({
  leaf,
  isActive,
  totalPanes,
  settings,
  platform,
  initialCwdPaneId,
  initialCwd,
  onCloseTab,
  onClosePane,
  onChangeConnection,
  onOpenLocalTerminal,
  onTitleChange,
  onOpenRemotePath,
  onOpenLocalPath,
  onSelectPane,
  onNavigateToTabBar,
  hoistLocalPerf,
}) => {
  const isSole = totalPanes === 1;
  const perfEnabled = settings.perfMetricsEnabled === true;
  const perfLayout = settings.perfMetricsLayout ?? 'text';
  const perfItems = settings.perfMetricsItems;
  const perfIntervalSec = settings.perfMetricsIntervalSec;
  const perfMetrics = useMemo(
    () =>
      perfEnabled
        ? { layout: perfLayout, items: perfItems ?? DEFAULT_PERF_ITEMS, intervalSec: perfIntervalSec }
        : undefined,
    [perfEnabled, perfLayout, perfItems, perfIntervalSec]
  );
  const sshConfig = getLeafSshConfig(leaf);
  let content: React.ReactNode;

  if (isSftpLeaf(leaf)) {
    ensureStorageBridgeDefaults();
    content = (
      <ConfirmProvider>
        <div
          data-testid={`sftp-pane-${leaf.id}`}
          data-surface-type="sftp"
          className="flex h-full w-full flex-col overflow-hidden bg-app"
        >
          <div
            data-testid="host-workspace-sftp-pane"
            className="flex h-full w-full flex-1 flex-col overflow-hidden"
          >
            <DualPaneExplorer
              initialSSHConfig={sshConfig}
              initialLocalPath={leaf.sftpInitialPath}
              shortcuts={settings.shortcuts}
              showHiddenFiles={settings.showHiddenFiles ?? false}
              gitIntegrationEnabled={settings.fileManagerGitIntegration ?? true}
              onOpenTerminal={onOpenRemotePath}
            />
          </div>
        </div>
      </ConfirmProvider>
    );
  } else if (sshConfig) {
    content = (
      <TerminalView
        paneId={leaf.id}
        config={sshConfig}
        perfMetrics={perfMetrics}
        isActive={isActive}
        fontSize={settings.terminalFontSize}
        fontFamily={settings.terminalFontFamily}
        theme={settings.theme}
        scrollback={settings.terminalScrollback}
        pathHoverPreview={settings.terminalPathHoverPreview}
        pathHoverMode={settings.terminalPathHoverMode}
        sudoRetryPrompt={settings.terminalSudoRetryPrompt}
        portForwardAutoDetect={settings.terminalPortForwardAutoDetect}
        portForwardCustomRegex={settings.terminalPortForwardCustomRegex}
        initialCwd={initialCwdPaneId === leaf.id ? initialCwd : undefined}
        sessionExitAction={settings.sessionExitAction}
        copyOnSelect={settings.copyOnSelect}
        clipboardHistoryScope={settings.clipboardHistoryScope}
        onOpenPath={onOpenRemotePath ? (path) => onOpenRemotePath(sshConfig, path) : undefined}
        onCloseTab={isSole ? onCloseTab : () => onClosePane(leaf.id)}
        onTitleChange={onTitleChange ? (title) => onTitleChange(leaf.id, title) : undefined}
      />
    );
  } else if (leaf.k8sTarget) {
    content = (
      <TerminalView
        paneId={leaf.id}
        k8sTarget={leaf.k8sTarget}
        perfMetrics={perfMetrics}
        isActive={isActive}
        fontSize={settings.terminalFontSize}
        fontFamily={settings.terminalFontFamily}
        theme={settings.theme}
        scrollback={settings.terminalScrollback}
        pathHoverPreview={settings.terminalPathHoverPreview}
        pathHoverMode={settings.terminalPathHoverMode}
        sudoRetryPrompt={settings.terminalSudoRetryPrompt}
        portForwardAutoDetect={settings.terminalPortForwardAutoDetect}
        portForwardCustomRegex={settings.terminalPortForwardCustomRegex}
        sessionExitAction={settings.sessionExitAction}
        copyOnSelect={settings.copyOnSelect}
        clipboardHistoryScope={settings.clipboardHistoryScope}
        onCloseTab={isSole ? onCloseTab : () => onClosePane(leaf.id)}
        onTitleChange={onTitleChange ? (title) => onTitleChange(leaf.id, title) : undefined}
      />
    );
  } else if (leaf.k8sLogTarget) {
    content = (
      <K8sLogView
        target={leaf.k8sLogTarget}
        isActive={isActive}
        fontSize={settings.terminalFontSize}
        fontFamily={settings.terminalFontFamily}
      />
    );
  } else if (leaf.local) {
    content = (
      <TerminalView
        paneId={leaf.id}
        local
        perfMetrics={hoistLocalPerf ? undefined : perfMetrics}
        shellType={leaf.shellType}
        wslDistro={leaf.wslDistro}
        isActive={isActive}
        fontSize={settings.terminalFontSize}
        fontFamily={settings.terminalFontFamily}
        theme={settings.theme}
        scrollback={settings.terminalScrollback}
        pathHoverPreview={settings.terminalPathHoverPreview}
        pathHoverMode={settings.terminalPathHoverMode}
        sudoRetryPrompt={settings.terminalSudoRetryPrompt}
        portForwardAutoDetect={settings.terminalPortForwardAutoDetect}
        portForwardCustomRegex={settings.terminalPortForwardCustomRegex}
        sessionExitAction={settings.sessionExitAction}
        copyOnSelect={settings.copyOnSelect}
        clipboardHistoryScope={settings.clipboardHistoryScope}
        onOpenPath={onOpenLocalPath ? (path) => onOpenLocalPath(path) : undefined}
        onCloseTab={isSole ? onCloseTab : () => onClosePane(leaf.id)}
        onTitleChange={onTitleChange ? (title) => onTitleChange(leaf.id, title) : undefined}
      />
    );
  } else {
    content = (
      <UnconnectedPanePlaceholder
        leafId={leaf.id}
        isSole={isSole}
        isActive={isActive}
        platform={platform}
        onChangeConnection={onChangeConnection}
        onOpenLocalTerminal={onOpenLocalTerminal}
        onNavigateToTabBar={onNavigateToTabBar}
      />
    );
  }

  return (
    <div
      className="h-full w-full"
      onMouseDownCapture={() => onSelectPane(leaf.id)}
      onFocusCapture={() => onSelectPane(leaf.id)}
    >
      {content}
    </div>
  );
};

export const PaneTreeView: React.FC<PaneTreeViewProps> = (props) => {
  const {
    node: propNode,
    initialCwd,
    onClosePane,
    onSplitSftp,
    onResizeSplit,
  } = props;
  const paneContainersRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const onSelectPaneRef = useRef(props.onSelectPane);
  onSelectPaneRef.current = props.onSelectPane;

  const [sftpSplits, setSftpSplits] = useState<Record<string, SftpSplitStateEntry>>({});

  const getPaneContainer = useCallback((paneId: string) => {
    let el = paneContainersRef.current.get(paneId);
    if (!el) {
      el = document.createElement('div');
      el.className = 'h-full w-full';
      el.addEventListener(
        'mousedown',
        () => {
          onSelectPaneRef.current(paneId);
        },
        true
      );
      el.addEventListener(
        'focusin',
        () => {
          onSelectPaneRef.current(paneId);
        },
        true
      );
      paneContainersRef.current.set(paneId, el);
    }
    return el;
  }, []);

  const rawLeaves = useMemo(() => collectLeaves(propNode), [propNode]);

  // Automatically activate SFTP split if a Server Blade requested a Host Workspace (SSH + SFTP) split
  useEffect(() => {
    for (const leaf of rawLeaves) {
      const cfg = getLeafSshConfig(leaf);
      if (cfg && consumePendingHostWorkspaceSplit(cfg)) {
        setSftpSplits((prev) => {
          if (prev[leaf.id]) return prev;
          return {
            ...prev,
            [leaf.id]: {
              splitId: `${leaf.id}-sftp-split`,
              sftpLeafId: `${leaf.id}-sftp`,
              config: cfg,
              sftpInitialPath: leaf.sftpInitialPath ?? initialCwd,
              weights: [0.5, 0.5],
            },
          };
        });
      }
    }
  }, [rawLeaves, initialCwd]);

  const hasSftpSplit = useCallback(
    (paneId: string): boolean => {
      if (sftpSplits[paneId]) return true;
      return Boolean(findSiblingSftpLeafInNode(propNode, paneId));
    },
    [sftpSplits, propNode]
  );

  const handleToggleSftpSplit = useCallback(
    (paneId: string) => {
      const existingInPropTree = findSiblingSftpLeafInNode(propNode, paneId);
      if (existingInPropTree) {
        onClosePane(existingInPropTree.id);
        return;
      }
      const targetLeaf = findLeaf(propNode, paneId);
      const cfg = targetLeaf ? getLeafSshConfig(targetLeaf) : undefined;
      setSftpSplits((prev) => {
        if (prev[paneId]) {
          const next = { ...prev };
          delete next[paneId];
          return next;
        }
        return {
          ...prev,
          [paneId]: {
            splitId: `${paneId}-sftp-split`,
            sftpLeafId: `${paneId}-sftp`,
            config: cfg,
            sftpInitialPath: targetLeaf?.sftpInitialPath ?? initialCwd,
            weights: [0.5, 0.5],
          },
        };
      });
      onSplitSftp?.(paneId, cfg);
    },
    [propNode, initialCwd, onClosePane, onSplitSftp]
  );

  const handleClosePane = useCallback(
    (paneId: string) => {
      // Check if closing an internally managed SFTP split leaf
      const matchingTerminalId = Object.keys(sftpSplits).find(
        (termId) => sftpSplits[termId]?.sftpLeafId === paneId
      );
      if (matchingTerminalId) {
        setSftpSplits((prev) => {
          const next = { ...prev };
          delete next[matchingTerminalId];
          return next;
        });
        return;
      }
      // If closing a terminal leaf that had an SFTP split attached, clean up its SFTP split too
      if (sftpSplits[paneId]) {
        setSftpSplits((prev) => {
          const next = { ...prev };
          delete next[paneId];
          return next;
        });
      }
      onClosePane(paneId);
    },
    [sftpSplits, onClosePane]
  );

  const handleResizeSplit = useCallback(
    (splitId: string, weights: number[]) => {
      const matchingTerminalId = Object.keys(sftpSplits).find(
        (termId) => sftpSplits[termId]?.splitId === splitId
      );
      if (matchingTerminalId) {
        setSftpSplits((prev) => {
          const current = prev[matchingTerminalId];
          if (!current) return prev;
          return {
            ...prev,
            [matchingTerminalId]: {
              ...current,
              weights,
            },
          };
        });
      }
      onResizeSplit?.(splitId, weights);
    },
    [sftpSplits, onResizeSplit]
  );

  const effectiveNode = useMemo(
    () => injectSftpSplits(propNode, sftpSplits, propNode),
    [propNode, sftpSplits]
  );

  const leaves = useMemo(() => collectLeaves(effectiveNode), [effectiveNode]);
  const effectiveTotalPanes = Math.max(props.totalPanes, leaves.length);

  const primaryTerminalPaneId = useMemo(() => {
    const terminalLeaves = leaves.filter((l) => !isSftpLeaf(l));
    if (terminalLeaves.length === 0) return undefined;
    if (props.activePaneId && terminalLeaves.some((l) => l.id === props.activePaneId)) {
      return props.activePaneId;
    }
    return terminalLeaves[0].id;
  }, [leaves, props.activePaneId]);

  useEffect(() => {
    const currentIds = new Set(leaves.map((l) => l.id));
    for (const [id, el] of paneContainersRef.current.entries()) {
      if (!currentIds.has(id)) {
        el.remove();
        paneContainersRef.current.delete(id);
      }
    }
  }, [leaves]);

  // A zoomed pane is laid out alone. The hidden panes keep their portal content (and sessions)
  // mounted in detached containers and are re-attached by their PaneSlot when the zoom ends.
  const zoomedLeaf = props.zoomedPaneId ? findLeaf(effectiveNode, props.zoomedPaneId) : null;

  return (
    <>
      <PaneTreeLayout
        {...props}
        node={zoomedLeaf ?? effectiveNode}
        totalPanes={effectiveTotalPanes}
        onClosePane={handleClosePane}
        onResizeSplit={handleResizeSplit}
        getPaneContainer={getPaneContainer}
        primaryTerminalPaneId={primaryTerminalPaneId}
        hasSftpSplit={hasSftpSplit}
        onToggleSftpSplit={handleToggleSftpSplit}
      />
      {leaves.map((leaf) => {
        const container = getPaneContainer(leaf.id);
        return createPortal(
          <PaneLeafContent
            key={leaf.id}
            leaf={leaf}
            isActive={props.isActive}
            totalPanes={effectiveTotalPanes}
            settings={props.settings}
            platform={props.platform}
            initialCwdPaneId={props.initialCwdPaneId}
            initialCwd={props.initialCwd}
            onCloseTab={props.onCloseTab}
            onClosePane={handleClosePane}
            onChangeConnection={props.onChangeConnection}
            onOpenLocalTerminal={props.onOpenLocalTerminal}
            onTitleChange={props.onTitleChange}
            onOpenRemotePath={props.onOpenRemotePath}
            onOpenLocalPath={props.onOpenLocalPath}
            onSelectPane={props.onSelectPane}
            onNavigateToTabBar={props.onNavigateToTabBar}
            hoistLocalPerf={props.hoistLocalPerf}
          />,
          container,
          leaf.id
        );
      })}
    </>
  );
};

export default PaneTreeView;
