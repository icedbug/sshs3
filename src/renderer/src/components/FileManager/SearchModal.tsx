import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  Maximize2,
  Minimize2,
  Search,
  X,
} from 'lucide-react';
import type { SearchMatch, SearchMode, SearchSourceType } from '@shared/types/search';
import { classNames, describeIpcError } from '../../lib/format';
import { SearchResultsList } from './SearchResultsList';
import { SearchPreviewPane } from './SearchPreviewPane';
import { useEscapeToClose } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { createRequestGuard, startGuarded } from '../../lib/requestGuard';

interface SearchWarning {
  path?: string;
  message: string;
}

interface SearchModalProps {
  open: boolean;
  providerId: string;
  sourceType: SearchSourceType;
  rootPath: string;
  onClose: () => void;
  /** Navigates the owning pane to a match's containing folder and closes the search modal. */
  onJumpToFile?: (path: string) => void;
}

export const SearchModal: React.FC<SearchModalProps> = ({
  open,
  providerId,
  sourceType,
  rootPath,
  onClose,
  onJumpToFile,
}) => {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('literal');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [includeGlobs, setIncludeGlobs] = useState('');
  const [excludeGlobs, setExcludeGlobs] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [scannedCount, setScannedCount] = useState(0);
  const [currentPath, setCurrentPath] = useState<string | undefined>(undefined);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<SearchWarning[]>([]);
  const [warningsExpanded, setWarningsExpanded] = useState(false);
  const [warningsDismissed, setWarningsDismissed] = useState(false);
  const [copiedWarnings, setCopiedWarnings] = useState(false);
  const [selectedMatch, setSelectedMatch] = useState<SearchMatch | null>(null);

  const [isMaximized, setIsMaximized] = useState(false);
  const [leftWidth, setLeftWidth] = useState<number>(400);
  const [isDragging, setIsDragging] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  const activeSearchIdRef = useRef<string | null>(null);
  const queryInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => queryInputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    const unsubResult = window.multissh.onSearchResult((event) => {
      if (event.searchId !== activeSearchIdRef.current) return;
      setMatches((prev) => [...prev, ...event.matches]);
    });
    const unsubProgress = window.multissh.onSearchProgress((event) => {
      if (event.searchId !== activeSearchIdRef.current) return;
      setScannedCount(event.scannedCount);
      setCurrentPath(event.currentPath);
    });
    const unsubError = window.multissh.onSearchError((event) => {
      if (event.searchId !== activeSearchIdRef.current) return;
      if (event.fatal) {
        setError(event.message);
      } else {
        setWarnings((prev) => [...prev, { path: event.path, message: event.message }]);
      }
    });
    const unsubDone = window.multissh.onSearchDone((event) => {
      if (event.searchId !== activeSearchIdRef.current) return;
      setSearching(false);
      setTruncated(event.truncated);
      setScannedCount(event.scannedCount);
      setCurrentPath(undefined);
      activeSearchIdRef.current = null;
    });
    return () => {
      unsubResult();
      unsubProgress();
      unsubError();
      unsubDone();
    };
  }, []);

  // A start that resolves after Cancel, close or unmount must stop its search instead of orphaning it (M10).
  const [startGuard] = useState(createRequestGuard);

  const stopActiveSearch = useCallback(() => {
    startGuard.invalidate();
    if (activeSearchIdRef.current) {
      void window.multissh.searchCancel(activeSearchIdRef.current);
      activeSearchIdRef.current = null;
    }
  }, [startGuard]);

  useEffect(() => {
    if (!open) stopActiveSearch();
  }, [open, stopActiveSearch]);

  useEffect(() => () => stopActiveSearch(), [stopActiveSearch]);

  const handleSubmit = useCallback(
    async () => {
      if (!query.trim() || searching) return;

      stopActiveSearch();
      setMatches([]);
      setError(null);
      setWarnings([]);
      setWarningsExpanded(false);
      setWarningsDismissed(false);
      setCopiedWarnings(false);
      setTruncated(false);
      setScannedCount(0);
      setCurrentPath(undefined);
      setSelectedMatch(null);
      setSearching(true);
      setHasSearched(true);

      try {
        const started = await startGuarded(
          startGuard,
          startGuard.begin(),
          () =>
            window.multissh.searchStart({
              providerId,
              sourceType,
              rootPath,
              query,
              mode,
              caseSensitive,
              includeGlobs: includeGlobs
                .split(',')
                .map((g) => g.trim())
                .filter(Boolean),
              excludeGlobs: excludeGlobs
                .split(',')
                .map((g) => g.trim())
                .filter(Boolean),
            }),
          ({ searchId }) => void window.multissh.searchCancel(searchId)
        );
        if (!started) return; // cancelled, closed or restarted while starting: whoever did that owns the state now
        activeSearchIdRef.current = started.value.searchId;
      } catch (err) {
        setSearching(false);
        setError(describeIpcError(err, 'Failed to start search'));
      }
    },
    [query, searching, providerId, sourceType, rootPath, mode, caseSensitive, includeGlobs, excludeGlobs, stopActiveSearch, startGuard]
  );

  const handleCancel = useCallback(() => {
    stopActiveSearch();
    setSearching(false);
  }, [stopActiveSearch]);

  const handleClose = useCallback(() => {
    stopActiveSearch();
    onClose();
  }, [stopActiveSearch, onClose]);

  const handleJumpToFile = useCallback(
    (match: SearchMatch) => {
      onJumpToFile?.(match.path);
      handleClose();
    },
    [onJumpToFile, handleClose]
  );

  const handleCopyWarnings = useCallback(() => {
    if (warnings.length === 0) return;
    const text = warnings
      .map((w) => (w.path ? `${w.path}: ${w.message}` : w.message))
      .join('\n');
    void navigator.clipboard.writeText(text);
    setCopiedWarnings(true);
    setTimeout(() => setCopiedWarnings(false), 2000);
  }, [warnings]);

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const newWidth = e.clientX - rect.left;
      const minWidth = 260;
      const maxWidth = Math.max(minWidth, rect.width - 320);
      setLeftWidth(Math.min(maxWidth, Math.max(minWidth, newWidth)));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  useEscapeToClose(handleClose, open);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  if (!open) return null;

  return (
    <div
      className={classNames(
        'fixed inset-0 z-50 flex items-center justify-center bg-black/65 animate-in fade-in duration-150',
        isMaximized ? 'p-0' : 'p-2 sm:p-4'
      )}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search in Files"
        className={classNames(
          'flex flex-col overflow-hidden bg-app-card shadow-2xl transition-[width,height,border-radius] duration-150',
          isMaximized
            ? 'h-full w-full rounded-none border-0'
            : 'h-[90vh] w-[95vw] max-w-[1600px] rounded-xl border border-border-subtle'
        )}
      >
        <div
          onDoubleClick={() => setIsMaximized((prev) => !prev)}
          className="flex items-center justify-between border-b border-divider bg-app-surface px-4 py-3 select-none cursor-default"
        >
          <div className="flex min-w-0 items-center gap-2">
            <Search className="h-4 w-4 shrink-0 text-sky-400" />
            <h2 className="truncate text-sm font-semibold text-txt-primary" title={`Search in Files — ${rootPath}`}>
              Search in Files — <span className="font-mono font-normal text-txt-secondary">{rootPath}</span>
            </h2>
          </div>
          <div className="flex items-center gap-1 shrink-0 ml-2">
            <button
              type="button"
              onClick={() => setIsMaximized((prev) => !prev)}
              title={isMaximized ? 'Restore size' : 'Maximize'}
              className="rounded-lg p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
            >
              {isMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              aria-label="Close (Esc)"
              type="button"
              onClick={handleClose}
              title="Close (Esc)"
              className="rounded-lg p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="space-y-2 border-b border-divider bg-app-surface px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <input
                aria-label="Search query"
                ref={queryInputRef}
                data-autofocus
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleSubmit();
                  }
                }}
                placeholder="Search inside files..."
                className="w-full rounded-lg border border-border-subtle bg-app-input pl-3 pr-8 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
              />
              {query.length > 0 && (
                <button
                  aria-label="Clear search query"
                  type="button"
                  onClick={() => {
                    setQuery('');
                    queryInputRef.current?.focus();
                  }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-txt-muted hover:text-txt-primary transition-colors"
                  title="Clear search query"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {/* Always a plain button, never type="submit": swapping a button's type at
                the same screen position inside a <form> mid-click let Chromium treat a
                single click on "Cancel" as also submitting the form once React
                re-rendered it into the "Search" button — restarting the very search
                that click had just cancelled. Handling Enter and the click explicitly,
                with no <form> at all, removes that whole class of native-submit race. */}
            {searching ? (
              <button
                type="button"
                onClick={handleCancel}
                className="rounded-lg border border-border-subtle px-3.5 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              >
                Cancel
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!query.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50 shadow-sm transition-colors"
              >
                {searching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Search
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-txt-secondary">
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="radio"
                checked={mode === 'literal'}
                onChange={() => setMode('literal')}
                className="text-sky-500 focus:ring-0"
              />
              Literal
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="radio"
                checked={mode === 'regex'}
                onChange={() => setMode('regex')}
                className="text-sky-500 focus:ring-0"
              />
              Regex
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
                className="rounded border-border-subtle text-sky-500 focus:ring-0"
              />
              Case sensitive
            </label>
            <button
              type="button"
              onClick={() => setShowAdvanced((prev) => !prev)}
              className="ml-auto text-txt-muted hover:text-txt-primary transition-colors"
            >
              {showAdvanced ? 'Hide advanced' : 'Advanced...'}
            </button>
          </div>
          {showAdvanced && (
            <div className="flex flex-wrap items-center gap-3 text-xs text-txt-secondary">
              <label className="flex items-center gap-1.5">
                Include:
                <input
                  type="text"
                  value={includeGlobs}
                  onChange={(e) => setIncludeGlobs(e.target.value)}
                  placeholder="*.log, *.csv"
                  className="w-40 rounded-lg border border-border-subtle bg-app-input px-2 py-1 text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
                />
              </label>
              <label className="flex items-center gap-1.5">
                Exclude:
                <input
                  type="text"
                  value={excludeGlobs}
                  onChange={(e) => setExcludeGlobs(e.target.value)}
                  placeholder="*.min.js"
                  className="w-40 rounded-lg border border-border-subtle bg-app-input px-2 py-1 text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
                />
              </label>
            </div>
          )}
        </div>

        {error && (
          <div role="alert" className="border-b border-red-900/60 bg-red-950/40 px-4 py-1.5 text-xs text-red-300">{error}</div>
        )}

        <div ref={splitContainerRef} className="relative flex min-h-0 flex-1 overflow-hidden">
          {isDragging && <div className="fixed inset-0 z-50 cursor-col-resize select-none" />}
          <div
            style={{ width: `${leftWidth}px` }}
            className="flex shrink-0 flex-col border-r border-divider overflow-hidden"
          >
            <div className="flex items-center justify-between border-b border-divider bg-app-surface-subtle px-3 py-1.5 text-xs text-txt-muted">
              <span className="truncate" title={currentPath}>
                {matches.length} match{matches.length === 1 ? '' : 'es'} · {scannedCount} scanned
                {searching && currentPath ? ` · ${currentPath}` : ''}
              </span>
              {searching && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-sky-400" />}
            </div>
            {truncated && (
              <div className="border-b border-amber-900/60 bg-amber-950/30 px-3 py-1 text-xs text-amber-300">
                Result limit reached — narrow your search to see more.
              </div>
            )}
            {warnings.length > 0 && !warningsDismissed && (
              <div className="border-b border-amber-900/60 bg-amber-950/25 text-xs text-amber-300">
                <div className="flex items-center justify-between px-3 py-1.5 bg-amber-950/35">
                  <button
                    type="button"
                    onClick={() => setWarningsExpanded((prev) => !prev)}
                    className="flex min-w-0 items-center gap-1.5 hover:text-amber-200 transition-colors text-left"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                    <span className="font-medium text-xs truncate">
                      {warnings.length} warning{warnings.length === 1 ? '' : 's'} (skipped files/objects)
                    </span>
                    {warningsExpanded ? (
                      <ChevronUp className="h-3.5 w-3.5 shrink-0 text-amber-400/80" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-amber-400/80" />
                    )}
                  </button>
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <button
                      type="button"
                      onClick={handleCopyWarnings}
                      title="Copy all warnings to clipboard"
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-amber-300/90 hover:bg-amber-900/40 hover:text-amber-100 transition-colors"
                    >
                      {copiedWarnings ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      <span>{copiedWarnings ? 'Copied' : 'Copy'}</span>
                    </button>
                    <button
                      aria-label="Dismiss warning bar"
                      type="button"
                      onClick={() => setWarningsDismissed(true)}
                      title="Dismiss warning bar"
                      className="rounded p-0.5 text-amber-400/70 hover:bg-amber-900/40 hover:text-amber-200 transition-colors"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {warningsExpanded && (
                  <div className="border-t border-amber-900/40 bg-amber-950/40 px-3 py-2">
                    <ul className="max-h-48 overflow-y-auto space-y-1.5 pr-1 select-text">
                      {warnings.map((w, i) => (
                        <li
                          key={i}
                          title={w.path ? `${w.path}: ${w.message}` : w.message}
                          className="break-all whitespace-pre-wrap rounded border border-amber-900/40 bg-app-card/60 px-2 py-1 font-mono text-xs leading-relaxed text-amber-200/90"
                        >
                          {w.path ? <span className="font-semibold text-amber-300">{w.path}: </span> : null}
                          <span>{w.message}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1.5 text-2xs text-amber-400/60 italic">
                      Skipped entries are typically system-protected files or unreadable sockets/pipes (e.g. /tmp/systemd-private-*).
                    </p>
                  </div>
                )}
              </div>
            )}
            <SearchResultsList
              matches={matches}
              selectedMatchId={selectedMatch?.id ?? null}
              onSelect={setSelectedMatch}
              onJumpToFile={onJumpToFile ? handleJumpToFile : undefined}
              hasSearched={hasSearched}
            />
          </div>

          {/* Draggable Divider */}
          <div
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize panels (Double-click to reset)"
            onMouseDown={handleDividerMouseDown}
            onDoubleClick={() => setLeftWidth(400)}
            className={classNames(
              'group relative z-10 flex w-2 shrink-0 cursor-col-resize items-center justify-center transition-colors select-none -ml-1 hover:bg-sky-500/20 active:bg-sky-500/30',
              isDragging && 'bg-sky-500/30'
            )}
          >
            <div
              className={classNames(
                'h-8 w-1 rounded-full transition-colors',
                isDragging ? 'bg-sky-400' : 'bg-border-subtle group-hover:bg-sky-400'
              )}
            />
          </div>

          <SearchPreviewPane
            providerId={providerId}
            match={selectedMatch}
            onJumpToFile={onJumpToFile ? handleJumpToFile : undefined}
          />
        </div>
      </div>
    </div>
  );
};

export default SearchModal;
