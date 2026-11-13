import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubStore } from "../../src/main/ai/hub/HubStore";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function reloaded(fill: (store: HubStore) => void): Promise<{ store: HubStore; raw: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-hubstore-"));
  dirs.push(dir);
  const file = path.join(dir, "hub.json");
  const first = new HubStore(file);
  fill(first);
  await first.save();
  const store = new HubStore(file);
  await store.load();
  return { store, raw: await fs.readFile(file, "utf8") };
}

describe("HubStore persistence", () => {
  it("keeps a knowledge base document exactly as written, also where it looks like a secret", async () => {
    const content =
      "# Rotate the API key\nSet `api_key: <new key>` in config.yaml, then run\n`curl -H 'Authorization: Bearer $TOKEN' https://api.internal/reload`\npassword=changeme is the vendor default."; // pragma: allowlist secret
    const { store } = await reloaded((s) => {
      s.data.kbDocuments = [
        {
          id: "kb1",
          title: "Key rotation",
          sourceType: "manual",
          content,
          chunks: [{ id: "kb1#0", text: content }],
          updatedAt: 1,
        },
      ];
    });
    expect(store.data.kbDocuments![0].content).toBe(content);
    expect(store.data.kbDocuments![0].chunks[0].text).toBe(content);
  });

  it("keeps an MCP server's headers, environment and URL usable after a restart", async () => {
    const { store } = await reloaded((s) => {
      s.data.mcpServers = [
        {
          id: "m1",
          name: "Grafana",
          transport: "http",
          url: "https://svc:s3cretpw@grafana.internal/mcp", // pragma: allowlist secret
          headers: { Authorization: "Bearer glsa_abcdefghijklmnop" }, // pragma: allowlist secret
          env: { GRAFANA_TOKEN: "token=abc123def456" }, // pragma: allowlist secret
          enabled: true,
        },
      ];
    });
    const server = store.data.mcpServers![0];
    expect(server.headers).toEqual({ Authorization: "Bearer glsa_abcdefghijklmnop" }); // pragma: allowlist secret
    expect(server.env).toEqual({ GRAFANA_TOKEN: "token=abc123def456" }); // pragma: allowlist secret
    expect(server.url).toBe("https://svc:s3cretpw@grafana.internal/mcp"); // pragma: allowlist secret
  });

  it("keeps a Mission Agent's own instructions as written", async () => {
    const systemPrompt = "Never print values of the form password=... or token: ... in answers.";
    const { store } = await reloaded((s) => {
      s.data.agents = [
        { id: "a1", name: "A", role: "r", mission: "m", systemPrompt, defaultMode: "advice", updatedAt: 1 },
      ];
    });
    expect(store.data.agents![0].systemPrompt).toBe(systemPrompt);
  });

  it("still masks secrets in captured context: task messages, command output and terminal history", async () => {
    const { store, raw } = await reloaded((s) => {
      s.data.tasks = [
        {
          id: "t1",
          title: "t",
          mode: "advice",
          status: "completed",
          messages: [{ id: "m", role: "user", text: "the db password=hunter2secret", at: 1 }], // pragma: allowlist secret
          changes: [
            {
              id: "c",
              kind: "command",
              target: "prod",
              description: "d",
              status: "completed",
              output: "export AWS_KEY=AKIAABCDEFGHIJKLMNOP", // pragma: allowlist secret
              at: 1,
            },
          ],
          sources: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          maxCommands: 1,
          maxMinutes: 1,
          verification: "not-verified",
        },
      ];
      s.data.history = [
        { id: "terminal:x", label: "x", text: "Authorization: Bearer abcdefghijklmnop", observedAt: Date.now() }, // pragma: allowlist secret
      ];
    });
    expect(raw).not.toContain("hunter2secret");
    expect(raw).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(raw).not.toContain("Bearer abcdefghijklmnop");
    expect(store.data.tasks[0].messages[0].text).toContain("[redacted]");
  });
});
