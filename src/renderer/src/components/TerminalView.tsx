import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { ChevronDown, ChevronUp, RotateCcw, Search, Sparkles, X } from 'lucide-react';
import type { SSHConnectionConfig, SSHPtyExitEvent, LocalShellType } from '@shared/types/ssh';
import type { SessionExitAction, AppSettings } from '@shared/types/settings';
import type { K8sTerminalTarget } from '@shared/types/kubernetes';
import { registerTerminalLinks } from '../lib/terminalLinks';
import { useTerminalPathHover } from '../lib/useTerminalPathHover';
import { CommandOutputTracker, isAtEmptyPrompt } from '../lib/terminalOutput';
import { useSudoRetry } from '../lib/useSudoRetry';
import { isTerminalReply, printableInput } from '../lib/terminalInput';
import { hasControlChars } from '../lib/shellSafety';
import { IS_WINDOWS } from '../lib/platform';
import { SudoRetryPrompt } from './SudoRetryPrompt';
import { TERMINAL_ACTION_EVENT, type TerminalAction } from '../lib/terminalActionEvents';
import { SnippetPaletteModal } from './SnippetPaletteModal';
import { PerfBar } from './PerfBar';
import { ClipboardHistoryModal } from './ClipboardHistoryModal';
import { TerminalPathHoverCard } from './TerminalPathHoverCard';
import { FileEditorModal } from './FileManager/FileEditorModal';
import { DragOutDialog } from './FileManager/DragOutDialog';
import { isDirectPreviewFile, isDualModeFile } from './FileManager/fileTypeHelpers';
import { OPEN_CLIPBOARD_HISTORY_EVENT } from '../lib/clipboardHistoryEvents';
import { usePerfSamples } from '../lib/usePerfSamples';
import type { PerfLayout, PerfMetricId } from '@shared/types/perf';
import { extractHostnameFromCommand, scanOutputForHost } from '../lib/terminalTitle';
import { cdCommand } from '../lib/cdCommand';
import { usePortDetection } from '../lib/usePortDetection';
import { TerminalPortPill } from './TerminalPortPill';
import { useTerminalDropUpload } from '../lib/useTerminalDropUpload';
import { TerminalDropOverlay } from './TerminalDropOverlay';
import {
  consumeDetached,
  killUnlessReclaimed,
  registerLiveSession,
  takeAttach,
  unregisterLiveSession,
} from '../lib/liveSessions';
import { isTerminalZoomShortcut } from '../lib/terminalZoomKey';

import { TerminalControl } from './AiHub/TerminalControl';
import { hubRequest, selectAiTerminal } from '../lib/aiHub';

export interface TerminalViewProps {
  /** Omit together with `local` to spawn a local shell instead of an SSH session. */
  config?: SSHConnectionConfig;
  /** Spawn a local shell (user's default shell on macOS/Linux, chosen shell on Windows) instead of connecting over SSH. */
  local?: boolean;
  /** Windows only: which local shell to spawn when `local` is set. */
  shellType?: LocalShellType;
  /** Windows only: specific WSL distribution to launch. */
  wslDistro?: string;
  /** Set to run an interactive exec session inside a Kubernetes/OpenShift container instead of SSH or a local shell. */
  k8sTarget?: K8sTerminalTarget;
  /** Id of the pane this terminal fills; lets a terminal moved from another window attach to its running session. */
  paneId?: string;
  isActive?: boolean;
  onExit?: (event: SSHPtyExitEvent) => void;
  className?: string;
  fontSize?: number;
  fontFamily?: string;
  theme?: 'dark' | 'light' | 'breeze' | 'system';
  /** Remote directory to `cd` into once the shell prompt appears (sent once, after first PTY output). */
  initialCwd?: string;
  /** Terminal scrollback buffer limit (default 5000). */
  scrollback?: number;
  /** Action on session exit: 'reconnect' (default), 'close' (auto-close tab on clean exit), or 'keep' (passive). */
  sessionExitAction?: SessionExitAction;
  /** Mirror text selections into the system clipboard, not just the X11 PRIMARY selection. */
  copyOnSelect?: boolean;
  /** Whether the selection history is shared by all hosts or kept per connection. */
  clipboardHistoryScope?: AppSettings['clipboardHistoryScope'];
  /** Whether hovering over file paths shows an interactive preview card. Default true. */
  pathHoverPreview?: boolean;
  /** Open the hover card on hover (default) or only while Ctrl/Cmd is held. */
  pathHoverMode?: 'hover' | 'ctrl';
  /** Whether a failed command with a permission error offers to re-run with sudo. Default true. */
  sudoRetryPrompt?: boolean;
  /** Whether web services/listening ports in output are auto-detected for quick port forwarding. Default true. */
  portForwardAutoDetect?: boolean;
  /** Optional custom regular expression for matching service ports in terminal output. */
  portForwardCustomRegex?: string;
  /** Ctrl+click on a file path in the output (SSH sessions only). Receives the path as printed, e.g. `/var/log/x` or `~/x`. */
  onOpenPath?: (path: string) => void;
  /** Performance bar above the terminal (SSH, local shell and Kubernetes sessions). Omit to disable it entirely — nothing is polled. */
  perfMetrics?: { layout: PerfLayout; items: PerfMetricId[]; intervalSec?: number };
  /** Callback to close the enclosing tab. */
  onCloseTab?: () => void;
  /** Emitted when an OSC 0 or OSC 2 title sequence is received from the shell. */
  onTitleChange?: (title: string) => void;
}

// Every ANSI foreground is >= 7:1 on the #f8fafc background, so `minimumContrastRatio` 7 never has to
// rewrite the palette itself (only 256-colour / truecolor output from programs). "White" and
// "bright white" are the awkward pair on a light surface: programs use them as text (should be dark)
// and as a fill behind black text (htop bars, vim/tmux status lines, diff highlights). They are light
// greys here: black text on them is 12-14:1, and when they are used as text xterm simply darkens them.
const XTERM_LIGHT_THEME = {
  background: '#f8fafc', // Soft slate-50 instead of harsh #ffffff
  foreground: '#0f172a', // slate-900
  cursor: '#075985', // Sky-800
  cursorAccent: '#f8fafc',
  selectionBackground: '#bfdbfe', // Blue-200: visible against the page, text stays readable
  black: '#0f172a',
  red: '#a61b1b',
  green: '#14532d',
  yellow: '#713f12',
  blue: '#075985',
  magenta: '#6b21a8',
  cyan: '#164e63',
  white: '#cbd5e1',
  brightBlack: '#475569',
  brightRed: '#a61b1b',
  brightGreen: '#14532d',
  brightYellow: '#713f12',
  brightBlue: '#075985',
  brightMagenta: '#6b21a8',
  brightCyan: '#164e63',
  brightWhite: '#e2e8f0',
};

const XTERM_DARK_THEME = {
  background: '#0f172a', // slate-900
  foreground: '#f8fafc', // slate-50
  cursor: '#38bdf8', // sky-400
  cursorAccent: '#0f172a',
  selectionBackground: '#334155', // slate-700
  black: '#0f172a',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#38bdf8',
  magenta: '#c084fc',
  cyan: '#06b6d4',
  white: '#f8fafc',
  brightBlack: '#64748b',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#fde047',
  brightBlue: '#60a5fa',
  brightMagenta: '#d8b4fe',
  brightCyan: '#22d3ee',
  brightWhite: '#ffffff',
};

const XTERM_BREEZE_THEME = {
  background: '#232627',
  foreground: '#fcfcfc',
  cursor: '#3daee9',
  cursorAccent: '#232627',
  selectionBackground: '#1e5774',
  black: '#232627',
  red: '#ed1515',
  green: '#11d116',
  yellow: '#f67400',
  blue: '#1d9bf3',
  magenta: '#9b59b6',
  cyan: '#1abc9c',
  white: '#fcfcfc',
  brightBlack: '#7f8c8d',
  brightRed: '#c0392b',
  brightGreen: '#1cdc9a',
  brightYellow: '#fdbc4b',
  brightBlue: '#3daee9',
  brightMagenta: '#8e44ad',
  brightCyan: '#16a085',
  brightWhite: '#ffffff',
};

function getXTermTheme(themeName: 'dark' | 'light' | 'breeze' | 'system') {
  if (themeName === 'breeze') return XTERM_BREEZE_THEME;
  if (themeName === 'light') return XTERM_LIGHT_THEME;
  if (themeName === 'system') {
    const isSystemLight = Boolean(window.matchMedia?.('(prefers-color-scheme: light)')?.matches);
    return isSystemLight ? XTERM_LIGHT_THEME : XTERM_DARK_THEME;
  }
  return XTERM_DARK_THEME;
}

/** xterm nudges colours that are too dim (256-colour / truecolor output) up to AAA (7:1) on light, AA on Breeze. */
function minContrastFor(themeName: 'dark' | 'light' | 'breeze' | 'system'): number {
  const theme = getXTermTheme(themeName);
  if (theme === XTERM_LIGHT_THEME) return 7;
  // Breeze's palette has a few colours that are dim on its grey background (e.g. bright red).
  if (theme === XTERM_BREEZE_THEME) return 4.5;
  return 1;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  config,
  local = false,
  shellType,
  wslDistro,
  k8sTarget,
  paneId,
  isActive = true,
  onExit,
  className = '',
  fontSize = 13,
  fontFamily = 'Menlo, Monaco, "Courier New", monospace, Consolas',
  theme = 'dark',
  initialCwd,
  scrollback = 5000,
  sessionExitAction = 'reconnect',
  copyOnSelect = false,
  clipboardHistoryScope = 'global',
  pathHoverPreview = true,
  pathHoverMode = 'hover',
  sudoRetryPrompt = true,
  portForwardAutoDetect = true,
  portForwardCustomRegex,
  onOpenPath,
  perfMetrics,
  onCloseTab,
  onTitleChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  // State copy of the SSH session id so the perf bar can poll it (the ref alone doesn't re-render).
  const [perfSessionId, setPerfSessionId] = useState<string | null>(null);
  useEffect(() => { if (isActive && perfSessionId) selectAiTerminal(perfSessionId); }, [isActive, perfSessionId]);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const configRef = useRef(config);
  configRef.current = config;
  const initialCwdRef = useRef(initialCwd);
  initialCwdRef.current = initialCwd;
  const k8sTargetRef = useRef(k8sTarget);
  k8sTargetRef.current = k8sTarget;
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const fontFamilyRef = useRef(fontFamily);
  fontFamilyRef.current = fontFamily;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const scrollbackRef = useRef(scrollback);
  scrollbackRef.current = scrollback;

  const connectionKey = useMemo(() => {
    if (local) return `local:${shellType || ''}:${wslDistro || ''}`;
    if (k8sTarget) return `k8s:${k8sTarget.contextName}:${k8sTarget.namespace}:${k8sTarget.podName}:${k8sTarget.containerName}`;
    if (config) return `ssh:${config.id || ''}:${config.host}:${config.port ?? 22}:${config.username}`;
    return '';
    // eslint-disable-next-line react-hooks/exhaustive-deps -- config properties are checked individually to avoid re-running on new object references
  }, [local, shellType, wslDistro, k8sTarget, config?.id, config?.host, config?.port, config?.username]);

  const hostLabel = k8sTarget
    ? `${k8sTarget.podName}/${k8sTarget.containerName}`
    : local
      ? 'Local shell'
      : config
        ? config.name || config.host
        : '';
  const hostKeyRef = useRef(connectionKey);
  hostKeyRef.current = connectionKey;
  const hostLabelRef = useRef(hostLabel);
  hostLabelRef.current = hostLabel;

  const sessionExitActionRef = useRef(sessionExitAction);
  sessionExitActionRef.current = sessionExitAction;
  const onCloseTabRef = useRef(onCloseTab);
  onCloseTabRef.current = onCloseTab;
  const copyOnSelectRef = useRef(copyOnSelect);
  copyOnSelectRef.current = copyOnSelect;
  const clipboardScopeRef = useRef(clipboardHistoryScope);
  clipboardScopeRef.current = clipboardHistoryScope;
  const rootRef = useRef<HTMLDivElement>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // The search addon selects each match (xterm reports that asynchronously); copy-on-select ignores a
  // selection equal to the open search query.
  const searchQueryRef = useRef('');
  const outputTrackerRef = useRef<CommandOutputTracker | null>(null);
  // Bumped to re-run the search for a query set from the keyboard shortcut.
  const [searchRequest, setSearchRequest] = useState(0);
  const searchOpenRef = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  searchOpenRef.current = searchOpen;
  const [searchQuery, setSearchQuery] = useState('');
  searchQueryRef.current = searchQuery;
  const [searchResults, setSearchResults] = useState<{ index: number; count: number } | null>(null);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [inlineAiOpen, setInlineAiOpen] = useState(false);
  const [inlineAiPrompt, setInlineAiPrompt] = useState('');
  const [inlineSuggestion, setInlineSuggestion] = useState<{
    command: string;
    explanation: string;
    /** May run with one key: one line, classified read-only. */
    runnable?: boolean;
    riskLevel?: string;
    riskReason?: string;
    multiline?: boolean;
  } | null>(null);
  const inlineSuggestionRef = useRef(inlineSuggestion);
  inlineSuggestionRef.current = inlineSuggestion;
  /** Which question an answer belongs to: an answer to an earlier one, or one asked in a bar since closed, is dropped. */
  const inlineAskRef = useRef(0);

  /**
   * Runs a suggestion with one key: only one line classified read-only, and only onto an empty prompt
   * (a half-typed line, a running program or an unanswered question would take it as input).
   * Anything else is pasted for the person to read and run.
   */
  const runInlineSuggestion = (): void => {
    const term = termRef.current;
    const suggestion = inlineSuggestionRef.current;
    if (!term || !suggestion) return;
    if (suggestion.multiline) return;
    if (!suggestion.runnable || !isAtEmptyPrompt(term)) {
      term.paste(suggestion.command);
    } else {
      term.paste(suggestion.command);
      if (sessionIdRef.current) {
        outputTrackerRef.current?.recordEnter();
        const write = k8sTarget ? window.multissh?.k8sTerminalWrite : window.multissh?.terminalWrite;
        write?.(sessionIdRef.current, '\r');
      }
    }
    setInlineSuggestion(null);
    setInlineAiPrompt('');
    setInlineAiOpen(false);
    term.focus();
  };
  const [inlineLoading, setInlineLoading] = useState(false);
  const [terminalErrorHint, setTerminalErrorHint] = useState<string | null>(null);
  const inlineAiInputRef = useRef<HTMLInputElement>(null);
  const notifyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = useCallback((message: string, durationMs = 2000) => {
    clearTimeout(notifyTimerRef.current);
    setCopyNotice(message);
    notifyTimerRef.current = setTimeout(() => setCopyNotice(null), durationMs);
  }, []);
  useEffect(() => () => clearTimeout(notifyTimerRef.current), []);
  const pathHover = useTerminalPathHover({
    target: { local, config, k8sTarget },
    initialCwd,
    wsl: Boolean(local && shellType === 'wsl'),
    wslDistro,
    pathHoverPreview,
    pathHoverMode,
    onOpenPath,
    termRef,
    sessionIdRef,
    notify,
  });
  const pathHoverRef = useRef(pathHover);
  pathHoverRef.current = pathHover;

  // `sudo` does not exist in PowerShell or cmd.
  const sudoAvailable = !(
    local &&
    (shellType === 'cmd' || shellType === 'powershell' || shellType === 'pwsh' || (IS_WINDOWS && (!shellType || shellType === 'default')))
  );
  const sudoAvailableRef = useRef(sudoAvailable);
  sudoAvailableRef.current = sudoAvailable;
  const sudoRetry = useSudoRetry({
    rootUser: config?.username === 'root',
    enabled: sudoRetryPrompt && sudoAvailable,
    termRef,
    trackerRef: outputTrackerRef,
    run: (sudoCommand) => {
      const term = termRef.current;
      const sid = sessionIdRef.current;
      if (!term || !sid) return;
      const write = k8sTarget ? window.multissh?.k8sTerminalWrite : window.multissh?.terminalWrite;
      // Typed onto the prompt without Enter: the user sees the whole command on the real line, can edit
      // it, and runs it with a second Enter. Written straight to the PTY, like typing it, so it does not
      // go through onData, whose line buffer only tracks what the user typed. The command is a single
      // plain line (see detectSudoRetry).
      // The echo of this is the user's own line, not output that moves the prompt (see PromptAnchorTracker).
      outputTrackerRef.current?.noteInput();
      write?.(sid, sudoCommand);
      term.focus();
      // Typing scrolls xterm to the bottom, a direct PTY write does not. The bar also disappears now,
      // which resizes the terminal, so scroll again once that refit (next frame) has happened.
      term.scrollToBottom();
      requestAnimationFrame(() => requestAnimationFrame(() => termRef.current?.scrollToBottom()));
    },
  });
  const sudoRetryRef = useRef(sudoRetry);
  sudoRetryRef.current = sudoRetry;

  const portDetection = usePortDetection({
    // Kubernetes terminals have no port-forward path here, so a pod's ports must not be offered as local ones
    enabled: portForwardAutoDetect && !k8sTarget,
    customRegex: portForwardCustomRegex,
    isRemote: Boolean(config),
    config,
  });
  const scanPortsRef = useRef(portDetection.scanOutput);
  scanPortsRef.current = portDetection.scanOutput;

  const dropUpload = useTerminalDropUpload({
    isRemote: Boolean(config),
    wsl: Boolean(local && shellType === 'wsl'),
    config,
    k8sTarget,
    targetFolder: pathHover.cardCwd || '',
    onPaste: (text) => {
      termRef.current?.paste(text);
      termRef.current?.focus();
    },
    onNotice: notify,
  });

  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  // Tracks the size last reported to the PTY, shared between the resize observer and the
  // "becomes active" effect so both can decide whether a SIGWINCH sync is actually needed.
  const lastColsRef = useRef(0);
  const lastRowsRef = useRef(0);

  const [sessionKey, setSessionKey] = useState(0);
  const perfTitle = k8sTarget
    ? `${k8sTarget.podName}/${k8sTarget.containerName}`
    : local
      ? 'Local shell'
      : (config?.name || config?.host);
  const perfKind = k8sTarget ? 'k8s' : local || config ? 'ssh' : null;
  const perfState = usePerfSamples({
    local: Boolean(local && !k8sTarget),
    sshSessionId: perfSessionId,
    k8sTarget,
    intervalSec: perfMetrics?.intervalSec,
    active: Boolean(perfMetrics && perfKind && isActive),
  });
  const [exitEvent, setExitEvent] = useState<SSHPtyExitEvent | null>(null);

  // Lazy connection: background tabs (isActive === false on mount) defer
  // creating the PTY and spawning SSH until they become active for the first time.
  const [hasEverBeenActive, setHasEverBeenActive] = useState<boolean>(isActive);

  useEffect(() => {
    if (isActive && !hasEverBeenActive) {
      setHasEverBeenActive(true);
    }
  }, [isActive, hasEverBeenActive]);

  const handleReconnect = useCallback(() => {
    setExitEvent(null);
    setSessionKey((prev) => prev + 1);
  }, []);

  /**
   * Fits the xterm buffer to its container and synchronizes dimensions to the backend PTY.
   * While the container is hidden (display: none), fitting is skipped to prevent 0x0 degenerate sizes.
   */
  const syncPtySize = useCallback((force = false) => {
    if (!termRef.current || !fitAddonRef.current) return;
    if (!isActiveRef.current) return;
    try {
      try {
        const core = (termRef.current as any)?._core;
        if (core?._charSizeService && !core._charSizeService.hasValidSize) {
          core._charSizeService.measure();
        }
      } catch {
        // Safe to ignore if charSizeService is not accessible
      }
      fitAddonRef.current.fit();
      const newCols = termRef.current.cols;
      const newRows = termRef.current.rows;
      if (
        sessionIdRef.current &&
        (force || newCols !== lastColsRef.current || newRows !== lastRowsRef.current) &&
        newCols >= 10 &&
        newRows >= 3
      ) {
        lastColsRef.current = newCols;
        lastRowsRef.current = newRows;
        const resize = k8sTargetRef.current ? window.multissh?.k8sTerminalResize : window.multissh?.terminalResize;
        resize?.(sessionIdRef.current, newCols, newRows);
      }
    } catch {
      // Safe to ignore resize on hidden element
    }
  }, []);

  // Focus and fit when becoming active
  useEffect(() => {
    if (isActive && fitAddonRef.current && termRef.current) {
      let isCancelled = false;
      try {
        termRef.current.focus();
        // The pane was `display: none` while inactive; xterm's renderer can leave a stale
        // paint (cursor drawn at its pre-hide position) until new PTY output forces a redraw.
        termRef.current.refresh(0, termRef.current.rows - 1);
        syncPtySize(true);
      } catch {
        // Safe to ignore resize on hidden element
      }

      // When activating a tab that was in the background (display: none),
      // allow a frame and a short delay for DOM layout / font metrics to settle.
      // Call syncPtySize() without force so IPC is only dispatched if dimensions actually changed.
      const raf = requestAnimationFrame(() => {
        if (!isCancelled) syncPtySize();
      });
      const timer = setTimeout(() => {
        if (!isCancelled) syncPtySize();
      }, 80);

      if (document.fonts) {
        document.fonts.ready.then(() => {
          if (!isCancelled) {
            syncPtySize();
          }
        });
      }

      return () => {
        isCancelled = true;
        cancelAnimationFrame(raf);
        clearTimeout(timer);
      };
    }
    return undefined;
  }, [isActive, syncPtySize]);

  // Update terminal options when props change without recreating the PTY session
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize;
      termRef.current.options.fontFamily = fontFamily;
      termRef.current.options.theme = getXTermTheme(theme);
      termRef.current.options.minimumContrastRatio = minContrastFor(theme);
      if (scrollback !== undefined) {
        termRef.current.options.scrollback = scrollback;
      }
      syncPtySize();
      if (document.fonts) {
        document.fonts.ready.then(() => {
          syncPtySize();
        });
      }
    }
  }, [fontSize, fontFamily, theme, scrollback, syncPtySize]);

  // Main lifecycle: spawns and manages the PTY session.
  // Style properties are intentionally managed by the separate effect above to avoid session resets.
  useEffect(() => {
    if (!hasEverBeenActive) return;

    const container = containerRef.current;
    if (!container) return;

    setExitEvent(null);
    let isDisposed = false;
    let unsubData: (() => void) | null = null;
    let unsubExit: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const currentTheme = themeRef.current;

    // 1. Initialize Terminal & FitAddon
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: fontSizeRef.current,
      fontFamily: fontFamilyRef.current,
      theme: getXTermTheme(currentTheme),
      minimumContrastRatio: minContrastFor(currentTheme),
      scrollback: scrollbackRef.current ?? 5000,
      allowProposedApi: true,
      linkHandler: {
        activate: (_event, text) => {
          void window.multissh?.openExternal(text);
        },
      },
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;
    const resultsSub = searchAddon.onDidChangeResults(({ resultIndex, resultCount }: { resultIndex: number; resultCount: number }) =>
      setSearchResults({ index: resultIndex, count: resultCount })
    );
    registerTerminalLinks(term, {
      openUrl: (url) => void window.multissh.openExternal(url),
      ...pathHoverRef.current.createLinkHandlers(),
    });
    const outputTracker = new CommandOutputTracker(term);
    outputTrackerRef.current = outputTracker;

    const osc7Handler = term.parser.registerOscHandler(7, (data) => pathHoverRef.current.handleOsc7(data));

    term.open(containerRef.current);
    if (isActiveRef.current) {
      try {
        term.focus();
      } catch {
        // Safe to ignore in test/headless env
      }
    }

    const titleSub = term.onTitleChange((title) => {
      onTitleChangeRef.current?.(title);
      pathHoverRef.current.detectCwdFromText(title);
    });

    // Copy-on-select mirrors the selection into the system CLIPBOARD (not just the
    // browser/X11 PRIMARY selection middle-click already gets for free), so keyboard
    // paste shortcuts that read CLIPBOARD have something to paste. Once the selection
    // settles it is also recorded in the (encrypted) clipboard history.
    const historyScope = (): string | undefined => (clipboardScopeRef.current === 'host' ? hostKeyRef.current : undefined);
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    const selectionSub = term.onSelectionChange(() => {
      if (!copyOnSelectRef.current) return;
      clearTimeout(settleTimer);
      const selection = term.getSelection();
      if (!selection) return;
      if (searchOpenRef.current && selection.toLowerCase() === searchQueryRef.current.toLowerCase()) return;
      navigator.clipboard?.writeText(selection).catch(() => {
        // Ignore: clipboard access can be denied (no focus, permissions, etc.)
      });
      settleTimer = setTimeout(() => {
        void window.multissh
          ?.clipboardHistoryAdd(selection, hostKeyRef.current, hostLabelRef.current)
          .catch(() => {});
        setCopyNotice(`Copied ${selection.length} character${selection.length === 1 ? '' : 's'}`);
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => setCopyNotice(null), 2000);
      }, 350);
    });

    // Shift+Insert, Ctrl+Shift+V and middle-click paste from the system clipboard,
    // falling back to the most recent encrypted history entry if clipboard access is denied.
    const pasteFromClipboard = (): void => {
      const fallbackToHistory = (): void => {
        if (!window.multissh?.clipboardHistoryList) return;
        window.multissh
          .clipboardHistoryList(historyScope())
          .then((entries) => {
            if (entries.length > 0) term.paste(entries[0].text);
          })
          .catch(() => {});
      };

      if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) {
              term.paste(text);
            } else {
              fallbackToHistory();
            }
          })
          .catch(() => {
            fallbackToHistory();
          });
      } else {
        fallbackToHistory();
      }
    };

    const handleMiddleClick = (e: MouseEvent) => {
      if (e.button !== 1 || !copyOnSelectRef.current) return;
      // Stop Chromium's native PRIMARY-selection paste so the system clipboard/history entry is pasted.
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'auxclick') pasteFromClipboard();
    };
    container.addEventListener('mouseup', handleMiddleClick, true);
    container.addEventListener('auxclick', handleMiddleClick, true);

    const handleContextMenu = (e: MouseEvent) => {
      if (!copyOnSelectRef.current) return;
      e.preventDefault();
      setHistoryOpen(true);
    };
    // Keyboard shortcut (dispatched by App): only the terminal that currently has focus reacts.
    const handleOpenHistory = () => {
      if (!copyOnSelectRef.current || !isActiveRef.current) return;
      if (!container.contains(document.activeElement)) return;
      setHistoryOpen(true);
    };
    window.addEventListener(OPEN_CLIPBOARD_HISTORY_EVENT, handleOpenHistory);

    const showNotice = (message: string): void => {
      setCopyNotice(message);
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => setCopyNotice(null), 2000);
    };
    const handleTerminalAction = (e: Event) => {
      if (!isActiveRef.current || !rootRef.current?.contains(document.activeElement)) return;
      const action = (e as CustomEvent<TerminalAction>).detail;
      if (action === 'search') {
        const selection = term.getSelection();
        if (selection && !selection.includes('\n')) {
          setSearchQuery(selection);
          setSearchRequest((n) => n + 1);
        }
        setSearchOpen(true);
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (action === 'snippets') {
        setSnippetsOpen(true);
      } else if (action === 'copyLastOutput') {
        copyLastCommandOutput();
      } else if (action === 'rerunWithSudo') {
        rerunLastWithSudo();
      }
    };

    const rerunLastWithSudo = (): void => {
      if (!sudoAvailableRef.current) {
        showNotice('sudo is not available in this shell');
        return;
      }
      // Only onto an empty prompt: a half-typed line, a running program or an unanswered question would
      // receive the text as input instead.
      if (!isAtEmptyPrompt(term)) {
        showNotice('Wait for an empty prompt to re-run with sudo');
        return;
      }
      const kind = sudoRetryRef.current.rerunWithSudo(outputTracker.lastCommand());
      if (kind === 'refused') showNotice('This command cannot be re-run with sudo');
      else if (kind === 'history') showNotice("Typed 'sudo !!' (works in bash and zsh)");
    };

    const copyLastCommandOutput = (): void => {
      const output = outputTracker.lastOutput();
      if (!output) {
        showNotice('No command output to copy');
        return;
      }
      const lines = output.split('\n').length;
      (navigator.clipboard ? navigator.clipboard.writeText(output) : Promise.reject(new Error('no clipboard')))
        .then(() => {
          if (copyOnSelectRef.current) {
            void window.multissh?.clipboardHistoryAdd(output, hostKeyRef.current, hostLabelRef.current).catch(() => {});
          }
          showNotice(`Copied last output (${lines} line${lines === 1 ? '' : 's'})`);
        })
        .catch(() => showNotice('Could not access the clipboard'));
    };

    window.addEventListener(TERMINAL_ACTION_EVENT, handleTerminalAction);
    container.addEventListener('contextmenu', handleContextMenu, true);

    // Deduplicate rapid identical pastes (e.g. when Shift+Insert triggers both
    // Chromium's native paste event and the custom keydown handler below).
    let lastPasteText = '';
    let lastPasteTime = 0;

    const originalPaste = term.paste.bind(term);
    term.paste = (data: string) => {
      const now = Date.now();
      if (data && data === lastPasteText && now - lastPasteTime < 150) {
        return;
      }
      lastPasteText = data;
      lastPasteTime = now;
      originalPaste(data);
    };

    const handleDomPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain');
      if (text) {
        lastPasteText = text;
        lastPasteTime = Date.now();
      }
    };
    container.addEventListener('paste', handleDomPaste, true);

    // Shift+Insert is the conventional Linux terminal "paste from clipboard" shortcut;
    // xterm.js only reacts to the browser's native paste event (typically Ctrl/Cmd+V),
    // so it's wired up explicitly here.
    // Also prevent xterm from intercepting/swallowing tab switching shortcuts (Ctrl+Tab, Ctrl+Shift+Tab).
    term.attachCustomKeyEventHandler((e) => {
      if (e.defaultPrevented) {
        return false;
      }
      if (pathHoverRef.current.isEditorOpen()) {
        return false;
      }
      if (sudoRetryRef.current.handleKey(e)) {
        return false;
      }
      if (e.type === 'keydown' && e.key === 'Escape' && pathHoverRef.current.dismissCardOnEscape()) {
        e.preventDefault();
        return false;
      }
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey) {
        const keyLower = e.key.toLowerCase();
        // Ctrl+K: Open Inline Terminal AI bar (VS Code / Cursor style)
        // A full-screen program (an editor, a pager) keeps its own Ctrl+K.
        if (!e.shiftKey && keyLower === 'k' && term.buffer.active.type !== 'alternate') {
          e.preventDefault();
          inlineAskRef.current++;
          setInlineSuggestion(null);
          setInlineAiOpen(true);
          setTimeout(() => inlineAiInputRef.current?.focus(), 20);
          return false;
        }
        // Ctrl+L (with selection): Send selection to AI Chat (Ctrl+Shift+L is reserved for Snippets)
        if (!e.shiftKey && keyLower === 'l' && Boolean(term.getSelection())) {
          e.preventDefault();
          const selectedText = term.getSelection();
          if (selectedText) {
            window.dispatchEvent(
              new CustomEvent('sshs3:ai-attach', {
                detail: {
                  sessionId: sessionIdRef.current ?? undefined,
                  text: selectedText,
                  label: 'Terminal selection',
                },
              })
            );
          } else {
            window.dispatchEvent(new CustomEvent('sshs3:ai-open'));
          }
          return false;
        }
      }
      if (
        (e.type === 'keydown' && e.shiftKey && (e.key === 'Insert' || e.code === 'Insert')) ||
        (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'v' || e.key === 'V' || e.code === 'KeyV'))
      ) {
        e.preventDefault();
        pasteFromClipboard();
        return false;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === 'Tab' || e.key === 'ISO_Left_Tab' || e.code === 'Tab' || e.keyCode === 9)
      ) {
        return false;
      }
      if (isTerminalZoomShortcut(e)) {
        return false;
      }
      return true;
    });

    try {
      fitAddon.fit();
    } catch {
      // Ignore initial fit calculation in JSDOM / zero-size
    }

    if (document.fonts) {
      document.fonts.ready.then(() => {
        if (!isDisposed) {
          syncPtySize();
        }
      });
    }

    const cols = term.cols || 80;
    const rows = term.rows || 24;
    lastColsRef.current = cols;
    lastRowsRef.current = rows;

    // 2. Create Terminal Session via IPC
    // Always spawn under a fresh session id, never the saved profile's own id:
    // reusing it would let two mounts of the same profile (two tabs, or React
    // StrictMode's dev-mode double-invoke) collide on the same map entry in
    // SSHPtyManager, so killing one session tears down the other instead.
    const activeConfig = configRef.current;
    // A tab moved here from another window brings its running session: attach to it (and redraw
    // its output so far) instead of starting a new one.
    const attachTo = paneId ? takeAttach(paneId) : undefined;
    if (local || activeConfig || k8sTarget) {
      const killSession = k8sTarget ? window.multissh?.k8sTerminalKill : window.multissh?.terminalKill;
      const createPromise = attachTo
        ? window.multissh?.terminalAttach?.(attachTo.sessionId, attachTo.kind).then(({ scrollback: output }) => {
            if (output && !isDisposed) term.write(output);
            return { sessionId: attachTo.sessionId };
          })
        : k8sTarget
        ? window.multissh?.k8sTerminalCreate?.(k8sTarget, { cols, rows })
        : window.multissh?.terminalCreate?.(
            local
              ? { local: true as const, ptyOptions: { cols, rows, shellType, wslDistro } }
              : { config: { ...(activeConfig as SSHConnectionConfig), id: crypto.randomUUID() }, profileId: activeConfig?.id, ptyOptions: { cols, rows } }
          );
      createPromise
        ?.then(({ sessionId }) => {
          if (isDisposed) {
            // Already unmounted while waiting for session creation
            if (attachTo) killUnlessReclaimed(sessionId, (id) => killSession?.(id));
            else killSession?.(sessionId);
            return;
          }
          sessionIdRef.current = sessionId;
          if (paneId) registerLiveSession(paneId, { sessionId, kind: k8sTarget ? 'k8s' : 'ssh' });
          setPerfSessionId(sessionId);
          pathHoverRef.current.onSessionStarted(sessionId, () => isDisposed);

          // Force PTY size synchronization once session ID is established.
          // On app launch or tab restoration, the session was spawned with provisional
          // dimensions (80x24) while the DOM layout was still settling. Now that the
          // session ID is bound and container is in the DOM, re-measure with fit()
          // and push the true cols/rows to the backend PTY so the shell receives SIGWINCH.
          syncPtySize(true);
          requestAnimationFrame(() => syncPtySize());
          setTimeout(() => syncPtySize(), 60);
          setTimeout(() => syncPtySize(), 200);

          // 2b. If requested, cd into a starting directory once the remote
          // shell has had a moment to print its prompt. There's no "wait for
          // prompt" signal from the PTY, so we send it shortly after the
          // first data arrives from the remote side.
          // An attached session is long past its first prompt: never `cd` again.
          let cwdSent = !!attachTo;
          const sendInitialCwd = () => {
            if (cwdSent) return;
            cwdSent = true;
            const cwd = initialCwdRef.current;
            // A cwd with control characters (it comes from the shell's own report) must not be typed back in.
            if (cwd && !hasControlChars(cwd) && sessionIdRef.current && window.multissh?.terminalWrite) {
              setTimeout(() => {
                if (!isDisposed && sessionIdRef.current) {
                  window.multissh.terminalWrite(sessionIdRef.current, `${cdCommand(cwd)}\n`);
                }
              }, 400);
            }
          };

          // 3. User input to PTY
          let inputLineBuffer = '';
          /** When a person last pressed Enter here: error words in output count only shortly after. */
          let lastEnterAt = 0;
          term.onData((data) => {
            const write = k8sTarget ? window.multissh?.k8sTerminalWrite : window.multissh?.terminalWrite;
            if (sessionIdRef.current && write) {
              void write(sessionIdRef.current, data).catch(() => { window.dispatchEvent(new CustomEvent('sshs3:ai-open')); });
            }
            if (!isTerminalReply(data)) outputTracker.noteInput();
            if (isTerminalReply(data)) {
              // The terminal answering a query from the program (fish asks before every prompt), not typing.
            } else if (data.includes('\r') || data.includes('\n')) {
              outputTracker.recordEnter();
              lastEnterAt = Date.now();
              // A new command: the last one's error chip is stale.
              setTerminalErrorHint(null);
              sudoRetryRef.current.notifyEnter();
              const parts = data.split(/[\r\n]+/);
              const cmd = (inputLineBuffer + (parts[0] || '')).trim();
              inputLineBuffer = parts.length > 1 ? parts[parts.length - 1] : '';
              const target = extractHostnameFromCommand(cmd);
              if (target) {
                onTitleChangeRef.current?.(`ssh ${target}`);
              } else if (/^(exit|logout)$/i.test(cmd)) {
                onTitleChangeRef.current?.('__EXIT__');
              }
            } else if (data === '\x04') {
              sudoRetryRef.current.notifyInput();
              // Ctrl+D (EOF/exit)
              onTitleChangeRef.current?.('__EXIT__');
            } else if (data === '\x7f' || data === '\b') {
              sudoRetryRef.current.notifyInput();
              inputLineBuffer = inputLineBuffer.slice(0, -1);
            } else {
              sudoRetryRef.current.notifyInput();
              // Retain printable text (including pasted commands), not escape sequences or controls
              const printable = printableInput(data);
              inputLineBuffer += printable;
            }
          });

          // 4. Data from PTY to xterm
          const onData = k8sTarget ? window.multissh?.onK8sTerminalData : window.multissh?.onTerminalData;
          if (onData) {
            unsubData = onData((sessId, data) => {
              if (sessId === sessionIdRef.current) {
                term.write(data);
                outputTracker.noteOutput();
                sudoRetryRef.current.notifyOutput();
                sendInitialCwd();
                pathHoverRef.current.detectCwdFromText(data);
                scanPortsRef.current(data);
                if (!k8sTarget) {
                  const detectedHost = scanOutputForHost(data);
                  if (detectedHost) {
                    onTitleChangeRef.current?.(detectedHost);
                  }
                }
                // eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
                const oscExitMatch = /\x1b\]133;D;([1-9][0-9]*)(?:\x07|\x1b\\)/.exec(data);
                // A command that ended well clears the chip: the error it pointed at is behind us.
                // eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
                if (/\x1b\]133;D;0(?:\x07|\x1b\\)/.test(data)) setTerminalErrorHint(null);
                if (
                  oscExitMatch ||
                  // Words in output count only right after a person ran something: `tail -f` or a grep that
                  // prints "Permission denied" is not a failed command.
                  (Date.now() - lastEnterAt < 20_000 &&
                  /(?:command not found|Permission denied|Connection refused|No such file or directory|502 Bad Gateway|CrashLoopBackOff|MountVolume\.SetUp failed|AttachVolume\.Attach failed|snapmirror.*broken-off|HEALTH_ERR|CommandNotFoundException|ParserError|failed \(Result: exit-code\)|ERR!|fatal:)/i.test(
                    data
                  ))
                ) {
                  // eslint-disable-next-line no-control-regex
                  const clean = (outputTracker.lastOutput() || data).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
                  if (clean) {
                    setTerminalErrorHint(clean.slice(0, 500));
                  }
                }
              }
            });
          }

          // 5. Exit from PTY / exec session
          if (k8sTarget) {
            if (window.multissh?.onK8sTerminalExit) {
              unsubExit = window.multissh.onK8sTerminalExit((sessId, event) => {
                if (sessId === sessionIdRef.current) {
                  term.write(`\r\n\x1b[33m[Session terminated: ${event.status}]\x1b[0m\r\n`);
                  const mapped: SSHPtyExitEvent = { exitCode: event.status === 'Success' ? 0 : 1 };
                  onExitRef.current?.(mapped);

                  const action = sessionExitActionRef.current;
                  if (action === 'close' && mapped.exitCode === 0 && onCloseTabRef.current) {
                    onCloseTabRef.current();
                  } else if (action !== 'keep') {
                    setExitEvent(mapped);
                  }
                }
              });
            }
          } else if (window.multissh?.onTerminalExit) {
            unsubExit = window.multissh.onTerminalExit((sessId, event) => {
              if (sessId === sessionIdRef.current) {
                term.write(
                  `\r\n\x1b[33m[Session terminated (code: ${event.exitCode})]\x1b[0m\r\n`
                );
                onExitRef.current?.(event);

                const action = sessionExitActionRef.current;
                if (action === 'close' && event.exitCode === 0 && onCloseTabRef.current) {
                  onCloseTabRef.current();
                } else if (action !== 'keep') {
                  setExitEvent(event);
                }
              }
            });
          }
        })
        .catch((err) => {
          if (!isDisposed) {
            term.write(`\r\n\x1b[31mFailed to start terminal session: ${err.message}\x1b[0m\r\n`);
            if (sessionExitActionRef.current !== 'keep') {
              setExitEvent({ exitCode: 1 });
            }
          }
        });
    }

    // 6. Handle Resize
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      resizeObserver = new ResizeObserver(() => {
        syncPtySize();
      });
      resizeObserver.observe(containerRef.current);
    }

    // 7. Cleanup on unmount
    return () => {
      isDisposed = true;
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (unsubData) {
        unsubData();
      }
      if (unsubExit) {
        unsubExit();
      }
      titleSub.dispose();
      selectionSub.dispose();
      resultsSub.dispose();
      outputTracker.dispose();
      osc7Handler.dispose();
      outputTrackerRef.current = null;
      searchAddonRef.current = null;
      clearTimeout(settleTimer);
      clearTimeout(noticeTimer);
      const sid = sessionIdRef.current;
      const killSession = k8sTarget ? window.multissh?.k8sTerminalKill : window.multissh?.terminalKill;
      if (sid && paneId) unregisterLiveSession(paneId, sid);
      if (sid && killSession) {
        if (consumeDetached(sid)) {
          // The tab moved to another window and takes the running session along: leave it alone.
        } else if (attachTo) {
          killUnlessReclaimed(sid, killSession);
        } else {
          killSession(sid);
        }
      }
      term.dispose();
      if (container) {
        container.removeEventListener('paste', handleDomPaste, true);
        container.removeEventListener('mouseup', handleMiddleClick, true);
        container.removeEventListener('auxclick', handleMiddleClick, true);
        container.removeEventListener('contextmenu', handleContextMenu, true);
        window.removeEventListener(OPEN_CLIPBOARD_HISTORY_EVENT, handleOpenHistory);
        window.removeEventListener(TERMINAL_ACTION_EVENT, handleTerminalAction);
        container.innerHTML = '';
      }
      termRef.current = null;
      fitAddonRef.current = null;
      sessionIdRef.current = null;
      setPerfSessionId(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- target & shell types are encapsulated into connectionKey
  }, [connectionKey, sessionKey, syncPtySize, hasEverBeenActive]);

  const isLight =
    theme === 'light' ||
    (theme === 'system' &&
      typeof window !== 'undefined' &&
      Boolean(window.matchMedia?.('(prefers-color-scheme: light)')?.matches));
  const isBreeze = theme === 'breeze';

  // Highlight colours for search matches (the addon requires #RRGGBB values).
  const searchColors = isBreeze
    ? { match: '#8e2a2a', matchBorder: '#ed1515', active: '#ed1515', activeBorder: '#fcfcfc' }
    : isLight
      ? { match: '#fde047', matchBorder: '#ca8a04', active: '#fb923c', activeBorder: '#9a3412' }
      : { match: '#a16207', matchBorder: '#facc15', active: '#ea580c', activeBorder: '#fed7aa' };
  const searchOptions = {
    decorations: {
      matchBackground: searchColors.match,
      matchBorder: searchColors.matchBorder,
      matchOverviewRuler: searchColors.matchBorder,
      activeMatchBackground: searchColors.active,
      activeMatchBorder: searchColors.activeBorder,
      activeMatchColorOverviewRuler: searchColors.active,
    },
  };
  const runSearch = (direction: 'next' | 'previous', query = searchQuery, incremental = false): void => {
    const addon = searchAddonRef.current;
    if (!addon) return;
    if (!query) {
      addon.clearDecorations();
      setSearchResults(null);
      return;
    }
    if (direction === 'next') addon.findNext(query, { ...searchOptions, incremental });
    else addon.findPrevious(query, searchOptions);
  };
  // A query filled in by the shortcut while the bar was already open is searched here.
  useEffect(() => {
    if (searchRequest > 0) runSearch('next');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new request should trigger a search
  }, [searchRequest]);
  const closeSearch = (): void => {
    setSearchOpen(false);
    setSearchResults(null);
    searchAddonRef.current?.clearDecorations();
    termRef.current?.focus();
  };


  // LOW finding (code review): xterm.js renders its own internal DOM (a
  // canvas layer plus a hidden textarea for input capture) into this
  // container, none of which carries any indication of what a screen
  // reader user has just tabbed into.
  const terminalAriaLabel = k8sTarget
    ? `Terminal: ${k8sTarget.podName}/${k8sTarget.containerName}`
    : local
      ? 'Terminal: local shell'
      : config
        ? `Terminal: ${config.name || config.host}`
        : 'Terminal';

  return (
    <div
      ref={rootRef}
      data-testid="terminal-view"
      className={`relative flex h-full w-full flex-col overflow-hidden ${
        isBreeze ? 'bg-[#232627]' : isLight ? 'bg-[#f8fafc]' : 'bg-[#0f172a]'
      } ${className}`}
      {...dropUpload.dragHandlers}
    >
      <TerminalDropOverlay
        isDragging={dropUpload.isDragging}
        isRemote={Boolean(config || k8sTarget)}
        targetFolder={pathHover.cardCwd || ''}
      />
      {perfMetrics && perfKind && (
        <PerfBar kind={perfKind} state={perfState} layout={perfMetrics.layout} items={perfMetrics.items} title={perfTitle} local={Boolean(local)} />
      )}
      {/* Padding sits on this wrapper, not on the xterm container: FitAddon reads the parent's
          border-box height and only subtracts the xterm element's own padding, so padding on the
          container made the terminal ~16px too tall and clipped the last row (worse on Windows). */}
      <TerminalControl sessionId={perfSessionId} />
      {perfSessionId && (
        <div className="absolute bottom-1 right-3 z-10 flex items-center gap-1.5">
          {terminalErrorHint && (
            <div className="flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/15 px-2 py-0.5 text-[10px] font-medium text-rose-200 shadow-lg animate-fade-in">
              <button
                type="button"
                data-testid="terminal-fix-error-btn"
                className="inline-flex items-center gap-1 hover:text-white"
                onClick={() => {
                  // What raised the chip, not whatever was printed since.
                  const latest = terminalErrorHint;
                  window.dispatchEvent(new CustomEvent('sshs3:ai-open'));
                  window.dispatchEvent(
                    new CustomEvent('sshs3:ai-attach', {
                      detail: {
                        sessionId: perfSessionId,
                        text: latest,
                        label: `${hostLabel || 'Terminal'} error output`,
                        prompt:
                          'Explain why this error came up in the terminal and suggest the right command to fix it.',
                      },
                    })
                  );
                  setTerminalErrorHint(null);
                }}
              >
                <Sparkles className="h-3 w-3 text-rose-400" />
                <span>✨ Explain &amp; fix the error</span>
              </button>
              <button
                type="button"
                aria-label="Dismiss error hint"
                onClick={() => setTerminalErrorHint(null)}
                className="ml-0.5 text-rose-300/70 hover:text-white"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          )}
          <button
            type="button"
            data-testid="terminal-inline-ai-btn"
            className="rounded border border-border-subtle bg-app-surface px-2 py-0.5 text-[10px] text-sky-400 hover:bg-app-surface-hover"
            onClick={() => {
              setInlineAiOpen((prev) => !prev);
              setInlineSuggestion(null);
              setTimeout(() => inlineAiInputRef.current?.focus(), 20);
            }}
          >
            Inline AI (Ctrl+K)
          </button>
          <button
            type="button"
            className="rounded bg-app-surface px-2 py-0.5 text-[10px] text-txt-muted hover:text-txt-primary"
            onClick={() => {
              const text = termRef.current?.getSelection() || outputTrackerRef.current?.lastOutput();
              window.dispatchEvent(new CustomEvent('sshs3:ai-open'));
              if (text) {
                window.dispatchEvent(
                  new CustomEvent('sshs3:ai-attach', {
                    detail: {
                      sessionId: perfSessionId,
                      text,
                      label: termRef.current?.getSelection() ? 'Terminal selection' : 'Last command output',
                    },
                  })
                );
              }
            }}
          >
            Attach selection to AI
          </button>
        </div>
      )}
      {inlineAiOpen && (
        <div
          data-testid="terminal-inline-ai"
          className="absolute left-4 right-4 top-9 z-20 flex flex-col gap-2 rounded-xl border border-sky-500/40 bg-app-surface/95 px-3 py-2.5 text-xs text-txt-primary shadow-2xl backdrop-blur"
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const q = inlineAiPrompt.trim();
              if (!q) return;
              if (inlineSuggestion) {
                // Pressing Enter when a suggestion is ready pastes it into the terminal (never more than one line).
                if (inlineSuggestion.multiline) return;
                termRef.current?.paste(inlineSuggestion.command);
                setInlineSuggestion(null);
                setInlineAiPrompt('');
                setInlineAiOpen(false);
                termRef.current?.focus();
                return;
              }
              setInlineLoading(true);
              const asked = ++inlineAskRef.current;
              try {
                const contextText =
                  termRef.current?.getSelection() || outputTrackerRef.current?.lastOutput() || '';
                const snap = await hubRequest({
                  action: 'inline-suggest',
                  prompt: q,
                  sessionId: perfSessionId ?? undefined,
                  context: contextText || undefined,
                });
                const suggested = snap.reply?.inlineSuggestion;
                // Asked again, or closed, while this was on its way: it answers nothing any more.
                if (asked !== inlineAskRef.current) return;
                if (suggested) {
                  setInlineSuggestion({
                    command: suggested.command,
                    runnable: suggested.runnable === true,
                    riskLevel: suggested.riskLevel,
                    riskReason: suggested.riskReason,
                    multiline: suggested.multiline,
                    // A general check picked by keyword must not pass for an answer.
                    explanation:
                      suggested.source === 'fallback'
                        ? `No model answered. A general check instead: ${suggested.explanation}`
                        : suggested.source === 'skill'
                          ? `From a saved skill: ${suggested.explanation}`
                          : suggested.explanation,
                  });
                }
              } catch {
                // Fallback to side chat if inline suggestion fails
                window.dispatchEvent(new CustomEvent('sshs3:ai-open'));
                window.dispatchEvent(
                  new CustomEvent('sshs3:ai-attach', {
                    detail: {
                      sessionId: perfSessionId ?? undefined,
                      prompt: q,
                    },
                  })
                );
                setInlineAiPrompt('');
                setInlineAiOpen(false);
              } finally {
                setInlineLoading(false);
              }
            }}
            className="flex items-center gap-2"
          >
            <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-400 shrink-0">
              AI · {hostLabel || 'Terminal'}
            </span>
            <input
              ref={inlineAiInputRef}
              type="text"
              value={inlineAiPrompt}
              onChange={(e) => {
                setInlineAiPrompt(e.target.value);
                inlineAskRef.current++;
                if (inlineSuggestion) setInlineSuggestion(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  inlineAskRef.current++;
                  setInlineAiOpen(false);
                  setInlineSuggestion(null);
                  termRef.current?.focus();
                } else if (e.key === 'Enter' && e.ctrlKey && inlineSuggestion) {
                  e.preventDefault();
                  runInlineSuggestion();
                } else if (e.key === 'Enter' && e.shiftKey && inlineAiPrompt.trim()) {
                  e.preventDefault();
                  const q = inlineAiPrompt.trim();
                  const contextText =
                    termRef.current?.getSelection() || outputTrackerRef.current?.lastOutput() || '';
                  window.dispatchEvent(new CustomEvent('sshs3:ai-open'));
                  window.dispatchEvent(
                    new CustomEvent('sshs3:ai-attach', {
                      detail: {
                        sessionId: perfSessionId ?? undefined,
                        text: contextText || undefined,
                        label: contextText ? `${hostLabel || 'Terminal'} context` : undefined,
                        prompt: q,
                      },
                    })
                  );
                  setInlineSuggestion(null);
                  setInlineAiPrompt('');
                  setInlineAiOpen(false);
                }
              }}
              placeholder="Describe a command (Enter = suggest it right here, Shift+Enter = open in the AI chat)…"
              className="flex-1 bg-transparent text-xs text-txt-primary outline-none placeholder:text-txt-muted"
            />
            <button
              type="submit"
              disabled={!inlineAiPrompt.trim() || inlineLoading}
              className="rounded-md bg-sky-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-sky-500 disabled:opacity-40 shrink-0"
            >
              {inlineLoading ? 'Thinking…' : inlineSuggestion ? 'Paste (Enter)' : '⚡ Suggest'}
            </button>
            <button
              type="button"
              disabled={!inlineAiPrompt.trim()}
              onClick={() => {
                const q = inlineAiPrompt.trim();
                if (!q) return;
                const contextText =
                  termRef.current?.getSelection() || outputTrackerRef.current?.lastOutput() || '';
                window.dispatchEvent(new CustomEvent('sshs3:ai-open'));
                window.dispatchEvent(
                  new CustomEvent('sshs3:ai-attach', {
                    detail: {
                      sessionId: perfSessionId ?? undefined,
                      text: contextText || undefined,
                      label: contextText ? `${hostLabel || 'Terminal'} context` : undefined,
                      prompt: q,
                    },
                  })
                );
                setInlineSuggestion(null);
                setInlineAiPrompt('');
                setInlineAiOpen(false);
              }}
              className="rounded-md border border-border-subtle bg-app px-2 py-1 text-[11px] text-txt-secondary hover:text-txt-primary disabled:opacity-40 shrink-0"
            >
              To chat
            </button>
            <button
              type="button"
              aria-label="Close inline AI"
              onClick={() => {
                inlineAskRef.current++;
                setInlineAiOpen(false);
                setInlineSuggestion(null);
                termRef.current?.focus();
              }}
              className="rounded p-1 text-txt-muted hover:text-txt-primary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </form>

          {inlineSuggestion && (
            <div
              data-testid="terminal-inline-suggestion"
              className="flex flex-col gap-1.5 rounded-lg border border-sky-500/30 bg-app px-3 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                {/* Shown as it is, line for line: what is pasted is what is seen. */}
                <pre className="m-0 whitespace-pre-wrap font-mono text-xs text-emerald-300 break-all">
                  $ {inlineSuggestion.command}
                </pre>
                <div className="flex items-center gap-1.5 shrink-0">
                  {inlineSuggestion.multiline ? (
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard?.writeText(inlineSuggestion.command)}
                      className="rounded bg-app-surface px-2 py-1 text-[10px] font-medium text-txt-primary hover:bg-app-surface-hover border border-border-subtle"
                    >
                      Copy
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        termRef.current?.paste(inlineSuggestion.command);
                        setInlineSuggestion(null);
                        setInlineAiPrompt('');
                        setInlineAiOpen(false);
                        termRef.current?.focus();
                      }}
                      className="rounded bg-app-surface px-2 py-1 text-[10px] font-medium text-txt-primary hover:bg-app-surface-hover border border-border-subtle"
                    >
                      Paste (Enter)
                    </button>
                  )}
                  {inlineSuggestion.runnable && (
                    <button
                      type="button"
                      onClick={() => runInlineSuggestion()}
                      className="rounded bg-emerald-600 px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-emerald-500"
                    >
                      ▶ Run now (Ctrl+Enter)
                    </button>
                  )}
                </div>
              </div>
              {inlineSuggestion.riskLevel && inlineSuggestion.riskLevel !== 'safe' && (
                <span
                  className={`text-[11px] ${inlineSuggestion.riskLevel === 'destructive' ? 'text-rose-300' : 'text-amber-300'}`}
                  title={inlineSuggestion.riskReason}
                >
                  {inlineSuggestion.riskLevel === 'destructive' ? 'Hard to take back' : 'Changes something'}
                  {inlineSuggestion.riskReason ? `: ${inlineSuggestion.riskReason}` : ''}. Read it before you press Enter.
                </span>
              )}
              {inlineSuggestion.multiline && (
                <span className="text-[11px] text-amber-300">
                  More than one command: copy it and run each one yourself.
                </span>
              )}
              <span className="text-[11px] text-txt-muted">{inlineSuggestion.explanation}</span>
            </div>
          )}
        </div>
      )}
      <div className="min-h-0 w-full flex-1 px-1.5 py-1">
        <div
          ref={containerRef}
          data-testid="terminal-container"
          role="application"
          aria-label={terminalAriaLabel}
          className="h-full w-full overflow-hidden focus:outline-none"
        />
      </div>
      {sudoRetry.suggestion && !exitEvent && <SudoRetryPrompt command={sudoRetry.suggestion.sudoCommand} />}

      {searchOpen && (
        <div
          data-testid="terminal-search"
          className="absolute right-4 top-2 z-20 flex items-center gap-1 rounded-lg border border-border-subtle bg-app-surface px-2 py-1.5 text-xs text-txt-primary shadow-lg"
        >
          <Search className="h-3.5 w-3.5 text-txt-muted" />
          <input
            ref={searchInputRef}
            type="text"
            aria-label="Search terminal"
            autoFocus
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              runSearch('next', e.target.value, true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch(e.shiftKey ? 'previous' : 'next');
              else if (e.key === 'Escape') closeSearch();
            }}
            placeholder="Search…"
            className="w-44 bg-transparent px-1 text-xs text-txt-primary outline-none placeholder:text-txt-muted"
          />
          <span className="w-14 text-right text-[11px] text-txt-muted" aria-live="polite">
            {searchQuery && searchResults
              ? searchResults.count === 0
                ? 'No results'
                : searchResults.index >= 0
                  ? `${searchResults.index + 1}/${searchResults.count}`
                  : `${searchResults.count}+`
              : ''}
          </span>
          <button
            type="button"
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
            onClick={() => runSearch('previous')}
            className="rounded p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary cursor-pointer"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Next match"
            title="Next match (Enter)"
            onClick={() => runSearch('next')}
            className="rounded p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary cursor-pointer"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Close search"
            title="Close (Esc)"
            onClick={closeSearch}
            className="rounded p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {copyNotice && (
        <div
          data-testid="copy-notice"
          role="status"
          className="dark-surface pointer-events-none absolute bottom-3 right-4 z-20 rounded-lg bg-slate-900/90 px-3 py-1.5 text-xs text-slate-200 shadow-lg animate-fade-in"
        >
          {copyNotice}
        </div>
      )}

      {pathHover.hoverCardData && (
        <TerminalPathHoverCard
          path={pathHover.hoverCardData.path}
          x={pathHover.hoverCardData.x}
          y={pathHover.hoverCardData.y}
          userHome={pathHover.userHomeDir}
          currentCwd={pathHover.cardCwd}
          providerId={pathHover.providerId}
          toStoragePath={pathHover.toStoragePath}
          {...pathHover.cardProps}
        />
      )}

      {pathHover.dragOutPath && pathHover.providerId && (
        <DragOutDialog
          providerId={pathHover.providerId}
          paths={[pathHover.dragOutPath]}
          onClose={pathHover.closeDragOut}
        />
      )}

      {pathHover.editorEntry && (
        <FileEditorModal
          open={true}
          providerId={pathHover.providerId}
          sourceType={local ? 'local' : k8sTarget ? 'k8s' : 'sftp'}
          initialMode={
            isDirectPreviewFile(pathHover.editorEntry.name) || isDualModeFile(pathHover.editorEntry.name)
              ? 'preview'
              : 'source'
          }
          entry={pathHover.editorEntry}
          onSaved={() => notify(`Saved: ${pathHover.editorEntry?.name}`, 2500)}
          onClose={pathHover.closeEditor}
        />
      )}

      {snippetsOpen && (
        <SnippetPaletteModal
          hostKey={connectionKey}
          hostLabel={hostLabel}
          context={{ host: config?.host ?? hostLabel, user: config?.username ?? '' }}
          onInsert={(command, run) => {
            setSnippetsOpen(false);
            const term = termRef.current;
            if (term) {
              // A trailing newline plus "run" would press Enter twice.
              term.paste(run ? command.replace(/[\r\n]+$/, '') : command);
              if (run && sessionIdRef.current) {
                outputTrackerRef.current?.recordEnter();
                const write = k8sTarget ? window.multissh?.k8sTerminalWrite : window.multissh?.terminalWrite;
                write?.(sessionIdRef.current, '\r');
              }
              term.focus();
            }
          }}
          onClose={() => {
            setSnippetsOpen(false);
            termRef.current?.focus();
          }}
        />
      )}

      {historyOpen && (
        <ClipboardHistoryModal
          hostKey={clipboardHistoryScope === 'host' ? connectionKey : undefined}
          onPaste={(text) => {
            setHistoryOpen(false);
            termRef.current?.paste(text);
            termRef.current?.focus();
          }}
          onClose={() => {
            setHistoryOpen(false);
            termRef.current?.focus();
          }}
        />
      )}

      {exitEvent && (
        <div
          data-testid="session-exit-overlay"
          className="dark-surface absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 px-4 py-2.5 rounded-xl bg-slate-900/90 dark:bg-slate-800/95 border border-slate-700/80 shadow-2xl text-xs text-slate-200 z-20 animate-fade-in"
        >
          <div className="flex items-center gap-2 pr-2 border-r border-slate-700/70">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                exitEvent.exitCode === 0
                  ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.5)]'
                  : 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]'
              }`}
            />
            <span role="status" className="font-medium text-slate-200">
              Session ended{exitEvent.exitCode !== undefined ? ` (code ${exitEvent.exitCode})` : ''}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleReconnect}
              data-testid="reconnect-button"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 active:bg-sky-700 text-white font-medium shadow-sm transition-colors cursor-pointer"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reconnect
            </button>

            {onCloseTab && (
              <button
                type="button"
                onClick={onCloseTab}
                data-testid="close-tab-button"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 active:bg-slate-700 text-slate-300 hover:text-white font-medium transition-colors cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
                Close Tab
              </button>
            )}
          </div>
        </div>
      )}

      <TerminalPortPill
        ports={portDetection.detectedPorts}
        isRemote={Boolean(config)}
        onForwardAndOpen={portDetection.handleForwardAndOpen}
        onDismiss={portDetection.dismissPort}
      />
    </div>
  );
};
