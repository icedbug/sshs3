import React, { useState } from 'react';
import { Terminal, Monitor, Moon, Sun, Sliders, FolderTree } from 'lucide-react';
import type { SettingsForm } from './useSettingsForm';
import { ManagedGroup } from './Managed';

/** The "General" page of the settings dialog. */
export const GeneralSettingsSection: React.FC<{ form: SettingsForm }> = ({ form }) => {
  const {
    theme,
    setTheme,
    autoCheckUpdates,
    setAutoCheckUpdates,
    confirmBeforeQuit,
    setConfirmBeforeQuit,
    enableGlobalSearch,
    setEnableGlobalSearch,
    logLevel,
    setLogLevel,
    defaultNewTab,
    setDefaultNewTab,
    updateState,
    isManaged,
  } = form;
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);

  const copyDiagnostics = async (): Promise<void> => {
    try {
      const text = await window.multissh?.getDiagnostics();
      if (text) await navigator.clipboard.writeText(text);
      setDiagnosticsCopied(true);
      window.setTimeout(() => setDiagnosticsCopied(false), 2000);
    } catch {
      setDiagnosticsCopied(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Theme */}
      <div className="space-y-2">
        <div id="color-theme-label" className="text-xs font-medium text-txt-primary">Color Theme</div>
        <div role="radiogroup" aria-labelledby="color-theme-label" className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <label
            className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-xs font-medium cursor-pointer transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-500 has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-app-surface ${
              theme === 'dark'
                ? 'border-sky-500 bg-sky-500/15 text-sky-300'
                : 'border-border-subtle bg-app-surface text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
            }`}
          >
            <input
              type="radio"
              name="colorTheme"
              checked={theme === 'dark'}
              onChange={() => setTheme('dark')}
              className="sr-only"
            />
            <Moon className="h-4 w-4 text-sky-400" />
            Dark
          </label>
          <label
            className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-xs font-medium cursor-pointer transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-500 has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-app-surface ${
              theme === 'light'
                ? 'border-sky-500 bg-sky-500/15 text-sky-300'
                : 'border-border-subtle bg-app-surface text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
            }`}
          >
            <input
              type="radio"
              name="colorTheme"
              checked={theme === 'light'}
              onChange={() => setTheme('light')}
              className="sr-only"
            />
            <Sun className="h-4 w-4 text-amber-400" />
            Light
          </label>
          <label
            className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-xs font-medium cursor-pointer transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-500 has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-app-surface ${
              theme === 'breeze'
                ? 'border-sky-500 bg-sky-500/15 text-sky-300'
                : 'border-border-subtle bg-app-surface text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
            }`}
          >
            <input
              type="radio"
              name="colorTheme"
              checked={theme === 'breeze'}
              onChange={() => setTheme('breeze')}
              className="sr-only"
            />
            <Sliders className="h-4 w-4 text-cyan-400" />
            Breeze
          </label>
          <label
            className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-xs font-medium cursor-pointer transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-500 has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-app-surface ${
              theme === 'system'
                ? 'border-sky-500 bg-sky-500/15 text-sky-300'
                : 'border-border-subtle bg-app-surface text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
            }`}
          >
            <input
              type="radio"
              name="colorTheme"
              checked={theme === 'system'}
              onChange={() => setTheme('system')}
              className="sr-only"
            />
            <Monitor className="h-4 w-4 text-sky-400" />
            System
          </label>
        </div>
      </div>

      {/* Default New Tab Type */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-txt-primary">Default Tab Type</label>
        <div className="grid grid-cols-2 gap-2.5">
          <label
            className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-xs font-medium cursor-pointer transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-500 has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-app-surface ${
              defaultNewTab === 'terminal'
                ? 'border-sky-500 bg-sky-500/15 text-sky-300'
                : 'border-border-subtle bg-app-surface text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
            }`}
          >
            <input
              type="radio"
              name="defaultTab"
              checked={defaultNewTab === 'terminal'}
              onChange={() => setDefaultNewTab('terminal')}
              className="sr-only"
            />
            <Terminal className="h-4 w-4 text-sky-400" />
            <span>Terminal</span>
          </label>

          <label
            className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-xs font-medium cursor-pointer transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-500 has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-app-surface ${
              defaultNewTab === 'filemanager'
                ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                : 'border-border-subtle bg-app-surface text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
            }`}
          >
            <input
              type="radio"
              name="defaultTab"
              checked={defaultNewTab === 'filemanager'}
              onChange={() => setDefaultNewTab('filemanager')}
              className="sr-only"
            />
            <FolderTree className="h-4 w-4 text-amber-400" />
            <span>File Manager</span>
          </label>
        </div>
      </div>

      {/* App Behavior */}
      <div className="space-y-2 pt-2 border-t border-divider">
        <label className="text-xs font-medium text-txt-primary">App Behavior</label>
        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={confirmBeforeQuit}
            onChange={(e) => setConfirmBeforeQuit(e.target.checked)}
            className="h-4 w-4 rounded border-border-subtle text-sky-600 focus:ring-sky-500"
          />
          <span className="text-xs text-txt-primary">Confirm before quitting the app</span>
        </label>
        <p className="text-xs text-txt-muted pl-6">
          Ask for confirmation when closing the window or quitting, so active SSH
          sessions and tunnels aren't closed by accident.
        </p>
        <label className="flex items-center gap-2.5 cursor-pointer pt-1">
          <input
            type="checkbox"
            checked={enableGlobalSearch}
            onChange={(e) => setEnableGlobalSearch(e.target.checked)}
            className="h-4 w-4 rounded border-border-subtle text-sky-600 focus:ring-sky-500"
          />
          <span className="text-xs text-txt-primary">Enable global search</span>
        </label>
        <p className="text-xs text-txt-muted pl-6">
          Adds a search button to the top bar and the shortcut to find a profile, an open tab or a user@host
          from anywhere.
        </p>
        <ManagedGroup managed={isManaged('autoCheckUpdates')} indentNotice>
          <label className="flex items-center gap-2.5 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={autoCheckUpdates && updateState?.unsupportedReason !== 'disabled'}
              disabled={updateState?.unsupportedReason === 'disabled'}
              onChange={(e) => setAutoCheckUpdates(e.target.checked)}
              className="h-4 w-4 rounded border-border-subtle text-sky-600 focus:ring-sky-500"
            />
            <span className="text-xs text-txt-primary">Check for updates automatically</span>
          </label>
        </ManagedGroup>
        <div className="flex items-center gap-2 pl-6 text-xs text-txt-muted">
          <span data-testid="update-status">
            Version {updateState?.currentVersion ?? '…'}
            {updateState?.status === 'checking' && ' · checking…'}
            {updateState?.status === 'up-to-date' && ' · up to date'}
            {updateState?.status === 'error' && ` · ${updateState.error ?? 'update check failed'}`}
            {updateState?.status === 'available' && ` · ${updateState.version ?? ''} available`}
            {updateState?.status === 'downloading' &&
              ` · downloading ${updateState.version ?? ''} (${updateState.progress ?? 0}%)`}
            {updateState?.status === 'ready' &&
              ` · ${updateState.version ?? ''} downloaded, restart to install`}
            {updateState?.status === 'unsupported' &&
              (updateState.unsupportedReason === 'windows-unsigned'
                ? ' · download new versions manually (Windows builds are not code-signed yet)'
                : updateState.unsupportedReason === 'not-installer'
                  ? ' · this copy was not installed with the sshs3 installer (MSI, ZIP or portable), so new versions come the same way it did'
                  : updateState.unsupportedReason === 'disabled'
                    ? ' · updates are disabled by the administrator'
                    : ' · updates are disabled in development')}
          </span>
          {updateState?.status === 'unsupported' && updateState.unsupportedReason === 'windows-unsigned' && (
            <button
              type="button"
              onClick={() =>
                void window.multissh?.openExternal('https://github.com/alun-hub/sshs3/releases/latest')
              }
              className="rounded border border-border-subtle px-2 py-0.5 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary disabled:opacity-50"
            >
              Open releases
            </button>
          )}
          {updateState?.status === 'available' && (
            <button type="button" onClick={() => void window.multissh?.downloadUpdate()} className="rounded border border-border-subtle px-2 py-0.5 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary disabled:opacity-50">
              Download
            </button>
          )}
          {updateState?.status === 'ready' && (
            <button type="button" onClick={() => void window.multissh?.installUpdate()} className="rounded border border-border-subtle px-2 py-0.5 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary disabled:opacity-50">
              Restart and install
            </button>
          )}
          {updateState &&
            updateState.status !== 'unsupported' &&
            updateState.status !== 'available' &&
            updateState.status !== 'ready' && (
              <button
                type="button"
                disabled={updateState.status === 'checking' || updateState.status === 'downloading'}
                onClick={() => void window.multissh?.checkForUpdates()}
                className="rounded border border-border-subtle px-2 py-0.5 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary disabled:opacity-50"
              >
                Check now
              </button>
            )}
        </div>
      </div>

      {/* Logging */}
      <div className="space-y-2 pt-2 border-t border-divider">
        <label htmlFor="log-level" className="text-xs font-medium text-txt-primary">
          Logging
        </label>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            id="log-level"
            value={logLevel}
            onChange={(e) => setLogLevel(e.target.value as typeof logLevel)}
            className="rounded border border-border-subtle bg-app-surface px-2 py-1 text-txt-primary focus:border-sky-500 focus:outline-none"
          >
            <option value="error">Errors only</option>
            <option value="warn">Warnings</option>
            <option value="info">Normal</option>
            <option value="debug">Debug (verbose)</option>
          </select>
          <button
            type="button"
            onClick={() => void window.multissh?.openLogFolder()}
            className="rounded border border-border-subtle px-2 py-1 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary"
          >
            Open log folder
          </button>
          <button
            type="button"
            onClick={() => void copyDiagnostics()}
            className="rounded border border-border-subtle px-2 py-1 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary"
          >
            {diagnosticsCopied ? 'Copied' : 'Copy diagnostics'}
          </button>
        </div>
        <p className="text-xs text-txt-muted">
          Logs are stored locally and PINs, passwords and keys are never written. Use Debug while reproducing a
          problem, then copy the diagnostics for a bug report.
        </p>
      </div>
    </div>
  );
};
