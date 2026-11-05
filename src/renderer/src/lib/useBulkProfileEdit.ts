import { useCallback, useMemo, useRef, useState } from 'react';
import { saveInOrder } from './saveInOrder';
import { normalizeSystem } from '@shared/system';
import { normalizeFolderName, withAddedTags } from './bulkProfileEdit';
import { defaultSystemFolder, groupAsSystem as groupAsSystemOf, moveWithSystems } from './systemEdit';
import type { SystemProfile } from './systemGrouping';

interface BulkProfile extends SystemProfile {
  tags?: string[];
}

interface UseBulkProfileEditOptions<T extends BulkProfile> {
  /** The profiles of the list being shown (one protocol, one source); a selected id that leaves it is forgotten. */
  profiles: readonly T[];
  /** Every profile of the list, also the ones a search hides. Moving a server moves its whole system, hidden servers included. */
  allProfiles?: readonly T[];
  /** Saves one profile through the same path a drag and drop uses (personal store, or the Team Vault). */
  save: (profile: T) => Promise<unknown>;
  /** Reads the list again after profiles were saved. */
  reload: () => Promise<void>;
  onError: (message: string) => void;
}

const plural = (n: number) => `${n} profile${n === 1 ? '' : 's'}`;

/**
 * Checkbox selection over a list of profiles, and the two edits that work on the whole selection:
 * move to a folder and add tags. Profiles are saved one at a time, in order, through `save`; the
 * first failure stops the run (what was saved is reloaded) and keeps the selection so it can be
 * retried. Only profiles that would actually change are saved, so a Team Vault revision is not
 * bumped for nothing.
 */
export function useBulkProfileEdit<T extends BulkProfile>({ profiles, allProfiles, save, reload, onError }: UseBulkProfileEditOptions<T>) {
  const everyone = allProfiles ?? profiles;
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const selection = useMemo(() => {
    const ids = new Set(profiles.map((p) => p.id));
    return new Set([...chosen].filter((id) => ids.has(id)));
  }, [chosen, profiles]);

  const toggle = useCallback((id: string) => {
    setNotice(null);
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setNotice(null);
    setChosen(new Set());
  }, []);

  const saveAll = (changed: T[], failure: string) => saveInOrder(changed, save, reload, onError, failure);

  const run = async (work: () => Promise<void>) => {
    if (busyRef.current || selection.size === 0) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const moveTo = (rawFolder: string) =>
    run(async () => {
      const folder = normalizeFolderName(rawFolder);
      const changed = moveWithSystems(everyone, selection, folder);
      if (changed.length === 0) {
        setNotice(folder ? `Already in "${folder}".` : 'None of them is in a folder.');
        return;
      }
      if (await saveAll(changed, 'Failed to move the profiles')) {
        setChosen(new Set());
        setNotice(folder ? `Moved ${plural(changed.length)} to "${folder}".` : `Moved ${plural(changed.length)} out of ${changed.length === 1 ? 'its' : 'their'} folder.`);
      }
    });

  const groupAsSystem = (rawName: string, rawFolder: string) =>
    run(async () => {
      const name = normalizeSystem({ name: rawName }, undefined)?.name;
      if (!name) {
        setNotice('Enter a name for the system.');
        return;
      }
      const folder = rawFolder.trim() !== '' ? normalizeFolderName(rawFolder) : defaultSystemFolder(everyone, selection, name);
      const changed = groupAsSystemOf(everyone, selection, name, folder);
      if (changed.length === 0) {
        setNotice(`Already in "${name}".`);
        return;
      }
      if (await saveAll(changed, 'Failed to group the profiles')) {
        setChosen(new Set());
        setNotice(`Grouped ${plural(selection.size)} into "${name}".`);
      }
    });

  const addTags = (tags: readonly string[]) =>
    run(async () => {
      const changed = withAddedTags(everyone, selection, tags);
      if (changed.length === 0) {
        setNotice('They already have those tags.');
        return;
      }
      if (await saveAll(changed, 'Failed to add the tags')) {
        setChosen(new Set());
        setNotice(`Added tags to ${plural(changed.length)}.`);
      }
    });

  return {
    count: selection.size,
    isSelected: (id: string) => selection.has(id),
    /** What a profile row needs to show and toggle its checkbox. */
    rowSelect: (id: string) => ({ checked: selection.has(id), anyChecked: selection.size > 0, onToggle: () => toggle(id) }),
    toggle,
    clear,
    moveTo,
    groupAsSystem,
    addTags,
    busy,
    notice,
  };
}
