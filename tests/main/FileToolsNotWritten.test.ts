import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { FileTools } from "../../src/main/ai/hub/FileTools";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import { ToolBroker } from "../../src/main/ai/hub/ToolBroker";
import type { AgentChange, AgentTask } from "../../src/shared/types/aiHub";

/**
 * A file write that wrote nothing says so. Refused at the last look at the rules, it used to write
 * the old content back, which is a write. Refused by the server before it began (the login account
 * may not write the file), it was recorded as "uncertain" with "the file could not be put back",
 * and the agent gave up instead of using a change card with sudo.
 */

const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
});

const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const CONF = "/etc/nginx/conf.d/shop.conf";

async function setup(options: { kind?: "ssh" | "local" } = {}) {
  const terminals = new TerminalRegistry();
  disposals.push(() => terminals.dispose());
  terminals.register({ id: "ssh-1", label: "web01", kind: options.kind ?? "ssh" }, (data) => {
    const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
    if (n) queueMicrotask(() => terminals.feed("ssh-1", `\x1b]777;SSHS3;${n};BEGIN\x07ok\x1b]777;SSHS3;${n};END;0;/srv\x07`));
  });
  await terminals.arm("ssh-1", "bash");
  const session = terminals.get("ssh-1")!;
  const files = new Map<string, string>([[CONF, "worker_connections 512;\n"]]);
  /** What the server does with a write. Unset: it writes. */
  const server: { write?: (path: string, content: string) => void; saves: Array<{ path: string; content: string }> } = { saves: [] };
  const registered = new Set<string>();
  const bridge = {
    storageRegistry: {
      has: (id: string) => registered.has(id),
      getOrCreate: async (cfg: { id: string }) => {
        registered.add(cfg.id);
        return {};
      },
    },
    sshPtyManager: { getSession: () => ({ config: { host: "10.0.0.20", port: 22, username: "deploy" } }) },
    smartcard: { prepareSftpSmartcardConfig: async (c: unknown) => c, prepareFido2SftpConfig: async (c: unknown) => c },
    fileEditorService: {
      readFile: async (_r: unknown, _p: string, p: string) => ({ content: files.get(p) ?? "" }),
      saveFile: async (_r: unknown, _p: string, p: string, content: string) => {
        server.saves.push({ path: p, content });
        if (server.write) server.write(p, content);
        else files.set(p, content);
      },
    },
    k8sTerminalManager: { getSession: () => undefined },
  };
  const task = {
    id: "task-1",
    title: "t",
    mode: "assisted",
    status: "running",
    messages: [],
    changes: [],
    sources: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    maxCommands: 20,
    maxMinutes: 10,
    verification: "not-verified",
    target: { sessionId: "ssh-1", generation: session.generation, label: "web01" },
  } as unknown as AgentTask;
  terminals.claim("ssh-1", session.generation, task.id);
  const tools = new FileTools(bridge as never, terminals, () => {});
  const write = (authorize: (change: AgentChange) => Promise<void>, recheck?: (change: AgentChange) => void) =>
    tools.invoke(task, { action: "file-write", path: CONF, expected: sha256(files.get(CONF)!), content: "worker_connections 2048;\n" }, authorize, recheck);
  return { terminals, task, files, server, tools, write };
}

const allow = async (change: AgentChange): Promise<void> => {
  change.status = "approved";
};

describe("a file write refused at the last look at the rules", () => {
  it("writes nothing at all: not the new content, and not the old content back", async () => {
    const { task, files, server, write } = await setup();
    await expect(
      write(allow, () => {
        throw new Error("A change freeze now holds on this target.");
      }),
    ).rejects.toThrow(/change freeze now holds/);
    expect(server.saves).toEqual([]);
    expect(files.get(CONF)).toBe("worker_connections 512;\n");
    expect(task.changes[0]).toMatchObject({ status: "denied", decidedHow: "policy", output: "Not run: A change freeze now holds on this target. Nothing was written." });
    // Nothing ran, so the run's proof is as it was.
    expect(task.verification).toBe("not-verified");
  });
});

describe("a file write the server refuses before it begins", () => {
  it("is recorded as failed and not written, puts nothing back, and tells the agent the way forward", async () => {
    const { task, files, server, write } = await setup();
    server.write = (p) => {
      throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: "EACCES" });
    };
    const error = await write(allow).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toBe(
      `The account sshs3 logs in with may not write ${CONF}. Nothing was written. Make the edit with sshs3_change and sudo instead, for example \`sudo sed -i …\` or \`sudo tee\`, with a check and a rollback. (EACCES: permission denied, open '${CONF}')`,
    );
    // One attempt to write, and no second one to "put back" what was never changed.
    expect(server.saves).toHaveLength(1);
    expect(files.get(CONF)).toBe("worker_connections 512;\n");
    const change = task.changes[0];
    expect(change.status).toBe("failed");
    expect(change.output).toBe(`Not written: the account sshs3 logs in with may not write this file (EACCES: permission denied, open '${CONF}'). The file is as it was.`);
    expect(change.output).not.toMatch(/could not be put back/);
  });

  it("knows the same refusal as a message without a code, and as the number SFTP gives", async () => {
    // The demo lab's server says it in words only.
    const words = await setup();
    words.server.write = (p) => {
      throw new Error(`EACCES: permission denied, open '${p}'`);
    };
    await expect(words.write(allow)).rejects.toThrow(/may not write .* Make the edit with sshs3_change and sudo instead/);
    expect(words.task.changes[0].status).toBe("failed");
    // SFTP: code 3.
    const sftp = await setup();
    sftp.server.write = () => {
      throw Object.assign(new Error("Permission denied"), { code: 3 });
    };
    await expect(sftp.write(allow)).rejects.toThrow(/Make the edit with sshs3_change and sudo instead/);
    expect(sftp.task.changes[0]).toMatchObject({ status: "failed" });
    expect(sftp.server.saves).toHaveLength(1);
  });

  it("says it as it is for a read-only file system and for a folder that is gone", async () => {
    const readOnly = await setup();
    readOnly.server.write = (p) => {
      throw Object.assign(new Error(`EROFS: read-only file system, open '${p}'`), { code: "EROFS" });
    };
    await expect(readOnly.write(allow)).rejects.toThrow(/is on is read-only\. Nothing was written\./);
    expect(readOnly.task.changes[0]).toMatchObject({ status: "failed", output: expect.stringMatching(/^Not written: the file system this file is on is read-only/) });
    expect(readOnly.server.saves).toHaveLength(1);

    const gone = await setup();
    gone.server.write = (p) => {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
    };
    await expect(gone.write(allow)).rejects.toThrow(/is not there any more\. Nothing was written\./);
    expect(gone.task.changes[0].status).toBe("failed");
  });

  it("speaks of the account sshs3 runs as on a terminal of this computer", async () => {
    const { write, server } = await setup({ kind: "local" });
    server.write = (p) => {
      throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: "EACCES" });
    };
    await expect(write(allow)).rejects.toThrow(/^The account sshs3 runs as may not write/);
  });

  it("any other failure that left the file as it was is failed and not written too", async () => {
    const { task, server, write } = await setup();
    server.write = () => {
      throw new Error("Connection reset before the upload began");
    };
    await expect(write(allow)).rejects.toThrow(/The file was not written: Connection reset before the upload began Nothing was written/);
    expect(task.changes[0]).toMatchObject({ status: "failed", output: "Not written: Connection reset before the upload began\nThe file is as it was." });
    expect(server.saves).toHaveLength(1);
  });
});

describe("a file write that may have happened in part", () => {
  it("is put back, and says so", async () => {
    const { task, files, server, write } = await setup();
    let first = true;
    server.write = (p, content) => {
      if (first) {
        first = false;
        // The disk filled up half-way: the file is cut short.
        files.set(p, content.slice(0, 7));
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      }
      files.set(p, content);
    };
    await expect(write(allow)).rejects.toThrow(/ENOSPC/);
    expect(server.saves).toHaveLength(2);
    expect(files.get(CONF)).toBe("worker_connections 512;\n");
    expect(task.changes[0]).toMatchObject({ status: "failed", output: "ENOSPC: no space left on device, write\nThe file was put back as it was." });
  });

  it("stays uncertain when it could not be put back", async () => {
    const { task, files, server, write } = await setup();
    server.write = (p, content) => {
      files.set(p, content.slice(0, 7));
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    };
    await expect(write(allow)).rejects.toThrow(/ENOSPC/);
    expect(task.changes[0].status).toBe("uncertain");
    expect(task.changes[0].output).toMatch(/could not be put back as it was: look at it on the server/);
  });
});

describe("through the broker", () => {
  it("a write the server refused does not hold its idempotency key, and the agent reads the way forward", async () => {
    const { terminals, task, server, tools } = await setup();
    task.mode = "autonomous";
    const broker = new ToolBroker(terminals, {
      context: async () => ({}),
      memory: async () => [],
      file: (t, request, authorize, recheck) => tools.invoke(t, request, authorize, recheck),
      changed: vi.fn(),
    });
    disposals.unshift(() => broker.dispose());
    const capability = await broker.issue(task);
    server.write = (p) => {
      throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: "EACCES" });
    };
    const request = { action: "file-write", path: CONF, expected: sha256("worker_connections 512;\n"), content: "worker_connections 2048;\n", idempotencyKey: "w1" };
    await expect(broker.invoke(capability.key, request)).rejects.toThrow(/Make the edit with sshs3_change and sudo instead/);
    expect(task.changes[0].status).toBe("failed");
    expect(broker.getIdempotencyEntry(task.id, "w1")?.status).toBe("failed");
  });

  it("hands the agent what the person said when they approved the write", async () => {
    const { terminals, task, tools, files } = await setup();
    const broker = new ToolBroker(terminals, {
      context: async () => ({}),
      memory: async () => [],
      file: (t, request, authorize, recheck) => tools.invoke(t, request, authorize, recheck),
      changed: vi.fn(),
    });
    disposals.unshift(() => broker.dispose());
    const capability = await broker.issue(task);
    const pending = broker.invoke(capability.key, { action: "file-write", path: CONF, expected: sha256("worker_connections 512;\n"), content: "worker_connections 2048;\n" });
    await vi.waitFor(() => expect(task.status).toBe("waiting"));
    broker.approve(task.id, task.changes[0].id, true, "Reload nginx afterwards, do not restart it.");
    await expect(pending).resolves.toMatchObject({ verified: "file-content-only", personNote: "Approved with a note from the person: Reload nginx afterwards, do not restart it." });
    expect(files.get(CONF)).toBe("worker_connections 2048;\n");
  });

  it("hands the agent what the person said when they approved a call to a tool of another system", async () => {
    const { terminals, task } = await setup();
    const broker = new ToolBroker(terminals, {
      context: async () => ({}),
      memory: async () => [],
      file: async () => ({}),
      // As the hub's own tools do: the call is put to the broker as a change, then made.
      appAction: async (t, request, authorize) => {
        const change: AgentChange = { id: `mcp-${t.changes.length + 1}`, kind: "command", toolCall: true, target: "MCP · Grafana", description: `Call ${request.action}`, status: "pending", at: Date.now() };
        t.changes.push(change);
        await authorize(change);
        change.status = "completed";
        return { ok: true, mcpServer: "Grafana", tool: "silence_alert", output: { silenced: true } };
      },
      changed: vi.fn(),
    });
    disposals.unshift(() => broker.dispose());
    const capability = await broker.issue(task);
    const pending = broker.invoke(capability.key, { action: "mcp__grafana__silence_alert", payload: { alert: "disk" } });
    await vi.waitFor(() => expect(task.status).toBe("waiting"));
    broker.approve(task.id, "mcp-1", true, "Silence it for one hour only.");
    await expect(pending).resolves.toEqual({
      ok: true,
      mcpServer: "Grafana",
      tool: "silence_alert",
      output: { silenced: true },
      personNote: "Approved with a note from the person: Silence it for one hour only.",
    });
    // Approved without a word: the result is as the tool gave it.
    const quiet = broker.invoke(capability.key, { action: "mcp__grafana__silence_alert", payload: { alert: "disk" } });
    await vi.waitFor(() => expect(task.status).toBe("waiting"));
    broker.approve(task.id, "mcp-2", true);
    await expect(quiet).resolves.not.toHaveProperty("personNote");
  });
});
