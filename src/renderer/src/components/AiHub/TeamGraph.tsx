import { useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { layoutOrg, tokens, type AgentLive } from "./workforceModel";

type AgentNodeData = { live: AgentLive; selected: boolean };

const STATE_TEXT: Record<AgentLive["state"], string> = {
  working: "working",
  waiting: "needs you",
  paused: "paused",
  "out-of-budget": "out of budget",
  idle: "idle",
};

function AgentNode({ data }: NodeProps<Node<AgentNodeData>>): JSX.Element {
  const { live, selected } = data;
  const share = live.budget ? Math.min(1, live.spent / live.budget) : 0;
  return (
    <div className={`ai-org-node ai-org-${live.state} ${selected ? "ai-org-selected" : ""}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="ai-org-head">
        <span className="ai-org-dot" />
        <strong>{live.agent.name}</strong>
        <span className="ai-org-state">{STATE_TEXT[live.state]}</span>
      </div>
      <small>
        {live.agent.role}
        {live.agent.runnerId ? ` · ${live.agent.runnerId}` : ""}
      </small>
      {live.ticket ? (
        <div className="ai-org-ticket">
          <span>{live.ticket.title}</span>
          <em>{live.doing}</em>
        </div>
      ) : (
        <div className="ai-org-ticket ai-org-quiet">
          <em>{live.doing || (live.open ? `${live.open} open ticket${live.open === 1 ? "" : "s"}` : "No tickets")}</em>
        </div>
      )}
      {live.budget ? (
        <div className="ai-org-budget" title={`${tokens(live.spent)} of ${tokens(live.budget)} tokens this month`}>
          <span style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { agent: AgentNode };

/** The team as a tree that moves: who reports to whom, and what each one is doing now. */
export function TeamGraph({
  team,
  selectedId,
  onSelect,
}: {
  team: AgentLive[];
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
}): JSX.Element {
  const { nodes, edges } = useMemo(() => {
    const placed = layoutOrg(team.map((t) => t.agent));
    const byId = new Map(team.map((t) => [t.agent.id, t]));
    const nodes: Node<AgentNodeData>[] = placed.map((p) => ({
      id: p.id,
      type: "agent",
      position: { x: p.x, y: p.y },
      data: { live: byId.get(p.id)!, selected: p.id === selectedId },
      draggable: false,
    }));
    const ids = new Set(placed.map((p) => p.id));
    const edges: Edge[] = team
      .filter((t) => t.agent.reportsTo && ids.has(t.agent.reportsTo) && placed.find((p) => p.id === t.agent.id)!.depth > 0)
      .map((t) => ({
        id: `${t.agent.reportsTo}-${t.agent.id}`,
        source: t.agent.reportsTo!,
        target: t.agent.id,
        type: "smoothstep",
        // The line to an agent that is working moves.
        animated: t.state === "working",
        className: `ai-org-edge ai-org-edge-${t.state}`,
      }));
    return { nodes, edges };
  }, [team, selectedId]);

  return (
    <div className="ai-org" data-testid="team-graph">
      {/* Remounted when the space changes (the agent panel opens), so the team is fitted again. */}
      <ReactFlow
        key={`${selectedId ? "split" : "full"}-${team.length}`}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.4}
        nodesConnectable={false}
        nodesDraggable={false}
        proOptions={{ hideAttribution: false }}
        onNodeClick={(_, node) => onSelect(node.id === selectedId ? undefined : node.id)}
        onPaneClick={() => onSelect(undefined)}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
