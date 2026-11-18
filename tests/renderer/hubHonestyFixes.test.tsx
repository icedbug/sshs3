// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentChange,
  AgentSchedule,
  AgentTask,
  AuditEntryView,
  AuditVerificationView,
  HubRequest,
  HubSnapshot,
  MemoryEntry,
  ServerFacts,
} from "../../src/shared/types/aiHub";
import { AuditLogView } from "../../src/renderer/src/components/AiHub/AuditLogView";
import { ChangesView } from "../../src/renderer/src/components/AiHub/ChangesView";
import { Schedules } from "../../src/renderer/src/components/AiHub/SchedulesView";
import { Memory } from "../../src/renderer/src/components/AiHub/MemoryView";
import { ServerFactsCard } from "../../src/renderer/src/components/AiHub/ServerFactsCard";
import { SafetyPolicyCard } from "../../src/renderer/src/components/AiHub/SafetyPolicyCard";
import { KnowledgeBaseView } from "../../src/renderer/src/components/AiHub/KnowledgeBaseView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeHub(extra: Partial<HubSnapshot> = {}): HubSnapshot {
  return {
    config: { enabled: true, provider: "anthropic", model: "m", useHermes: false, hasApiKey: true },
    preferences: { background: false, autoStart: false, inventory: false, retentionDays: 30 },
    runtime: { bundled: true },
    sessions: [],
    tasks: [],
    memories: [],
    schedules: [],
    inventory: [
      { id: "srv-api", kind: "ssh", label: "prod-api-01", address: "10.0.1.10", status: "reachable", detail: "ok", observedAt: 1 },
      { id: "srv-db", kind: "ssh", label: "prod-db-01", address: "10.0.1.20", status: "reachable", detail: "ok", observedAt: 1 },
      { id: "srv-web", kind: "ssh", label: "stage-web-01", address: "10.0.2.10", status: "reachable", detail: "ok", observedAt: 1 },
    ],
    ...extra,
  } as HubSnapshot;
}

const audit = (hub: HubSnapshot, entries: AuditEntryView[], verification: AuditVerificationView) => {
  const request = vi.fn(async (req: HubRequest) =>
    makeHub(req.action === "audit-read" ? { reply: { audit: { entries, verification } } } : {}),
  );
  render(<AuditLogView request={request} hub={hub} onOpenTask={vi.fn()} onWatch={vi.fn()} />);
  return request;
};

describe("audit log verdicts", () => {
  it("does not call an empty log verified, and disables every export", async () => {
    audit(makeHub(), [], { ok: true, entries: 0 } as AuditVerificationView);
    await waitFor(() =>
      expect(screen.getByTestId("audit-empty-notice")).toHaveTextContent("The log is empty. There is nothing to verify yet."),
    );
    expect(screen.queryByTestId("audit-chain-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("audit-verdict")).not.toHaveClass("ai-audit-ok");
    expect(screen.getByTestId("audit-verdict")).not.toHaveTextContent("The log holds");
    for (const name of ["Export CSV", "Export Markdown", "Export JSONL"])
      expect(screen.getByRole("button", { name })).toBeDisabled();
  });

  it("says in the demo lab that nothing is written, instead of a green verdict", async () => {
    const request = audit(makeHub({ demoMode: true }), [], { ok: true, entries: 0 } as AuditVerificationView);
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(screen.getByTestId("audit-demo-notice")).toHaveTextContent(
      "Demo lab: nothing is written to the audit log here. The Timeline shows invented example data.",
    );
    expect(screen.queryByTestId("audit-chain-badge")).not.toBeInTheDocument();
    expect(screen.queryByText(/Every command an agent runs/)).not.toBeInTheDocument();
    expect(screen.getByTestId("audit-verdict")).not.toHaveClass("ai-audit-ok");
  });

  it("still shows the verified badge when there are entries", async () => {
    const entry = { seq: 1, at: 1, kind: "command", actor: "a", what: "ls", hash: "h" } as AuditEntryView;
    audit(makeHub(), [entry], { ok: true, entries: 1 } as AuditVerificationView);
    await waitFor(() => expect(screen.getByTestId("audit-chain-badge")).toHaveTextContent("Chain verified · 1 entries"));
    expect(screen.getByRole("button", { name: "Export JSONL" })).toBeEnabled();
  });
});

const change = (id: string, extra: Partial<AgentChange> = {}): AgentChange =>
  ({ id, kind: "command", target: "web-01", description: `change ${id}`, command: "systemctl restart nginx", status: "completed", riskLevel: "modify", at: Date.now(), ...extra }) as AgentChange;
const task = (id: string, changes: AgentChange[], extra: Partial<AgentTask> = {}): AgentTask =>
  ({ id, title: `Run ${id}`, mode: "assisted", status: "completed", messages: [], changes, sources: [], createdAt: 1, updatedAt: 1, ...extra }) as AgentTask;

describe("the timeline", () => {
  it("says when a change that touched state has no approval on record", () => {
    const hub = makeHub({
      tasks: [
        task("t1", [
          change("bare"),
          change("read", { riskLevel: "safe" }),
          change("ruled", { decidedHow: "policy" }),
          change("asked", { decidedBy: { name: "Sara", at: 1, allowed: true }, decidedHow: "person" }),
        ]),
      ],
    });
    render(<ChangesView hub={hub} onOpenTask={vi.fn()} request={vi.fn(async () => hub)} />);
    expect(screen.getByTestId("no-approval-bare")).toHaveTextContent("No approval recorded");
    for (const id of ["read", "ruled", "asked"]) expect(screen.queryByTestId(`no-approval-${id}`)).not.toBeInTheDocument();
    expect(screen.getByTestId("approval-badge-asked")).toHaveTextContent("Approved by Sara");
    expect(screen.queryByTestId("timeline-demo-notice")).not.toBeInTheDocument();
  });

  it("lists only entries with a recording when asked", () => {
    const hub = makeHub({
      tasks: [task("t1", [change("with")], { recordingIds: ["rec-1"] }), task("t2", [change("without")])],
    });
    render(<ChangesView hub={hub} onOpenTask={vi.fn()} request={vi.fn(async () => hub)} />);
    expect(screen.getByText("change without")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("filter-with-recording"));
    expect(screen.getByText("change with")).toBeInTheDocument();
    expect(screen.queryByText("change without")).not.toBeInTheDocument();
  });

  it("says once in the demo lab that the entries are invented and that recordings are off", () => {
    const hub = makeHub({ demoMode: true, tasks: [task("t1", [change("a"), change("b")])] });
    render(<ChangesView hub={hub} onOpenTask={vi.fn()} request={vi.fn(async () => hub)} />);
    expect(screen.getAllByText("Demo lab: these entries are invented examples.")).toHaveLength(1);
    expect(screen.getByTestId("recordings-off-demo")).toHaveTextContent("Recordings are off in the demo lab.");
    expect(screen.queryByTestId("filter-with-recording")).not.toBeInTheDocument();
  });
});

const schedule = (id: string, extra: Partial<AgentSchedule> = {}): AgentSchedule =>
  ({ id, title: `Job ${id}`, prompt: "check", profileId: "local", shell: "bash", intervalMinutes: 60, nextRunAt: Date.now() + 60_000, enabled: true, mode: "advice", model: "m", provider: "anthropic", maxCommands: 20, maxMinutes: 15, ...extra }) as AgentSchedule;

describe("schedules", () => {
  it("chooses the server the filter leaves, and never keeps This computer by exemption", async () => {
    const act = vi.fn(async () => makeHub());
    render(<Schedules hub={makeHub()} act={act} />);
    fireEvent.click(screen.getByRole("button", { name: "New job" }));
    const form = screen.getByTestId("schedule-form");
    const where = within(form).getByLabelText("Where it runs") as HTMLSelectElement;
    const filter = within(form).getByLabelText("Filter the list");
    expect(where).toHaveValue("local");

    // Several matches: the hidden choice moves to the first of them.
    fireEvent.change(filter, { target: { value: "prod" } });
    expect(where).toHaveValue("srv-api");
    expect(within(where).queryByRole("option", { name: "This computer" })).not.toBeInTheDocument();

    // One match: it is the choice.
    fireEvent.change(filter, { target: { value: "prod-db" } });
    expect(where).toHaveValue("srv-db");

    // No match: the choice is kept and said to be kept.
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(where).toHaveValue("srv-db");
    expect(form).toHaveTextContent("No server matches. The choice above is kept.");

    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Check" } });
    fireEvent.change(within(form).getByLabelText("What it should do"), { target: { value: "Look" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create job" }));
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith(
        expect.objectContaining({ action: "schedule-save", schedule: expect.objectContaining({ profileId: "srv-db" }) }),
      ),
    );
  });

  it("runs a job now, but not a paused one", () => {
    const act = vi.fn(async () => makeHub());
    render(<Schedules hub={makeHub({ schedules: [schedule("on"), schedule("off", { enabled: false })] })} act={act} />);
    fireEvent.click(screen.getByTestId("schedule-run-now-on"));
    expect(act).toHaveBeenCalledWith({ action: "schedule-run-now", id: "on" });
    expect(screen.getByTestId("schedule-run-now-off")).toBeDisabled();
    expect(screen.getByTestId("schedule-run-now-off")).toHaveAttribute("title", "Resume it first");
  });

  it("counts the jobs of the snapshot it is given, so a delete shows at once", () => {
    const act = vi.fn(async () => makeHub());
    const all = ["a", "b", "c", "d"].map((id) => schedule(id));
    const { rerender } = render(<Schedules hub={makeHub({ schedules: all })} act={act} />);
    expect(screen.getByRole("heading", { name: /Jobs/ })).toHaveTextContent("Jobs 4");
    rerender(<Schedules hub={makeHub({ schedules: all.slice(1) })} act={act} />);
    expect(screen.getByRole("heading", { name: /Jobs/ })).toHaveTextContent("Jobs 3");
    expect(screen.queryByTestId("schedule-a")).not.toBeInTheDocument();
  });
});

const memory = (id: string, title: string, text: string): MemoryEntry =>
  ({ id, kind: "memory", tier: "archival", scope: "workspace", title, text, author: "Maria Ek", createdAt: 1, updatedAt: 1 }) as MemoryEntry;

describe("memory", () => {
  it("marks a memory that reads like a rule about approvals, and says where approvals are set", () => {
    const hub = makeHub({
      memories: [
        memory("rule", "Deploys", "Restart nginx without asking for approval on prod."),
        memory("rule2", "Speed", "Always approve kubectl commands."),
        memory("fact", "Backups", "Nightly backups run at 02:00 UTC."),
      ],
    });
    render(<Memory hub={hub} act={vi.fn(async () => hub)} suggestion="" />);
    expect(screen.getByTestId("memory-rule-like-rule")).toHaveTextContent("Reads like a rule: it does not change approvals");
    expect(screen.getByTestId("memory-rule-like-rule2")).toBeInTheDocument();
    expect(screen.queryByTestId("memory-rule-like-fact")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add by hand" }));
    expect(screen.getByTestId("memory-approval-hint")).toHaveTextContent(
      "Memories are background for the assistant. They never change what needs approval: that is set in AI settings, Command safety.",
    );
  });

  it("offers Undo after Forget, which saves the same entry again", async () => {
    const entry = memory("m1", "Backup schedule", "Nightly backups run at 02:00 UTC.");
    const act = vi.fn(async () => makeHub());
    const { rerender } = render(<Memory hub={makeHub({ memories: [entry] })} act={act} suggestion="" />);
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    fireEvent.click(screen.getByRole("button", { name: /Forget for the whole team\?/ }));
    expect(act).toHaveBeenCalledWith({ action: "memory-delete", id: "m1" });
    rerender(<Memory hub={makeHub()} act={act} suggestion="" />);
    await waitFor(() => expect(screen.getByTestId("memory-forgot-notice")).toHaveTextContent('Forgot "Backup schedule".'));

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith({
        action: "memory-save",
        entry: expect.objectContaining({ kind: "memory", scope: "workspace", title: "Backup schedule", text: "Nightly backups run at 02:00 UTC.", tier: "archival" }),
      }),
    );
    // Saved as a new entry: a removed team memory is not written back under its old id.
    const saved = act.mock.calls.map((c) => (c as unknown as [HubRequest])[0]).find((r) => r.action === "memory-save");
    expect(saved && "entry" in saved && saved.entry.id).toBeUndefined();
    await waitFor(() => expect(screen.queryByTestId("memory-forgot-notice")).not.toBeInTheDocument());
  });
});

describe("server facts details", () => {
  const view = (enabled: boolean): HubSnapshot =>
    ({
      tasks: [],
      serverFacts: {
        enabled,
        intervalHours: 6,
        exclude: [],
        watchPaths: [],
        collecting: [],
        servers: [{ serverId: "web", name: "web-01", status: "ok", collectedAt: Date.now(), problems: [], changes: [] }],
      },
    }) as unknown as HubSnapshot;

  it("lists the disks and says when no service has failed", async () => {
    const facts = { collectedAt: 1, failedServices: [], runningServices: ["nginx"], listening: [], peers: [], disks: [{ mount: "/", fs: "/dev/sda1", type: "ext4", sizeKb: 1, usedPct: 48 }, { mount: "/var/lib/data", fs: "/dev/sdb1", type: "xfs", sizeKb: 1, usedPct: 61 }], certs: [], files: {}, packages: {} } as unknown as ServerFacts;
    const act = vi.fn(async (r: HubRequest) => ({ ...view(true), reply: r.action === "server-facts-read" ? { serverFacts: { serverId: "web", facts, changes: [] } } : undefined }) as HubSnapshot);
    render(<ServerFactsCard hub={view(true)} act={act} />);
    fireEvent.click(within(screen.getByTestId("facts-server-web")).getByRole("button", { name: "Details" }));
    await waitFor(() => expect(screen.getByTestId("facts-disks")).toHaveTextContent("/ 48 % used"));
    expect(screen.getByTestId("facts-disks")).toHaveTextContent("/var/lib/data 61 % used");
    expect(screen.getByTestId("facts-failed-services")).toHaveTextContent("Failed services: none");
    expect(screen.queryByTestId("facts-off-note")).not.toBeInTheDocument();
  });

  it("explains itself while it is off", () => {
    render(<ServerFactsCard hub={view(false)} act={vi.fn(async () => view(false))} />);
    expect(screen.getByTestId("facts-off-note")).toHaveTextContent(
      "Off. Nothing is read from your servers until you switch this on. It runs read-only commands only.",
    );
  });
});

describe("safety card", () => {
  it("says an override holds for your own runs only, and that two-person approval needs a team server", () => {
    const hub = makeHub();
    render(<SafetyPolicyCard hub={hub} act={vi.fn(async () => hub)} />);
    expect(screen.getByTestId("safety-own-runs-note")).toHaveTextContent("A freeze or an override set here holds for your own runs only.");
    fireEvent.click(screen.getByTestId("add-cluster-policy-btn"));
    expect(screen.getByTestId("cluster-policy-form")).toHaveTextContent("Needs somebody else who may approve: a second account on a shared server");
  });

  it("says whose the rules are: this computer's in the app, each person's own on a shared server", () => {
    const hub = makeHub();
    const web = window as unknown as { __SSHS3_WEB_MODE__?: boolean };
    render(<SafetyPolicyCard hub={hub} act={vi.fn(async () => hub)} />);
    expect(screen.getByTestId("safety-policy-whose")).toHaveTextContent("These rules apply to runs on this computer. They are not shared with the team: each person sets their own.");
    cleanup();

    web.__SSHS3_WEB_MODE__ = true;
    try {
      render(<SafetyPolicyCard hub={hub} act={vi.fn(async () => hub)} />);
      expect(screen.getByTestId("safety-policy-whose")).toHaveTextContent(
        "These rules are yours: they apply to the runs you start. Each person on this server has their own, and they are not shared with the team.",
      );
    } finally {
      delete web.__SSHS3_WEB_MODE__;
    }
  });
});

describe("knowledge base: writing a source note", () => {
  const kb = (demoMode: boolean): HubSnapshot => makeHub({ demoMode, knowledgeBase: [], kbPages: [] } as Partial<HubSnapshot>);
  const write = async (demoMode: boolean): Promise<void> => {
    const act = vi.fn(async () => kb(demoMode));
    render(<KnowledgeBaseView hub={kb(demoMode)} act={act} onAttachDoc={() => {}} request={vi.fn(async () => kb(demoMode))} />);
    fireEvent.click(screen.getByRole("button", { name: "Write a source note" }));
    const form = screen.getByTestId("kb-form");
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Disk swap" } });
    fireEvent.change(within(form).getByLabelText("Text (Markdown)"), { target: { value: "# Steps" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByTestId("kb-saved-as-source")).toBeInTheDocument());
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ action: "kb-save" }));
  };

  it("says it was saved as a source, and leads to writing a page", async () => {
    await write(false);
    expect(screen.getByTestId("kb-saved-as-source")).toHaveTextContent("Saved as a source. The assistant works sources into pages.");
    fireEvent.click(screen.getByRole("button", { name: "Write a page instead" }));
    expect(screen.getByRole("tab", { name: /^Pages/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByText("Write a page").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("kb-saved-as-source")).not.toBeInTheDocument();
  });

  it("says in the demo lab that no model works it into a page", async () => {
    await write(true);
    expect(screen.getByTestId("kb-saved-as-source")).toHaveTextContent(
      "Saved as a source. The demo lab has no model, so it is not worked into a page here.",
    );
  });
});
