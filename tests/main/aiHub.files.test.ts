import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import type { IpcBridge } from "../../src/main/IpcBridge";
import type { AgentTask } from "../../src/shared/types/aiHub";
import { FileTools } from "../../src/main/ai/hub/FileTools";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
describe("task-bound file changes", () => {
  async function setup() {
    const terminals = new TerminalRegistry();
    terminals.register({ id: "s", kind: "local", label: "local" }, (data) => {
      const nonce = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      if (nonce)
        queueMicrotask(() =>
          terminals.feed(
            "s",
            "\x1b]777;SSHS3;" +
              nonce +
              ";BEGIN\x07\x1b]777;SSHS3;" +
              nonce +
              ";END;0;/\x07",
          ),
        );
    });
    await terminals.arm(
      "s",
      process.platform === "win32" ? "powershell" : "bash",
    );
    const target = {
      sessionId: "s",
      generation: terminals.get("s")!.generation,
      label: "local",
    };
    terminals.claim("s", target.generation, "t");
    const task: AgentTask = {
      id: "t",
      title: "repair",
      target,
      mode: "assisted",
      status: "running",
      messages: [],
      changes: [],
      sources: [],
      createdAt: 1,
      updatedAt: 1,
      maxCommands: 10,
      maxMinutes: 5,
      verification: "not-verified",
    };
    let content = "original";
    const readFile = vi.fn(async () => ({
      content,
      isBinary: false,
      truncated: false,
      notUtf8: false,
    }));
    const saveFile = vi.fn(
      async (_registry, _provider, _path, value: string) => {
        content = value;
      },
    );
    const host = {
      storageRegistry: { has: () => true },
      fileEditorService: { readFile, saveFile },
    } as unknown as IpcBridge;
    return {
      terminals,
      task,
      readFile,
      saveFile,
      file: process.platform === "win32" ? "C:\\test.conf" : "/test.conf",
      tools: new FileTools(host, terminals, () => {}),
      mutate: () => {
        content = "concurrent edit";
      },
    };
  }
  it("shows a diff before approval, checks expected hash, and reads the file back", async () => {
    const { terminals, task, file, tools, saveFile } = await setup();
    try {
      const read = (await tools.invoke(
        task,
        { action: "file-read", path: file },
        async () => {},
      )) as { hash: string };
      expect(read.hash).toBe(
        crypto.createHash("sha256").update("original").digest("hex"),
      );
      const approval = vi.fn(async () => {
        expect(task.changes[0]).toMatchObject({
          before: "original",
          after: "fixed",
          status: "pending",
        });
        expect(saveFile).not.toHaveBeenCalled();
      });
      expect(
        await tools.invoke(
          task,
          {
            action: "file-write",
            path: file,
            expected: read.hash,
            content: "fixed",
          },
          approval,
        ),
      ).toMatchObject({ verified: "file-content-only" });
      expect(saveFile).toHaveBeenCalledTimes(1);
      expect(approval).toHaveBeenCalledTimes(1);
    } finally {
      terminals.dispose();
    }
  });
  it("does not overwrite a file changed while approval was pending", async () => {
    const { terminals, task, file, tools, saveFile, mutate } = await setup();
    try {
      const read = (await tools.invoke(
        task,
        { action: "file-read", path: file },
        async () => {},
      )) as { hash: string };
      await expect(
        tools.invoke(
          task,
          {
            action: "file-write",
            path: file,
            expected: read.hash,
            content: "fixed",
          },
          async () => {
            mutate();
          },
        ),
      ).rejects.toThrow("changed during review");
      expect(saveFile).not.toHaveBeenCalled();
    } finally {
      terminals.dispose();
    }
  });
  it("revokes file authority on takeover even after a human approved the diff", async () => {
    const { terminals, task, file, tools, saveFile } = await setup();
    try {
      const read = (await tools.invoke(
        task,
        { action: "file-read", path: file },
        async () => {},
      )) as { hash: string };
      await expect(
        tools.invoke(
          task,
          {
            action: "file-write",
            path: file,
            expected: read.hash,
            content: "fixed",
          },
          async () => {
            terminals.takeover("s");
          },
        ),
      ).rejects.toThrow("authority changed");
      expect(task.changes.at(-1)?.status).toBe("failed");
      expect(saveFile).not.toHaveBeenCalled();
    } finally {
      terminals.dispose();
    }
  });
  it("lazily arms and claims an unarmed local terminal on first file_read / file_write", async () => {
    const terminals = new TerminalRegistry();
    terminals.register({ id: "unarmed", kind: "local", label: "Local cmd" }, (data) => {
      const nonce = (
        /SSHS3;([a-f0-9]{32});BEGIN/.exec(data) ??
        /sshs3-([a-f0-9]{32})\.cmd/.exec(data)
      )?.[1];
      if (nonce) {
        queueMicrotask(() =>
          terminals.feed(
            "unarmed",
            "\x1b]777;SSHS3;" +
              nonce +
              ";BEGIN\x07\x1b]777;SSHS3;" +
              nonce +
              ";END;0;C:\\Users\x07",
          ),
        );
      }
    });
    expect(terminals.get("unarmed")?.state).toBe("unknown");
    const target = {
      sessionId: "unarmed",
      generation: terminals.get("unarmed")!.generation,
      label: "Local cmd",
    };
    const task: AgentTask = {
      id: "t-lazy",
      title: "lazy file read",
      target,
      mode: "assisted",
      status: "running",
      messages: [],
      changes: [],
      sources: [],
      createdAt: 1,
      updatedAt: 1,
      maxCommands: 10,
      maxMinutes: 5,
      verification: "not-verified",
    };
    let content = "lazy-initial";
    const host = {
      storageRegistry: {
        has: () => false,
        getOrCreate: vi.fn(async () => ({})),
      },
      fileEditorService: {
        readFile: vi.fn(async () => ({
          content,
          isBinary: false,
          truncated: false,
          notUtf8: false,
        })),
        saveFile: vi.fn(async (_reg, _prov, _path, val: string) => {
          content = val;
        }),
      },
    } as unknown as IpcBridge;
    const tools = new FileTools(host, terminals, () => {});
    const file = process.platform === "win32" ? "C:\\test.conf" : "/test.conf";
    try {
      const read = (await tools.invoke(
        task,
        { action: "file-read", path: file },
        async () => {},
      )) as { content: string; hash: string };
      expect(read.content).toBe("lazy-initial");
      expect(terminals.get("unarmed")?.state).toBe("ready");
      expect(terminals.get("unarmed")?.owner).toBe("t-lazy");
      expect(terminals.get("unarmed")?.shell).toBe(
        process.platform === "win32" ? "cmd" : "bash",
      );
    } finally {
      terminals.dispose();
    }
  });
});

describe("what is approved of a file change, and what happens when the write fails", () => {
  async function setup(initial: string) {
    const terminals = new TerminalRegistry();
    terminals.register({ id: "s", kind: "local", label: "local" }, (data) => {
      const nonce = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      if (nonce) queueMicrotask(() => terminals.feed("s", `\x1b]777;SSHS3;${nonce};BEGIN\x07\x1b]777;SSHS3;${nonce};END;0;/\x07`));
    });
    await terminals.arm("s", process.platform === "win32" ? "powershell" : "bash");
    const target = { sessionId: "s", generation: terminals.get("s")!.generation, label: "local" };
    terminals.claim("s", target.generation, "t");
    const task: AgentTask = { id: "t", title: "repair", target, mode: "assisted", status: "running", messages: [], changes: [], sources: [], createdAt: 1, updatedAt: 1, maxCommands: 10, maxMinutes: 5, verification: "not-verified" };
    let content = initial;
    let failNext = false;
    const saveFile = vi.fn(async (_r, _p, _path, value: string) => {
      if (failNext) {
        failNext = false;
        content = value.slice(0, 3); // half-written
        throw new Error("connection lost");
      }
      content = value;
    });
    const host = {
      storageRegistry: { has: () => true },
      fileEditorService: { readFile: vi.fn(async () => ({ content, isBinary: false, truncated: false, notUtf8: false })), saveFile },
    } as unknown as IpcBridge;
    const tools = new FileTools(host, terminals, () => {});
    const hash = crypto.createHash("sha256").update(initial).digest("hex");
    return { terminals, task, tools, hash, current: () => content, failWrite: () => (failNext = true) };
  }
  const file = process.platform === "win32" ? "C:\\test.conf" : "/test.conf";

  it("shows what changes as a diff, and keeps the path when the agent describes the change", async () => {
    const { terminals, task, tools, hash } = await setup("a\nb\nc\n");
    try {
      await tools.invoke(task, { action: "file-write", path: file, expected: hash, content: "a\nB\nc\n", description: "fix b" }, async () => {
        expect(task.changes[0].diff).toContain("-b\n+B");
        expect(task.changes[0].description).toBe(`${file} — fix b`);
      });
    } finally {
      terminals.dispose();
    }
  });

  it("will not rewrite a file the model could not have read whole", async () => {
    const long = "x".repeat(30_000);
    const { terminals, task, tools, hash } = await setup(long);
    try {
      const read = (await tools.invoke(task, { action: "file-read", path: file }, async () => {})) as { complete?: boolean; content: string };
      expect(read.complete).toBe(false);
      await expect(tools.invoke(task, { action: "file-write", path: file, expected: hash, content: "short" }, async () => {})).rejects.toThrow(/could be read whole/);
    } finally {
      terminals.dispose();
    }
  });

  it("puts the file back as it was when the write fails half-way", async () => {
    const { terminals, task, tools, hash, current, failWrite } = await setup("original\n");
    try {
      failWrite();
      await expect(tools.invoke(task, { action: "file-write", path: file, expected: hash, content: "replacement\n" }, async () => {})).rejects.toThrow("connection lost");
      expect(current()).toBe("original\n");
      expect(task.changes[0].status).toBe("failed");
      expect(task.changes[0].output).toContain("put back as it was");
    } finally {
      terminals.dispose();
    }
  });
});
