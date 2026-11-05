import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FileEntry } from '@shared/types/storage';
import type { TerminalLinkHandlers } from './terminalLinks';
import { isDistinctiveFilename } from './terminalLinks';
import { lookupPathWithin, statIfExists } from './storageLookup';
import { createRendererLogger } from './log';
import {
  allowPreview,
  hoverModifierSatisfied,
  isRelativePath,
  mergeCwd,
  needsExistenceCheck,
  type ExistenceCheck,
  type PathHoverMode,
} from './pathPreviewGate';
import { isNetworkUncPath, resolvePathDetails } from './terminalPathPreview';
import { extractCwdFromPrompt } from './terminalOutput';
import { wslToWindowsPath } from './wslPaths';
import { pathBasename, terminalProviderId, terminalStorageConnectConfig, type TerminalStorageTarget } from './terminalStorage';

const log = createRendererLogger('path-hover');

const STAT_CACHE_TTL_MS = 5000;
/** A lookup that has not answered by now is treated as inconclusive and the card is shown as before. */
const LOOKUP_TIMEOUT_MS = 600;
/**
 * xterm reports a link as left, and asks for it again, whenever the rows it sits on are repainted (a
 * spinner, streaming output), without the pointer moving. A leave that is followed by a hover of the same
 * path within this time is such a repaint and must not close or restart anything.
 */
const LEAVE_GRACE_MS = 120;
const CONNECT_RETRY_BACKOFF_MS = 30_000;

interface HoverCardData {
  path: string;
  x: number;
  y: number;
}

export interface UseTerminalPathHoverOptions {
  target: TerminalStorageTarget;
  initialCwd?: string;
  /** A WSL shell reports Linux paths that the Windows side must translate before opening them. */
  wsl?: boolean;
  wslDistro?: string;
  pathHoverPreview: boolean;
  /** Open the hover card on hover (default) or only while Ctrl/Cmd is held. */
  pathHoverMode?: PathHoverMode;
  onOpenPath?: (path: string) => void;
  termRef: RefObject<Terminal | null>;
  sessionIdRef: RefObject<string | null>;
  notify: (message: string, durationMs?: number) => void;
}

function guessHome(username?: string): string {
  if (username === 'root') return '/root';
  return username ? `/home/${username}` : '';
}

/**
 * Terminal-side file path handling: cwd tracking, the hover preview card and the in-terminal editor.
 * The storage provider for remote hosts is connected lazily, the first time a path is actually
 * inspected, so merely opening a terminal never triggers a second authentication.
 */
export function useTerminalPathHover({
  target,
  initialCwd,
  wsl = false,
  wslDistro,
  pathHoverPreview,
  pathHoverMode = 'hover',
  onOpenPath,
  termRef,
  sessionIdRef,
  notify,
}: UseTerminalPathHoverOptions) {
  const { local, config } = target;
  const targetRef = useRef(target);
  targetRef.current = target;
  const providerId = terminalProviderId(target);
  const toStoragePath = useCallback((p: string) => (wsl ? wslToWindowsPath(p, wslDistro) : p), [wsl, wslDistro]);
  const toStoragePathRef = useRef(toStoragePath);
  toStoragePathRef.current = toStoragePath;
  const onOpenPathRef = useRef(onOpenPath);
  onOpenPathRef.current = onOpenPath;
  const pathHoverPreviewRef = useRef(pathHoverPreview);
  pathHoverPreviewRef.current = pathHoverPreview;
  const pathHoverModeRef = useRef(pathHoverMode);
  pathHoverModeRef.current = pathHoverMode;
  /** A path under the pointer that waits for Ctrl/Cmd (only in `ctrl` mode). */
  const pendingHoverRef = useRef<{ clientX: number; clientY: number; path: string } | null>(null);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const [hoverCardData, setHoverCardData] = useState<HoverCardData | null>(null);
  const hoverCardDataRef = useRef<HoverCardData | null>(null);
  hoverCardDataRef.current = hoverCardData;
  const hoverDwellTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Bumped whenever a pending card is cancelled, so a dwell callback already awaiting a lookup gives up. */
  const hoverGenerationRef = useRef(0);
  const hoverLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const leaveGraceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The path the pointer is on, as last reported by xterm. */
  const hoveredPathRef = useRef<string | null>(null);
  /**
   * Where the pointer is now. A card opens after a dwell (up to half a second when another card is open),
   * by which time the pointer has moved on from where it entered the link; placing the card relative to
   * the entry point can put it under the pointer, which then enters and leaves it as it settles.
   */
  const lastPointerRef = useRef({ clientX: 0, clientY: 0, seen: false });
  useEffect(() => {
    // Mutates one object: this runs for every mouse move in every terminal.
    const onMove = (e: MouseEvent) => {
      const p = lastPointerRef.current;
      p.clientX = e.clientX;
      p.clientY = e.clientY;
      p.seen = true;
    };
    window.addEventListener('mousemove', onMove, { capture: true, passive: true });
    return () => window.removeEventListener('mousemove', onMove, { capture: true });
  }, []);
  /** Debug trace of what opens and closes the card; a line identical to the previous one is dropped. */
  const lastTraceRef = useRef('');
  const trace = useCallback((event: string, data?: Record<string, unknown>) => {
    // A cheap key: this is called for every hover and leave while a card is open.
    const key = `${event}|${String(data?.path)}|${String(data?.open)}|${String(data?.replaced)}`;
    if (key === lastTraceRef.current) return;
    lastTraceRef.current = key;
    log.debug(event, data);
  }, []);
  const isMouseOverCardRef = useRef(false);

  const [userHomeDir, setUserHomeDir] = useState<string>(() => guessHome(config?.username) || '/home/user');
  const userHomeDirRef = useRef(userHomeDir);
  userHomeDirRef.current = userHomeDir;
  const [currentCwd, setCurrentCwd] = useState<string>(initialCwd || guessHome(config?.username));
  const currentCwdRef = useRef(currentCwd);
  currentCwdRef.current = currentCwd;

  const [editingFile, setEditingFile] = useState<string | null>(null);
  const editingFileRef = useRef(editingFile);
  editingFileRef.current = editingFile;
  const editorEntry = useMemo<FileEntry | null>(
    () =>
      editingFile
        ? { name: pathBasename(editingFile), path: toStoragePath(editingFile), size: 0, isDirectory: false }
        : null,
    [editingFile, toStoragePath]
  );

  /**
   * The working directory comes from the shell itself (OSC 7) or from its process, as opposed to being
   * guessed from prompt-like text in the output (which any such text can change) or the home directory.
   */
  const cwdReliableRef = useRef(false);
  const setCwd = useCallback((dir: string, reliable = false) => {
    const next = mergeCwd({ dir: currentCwdRef.current, reliable: cwdReliableRef.current }, { dir, reliable });
    if (next.dir === currentCwdRef.current && next.reliable === cwdReliableRef.current) return;
    cwdReliableRef.current = next.reliable;
    currentCwdRef.current = next.dir;
    setCurrentCwd(next.dir);
  }, []);

  const applyHome = useCallback((home: string) => {
    userHomeDirRef.current = home;
    setUserHomeDir(home);
    setCurrentCwd((prev) => prev || home);
  }, []);

  /** Updates the cwd from prompt-like text (a title, PTY output). */
  const detectCwdFromText = useCallback(
    (text: string) => {
      const detected = extractCwdFromPrompt(text, userHomeDirRef.current);
      if (detected) setCwd(detected);
    },
    [setCwd]
  );

  const handleOsc7 = useCallback(
    (data: string): boolean => {
      try {
        let p = data;
        if (p.startsWith('file://')) {
          const slashIdx = p.indexOf('/', 7);
          if (slashIdx >= 0) p = p.slice(slashIdx);
        }
        // Windows shells report `file:///C:/Users/me` — drop the slash before the drive letter.
        if (/^\/[A-Za-z]:[\\/]/.test(p)) {
          setCwd(decodeURIComponent(p.slice(1)).replace(/\//g, '\\'), true);
        } else if (p.startsWith('/')) {
          setCwd(decodeURIComponent(p), true);
        }
      } catch {
        // Safe to ignore malformed OSC 7
      }
      return true;
    },
    [setCwd]
  );

  // Local shells: the home directory is known immediately.
  useEffect(() => {
    // A WSL shell's home is a Linux path; the Windows home directory would be wrong for it.
    if (!local || wsl) return;
    window.multissh
      ?.getHomeDir?.()
      .then((h) => {
        if (h) applyHome(h);
      })
      .catch(() => {});
  }, [local, wsl, applyHome]);

  // Remote hosts: connect the storage provider on first use and share the in-flight attempt.
  const providerPromiseRef = useRef<{ id: string; promise: Promise<void> } | null>(null);
  // A failed connect (auth, network) is not retried on every hover.
  const connectFailureRef = useRef<{ id: string; at: number; error: unknown } | null>(null);
  const statCacheRef = useRef(new Map<string, { exists: boolean; at: number }>());
  const ensureProvider = useCallback((): Promise<void> => {
    const t = targetRef.current;
    const connectConfig = terminalStorageConnectConfig({ ...t, sessionId: sessionIdRef.current });
    if (!connectConfig || !window.multissh?.connectStorage) return Promise.resolve();
    if (providerPromiseRef.current?.id === connectConfig.id) return providerPromiseRef.current.promise;
    const failure = connectFailureRef.current;
    if (failure?.id === connectConfig.id && Date.now() - failure.at < CONNECT_RETRY_BACKOFF_MS) {
      return Promise.reject(failure.error);
    }
    const promise = window.multissh
      .connectStorage(connectConfig)
      .then(async () => {
        if (!t.local && !t.k8sTarget && window.multissh?.storageGetHomeDir) {
          const home = await window.multissh.storageGetHomeDir(connectConfig.id).catch(() => '');
          if (home) applyHome(home);
        }
      })
      .catch((err) => {
        providerPromiseRef.current = null;
        connectFailureRef.current = { id: connectConfig.id, at: Date.now(), error: err };
        throw err;
      });
    providerPromiseRef.current = { id: connectConfig.id, promise };
    return promise;
  }, [applyHome, sessionIdRef]);

  // A different host/pod means a different provider.
  useEffect(() => {
    providerPromiseRef.current = null;
    statCacheRef.current.clear();
    connectFailureRef.current = null;
  }, [providerId]);

  const refreshCwd = useCallback(async () => {
    const sid = sessionIdRef.current;
    // A local shell's working directory is a property of its process: that is authoritative, unlike a
    // prompt-like line in the output. (A WSL shell's process is the Windows side, so it is not used.)
    if (sid && local && !wsl && window.multissh?.terminalGetCwd) {
      try {
        const dir = await window.multissh.terminalGetCwd(sid);
        if (dir) {
          setCwd(dir, true);
          return;
        }
      } catch {
        // Fall back to the prompt below
      }
    }
    let detectedFromPrompt = false;
    const term = termRef.current;
    if (term) {
      const buf = term.buffer.active;
      const cursorLine = buf.baseY + buf.cursorY;
      for (let i = cursorLine; i >= Math.max(0, cursorLine - 8); i--) {
        const text = buf.getLine(i)?.translateToString(true).trim();
        if (!text) continue;
        const detected = extractCwdFromPrompt(text, userHomeDirRef.current);
        if (detected) {
          detectedFromPrompt = true;
          setCwd(detected);
          break;
        }
      }
    }
    if (sid && local && wsl && !detectedFromPrompt && window.multissh?.terminalGetCwd) {
      try {
        const dir = await window.multissh.terminalGetCwd(sid);
        if (dir) setCwd(dir);
      } catch {
        // Safe to ignore
      }
    }
  }, [local, wsl, termRef, sessionIdRef, setCwd]);

  /** Local shells report their cwd as soon as the session exists. */
  const onSessionStarted = useCallback(
    (sessionId: string, isDisposed: () => boolean) => {
      if (!local || !window.multissh?.terminalGetCwd) return;
      window.multissh
        .terminalGetCwd(sessionId)
        .then((dir) => {
          if (!isDisposed() && dir) setCwd(dir, !wsl);
        })
        .catch(() => {});
    },
    [local, wsl, setCwd]
  );

  const clearHoverTimers = useCallback(() => {
    hoverGenerationRef.current++;
    clearTimeout(hoverDwellTimerRef.current);
    clearTimeout(hoverLeaveTimerRef.current);
  }, []);

  const dismissCard = useCallback(() => {
    trace('card dismissed', { path: hoverCardDataRef.current?.path ?? null });
    clearHoverTimers();
    isMouseOverCardRef.current = false;
    setHoverCardData(null);
  }, [clearHoverTimers, trace]);

  useEffect(() => {
    if (!pathHoverPreview) dismissCard();
  }, [pathHoverPreview, dismissCard]);

  useEffect(() => clearHoverTimers, [clearHoverTimers]);
  // A leave still waiting out its grace time is confirmed by finishLeave, not dropped; only unmounting
  // cancels it.
  useEffect(() => () => clearTimeout(leaveGraceTimerRef.current), []);

  /** Escape closes an open card; returns whether it was consumed. */
  const dismissCardOnEscape = useCallback((): boolean => {
    if (!hoverCardDataRef.current) return false;
    dismissCard();
    return true;
  }, [dismissCard]);

  /** Handlers handed to `registerTerminalLinks`; stable because everything goes through refs. */
  // Hovering sweeps over many words; remember recent existence checks instead of stat-ing each time.
  const checkExistence = useCallback(async (fullPath: string): Promise<ExistenceCheck> => {
    const id = terminalProviderId(targetRef.current);
    // Hovering must not make this machine authenticate to whatever server a path in the output names.
    if (isNetworkUncPath(fullPath) || isNetworkUncPath(toStoragePathRef.current(fullPath))) return 'unknown';
    // Nothing to check against: behave as if the file exists.
    if (!id || !(window.multissh?.storageLookup || window.multissh?.storageStat)) return 'exists';
    const key = `${id}\0${fullPath}`;
    const cached = statCacheRef.current.get(key);
    if (cached && Date.now() - cached.at < STAT_CACHE_TTL_MS) return cached.exists ? 'exists' : 'missing';
    let exists: boolean;
    try {
      const found = await lookupPathWithin(id, toStoragePathRef.current(fullPath), LOOKUP_TIMEOUT_MS);
      if (found === 'timeout') {
        log.debug('lookup timed out, showing the card as before', { path: fullPath });
        return 'unknown';
      }
      exists = found !== null;
    } catch (err) {
      // A lost connection or a permission error says nothing about the file.
      log.debug('lookup failed, showing the card as before', { path: fullPath, error: String(err) });
      return 'unknown';
    }
    // A miss caused by a failed connection says nothing about the file.
    if (!exists && connectFailureRef.current) return 'unknown';
    if (statCacheRef.current.size > 200) statCacheRef.current.clear();
    statCacheRef.current.set(key, { exists, at: Date.now() });
    return exists ? 'exists' : 'missing';
  }, []);

  /** Connect first so the real home directory is known before prompts are parsed against it. */
  const prepareHover = useCallback(async (): Promise<void> => {
    // Also for a local terminal: the lookup and the preview go through the 'local' storage provider,
    // which is only registered once something connects it.
    await ensureProvider().catch(() => {});
    await refreshCwd();
  }, [ensureProvider, refreshCwd]);

  /**
   * A local shell that runs an interactive ssh client shows files of the remote host, but the card would
   * look them up and preview them on this machine, so it is not offered then. Only Linux can tell.
   */
  const localShellRunsSsh = useCallback(async (): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid || !targetRef.current.local || !window.multissh?.terminalHasSshClient) return false;
    try {
      return await window.multissh.terminalHasSshClient(sid);
    } catch {
      return false;
    }
  }, [sessionIdRef]);

  /** Opens the card after a short dwell, unless the text turns out not to be a real file. */
  const startHover = useCallback(
    (point: { clientX: number; clientY: number }, path: string) => {
      if (!pathHoverPreviewRef.current || isMouseOverCardRef.current) return;
      if (hoverCardDataRef.current?.path === path) {
        // Back on the path the open card is for: cancel a close that was already scheduled.
        clearTimeout(hoverLeaveTimerRef.current);
        return;
      }
      clearHoverTimers();
      const generation = hoverGenerationRef.current;
      const cancelled = () => generation !== hoverGenerationRef.current;
      const delay = hoverCardDataRef.current ? 500 : 150;
      hoverDwellTimerRef.current = setTimeout(async () => {
        if (!pathHoverPreviewRef.current || isMouseOverCardRef.current) return;
        await prepareHover();
        if (cancelled()) return;
        if (await localShellRunsSsh()) {
          log.debug('card skipped, the local shell is running ssh', { path });
          return;
        }
        if (cancelled()) return;
        const details = resolvePathDetails(path, userHomeDirRef.current, currentCwdRef.current);
        // The card reads the file (preview, certificate check) as soon as it opens, so for a path that names
        // another machine it must not open at all: that would send this user's NetNTLMv2 credentials to it.
        if (isNetworkUncPath(details.fullPath) || isNetworkUncPath(toStoragePathRef.current(details.fullPath))) {
          log.debug('card skipped, the path names a network share', { path });
          return;
        }
        const hasSlash = path.includes('/') || path.includes('\\');
        // A bare word is only previewed when the file really exists; text that merely looks like a path
        // (`Node.js`, a proposed `src/new.ts`) is dropped once the file is known not to exist.
        const gate = {
          bareToken: !hasSlash && !details.extension && !isDistinctiveFilename(details.basename),
          relative: isRelativePath(path),
          cwdReliable: cwdReliableRef.current,
        };
        const checked = needsExistenceCheck(gate);
        const existence = checked ? await checkExistence(details.fullPath) : 'unknown';
        // The pointer may have left (or moved to another path) while the lookup was in flight.
        if (cancelled()) {
          log.debug('card cancelled, the pointer left', { path, existence });
          return;
        }
        if (!allowPreview(gate, existence)) {
          log.debug('card suppressed', { path, fullPath: details.fullPath, existence, ...gate });
          return;
        }
        if (!pathHoverPreviewRef.current || isMouseOverCardRef.current) return;
        trace('card shown', { path, replaced: hoverCardDataRef.current?.path ?? null, existence, checked, ...gate });
        const p = lastPointerRef.current;
        const at = p.seen ? p : point;
        setHoverCardData({ path, x: at.clientX, y: at.clientY });
      }, delay);
    },
    [clearHoverTimers, prepareHover, checkExistence, localShellRunsSsh, trace]
  );

  // In `ctrl` mode a path under the pointer opens its card as soon as Ctrl/Cmd is pressed.
  useEffect(() => {
    if (pathHoverMode !== 'ctrl') {
      pendingHoverRef.current = null;
      return;
    }
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== 'Control' && ev.key !== 'Meta') return;
      const pending = pendingHoverRef.current;
      if (!pending) return;
      pendingHoverRef.current = null;
      startHover(pending, pending.path);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pathHoverMode, startHover]);

  /**
   * Closes the open card after `ms`, unless the pointer is over it by then. Replaces any close already
   * scheduled, and only ever closes the card that was open when it was scheduled: a timer that outlives
   * its purpose must not close a card shown later.
   */
  const scheduleClose = useCallback(
    (ms: number, reason: string) => {
      clearTimeout(hoverLeaveTimerRef.current);
      const closing = hoverCardDataRef.current?.path;
      if (closing === undefined) return;
      hoverLeaveTimerRef.current = setTimeout(() => {
        if (isMouseOverCardRef.current || hoverCardDataRef.current?.path !== closing) return;
        trace(`card closed: ${reason}`, { path: closing });
        setHoverCardData(null);
      }, ms);
    },
    [trace]
  );

  /** The pointer really left the path (no hover of the same path followed): cancel and schedule the close. */
  const finishLeave = useCallback(() => {
    if (!leaveGraceTimerRef.current) return;
    clearTimeout(leaveGraceTimerRef.current);
    leaveGraceTimerRef.current = undefined;
    if (hoverCardDataRef.current) {
      trace('leave confirmed', {
        path: hoveredPathRef.current,
        open: hoverCardDataRef.current.path,
        overCard: isMouseOverCardRef.current,
      });
    }
    hoveredPathRef.current = null;
    pendingHoverRef.current = null;
    hoverGenerationRef.current++;
    clearTimeout(hoverDwellTimerRef.current);
    if (!pathHoverPreviewRef.current || isMouseOverCardRef.current) return;
    scheduleClose(400, 'the pointer left the link');
  }, [trace, scheduleClose]);

  const createLinkHandlers = useCallback((): Pick<TerminalLinkHandlers, 'openPath' | 'hoverPath' | 'leavePath'> => {
    return {
      openPath: onOpenPathRef.current
        ? async (path) => {
            dismissCard();
            await prepareHover();
            const details = resolvePathDetails(path, userHomeDirRef.current, currentCwdRef.current);
            onOpenPathRef.current?.(toStoragePathRef.current(details.fullPath));
          }
        : undefined,
      hoverPath: (e, path) => {
        if (hoverCardDataRef.current) {
          trace('hover', {
            path,
            open: hoverCardDataRef.current.path,
            overCard: isMouseOverCardRef.current,
            repaint: Boolean(leaveGraceTimerRef.current && hoveredPathRef.current === path),
          });
        }
        if (leaveGraceTimerRef.current && hoveredPathRef.current === path) {
          // A repaint made xterm re-ask for the link under a pointer that did not move: keep the open
          // card, the pending dwell and the lookup in flight exactly as they are.
          clearTimeout(leaveGraceTimerRef.current);
          leaveGraceTimerRef.current = undefined;
          clearTimeout(hoverLeaveTimerRef.current);
          return;
        }
        finishLeave();
        hoveredPathRef.current = path;
        if (!pathHoverPreviewRef.current || isMouseOverCardRef.current) return;
        if (!hoverModifierSatisfied(pathHoverModeRef.current, e)) {
          pendingHoverRef.current = { clientX: e.clientX, clientY: e.clientY, path };
          return;
        }
        pendingHoverRef.current = null;
        startHover(e, path);
      },
      leavePath: () => {
        if (hoverCardDataRef.current) {
          trace('leave', { path: hoveredPathRef.current, open: hoverCardDataRef.current.path });
        }
        clearTimeout(leaveGraceTimerRef.current);
        leaveGraceTimerRef.current = setTimeout(finishLeave, LEAVE_GRACE_MS);
      },
    };
  }, [dismissCard, prepareHover, startHover, finishLeave, trace]);

  const openInEditor = useCallback(
    async (p: string) => {
      const id = terminalProviderId(targetRef.current);
      if (!id) return;
      try {
        await ensureProvider();
      } catch (err: any) {
        notifyRef.current(`Failed to open storage: ${err?.message || String(err)}`, 3000);
        return;
      }
      // Proceeds to the editor when the stat finds nothing.
      const stat = await statIfExists(id, toStoragePathRef.current(p));
      if (stat?.isDirectory) {
        onOpenPathRef.current?.(toStoragePathRef.current(p));
        dismissCard();
        return;
      }
      termRef.current?.blur();
      setEditingFile(p);
      dismissCard();
    },
    [ensureProvider, dismissCard, termRef]
  );

  const [dragOutPath, setDragOutPath] = useState<string | null>(null);
  const requestDragOut = useCallback(
    async (p: string) => {
      try {
        await ensureProvider();
      } catch (err: any) {
        notifyRef.current(`Failed to open storage: ${err?.message || String(err)}`, 3000);
        return;
      }
      termRef.current?.blur();
      setDragOutPath(p);
      dismissCard();
    },
    [ensureProvider, dismissCard, termRef]
  );
  const closeDragOut = useCallback(() => {
    setDragOutPath(null);
    termRef.current?.focus();
  }, [termRef]);

  const closeEditor = useCallback(() => {
    setEditingFile(null);
    termRef.current?.focus();
  }, [termRef]);

  const cardProps = {
    onMouseEnter: () => {
      trace('pointer entered the card', { path: hoverCardDataRef.current?.path ?? null });
      isMouseOverCardRef.current = true;
      clearHoverTimers();
    },
    onMouseLeave: () => {
      trace('pointer left the card', { path: hoverCardDataRef.current?.path ?? null });
      isMouseOverCardRef.current = false;
      scheduleClose(300, 'the pointer left the card');
    },
    onClose: dismissCard,
    onCopyPath: (p: string) => {
      navigator.clipboard?.writeText(p);
      notifyRef.current(`Copied path: ${p}`, 2000);
      dismissCard();
    },
    onOpenPath: onOpenPath
      ? (p: string) => {
          onOpenPathRef.current?.(toStoragePathRef.current(p));
          dismissCard();
        }
      : undefined,
    onOpenEditor: openInEditor,
    onDragOut: providerId && providerId !== 'local' ? requestDragOut : undefined,
  };

  return {
    hoverCardData: pathHoverPreview ? hoverCardData : null,
    cardProps,
    cardCwd: currentCwdRef.current || currentCwd || initialCwd || userHomeDir,
    userHomeDir,
    providerId,
    toStoragePath,
    editingFile,
    editorEntry,
    isEditorOpen: () => editingFileRef.current !== null,
    closeEditor,
    dragOutPath,
    closeDragOut,
    createLinkHandlers,
    detectCwdFromText,
    handleOsc7,
    onSessionStarted,
    dismissCardOnEscape,
  };
}
