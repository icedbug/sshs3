/* global require, process */
// A stand-in for an external coding agent: speaks the Agent Client Protocol on stdio.
// Behaviour is chosen by FAKE_ACP: "ask" asks permission for a shell command, "crash" exits, "auth" refuses the session.
const readline = require("node:readline");
const mode = process.env.FAKE_ACP || "plain";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const waiting = new Map();
let nextId = 100;
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
process.stdout.write("not json, an agent that logs to stdout\n");
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined) return waiting.get(m.id)?.(m.result ?? m.error);
  if (m.method === "initialize")
    return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: mode === "old" ? 0 : 1, agentCapabilities: {} } });
  if (m.method === "session/new") {
    if (mode === "auth") return send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "Authentication required" } });
    if (mode === "crash") return process.exit(3);
    return send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } });
  }
  if (m.method === "session/cancel") return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
  if (m.method === "session/prompt") {
    promptId = m.id;
    const update = (u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: u } });
    update({ sessionUpdate: "plan", entries: [{ content: "Read the code", priority: "high", status: "completed" }, { content: "Run the tests", priority: "high", status: "in_progress" }] });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Prompt was: " + m.params.prompt[0].text.slice(0, 4000) + "\n" } });
    if (mode === "hang") return;
    let verdict = "not asked";
    if (mode === "ask-by-id") {
      // As the spec allows: the command is said when the call is announced, the permission request names only the call.
      update({ sessionUpdate: "tool_call", toolCallId: "c2", title: "Terminal", kind: "execute", status: "pending", rawInput: { command: "rm -rf /srv/data" } });
      const answer = await ask("session/request_permission", {
        sessionId: "s1",
        toolCall: { toolCallId: "c2" },
        options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }],
      });
      verdict = answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled";
      update({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "failed", content: [{ type: "content", content: { type: "text", text: "rm: permission denied" } }] });
    }
    if (mode === "ask") {
      update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Run npm test", kind: "execute", status: "pending", rawInput: { command: process.env.FAKE_ACP_COMMAND || "npm test" } });
      const answer = await ask("session/request_permission", {
        sessionId: "s1",
        toolCall: { toolCallId: "c1", title: "Run npm test", kind: "execute", rawInput: { command: process.env.FAKE_ACP_COMMAND || "npm test" } },
        options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "no", name: "Reject", kind: "reject_once" }],
      });
      verdict = answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled";
      update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: verdict === "yes" ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: verdict === "yes" ? "12 passed" : "not run" } }] });
    }
    // The client offers no file access: asking for it must be refused, not hang.
    const fsAnswer = await ask("fs/read_text_file", { sessionId: "s1", path: "/etc/passwd" });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Permission: ${verdict}. File read through the client: ${fsAnswer.code === -32601 ? "refused" : "ALLOWED"}.` } });
    send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  }
});
let promptId;
