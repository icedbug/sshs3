import type { SSHConnectionConfig } from '@shared/types/ssh';
import type { S3Config } from '@shared/types/storage';

export type Tab = 'ssh' | 's3' | 'k8s';

/** The profile being created or edited in the form shown inside the manager.
 *
 * `teamVaultId` is set only when CREATING a new shared (Team Vault) profile — there's no
 * `config.teamVaultProfileRef` yet to read it from in that case, since the profile doesn't exist.
 * When EDITING an existing shared profile, `config.teamVaultProfileRef.vaultId` already carries
 * it (every team profile `TeamProfileTreeList` renders is pre-tagged with that ref), so
 * `teamVaultId` is left unset and the vaultId is read from there instead —
 * `ConnectionManagerModal` checks both (`editing.teamVaultId ?? (editing.config as any)
 * ?.teamVaultProfileRef?.vaultId`) wherever it needs to know which team an edit belongs to.
 * Absent entirely for a personal (non-Team-Vault) profile. */
export type EditingState = {
  type: Tab;
  config?: SSHConnectionConfig | S3Config;
  teamVaultId?: string;
};

/** One Team Vault's worth of metadata `TeamProfileTreeList` reports up to
 * `ConnectionManagerModal`, which has no other way to know it (it doesn't fetch vault payloads
 * itself) — used to gate the edit form's secret field and feed its folder-suggestion autocomplete
 * for whichever team the open edit belongs to. */
export interface TeamVaultMeta {
  vaultId: string;
  vaultName?: string;
  isAdmin: boolean;
  folderSuggestions: string[];
  /** Names of the systems that exist in this team, offered in the profile form. */
  systemSuggestions: string[];
  /** Mirrors `TeamVaultStatus.unlocked` so `ConnectionManagerModal` can keep its tab row's lock
   * icon in sync the moment `TeamProfileTreeList` unlocks/locks a vault, instead of waiting for
   * the next `loadTeamVaultTabs()` poll. */
  unlocked: boolean;
  /** How many of this vault's profiles (of the active tab's type) match the current search query
   * — lets `ConnectionManagerModal` tell the user "N more results in <team>" when searching from
   * Personal or a different team (§8), without fetching every unlocked vault's full payload
   * itself. 0 when `query` is empty. */
  matchCount: number;
}

/** Imperative handle `TeamProfileTreeList` exposes via `forwardRef` — `ConnectionManagerModal`
 * calls `refreshVault` after it saves a shared profile through the edit form (which it renders,
 * not `TeamProfileTreeList`), so that vault's cached payload picks up the change immediately
 * instead of waiting for the next background poll. */
export interface TeamProfileTreeListHandle {
  refreshVault: (vaultId: string) => Promise<void>;
}

/** Lets a profile row take part in a multi-selection: the list owns the selection, the row only shows and toggles it. */
export interface RowSelect {
  checked: boolean;
  /** Some profile in the list is selected, so every row shows its checkbox, not only the one pointed at. */
  anyChecked: boolean;
  onToggle: () => void;
}
