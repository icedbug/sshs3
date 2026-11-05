import React from 'react';
import { ChevronRight, Layers, Lock, Terminal, Zap } from 'lucide-react';
import type { PaletteRow } from '../lib/globalSearchRows';
import { Highlighted } from './ui/Highlighted';
import { TagChips } from './ui/TagChips';

interface GlobalSearchResultRowProps {
  id: string;
  row: PaletteRow;
  active: boolean;
  onHover: () => void;
  /** `sftp` is true for a Shift+click. */
  onActivate: (sftp: boolean) => void;
}

const BADGE = 'inline-flex w-12 shrink-0 items-center justify-center rounded px-1 py-0.5 text-[10px] font-semibold';

/** One option of the palette's listbox. */
export const GlobalSearchResultRow: React.FC<GlobalSearchResultRowProps> = ({ id, row, active, onHover, onActivate }) => {
  let badge: React.ReactNode;
  let title: React.ReactNode;
  let subtitle: string;
  let trailing: React.ReactNode = null;

  if (row.type === 'adhoc') {
    const { username, host, port } = row.target;
    badge = (
      <span className={`${BADGE} bg-amber-500/15 text-amber-400`}>
        <Zap className="h-3 w-3" aria-hidden="true" />
      </span>
    );
    title = `Connect to ${username}@${host}${port ? `:${port}` : ''}`;
    subtitle = 'One-off connection, not saved';
  } else if (row.type === 'locked') {
    badge = (
      <span className={`${BADGE} bg-app-surface-subtle text-txt-muted`}>
        <Lock className="h-3 w-3" aria-hidden="true" />
      </span>
    );
    title = row.vault.name;
    subtitle = 'Locked. Press Enter to open Connection Manager and unlock it.';
  } else {
    const { entry } = row;
    badge =
      entry.kind === 'action' ? (
        <span className={`${BADGE} bg-violet-500/15 text-violet-400`}>
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      ) : entry.kind === 'tab' ? (
        <span className={`${BADGE} bg-app-surface-subtle text-txt-muted`}>
          <Terminal className="h-3 w-3" aria-hidden="true" />
        </span>
      ) : entry.kind === 'system' ? (
        <span className={`${BADGE} bg-sky-500/15 text-sky-400`}>
          <Layers className="h-3 w-3" aria-hidden="true" />
        </span>
      ) : (
        <span className={`${BADGE} ${entry.kind === 'ssh' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-sky-500/15 text-sky-400'}`}>
          {entry.kind === 'ssh' ? 'SSH' : 'S3'}
        </span>
      );
    title = <Highlighted text={entry.title} indices={row.titleIndices} />;
    subtitle = entry.group ? `${entry.subtitle} · ${entry.group}` : entry.subtitle;
    trailing = (
      <>
        <TagChips tags={entry.tags} max={2} />
        {entry.sourceLabel && (
          <span className="shrink-0 rounded bg-app-surface-subtle px-1.5 py-0.5 text-[10px] text-txt-muted">{entry.sourceLabel}</span>
        )}
      </>
    );
  }

  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      onMouseMove={onHover}
      onClick={(e) => onActivate(e.shiftKey)}
      className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 ${
        active ? 'bg-app-surface-hover ring-1 ring-sky-500/60' : ''
      }`}
    >
      {badge}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-txt-primary">{title}</span>
        <span className="block truncate text-[11px] text-txt-muted">{subtitle}</span>
      </span>
      {trailing}
    </li>
  );
};
