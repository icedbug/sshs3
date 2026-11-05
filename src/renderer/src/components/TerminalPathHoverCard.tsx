import React, { useMemo, useState, useEffect, useLayoutEffect, useRef } from 'react';
import {
  File,
  FileCode,
  FileCog,
  FileImage,
  FileArchive,
  FileText,
  Folder,
  ShieldCheck,
  Copy,
  Check,
  ExternalLink,
  Edit3,
  Eye,
  GripVertical,
  X,
} from 'lucide-react';
import { isNetworkUncPath, isSensitiveFilePath, resolvePathDetails, type FileTypeCategory } from '../lib/terminalPathPreview';
import { classNames, formatBytes } from '../lib/format';
import { chooseHoverCardSide, hoverCardRoom, placeHoverCard } from '../lib/hoverCardPlacement';
import { createRendererLogger } from '../lib/log';
import { useCertificatePreview } from '../lib/useCertificatePreview';
import { CertificatePreview } from './CertificatePreview';

export interface TerminalPathHoverCardProps {
  path: string;
  x: number;
  y: number;
  userHome?: string;
  currentCwd?: string;
  providerId?: string;
  /** Maps the path as the shell shows it to the one the storage provider opens (WSL). */
  toStoragePath?: (p: string) => string;
  onClose: () => void;
  onCopyPath: (path: string) => void;
  onOpenPath?: (path: string) => void;
  onOpenEditor?: (path: string) => void;
  /** Remote terminals: asks to copy the item here so it can be dragged into another app. */
  onDragOut?: (path: string) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

const CATEGORY_ICONS: Record<FileTypeCategory, React.ComponentType<{ className?: string }>> = {
  code: FileCode,
  config: FileCog,
  image: FileImage,
  archive: FileArchive,
  markdown: FileText,
  document: FileText,
  directory: Folder,
  unknown: File,
};

const CATEGORY_STYLES: Record<
  FileTypeCategory,
  {
    iconBg: string;
    iconText: string;
    badgeBg: string;
    badgeText: string;
    badgeRing: string;
  }
> = {
  code: {
    iconBg: 'bg-sky-500/10 border-sky-500/20',
    iconText: 'text-sky-400',
    badgeBg: 'bg-sky-500/15',
    badgeText: 'text-sky-300',
    badgeRing: 'ring-sky-500/30',
  },
  config: {
    iconBg: 'bg-amber-500/10 border-amber-500/20',
    iconText: 'text-amber-400',
    badgeBg: 'bg-amber-500/15',
    badgeText: 'text-amber-300',
    badgeRing: 'ring-amber-500/30',
  },
  image: {
    iconBg: 'bg-purple-500/10 border-purple-500/20',
    iconText: 'text-purple-400',
    badgeBg: 'bg-purple-500/15',
    badgeText: 'text-purple-300',
    badgeRing: 'ring-purple-500/30',
  },
  markdown: {
    iconBg: 'bg-emerald-500/10 border-emerald-500/20',
    iconText: 'text-emerald-400',
    badgeBg: 'bg-emerald-500/15',
    badgeText: 'text-emerald-300',
    badgeRing: 'ring-emerald-500/30',
  },
  archive: {
    iconBg: 'bg-orange-500/10 border-orange-500/20',
    iconText: 'text-orange-400',
    badgeBg: 'bg-orange-500/15',
    badgeText: 'text-orange-300',
    badgeRing: 'ring-orange-500/30',
  },
  document: {
    iconBg: 'bg-blue-500/10 border-blue-500/20',
    iconText: 'text-blue-400',
    badgeBg: 'bg-blue-500/15',
    badgeText: 'text-blue-300',
    badgeRing: 'ring-blue-500/30',
  },
  directory: {
    iconBg: 'bg-yellow-500/10 border-yellow-500/20',
    iconText: 'text-yellow-400',
    badgeBg: 'bg-yellow-500/15',
    badgeText: 'text-yellow-300',
    badgeRing: 'ring-yellow-500/30',
  },
  unknown: {
    iconBg: 'bg-slate-500/10 border-slate-500/20',
    iconText: 'text-slate-400',
    badgeBg: 'bg-slate-500/15',
    badgeText: 'text-slate-300',
    badgeRing: 'ring-slate-500/30',
  },
};

const log = createRendererLogger('path-card');
const identityPath = (p: string): string => p;
/** The tallest the card gets: header, actions and an image or text preview. */
const MAX_CARD_HEIGHT = 280;
/** However little room there is, the card keeps at least this much (then it may overlap the pointer). */
const MIN_CARD_HEIGHT = 120;

export const TerminalPathHoverCard: React.FC<TerminalPathHoverCardProps> = ({
  path,
  x,
  y,
  userHome,
  currentCwd,
  providerId,
  toStoragePath = identityPath,
  onClose,
  onCopyPath,
  onOpenPath,
  onOpenEditor,
  onDragOut,
  onMouseEnter,
  onMouseLeave,
}) => {
  const details = useMemo(() => resolvePathDetails(path, userHome, currentCwd), [path, userHome, currentCwd]);
  const cardRef = useRef<HTMLDivElement>(null);
  const [measuredHeight, setMeasuredHeight] = useState(0);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const measure = () => setMeasuredHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [isDirOverride, setIsDirOverride] = useState<boolean | null>(details.isDir ? true : null);

  useEffect(() => {
    setIsDirOverride(details.isDir ? true : null);
  }, [details.fullPath, details.isDir]);

  const isEffectiveDir = isDirOverride ?? details.isDir;
  const effectiveCategory: FileTypeCategory = isEffectiveDir ? 'directory' : details.category;
  // Parsed in the main process (no openssl needed on the host); undefined unless the file holds a certificate.
  // Defence in depth (the hover hook never opens the card for these): no file access for a network share.
  const networkPath = isNetworkUncPath(details.fullPath) || isNetworkUncPath(toStoragePath(details.fullPath));
  const { result: certificates, pending: certificatePending } = useCertificatePreview(
    providerId,
    toStoragePath(details.fullPath),
    !isEffectiveDir && !networkPath
  );
  const effectiveLabel = isEffectiveDir ? 'Directory' : certificates ? 'Certificate' : details.label;
  const Icon = certificates ? ShieldCheck : CATEGORY_ICONS[effectiveCategory] || File;
  const catStyle = CATEGORY_STYLES[effectiveCategory] || CATEGORY_STYLES.unknown;

  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(copiedTimerRef.current), []);
  const [snippet, setSnippet] = useState<{
    lines?: string[];
    isImage?: boolean;
    imageSrc?: string;
    lineCount?: number;
    size?: number;
  } | null>(null);

  // Live Quick Peek: asynchronously load first few lines or image thumbnail if provider is available
  useEffect(() => {
    let cancelled = false;
    setSnippet(null);
    // A certificate-named file is looked at as a certificate first; it is read as text only if it is not one.
    if (certificatePending || certificates) return undefined;
    if (!providerId || networkPath || isEffectiveDir || !window.multissh?.fileRead || isSensitiveFilePath(details.fullPath)) {
      return undefined;
    }

    const startedAt = performance.now();
    const timer = setTimeout(() => {
      const maxBytes = details.category === 'image' ? 5 * 1024 * 1024 : 2048;
      window.multissh
        ?.fileRead(providerId, toStoragePath(details.fullPath), maxBytes)
        .then((res) => {
          if (cancelled || !res) return;
          log.debug('preview loaded', {
            path: details.fullPath,
            provider: providerId,
            kind: res.isDirectory ? 'directory' : res.isBinary ? 'binary' : 'text',
            truncated: Boolean(res.truncated),
            ms: Math.round(performance.now() - startedAt),
          });
          if (res.isDirectory) {
            setIsDirOverride(true);
            setSnippet(null);
            return;
          }
          if (details.category === 'image' && res.base64 && !res.truncated) {
            setSnippet({
              isImage: true,
              imageSrc: `data:${res.mimeType || 'image/png'};base64,${res.base64}`,
              size: res.size,
            });
          } else if (!res.isBinary && res.content) {
            const rawLines = res.content.split('\n');
            const cleanLines = rawLines.slice(0, 3);
            setSnippet({
              lines: cleanLines,
              lineCount: rawLines.length,
              size: res.size,
            });
          }
        })
        .catch((err) => {
          log.debug('preview failed', {
            path: details.fullPath,
            provider: providerId,
            error: String(err),
            ms: Math.round(performance.now() - startedAt),
          });
          if (!cancelled) setSnippet(null);
        });
    }, 40);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [providerId, details.fullPath, isEffectiveDir, networkPath, details.category, toStoragePath, certificatePending, certificates]);

  // Local files are dragged out of the card in place; remote ones first ask to copy them here.
  const isLocalProvider = providerId === 'local';
  const canDragOut = Boolean(providerId) && !networkPath && (isLocalProvider ? Boolean(window.multissh?.dragOutStart) : Boolean(onDragOut));
  // Dragging the file icon, the preview or the handle all start the same flow; a remote drag opens the confirmation instead.
  const handleDragStart = (e: React.DragEvent) => {
    e.preventDefault();
    if (isLocalProvider) void window.multissh?.dragOutStart?.([toStoragePath(details.fullPath)]).catch(() => {});
    else onDragOut?.(details.fullPath);
  };
  const dragSource = canDragOut ? { draggable: true, onDragStart: handleDragStart } : {};
  const dragCursor = canDragOut ? 'cursor-grab active:cursor-grabbing' : '';

  const handleCopy = () => {
    onCopyPath(details.fullPath);
    setCopied(true);
    clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
  };

  // Viewport boundary collision avoidance. The real height is measured (the preview and rows vary); the
  // estimate only covers the first paint and environments without layout.
  const cardWidth = 380;
  const estimatedHeight = snippet ? (snippet.isImage ? 230 : 200) : 135;
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
  // The side is fixed from the room for a card with a preview, so it does not jump to the other side of
  // the pointer when the preview loads and the card grows.
  const side = useMemo(
    () => chooseHoverCardSide({ y, reserveHeight: MAX_CARD_HEIGHT, viewportHeight }),
    [y, viewportHeight]
  );
  // The card never grows past the room on its side of the pointer (the content scrolls instead), so it
  // is not pushed back over the pointer in a short window.
  const maxHeight = Math.max(hoverCardRoom({ y, side, viewportHeight }), MIN_CARD_HEIGHT);
  const { left, top } = placeHoverCard({
    x,
    y,
    width: cardWidth,
    height: measuredHeight || estimatedHeight,
    viewportWidth,
    viewportHeight,
    side,
  });

  // No invisible "bridge" towards the pointer: the card opens 12px right of and 16px below it, so a strip
  // reaching back to the link would lie under the pointer, which then counts as being inside the card the
  // moment it opens (and stops the terminal reporting the link). Crossing the gap is covered by the close delay.
  return (
    <div
      ref={cardRef}
      data-testid="terminal-path-hover-card"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ left: `${Math.round(left)}px`, top: `${Math.round(top)}px`, maxHeight: `${maxHeight}px` }}
      className="fixed z-50 flex flex-col w-[380px] overflow-y-auto rounded-xl border border-border-subtle bg-app-surface/95 p-3.5 shadow-2xl backdrop-blur-xl ring-1 ring-white/10 animate-fade-in text-txt-primary select-none pointer-events-auto"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2.5 border-b border-divider pb-2.5">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div
            {...dragSource}
            data-testid="path-hover-drag-icon"
            className={classNames(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-md border shadow-xs transition-colors',
              dragCursor,
              catStyle.iconBg
            )}
          >
            <Icon className={classNames('h-5 w-5', catStyle.iconText)} />
          </div>

          <div className="flex flex-col min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                className="truncate font-bold text-sm text-txt-primary leading-[18px]"
                title={details.basename}
              >
                {details.basename}
              </span>
              <span
                className={classNames(
                  'inline-flex h-4 items-center rounded px-2 pt-0.5 text-[9px] leading-none font-mono font-bold tracking-wider uppercase ring-1 ring-inset shrink-0',
                  catStyle.badgeBg,
                  catStyle.badgeText,
                  catStyle.badgeRing
                )}
              >
                {effectiveLabel}
              </span>
            </div>

            <span
              className="truncate text-[11px] font-mono text-txt-muted mt-0.5 leading-4 select-all block"
              title={details.fullPath}
            >
              {details.fullPath}
            </span>
          </div>
        </div>

        <button
          type="button"
          aria-label="Close hover preview"
          onClick={onClose}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors -mr-1 -mt-1"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {certificates && <CertificatePreview result={certificates} />}

      {/* Quick Peek Preview (Snippet or Image Thumbnail) */}
      {snippet && !certificates && (
        <div
          {...dragSource}
          data-testid="path-hover-drag-preview"
          className={classNames(
            'my-2.5 overflow-hidden rounded-xl border border-border-subtle bg-app-surface-subtle p-2 text-xs font-mono',
            canDragOut ? 'select-none' : 'select-text',
            dragCursor
          )}
        >
          {snippet.isImage && snippet.imageSrc ? (
            <div className="flex flex-col items-center justify-center py-1">
              <img
                src={snippet.imageSrc}
                alt={details.basename}
                className="max-h-24 max-w-full rounded-lg object-contain border border-white/10 shadow-sm"
              />
              {snippet.size !== undefined && (
                <span className="mt-1 text-[10px] text-txt-muted">
                  {formatBytes(snippet.size)}
                </span>
              )}
            </div>
          ) : snippet.lines && snippet.lines.length > 0 ? (
            <div className="space-y-0.5">
              {snippet.lines.map((line, idx) => (
                <div key={idx} className="flex gap-2 text-[11px] leading-relaxed">
                  <span className="w-5 shrink-0 text-right text-txt-muted/40 select-none">
                    {idx + 1}
                  </span>
                  <span className="text-txt-primary truncate">{line || ' '}</span>
                </div>
              ))}
              <div className="mt-1.5 flex items-center justify-between border-t border-divider pt-1 text-[10px] text-txt-muted">
                <span>{snippet.lineCount} lines</span>
                {snippet.size !== undefined && <span>{formatBytes(snippet.size)}</span>}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 pt-2.5 text-xs font-medium">
        {onOpenEditor && !isEffectiveDir && (
          <button
            type="button"
            onClick={() => onOpenEditor(details.fullPath)}
            className="flex flex-1 h-8 items-center justify-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/15 px-2.5 text-sky-300 hover:bg-sky-500/25 hover:border-sky-500/50 hover:text-sky-200 transition-all font-semibold shadow-xs active:scale-[0.98] whitespace-nowrap"
          >
            {details.category === 'image' || details.extension === 'pdf' ? (
              <Eye className="h-3.5 w-3.5 text-sky-400 shrink-0" />
            ) : (
              <Edit3 className="h-3.5 w-3.5 text-sky-400 shrink-0" />
            )}
            <span>{details.category === 'image' || details.extension === 'pdf' ? 'View' : 'Edit'}</span>
          </button>
        )}

        {onOpenPath && (
          <button
            type="button"
            onClick={() => onOpenPath(details.fullPath)}
            className={classNames(
              'flex flex-1 h-8 items-center justify-center gap-1.5 rounded-lg border border-divider bg-app-card px-2.5 text-txt-secondary hover:text-txt-primary hover:bg-app-surface-hover hover:border-border-subtle transition-all active:scale-[0.98] whitespace-nowrap',
              isEffectiveDir
                ? 'bg-amber-500/15 border-amber-500/30 text-amber-300 hover:bg-amber-500/25 font-semibold'
                : 'font-medium'
            )}
          >
            <ExternalLink className="h-3.5 w-3.5 text-amber-400 shrink-0" />
            <span>{isEffectiveDir ? 'Browse' : 'Reveal'}</span>
          </button>
        )}

        {canDragOut && isLocalProvider && (
          <div
            {...dragSource}
            data-testid="path-hover-drag-handle"
            title={`Drag this ${isEffectiveDir ? 'folder' : 'file'} into another app`}
            className="flex h-8 w-8 shrink-0 cursor-grab items-center justify-center rounded-lg border border-divider bg-app-card text-txt-muted transition-all hover:border-border-subtle hover:bg-app-surface-hover hover:text-txt-primary active:cursor-grabbing"
          >
            <GripVertical className="h-4 w-4" />
          </div>
        )}
        {canDragOut && !isLocalProvider && (
          <button
            type="button"
            aria-label="Drag out of sshs3"
            {...dragSource}
            onClick={() => onDragOut?.(details.fullPath)}
            data-testid="path-hover-drag-handle"
            title="Drag out of sshs3 (asks before copying)…"
            className="flex h-8 w-8 shrink-0 cursor-grab items-center justify-center rounded-lg border border-divider bg-app-card text-txt-muted transition-all hover:border-border-subtle hover:bg-app-surface-hover hover:text-txt-primary"
          >
            <GripVertical className="h-4 w-4" />
          </button>
        )}

        <button
          type="button"
          onClick={handleCopy}
          className="flex flex-1 h-8 items-center justify-center gap-1.5 rounded-lg border border-divider bg-app-card px-2.5 text-txt-secondary hover:text-txt-primary hover:bg-app-surface-hover hover:border-border-subtle transition-all font-medium active:scale-[0.98] whitespace-nowrap"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
              <span className="text-emerald-400 font-semibold">Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5 text-txt-muted shrink-0" />
              <span>Copy Path</span>
            </>
          )}
        </button>
      </div>

      {/* Footer shortcut helper */}
      <div className="mt-2.5 flex items-center justify-between border-t border-divider/60 pt-2 text-[10px] text-txt-muted select-none">
        <span className="flex items-center gap-1 opacity-70">
          <kbd className="inline-flex h-4 items-center rounded border border-border-subtle bg-app-card px-1 pt-px font-mono text-[9px] leading-none text-txt-secondary">
            Ctrl
          </kbd>
          <span>+ click to {isEffectiveDir ? 'browse' : 'reveal'}</span>
        </span>
        <span className="opacity-50 font-mono">Esc to dismiss</span>
      </div>
    </div>
  );
};
