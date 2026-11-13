import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  AppWindow,
  Check,
  Code,
  Eye,
  ExternalLink,
  FileText,
  Lock,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  RotateCw,
  Save,
  Search,
  Sparkles,
  Table,
  Terminal,
  Unlock,
  WrapText,
  X,
} from 'lucide-react';
import type { FileEntry } from '@shared/types/storage';
import type { ExternalFileStatusEvent, FileReadResult } from '@shared/types/ipc';
import { classNames, formatBytes, formatDateTime, describeIpcError } from '../../lib/format';
import { hubRequest } from '../../lib/aiHub';
import type { SourceType } from './types';
import { useEscapeToClose } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { useConfirm } from '../ConfirmDialog';
import { openEditorTab } from '../../lib/editorTabEvents';
import { CodeEditor, type CodeEditorHandle } from '../Editor/CodeEditor';
import {
  isMarkdownFile,
  isHtmlFile,
  isRasterImageFile,
  isSvgFile,
  isPdfFile,
  isCsvFile,
  isJsonFile,
  isDualModeFile,
  getPreviewLabel,
  isDirectPreviewFile,
} from './fileTypeHelpers';
import { formatJson } from '../../lib/jsonFormatter';
import { createRequestGuard, startGuarded } from '../../lib/requestGuard';
import { appendCapped } from '../../lib/tailBuffer';

const MarkdownPreview = lazy(() => import('./MarkdownPreview'));
const ImageViewer = lazy(() => import('./ImageViewer'));
const HtmlPreview = lazy(() => import('./HtmlPreview'));
const CsvTablePreview = lazy(() => import('./CsvTablePreview'));
const PdfViewer = lazy(() => import('./PdfViewer'));

interface FileEditorModalProps {
  open: boolean;
  providerId: string;
  sourceType: SourceType;
  entry: FileEntry | null;
  isTailMode?: boolean;
  initialMode?: 'source' | 'preview';
  embedded?: boolean;
  initialContentOverride?: string;
  onClose: () => void;
  onSaved?: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
}

export const FileEditorModal: React.FC<FileEditorModalProps> = ({
  open,
  providerId,
  sourceType,
  entry,
  isTailMode = false,
  initialMode,
  embedded = false,
  initialContentOverride,
  onClose,
  onSaved,
  onDirtyChange,
}) => {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [isBinary, setIsBinary] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [notUtf8, setNotUtf8] = useState(false);
  const [base64, setBase64] = useState<string | undefined>(undefined);
  const [mimeType, setMimeType] = useState<string | undefined>(undefined);
  const [loadedSize, setLoadedSize] = useState<number | undefined>(undefined);
  const [readOnly, setReadOnly] = useState(false);

  const entryName = entry?.name ?? '';
  const isDirectPreview = useMemo(() => isDirectPreviewFile(entryName), [entryName]);
  const isRasterImage = useMemo(() => isRasterImageFile(entryName), [entryName]);
  const isSvg = useMemo(() => isSvgFile(entryName), [entryName]);
  const isPdf = useMemo(() => isPdfFile(entryName), [entryName]);
  const isHtml = useMemo(() => isHtmlFile(entryName), [entryName]);
  const isCsv = useMemo(() => isCsvFile(entryName), [entryName]);
  const isMarkdown = useMemo(() => isMarkdownFile(entryName), [entryName]);
  const isJson = useMemo(() => isJsonFile(entryName), [entryName]);
  const hasDualMode = useMemo(() => isDualModeFile(entryName), [entryName]);
  const previewLabel = useMemo(() => getPreviewLabel(entryName), [entryName]);

  // Saving a partial (truncated), binary or non-UTF-8 read would overwrite the file with damaged content.
  // Direct preview files (raster images, PDFs) are never edited as plain text.
  const saveBlocked = isBinary || truncated || notUtf8 || isDirectPreview;
  const [wordWrap, setWordWrap] = useState(true);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [kbConfirm, setKbConfirm] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [viewMode, setViewMode] = useState<'source' | 'preview'>('source');

  // Tail state
  const [tailModeActive, setTailModeActive] = useState(false);
  const [tailId, setTailId] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Search state
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const [previewMatchesCount, setPreviewMatchesCount] = useState(0);
  const [editorMatchesCount, setEditorMatchesCount] = useState(0);

  // Cursor position
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });

  // External editor state
  const [externalSessionToken, setExternalSessionToken] = useState<string | null>(null);
  const [externalStatus, setExternalStatus] = useState<string | null>(null);
  const [externalLaunching, setExternalLaunching] = useState(false);

  const confirm = useConfirm();
  const dialogRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<CodeEditorHandle>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const originalEolRef = useRef<'\r\n' | '\n'>('\n');
  const initialContentUsedRef = useRef(false);
  // Only the latest load may write state; a slower earlier read must not overwrite a newer file.
  const loadSeqRef = useRef(0);
  const sessionsRef = useRef<{ tailId: string | null; externalToken: string | null }>({
    tailId: null,
    externalToken: null,
  });
  sessionsRef.current = { tailId, externalToken: externalSessionToken };

  // A tail that is still starting when the editor closes or unmounts must be stopped when its start finishes (M10).
  const [tailGuard] = useState(createRequestGuard);

  // An embedded editor tab is unmounted by its parent; release the tail/external sessions then.
  useEffect(
    () => () => {
      tailGuard.invalidate();
      const { tailId: t, externalToken } = sessionsRef.current;
      if (t) void window.multissh?.fileTailStop?.(t);
      if (externalToken) void window.multissh?.fileCloseExternal?.(externalToken);
    },
    [tailGuard]
  );

  const isDirty = useMemo(
    () => !tailModeActive && content.replace(/\r\n/g, '\n') !== originalContent.replace(/\r\n/g, '\n'),
    [tailModeActive, content, originalContent]
  );

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Read by the external-editor listener, which must not be re-subscribed on every keystroke.
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;

  // Stop tail session helper
  const stopTailSession = useCallback(async () => {
    // Also cancels a tail that is still starting (its result is then stopped on arrival), and ends its spinner.
    tailGuard.invalidate();
    setLoading(false);
    if (tailId) {
      await window.multissh?.fileTailStop?.(tailId);
      setTailId(null);
    }
    setTailModeActive(false);
  }, [tailId, tailGuard]);

  const entryPath = entry?.path;
  const isDirectory = entry?.isDirectory;

  // Load file content normally
  const loadFile = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    if (!entryPath || isDirectory) return;
    await stopTailSession();
    setLoading(true);
    setError(null);
    setSaveStatus(null);
    try {
      const res: FileReadResult = isDirectPreview
        ? await window.multissh.fileRead(providerId, entryPath, 100 * 1024 * 1024)
        : await window.multissh.fileRead(providerId, entryPath);
      if (seq !== loadSeqRef.current) return;
      if (res.isDirectory) {
        setError('Target is a directory, not a regular file.');
        setReadOnly(true);
        return;
      }
      const hasCrlf = typeof res.content === 'string' && res.content.includes('\r\n');
      originalEolRef.current = hasCrlf ? '\r\n' : '\n';
      const normalized = hasCrlf ? res.content.replace(/\r\n/g, '\n') : res.content;
      let initialVal = normalized;
      if (!initialContentUsedRef.current && initialContentOverride !== undefined) {
        initialVal = initialContentOverride;
        initialContentUsedRef.current = true;
      }
      setContent(initialVal);
      setOriginalContent(normalized);
      setIsBinary(res.isBinary);
      setTruncated(res.truncated);
      setNotUtf8(!!res.notUtf8);
      setBase64(res.base64);
      setMimeType(res.mimeType);
      setLoadedSize(res.size);
      setReadOnly(res.isBinary || res.truncated || !!res.notUtf8);
    } catch (err: any) {
      if (seq !== loadSeqRef.current) return;
      setError(describeIpcError(err, 'Failed to load file content'));
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [providerId, entryPath, isDirectory, isDirectPreview, stopTailSession, initialContentOverride]);

  // Start tail session
  const startTailSession = useCallback(async () => {
    if (!entryPath || isDirectory) return;
    setLoading(true);
    setError(null);
    setSaveStatus(null);
    setTailModeActive(true);
    setReadOnly(true);

    if (tailId) {
      await window.multissh?.fileTailStop?.(tailId);
      setTailId(null);
    }

    try {
      const started = await startGuarded(
        tailGuard,
        tailGuard.begin(),
        () => window.multissh.fileTailStart(providerId, entryPath),
        (res) => void window.multissh?.fileTailStop?.(res.tailId)
      );
      // Closed, switched to normal mode or restarted while starting: that tail has been stopped above.
      if (!started) return;
      const res = started.value;
      setTailId(res.tailId);
      setContent(res.initialContent);
      setOriginalContent(res.initialContent);
      setIsBinary(false);
      setTruncated(false);

      setTimeout(() => {
        editorRef.current?.scrollToBottom();
      }, 50);
    } catch (err: any) {
      setError(describeIpcError(err, 'Failed to start live log stream'));
      setTailModeActive(false);
    } finally {
      setLoading(false);
    }
  }, [providerId, entryPath, isDirectory, tailId, tailGuard]);

  // Open modal effect
  useEffect(() => {
    if (!open || !entry) {
      tailGuard.invalidate();
      setContent('');
      setOriginalContent('');
      originalEolRef.current = '\n';
      setBase64(undefined);
      setMimeType(undefined);
      setLoadedSize(undefined);
      setError(null);
      setSaveStatus(null);
      setExternalStatus(null);
      setTailModeActive(false);
      if (tailId) {
        void window.multissh?.fileTailStop?.(tailId);
        setTailId(null);
      }
      if (externalSessionToken) {
        void window.multissh?.fileCloseExternal?.(externalSessionToken);
        setExternalSessionToken(null);
      }
      return;
    }

    if (isDirectPreviewFile(entry.name)) {
      setViewMode('preview');
    } else if (initialMode) {
      setViewMode(initialMode);
    } else if (isDualModeFile(entry.name)) {
      setViewMode('preview');
    } else {
      setViewMode('source');
    }

    if (isTailMode) {
      void startTailSession();
    } else {
      void loadFile();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entryPath, isTailMode, providerId, initialMode]);

  // Auto-focus editor when loaded and in source mode (not binary/direct preview)
  useEffect(() => {
    if (open && !loading && viewMode === 'source' && !isDirectPreview && !isBinary) {
      const timer = setTimeout(() => {
        // Something opened in the meantime (a confirmation dialog) owns the focus now: do not take it back.
        const owner = document.activeElement?.closest('[aria-modal="true"]');
        if (owner && owner !== dialogRef.current) return;
        editorRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [open, loading, viewMode, isDirectPreview, isBinary]);

  // Tail data stream listener
  useEffect(() => {
    if (!open || !tailModeActive || !tailId || !window.multissh?.onFileTailData) return;

    const dataCleanup = window.multissh.onFileTailData((event) => {
      if (event.tailId === tailId) {
        setContent((prev) => appendCapped(prev, event.chunk));
        if (autoScroll) {
          setTimeout(() => {
            editorRef.current?.scrollToBottom();
          }, 10);
        }
      }
    });

    const errorCleanup = window.multissh.onFileTailError?.((event) => {
      if (event.tailId === tailId) {
        setError(`Tail error: ${event.error}`);
      }
    });

    return () => {
      dataCleanup();
      errorCleanup?.();
    };
  }, [open, tailModeActive, tailId, autoScroll]);

  // External editor status listener
  useEffect(() => {
    if (!open || !window.multissh?.onExternalFileStatus) return;

    const cleanup = window.multissh.onExternalFileStatus((event: ExternalFileStatusEvent) => {
      // This tab's own session, or the same file on the same storage. A bare path match is not enough: the same
      // path exists on every server (M11).
      const isOurs =
        event.sessionToken === externalSessionToken ||
        (event.providerId === providerId && event.remotePath === entry?.path);
      if (!isOurs) return;
      if (event.status === 'uploaded') {
        setSaveStatus(`Uploaded from external editor at ${event.timestamp}`);
        setExternalStatus(`Auto-uploaded from external editor at ${event.timestamp}`);
        void (async () => {
          // Reloading replaces the editor buffer: never do that over unsaved edits without asking.
          if (
            isDirtyRef.current &&
            !(await confirmRef.current({
              title: 'File changed externally',
              message: `${entry?.name ?? 'This file'} was changed by the external editor. Reload it and discard your unsaved edits?`,
              confirmLabel: 'Reload and discard',
              cancelLabel: 'Keep my edits',
            }))
          ) {
            setExternalStatus('The external editor saved a newer version. Your unsaved edits here were kept.');
            return;
          }
          void loadFile();
        })();
        onSaved?.();
      } else if (event.status === 'error') {
        setError(`External editor upload failed: ${event.error}`);
      }
    });

    return () => cleanup();
  }, [open, externalSessionToken, providerId, entry?.path, entry?.name, loadFile, onSaved]);



  // Save file content
  const handleSave = useCallback(async () => {
    if (!entry || readOnly || saving || tailModeActive || saveBlocked) return;
    setSaving(true);
    setError(null);
    try {
      const contentToSave = originalEolRef.current === '\r\n'
        ? content.replace(/\r?\n/g, '\r\n')
        : content;
      await window.multissh.fileSave(providerId, entry.path, contentToSave);
      setOriginalContent(content);
      const timestamp = formatDateTime(new Date());
      setSaveStatus(`Saved at ${timestamp}`);
      onSaved?.();
    } catch (err: any) {
      setError(describeIpcError(err, 'Failed to save file'));
    } finally {
      setSaving(false);
    }
  }, [providerId, entry, content, readOnly, saving, tailModeActive, saveBlocked, onSaved]);

  // Launch external editor
  const handleOpenExternal = useCallback(async () => {
    if (!entry) return;
    setExternalLaunching(true);
    setError(null);
    try {
      const res = await window.multissh.fileOpenExternal(providerId, entry.path);
      setExternalSessionToken(res.sessionToken);
      setExternalStatus('External editor active — auto-uploading on save');
    } catch (err: any) {
      setError(describeIpcError(err, 'Failed to open external editor'));
    } finally {
      setExternalLaunching(false);
    }
  }, [providerId, entry]);

  // Close confirmation if dirty
  const handleRequestClose = useCallback(async () => {
    if (!embedded && isDirty && !tailModeActive) {
      const discard = await confirm({
        title: 'Discard unsaved changes',
        message: `Discard your unsaved changes to ${entry?.name ?? 'this file'}?`,
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing',
      });
      if (!discard) return;
    }
    // An embedded tab releases its sessions on unmount, once the parent has actually closed it.
    if (!embedded) {
      if (tailId) {
        void window.multissh?.fileTailStop?.(tailId);
        setTailId(null);
      }
      if (externalSessionToken) {
        void window.multissh?.fileCloseExternal?.(externalSessionToken);
        setExternalSessionToken(null);
      }
      // Already released: keep the unmount cleanup from stopping them a second time.
      sessionsRef.current = { tailId: null, externalToken: null };
    }
    onClose();
  }, [embedded, isDirty, tailModeActive, tailId, externalSessionToken, onClose, confirm, entry?.name]);

  // Detach modal to a standalone tab
  const handleDetachToTab = useCallback(() => {
    if (!entry) return;
    openEditorTab({
      providerId,
      sourceType,
      entry,
      initialMode: viewMode,
      isTailMode: tailModeActive,
      initialContent: content,
    });
    if (tailId) {
      void window.multissh?.fileTailStop?.(tailId);
      setTailId(null);
    }
    if (externalSessionToken) {
      void window.multissh?.fileCloseExternal?.(externalSessionToken);
      setExternalSessionToken(null);
    }
    sessionsRef.current = { tailId: null, externalToken: null };
    onClose();
  }, [entry, providerId, sourceType, viewMode, tailModeActive, content, tailId, externalSessionToken, onClose]);

  // Global Escape key handling
  useEscapeToClose(() => {
    if (showSearch) {
      setShowSearch(false);
      return;
    }
    if (!embedded) {
      void handleRequestClose();
    }
  }, open && !embedded);
  useDialogFocus(dialogRef, open && !embedded && !!entry);

  // Format JSON helper
  const handleFormatJson = useCallback(() => {
    const res = formatJson(content, 2);
    if (res.error || res.formatted === undefined) {
      setError(`JSON Formatting failed: ${res.error || 'Unknown error'}`);
    } else {
      setContent(res.formatted);
      setError(null);
    }
  }, [content]);

  // Search logic
  const totalMatches = isMarkdown && viewMode === 'preview' ? previewMatchesCount : editorMatchesCount;
  const safeCurrentMatchIdx = totalMatches > 0 ? Math.min(currentMatchIdx, totalMatches - 1) : 0;

  const handleSearchNext = useCallback(() => {
    if (totalMatches === 0) return;
    if (isMarkdown && viewMode === 'preview') {
      setCurrentMatchIdx((prev) => (prev + 1) % totalMatches);
    } else {
      editorRef.current?.findNext();
      setCurrentMatchIdx((prev) => (prev + 1) % totalMatches);
    }
  }, [totalMatches, isMarkdown, viewMode]);

  const handleSearchPrev = useCallback(() => {
    if (totalMatches === 0) return;
    if (isMarkdown && viewMode === 'preview') {
      setCurrentMatchIdx((prev) => (prev - 1 + totalMatches) % totalMatches);
    } else {
      editorRef.current?.findPrevious();
      setCurrentMatchIdx((prev) => (prev - 1 + totalMatches) % totalMatches);
    }
  }, [totalMatches, isMarkdown, viewMode]);

  // Line count
  const lineCount = useMemo(() => {
    return Math.max(1, content.split('\n').length);
  }, [content]);

  if (!open || !entry) return null;

  const innerContent = (
    <div
      className={classNames(
        'flex flex-col bg-app-card overflow-hidden transition-all duration-150',
        embedded
          ? 'h-full w-full'
          : classNames(
              'rounded-xl border border-border-subtle shadow-2xl',
              isMaximized ? 'w-[98vw] h-[96vh] max-w-none' : 'w-[94vw] max-w-[1500px] h-[88vh]'
            )
      )}
    >
      {/* Header */}
      <div
        onDoubleClick={embedded ? undefined : () => setIsMaximized((m) => !m)}
        title={embedded ? undefined : 'Double-click header to maximize / restore'}
        className="flex items-center justify-between border-b border-divider bg-app-surface px-4 py-2.5 select-none shrink-0 cursor-default"
      >
          <div className="flex items-center gap-2.5 min-w-0">
            <FileText className="h-4 w-4 text-sky-400 shrink-0" />
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-semibold text-txt-primary truncate">
                {entry.name}
              </span>
              <span className="rounded bg-app-surface-subtle px-1.5 py-0.5 text-2xs font-mono uppercase tracking-wider text-txt-muted">
                {sourceType}
              </span>
              {isDirty ? (
                <span className="flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-2xs font-medium text-amber-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                  Unsaved changes
                </span>
              ) : (
                saveStatus && (
                  <span className="flex items-center gap-1 rounded bg-emerald-500/20 px-1.5 py-0.5 text-2xs font-medium text-emerald-400">
                    <Check className="h-3 w-3" />
                    Saved
                  </span>
                )
              )}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1">
            {/* Tail -f Toggle */}
            {!isDirectPreview && (
              <button
                type="button"
                title={tailModeActive ? 'Stop Tail -f' : 'Start Tail -f (Live log stream)'}
                onClick={() => {
                  if (tailModeActive) {
                    void stopTailSession();
                    void loadFile();
                  } else {
                    void startTailSession();
                  }
                }}
                className={classNames(
                  'flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold transition-colors',
                  tailModeActive
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 animate-pulse'
                    : 'text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
                )}
              >
                <Terminal className="h-3.5 w-3.5" />
                <span>{tailModeActive ? 'TAILING...' : 'Tail -f'}</span>
              </button>
            )}

            {/* Dual Mode Source / Preview: a segmented control so the current mode is always visible */}
            {hasDualMode && (
              <div
                role="group"
                aria-label={`${previewLabel} view`}
                className="flex items-center rounded-lg border border-border-subtle bg-app-input p-0.5 text-xs font-semibold"
              >
                {(
                  [
                    { preview: false, label: 'Source', title: 'Switch to Source (Edit)', icon: <Pencil className="h-3.5 w-3.5" /> },
                    { preview: true, label: previewLabel, title: `Switch to ${previewLabel}`, icon: isCsv ? <Table className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" /> },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    title={opt.title}
                    aria-pressed={viewMode === (opt.preview ? 'preview' : 'source')}
                    onClick={() => setViewMode(opt.preview ? 'preview' : 'source')}
                    className={classNames(
                      'flex items-center gap-1 rounded-md px-2 py-0.5 transition-colors',
                      viewMode === (opt.preview ? 'preview' : 'source')
                        ? 'bg-sky-500/20 text-sky-400'
                        : 'text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
                    )}
                  >
                    {opt.icon}
                    <span>{opt.label}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Format JSON button */}
            {isJson && viewMode === 'source' && !readOnly && !tailModeActive && (
              <button
                type="button"
                title="Format JSON (Prettify with 2-space indentation)"
                onClick={handleFormatJson}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              >
                <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                <span>Format</span>
              </button>
            )}

            {/* Search Toggle */}
            {!isDirectPreview && !(hasDualMode && viewMode === 'preview' && !isMarkdown) && (
              <button
                aria-label="Search (Ctrl+F)"
                type="button"
                title="Search (Ctrl+F)"
                onClick={() => {
                  setShowSearch((prev) => {
                    const next = !prev;
                    if (next) setTimeout(() => searchInputRef.current?.focus(), 50);
                    return next;
                  });
                }}
                className={classNames(
                  'rounded-lg p-1.5 transition-colors',
                  showSearch
                    ? 'bg-sky-500/20 text-sky-400'
                    : 'text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
                )}
              >
                <Search className="h-4 w-4" />
              </button>
            )}

            {/* Word wrap toggle */}
            {!isDirectPreview && viewMode === 'source' && (
              <button
                type="button"
                title={wordWrap ? 'Disable Word Wrap' : 'Enable Word Wrap'}
                aria-label={wordWrap ? 'Disable Word Wrap' : 'Enable Word Wrap'}
                onClick={() => setWordWrap((w) => !w)}
                className={classNames(
                  'rounded-lg p-1.5 transition-colors',
                  wordWrap
                    ? 'bg-sky-500/20 text-sky-400'
                    : 'text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
                )}
              >
                <WrapText className="h-4 w-4" />
              </button>
            )}

            {/* Read-only toggle */}
            {!isDirectPreview && viewMode === 'source' && (
              <button
                type="button"
                disabled={tailModeActive || saveBlocked}
                title={
                  saveBlocked
                    ? 'This file cannot be edited safely (truncated, binary or not UTF-8)'
                    : tailModeActive
                    ? 'Read-only during Tail -f mode'
                    : readOnly
                    ? 'Switch to Edit Mode'
                    : 'Switch to Read-Only Mode'
                }
                onClick={() => setReadOnly((r) => !r)}
                className={classNames(
                  'rounded-lg p-1.5 transition-colors disabled:opacity-40',
                  readOnly
                    ? 'text-amber-400 hover:bg-app-surface-hover'
                    : 'text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
                )}
              >
                {readOnly ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
              </button>
            )}

            {/* Reload from server */}
            <button
              aria-label="Reload from storage"
              type="button"
              title="Reload from storage"
              disabled={loading || saving}
              onClick={async () => {
                if (
                  isDirty &&
                  !(await confirm({
                    title: 'Reload from storage',
                    message: 'Reloading discards your unsaved changes. Continue?',
                    confirmLabel: 'Reload and discard',
                    cancelLabel: 'Keep editing',
                  }))
                ) {
                  return;
                }
                if (tailModeActive) {
                  void startTailSession();
                } else {
                  void loadFile();
                }
              }}
              className="rounded-lg p-1.5 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary disabled:opacity-40 transition-colors"
            >
              <RotateCw className={classNames('h-4 w-4', loading && 'animate-spin text-sky-400')} />
            </button>

            {/* AI Analyze & Knowledge Base Integration */}
            {!isBinary && content && (
              <>
                <button
                  type="button"
                  data-testid="file-editor-ask-ai-btn"
                  title="Attach this file to the assistant, for analysis, troubleshooting or a configuration review"
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent('sshs3:ai-attach', {
                        detail: {
                          label: `@file:${entry.name}`,
                          text: `File: ${entry.path} (source: ${providerId}, type: ${sourceType})\n\n${content.slice(0, 12000)}`,
                          prompt: `Review @file:${entry.name} (${entry.path}). Look for errors, risks and anything that departs from how our clusters are set up.`,
                        },
                      })
                    );
                  }}
                  className="flex items-center gap-1 rounded-lg border border-sky-500/40 bg-sky-500/15 px-2.5 py-1 text-xs font-semibold text-sky-300 hover:bg-sky-500/25 transition-colors"
                >
                  <span>✨</span>
                  <span className="hidden sm:inline">Ask the assistant</span>
                </button>
                <button
                  type="button"
                  data-testid="file-editor-save-kb-btn"
                  title="Share this file's text with the team's knowledge base. Agents will read it. Secrets it recognises are masked first."
                  onClick={() => {
                    // Shared with the team and read by agents: asked about first, never on a single click.
                    if (!kbConfirm) {
                      setKbConfirm(true);
                      setTimeout(() => setKbConfirm(false), 5000);
                      return;
                    }
                    setKbConfirm(false);
                    hubRequest({
                      action: 'kb-ingest-text',
                      title: `${entry.name} (${providerId})`,
                      text: content,
                      mask: true,
                      sourceRef: `${providerId}:${entry.path}`,
                    })
                      .then((next) => {
                        const result = next.reply?.ingest;
                        setSaveStatus(
                          result?.failed.length
                            ? `Not saved to the knowledge base: ${result.failed[0].error}`
                            : result?.duplicates.length
                              ? 'Already in the knowledge base'
                              : 'Saved to the knowledge base (recognised secrets masked)',
                        );
                      })
                      .catch((error: unknown) =>
                        setSaveStatus(`Not saved to the knowledge base: ${error instanceof Error ? error.message : 'the request failed'}`),
                      )
                      .finally(() => setTimeout(() => setSaveStatus(null), 4000));
                  }}
                  className="flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 transition-colors"
                >
                  <span>📚</span>
                  <span className="hidden sm:inline">{kbConfirm ? 'Share with the team?' : 'Add to KB'}</span>
                </button>
              </>
            )}

            {/* Open in external editor */}
            <button
              type="button"
              title={isDirectPreview ? 'Open in External App' : 'Open in External Editor (auto-uploads on save)'}
              disabled={externalLaunching || loading}
              onClick={() => void handleOpenExternal()}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-txt-primary hover:bg-app-surface-hover transition-colors"
            >
              {externalLaunching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />
              ) : (
                <ExternalLink className="h-3.5 w-3.5 text-sky-400" />
              )}
              <span className="hidden sm:inline">{isDirectPreview ? 'External App' : 'External Editor'}</span>
            </button>

            {/* Save button */}
            {!isDirectPreview && viewMode === 'source' && (
              <button
                type="button"
                title="Save changes (Ctrl+S)"
                disabled={!isDirty || readOnly || saving || loading || tailModeActive || saveBlocked}
                onClick={() => void handleSave()}
                className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1 text-xs font-semibold text-white shadow-sm hover:bg-sky-400 disabled:opacity-40 transition-colors ml-1"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                <span>Save</span>
              </button>
            )}

            {/* Detach to Tab */}
            {!embedded && (
              <button
                type="button"
                title="Detach to tab"
                aria-label="Detach to tab"
                onClick={handleDetachToTab}
                className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors ml-1"
              >
                <AppWindow className="h-4 w-4" />
              </button>
            )}

            {/* Maximize / Restore toggle */}
            {!embedded && (
              <button
                type="button"
                title={isMaximized ? 'Restore size' : 'Maximize editor'}
                aria-label={isMaximized ? 'Restore size' : 'Maximize editor'}
                onClick={() => setIsMaximized((m) => !m)}
                className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors ml-1"
              >
                {isMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
            )}

            {/* Close button */}
            <button
              type="button"
              title={embedded ? 'Close tab' : 'Close editor (Esc)'}
              aria-label={embedded ? 'Close tab' : 'Close editor'}
              onClick={() => void handleRequestClose()}
              className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors ml-1"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Path Subheader */}
        <div className="flex items-center justify-between border-b border-divider bg-app-surface/60 px-4 py-1 text-xs text-txt-muted">
          <span className="font-mono truncate">{entry.path}</span>
          <span className="shrink-0">{formatBytes(entry.size)}</span>
        </div>

        {/* Tail Mode Banner */}
        {tailModeActive && (
          <div className="flex items-center justify-between border-b border-emerald-900/60 bg-emerald-950/40 px-3 py-1.5 text-xs text-emerald-300">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-ping" />
              <span className="font-semibold">TAIL -F STREAM ACTIVE</span>
              <span className="text-xs opacity-80">
                ({autoScroll ? 'Auto-scrolling' : 'Auto-scroll paused (scroll down to bottom to resume)'})
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                void stopTailSession();
                void loadFile();
              }}
              className="rounded bg-emerald-900/60 px-2 py-0.5 text-xs font-medium text-emerald-200 hover:bg-emerald-800/80"
            >
              Stop Stream
            </button>
          </div>
        )}

        {/* Large File Warning Banner (>20MB) */}
        {!tailModeActive && entry.size > 20 * 1024 * 1024 && (
          <div className="flex items-center justify-between gap-2 border-b border-amber-900/60 bg-amber-950/40 px-3 py-1.5 text-xs text-amber-300">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
              <span>
                Large file ({formatBytes(entry.size)}). Loading the full file may freeze the app. Consider using Tail -f mode.
              </span>
            </div>
            <button
              type="button"
              onClick={() => void startTailSession()}
              className="rounded bg-amber-800/50 px-2.5 py-0.5 text-xs font-semibold text-amber-200 hover:bg-amber-700/60 shrink-0"
            >
              Switch to Tail -f
            </button>
          </div>
        )}

        {/* In-Editor Search Bar */}
        {showSearch && (
          <div className="flex items-center gap-2 border-b border-divider bg-app-surface px-3 py-1.5 select-none">
            <Search className="h-3.5 w-3.5 text-txt-muted shrink-0" />
            <input
              aria-label="Find in file"
              ref={searchInputRef}
              type="text"
              placeholder="Find in file... (Enter for next, Esc to close)"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentMatchIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (e.shiftKey) handleSearchPrev();
                  else handleSearchNext();
                }
                if (e.key === 'Escape') {
                  setShowSearch(false);
                  editorRef.current?.focus();
                }
              }}
              className="flex-1 bg-transparent text-xs text-txt-primary placeholder-txt-muted outline-none"
            />
            {searchQuery && (
              <span className="text-xs text-txt-muted px-1">
                {totalMatches > 0
                  ? `${safeCurrentMatchIdx + 1} of ${totalMatches}`
                  : 'No matches'}
              </span>
            )}
            <button
              type="button"
              onClick={handleSearchPrev}
              disabled={totalMatches === 0}
              className="rounded px-1.5 py-0.5 text-xs text-txt-secondary hover:bg-app-surface-hover disabled:opacity-40"
            >
              Prev
            </button>
            <button
              type="button"
              onClick={handleSearchNext}
              disabled={totalMatches === 0}
              className="rounded px-1.5 py-0.5 text-xs text-txt-secondary hover:bg-app-surface-hover disabled:opacity-40"
            >
              Next
            </button>
            <button
              aria-label="Close"
              title="Close"
              type="button"
              onClick={() => {
                setShowSearch(false);
                editorRef.current?.focus();
              }}
              className="rounded p-1 text-txt-muted hover:text-txt-primary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div role="alert" className="flex items-center justify-between gap-2 border-b border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs text-red-300">
            <div className="flex items-center gap-1.5 truncate">
              <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
              <span className="truncate">{error}</span>
            </div>
            <button
              aria-label="Close"
              title="Close"
              type="button"
              onClick={() => setError(null)}
              className="rounded p-0.5 hover:bg-red-900/40 text-red-300"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* Binary warning banner */}
        {isBinary && !isRasterImage && !isPdf && (
          <div className="flex items-center justify-between gap-2 border-b border-amber-900/60 bg-amber-950/40 px-3 py-1.5 text-xs text-amber-300">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
              <span>
                Binary file detected. Plain text view might not render properly.
              </span>
            </div>
            <button
              type="button"
              onClick={() => void handleOpenExternal()}
              className="rounded bg-amber-800/40 px-2 py-0.5 text-xs font-semibold text-amber-200 hover:bg-amber-700/50"
            >
              Open in External App
            </button>
          </div>
        )}

        {/* Truncated warning banner */}
        {truncated && !tailModeActive && (
          <div className="flex items-center gap-1.5 border-b border-amber-900/60 bg-amber-950/40 px-3 py-1.5 text-xs text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
            <span>
              {isDirectPreview
                ? 'File exceeds 100 MB. Displaying the first 100 MB.'
                : 'File exceeds 5 MB. Displaying the first 5 MB (read-only, so the file cannot be overwritten with a partial copy).'}
            </span>
          </div>
        )}

        {notUtf8 && !isBinary && (
          <div className="flex items-center gap-1.5 border-b border-amber-900/60 bg-amber-950/40 px-3 py-1.5 text-xs text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
            <span>File is not valid UTF-8. Opened read-only to avoid corrupting it on save.</span>
          </div>
        )}

        {/* External editor status banner */}
        {externalStatus && (
          <div className="flex items-center justify-between gap-2 border-b border-sky-900/60 bg-sky-950/40 px-3 py-1.5 text-xs text-sky-300">
            <div className="flex items-center gap-1.5">
              <Code className="h-4 w-4 shrink-0 text-sky-400" />
              <span>{externalStatus}</span>
            </div>
            <button
              aria-label="Close"
              title="Close"
              type="button"
              onClick={() => setExternalStatus(null)}
              className="rounded p-0.5 hover:bg-sky-900/40 text-sky-300"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* Editor Body */}
        <div className="relative flex-1 min-h-0 flex bg-app-card overflow-hidden">
          {loading ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-txt-muted text-sm">
              <Loader2 className="h-6 w-6 animate-spin text-sky-400" />
              <span>{tailModeActive ? 'Starting Tail -f stream...' : 'Loading file...'}</span>
            </div>
          ) : isPdf ? (
            <Suspense
              fallback={
                <div className="flex-1 flex items-center justify-center gap-2 text-txt-muted text-sm">
                  <Loader2 className="h-5 w-5 animate-spin text-sky-400" />
                  <span>Loading PDF...</span>
                </div>
              }
            >
              <PdfViewer
                fileName={entry.name}
                base64={base64}
                onOpenExternal={handleOpenExternal}
              />
            </Suspense>
          ) : isRasterImage ? (
            <Suspense
              fallback={
                <div className="flex-1 flex items-center justify-center gap-2 text-txt-muted text-sm">
                  <Loader2 className="h-5 w-5 animate-spin text-sky-400" />
                  <span>Loading image...</span>
                </div>
              }
            >
              <ImageViewer
                fileName={entry.name}
                fileSize={loadedSize ?? entry.size}
                mimeType={mimeType || 'image/png'}
                base64={base64}
              />
            </Suspense>
          ) : viewMode === 'preview' && isSvg ? (
            <Suspense
              fallback={
                <div className="flex-1 flex items-center justify-center gap-2 text-txt-muted text-sm">
                  <Loader2 className="h-5 w-5 animate-spin text-sky-400" />
                  <span>Loading SVG...</span>
                </div>
              }
            >
              <ImageViewer
                fileName={entry.name}
                fileSize={loadedSize ?? entry.size}
                mimeType="image/svg+xml"
                svgContent={content}
              />
            </Suspense>
          ) : viewMode === 'preview' && isHtml ? (
            <Suspense
              fallback={
                <div className="flex-1 flex items-center justify-center gap-2 text-txt-muted text-sm">
                  <Loader2 className="h-5 w-5 animate-spin text-sky-400" />
                  <span>Loading HTML preview...</span>
                </div>
              }
            >
              <HtmlPreview
                fileName={entry.name}
                htmlContent={content}
                onOpenInBrowser={handleOpenExternal}
              />
            </Suspense>
          ) : viewMode === 'preview' && isCsv ? (
            <Suspense
              fallback={
                <div className="flex-1 flex items-center justify-center gap-2 text-txt-muted text-sm">
                  <Loader2 className="h-5 w-5 animate-spin text-sky-400" />
                  <span>Loading CSV table...</span>
                </div>
              }
            >
              <CsvTablePreview
                fileName={entry.name}
                csvContent={content}
              />
            </Suspense>
          ) : viewMode === 'preview' && isMarkdown ? (
            <div className="flex-1 h-full overflow-auto p-6">
              <div className="markdown-preview max-w-3xl mx-auto prose prose-sm sm:prose-base prose-headings:font-semibold prose-a:text-sky-400 prose-pre:bg-app-surface prose-pre:border prose-pre:border-border-subtle prose-code:text-sky-300">
                <Suspense
                  fallback={
                    <div className="flex items-center gap-2 text-txt-muted text-sm">
                      <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
                      <span>Loading preview...</span>
                    </div>
                  }
                >
                  <MarkdownPreview
                    content={content}
                    searchQuery={showSearch ? searchQuery : ''}
                    currentMatchIdx={safeCurrentMatchIdx}
                    onMatchesCountChange={setPreviewMatchesCount}
                  />
                </Suspense>
              </div>
            </div>
          ) : (
            <CodeEditor
              ref={editorRef}
              value={content}
              fileName={entry.name}
              readOnly={readOnly || saving || tailModeActive}
              wordWrap={wordWrap}
              searchQuery={showSearch ? searchQuery : ''}
              ariaLabel={`Contents of ${entry.name}`}
              onChange={setContent}
              onSave={() => void handleSave()}
              onSearchRequested={() => {
                setShowSearch(true);
                setTimeout(() => searchInputRef.current?.focus(), 50);
              }}
              onCursorChange={setCursorPos}
              onMatchesCountChange={(count) => {
                if (!isMarkdown || viewMode !== 'preview') {
                  setEditorMatchesCount(count);
                }
              }}
              onScrollNearBottomChange={(nearBottom) => {
                if (tailModeActive) {
                  setAutoScroll(nearBottom);
                }
              }}
            />
          )}
        </div>

        {/* Status Bar */}
        {!isRasterImage && (
          <div className="flex items-center justify-between border-t border-divider bg-app-surface px-3 py-1.5 text-xs text-txt-muted select-none shrink-0 font-mono">
            <div className="flex items-center gap-3">
              {viewMode === 'source' && !isDirectPreview ? (
                <>
                  <span>
                    Ln {cursorPos.line}, Col {cursorPos.col}
                  </span>
                  <span>{lineCount} lines</span>
                  <span>{content.length} chars</span>
                </>
              ) : isPdf ? (
                <span>PDF Document</span>
              ) : isCsv && viewMode === 'preview' ? (
                <span>Table View</span>
              ) : (
                <>
                  <span>Preview Mode</span>
                  <span>{lineCount} lines</span>
                </>
              )}
            </div>

            <div className="flex items-center gap-3">
              {saveStatus && (
                <span className="text-txt-secondary">{saveStatus}</span>
              )}
              <span
                className={classNames(
                  'font-sans uppercase text-2xs font-semibold px-1.5 py-0.5 rounded',
                  tailModeActive
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : isPdf
                    ? 'bg-rose-500/20 text-rose-400'
                    : hasDualMode && viewMode === 'preview'
                    ? 'bg-sky-500/20 text-sky-400'
                    : readOnly
                    ? 'bg-amber-500/20 text-amber-400'
                    : 'bg-sky-500/20 text-sky-400'
                )}
              >
                {tailModeActive
                  ? 'Tail -f'
                  : isPdf
                  ? 'PDF'
                  : hasDualMode && viewMode === 'preview'
                  ? previewLabel
                  : readOnly
                  ? 'Read-Only'
                  : 'Edit'}
              </span>
              <span>{isPdf ? 'Binary' : 'UTF-8'}</span>
            </div>
          </div>
        )}
    </div>
  );

  if (embedded) {
    return (
      <div
        role="region"
        aria-label={`Editing ${entry.name}`}
        className="flex flex-col h-full w-full bg-app-card overflow-hidden"
      >
        {innerContent}
      </div>
    );
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Editing ${entry.name}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-3 sm:p-5 animate-in fade-in duration-150"
    >
      {innerContent}
    </div>
  );
};

export default FileEditorModal;
