import React from 'react';
import { LogIn, Network, Trash2, Users } from 'lucide-react';
import type { K8sProfile } from '@shared/types/kubernetes';

interface K8sProfileRowProps {
  profile: K8sProfile;
  onSignIn: (profile: K8sProfile) => void;
  onRemove: (profile: K8sProfile) => void;
  /** Offered only when at least one Team Vault is unlocked. */
  onShare?: (profile: K8sProfile) => void;
}

/** Action buttons for a saved cluster: sign in again (also edits it) and forget the profile. */
export const K8sProfileActions: React.FC<K8sProfileRowProps> = ({ profile, onSignIn, onRemove, onShare }) => (
  <div className="flex shrink-0 items-center gap-1 opacity-75 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
    <button
      type="button"
      onClick={() => onSignIn(profile)}
      title="Sign in again or edit this cluster profile"
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-txt-muted hover:bg-app-surface hover:text-txt-primary border border-transparent hover:border-border-subtle transition-colors"
    >
      <LogIn className="h-3 w-3" />
      <span className="hidden sm:inline">Sign in</span>
    </button>
    {onShare && (
      <button
        type="button"
        onClick={() => onShare(profile)}
        title="Share this cluster with a Team Vault (no token is shared)"
        aria-label={`Share profile ${profile.name} to a team`}
        className="rounded p-1 text-txt-muted hover:bg-app-surface hover:text-emerald-400 transition-colors"
      >
        <Users className="h-3 w-3" />
      </button>
    )}
    <button
      type="button"
      onClick={() => onRemove(profile)}
      title="Remove this profile (the kubeconfig entry is kept)"
      aria-label={`Remove profile ${profile.name}`}
      className="rounded p-1 text-txt-muted hover:bg-app-surface hover:text-red-400 transition-colors"
    >
      <Trash2 className="h-3 w-3" />
    </button>
  </div>
);

/** A saved cluster that has no kubeconfig context yet, so it cannot be expanded until the user signs in. */
export const K8sUnattachedProfileRow: React.FC<K8sProfileRowProps> = (props) => {
  const { profile } = props;
  return (
    <div className="group flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-app-surface-hover transition-colors">
      <div className="flex min-w-0 items-center gap-1.5">
        <Network className="h-3.5 w-3.5 shrink-0 text-txt-muted" />
        <span className="truncate font-semibold text-txt-secondary">{profile.name}</span>
        <span className="rounded bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.2 text-2xs text-amber-400">
          not signed in
        </span>
        {profile.namespace && <span className="truncate text-2xs text-txt-muted">project {profile.namespace}</span>}
        <span className="truncate font-normal text-txt-muted">{profile.server}</span>
      </div>
      <K8sProfileActions {...props} />
    </div>
  );
};
