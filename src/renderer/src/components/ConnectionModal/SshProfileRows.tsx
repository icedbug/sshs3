import React from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Cable, Copy, Folder, KeyRound, Pencil, Trash2 } from 'lucide-react';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import { SftpButton } from '../SftpButton';
import { ProfileRowMenu } from './ProfileRowMenu';
import type { EditingState } from './types';

interface SshProfileRowProps {
  profile: SSHConnectionConfig;
  onConnectSSH?: (config: SSHConnectionConfig) => void;
  onConnectSFTP?: (config: SSHConnectionConfig) => void;
  handleConnectSSH: (profile: SSHConnectionConfig) => Promise<void> | void;
  handleCloneSSH: (profile: SSHConnectionConfig) => Promise<void> | void;
  handleDeleteSSH: (id: string, name: string) => Promise<void> | void;
  setEditing: Dispatch<SetStateAction<EditingState | null>>;
  setInstallKeyProfile: (profile: SSHConnectionConfig) => void;
  setTunnelsProfile: (profile: SSHConnectionConfig) => void;
}

/** One entry of the "Recently Used" box for SSH profiles. */
export const SshRecentRow: React.FC<SshProfileRowProps> = ({
  profile,
  onConnectSSH,
  onConnectSFTP,
  handleConnectSSH,
  handleCloneSSH,
  handleDeleteSSH,
  setEditing,
  setInstallKeyProfile,
  setTunnelsProfile,
}) => (
  <div
    onDoubleClick={() => void handleConnectSSH(profile)}
    title="Double-click to connect"
    className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-app-surface px-3 py-1.5 hover:border-border-strong transition-colors cursor-pointer"
  >
    <div className="min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="truncate text-xs font-medium text-txt-primary">{profile.name}</span>
        {profile.cluster && (
          <span className="rounded bg-indigo-500/15 border border-indigo-500/35 px-1.5 py-0.2 text-2xs font-medium text-indigo-300">
            🧩 {profile.cluster}
          </span>
        )}
        {(profile.nodeRole || profile.role) && (
          <span className="rounded bg-sky-500/15 border border-sky-500/35 px-1.5 py-0.2 text-2xs text-sky-300">
            {profile.nodeRole || profile.role}
          </span>
        )}
        {profile.shared && (
          <span className="rounded bg-purple-500/15 border border-purple-500/35 px-1.5 py-0.2 text-2xs text-purple-300">
            ☁️ S3 Shared
          </span>
        )}
        {profile.forwardAgent && (
          <span className="rounded bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.2 text-2xs text-amber-400">
            Agent Fwd
          </span>
        )}
        {profile.group && (
          <span
            title={`In folder "${profile.group}"`}
            className="inline-flex items-center gap-1 rounded bg-app-surface-subtle border border-border-subtle px-1.5 py-0.5 text-2xs text-txt-muted"
          >
            <Folder className="h-2.5 w-2.5" />
            {profile.group}
          </span>
        )}
      </div>
      <div className="truncate text-xs text-txt-muted">
        {profile.username}@{profile.host}:{profile.port ?? 22} · Last connected:{' '}
        {profile.lastUsedAt}
      </div>
    </div>
    <div className="flex shrink-0 items-center gap-1.5">
      {onConnectSSH && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void handleConnectSSH(profile);
          }}
          className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 shadow-sm transition-colors"
        >
          Connect
        </button>
      )}
      {onConnectSFTP && (
          <SftpButton authType={profile.authType} onOpen={() => onConnectSFTP(profile)} /> 
        )}
      {/* UX audit finding #11: this row used to stop at Connect/SFTP
          while the identical profile, shown again below in its folder,
          also had Tunnels/Duplicate/Edit/Delete — same entity, two
          different action sets depending on where you saw it. */}
      <button
        type="button"
        title="Edit Profile"
        onClick={(e) => {
          e.stopPropagation();
          setEditing({ type: 'ssh', config: profile });
        }}
        className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
        <ProfileRowMenu
        items={[
          { label: 'Install public key', icon: <KeyRound className="h-3.5 w-3.5" />, onSelect: () => setInstallKeyProfile(profile) },
          { label: 'Manage tunnels', icon: <Cable className="h-3.5 w-3.5" />, onSelect: () => setTunnelsProfile(profile) },
          { label: 'Duplicate profile', icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => void handleCloneSSH(profile) },
          { label: 'Delete profile', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, separated: true, onSelect: () => void handleDeleteSSH(profile.id, profile.name) },
        ]}
      />
    </div>
  </div>
);

/** One draggable SSH profile card inside a folder. */
export const SshProfileRow: React.FC<SshProfileRowProps> = ({
  profile,
  onConnectSSH,
  onConnectSFTP,
  handleConnectSSH,
  handleCloneSSH,
  handleDeleteSSH,
  setEditing,
  setInstallKeyProfile,
  setTunnelsProfile,
}) => (
  <div
    draggable
    onDragStart={(e) => {
      e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'ssh', id: profile.id }));
      e.dataTransfer.effectAllowed = 'move';
    }}
    onDoubleClick={() => void handleConnectSSH(profile)}
    title="Double-click to connect (or drag to folder)"
    className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-app-surface px-3 py-1.5 cursor-grab active:cursor-grabbing hover:border-border-strong transition-all select-none"
  >
    <div className="min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="truncate text-sm text-txt-primary font-medium">
          {profile.name}
        </span>
        {profile.cluster && (
          <span className="rounded bg-indigo-500/15 border border-indigo-500/35 px-1.5 py-0.2 text-2xs font-medium text-indigo-300">
            🧩 {profile.cluster}
          </span>
        )}
        {(profile.nodeRole || profile.role) && (
          <span className="rounded bg-sky-500/15 border border-sky-500/35 px-1.5 py-0.2 text-2xs text-sky-300">
            {profile.nodeRole || profile.role}
          </span>
        )}
        {profile.shared && (
          <span className="rounded bg-purple-500/15 border border-purple-500/35 px-1.5 py-0.2 text-2xs text-purple-300">
            ☁️ S3 Shared
          </span>
        )}
        {profile.proxyJump && (
          <span className="rounded bg-sky-500/15 border border-sky-500/30 px-1.5 py-0.2 text-2xs text-sky-400">
            Jump
          </span>
        )}
        {profile.forwardAgent && (
          <span className="rounded bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.2 text-2xs text-amber-400">
            Agent Fwd
          </span>
        )}
        {profile.tunnels && profile.tunnels.length > 0 && (
          <span className="rounded bg-indigo-500/15 border border-indigo-500/30 px-1.5 py-0.2 text-2xs text-indigo-400">
            {profile.tunnels.length} tunnel{profile.tunnels.length > 1 ? 's' : ''}
          </span>
        )}
      </div>
      <div className="truncate text-xs text-txt-muted">
        {profile.username}@{profile.host}:{profile.port ?? 22} · {profile.authType}
        {profile.description ? ` · ${profile.description}` : ''}
      </div>
    </div>
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        title={`Fråga AI om ${profile.name}`}
        onClick={(e) => {
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent('sshs3:ai-attach', {
              detail: {
                label: `@${profile.name}`,
                text: `Server: ${profile.name} (${profile.username}@${profile.host}:${profile.port ?? 22})${profile.cluster ? `\nCluster: ${profile.cluster}` : ''}${profile.nodeRole ? `\nNode Role: ${profile.nodeRole}` : ''}${profile.description ? `\nDescription: ${profile.description}` : ''}`,
                prompt: `Hjälp mig med @${profile.name}: `,
              },
            })
          );
        }}
        className="rounded-lg border border-sky-500/40 bg-sky-500/15 px-2 py-1 text-xs font-medium text-sky-300 hover:bg-sky-500/25 transition-colors"
      >
        ✨ AI
      </button>
      {onConnectSSH && (
        <button
          type="button"
          title="Connect (SSH Terminal)"
          onClick={(e) => {
            e.stopPropagation();
            void handleConnectSSH(profile);
          }}
          className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 shadow-sm transition-colors"
        >
          Connect
        </button>
      )}
      {onConnectSFTP && (
          <SftpButton authType={profile.authType} onOpen={() => onConnectSFTP(profile)} /> 
        )}
      <button
        type="button"
        title="Edit Profile"
        onClick={(e) => {
          e.stopPropagation();
          setEditing({ type: 'ssh', config: profile });
        }}
        className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
        <ProfileRowMenu
        items={[
          { label: 'Install public key', icon: <KeyRound className="h-3.5 w-3.5" />, onSelect: () => setInstallKeyProfile(profile) },
          { label: 'Manage tunnels', icon: <Cable className="h-3.5 w-3.5" />, onSelect: () => setTunnelsProfile(profile) },
          { label: 'Duplicate profile', icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => void handleCloneSSH(profile) },
          { label: 'Delete profile', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, separated: true, onSelect: () => void handleDeleteSSH(profile.id, profile.name) },
        ]}
      />
    </div>
  </div>
);
