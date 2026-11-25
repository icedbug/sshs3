// @vitest-environment jsdom
/*
 * What the exploring testers of the feature test found in the AI workspace, one test per finding:
 * a person in a role used the product in a real browser and reported what misled them.
 */
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChange, AgentTask, HubSnapshot } from "../../src/shared/types/aiHub";
import { ChangesView, groupChangeEntries } from "../../src/renderer/src/components/AiHub/ChangesView";
import { changeStatusLabel, isUncertainOrPartialRollback } from "../../src/renderer/src/components/AiHub/ChangeProof";
import { composerUsage } from "../../src/renderer/src/components/AiHub/panel/panelHelpers";
import { linkFileRefs } from "../../src/renderer/src/components/AiHub/reportRefs";
import { RichMarkdownContent } from "../../src/renderer/src/components/AiHub/RichMarkdownContent";
import { MessageRow } from "../../src/renderer/src/components/AiHub/panel/Timeline";
import { TargetNotice, targetMismatch } from "../../src/renderer/src/components/AiHub/TargetNotice";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function hubWith(extra: Partial<HubSnapshot> = {}): HubSnapshot {
  return {
    config: { enabled: true, provider: "anthropic", model: "claude-opus-5-5", useHermes: false, hasApiKey: true },
    preferences: { background: false, autoStart: false, inventory: false, retentionDays: 30, approvalWaitMinutes: 10 },
    runtime: { bundled: true },
    sessions: [],
    tasks: [],
    inventory: [],
    memories: [],
    schedules: [],
    ...extra,
  };
}

function taskWith(changes: AgentChange[]): AgentTask {
  return {
    id: "task-1",
    title: "Create a test file on web-01",
    agentName: "Assistant",
    mode: "assisted",
    status: "completed",
    messages: [],
    sources: [],
    changes,
    createdAt: 1000,
    updatedAt: 3000,
    maxCommands: 10,
    maxMinutes: 10,
  } as unknown as AgentTask;
}

describe("what the exploring testers found", () => {
  // E3: a change on production that needed two people showed "Approvals: 2/2" and then "Allowed by
  // Maria at 05:57 PM", naming only the second; the team's agents read the records and reported that no
  // second approval was recorded.
  it("names each person who allowed a change that needed two", () => {
    const change: AgentChange = {
      id: "c2",
      kind: "command",
      target: "web-01",
      description: "Create test file /tmp/x on web-01 (production)",
      command: "printf '%s' x > /tmp/x",
      status: "completed",
      at: 1000,
      requiredApprovals: 2,
      approvals: [
        { actor: "Omar", actorId: "user:o", at: 1000, allowed: true },
        { actor: "Maria", actorId: "user:m", at: 2000, allowed: true, peer: true },
      ],
      decidedBy: { name: "Maria", at: 2000, allowed: true },
      decidedHow: "person",
    };
    render(<ChangesView hub={hubWith({ tasks: [taskWith([change])] })} onOpenTask={vi.fn()} request={vi.fn()} />);
    expect(document.body.textContent).toMatch(/Allowed by Omar and Maria \(second person\) at /);
    expect(document.body.textContent).not.toMatch(/Allowed by Maria at /);
  });

  it("still names the one person who allowed a change that needed one", () => {
    const change: AgentChange = {
      id: "c1",
      kind: "command",
      target: "web-02",
      description: "Create test file /tmp/y on web-02",
      command: "printf '%s' y > /tmp/y",
      status: "completed",
      at: 1000,
      approvals: [{ actor: "Lina", at: 1000, allowed: true }],
      decidedBy: { name: "Lina", at: 1000, allowed: true },
      decidedHow: "person",
    };
    render(<ChangesView hub={hubWith({ tasks: [taskWith([change])] })} onOpenTask={vi.fn()} request={vi.fn()} />);
    expect(document.body.textContent).toMatch(/Allowed by Lina at /);
  });

  // E8: the panel's header said "276k tok · $0.368" and the row under the composer "1.4k · $0.368" for
  // the same conversation: the row left out the tokens read from the prompt cache, which the cost counts.
  it("counts a conversation's tokens the same under the composer as in the header", () => {
    const task = {
      ...taskWith([]),
      status: "completed",
      usage: { inputTokens: 1_000, outputTokens: 400, cacheReadTokens: 270_000, cacheCreationTokens: 4_600, costUsd: 0.368 },
    } as unknown as AgentTask;
    const shown = composerUsage(task)!;
    expect(shown.label).toBe("276k · $0.368");
    expect(shown.title).toContain("275k of them read from or written to the prompt cache");
    expect(composerUsage({ ...taskWith([]), usage: undefined } as unknown as AgentTask)).toBeUndefined();
  });

  // E9: a knowledge base page showed "Binary: [ /usr/sbin/nginx ](#file-%2Fusr%2Fsbin%2Fnginx)": the page
  // view linked its file names, and the markdown it hands them to linked them again, a link in a link.
  it("links a file name in a knowledge base page once, so it shows as a link and not as its markup", () => {
    const body = "- **Binary:** `/usr/sbin/nginx`. The config is /etc/nginx/nginx.conf, line 2.";
    expect(linkFileRefs(linkFileRefs(body))).toBe(linkFileRefs(body));
    render(<RichMarkdownContent text={linkFileRefs(body)} />);
    expect(document.body.textContent).not.toContain("](#file-");
    expect(screen.getAllByTestId("ai-file-ref-btn").length).toBeGreaterThanOrEqual(2);
  });

  // E6: a health check that only looked showed as "6 changes" beside a summary of "6 commands", and its
  // header listed every server twice: one entry's target was "web-02, cache-01, ..." and another's the
  // same servers in another order.
  it("counts a group of commands as commands and names each of its servers once", () => {
    const cmd = (id: string, target: string): AgentChange => ({ id, kind: "command", target, description: "Look", command: "uptime", status: "completed", at: 1000, decidedHow: "policy" });
    const changes = [cmd("a", "web-02, cache-01, db-01"), cmd("b", "db-01, web-02, cache-01"), cmd("c", "web-01")];
    render(<ChangesView hub={hubWith({ tasks: [taskWith(changes)] })} onOpenTask={vi.fn()} request={vi.fn()} />);
    const card = document.querySelector('[data-testid^="change-set-"]')!;
    expect(card.textContent).toContain("3 commands");
    expect(card.textContent).not.toMatch(/3 changes/);
    const group = groupChangeEntries(
      changes.map((c) => ({ id: c.id, at: c.at, kind: "agent", actor: "Assistant", target: c.target, summary: c.description, taskId: "task-1", change: c })) as never,
    )[0];
    expect(group.targets).toEqual(["web-02", "cache-01", "db-01", "web-01"]);
  });

  // H8: after Resume, the chat showed "You 06:20 PM: Resume on this terminal. Recheck the current state;
  // do not replay any uncertain command." with Edit and Retry, as if the person had typed it.
  it("shows a line the hub wrote as the hub's, not as the person's", () => {
    const actions = { edit: vi.fn(), retry: vi.fn(), fork: vi.fn(), copy: vi.fn(), saveToMemory: vi.fn(), followUp: vi.fn(), openRef: vi.fn(), openFileRef: vi.fn(), stage: vi.fn(), run: vi.fn() };
    const row = (message: object) =>
      render(
        <MessageRow
          message={message as never}
          taskId="task-1"
          running={false}
          busy={false}
          copied={false}
          isLast={false}
          canRetry
          streaming={false}
          clipped={false}
          actions={actions}
        />,
      );
    const hub = row({ id: "m1", role: "user", by: "hub", at: 1000, text: "Resume on this terminal. Recheck the current state; do not replay any uncertain command." });
    expect(hub.container.textContent).toContain("sshs3");
    expect(hub.container.textContent).not.toContain("You");
    expect(hub.container.querySelector('[title="Edit prompt in composer"]')).toBeNull();
    hub.unmount();
    const person = row({ id: "m2", role: "user", at: 1000, text: "Resume on web-02 please" });
    expect(person.container.textContent).toContain("You");
    expect(person.container.querySelector('[title="Edit prompt in composer"]')).not.toBeNull();
  });

  // H7: after a rollback from the chat card, the card still said "uncertain" and still offered "Verify &
  // Execute Rollback", which the hub then refused ("Only a change that ran can be taken back, once"),
  // while Changes said "rolled back".
  it("offers no second rollback, and calls a change rolled back once its rollback ran", () => {
    const ran = (exitCode: number, restored: boolean) =>
      ({
        status: "uncertain",
        check: { command: "cat /tmp/x", expected: "late", after: true },
        rollback: { command: "rm -f /tmp/x", ran: true, exitCode, restored, comparedWithBaseline: true },
      }) as never;
    expect(isUncertainOrPartialRollback(ran(0, true))).toBe(false);
    expect(isUncertainOrPartialRollback(ran(1, false))).toBe(false);
    expect(changeStatusLabel(ran(0, true))).toBe("rolled back");
    expect(changeStatusLabel(ran(1, false))).toBe("rollback failed");
    expect(changeStatusLabel({ status: "uncertain" } as never)).toBe("uncertain");
    expect(isUncertainOrPartialRollback({ status: "uncertain", rollback: { command: "rm -f /tmp/x", ran: false } } as never)).toBe(true);
  });

  // H1: a new conversation took the terminal tab that was open, production app-01, although the message
  // said "on web-02 please create a file in /tmp"; the chip said "app-01", Auto stayed on, and nothing
  // said that the message named another server, or that the terminal it would run on was production.
  describe("the server a message names and the one it runs on", () => {
    const servers = [
      { name: "app-01", tags: ["production", "api"] },
      { name: "web-02", tags: ["staging"] },
      { name: "web-01", tags: ["production"] },
    ];
    it("finds a server named in the message other than the conversation's", () => {
      expect(targetMismatch("on web-02 please create a file in /tmp", "app-01", servers)).toEqual({ named: ["web-02"], target: "app-01", production: true });
      expect(targetMismatch("on web-02 please", "web-02", servers)).toBeUndefined();
      // Named beside its own server: the person knows where it runs.
      expect(targetMismatch("copy it from web-01 to app-01", "app-01", servers)).toBeUndefined();
      expect(targetMismatch("anything on web-020", "app-01", servers)).toBeUndefined();
      expect(targetMismatch("on web-02", undefined, servers)).toBeUndefined();
    });
    it("says so above the composer, and that the terminal is production", () => {
      render(<TargetNotice text="on web-02 please create a file in /tmp" target="app-01" servers={servers} />);
      const notice = screen.getByTestId("ai-target-mismatch");
      expect(notice).toHaveTextContent("Your message names web-02, but this conversation runs on app-01, a production server.");
      cleanup();
      render(<TargetNotice text="what runs here?" target="app-01" servers={servers} />);
      expect(screen.queryByTestId("ai-target-mismatch")).toBeNull();
      expect(screen.getByTestId("ai-target-production")).toHaveTextContent("app-01 is a production server");
      cleanup();
      render(<TargetNotice text="what runs here?" target="web-02" servers={servers} />);
      expect(document.body.textContent).toBe("");
    });
  });

  // H10: in the person's own pasted text, every /tmp/... path and URL path such as /api/checkout became a
  // file chip, which broke the lines up. A file chip is for an answer that points at a file.
  it("leaves the person's own text as they wrote it, and links files in an answer", () => {
    const actions = { edit: vi.fn(), retry: vi.fn(), fork: vi.fn(), copy: vi.fn(), saveToMemory: vi.fn(), followUp: vi.fn(), openRef: vi.fn(), openFileRef: vi.fn(), stage: vi.fn(), run: vi.fn() };
    const row = (message: object) =>
      render(
        <MessageRow message={message as never} taskId="task-1" running={false} busy={false} copied={false} isLast={false} canRetry streaming={false} clipped={false} actions={actions} />,
      );
    const person = row({ id: "m1", role: "user", at: 1000, text: "for i in 1 2; do echo m-$i >> /tmp/lina-g4.txt; done; GET /api/checkout 502" });
    expect(person.container.querySelectorAll('[data-testid="ai-file-ref-btn"]')).toHaveLength(0);
    expect(person.container.textContent).toContain(">> /tmp/lina-g4.txt; done");
    person.unmount();
    const answer = row({ id: "m2", role: "assistant", at: 1000, text: "The loop writes to /tmp/lina-g4.txt." });
    expect(answer.container.querySelectorAll('[data-testid="ai-file-ref-btn"]').length).toBeGreaterThan(0);
  });
});
