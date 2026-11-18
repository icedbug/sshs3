import { X } from "lucide-react";
import { Settings } from "../SettingsView";
import type { PanelState } from "./usePanelState";

/**
 * The AI settings, over the panel.
 *
 * A piece of the chat panel (AiHubPanel). What it shows is the panel's own state, `p`: see usePanelState.
 */
export function SettingsOverlay({ p }: { p: PanelState }): JSX.Element {
  const {
    settingsOpen,
    hub,
    setSettingsOpen,
    modal,
    error,
    act,
    labsEnabled,
    handleToggleLabs,
  } = p;
  return (
    <>
      {settingsOpen && hub && (
        <div
          className="ai-settings-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSettingsOpen(false);
          }}
        >
          <div
            className="ai-settings-dialog"
            ref={modal}
            role="dialog"
            aria-modal="true"
            aria-label="AI settings"
          >
            <header>
              <strong>AI settings</strong>
              <button
                className="ai-icon-button"
                aria-label="Close AI settings"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={17} />
              </button>
            </header>
            {error && (
              <p className="ai-error" role="alert">
                {error}
              </p>
            )}
            <Settings
              hub={hub}
              act={act}
              labsEnabled={labsEnabled}
              onToggleLabs={handleToggleLabs}
            />
          </div>
        </div>
      )}
    </>
  );
}
