import React from 'react';
import { useBulkProfileEdit } from '../../lib/useBulkProfileEdit';
import { BulkActionBar } from './BulkActionBar';
import type { RowSelect } from './types';
import type { SystemProfile } from '../../lib/systemGrouping';

type BulkEditable = SystemProfile & { tags?: string[] };

interface TeamBulkEditProps<T extends BulkEditable> {
  /** The profiles of the list being shown (one team, one protocol, after the search filter). */
  profiles: readonly T[];
  /** Every profile of the team's list, also the ones a search hides (a moved server takes its whole system along). */
  allProfiles?: readonly T[];
  /** Saves one profile in the Team Vault, the same way moving it by drag and drop does. */
  save: (profile: T) => Promise<unknown>;
  reload: () => Promise<void>;
  onError: (message: string) => void;
  folderSuggestions: string[];
  /** Names of the team's systems; when given, "Group as system…" is offered (SSH lists only). */
  systemSuggestions?: string[];
  /** Renders the list; `rowSelect(id)` is what a profile row needs to show and toggle its checkbox. */
  children: (rowSelect: (id: string) => RowSelect) => React.ReactNode;
}

/**
 * Multi-selection for one team's profile list: the action bar above the list, and each row's checkbox
 * state handed to `children`. Mount it with a `key` per team and protocol so the selection starts
 * empty when either changes.
 */
export function TeamBulkEdit<T extends BulkEditable>({
  profiles,
  allProfiles,
  save,
  reload,
  onError,
  folderSuggestions,
  systemSuggestions,
  children,
}: TeamBulkEditProps<T>): React.ReactElement {
  const bulk = useBulkProfileEdit<T>({ profiles, allProfiles, save, reload, onError });
  return (
    <div className="space-y-2">
      <BulkActionBar
        count={bulk.count}
        busy={bulk.busy}
        notice={bulk.notice}
        folderSuggestions={folderSuggestions}
        systemSuggestions={systemSuggestions}
        onGroupAsSystem={systemSuggestions ? (name, folder) => void bulk.groupAsSystem(name, folder) : undefined}
        onMove={(folder) => void bulk.moveTo(folder)}
        onAddTags={(tags) => void bulk.addTags(tags)}
        onClear={bulk.clear}
      />
      {children(bulk.rowSelect)}
    </div>
  );
}
