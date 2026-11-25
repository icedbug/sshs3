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
import { composerUsage } from "../../src/renderer/src/components/AiHub/panel/panelHelpers";
import { linkFileRefs } from "../../src/renderer/src/components/AiHub/reportRefs";
import { RichMarkdownContent } from "../../src/renderer/src/components/AiHub/RichMarkdownContent";

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
});
