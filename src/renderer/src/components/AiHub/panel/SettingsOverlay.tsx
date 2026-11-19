import { X } from "lucide-react";
import { lazy, Suspense } from "react";
import type { PanelState } from "./usePanelState";

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
            <Suspense fallback={<p role="status">Opening settings…</p>}>
              <Settings
                hub={hub}
                act={act}
                labsEnabled={labsEnabled}
                onToggleLabs={handleToggleLabs}
              />
            </Suspense>
          </div>
        </div>
      )}
    </>
  );
}
