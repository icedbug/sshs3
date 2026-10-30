import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
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

const MarkdownPreview = lazy(() => import('./MarkdownPreview'));

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);

function isMarkdownFile(name: string): boolean {
  const idx = name.lastIndexOf('.');
  if (idx === -1) return false;
  return MARKDOWN_EXTENSIONS.has(name.slice(idx + 1).toLowerCase());
}

interface FileEditorModalProps {
  open: boolean;
  providerId: string;
  sourceType: SourceType;
  entry: FileEntry | null;
  isTailMode?: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export const FileEditorModal: React.FC<FileEditorModalProps> = ({
  open,
  providerId,
  sourceType,
  entry,
  isTailMode = false,
  onClose,
  onSaved,
}) => {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [isBinary, setIsBinary] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [notUtf8, setNotUtf8] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  // Saving a partial (truncated), binary or non-UTF-8 read would overwrite the file with damaged content.
  const saveBlocked = isBinary || truncated || notUtf8;
  const [wordWrap, setWordWrap] = useState(true);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const [markdownPreview, setMarkdownPreview] = useState(false);

  const isMarkdown = useMemo(() => (entry ? isMarkdownFile(entry.name) : false), [entry]);

  // Tail state
  const [tailModeActive, setTailModeActive] = useState(false);
  const [tailId, setTailId] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Search state
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const [previewMatchesCount, setPreviewMatchesCount] = useState(0);

  // Cursor position
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });

  // External editor state
  const [externalSessionToken, setExternalSessionToken] = useState<string | null>(null);
  const [externalStatus, setExternalStatus] = useState<string | null>(null);
  const [externalLaunching, setExternalLaunching] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const isDirty = useMemo(
    () => !tailModeActive && content !== originalContent,
    [tailModeActive, content, originalContent]
  );

  // Stop tail session helper
  const stopTailSession = useCallback(async () => {
    if (tailId) {
      await window.multissh?.fileTailStop?.(tailId);
      setTailId(null);
    }
    setTailModeActive(false);
  }, [tailId]);

  // Load file content normally
  const loadFile = useCallback(async () => {
    if (!entry || entry.isDirectory) return;
    await stopTailSession();
    setLoading(true);
    setError(null);
    setSaveStatus(null);
    try {
      const res: FileReadResult = await window.multissh.fileRead(providerId, entry.path);
      setContent(res.content);
      setOriginalContent(res.content);
      setIsBinary(res.isBinary);
      setTruncated(res.truncated);
      setNotUtf8(!!res.notUtf8);
      setReadOnly(res.isBinary || res.truncated || !!res.notUtf8);
    } catch (err: any) {
      setError(describeIpcError(err, 'Failed to load file content'));
    } finally {
      setLoading(false);
    }
  }, [providerId, entry, stopTailSession]);

  // Start tail session
  const startTailSession = useCallback(async () => {
    if (!entry || entry.isDirectory) return;
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
      const res = await window.multissh.fileTailStart(providerId, entry.path);
      setTailId(res.tailId);
      setContent(res.initialContent);
      setOriginalContent(res.initialContent);
      setIsBinary(false);
      setTruncated(false);

      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
        }
      }, 50);
    } catch (err: any) {
      setError(describeIpcError(err, 'Failed to start live log stream'));
      setTailModeActive(false);
    } finally {
      setLoading(false);
    }
  }, [providerId, entry, tailId]);

  // Open modal effect
  useEffect(() => {
    if (!open || !entry) {
      setContent('');
      setOriginalContent('');
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

    setMarkdownPreview(isMarkdownFile(entry.name));

    if (isTailMode) {
      void startTailSession();
    } else {
      void loadFile();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry, isTailMode, providerId]);

  // Tail data stream listener
  useEffect(() => {
    if (!open || !tailModeActive || !tailId || !window.multissh?.onFileTailData) return;

    const dataCleanup = window.multissh.onFileTailData((event) => {
      if (event.tailId === tailId) {
        setContent((prev) => prev + event.chunk);
        if (autoScroll) {
          setTimeout(() => {
            if (textareaRef.current) {
              textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
            }
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
      if (event.sessionToken === externalSessionToken || event.remotePath === entry?.path) {
        if (event.status === 'uploaded') {
          setSaveStatus(`Uploaded from external editor at ${event.timestamp}`);
          setExternalStatus(`Auto-uploaded from external editor at ${event.timestamp}`);
          void loadFile();
          onSaved?.();
        } else if (event.status === 'error') {
          setError(`External editor upload failed: ${event.error}`);
        }
      }
    });

    return () => cleanup();
  }, [open, externalSessionToken, entry?.path, loadFile, onSaved]);

  // Sync scroll & auto-scroll tracking
  const handleScroll = useCallback(() => {
    if (textareaRef.current) {
      if (lineNumbersRef.current) {
        lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
      }
      if (backdropRef.current) {
        backdropRef.current.scrollTop = textareaRef.current.scrollTop;
        backdropRef.current.scrollLeft = textareaRef.current.scrollLeft;
      }
      if (tailModeActive) {
        const el = textareaRef.current;
        const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        setAutoScroll(isNearBottom);
      }
    }
  }, [tailModeActive]);

  // Track cursor line & col
  const updateCursorPosition = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const pos = el.selectionStart;
    const textBefore = el.value.slice(0, pos);
    const lines = textBefore.split('\n');
    const line = lines.length;
    const col = lines[lines.length - 1].length + 1;
    setCursorPos({ line, col });
  }, []);

  // Save file content
  const handleSave = useCallback(async () => {
    if (!entry || readOnly || saving || tailModeActive || saveBlocked) return;
    setSaving(true);
    setError(null);
    try {
      await window.multissh.fileSave(providerId, entry.path, content);
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
  const handleRequestClose = useCallback(() => {
    if (isDirty && !tailModeActive) {
      if (!window.confirm('You have unsaved changes. Discard them?')) {
        return;
      }
    }
    if (tailId) {
      void window.multissh?.fileTailStop?.(tailId);
      setTailId(null);
    }
    if (externalSessionToken) {
      void window.multissh?.fileCloseExternal?.(externalSessionToken);
      setExternalSessionToken(null);
    }
    onClose();
  }, [isDirty, tailModeActive, tailId, externalSessionToken, onClose]);

  // Global Escape key handling
  useEscapeToClose(() => {
    if (showSearch) {
      setShowSearch(false);
      return;
    }
    handleRequestClose();
  }, open);

  // Textarea key handling
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSave();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
        return;
      }

      if (e.key === 'Tab' && !readOnly) {
        e.preventDefault();
        const el = textareaRef.current;
        if (!el) return;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const insertText = '  ';
        const newText = el.value.slice(0, start) + insertText + el.value.slice(end);
        setContent(newText);
        setTimeout(() => {
          el.selectionStart = el.selectionEnd = start + insertText.length;
          updateCursorPosition();
        }, 0);
      }
    },
    [handleSave, readOnly, updateCursorPosition]
  );

  // Search logic
  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const query = searchQuery.toLowerCase();
    const matches: number[] = [];
    let pos = 0;
    const lowerContent = content.toLowerCase();
    while ((pos = lowerContent.indexOf(query, pos)) !== -1) {
      matches.push(pos);
      pos += query.length;
    }
    return matches;
  }, [content, searchQuery]);

  const totalMatches = isMarkdown && markdownPreview ? previewMatchesCount : searchMatches.length;
  const safeCurrentMatchIdx = totalMatches > 0 ? Math.min(currentMatchIdx, totalMatches - 1) : 0;

  const handleSearchNext = useCallback(() => {
    if (totalMatches === 0) return;
    setCurrentMatchIdx((prev) => (prev + 1) % totalMatches);
  }, [totalMatches]);

  const handleSearchPrev = useCallback(() => {
    if (totalMatches === 0) return;
    setCurrentMatchIdx((prev) => (prev - 1 + totalMatches) % totalMatches);
  }, [totalMatches]);

  // Scroll to current match in Edit mode
  const scrollToCurrentEditMatch = useCallback(() => {
    if (searchMatches.length === 0 || safeCurrentMatchIdx >= searchMatches.length) return;
    const matchPos = searchMatches[safeCurrentMatchIdx];
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Update selection range
    textarea.setSelectionRange(matchPos, matchPos + searchQuery.length);
    updateCursorPosition();

    // Scroll textarea to the match
    const activeMark = backdropRef.current?.querySelector('[data-active="true"]') as HTMLElement | null;
    if (activeMark) {
      const targetTop = Math.max(0, activeMark.offsetTop - textarea.clientHeight / 2 + activeMark.clientHeight / 2);
      textarea.scrollTop = targetTop;
      if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = targetTop;
      if (backdropRef.current) backdropRef.current.scrollTop = targetTop;

      if (!wordWrap) {
        const targetLeft = Math.max(0, activeMark.offsetLeft - textarea.clientWidth / 2);
        textarea.scrollLeft = targetLeft;
        if (backdropRef.current) backdropRef.current.scrollLeft = targetLeft;
      }
    } else {
      const linesBefore = content.slice(0, matchPos).split('\n');
      const lineIndex = linesBefore.length - 1;
      const lineHeight = 20; // 20px per line
      const targetTop = Math.max(0, lineIndex * lineHeight - textarea.clientHeight / 2 + lineHeight / 2);
      textarea.scrollTop = targetTop;
      if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = targetTop;
      if (backdropRef.current) backdropRef.current.scrollTop = targetTop;
    }
  }, [searchMatches, safeCurrentMatchIdx, searchQuery.length, updateCursorPosition, wordWrap, content]);

  useEffect(() => {
    if (!showSearch || !searchQuery.trim() || searchMatches.length === 0) return;
    if (isMarkdown && markdownPreview) return;

    scrollToCurrentEditMatch();
  }, [showSearch, searchQuery, safeCurrentMatchIdx, searchMatches, isMarkdown, markdownPreview, scrollToCurrentEditMatch]);

  // Render search highlight backdrop in Edit mode
  const renderBackdrop = useCallback(() => {
    if (!showSearch || !searchQuery.trim() || searchMatches.length === 0) return null;

    const elements: React.ReactNode[] = [];
    let lastIdx = 0;
    const matchLen = searchQuery.length;
    const maxMatches = Math.min(searchMatches.length, 1000);

    for (let i = 0; i < maxMatches; i++) {
      const matchPos = searchMatches[i];
      if (matchPos > lastIdx) {
        elements.push(
          <span key={`text-${lastIdx}`} className="text-transparent">
            {content.slice(lastIdx, matchPos)}
          </span>
        );
      }
      const isCurrent = i === safeCurrentMatchIdx;
      elements.push(
        <mark
          key={`mark-${matchPos}`}
          data-match-idx={i}
          data-active={isCurrent ? 'true' : undefined}
          className={classNames(
            'text-transparent rounded-xs',
            isCurrent ? 'bg-sky-500/60 ring-1 ring-sky-400' : 'bg-amber-400/35'
          )}
        >
          {content.slice(matchPos, matchPos + matchLen)}
        </mark>
      );
      lastIdx = matchPos + matchLen;
    }

    if (lastIdx < content.length) {
      elements.push(
        <span key="text-tail" className="text-transparent">
          {content.slice(lastIdx)}
        </span>
      );
    }

    return elements;
  }, [showSearch, searchQuery, searchMatches, content, safeCurrentMatchIdx]);

  // Line count
  const lineCount = useMemo(() => {
    return Math.max(1, content.split('\n').length);
  }, [content]);

  if (!open || !entry) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Editing ${entry.name}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-3 sm:p-5 animate-in fade-in duration-150"
    >
      <div
        className={classNames(
          'flex flex-col rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden transition-all duration-150',
          isMaximized ? 'w-[98vw] h-[96vh] max-w-none' : 'w-[94vw] max-w-[1500px] h-[88vh]'
        )}
      >
        {/* Header */}
        <div
          onDoubleClick={() => setIsMaximized((m) => !m)}
          title="Double-click header to maximize / restore"
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

            {/* Markdown Source / Preview: a segmented control so the current mode is always visible */}
            {isMarkdown && (
              <div
                role="group"
                aria-label="Markdown view"
                className="flex items-center rounded-lg border border-border-subtle bg-app-input p-0.5 text-xs font-semibold"
              >
                {(
                  [
                    { preview: false, label: 'Source', title: 'Switch to Source (Edit)', icon: <Pencil className="h-3.5 w-3.5" /> },
                    { preview: true, label: 'Preview', title: 'Switch to Preview', icon: <Eye className="h-3.5 w-3.5" /> },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    title={opt.title}
                    aria-pressed={markdownPreview === opt.preview}
                    onClick={() => setMarkdownPreview(opt.preview)}
                    className={classNames(
                      'flex items-center gap-1 rounded-md px-2 py-0.5 transition-colors',
                      markdownPreview === opt.preview
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

            {/* Search Toggle */}
            <button
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

            {/* Word wrap toggle */}
            <button
              type="button"
              title={wordWrap ? 'Disable Word Wrap' : 'Enable Word Wrap'}
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

            {/* Read-only toggle */}
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

            {/* Reload from server */}
            <button
              type="button"
              title="Reload from storage"
              disabled={loading || saving}
              onClick={() => {
                if (isDirty && !window.confirm('Discard unsaved changes and reload?')) return;
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
                  title="Bifoga filinnehållet till AI Hub för analys, felsökning eller konfigurationsgranskning"
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent('sshs3:ai-attach', {
                        detail: {
                          label: `@file:${entry.name}`,
                          text: `File: ${entry.path} (source: ${providerId}, type: ${sourceType})\n\n${content.slice(0, 12000)}`,
                          prompt: `Granska och analysera @file:${entry.name} (${entry.path}). Kontrollera om det finns några fel, risker eller förbättringar mot våra klusterstandarder.`,
                        },
                      })
                    );
                  }}
                  className="flex items-center gap-1 rounded-lg border border-sky-500/40 bg-sky-500/15 px-2.5 py-1 text-xs font-semibold text-sky-300 hover:bg-sky-500/25 transition-colors"
                >
                  <span>✨</span>
                  <span className="hidden sm:inline">Fråga AI</span>
                </button>
                <button
                  type="button"
                  data-testid="file-editor-save-kb-btn"
                  title="Indexera och spara denna fil som ett dokument/runbook i Workspace Knowledge Base (KB)"
                  onClick={() => {
                    void hubRequest({
                      action: 'kb-save',
                      doc: {
                        title: `${entry.name} (${providerId})`,
                        sourceType: sourceType === 's3' ? 's3' : 'upload',
                        sourceRef: `${providerId}:${entry.path}`,
                        tags: [sourceType, entry.name.split('.').pop() || 'config'],
                        content: content.slice(0, 24000),
                        shared: true,
                      },
                    }).then(() => {
                      setSaveStatus('Sparad i Knowledge Base (KB)!');
                      setTimeout(() => setSaveStatus(null), 2500);
                    });
                  }}
                  className="flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 transition-colors"
                >
                  <span>📚</span>
                  <span className="hidden sm:inline">Spara i KB</span>
                </button>
              </>
            )}

            {/* Open in external editor */}
            <button
              type="button"
              title="Open in External Editor (auto-uploads on save)"
              disabled={externalLaunching || loading}
              onClick={() => void handleOpenExternal()}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-txt-primary hover:bg-app-surface-hover transition-colors"
            >
              {externalLaunching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />
              ) : (
                <ExternalLink className="h-3.5 w-3.5 text-sky-400" />
              )}
              <span className="hidden sm:inline">External Editor</span>
            </button>

            {/* Save button */}
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

            {/* Maximize / Restore toggle */}
            <button
              type="button"
              title={isMaximized ? 'Restore size' : 'Maximize editor'}
              onClick={() => setIsMaximized((m) => !m)}
              className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors ml-1"
            >
              {isMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>

            {/* Close button */}
            <button
              type="button"
              title="Close editor (Esc)"
              onClick={handleRequestClose}
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
                  textareaRef.current?.focus();
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
            <button aria-label="Close" title="Close"
              type="button"
              onClick={() => {
                setShowSearch(false);
                textareaRef.current?.focus();
              }}
              className="rounded p-1 text-txt-muted hover:text-txt-primary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="flex items-center justify-between gap-2 border-b border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs text-red-300">
            <div className="flex items-center gap-1.5 truncate">
              <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
              <span className="truncate">{error}</span>
            </div>
            <button aria-label="Close" title="Close"
              type="button"
              onClick={() => setError(null)}
              className="rounded p-0.5 hover:bg-red-900/40 text-red-300"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* Binary warning banner */}
        {isBinary && (
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
            <span>File exceeds 5 MB. Displaying the first 5 MB (read-only, so the file cannot be overwritten with a partial copy).</span>
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
            <button aria-label="Close" title="Close"
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
          ) : isMarkdown && markdownPreview ? (
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
            <>
              {/* Line Numbers Gutter */}
              <div
                ref={lineNumbersRef}
                aria-hidden="true"
                className="w-12 sm:w-14 shrink-0 select-none bg-app-surface border-r border-divider text-right font-mono text-xs leading-5 text-txt-muted py-2.5 pr-2.5 overflow-hidden"
              >
                {Array.from({ length: lineCount }, (_, i) => (
                  <div key={i + 1} className="h-5 leading-5">
                    {i + 1}
                  </div>
                ))}
              </div>

              {/* Text Area Container */}
              <div className="relative flex-1 h-full min-w-0 overflow-hidden">
                {/* Search Highlight Backdrop */}
                {showSearch && searchQuery.trim() && searchMatches.length > 0 && (
                  <div
                    ref={backdropRef}
                    aria-hidden="true"
                    className={classNames(
                      'absolute inset-0 pointer-events-none p-2.5 font-mono text-xs leading-5 overflow-hidden select-none z-0',
                      wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
                    )}
                  >
                    {renderBackdrop()}
                  </div>
                )}

                {/* Text Area */}
                <textarea
                  aria-label={`Contents of ${entry.name}`}
                  ref={textareaRef}
                  value={content}
                  readOnly={readOnly || saving || tailModeActive}
                  spellCheck={false}
                  wrap={wordWrap ? 'soft' : 'off'}
                  onChange={(e) => {
                    setContent(e.target.value);
                    updateCursorPosition();
                  }}
                  onScroll={handleScroll}
                  onClick={updateCursorPosition}
                  onKeyUp={updateCursorPosition}
                  onSelect={updateCursorPosition}
                  onKeyDown={handleKeyDown}
                  className={classNames(
                    'relative z-10 flex-1 h-full w-full bg-transparent p-2.5 font-mono text-xs leading-5 text-txt-primary outline-none resize-none overflow-auto border-none select-text',
                    (readOnly || tailModeActive) && 'opacity-90'
                  )}
                  placeholder="Empty file"
                />
              </div>
            </>
          )}
        </div>

        {/* Status Bar */}
        <div className="flex items-center justify-between border-t border-divider bg-app-surface px-3 py-1.5 text-xs text-txt-muted select-none shrink-0 font-mono">
          <div className="flex items-center gap-3">
            <span>
              Ln {cursorPos.line}, Col {cursorPos.col}
            </span>
            <span>{lineCount} lines</span>
            <span>{content.length} chars</span>
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
                  : readOnly
                  ? 'bg-amber-500/20 text-amber-400'
                  : 'bg-sky-500/20 text-sky-400'
              )}
            >
              {tailModeActive ? 'Tail -f' : isMarkdown && markdownPreview ? 'Preview' : readOnly ? 'Read-Only' : 'Edit'}
            </span>
            <span>UTF-8</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FileEditorModal;
