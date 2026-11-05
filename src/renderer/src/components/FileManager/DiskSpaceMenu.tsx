import React, { useCallback, useEffect, useRef, useState } from 'react';
import { HardDrive } from 'lucide-react';
import type { SpaceInfo, VolumeInfo } from '@shared/types/storage';
import { classNames, formatBytes } from '../../lib/format';
import { useEscapeToClose } from '../../lib/useModalDismiss';

interface DiskSpaceMenuProps {
  providerId: string;
  /** Only the local provider can enumerate volumes; SFTP just reports the current path's filesystem. */
  canListVolumes: boolean;
  currentPath: string;
  onNavigate: (path: string) => void;
  /** Bumped by the parent (e.g. a click on the "C:" breadcrumb) to open the drive list. */
  openRequest?: number;
}

function usedPct(space: SpaceInfo): number {
  return space.totalBytes > 0 ? Math.min(100, Math.round(((space.totalBytes - space.freeBytes) / space.totalBytes) * 100)) : 0;
}

const FillBar: React.FC<{ pct: number }> = ({ pct }) => (
  <div className="h-1.5 w-full overflow-hidden rounded-full bg-app-input">
    <div
      className={classNames('h-full rounded-full', pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-sky-500')}
      style={{ width: `${pct}%` }}
    />
  </div>
);

/** Free-space indicator for the current path; for local panes also a drive/volume picker with fill levels. */
export const DiskSpaceMenu: React.FC<DiskSpaceMenuProps> = ({ providerId, canListVolumes, currentPath, onNavigate, openRequest }) => {
  const [space, setSpace] = useState<SpaceInfo | undefined>();
  const [open, setOpen] = useState(false);
  const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
  const [focusIdx, setFocusIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(window.multissh.storageGetSpace?.(providerId, currentPath))
      .then((s) => {
        if (!cancelled) setSpace(s);
      })
      .catch(() => {
        if (!cancelled) setSpace(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [providerId, currentPath]);

  useEffect(() => {
    if (openRequest && canListVolumes) setOpen(true);
  }, [openRequest, canListVolumes]);

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);
  useEscapeToClose(close, open);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.resolve(window.multissh.storageListVolumes?.(providerId) ?? [])
      .then((v) => {
        if (cancelled) return;
        setVolumes(v);
        // Land on the volume that contains the current path (longest matching root).
        const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
        let best = 0;
        let bestLen = -1;
        v.forEach((vol, i) => {
          const root = norm(vol.path);
          if (norm(currentPath).startsWith(root) && root.length > bestLen) {
            best = i;
            bestLen = root.length;
          }
        });
        setFocusIdx(best);
      })
      .catch(() => {
        if (!cancelled) setVolumes([]);
      });
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => {
      cancelled = true;
      window.removeEventListener('mousedown', onDown);
    };
  }, [open, providerId, currentPath]);

  useEffect(() => {
    if (open) itemRefs.current[focusIdx]?.focus();
  }, [open, focusIdx, volumes]);

  if (!space && !canListVolumes) return null;

  const pct = space ? usedPct(space) : undefined;
  const title = space
    ? `${formatBytes(space.freeBytes)} free of ${formatBytes(space.totalBytes)} (${pct}% used)`
    : 'Drives and volumes';

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        title={canListVolumes ? `${title} — click for drives` : title}
        aria-label={canListVolumes ? 'Drives and volumes' : 'Disk space'}
        aria-haspopup={canListVolumes ? 'menu' : undefined}
        aria-expanded={canListVolumes ? open : undefined}
        onClick={() => canListVolumes && setOpen((o) => !o)}
        className={classNames(
          'flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[11px] text-txt-secondary transition-colors',
          canListVolumes ? 'hover:bg-app-surface-hover hover:text-txt-primary' : 'cursor-default'
        )}
      >
        <HardDrive className="h-4 w-4" />
        {space && pct !== undefined && (
          <>
            <span className="w-10"><FillBar pct={pct} /></span>
            <span className="tabular-nums">{formatBytes(space.freeBytes)} free</span>
          </>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 mt-1 w-72 rounded-md border border-border-subtle bg-app-card py-1 text-xs shadow-2xl"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              e.stopPropagation();
              const n = volumes.length;
              if (n) setFocusIdx((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
            }
          }}
        >
          {volumes.length === 0 && <div className="px-3 py-2 text-txt-muted">No drives found</div>}
          {volumes.map((vol, i) => {
            const p = usedPct(vol);
            return (
              <button
                key={vol.path}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onNavigate(vol.path);
                }}
                className="flex w-full flex-col gap-1 px-3 py-1.5 text-left text-txt-primary hover:bg-app-surface-hover focus:bg-app-surface-hover focus:outline-none"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{vol.label}</span>
                  <span className="shrink-0 tabular-nums text-txt-muted">
                    {formatBytes(vol.freeBytes)} free of {formatBytes(vol.totalBytes)}
                  </span>
                </span>
                <FillBar pct={p} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default DiskSpaceMenu;
