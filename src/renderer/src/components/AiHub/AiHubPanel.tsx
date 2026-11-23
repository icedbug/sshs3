import { isWebBrowserMode } from "../../lib/webClientBridge";
import type { FileRef } from "./reportRefs";
import "./aiHub.css";
import { usePanelState } from "./panel/usePanelState";
import { PanelHeader } from "./panel/PanelHeader";
import { PanelNav } from "./panel/PanelNav";
import { ScenarioBar } from "./panel/ScenarioBar";
import { WorkSidebar } from "./panel/WorkSidebar";
import { Welcome } from "./panel/Welcome";
import { TaskContextBar } from "./panel/TaskContextBar";
import { Timeline } from "./panel/Timeline";
import { ConversationTail } from "./panel/ConversationTail";
import { AboveComposer } from "./panel/AboveComposer";
import { ComposerContextRow } from "./panel/ComposerContextRow";
import { ComposerInput } from "./panel/ComposerInput";
import { ComposerFooter } from "./panel/ComposerFooter";
import { OtherViews } from "./panel/OtherViews";
import { SettingsOverlay } from "./panel/SettingsOverlay";

export interface AiHubPanelProps {
  mode: "closed" | "panel" | "hub";
  setMode: (value: "closed" | "panel" | "hub") => void;
  width?: number;
  onResizeWidth?: (width: number) => void;
  /** Optional per-tab active task id. */
  initialTaskId?: string;
  /** Called whenever the active task id changes inside the panel. */
  onTaskChange?: (taskId: string) => void;
  /** Optional terminal session id bound to this tab's AI dock. */
  boundTerminalId?: string;
  /** Optional compact navigation label preference. */
  compactMode?: boolean;
  /** Optional handler invoked when clicking a `host:/path:line` or `/path:line` citation. */
  onOpenFileRef?: (ref: FileRef) => void;
}

/**
 * The AI chat panel: the side panel beside a terminal, and the full AI Hub.
 *
 * What it holds and does is in panel/usePanelState; what it draws is in the pieces in panel/. This
 * file calls the first and lays out the second.
 */
export function AiHubPanel(props: AiHubPanelProps): JSX.Element {
  const p = usePanelState(props);
  const {
    mode,
    width,
    setMenu,
    onResizeWidth,
    hub,
    activeView,
    conversation,
    follow,
    end,
  } = p;
  if (mode === "closed") return <aside hidden aria-label="AI chat" />;
  return (
    <aside
      // In the browser a floating account bar sits at the bottom right; the panel leaves room for it.
      className={"ai-hub ai-hub-" + mode + (isWebBrowserMode() ? " ai-hub-web" : "")}
      style={mode === "panel" && width ? { width: `${width}px` } : undefined}
      aria-label="AI chat"
      onKeyDown={(e) => {
        if (e.key === "Escape") setMenu(null);
      }}
    >
      {mode === "panel" && onResizeWidth && (
        <div
          className="ai-hub-resize-handle"
          title="Drag to resize AI panel"
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = width ?? 420;
            const onMove = (moveEvent: MouseEvent): void => {
              const delta = startX - moveEvent.clientX;
              const nextWidth = Math.min(
                900,
                Math.max(300, startWidth + delta),
              );
              onResizeWidth(nextWidth);
            };
            const onUp = (): void => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
        />
      )}
      <PanelHeader p={p} />
      <PanelNav p={p} />
      <ScenarioBar p={p} />
      {!hub ? (
        <p className="ai-empty">Connecting…</p>
      ) : (
        <>
          {activeView === "Work" && (
            <div className="ai-work-layout">
              <WorkSidebar p={p} hub={hub} />
              <div className="ai-chat-body">
              <div
                className="ai-scroll ai-conversation"
                ref={conversation}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  follow.current =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                }}
              >
                <Welcome p={p} hub={hub} />
                <TaskContextBar p={p} hub={hub} />
                <Timeline p={p} />
                <ConversationTail p={p} hub={hub} />
                <div ref={end} />
              </div>
              <AboveComposer p={p} />
              <div className="ai-composer">
                <ComposerContextRow p={p} hub={hub} />
                <ComposerInput p={p} />
                <ComposerFooter p={p} hub={hub} />
              </div>
            </div>
            </div>
          )}
          <OtherViews p={p} hub={hub} />
        </>
      )}
      <SettingsOverlay p={p} />
    </aside>
  );
}
