import React, { useId, useState } from 'react';
import { FolderInput, Layers, Tag, X } from 'lucide-react';
import { TagInput } from '../ui/TagInput';

interface BulkActionBarProps {
  /** How many profiles are selected. */
  count: number;
  /** A save is running: the actions wait. */
  busy: boolean;
  /** The result of the last action ("Moved 2 profiles to ..."), shown even after the selection was cleared. */
  notice: string | null;
  /** Existing folders, offered while typing a destination. */
  folderSuggestions: string[];
  /** `''` takes the profiles out of their folder. */
  onMove: (folder: string) => void;
  onAddTags: (tags: string[]) => void;
  /** Names of the systems that exist, offered while typing in "Group as system…". */
  systemSuggestions?: string[];
  /** Puts the selected profiles into a system (and a folder; `''` means the system's own or the one most are in). Omit where systems are not supported. */
  onGroupAsSystem?: (name: string, folder: string) => void;
  onClear: () => void;
}

type Panel = 'move' | 'tags' | 'system' | null;

const BUTTON =
  'flex items-center gap-1.5 rounded-lg border border-border-subtle px-2.5 py-1 text-xs font-medium text-txt-secondary transition-colors hover:bg-app-surface-hover hover:text-txt-primary disabled:cursor-not-allowed disabled:opacity-50';
const PANEL_INPUT =
  'min-w-0 flex-1 rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted';

/**
 * Shown above a profile list while some profiles are selected: move them to a folder (existing or
 * new, any depth with `/`), take them out of their folder, or add tags to all of them. The result of
 * the last action stays visible afterwards, since the selection it applied to is gone.
 */
export const BulkActionBar: React.FC<BulkActionBarProps> = ({
  count,
  busy,
  notice,
  folderSuggestions,
  onMove,
  onAddTags,
  systemSuggestions,
  onGroupAsSystem,
  onClear,
}) => {
  const [panel, setPanel] = useState<Panel>(null);
  const [folder, setFolder] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [systemName, setSystemName] = useState('');
  const listId = useId();

  if (count === 0 && !notice) return null;

  const close = () => {
    setPanel(null);
    setFolder('');
    setTags([]);
    setSystemName('');
  };
  const toggle = (next: Exclude<Panel, null>) => {
    setFolder('');
    setTags([]);
    setSystemName('');
    setPanel((current) => (current === next ? null : next));
  };
  const move = (target: string) => {
    onMove(target);
    close();
  };
  // Escape closes the panel only: it must not reach the dialog around it, which would close as well.
  const escapeCloses = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };

  if (count === 0) {
    return (
      <p role="status" className="px-1 text-xs text-txt-secondary">
        {notice}
      </p>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-semibold text-txt-primary">{count} selected</span>
        <button type="button" disabled={busy} aria-expanded={panel === 'move'} onClick={() => toggle('move')} className={BUTTON}>
          <FolderInput className="h-3.5 w-3.5" aria-hidden="true" />
          Move to folder…
        </button>
        <button type="button" disabled={busy} aria-expanded={panel === 'tags'} onClick={() => toggle('tags')} className={BUTTON}>
          <Tag className="h-3.5 w-3.5" aria-hidden="true" />
          Add tags…
        </button>
        {onGroupAsSystem && (
          <button type="button" disabled={busy} aria-expanded={panel === 'system'} onClick={() => toggle('system')} className={BUTTON}>
            <Layers className="h-3.5 w-3.5" aria-hidden="true" />
            Group as system…
          </button>
        )}
        <button type="button" onClick={onClear} aria-label="Clear selection" className={`${BUTTON} ml-auto`}>
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          Clear
        </button>
      </div>

      {panel === 'move' && (
        <div role="group" aria-label="Move to folder" className="flex flex-wrap items-center gap-2" onKeyDown={escapeCloses}>
          <label htmlFor={`${listId}-folder`} className="text-xs text-txt-secondary">
            Folder
          </label>
          <input
            id={`${listId}-folder`}
            autoFocus
            value={folder}
            list={folderSuggestions.length > 0 ? listId : undefined}
            onChange={(e) => setFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && folder.trim() !== '') {
                e.preventDefault();
                move(folder);
              }
            }}
            placeholder="Existing or new, e.g. Prod/Web"
            className={PANEL_INPUT}
          />
          {folderSuggestions.length > 0 && (
            <datalist id={listId}>
              {folderSuggestions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          )}
          <button
            type="button"
            disabled={busy || folder.trim() === ''}
            onClick={() => move(folder)}
            className="rounded-lg bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Move
          </button>
          <button type="button" disabled={busy} onClick={() => move('')} className={BUTTON}>
            Take out of folder
          </button>
        </div>
      )}

      {panel === 'system' && onGroupAsSystem && (
        <div role="group" aria-label="Group as system" className="flex flex-wrap items-center gap-2" onKeyDown={escapeCloses}>
          <label htmlFor={`${listId}-system`} className="text-xs text-txt-secondary">
            System
          </label>
          <input
            id={`${listId}-system`}
            autoFocus
            value={systemName}
            list={systemSuggestions && systemSuggestions.length > 0 ? `${listId}-systems` : undefined}
            onChange={(e) => setSystemName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && systemName.trim() !== '') {
                e.preventDefault();
                onGroupAsSystem(systemName, folder);
                close();
              }
            }}
            placeholder="Existing or new, e.g. Webshop"
            className={PANEL_INPUT}
          />
          {systemSuggestions && systemSuggestions.length > 0 && (
            <datalist id={`${listId}-systems`}>
              {systemSuggestions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          )}
          <label htmlFor={`${listId}-system-folder`} className="text-xs text-txt-secondary">
            Folder (optional)
          </label>
          <input
            id={`${listId}-system-folder`}
            value={folder}
            list={folderSuggestions.length > 0 ? listId : undefined}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="Default: the system's folder"
            className={PANEL_INPUT}
          />
          {folderSuggestions.length > 0 && (
            <datalist id={listId}>
              {folderSuggestions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          )}
          <button
            type="button"
            disabled={busy || systemName.trim() === ''}
            onClick={() => {
              onGroupAsSystem(systemName, folder);
              close();
            }}
            className="rounded-lg bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Group
          </button>
        </div>
      )}

      {panel === 'tags' && (
        <div role="group" aria-label="Add tags" className="flex flex-wrap items-start gap-2" onKeyDown={escapeCloses}>
          <div className="min-w-[14rem] flex-1">
            <TagInput id={`${listId}-tags`} value={tags} onChange={setTags} ariaLabel="Tags to add" />
          </div>
          <button
            type="button"
            disabled={busy || tags.length === 0}
            onClick={() => {
              onAddTags(tags);
              close();
            }}
            className="rounded-lg bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add
          </button>
        </div>
      )}

      {notice && (
        <p role="status" className="text-xs text-txt-secondary">
          {notice}
        </p>
      )}
    </div>
  );
};
