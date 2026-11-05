import { useEffect } from 'react';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import type { S3Config } from '@shared/types/storage';
import { useBulkProfileEdit } from './useBulkProfileEdit';
import { systemNames } from './systemGrouping';

interface UsePersonalBulkEditOptions {
  tab: string;
  /** 'personal' or a Team Vault id: only the personal lists are selected here. */
  source: string;
  open: boolean;
  /** The profiles the lists are showing now (after the search filter). */
  sshProfiles: SSHConnectionConfig[];
  /** Every SSH profile, also the ones the search hides: a moved server takes its whole system along. */
  allSshProfiles?: SSHConnectionConfig[];
  s3Profiles: S3Config[];
  sshFolders: string[];
  s3Folders: string[];
  reload: () => Promise<void>;
  onError: (message: string) => void;
}

/**
 * Multi-selection for Connection Manager's personal SSH and S3 lists: one selection per tab, saved
 * through the personal store, forgotten when the tab or team changes or the dialog is reopened.
 * `barProps` are the props of the action bar for the tab being shown.
 */
export function usePersonalBulkEdit({
  tab,
  source,
  open,
  sshProfiles,
  allSshProfiles,
  s3Profiles,
  sshFolders,
  s3Folders,
  reload,
  onError,
}: UsePersonalBulkEditOptions) {
  const ssh = useBulkProfileEdit<SSHConnectionConfig>({
    profiles: sshProfiles,
    allProfiles: allSshProfiles,
    save: (profile) => window.multissh.profilesSaveSSH(profile),
    reload,
    onError,
  });
  const s3 = useBulkProfileEdit<S3Config>({
    profiles: s3Profiles,
    save: (profile) => window.multissh.profilesSaveS3(profile),
    reload,
    onError,
  });

  const clearSsh = ssh.clear;
  const clearS3 = s3.clear;
  useEffect(() => {
    clearSsh();
    clearS3();
  }, [tab, source, open, clearSsh, clearS3]);

  const active = tab === 's3' ? s3 : ssh;
  return {
    ssh,
    s3,
    barProps: {
      count: active.count,
      busy: active.busy,
      notice: active.notice,
      folderSuggestions: tab === 's3' ? s3Folders : sshFolders,
      onMove: (folder: string) => void active.moveTo(folder),
      onAddTags: (tags: string[]) => void active.addTags(tags),
      systemSuggestions: tab === 's3' ? undefined : systemNames(allSshProfiles ?? sshProfiles),
      onGroupAsSystem: tab === 's3' ? undefined : (name: string, folder: string) => void ssh.groupAsSystem(name, folder),
      onClear: active.clear,
    },
  };
}
