import { X } from "lucide-react";
import { lazy, Suspense } from "react";
import type { PanelState } from "./usePanelState";
import { ErrorBoundary } from "../../ErrorBoundary";

const Settings = lazy(() => import("../SettingsView").then((m) => ({ default: m.Settings })));

/**
 * The AI settings, over the panel.
 *
 * A piece of the chat panel (AiHubPanel). What it shows is the panel's own state, `p`: see usePanelState.
 */
export function SettingsOverlay({ p }: { p: PanelState }): JSX.Element {
  const {
    settingsOpen,
    hub,
    closeSettings,
    settingsAsking,
    setSettingsAsking,
    setSettingsUnsaved,
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
            if (e.target === e.currentTarget) closeSettings();
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
                onClick={() => closeSettings()}
              >
                <X size={17} />
              </button>
            </header>
            {settingsAsking && (
              <div className="ai-note" role="alertdialog" aria-label="Changes that are not saved" data-testid="ai-settings-unsaved">
                <span>Your changes are not saved yet.</span>
                <div className="ai-card-actions">
                  <button type="button" className="ai-btn-accent" autoFocus onClick={() => setSettingsAsking(false)}>
                    Keep editing
                  </button>
                  <button type="button" className="ai-btn-danger" onClick={() => closeSettings(true)}>
                    Close without saving
                  </button>
                </div>
              </div>
            )}
            {error && (
              <p className="ai-error" role="alert">
                {error}
              </p>
            )}
            <ErrorBoundary what="The settings">
              <Suspense fallback={<p role="status">Opening settings…</p>}>
                <Settings
                  hub={hub}
                  act={act}
                  error={error}
                  labsEnabled={labsEnabled}
                  onToggleLabs={handleToggleLabs}
                  onUnsavedChange={setSettingsUnsaved}
                />
              </Suspense>
            </ErrorBoundary>
          </div>
        </div>
      )}
    </>
  );
}
