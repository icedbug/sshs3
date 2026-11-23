import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceCapture } from "../../src/main/ai/hub/SourceCapture";
import { operatingInstructions, parseHypotheses } from "../../src/main/ai/hub/AgentDiscipline";
import { DirectAgentRuntime, resetCircuitBreakers, retryPolicy } from "../../src/main/ai/hub/DirectAgentRuntime";
import { ticketAfterRun } from "../../src/main/ai/hub/WorkBoard";
import type { RunEvent } from "../../src/main/ai/hub/AgentRuntime";
import type { AgentHypothesis, AgentTask, WorkTicket } from "../../src/shared/types/aiHub";
import { PROTOCOLS, scriptedModel } from "../helpers/scriptedModel";

/**
 * What an agent reads a system with is a source it can cite and rest a confirmed cause on: not only
 * its own terminal, but a command across a cluster, a file, a diff and an investigator's report.
 */

const capture = () => new SourceCapture((text) => text);
/** The sources a request carries when it holds this tool result, and the result as the model reads it. */
function sent(tool: string, result: unknown) {
  const cap = capture();
  const raw = JSON.stringify(result);
  const marked = cap.toolOutput(tool, raw, raw, { sessionId: "tab", label: "web-01" }, 1_000);
  const { body, call } = cap.wire(JSON.stringify({ messages: [{ role: "tool", content: marked }] }), 1_001);
  return { sources: call.sources, content: (JSON.parse(body) as { messages: Array<{ content: string }> }).messages[0].content };
}

describe("tool results that are sources", () => {
  it("gives a file that was read a reference", () => {
    const { sources, content } = sent("file_read", { content: "proxy_read_timeout 60s;\n", hash: "abc", source: "web-01:/etc/nginx/acme.conf", observedAt: 900 });
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ ref: "S1", kind: "server-reading", id: "web-01:/etc/nginx/acme.conf", label: "web-01:/etc/nginx/acme.conf", observedAt: 900 });
    expect(sources[0].excerpt).toContain("proxy_read_timeout 60s;");
    // The model sees the reference right after the text it stands for.
    expect(content).toContain("proxy_read_timeout 60s;\\n [S1]");
    expect(content).not.toContain("⟦");
  });

  it("gives a remote file and a diff a reference; a listing has none", () => {
    const read = sent("sshs3_storage_ops", { ok: true, operation: "read_remote_file", target: "db-01", path: "/etc/postgresql/pg_hba.conf", content: "host all all 0.0.0.0/0 md5" });
    expect(read.sources).toEqual([expect.objectContaining({ ref: "S1", kind: "server-reading", id: "db-01:/etc/postgresql/pg_hba.conf" })]);
    expect(read.content).toContain("0.0.0.0/0 md5 [S1]");

    const diffText = "--- web-01:/etc/app.conf\n+++ web-02:/etc/app.conf\n-timeout=60\n+timeout=30\n";
    const diff = sent("sshs3_storage_ops", { ok: true, operation: "diff_paths", left: { target: "web-01", path: "/etc/app.conf" }, right: { target: "web-02", path: "/etc/app.conf" }, identical: false, unifiedDiff: diffText, diff: diffText });
    // The diff is sent under two names: it is one source.
    expect(diff.sources).toHaveLength(1);
    expect(diff.sources[0]).toMatchObject({ kind: "server-reading", id: "web-01:/etc/app.conf and web-02:/etc/app.conf", label: "Diff of web-01:/etc/app.conf and web-02:/etc/app.conf" });

    const listing = sent("sshs3_storage_ops", { ok: true, operation: "list_files", target: "db-01", path: "/etc", entries: [{ name: "hosts", path: "/etc/hosts", type: "file", size: 120 }] });
    expect(listing.sources).toEqual([]);
  });

  it("gives each server's output of a command across a cluster its own reference, and none to a node where nothing ran", () => {
    const { sources, content } = sent("sshs3_cluster_exec", {
      ok: false, ref: "c4", nodeCount: 4,
      results: [
        { node: "web-01", host: "10.0.0.1", exitCode: 0, output: "nginx version: nginx/1.24.0", source: "terminal:t1" },
        { node: "web-02", host: "10.0.0.2", exitCode: 0, output: "nginx version: nginx/1.18.0", source: "terminal:t2" },
        { node: "web-03", host: "10.0.0.3", exitCode: -1, output: "Unknown whether it ran: timed out", source: "terminal:t3" },
        { node: "web-04", host: "10.0.0.4", exitCode: 1, output: "No open terminal for this node", source: "unconnected:web-04" },
      ],
    });
    expect(sources.map((s) => [s.ref, s.kind, s.id, s.label])).toEqual([["S1", "terminal", "t1", "web-01"], ["S2", "terminal", "t2", "web-02"]]);
    expect(content).toContain("nginx/1.24.0 [S1]");
    expect(content).toContain("nginx/1.18.0 [S2]");
    expect(content).not.toContain("timed out [S");
  });

  it("gives each investigator's report a reference, and none to one that failed", () => {
    const { sources } = sent("sshs3_investigate", {
      asked: 2, answered: 1,
      reports: [
        { question: "What is nginx's proxy_read_timeout on web-01?", status: "answered", report: "It is 60s (grep in /etc/nginx/acme.conf)." },
        { question: "What is postgres max_connections?", status: "failed", report: "The investigator ended without a report." },
      ],
    });
    expect(sources).toEqual([expect.objectContaining({ ref: "S1", kind: "investigation", id: "investigator-1", label: "Investigator 1: What is nginx's proxy_read_timeout on web-01?" })]);
  });

  it("tells an agent that acts what the references are and what they are for", () => {
    const acting = operatingInstructions({ mode: "assisted", target: { label: "web-01" }, thorough: false, agentSection: [] });
    expect(acting).toContain("carries a source reference instead, in square brackets after the text ([S1], [S2] …)");
    expect(acting).toContain("give it as `sourceRef` when you record an observation with `sshs3_hypotheses`");
  });
});

// ------------------------------------------------------------------ in a run, on all three protocols

beforeEach(() => {
  retryPolicy.attempts = 0;
  retryPolicy.baseDelayMs = 1;
  resetCircuitBreakers();
});
afterEach(() => {
  retryPolicy.attempts = 3;
  retryPolicy.baseDelayMs = 1000;
});

describe.each(PROTOCOLS)("a cause confirmed by a file that was read (%s)", (protocol) => {
  it("is confirmed for the team: the observation names the file as its source", async () => {
    const model = scriptedModel(protocol, (request) => {
      if (request.toolResults === 0) return { calls: [{ name: "file_read", args: { path: "/etc/nginx/acme.conf" } }] };
      if (request.toolResults === 1) {
        // The file's reference is in the request; the model cites it.
        expect(request.raw).toContain("[S1]");
        return { calls: [{ name: "sshs3_hypotheses", args: { hypotheses: [{ id: "h1", text: "nginx gives up on the upstream after 60s", status: "confirmed", evidence: [{ supports: true, text: "proxy_read_timeout is 60s in acme.conf", id: "e1", sourceRef: "S1" }] }] } }] };
      }
      return { text: "The timeout is 60s [S1]." };
    });
    const events: RunEvent[] = [];
    const task = {
      id: "t1", title: "t", mode: "assisted", status: "running", target: { sessionId: "s1", generation: 1, label: "web-01" },
      messages: [{ id: "m", role: "user", text: "SSE streams drop after 60s. Why?", at: 1 }],
      changes: [], sources: [], createdAt: 1, updatedAt: 1, maxCommands: 0, maxMinutes: 0, verification: "not-verified",
    } as unknown as AgentTask;
    const broker = async (req: { action: string }) =>
      req.action === "context" ? {} : req.action === "file-read" ? { content: "proxy_read_timeout 60s;\n", hash: "h", source: "web-01:/etc/nginx/acme.conf", observedAt: 5 } : {};
    await new DirectAgentRuntime(broker as never, undefined, model.fetch).start(task, model.config(), (event) => events.push(event));
    expect(events.find((e) => /^run\./.test(e.type) && e.type !== "run.retrying")?.type).toBe("run.completed");
    const hypotheses = events.filter((e) => e.type === "hypotheses.updated").at(-1)!.hypotheses as AgentHypothesis[];
    expect(hypotheses[0].evidence[0].source).toMatchObject({ ref: "S1", kind: "server-reading", taskId: "t1" });
    // What the hub makes of it on the ticket: a confirmed diagnosis, not "insufficient evidence".
    const ticket = { id: "k1", title: "SSE drops", status: "doing", createdAt: 1, updatedAt: 1 } as unknown as WorkTicket;
    const after = ticketAfterRun(ticket, { ...task, status: "completed", hypotheses, messages: [...task.messages, { id: "a", role: "assistant", text: "The timeout is 60s [S1].", at: 9 }] } as AgentTask, 10);
    expect(after.diagnosis).toMatchObject({ status: "confirmed", hypothesisId: "h1" });
  });
});

describe("taking a hypothesis off the list", () => {
  const list = (n: number, status: AgentHypothesis["status"] = "open"): AgentHypothesis[] =>
    Array.from({ length: n }, (_, i) => ({ id: `h${i + 1}`, text: `Cause ${i + 1}`, status, evidence: status === "open" ? [] : [{ supports: status === "confirmed", text: "seen" }] }));

  it("removes it, and makes room on a full list", () => {
    const previous = list(24);
    const full = parseHypotheses({ hypotheses: [{ id: "h25", text: "One more cause", status: "open" }] }, { previous });
    expect(full).toEqual({ error: expect.stringContaining("at most 24 hypotheses. Take one off the list with `withdraw`") });
    const made = parseHypotheses({ hypotheses: [{ id: "h25", text: "One more cause", status: "open" }], withdraw: ["h3", "h7"] }, { previous });
    if ("error" in made) throw new Error(made.error);
    expect(made.withdrawn).toEqual(["h3", "h7"]);
    expect(made.hypotheses.map((h) => h.id)).not.toContain("h3");
    expect(made.hypotheses.map((h) => h.id)).toContain("h25");
    expect(made.hypotheses).toHaveLength(23);
    // What is not sent and not withdrawn stays as it was.
    expect(made.hypotheses.find((h) => h.id === "h1")).toEqual(previous[0]);
  });

  it("refuses one that is confirmed, one that is not there, and one that is sent in the same call", () => {
    const previous = [...list(1, "confirmed"), { id: "h2", text: "Cause 2", status: "ruled-out" as const, evidence: [{ supports: false, text: "excluded" }] }];
    expect(parseHypotheses({ hypotheses: [], withdraw: ["h1"] }, { previous })).toEqual({ error: expect.stringContaining("is confirmed and cannot be withdrawn") });
    expect(parseHypotheses({ hypotheses: [], withdraw: ["h9"] }, { previous })).toEqual({ error: "There is no hypothesis h9 to withdraw." });
    expect(parseHypotheses({ hypotheses: [{ id: "h2", text: "Cause 2", status: "open" }], withdraw: ["h2"] }, { previous })).toEqual({ error: expect.stringContaining("both sent and withdrawn") });
    // One that was ruled out can go: it is the model's call what stays on its working list.
    const gone = parseHypotheses({ hypotheses: [], withdraw: ["h2"] }, { previous });
    expect("error" in gone ? gone.error : gone.hypotheses.map((h) => h.id)).toEqual(["h1"]);
  });
});
