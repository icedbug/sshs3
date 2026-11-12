// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubSnapshot, MissionAgent, WorkTicket } from "../../src/shared/types/aiHub";
import { WorkforceView } from "../../src/renderer/src/components/AiHub/WorkforceView";
import { agentsLive, layoutOrg } from "../../src/renderer/src/components/AiHub/workforceModel";

afterEach(cleanup);

const agent = (id: string, extra: Partial<MissionAgent> = {}): MissionAgent => ({
  id,
  name: id,
  role: "role",
  mission: "m",
  systemPrompt: "",
  defaultMode: "assisted",
  updatedAt: 1,
  ...extra,
});
const ticket = (id: string, extra: Partial<WorkTicket> = {}): WorkTicket => ({
  id,
  title: `Ticket ${id}`,
  description: "",
  status: "todo",
  assigneeAgentId: "lead",
  assigneeName: "lead",
  createdBy: "jacob",
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});
const hub = (extra: Partial<HubSnapshot>): HubSnapshot =>
  ({
    tasks: [],
    sessions: [],
    agents: [],
    workGoals: [],
    workTickets: [],
    agentUsage: {},
    workforceTemplates: [{ id: "operate-system", title: "Operate a system", description: "d", roles: ["Lead"] }],
    workBoardSync: { shared: false },
    preferences: {},
    ...extra,
  }) as unknown as HubSnapshot;

describe("the team as a tree", () => {
  it("puts reports under their lead, loners in rows below, and ignores a line that closes a circle", () => {
    const placed = layoutOrg([
      { id: "lead" },
      { id: "a", reportsTo: "lead" },
      { id: "b", reportsTo: "lead" },
      { id: "loner" },
      { id: "x", reportsTo: "y" },
      { id: "y", reportsTo: "x" },
    ]);
    const at = new Map(placed.map((p) => [p.id, p]));
    expect(at.get("lead")!.depth).toBe(0);
    expect(at.get("a")!.depth).toBe(1);
    expect(at.get("lead")!.x).toBe((at.get("a")!.x + at.get("b")!.x) / 2);
    expect(at.get("loner")!.y).toBeGreaterThan(at.get("a")!.y);
    // Nothing is lost to the circle: every agent is placed once.
    expect(placed.map((p) => p.id).sort()).toEqual(["a", "b", "lead", "loner", "x", "y"]);
  });

  it("reads what each agent is doing from the board and the running conversation", () => {
    const live = agentsLive(
      hub({
        agents: [agent("lead"), agent("idle"), agent("paused", { enabled: false }), agent("broke", { monthlyTokenBudget: 1000 }), agent("asks")],
        agentUsage: { broke: { month: new Date().toISOString().slice(0, 7), tokens: 1500, runs: 2 } },
        workTickets: [
          ticket("1", { status: "in_progress", taskId: "t1", claim: { by: "jacob", client: "c", at: 1, seenAt: 1 } }),
          ticket("2", { status: "in_progress", assigneeAgentId: "asks", taskId: "t2" }),
          ticket("3", { status: "in_progress", assigneeAgentId: "idle", claim: { by: "erik", client: "other", at: 1, seenAt: 1 } }),
        ],
        tasks: [
          { id: "t1", status: "running", changes: [{ id: "c", kind: "command", command: "df -h", status: "completed", description: "", target: "x", at: 1 }], todos: [] },
          { id: "t2", status: "waiting", changes: [{ id: "c", kind: "command", command: "systemctl restart x", status: "pending", description: "Restart x", target: "x", at: 1 }] },
        ] as unknown as HubSnapshot["tasks"],
      }),
    );
    const by = new Map(live.map((l) => [l.agent.id, l]));
    expect(by.get("lead")).toMatchObject({ state: "working", doing: "$ df -h" });
    expect(by.get("asks")).toMatchObject({ state: "waiting", doing: "Waiting for you: Restart x" });
    expect(by.get("paused")!.state).toBe("paused");
    expect(by.get("broke")!.state).toBe("out-of-budget");
    // Run by a teammate's app: there is no conversation here, only who has it.
    expect(by.get("idle")).toMatchObject({ state: "working", doing: "Running on erik's computer" });
  });
});

describe("the board", () => {
  it("offers the templates while there is nothing, and sets one up", async () => {
    const act = vi.fn(async () => undefined);
    render(<WorkforceView hub={hub({})} act={act} onOpenTask={() => {}} />);
    fireEvent.click(screen.getByTestId("workforce-template-operate-system"));
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith({ action: "workforce-template-apply", templateId: "operate-system" }),
    );
  });

  it("shows tickets in their columns, starts one, and makes sending back need a note", async () => {
    const act = vi.fn(async () => undefined);
    render(
      <WorkforceView
        hub={hub({
          agents: [agent("lead")],
          workGoals: [{ id: "g", title: "Keep prod healthy", status: "active", createdAt: 1, updatedAt: 1 }],
          workTickets: [
            ticket("todo1", { goalId: "g" }),
            ticket("rev1", { status: "review", result: "I checked **everything**.", goalId: "g" }),
            ticket("run1", { status: "in_progress", claim: { by: "erik", client: "x", at: Date.now(), seenAt: Date.now() } }),
            ticket("nobody", { status: "backlog", assigneeAgentId: undefined, assigneeName: undefined }),
          ],
        })}
        act={act}
        onOpenTask={() => {}}
      />,
    );
    expect(within(screen.getByTestId("column-todo")).getByText("Ticket todo1")).toBeVisible();
    expect(within(screen.getByTestId("column-in_progress")).getByText(/erik/)).toBeVisible();
    expect(screen.getByText("Keep prod healthy · 0/2")).toBeVisible();
    // A ticket nobody is assigned to, and one that is running, cannot be started.
    expect(screen.queryByTestId("ticket-start-nobody")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ticket-start-run1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ticket-start-todo1"));
    await waitFor(() => expect(act).toHaveBeenCalledWith({ action: "ticket-start", id: "todo1" }));

    fireEvent.click(screen.getByTestId("ticket-rev1"));
    const review = screen.getByTestId("ticket-review");
    expect(within(screen.getByTestId("ticket-detail")).getByText("everything")).toBeVisible();
    expect(within(review).getByRole("button", { name: "Send back" })).toBeDisabled();
    fireEvent.change(within(review).getByLabelText("Note for the agent"), { target: { value: "Check the replica too" } });
    fireEvent.click(within(review).getByRole("button", { name: "Send back" }));
    expect(act).toHaveBeenCalledWith({ action: "ticket-review", id: "rev1", approve: false, note: "Check the replica too" });
  });
});
