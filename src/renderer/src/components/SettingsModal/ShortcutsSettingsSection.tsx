import React from 'react';
import { RotateCcw, Search } from 'lucide-react';
import type { SettingsForm } from './useSettingsForm';

/** The "Keyboard Shortcuts" page of the settings dialog. */
export const ShortcutsSettingsSection: React.FC<{ form: SettingsForm }> = ({ form }) => {
  const {
    shortcuts,
    recordingAction,
    setRecordingAction,
    recordingPreview,
    handleKeyUpRecord,
    shortcutSearch,
    setShortcutSearch,
    handleResetShortcuts,
    handleKeyDownRecord,
    filteredShortcuts,
  } = form;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-txt-muted" />
          <input
            aria-label="Search keyboard shortcuts"
            type="text"
            placeholder="Search keyboard shortcuts..."
            value={shortcutSearch}
            onChange={(e) => setShortcutSearch(e.target.value)}
            className="w-full rounded-lg border border-border-subtle bg-app-surface py-1.5 pl-8 pr-3 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
          />
        </div>
        <button
          type="button"
          onClick={handleResetShortcuts}
          className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface px-2.5 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary shrink-0 transition-colors"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          <span>Reset Defaults</span>
        </button>
      </div>

      <div className="space-y-1">
        {filteredShortcuts.map((def) => {
          const currentKey = shortcuts[def.id] || def.defaultKeys;
          const isRecording = recordingAction === def.id;

          return (
            <div
              key={def.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-app-surface px-3 py-1.5 text-xs"
            >
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate font-medium text-txt-primary">{def.name}</span>
                <span className="shrink-0 text-2xs text-txt-muted">{def.category}</span>
              </div>

              <div>
                {isRecording ? (
                  <button
                    type="button"
                    data-shortcut-recording="true"
                    onKeyDown={(e) => handleKeyDownRecord(e, def.id)}
                    onKeyUp={handleKeyUpRecord}
                    autoFocus
                    className="rounded-md border border-sky-500 bg-sky-950 px-2.5 py-0.5 font-mono text-xs text-sky-300 outline-none animate-pulse"
                  >
                    {recordingPreview ? `${recordingPreview}+...` : 'Press keys (Esc to cancel)...'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setRecordingAction(def.id)}
                    className="rounded-md border border-border-subtle bg-app-input px-2.5 py-0.5 font-mono text-xs text-txt-primary hover:border-sky-500 hover:text-sky-400 transition-colors"
                  >
                    {currentKey}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
