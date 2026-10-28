import crypto from "node:crypto";
import path from "node:path";
import type { SFTPConfig } from "../../../shared/types/storage";
import type { IpcBridge } from "../../IpcBridge";
import type { AgentChange, AgentTask } from "../../../shared/types/aiHub";
import type { ToolRequest } from "./ToolBroker";
import type { TerminalRegistry } from "./TerminalRegistry";
import { boundedContext, maskContext, safeError } from "./privacy";

/** File providers are resolved from the bound live session, never from model-supplied host IDs. */
export class FileTools {
  constructor(
    private readonly bridge: IpcBridge,
    private readonly terminals: TerminalRegistry,
    private readonly changed: () => void,
  ) {}
  async invoke(
    task: AgentTask,
    request: ToolRequest,
    authorize: (change: AgentChange) => Promise<void>,
  ): Promise<unknown> {
    if (task.mode === "advice")
      throw new Error(
        "Advice can only use existing context. Attach the file to the task.",
      );
    let target = task.target;
    if (!target) throw new Error("File access requires a bound terminal");
    const initial = this.terminals.get(target.sessionId);
    if (
      initial &&
      initial.generation === target.generation &&
      (initial.state !== "ready" || !initial.shell)
    ) {
      const ready = await this.terminals.ensureReady(target.sessionId);
      target = {
        sessionId: ready.id,
        generation: ready.generation,
        label: ready.label,
      };
      task.target = target;
    }
    const prepared = this.terminals.get(target.sessionId);
    if (
      prepared &&
      prepared.generation === target.generation &&
      prepared.state === "ready" &&
      prepared.owner !== task.id
    ) {
      this.terminals.claim(target.sessionId, target.generation, task.id);
    }
    const assertTarget = (): void => {
      const session = this.terminals.get(target!.sessionId);
      if (
        !session ||
        session.generation !== target!.generation ||
        session.owner !== task.id ||
        session.state !== "ready"
      )
        throw new Error("Terminal authority changed; file access stopped");
    };
    assertTarget();
    const session = this.terminals.get(target.sessionId)!;
    const file = request.path;
    if (
      typeof file !== "string" ||
      file.length > 4000 ||
      file.includes("\0") ||
      !(session.kind === "local"
        ? path.isAbsolute(file)
        : path.posix.isAbsolute(file))
    )
      throw new Error("Use an absolute path on the assigned target");
    const providerId = "ai-file:" + session.id + ":" + session.generation;
    if (!this.bridge.storageRegistry.has(providerId)) {
      if (session.kind === "local") {
        // WSL and nested shells do not share the host filesystem namespace.
        if (
          process.platform === "win32" &&
          !["cmd", "powershell", "pwsh"].includes(session.shell ?? "")
        )
          throw new Error(
            "For WSL files, use a command in the assigned terminal",
          );
        await this.bridge.storageRegistry.getOrCreate({
          id: providerId,
          name: session.label,
          type: "local",
        });
      } else if (session.kind === "ssh") {
        const live = this.bridge.sshPtyManager.getSession(session.id);
        if (!live) throw new Error("SSH connection no longer exists");
        let config: SFTPConfig = {
          ...live.config,
          id: providerId,
          port: live.config.port ?? 22,
        };
        config = await this.bridge.smartcard.prepareSftpSmartcardConfig(
          config,
          providerId,
        );
        config = await this.bridge.smartcard.prepareFido2SftpConfig(
          config,
          providerId,
        );
        await this.bridge.storageRegistry.getOrCreate({
          id: providerId,
          name: session.label,
          type: "sftp",
          sftpConfig: config,
        });
      } else {
        const live = this.bridge.k8sTerminalManager.getSession(session.id);
        if (!live) throw new Error("Container connection no longer exists");
        await this.bridge.storageRegistry.getOrCreate({
          id: providerId,
          name: session.label,
          type: "k8s",
          k8sConfig: { ...live.target, id: providerId, name: session.label },
        });
      }
    }
    const read = async (): Promise<string> => {
      const value = await this.bridge.fileEditorService.readFile(
        this.bridge.storageRegistry,
        providerId,
        file,
        64_000,
      );
      if (value.truncated || value.isBinary || value.notUtf8)
        throw new Error(
          "Only complete UTF-8 text files under 64 KB are supported",
        );
      return value.content;
    };
    const before = await read();
    assertTarget();
    const hash = (text: string): string =>
      crypto.createHash("sha256").update(text).digest("hex");
    if (request.action === "file-read")
      return {
        content: boundedContext(before, 64_000),
        hash: hash(before),
        source: session.label + ":" + file,
        observedAt: Date.now(),
      };
    if (
      typeof request.content !== "string" ||
      Buffer.byteLength(request.content, "utf8") > 64_000 ||
      request.expected !== hash(before)
    )
      throw new Error("Read this file first and provide its expected hash");
    if (maskContext(before) !== before)
      throw new Error(
        "This file contains redacted secrets. Edit it in the terminal without asking the model to reproduce secrets.",
      );
    const change: AgentChange = {
      id: crypto.randomUUID(),
      kind: "file",
      target: session.label,
      description: boundedContext(request.description || file),
      before,
      after: boundedContext(request.content, 64_000),
      status: "pending",
      at: Date.now(),
    };
    task.changes.push(change);
    try {
      await authorize(change);
      assertTarget();
      if (hash(await read()) !== request.expected)
        throw new Error("File changed during review; no write performed");
      assertTarget();
    } catch (error) {
      if (change.status !== "denied") change.status = "failed";
      change.output = safeError(error);
      this.changed();
      throw error;
    }
    change.status = "running";
    task.verification = "not-verified";
    this.changed();
    try {
      await this.bridge.fileEditorService.saveFile(
        this.bridge.storageRegistry,
        providerId,
        file,
        request.content,
      );
      const actual = await read();
      if (actual !== request.content)
        throw new Error("Post-write verification failed");
      change.status = "completed";
      change.output =
        "File content read back and matched the proposed change. Application behavior still needs verification.";
      this.changed();
      return {
        changeId: change.id,
        hash: hash(actual),
        source: session.label + ":" + file,
        verified: "file-content-only",
      };
    } catch (error) {
      change.status = "uncertain";
      change.output = safeError(error);
      task.verification = "incomplete";
      this.changed();
      throw error;
    }
  }
}
