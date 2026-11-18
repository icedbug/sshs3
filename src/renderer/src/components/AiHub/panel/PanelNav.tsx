import { countWaitingInboxItems } from "@shared/aiHubInbox";
import { FlaskConical, MessageSquare, Plus, X } from "lucide-react";
import { getHubViewLabel } from "../panelShared";
import { isConversation } from "../workforceModel";
import { View, isModelSetupMessage } from "./panelHelpers";
import type { PanelState } from "./usePanelState";

/**
 * Under the top bar: the conversation history menu, the tabs of the hub's views, and an error or a notice.
 *
 * A piece of the chat panel (AiHubPanel). What it shows is the panel's own state, `p`: see usePanelState.
 */
export function PanelNav({ p }: { p: PanelState }): JSX.Element {
  const {
    menu,
    newChat,
    hub,
    taskId,
    chooseTask,
    mode,
    visibleHubViews,
    activeView,
    setKbTabRequest,
    setView,
    setMenu,
    compactModeProp,
    labsEnabled,
    handleToggleLabs,
    error,
    setSettingsOpen,
    setError,
    notice,
    setNotice,
  } = p;
  return (
    <>
      {menu === "history" && (
        <div className="ai-history" aria-label="Conversation history">
          <button className="ai-history-new" onClick={newChat}>
            <Plus size={14} /> New chat
          </button>
          {!hub?.tasks.some(isConversation) && (
            <p className="ai-hint">Your conversations will appear here.</p>
          )}
          {/* Same list as the sidebar: background runs are not conversations. */}
          {[...(hub?.tasks ?? [])].filter(isConversation).reverse().map((t) => (
            <button
              className="ai-history-entry"
              key={t.id}
              aria-current={t.id === taskId ? "true" : undefined}
              onClick={() => chooseTask(t.id)}
            >
              <MessageSquare size={14} />
              <span>
                {t.title}
                <small>{new Date(t.updatedAt).toLocaleDateString()}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      <nav aria-label="Hub views" className={mode === "hub" ? "ai-nav-rail" : undefined}>
        {(mode === "hub"
          ? visibleHubViews
          : (["Work", "Inbox", "Workforce", "Knowledge Base"] as View[])
        ).map((name) => {
          const badgeCount =
            name === "Inbox"
              ? // What still waits for somebody: an alert that was acknowledged stays listed and is not counted.
                (hub ? countWaitingInboxItems(hub) : 0)
              : name === "Workforce"
              ? (hub?.workTickets ?? []).filter((t) => t.status === "review" || t.status === "in_progress").length
              : name === "Agents & MCP"
              ? (hub?.agents?.length ?? 0) + (hub?.mcpServers?.length ?? 0)
              : name === "Knowledge Base"
                ? (hub?.kbDocuments?.length ?? 0)
                : name === "Memory & skills"
                  ? (hub?.memories ?? []).filter((m) => !m.id.startsWith("auto-node:") && !m.id.startsWith("auto-cluster:")).length
                  : name === "Schedules"
                    ? (hub?.schedules?.length ?? 0)
                    : 0;
          return (
            <button
              key={name}
              aria-current={activeView === name ? "page" : undefined}
              onClick={() => {
                setKbTabRequest(undefined);
                setView(name);
                setMenu(null);
              }}
            >
              <span>{getHubViewLabel(name, { compact: compactModeProp || mode === "panel" })}</span>
              {badgeCount > 0 && (
                <span className="ai-nav-badge">{badgeCount}</span>
              )}
            </button>
          );
        })}
        {mode === "hub" && (
          <button
            type="button"
            data-testid="ai-hub-labs-toggle"
            className={`ai-labs-nav-toggle ${labsEnabled ? "active" : ""}`}
            aria-pressed={labsEnabled}
            title="Show or hide Labs views (Memory & skills, Agents & MCP, Schedules)"
            onClick={() => handleToggleLabs(!labsEnabled)}
          >
            <FlaskConical size={12} />
            <span>{labsEnabled ? "More: on" : "More: Memory, Agents & MCP, Schedules"}</span>
          </button>
        )}
      </nav>
      {error && (
        <div className="ai-error" role="alert">
          {error}
          {isModelSetupMessage(error) && (
            <button type="button" className="ai-code-btn" onClick={() => setSettingsOpen(true)}>
              Open AI settings
            </button>
          )}
          <button
            className="ai-icon-button"
            aria-label="Dismiss error"
            onClick={() => setError("")}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {notice && (
        <div className="ai-error ai-notice" role="status">
          {notice}
          <button
            className="ai-icon-button"
            aria-label="Dismiss note"
            onClick={() => setNotice("")}
          >
            <X size={13} />
          </button>
        </div>
      )}
    </>
  );
}
