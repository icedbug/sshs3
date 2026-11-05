import React, { useRef } from 'react';
import { Lock, Pencil, Plus, Trash2, Users, LogIn } from 'lucide-react';
import type { K8sProfile } from '@shared/types/kubernetes';
import type { TeamK8sGroup } from '../../lib/useK8sTeamProfiles';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';

interface K8sTeamVaultSectionProps {
  groups: TeamK8sGroup[];
  lockedCount: number;
  onSignIn: (template: K8sProfile) => void;
  onAdd: (group: TeamK8sGroup) => void;
  onEdit: (group: TeamK8sGroup, template: K8sProfile) => void;
  onRemove: (group: TeamK8sGroup, template: K8sProfile) => void;
}

const iconButton =
  'rounded p-1 text-txt-muted hover:bg-app-surface hover:text-txt-primary border border-transparent hover:border-border-subtle transition-colors';

/** Cluster templates shared through unlocked Team Vaults. Signing in creates the user's own personal profile. */
export const K8sTeamVaultSection: React.FC<K8sTeamVaultSectionProps> = ({
  groups,
  lockedCount,
  onSignIn,
  onAdd,
  onEdit,
  onRemove,
}) => {
  if (groups.length === 0 && lockedCount === 0) return null;
  return (
    <div data-testid="k8s-team-vault-section" className="space-y-2 rounded-lg border border-border-subtle/80 p-2">
      {groups.map((group) => (
        <div key={group.vaultId} className="space-y-1">
          <div className="flex items-center justify-between gap-2 px-1 text-xs font-semibold text-txt-secondary">
            <span className="flex min-w-0 items-center gap-1.5">
              <Users className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
              <span className="truncate">{group.vaultName}</span>
            </span>
            <button type="button" onClick={() => onAdd(group)} className={iconButton} title={`Add a shared cluster to ${group.vaultName}`} aria-label={`Add shared cluster to ${group.vaultName}`}>
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          {group.profiles.length === 0 ? (
            <p className="px-2 py-0.5 text-xs text-txt-muted">No shared clusters yet</p>
          ) : (
            group.profiles.map((template) => (
              <div key={template.id} className="group flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-xs hover:bg-app-surface-hover">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium text-txt-secondary">{template.name}</span>
                  {template.namespace && <span className="truncate text-2xs text-txt-muted">project {template.namespace}</span>}
                  <span className="truncate text-txt-muted">{template.server}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1 opacity-75 group-hover:opacity-100 group-focus-within:opacity-100">
                  <button type="button" onClick={() => onSignIn(template)} className={`${iconButton} flex items-center gap-1 px-1.5`} title="Sign in to this cluster (saves it as your own profile)">
                    <LogIn className="h-3 w-3" />
                    <span className="hidden sm:inline">Sign in</span>
                  </button>
                  <button type="button" onClick={() => onEdit(group, template)} className={iconButton} aria-label={`Edit shared cluster ${template.name}`} title="Edit for the whole team">
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button type="button" onClick={() => onRemove(group, template)} className={`${iconButton} hover:text-red-400`} aria-label={`Remove shared cluster ${template.name}`} title="Remove for the whole team">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      ))}
      {lockedCount > 0 && (
        <p className="flex items-center gap-1.5 px-1 text-xs text-txt-muted">
          <Lock className="h-3 w-3" />
          {lockedCount} locked team vault{lockedCount === 1 ? '' : 's'} not shown. Unlock them in the SSH or S3 tab.
        </p>
      )}
    </div>
  );
};

interface K8sSharePickerProps {
  profile: K8sProfile | null;
  groups: TeamK8sGroup[];
  onPick: (group: TeamK8sGroup) => void;
  onClose: () => void;
}

/** Chooses which unlocked Team Vault a personal cluster profile is shared to (only when there are several). */
export const K8sSharePicker: React.FC<K8sSharePickerProps> = ({ profile, groups, onPick, onClose }) => {
  useModalDismiss(onClose, profile !== null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, profile !== null);
  if (!profile) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Share to Team Vault" className="w-full max-w-sm space-y-3 rounded-xl border border-border-subtle bg-app-card p-5 text-xs shadow-2xl">
        <h2 className="text-sm font-semibold text-txt-primary">Share “{profile.name}” to a team</h2>
        <p className="text-txt-muted">Shares the server, project and TLS option. No token is shared.</p>
        <div className="space-y-1">
          {groups.map((group, index) => (
            <button
              key={group.vaultId}
              type="button"
              autoFocus={index === 0}
              onClick={() => onPick(group)}
              className="flex w-full items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-left text-txt-primary hover:bg-app-surface-hover"
            >
              <Users className="h-3.5 w-3.5 text-emerald-400" />
              {group.vaultName}
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="rounded-lg px-3.5 py-1.5 text-txt-muted hover:bg-app-surface-hover">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
