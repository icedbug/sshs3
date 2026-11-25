import { lazy, Suspense } from "react";
import type { PanelState } from "./usePanelState";
import { hubRequest, selectAiTerminal } from "../../../lib/aiHub";
import { ErrorBoundary } from "../../ErrorBoundary";
const Memory = lazy(() => import("../MemoryView").then((m) => ({ default: m.Memory })));
const Schedules = lazy(() => import("../SchedulesView").then((m) => ({ default: m.Schedules })));
const ChangesView = lazy(() => import("../ChangesView").then((m) => ({ default: m.ChangesView })));
const WorkforceView = lazy(() => import("../WorkforceView").then((m) => ({ default: m.WorkforceView })));
const InboxView = lazy(() => import("../InboxView").then((m) => ({ default: m.InboxView })));
const InfrastructureView = lazy(() => import("../InfrastructureView").then((m) => ({ default: m.InfrastructureView })));
const AgentsAndMcpView = lazy(() => import("../AgentsAndMcpView").then((m) => ({ default: m.AgentsAndMcpView })));
const KnowledgeBaseView = lazy(() => import("../KnowledgeBaseView").then((m) => ({ default: m.KnowledgeBaseView })));

/**
 * The hub's views other than the chat: Inbox, Workforce, Agents & MCP, Knowledge Base, Infrastructure, Changes, Memory & skills and Schedules.
 *
 * A piece of the chat panel (AiHubPanel). What it shows is the panel's own state, `p`: see usePanelState.
 */
export function OtherViews({ p, hub }: { p: PanelState; hub: NonNullable<PanelState["hub"]> }): JSX.Element {
  const {
    activeView,
    act,
    chooseTask,
    setView,
    setKbTabRequest,
    setWorkforceTicketId,
    focusInboxItem,
    workforceTicketId,
    selectedAgentId,
    setSelectedAgentId,
    newChat,
    setAutonomy,
    kbTabRequest,
    handleOpenFileRef,
    terminalHandoff,
    setPrompt,
    composer,
    setAttachments,
    busy,
    task,
  } = p;
  return (
    // A view that fails to draw, or whose files could not be loaded, leaves the rest of the panel working.
    // Choosing another view draws afresh.
    <ErrorBoundary what="This view" resetKey={activeView}>
    <Suspense fallback={<p role="status">Opening view…</p>}>
          {activeView === "Inbox" && (
            <InboxView
              hub={hub}
              act={act}
              onOpenTask={(id) => {
                chooseTask(id);
                setView("Work");
              }}
              onOpenView={(next, detail) => {
                if (next === "Knowledge Base" && detail?.kbTab) {
                  setKbTabRequest((prev) => ({ tab: detail.kbTab!, seq: (prev?.seq ?? 0) + 1 }));
                } else {
                  setKbTabRequest(undefined);
                }
                setView(next);
              }}
              onOpenTicket={(id) => {
                setWorkforceTicketId(id);
                setView("Workforce");
              }}
              focusItemId={focusInboxItem}
              onRequest={act}
            />
          )}
          {activeView === "Workforce" && (
            <WorkforceView
              hub={hub}
              act={act}
              openTicketId={workforceTicketId}
              onOpenTask={(id) => {
                chooseTask(id);
                setView("Work");
              }}
            />
          )}
          {activeView === "Agents & MCP" && (
            <AgentsAndMcpView
              hub={hub}
              act={act}
              selectedAgentId={selectedAgentId}
              onSelectAgentForChat={(id) => {
                newChat();
                setSelectedAgentId(id);
                const ag = hub.agents?.find((x) => x.id === id);
                if (ag) setAutonomy(ag.defaultMode);
                setView("Work");
              }}
              onStartedMission={(newTaskId) => {
                if (newTaskId) chooseTask(newTaskId);
                setView("Work");
              }}
            />
          )}
          {activeView === "Knowledge Base" && (
            <KnowledgeBaseView
              hub={hub}
              act={act}
              request={hubRequest}
              openTab={kbTabRequest}
              onOpenFileRef={handleOpenFileRef}
              onRunStepInTerminal={terminalHandoff.runStep}
              onAskAiStep={(stepPrompt) => {
                setPrompt(stepPrompt);
                setView("Work");
                setTimeout(() => composer.current?.focus(), 30);
              }}
              onAttachDoc={(doc) => {
                const slug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
                setAttachments((old) => [
                  ...old.filter((x) => x.label !== `@kb:${slug}`).slice(-9),
                  {
                    id: crypto.randomUUID(),
                    label: `@kb:${slug}`,
                    text: `# KB Document: ${doc.title} (${doc.collection})\n\n${doc.content.slice(0, 8000)}`,
                    observedAt: Date.now(),
                  },
                ]);
                setView("Work");
              }}
              onRunRunbook={(doc) => {
                const slug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
                // A new conversation first: opening one empties the composer, so what goes into it comes after.
                chooseTask("");
                setAttachments((old) => [
                  ...old.filter((x) => x.label !== `@kb:${slug}`).slice(-9),
                  {
                    id: crypto.randomUUID(),
                    label: `@kb:${slug}`,
                    text: `# KB Document: ${doc.title} (${doc.collection})\n\n${doc.content.slice(0, 8000)}`,
                    observedAt: Date.now(),
                  },
                ]);
                setPrompt(
                  `Follow our runbook "${doc.title}" (${doc.collection || "general"}) step by step. Start with read-only checks and summarise the state.`,
                );
                setView("Work");
              }}
            />
          )}
          {activeView === "Infrastructure" && (
            <InfrastructureView
              hub={hub}
              act={act}
              busy={busy}
              onUseTerminal={(sessionId) => {
                selectAiTerminal(sessionId);
                chooseTask("");
                setView("Work");
              }}
              onOpenTerminal={(serverId) => {
                const srv = (hub.workspaceServers ?? []).find((s) => s.id === serverId || s.name === serverId);
                const existing = hub.sessions.find(
                  (s) =>
                    s.state !== "disconnected" &&
                    (s.id === serverId || (srv && s.label.toLowerCase().includes(srv.name.toLowerCase()))),
                );
                if (existing) {
                  selectAiTerminal(existing.id);
                } else {
                  window.dispatchEvent(new CustomEvent("sshs3:open-cluster-split", { detail: { serverIds: [srv?.id ?? serverId] } }));
                }
                if (p.mode === "hub") p.setMode("panel");
              }}
              onAsk={(text, attach, sessionId) => {
                if (sessionId) selectAiTerminal(sessionId);
                // A new conversation first: opening one empties the composer, so what goes into it comes after.
                chooseTask("");
                if (attach)
                  setAttachments((old) => [
                    ...old.filter((x) => x.label !== attach.label).slice(-9),
                    { id: crypto.randomUUID(), observedAt: Date.now(), ...attach },
                  ]);
                if (text) setPrompt(text);
                setView("Work");
              }}
            />
          )}
          {activeView === "Changes" && (
            <ChangesView
              hub={hub}
              request={hubRequest}
              onOpenTask={(id) => {
                chooseTask(id);
                setView("Work");
              }}
            />
          )}
          {activeView === "Memory & skills" && (
            <Memory
              hub={hub}
              act={act}
              request={hubRequest}
              onOpenTask={(id) => {
                chooseTask(id);
                setView("Work");
              }}
              suggestion={
                task?.messages
                  .filter((m) => m.role === "assistant")
                  .map((m) => m.text)
                  .join("\n\n") ?? ""
              }
            />
          )}
          {activeView === "Schedules" && (
            <Schedules
              hub={hub}
              act={act}
              onOpenTask={(id) => {
                chooseTask(id);
                setView("Work");
              }}
            />
          )}
    </Suspense>
    </ErrorBoundary>
  );
}
