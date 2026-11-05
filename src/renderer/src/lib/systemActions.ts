import type { ConfirmOptions } from '../components/ConfirmDialog';
import { saveInOrder } from './saveInOrder';
import { renameSystem, systemNameTaken, ungroupSystem } from './systemEdit';
import { systemNameOf, type SystemProfile } from './systemGrouping';

interface SystemActionsOptions<T extends SystemProfile> {
  /** Every profile of the source, as stored: not narrowed by a search, not aligned for drawing. */
  profiles: readonly T[];
  save: (profile: T) => Promise<unknown>;
  reload: () => Promise<void>;
  onError: (message: string) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

/** Rename and Ungroup on the system row, for the personal list and each Team Vault alike. Plain functions over the stored profiles: no React state, so callable per vault inside a list. */
export function createSystemActions<T extends SystemProfile>({ profiles, save, reload, onError, confirm }: SystemActionsOptions<T>) {
  const nameOf = (members: readonly T[]) => systemNameOf(members[0]) ?? '';

  const rename = async (members: readonly T[], newName: string) => {
    const from = nameOf(members);
    if (systemNameTaken(profiles, from, newName.trim())) {
      onError(`A system called "${newName.trim()}" already exists.`);
      return;
    }
    await saveInOrder(renameSystem(profiles, from, newName), save, reload, onError, 'Failed to rename the system');
  };

  const ungroup = async (members: readonly T[]) => {
    const name = nameOf(members);
    const ok = await confirm({
      title: 'Ungroup system',
      message: `Ungroup "${name}"? The servers stay, they are just no longer a system.`,
      confirmLabel: 'Ungroup',
      danger: false,
    });
    if (!ok) return;
    await saveInOrder(ungroupSystem(profiles, name), save, reload, onError, 'Failed to ungroup the system');
  };

  return { rename, ungroup };
}
