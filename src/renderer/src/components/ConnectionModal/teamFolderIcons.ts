import {
  Box,
  Cloud,
  Cpu,
  Database,
  Folder,
  GitBranch,
  Globe,
  HardDrive,
  Layers,
  Network,
  Server,
  Shield,
  type LucideIcon,
} from 'lucide-react';
import type { TeamFolderIcon } from '@shared/types/teamVault';

/** Maps `TEAM_FOLDER_ICONS` keys (shared/types/teamVault.ts) to their `lucide-react` component —
 * the only place that mapping needs to exist, so adding an icon to the shared allowlist is a
 * one-line addition here too.
 *
 * Deliberately a `Map`, not a plain object: `node.icon` comes from `TeamVaultPayload.folderIcons`
 * — decrypted, but otherwise untrusted shared data written by whichever member's client last
 * touched that folder (this app's own IPC handler validates against `TEAM_FOLDER_ICONS` before
 * writing, but that's a write-time check on THIS app's own save path, not a guarantee about what
 * a different, possibly modified client already wrote into the synced payload). A plain-object
 * lookup keyed by an attacker-chosen string (`"constructor"`, `"__proto__"`, `"toString"`, ...)
 * resolves through `Object.prototype` instead of returning `undefined`, handing back a
 * non-icon value that crashes the render the moment it's used as a component — a DoS for every
 * member whose client encounters that folder. `Map.get` never traverses a prototype chain, so an
 * unrecognized key always safely falls through to the default folder icon below. */
export const FOLDER_ICON_COMPONENTS = new Map<TeamFolderIcon, LucideIcon>([
  ['folder', Folder],
  ['server', Server],
  ['database', Database],
  ['cloud', Cloud],
  ['shield', Shield],
  ['globe', Globe],
  ['box', Box],
  ['layers', Layers],
  ['hard-drive', HardDrive],
  ['network', Network],
  ['git-branch', GitBranch],
  ['cpu', Cpu],
]);

export function folderIconComponent(icon: string | undefined): LucideIcon {
  return (icon && FOLDER_ICON_COMPONENTS.get(icon as TeamFolderIcon)) || Folder;
}
