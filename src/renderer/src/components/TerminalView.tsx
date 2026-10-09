import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import 'xterm/css/xterm.css';
import { ChevronDown, ChevronUp, RotateCcw, Search, X } from 'lucide-react';
import type { SSHConnectionConfig, SSHPtyExitEvent, LocalShellType } from '@shared/types/ssh';
import type { SessionExitAction, AppSettings } from '@shared/types/settings';
import type { K8sTerminalTarget } from '@shared/types/kubernetes';
import { registerTerminalLinks } from '../lib/terminalLinks';
import { CommandOutputTracker } from '../lib/terminalOutput';
import { TERMINAL_ACTION_EVENT, type TerminalAction } from '../lib/terminalActionEvents';
import { SnippetPaletteModal } from './SnippetPaletteModal';
import { AiAssistantModal } from './AiAssistantModal';
import { AI_CONFIG_CHANGED_EVENT, eraseTypedLine, isFailureExitCode, looksLikeFailure, TypedLineTracker } from '../lib/aiTerminal';
import type { AiTask, AiTerminalEnvironment } from '@shared/types/ai';
import { PerfBar } from './PerfBar';
import { ClipboardHistoryModal } from './ClipboardHistoryModal';
import { OPEN_CLIPBOARD_HISTORY_EVENT } from '../lib/clipboardHistoryEvents';
import { usePerfSamples } from '../lib/usePerfSamples';
import type { PerfLayout, PerfMetricId } from '@shared/types/perf';
import { extractHostnameFromCommand, scanOutputForHost } from '../lib/terminalTitle';

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
  /** Ctrl+click on a file path in the output (SSH sessions only). Receives the path as printed, e.g. `/var/log/x` or `~/x`. */
  onOpenPath?: (path: string) => void;
  /** Performance bar above the terminal (SSH, local shell and Kubernetes sessions). Omit to disable it entirely — nothing is polled. */
  perfMetrics?: { layout: PerfLayout; items: PerfMetricId[]; intervalSec?: number };
  /** Callback to close the enclosing tab. */
  onCloseTab?: () => void;
  /** Emitted when an OSC 0 or OSC 2 title sequence is received from the shell. */
  onTitleChange?: (title: string) => void;
}

function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
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
  selectionBackground: '#31363b',
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
  const onOpenPathRef = useRef(onOpenPath);
  onOpenPathRef.current = onOpenPath;
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
  /** Terminal text captured when the AI assistant was opened (it stays open while the terminal keeps printing). */
  const [aiContext, setAiContext] = useState<{
    selection: string;
    lastOutput: string;
    task?: AiTask;
    autoSubmit?: boolean;
  } | null>(null);
  /** Whether the AI assistant is turned on; its in-terminal hints only appear when it is. */
  const aiEnabledRef = useRef(false);
  /** Shown after a command fails, offering to explain the error. */
  const [failureHint, setFailureHint] = useState(false);
  const aiEnvironment = useMemo<AiTerminalEnvironment>(() => {
    if (k8sTarget) return { kind: 'k8s' };
    if (!local) return { kind: 'ssh' };
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    return { kind: 'local', platform: ua.includes('Windows') ? 'win32' : ua.includes('Mac') ? 'darwin' : 'linux', shell: shellType };
  }, [k8sTarget, local, shellType]);
  const aiEnvironmentRef = useRef(aiEnvironment);
  aiEnvironmentRef.current = aiEnvironment;

  useEffect(() => {
    const load = (): void => {
      const pending = window.multissh?.aiGetConfig?.();
      if (!pending) return;
      void pending
        .then((config) => {
          aiEnabledRef.current = config.enabled;
          if (!config.enabled) setFailureHint(false);
        })
        .catch(() => {});
    };
    load();
    window.addEventListener(AI_CONFIG_CHANGED_EVENT, load);
    return () => window.removeEventListener(AI_CONFIG_CHANGED_EVENT, load);
  }, []);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
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
      openPath: onOpenPathRef.current ? (path) => onOpenPathRef.current?.(path) : undefined,
    });
    const outputTracker = new CommandOutputTracker(term);
    outputTrackerRef.current = outputTracker;

    // AI failure hint. With OSC 133 shell integration the exit code says whether a command failed;
    // otherwise the end of its output is checked for typical error messages once output settles.
    const typedLine = new TypedLineTracker();
    /** The command line as typed, for spotting `ssh host` / `exit` (looser than typedLine, never null). */
    let inputLineBuffer = '';
    let awaitingCommandEnd = false;
    let failureCheckTimer: ReturnType<typeof setTimeout> | undefined;
    outputTracker.onCommandEnd = (exitCode) => {
      // Only commands the user ran: not the shell's startup or the app's own initial `cd`.
      const ranByUser = awaitingCommandEnd;
      awaitingCommandEnd = false;
      if (ranByUser && aiEnabledRef.current && isFailureExitCode(exitCode)) setFailureHint(true);
    };
    const scheduleFailureCheck = (): void => {
      if (!awaitingCommandEnd || outputTracker.hasShellIntegration || !aiEnabledRef.current) return;
      clearTimeout(failureCheckTimer);
      failureCheckTimer = setTimeout(() => {
        if (!awaitingCommandEnd || term.buffer.active.type !== 'normal') return;
        if (looksLikeFailure(outputTracker.lastOutput())) {
          awaitingCommandEnd = false;
          setFailureHint(true);
        }
      }, 700);
    };

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

    // Shift+Insert and middle-click paste the most recent history entry; without
    // copy-on-select (or with an empty history) they fall back to the system clipboard.
    const pasteLatest = (): void => {
      const fallback = (): void => {
        navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text) term.paste(text);
          })
          .catch(() => {
            // Ignore: clipboard access can be denied
          });
      };
      if (!copyOnSelectRef.current || !window.multissh?.clipboardHistoryList) {
        fallback();
        return;
      }
      window.multissh
        .clipboardHistoryList(historyScope())
        .then((entries) => (entries.length > 0 ? term.paste(entries[0].text) : fallback()))
        .catch(fallback);
    };

    const handleMiddleClick = (e: MouseEvent) => {
      if (e.button !== 1 || !copyOnSelectRef.current) return;
      // Stop Chromium's native PRIMARY-selection paste so only the history entry is pasted.
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'auxclick') pasteLatest();
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

    const showNotice = (message: string, durationMs = 2000): void => {
      setCopyNotice(message.length > 200 ? `${message.slice(0, 200)}…` : message);
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => setCopyNotice(null), durationMs);
    };
    const writeToPty = (data: string): void => {
      const write = k8sTargetRef.current ? window.multissh?.k8sTerminalWrite : window.multissh?.terminalWrite;
      if (sessionIdRef.current && write) write(sessionIdRef.current, data);
    };
    // Turns what the user typed at the prompt ("find files over 100 MB") into a command, in place.
    const runInlineCommand = async (): Promise<void> => {
      if (!aiEnabledRef.current) {
        showNotice('Turn on the AI assistant in Settings → AI Assistant', 4000);
        return;
      }
      const typed = typedLine.text;
      if (typed === null || !typed.trim()) {
        // Nothing (reliably) typed: describe the task in the assistant instead.
        setAiContext({ selection: term.getSelection(), lastOutput: outputTracker.lastOutput() ?? '', task: 'command' });
        return;
      }
      showNotice('✨ Writing a command…', 60_000);
      try {
        const result = await window.multissh.aiAsk({ task: 'command', prompt: typed, environment: aiEnvironmentRef.current });
        const command = (result.command ?? '').replace(/[\r\n]+$/, '');
        if (typedLine.text !== typed) {
          showNotice('The line changed while waiting, so the suggestion was not inserted', 4000);
        } else if (!command) {
          showNotice(result.text || 'No command was suggested for that', 6000);
        } else if (command.includes('\n')) {
          showNotice('The suggestion spans several lines; open the AI Assistant to review it', 5000);
        } else {
          // The erase goes straight to the shell, so keep both line trackers in step with it.
          const erase = eraseTypedLine(typed);
          writeToPty(erase);
          typedLine.feed(erase);
          inputLineBuffer = inputLineBuffer.slice(0, Math.max(0, inputLineBuffer.length - typed.length));
          term.paste(command);
          showNotice(result.text || 'Review the command, then press Enter', result.text.startsWith('Warning') ? 10_000 : 6000);
        }
      } catch (err) {
        showNotice((err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, ''), 6000);
      }
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
      } else if (action === 'aiAssistant') {
        setAiContext({ selection: term.getSelection(), lastOutput: outputTracker.lastOutput() ?? '' });
      } else if (action === 'aiInlineCommand') {
        void runInlineCommand();
      } else if (action === 'copyLastOutput') {
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
      }
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
      if (e.type === 'keydown' && e.shiftKey && e.key === 'Insert') {
        e.preventDefault();
        pasteLatest();
        return false;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === 'Tab' || e.key === 'ISO_Left_Tab' || e.code === 'Tab' || e.keyCode === 9)
      ) {
        return false;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === '+' ||
          e.key === '=' ||
          e.key === '-' ||
          e.key === '0' ||
          e.code === 'NumpadAdd' ||
          e.code === 'NumpadSubtract' ||
          e.code === 'Minus' ||
          e.code === 'Equal' ||
          e.code === 'Digit0')
      ) {
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
    if (local || activeConfig || k8sTarget) {
      const killSession = k8sTarget ? window.multissh?.k8sTerminalKill : window.multissh?.terminalKill;
      const createPromise = k8sTarget
        ? window.multissh?.k8sTerminalCreate?.(k8sTarget, { cols, rows })
        : window.multissh?.terminalCreate?.(
            local
              ? { local: true as const, ptyOptions: { cols, rows, shellType, wslDistro } }
              : { config: { ...(activeConfig as SSHConnectionConfig), id: crypto.randomUUID() }, ptyOptions: { cols, rows } }
          );
      createPromise
        ?.then(({ sessionId }) => {
          if (isDisposed) {
            // Already unmounted while waiting for session creation
            killSession?.(sessionId);
            return;
          }
          sessionIdRef.current = sessionId;
          setPerfSessionId(sessionId);

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
          let cwdSent = false;
          const sendInitialCwd = () => {
            if (cwdSent) return;
            cwdSent = true;
            const cwd = initialCwdRef.current;
            if (cwd && sessionIdRef.current && window.multissh?.terminalWrite) {
              setTimeout(() => {
                if (!isDisposed && sessionIdRef.current) {
                  window.multissh.terminalWrite(sessionIdRef.current, `cd ${shellQuote(cwd)}\n`);
                }
              }, 400);
            }
          };

          // 3. User input to PTY
          term.onData((data) => {
            const write = k8sTarget ? window.multissh?.k8sTerminalWrite : window.multissh?.terminalWrite;
            if (sessionIdRef.current && write) {
              write(sessionIdRef.current, data);
            }
            typedLine.feed(data);
            if (data.includes('\r') || data.includes('\n')) {
              awaitingCommandEnd = true;
              setFailureHint(false);
              outputTracker.recordEnter();
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
              // Ctrl+D (EOF/exit)
              onTitleChangeRef.current?.('__EXIT__');
            } else if (data === '\x7f' || data === '\b') {
              inputLineBuffer = inputLineBuffer.slice(0, -1);
            } else {
              // Strip control escape characters, retain printable text (including pasted commands)
              // eslint-disable-next-line no-control-regex
              const printable = data.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
              inputLineBuffer += printable;
            }
          });

          // 4. Data from PTY to xterm
          const onData = k8sTarget ? window.multissh?.onK8sTerminalData : window.multissh?.onTerminalData;
          if (onData) {
            unsubData = onData((sessId, data) => {
              if (sessId === sessionIdRef.current) {
                term.write(data);
                scheduleFailureCheck();
                sendInitialCwd();
                if (!k8sTarget) {
                  const detectedHost = scanOutputForHost(data);
                  if (detectedHost) {
                    onTitleChangeRef.current?.(detectedHost);
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
      clearTimeout(failureCheckTimer);
      outputTracker.onCommandEnd = null;
      outputTracker.dispose();
      outputTrackerRef.current = null;
      searchAddonRef.current = null;
      clearTimeout(settleTimer);
      clearTimeout(noticeTimer);
      const sid = sessionIdRef.current;
      const killSession = k8sTarget ? window.multissh?.k8sTerminalKill : window.multissh?.terminalKill;
      if (sid && killSession) {
        killSession(sid);
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
    >
      {perfMetrics && perfKind && (
        <PerfBar kind={perfKind} state={perfState} layout={perfMetrics.layout} items={perfMetrics.items} title={perfTitle} local={Boolean(local)} />
      )}
      {/* Padding sits on this wrapper, not on the xterm container: FitAddon reads the parent's
          border-box height and only subtracts the xterm element's own padding, so padding on the
          container made the terminal ~16px too tall and clipped the last row (worse on Windows). */}
      <div className="min-h-0 w-full flex-1 px-1.5 py-1">
        <div
          ref={containerRef}
          data-testid="terminal-container"
          role="application"
          aria-label={terminalAriaLabel}
          className="h-full w-full overflow-hidden focus:outline-none"
        />
      </div>

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

      {failureHint && !aiContext && (
        <div
          data-testid="ai-failure-hint"
          className="dark-surface absolute bottom-3 left-4 z-20 flex items-center gap-1 rounded-lg bg-slate-900/90 px-1 py-1 text-xs text-slate-200 shadow-lg animate-fade-in"
        >
          <button
            type="button"
            onClick={() => {
              setFailureHint(false);
              setAiContext({
                selection: '',
                lastOutput: outputTrackerRef.current?.lastOutput() ?? '',
                task: 'explain',
                autoSubmit: true,
              });
            }}
            className="rounded-md px-2 py-0.5 hover:bg-slate-700 cursor-pointer"
          >
            ✨ Explain this error
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              setFailureHint(false);
              termRef.current?.focus();
            }}
            className="rounded-md p-0.5 text-slate-400 hover:bg-slate-700 hover:text-slate-200 cursor-pointer"
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

      {aiContext && (
        <AiAssistantModal
          environment={aiEnvironment}
          selection={aiContext.selection}
          lastOutput={aiContext.lastOutput}
          initialTask={aiContext.task}
          autoSubmit={aiContext.autoSubmit}
          onInsert={(command) => {
            setAiContext(null);
            const term = termRef.current;
            if (!term) return;
            const text = command.replace(/[\r\n]+$/, '');
            // Never press Enter: the user reviews the suggestion and runs it themselves. A shell
            // without bracketed paste would run each pasted line, so multi-line text is copied instead.
            if (text.includes('\n') && !term.modes.bracketedPasteMode) {
              void navigator.clipboard?.writeText(text).catch(() => {});
              setCopyNotice('Multi-line command copied: paste it once you have reviewed it');
              setTimeout(() => setCopyNotice(null), 5000);
            } else {
              term.paste(text);
            }
            term.focus();
          }}
          onClose={() => {
            setAiContext(null);
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
            <span className="font-medium text-slate-200">
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
    </div>
  );
};
