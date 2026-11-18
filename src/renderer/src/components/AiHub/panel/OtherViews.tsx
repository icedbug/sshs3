import { hubRequest, selectAiTerminal } from "../../../lib/aiHub";
import { Memory } from "../MemoryView";
import { Schedules } from "../SchedulesView";
import { ChangesView } from "../ChangesView";
import { WorkforceView } from "../WorkforceView";
import { InboxView } from "../InboxView";
import { InfrastructureView } from "../InfrastructureView";
import { AgentsAndMcpView } from "../AgentsAndMcpView";
import { KnowledgeBaseView } from "../KnowledgeBaseView";
import type { PanelState } from "./usePanelState";

/**
 * The hub's views other than the chat: Inbox, Workforce, Agents & MCP, Knowledge Base, Infrastructure, Changes, Memory & skills and Schedules.
 *
 * A piece of the chat panel (AiHubPanel). What it shows is the panel's own state, `p`: see usePanelState.
 */
export function OtherViews({ p, hub }: { p: PanelState; hub: NonNullable<PanelState["hub"]> }): JSX.Element {
  const {
    activeView,
    act,
    setTaskId,
    setView,
    setKbTabRequest,
    setWorkforceTicketId,
    focusInboxItem,
    workforceTicketId,
    selectedAgentId,
    setSelectedAgentId,
    setAutonomy,
    kbTabRequest,
    handleOpenFileRef,
    runCommandInTerminal,
    setPrompt,
    composer,
    setAttachments,
    busy,
    task,
  } = p;
  return (
    <>
          {activeView === "Inbox" && (
            <InboxView
              hub={hub}
              act={act}
              onOpenTask={(id) => {
                setTaskId(id);
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
                setTaskId(id);
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
                setSelectedAgentId(id);
                const ag = hub.agents?.find((x) => x.id === id);
                if (ag) setAutonomy(ag.defaultMode);
                setView("Work");
              }}
              onStartedMission={(newTaskId) => {
                if (newTaskId) setTaskId(newTaskId);
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
              onRunStepInTerminal={(command) => runCommandInTerminal(command)}
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
                setAttachments((old) => [
                  ...old.filter((x) => x.label !== `@kb:${slug}`).slice(-9),
                  {
                    id: crypto.randomUUID(),
                    label: `@kb:${slug}`,
                    text: `# KB Document: ${doc.title} (${doc.collection})\n\n${doc.content.slice(0, 8000)}`,
                    observedAt: Date.now(),
                  },
                ]);
                setTaskId("");
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
                setTaskId("");
                setView("Work");
              }}
              onAsk={(text, attach, sessionId) => {
                if (sessionId) selectAiTerminal(sessionId);
                if (attach)
                  setAttachments((old) => [
                    ...old.filter((x) => x.label !== attach.label).slice(-9),
                    { id: crypto.randomUUID(), observedAt: Date.now(), ...attach },
                  ]);
                if (text) setPrompt(text);
                setTaskId("");
                setView("Work");
              }}
            />
          )}
          {activeView === "Changes" && (
            <ChangesView
              hub={hub}
              request={hubRequest}
              onOpenTask={(id) => {
                setTaskId(id);
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
                setTaskId(id);
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
                setTaskId(id);
                setView("Work");
              }}
            />
          )}
    </>
  );
}
