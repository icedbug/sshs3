import React from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { AlertTriangle, Copy, Pencil, Trash2 } from 'lucide-react';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import type { S3Config } from '@shared/types/storage';
import { SftpButton } from '../SftpButton';
import { OverflowMenu } from '../ui/OverflowMenu';
import { TagChips } from '../ui/TagChips';
import { ProfileRowCheckbox } from './ProfileRowCheckbox';
import type { EditingState, RowSelect } from './types';

interface TeamSshProfileRowProps {
  profile: SSHConnectionConfig;
  onConnectSSH?: (config: SSHConnectionConfig) => void;
  onConnectSFTP?: (config: SSHConnectionConfig) => void;
  handleCloneSSH: (profile: SSHConnectionConfig) => Promise<void> | void;
  handleDeleteSSH: (id: string, name: string) => Promise<void> | void;
  setEditing: Dispatch<SetStateAction<EditingState | null>>;
  /** Set by a list that supports selecting several profiles. */
  select?: RowSelect;
}

/**
 * Team Vault's row for a shared SSH profile — deliberately simpler than the personal
 * `SshProfileRow`: no "Manage tunnels" / "Install public key" actions, since both of those
 * modals persist their changes straight back to the PERSONAL profile store (`profilesSaveSSH`)
 * — wiring them up here would silently fork a shared profile into a local one on the first
 * tunnel edit. Drag-to-folder IS supported (`draggable` below) — see `TeamProfileTree.tsx`,
 * which renders this row inside the shared, arbitrarily-nested folder tree.
 */
export const TeamSshProfileRow: React.FC<TeamSshProfileRowProps> = ({
  profile,
  onConnectSSH,
  onConnectSFTP,
  handleCloneSSH,
  handleDeleteSSH,
  setEditing,
  select,
}) => (
  <div className="flex flex-col gap-1">
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'ssh', id: profile.id }));
        e.dataTransfer.effectAllowed = 'move';
      }}
      className="group flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-app-surface px-3 py-1.5 hover:border-border-strong transition-colors"
    >
      {select && <ProfileRowCheckbox name={profile.name} select={select} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-txt-primary">{profile.name}</span>
          <TagChips tags={profile.tags} />
        </div>
        <div className="truncate text-xs text-txt-muted">
          {profile.username}@{profile.host}:{profile.port ?? 22} · {profile.authType}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {onConnectSSH && (
          <button
            type="button"
            title="Connect (SSH Terminal)"
            onClick={() => onConnectSSH(profile)}
            className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 shadow-sm transition-colors"
          >
            Connect
          </button>
        )}
        {onConnectSFTP && <SftpButton authType={profile.authType} onOpen={() => onConnectSFTP(profile)} />}
        <button
          aria-label="Edit profile"
          type="button"
          title="Edit profile"
          onClick={() => setEditing({ type: 'ssh', config: profile })}
          className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <OverflowMenu
          items={[
            { label: 'Duplicate profile', icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => void handleCloneSSH(profile) },
            {
              label: 'Delete profile',
              icon: <Trash2 className="h-3.5 w-3.5" />,
              danger: true,
              separated: true,
              onSelect: () => void handleDeleteSSH(profile.id, profile.name),
            },
          ]}
        />
      </div>
    </div>
    {profile.authType === 'privateKey' && (
      <p className="flex items-center gap-1 px-2 text-2xs text-amber-400">
        <AlertTriangle className="h-3 w-3 shrink-0" />
        Private key path is local to this machine — other members need an identical path for this to work.
      </p>
    )}
  </div>
);

interface TeamS3ProfileRowProps {
  profile: S3Config;
  onConnectS3?: (config: S3Config) => void;
  handleCloneS3: (profile: S3Config) => Promise<void> | void;
  handleDeleteS3: (id: string, name: string) => Promise<void> | void;
  setEditing: Dispatch<SetStateAction<EditingState | null>>;
  /** Set by a list that supports selecting several profiles. */
  select?: RowSelect;
}

export const TeamS3ProfileRow: React.FC<TeamS3ProfileRowProps> = ({
  profile,
  onConnectS3,
  handleCloneS3,
  handleDeleteS3,
  setEditing,
  select,
}) => (
  <div
    draggable
    onDragStart={(e) => {
      e.dataTransfer.setData('text/plain', JSON.stringify({ type: 's3', id: profile.id }));
      e.dataTransfer.effectAllowed = 'move';
    }}
    className="group flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-app-surface px-3 py-1.5 hover:border-border-strong transition-colors"
  >
    {select && <ProfileRowCheckbox name={profile.name} select={select} />}
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium text-txt-primary">{profile.name}</span>
        <TagChips tags={profile.tags} />
      </div>
      <div className="truncate text-xs text-txt-muted">
        {profile.endpoint || 'AWS S3'} · {profile.region}
      </div>
    </div>
    <div className="flex shrink-0 items-center gap-1.5">
      {onConnectS3 && (
        <button
          type="button"
          onClick={() => onConnectS3(profile)}
          className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 shadow-sm transition-colors"
        >
          Connect
        </button>
      )}
      <button
        aria-label="Edit profile"
        type="button"
        title="Edit profile"
        onClick={() => setEditing({ type: 's3', config: profile })}
        className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <OverflowMenu
        items={[
          { label: 'Duplicate profile', icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => void handleCloneS3(profile) },
          {
            label: 'Delete profile',
            icon: <Trash2 className="h-3.5 w-3.5" />,
            danger: true,
            separated: true,
            onSelect: () => void handleDeleteS3(profile.id, profile.name),
          },
        ]}
      />
    </div>
  </div>
);
