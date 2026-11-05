import React from 'react';
import { FileCode } from 'lucide-react';
import type { SettingsForm } from './useSettingsForm';

/** The "Files & Storage" page of the settings dialog. */
export const FilesSettingsSection: React.FC<{ form: SettingsForm }> = ({ form }) => {
  const {
    defaultConflictPolicy,
    setDefaultConflictPolicy,
    showHiddenFiles,
    setShowHiddenFiles,
    verifyTransferIntegrity,
    setVerifyTransferIntegrity,
    shareFoldersAcrossTypes,
    setShareFoldersAcrossTypes,
    confirmBeforeDelete,
    setConfirmBeforeDelete,
    dotfilesPoolEnabled,
    setDotfilesPoolEnabled,
    setPoolManagerOpen,
  } = form;

  return (
    <div className="space-y-4">
      {/* Default Conflict Policy */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-txt-primary">
          Default Conflict Resolution for File Transfers
        </label>
        <div className="grid grid-cols-2 gap-2">
          {[
            { id: 'ask', label: 'Ask each time (Dialog)', desc: 'Show a prompt when files collide' },
            { id: 'overwrite', label: 'Overwrite', desc: 'Replace destination file' },
            { id: 'rename', label: 'Rename automatically', desc: 'Appends (1), (2), etc.' },
            { id: 'skip', label: 'Skip existing files', desc: 'Ignore files that already exist' },
          ].map((opt) => (
            <label
              key={opt.id}
              className={`flex flex-col gap-0.5 rounded-lg border p-3 cursor-pointer transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-500 has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-app-surface ${
                defaultConflictPolicy === opt.id
                  ? 'border-sky-500 bg-sky-500/15 text-sky-200'
                  : 'border-border-subtle bg-app-surface hover:bg-app-surface-hover text-txt-secondary'
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="conflictPolicy"
                  checked={defaultConflictPolicy === opt.id}
                  onChange={() => setDefaultConflictPolicy(opt.id as any)}
                  className="sr-only"
                />
                <span className="font-semibold text-xs text-txt-primary">{opt.label}</span>
              </div>
              <span className="text-xs text-txt-muted">{opt.desc}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-2 pt-2 border-t border-divider">
        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={showHiddenFiles}
            onChange={(e) => setShowHiddenFiles(e.target.checked)}
            className="h-4 w-4 rounded border-border-subtle text-sky-600 focus:ring-sky-500"
          />
          <span className="text-xs text-txt-primary">Show hidden files and dotfiles (.git, .env, etc.)</span>
        </label>

        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={confirmBeforeDelete}
            onChange={(e) => setConfirmBeforeDelete(e.target.checked)}
            className="h-4 w-4 rounded border-border-subtle text-sky-600 focus:ring-sky-500"
          />
          <span className="text-xs text-txt-primary">Confirm before deleting files and folders</span>
        </label>

        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={verifyTransferIntegrity}
            onChange={(e) => setVerifyTransferIntegrity(e.target.checked)}
            className="h-4 w-4 rounded border-border-subtle text-sky-600 focus:ring-sky-500"
          />
          <span className="text-xs text-txt-primary">Verify file integrity and size after transfer</span>
        </label>
      </div>

      {/* Folder organization */}
      <div className="space-y-2 pt-2 border-t border-divider">
        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={shareFoldersAcrossTypes}
            onChange={(e) => setShareFoldersAcrossTypes(e.target.checked)}
            className="h-4 w-4 rounded border-border-subtle text-sky-600 focus:ring-sky-500"
          />
          <span className="text-xs text-txt-primary">
            Share folders between SSH/SFTP and S3 in Connection Manager
          </span>
        </label>
        <p className="pl-6 text-xs text-txt-muted leading-relaxed">
          Off by default: each tab in Connection Manager only shows folders that
          actually contain a profile of that type, so an "S3" folder doesn't sit
          empty under SSH/SFTP. Turn this on to use one shared folder tree across
          both connection types instead.
        </p>
      </div>

      {/* Dotfiles Pool (opt-in) */}
      <div className="space-y-2 pt-2 border-t border-divider">
        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={dotfilesPoolEnabled}
            onChange={(e) => setDotfilesPoolEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-border-subtle text-sky-600 focus:ring-sky-500"
          />
          <span className="text-xs text-txt-primary">
            Enable dotfiles pool sync (off by default)
          </span>
        </label>
        <p className="pl-6 text-xs text-txt-muted leading-relaxed">
          Keeps chosen dotfiles (.bashrc, .vimrc, etc.) present on servers you connect to. Disabled
          here, nothing runs. Even when enabled, a host only syncs after you explicitly assign it a
          pool and a sync policy in its connection profile.
        </p>
        {dotfilesPoolEnabled && (
          <button
            type="button"
            onClick={() => setPoolManagerOpen(true)}
            className="ml-6 flex items-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface px-2.5 py-1.5 text-xs text-sky-400 hover:bg-app-surface-hover transition-colors"
          >
            <FileCode className="h-3.5 w-3.5" />
            Manage Dotfile Pools
          </button>
        )}
      </div>
    </div>
  );
};
