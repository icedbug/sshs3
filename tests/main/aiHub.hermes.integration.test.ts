import { describe, it, expect, vi } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.env.TEMP || "/tmp",
  },
}));
import { HermesManager } from "../../src/main/ai/HermesManager";
import {
  HermesRuntime,
  type RunEvent,
} from "../../src/main/ai/hub/AgentRuntime";
import { ToolBroker } from "../../src/main/ai/hub/ToolBroker";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import type { AgentTask } from "../../src/shared/types/aiHub";
describe.skipIf(process.env.SSHS3_HERMES_INTEGRATION !== "1")(
  "packaged Hermes contract",
  () => {
    it("admits a run, exposes only sshs3 tools, invokes broker and streams the final result", async () => {
      const home = await fs.mkdtemp(
        path.join(os.tmpdir(), "sshs3-hermes-contract-"),
      );
      const toolsSeen = new Set<string>();
      const model = http.createServer(async (req, res) => {
        let raw = "";
        for await (const c of req) raw += c;
        if (req.url?.endsWith("/models")) {
          res
            .writeHead(200, { "Content-Type": "application/json" })
            .end(
              JSON.stringify({
                data: [{ id: "contract-model", object: "model" }],
              }),
            );
          return;
        }
        const input = JSON.parse(raw || "{}");
        for (const tool of input.tools ?? [])
          toolsSeen.add(tool.function?.name ?? tool.name);
        const usedTool = input.messages?.some(
          (m: { role: string }) => m.role === "tool",
        );
        const message = usedTool
          ? {
              role: "assistant",
              content: "Verified: broker returned the test observation.",
            }
          : {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_context",
                  type: "function",
                  function: {
                    name: "sshs3",
                    arguments: '{"action":"context"}',
                  },
                },
              ],
            };
        if (input.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const delta = usedTool
            ? { content: message.content }
            : { tool_calls: [{ index: 0, ...message.tool_calls![0] }] };
          res.write(
            "data: " +
              JSON.stringify({
                id: "completion",
                object: "chat.completion.chunk",
                model: "contract-model",
                choices: [{ index: 0, delta, finish_reason: null }],
              }) +
              "\n\n",
          );
          res.end(
            "data: " +
              JSON.stringify({
                id: "completion",
                object: "chat.completion.chunk",
                model: "contract-model",
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: usedTool ? "stop" : "tool_calls",
                  },
                ],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 5,
                  total_tokens: 15,
                },
              }) +
              "\n\ndata: [DONE]\n\n",
          );
        } else {
          res
            .writeHead(200, { "Content-Type": "application/json" })
            .end(
              JSON.stringify({
                id: "completion",
                object: "chat.completion",
                model: "contract-model",
                choices: [
                  {
                    index: 0,
                    message,
                    finish_reason: usedTool ? "stop" : "tool_calls",
                  },
                ],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 5,
                  total_tokens: 15,
                },
              }),
            );
        }
      });
      await new Promise<void>((resolve) =>
        model.listen(0, "127.0.0.1", resolve),
      );
      const port = (model.address() as { port: number }).port;
      const terminal = new TerminalRegistry();
      const context = vi.fn(async () => ({
        observation: "test observation",
        source: "test:contract",
        observedAt: Date.now(),
      }));
      const broker = new ToolBroker(terminal, {
        context,
        memory: async () => [],
        file: async () => ({}),
        changed: () => {},
      });
      const task: AgentTask = {
        id: "contract",
        title: "Contract",
        mode: "advice",
        status: "running",
        messages: [
          {
            id: "first",
            role: "user",
            text: "Read context and describe the observation.",
            at: Date.now(),
          },
        ],
        changes: [],
        sources: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        maxCommands: 1,
        maxMinutes: 2,
        verification: "not-verified",
      };
      const toolEndpoint = await broker.issue(task);
      const manager = new HermesManager({
        homeDir: home,
        runtimeDir: process.env.SSHS3_HERMES_RUNTIME_DIR,
        toolEndpoint,
        startTimeoutMs: 90000,
      });
      const runtime = new HermesRuntime(manager);
      try {
        const events: RunEvent[] = [];
        await runtime.start(
          task,
          {
            kind: "custom",
            model: "contract-model",
            baseUrl: "http://127.0.0.1:" + port + "/v1",
            apiKey: "contract-only",
          },
          (event) => events.push(event),
        );
        expect(context).toHaveBeenCalled();
        expect([...toolsSeen]).toEqual(["sshs3"]);
        const final = events.find((e) => e.type === "run.completed");
        expect(final, JSON.stringify(events)).toBeDefined();
        expect(final!.output).toContain("test observation");
      } finally {
        await runtime.stop();
        await broker.dispose();
        terminal.dispose();
        model.closeAllConnections();
        await new Promise<void>((resolve) => model.close(() => resolve()));
        await fs.rm(home, { recursive: true, force: true });
      }
    }, 180000);
  },
);
