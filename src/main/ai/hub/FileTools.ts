import crypto from "node:crypto";
import path from "node:path";
import type { SFTPConfig } from "../../../shared/types/storage";
import type { IpcBridge } from "../../IpcBridge";
import type { AgentChange, AgentTask } from "../../../shared/types/aiHub";
import type { ToolRequest } from "./ToolBroker";
import type { TerminalRegistry } from "./TerminalRegistry";
import { createTwoFilesPatch } from "diff";
import { clip, maskContext, safeError } from "./privacy";

/** The longest file a model is shown whole, and so may rewrite whole: what fits in what a runtime passes on. */
const MAX_WHOLE_FILE = 28_000;

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
        await this.bridge.storageRegistry.getOrCreate(
          {
            id: providerId,
            name: session.label,
            type: "sftp",
            sftpConfig: config,
          },
          // providerId is synthetic; the terminal's profile id identifies a demo target.
          { profileId: session.profileId },
        );
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
    // What a model is shown of a file: all of it, or it is told it saw only the start, and may not rewrite it.
    if (request.action === "file-read")
      return {
        content: clip(before, MAX_WHOLE_FILE),
        ...(before.length > MAX_WHOLE_FILE
          ? { complete: false, note: `Only the first ${MAX_WHOLE_FILE} of ${before.length} characters are shown. This file is too long to be rewritten whole through file_write; change it with a command in the terminal (sed, a patch) instead.` }
          : {}),
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
    if (before.length > MAX_WHOLE_FILE)
      throw new Error(
        `This file is ${before.length} characters long; a file is rewritten through the model only when it could be read whole (at most ${MAX_WHOLE_FILE}). Change it with a command in the terminal instead.`,
      );
    if (maskContext(before) !== before)
      throw new Error(
        "This file contains redacted secrets. Edit it in the terminal without asking the model to reproduce secrets.",
      );
    // What is approved is what is written: new content that would be shown masked is refused like an old one.
    if (maskContext(request.content) !== request.content)
      throw new Error(
        "The new content contains something that looks like a secret, and it would be shown masked to the person approving it. Write the secret on the server yourself, not through the model.",
      );
    const change: AgentChange = {
      id: crypto.randomUUID(),
      kind: "file",
      target: session.label,
      // The path is always kept, whatever the agent says the change is.
      description: clip(request.description ? `${file} — ${request.description}` : file, 300),
      before,
      after: request.content,
      // What changes, line by line: what a person approves.
      diff: createTwoFilesPatch(file, file, before, request.content, "now", "proposed", { context: 3 }),
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
      // A write that failed half-way leaves a file nobody wanted: put back what was there.
      let restored: boolean;
      try {
        await this.bridge.fileEditorService.saveFile(this.bridge.storageRegistry, providerId, file, before);
        restored = (await read()) === before;
      } catch {
        restored = false;
      }
      change.status = restored ? "failed" : "uncertain";
      change.output = `${safeError(error)}\n${restored ? "The file was put back as it was." : "The file could not be put back as it was: look at it on the server."}`;
      task.verification = "incomplete";
      this.changed();
      throw error;
    }
  }
}
