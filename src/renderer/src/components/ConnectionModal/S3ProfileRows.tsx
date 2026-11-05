import React from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Copy, Folder, Pencil, Trash2 } from 'lucide-react';
import type { S3Config } from '@shared/types/storage';
import { TagChips } from '../ui/TagChips';
import { ProfileRowCheckbox } from './ProfileRowCheckbox';
import type { EditingState, RowSelect } from './types';

interface S3ProfileRowProps {
  profile: S3Config;
  onConnectS3?: (config: S3Config) => void;
  handleConnectS3: (profile: S3Config) => Promise<void> | void;
  handleCloneS3: (profile: S3Config) => Promise<void> | void;
  handleDeleteS3: (id: string, name: string) => Promise<void> | void;
  setEditing: Dispatch<SetStateAction<EditingState | null>>;
  /** Set by a list that supports selecting several profiles. */
  select?: RowSelect;
}

/** One entry of the "Recently Used" box for S3 profiles. */
export const S3RecentRow: React.FC<S3ProfileRowProps> = ({
  profile,
  onConnectS3,
  handleConnectS3,
  handleCloneS3,
  handleDeleteS3,
  setEditing,
}) => (
  <div
    onDoubleClick={() => void handleConnectS3(profile)}
    title="Double-click to connect"
    className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-app-surface px-3 py-1.5 hover:border-border-strong transition-colors cursor-pointer"
  >
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span className="truncate text-xs font-medium text-txt-primary">{profile.name}</span>
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
        {profile.endpoint || 'AWS S3'} · {profile.region} · Last connected:{' '}
        {profile.lastUsedAt}
      </div>
    </div>
    <div className="flex shrink-0 items-center gap-1.5">
      {onConnectS3 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void handleConnectS3(profile);
          }}
          className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 shadow-sm transition-colors"
        >
          Connect
        </button>
      )}
      {/* UX audit finding #11: match the action set this profile gets
          further down in its folder listing. */}
      <button
        aria-label="Duplicate / Clone Profile"
        type="button"
        title="Duplicate / Clone Profile"
        onClick={(e) => {
          e.stopPropagation();
          void handleCloneS3(profile);
        }}
        className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
      <button
        aria-label="Edit profile"
        type="button"
        title="Edit profile"
        onClick={(e) => {
          e.stopPropagation();
          setEditing({ type: 's3', config: profile });
        }}
        className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        aria-label="Delete profile"
        type="button"
        title="Delete profile"
        onClick={(e) => {
          e.stopPropagation();
          void handleDeleteS3(profile.id, profile.name);
        }}
        className="ml-1.5 rounded-lg p-1.5 text-red-400 hover:bg-red-500/15 transition-colors"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
);

/** One draggable S3 profile card inside a folder. */
export const S3ProfileRow: React.FC<S3ProfileRowProps> = ({
  profile,
  onConnectS3,
  handleConnectS3,
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
    onDoubleClick={() => void handleConnectS3(profile)}
    title="Double-click to connect (or drag to folder)"
    className="group flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-app-surface px-3 py-1.5 cursor-grab active:cursor-grabbing hover:border-border-strong transition-all select-none"
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
          title="Connect / Browse S3"
          onClick={(e) => {
            e.stopPropagation();
            void handleConnectS3(profile);
          }}
          className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 shadow-sm transition-colors"
        >
          Connect
        </button>
      )}
      <button
        aria-label="Duplicate / Clone Profile"
        type="button"
        title="Duplicate / Clone Profile"
        onClick={(e) => {
          e.stopPropagation();
          void handleCloneS3(profile);
        }}
        className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
      <button
        aria-label="Edit profile"
        type="button"
        title="Edit profile"
        onClick={(e) => {
          e.stopPropagation();
          setEditing({ type: 's3', config: profile });
        }}
        className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        aria-label="Delete profile"
        type="button"
        title="Delete profile"
        onClick={(e) => {
          e.stopPropagation();
          void handleDeleteS3(profile.id, profile.name);
        }}
        className="ml-1.5 rounded-lg p-1.5 text-red-400 hover:bg-red-500/15 transition-colors"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
);
