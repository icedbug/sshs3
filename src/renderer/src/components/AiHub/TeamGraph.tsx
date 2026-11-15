import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { layoutOrg, tokens, type AgentLive, type AgentState } from "./workforceModel";

type AgentNodeData = { live: AgentLive; selected: boolean };

const STATE_TEXT: Record<AgentState, string> = {
  working: "active",
  waiting: "needs you",
  paused: "paused",
  "out-of-budget": "out of budget",
  idle: "idle",
};

const STATE_COLOR: Record<AgentState, string> = {
  working: "#2dd4bf",
  waiting: "#fbbf24",
  paused: "#64748b",
  "out-of-budget": "#f87171",
  idle: "#94a3b8",
};

const NODE_STYLE_BY_STATE: Record<AgentState, React.CSSProperties> = {
  working: { borderColor: "rgba(45, 212, 191, 0.7)", boxShadow: "0 0 18px rgba(45, 212, 191, 0.16)" },
  waiting: { borderColor: "rgba(251, 191, 36, 0.75)" },
  paused: { opacity: 0.62, borderStyle: "dashed" },
  "out-of-budget": { borderColor: "rgba(248, 113, 113, 0.8)" },
  idle: { borderColor: "rgba(148, 163, 184, 0.28)" },
};

const AgentNode = memo(function AgentNode({ data }: NodeProps<Node<AgentNodeData>>): JSX.Element {
  const { live, selected } = data;
  const share = live.budget ? Math.min(1, live.spent / live.budget) : 0;
  const stateColor = STATE_COLOR[live.state];
  return (
    <div
      className={`ai-org-node ai-org-${live.state} ${selected ? "ai-org-selected" : ""}`}
      data-state={live.state}
      data-testid={`team-node-${live.agent.id}`}
      style={NODE_STYLE_BY_STATE[live.state]}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="ai-org-head">
        <span className="ai-org-dot" style={{ background: stateColor }} />
        <strong>{live.agent.name}</strong>
        <span className="ai-org-state" style={{ color: stateColor }}>
          {STATE_TEXT[live.state]}
        </span>
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
          <em>
            {live.doing || (live.open ? `${live.open} open ticket${live.open === 1 ? "" : "s"}` : "No tickets")}
          </em>
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
});

// Hoisted at module level so ReactFlow never remounts nodes/edges across renders.
const nodeTypes = { agent: AgentNode };
const edgeTypes = {};

const FIT_OPTIONS = { padding: 0.2, maxZoom: 1, duration: 250 } as const;

const miniMapNodeColor = (node: Node): string => {
  const live = (node.data as AgentNodeData | undefined)?.live;
  return live ? STATE_COLOR[live.state] : "#64748b";
};

/** The team as a tree that moves: who reports to whom, and what each one is doing now. */
export function TeamGraph({
  team,
  selectedId,
  workforcePaused,
  onSelect,
}: {
  team: AgentLive[];
  selectedId?: string;
  workforcePaused?: boolean;
  onSelect: (id: string | undefined) => void;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance<Node<AgentNodeData>, Edge> | null>(null);
  const teamCountRef = useRef(team.length);

  const { nodes, edges } = useMemo(() => {
    const placed = layoutOrg(team.map((t) => t.agent));
    const placedMap = new Map(placed.map((p) => [p.id, p]));
    const byId = new Map(team.map((t) => [t.agent.id, t]));
    const nextNodes: Node<AgentNodeData>[] = placed.map((p) => ({
      id: p.id,
      type: "agent",
      position: { x: p.x, y: p.y },
      data: { live: byId.get(p.id)!, selected: p.id === selectedId },
      draggable: false,
    }));
    const nextEdges: Edge[] = team
      .filter((t) => {
        if (!t.agent.reportsTo || !placedMap.has(t.agent.reportsTo)) return false;
        const pos = placedMap.get(t.agent.id);
        return Boolean(pos && pos.depth > 0);
      })
      .map((t) => {
        const edgeStyle =
          t.state === "working"
            ? { stroke: "#2dd4bf", strokeWidth: 2 }
            : t.state === "waiting"
              ? { stroke: "#fbbf24", strokeWidth: 1.75 }
              : t.state === "paused"
                ? { stroke: "rgba(148, 163, 184, 0.35)", strokeDasharray: "4 4" }
                : { stroke: "rgba(148, 163, 184, 0.45)" };
        return {
          id: `${t.agent.reportsTo}-${t.agent.id}`,
          source: t.agent.reportsTo!,
          target: t.agent.id,
          type: "smoothstep",
          // The line to an agent that is working moves.
          animated: t.state === "working",
          style: edgeStyle,
          className: `ai-org-edge ai-org-edge-${t.state}`,
        };
      });
    return { nodes: nextNodes, edges: nextEdges };
  }, [team, selectedId]);

  const handleFitView = useCallback(() => {
    rfInstance?.fitView(FIT_OPTIONS);
  }, [rfInstance]);

  // Refit smoothly when team size changes or container resizes without remounting ReactFlow.
  useEffect(() => {
    if (!rfInstance) return;
    if (teamCountRef.current !== team.length) {
      teamCountRef.current = team.length;
      rfInstance.fitView(FIT_OPTIONS);
    }
  }, [rfInstance, team.length]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !rfInstance || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => rfInstance.fitView(FIT_OPTIONS));
    });
    observer.observe(el);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [rfInstance]);

  const handleNodeClick = useCallback(
    (_: unknown, node: Node) => {
      onSelect(node.id === selectedId ? undefined : node.id);
    },
    [onSelect, selectedId],
  );

  const handlePaneClick = useCallback(() => {
    onSelect(undefined);
  }, [onSelect]);

  return (
    <div
      ref={containerRef}
      className={`ai-org ${workforcePaused ? "ai-org-workforce-paused" : ""}`}
      data-testid="team-graph"
      style={{ position: "relative" }}
    >
      <div
        className="ai-org-legend"
        data-testid="team-graph-legend"
        style={{
          position: "absolute",
          top: 10,
          left: 10,
          right: 10,
          zIndex: 5,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "10px",
          padding: "5px 9px",
          borderRadius: 8,
          background: "rgba(15, 18, 24, 0.84)",
          border: "1px solid rgba(255, 255, 255, 0.1)",
          fontSize: 11,
          pointerEvents: "auto",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span className="ai-org-dot" style={{ background: STATE_COLOR.working }} /> Active
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span className="ai-org-dot" style={{ background: STATE_COLOR.waiting }} /> Needs you
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span className="ai-org-dot" style={{ background: STATE_COLOR.paused }} /> Paused
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span className="ai-org-dot" style={{ background: STATE_COLOR.idle }} /> Idle
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span className="ai-org-dot" style={{ background: STATE_COLOR["out-of-budget"] }} /> Out of budget
        </span>
        <span style={{ opacity: 0.8 }}>· Dashed edge: paused · Animated edge: active run</span>
        {workforcePaused && (
          <span className="ai-badge ai-badge-danger" data-testid="team-graph-paused-badge">
            Workforce paused
          </span>
        )}
        <span className="ai-spacer" />
        <button
          type="button"
          className="ai-chip"
          data-testid="team-graph-fit"
          onClick={handleFitView}
        >
          Fit view
        </button>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.4}
        nodesConnectable={false}
        nodesDraggable={false}
        proOptions={{ hideAttribution: false }}
        onInit={setRfInstance}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} showZoom showFitView />
        <MiniMap pannable zoomable nodeColor={miniMapNodeColor} />
      </ReactFlow>
    </div>
  );
}
