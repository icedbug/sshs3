import { ChevronDown, History, Maximize2, MessageSquare, Minimize2, Plus, Settings as SettingsIcon, Sparkles, X } from "lucide-react";
import { isWebBrowserMode } from "../../../lib/webClientBridge";
import { DEMO_MODE_SET_BY_SERVER, formatCompactTokens, formatUsdCost, getHubViewLabel, TABULAR_NUMS_STYLE } from "../panelShared";
import type { PanelState } from "./usePanelState";

/**
 * The panel's top bar: its title, the model, the view menu, new chat, history, settings and close.
 *
 * A piece of the chat panel (AiHubPanel). What it shows is the panel's own state, `p`: see usePanelState.
 */
export function PanelHeader({ p }: { p: PanelState }): JSX.Element {
  const {
    mode,
    hub,
    activeProfile,
    setSettingsOpen,
    task,
    taskUsage,
    menu,
    setMenu,
    activeView,
    compactModeProp,
    visibleHubViews,
    setKbTabRequest,
    setView,
    handleToggleLabs,
    labsEnabled,
    act,
    newChat,
    setMode,
  } = p;
  return (
    <>
      <header className="ai-hub-header">
        <span className="ai-chat-title">
          <MessageSquare size={16} />
          <strong>{mode === "hub" ? "AI Hub" : "Assistant"}</strong>
          {mode === "hub" && (
            <span className="ai-pill" title="Active workspace hub">
              Workspace
            </span>
          )}
        </span>
        <div className="ai-header-actions">
          {hub && (
            <button
              type="button"
              data-testid="ai-profile-badge"
              className="ai-badge"
              style={{ cursor: "pointer", fontSize: 10.5, padding: "3px 8px" }}
              title={activeProfile.destination}
              onClick={() => setSettingsOpen(true)}
            >
              <Sparkles size={11} style={{ marginRight: 4 }} />
              {activeProfile.label}
            </button>
          )}
          {task && (
            <span
              data-testid="ai-usage-pill"
              className="ai-badge"
              style={{ ...TABULAR_NUMS_STYLE, fontSize: 10.5, padding: "3px 8px" }}
              title={`Tokens this conversation used and their estimated cost in USD${taskUsage.cachedTokens > 0 ? `: ${formatCompactTokens(taskUsage.cachedTokens)} of them read from or written to the prompt cache, which costs less` : ""}`}
            >
              {formatCompactTokens(taskUsage.totalTokens)} tok
              {taskUsage.costUsd > 0 ? ` · ${formatUsdCost(taskUsage.costUsd)}` : " · $0.00"}
            </span>
          )}
          {hub && (
            <div className="ai-menu-anchor">
              <button
                type="button"
                data-testid="ai-view-switcher"
                className="ai-badge"
                style={{ cursor: "pointer", fontSize: 10.5, padding: "3px 8px" }}
                aria-label="Switch hub view"
                aria-expanded={menu === "views"}
                onClick={() => setMenu(menu === "views" ? null : "views")}
              >
                <span>{getHubViewLabel(activeView, { compact: compactModeProp || mode === "panel" })}</span>
                <ChevronDown size={11} style={{ marginLeft: 3 }} />
              </button>
              {menu === "views" && (
                <div className="ai-popover" aria-label="Switch view menu">
                  <strong>Workspace views</strong>
                  {visibleHubViews.map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-current={activeView === v ? "true" : undefined}
                      onClick={() => {
                        setKbTabRequest(undefined);
                        setView(v);
                        setMenu(null);
                      }}
                    >
                      {getHubViewLabel(v, { compact: compactModeProp })}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      handleToggleLabs(!labsEnabled);
                    }}
                  >
                    {labsEnabled ? "Hide Labs views" : "Show Labs views"}
                  </button>
                </div>
              )}
            </div>
          )}
          {hub && (
            <button
              type="button"
              data-testid="ai-hub-demo-toggle"
              className={`ai-badge ${hub.demoMode ? "ai-badge-warn" : ""}`}
              style={{
                cursor: isWebBrowserMode() ? "not-allowed" : "pointer",
                fontSize: 10.5,
                padding: "3px 8px",
              }}
              title={
                isWebBrowserMode()
                  ? DEMO_MODE_SET_BY_SERVER
                  : "Turn the interactive demo lab (a scripted 12-node environment) on or off"
              }
              disabled={isWebBrowserMode()}
              onClick={() =>
                void act({
                  action: "demo-mode-toggle",
                  enabled: !hub.demoMode,
                })
              }
            >
              {hub.demoMode ? "Demo lab: on" : "Demo lab: off"}
            </button>
          )}
          <button
            className="ai-icon-button"
            aria-label="New chat"
            title="New chat"
            onClick={newChat}
          >
            <Plus size={17} />
          </button>
          <button
            className="ai-icon-button"
            aria-label="Chat history"
            title="Chat history"
            aria-expanded={menu === "history"}
            onClick={() => setMenu(menu === "history" ? null : "history")}
          >
            <History size={16} />
          </button>
          <button
            className="ai-icon-button"
            aria-label="AI settings"
            title="AI settings"
            onClick={() => {
              setSettingsOpen(true);
              setMenu(null);
            }}
          >
            <SettingsIcon size={15} />
          </button>
          <button
            className="ai-expand-button"
            aria-label={mode === "hub" ? "Collapse chat" : "Expand chat"}
            title={mode === "hub" ? "Collapse chat to sidebar" : "Expand chat to full view"}
            onClick={() => {
              setMode(mode === "hub" ? "panel" : "hub");
              setMenu(null);
            }}
          >
            {mode === "hub" ? (
              <>
                <Minimize2 size={14} />
                <span>Sidebar</span>
              </>
            ) : (
              <>
                <Maximize2 size={14} />
                <span>Full view</span>
              </>
            )}
          </button>
          <button
            className="ai-icon-button"
            aria-label="Close AI panel"
            title="Close chat"
            onClick={() => setMode("closed")}
          >
            <X size={16} />
          </button>
        </div>
      </header>
    </>
  );
}
