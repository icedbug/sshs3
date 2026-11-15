import crypto from "node:crypto";
import path from "node:path";
import type { SFTPConfig } from "../../../shared/types/storage";
import type { IpcBridge } from "../../IpcBridge";
import type { AgentChange, AgentTask } from "../../../shared/types/aiHub";
import type { TerminalRegistry } from "./TerminalRegistry";
type ManagedTerminal = NonNullable<ReturnType<TerminalRegistry["get"]>>;
import { createTwoFilesPatch } from "diff";
import { clip, containsSecrets, safeError } from "./privacy";
import type { ToolRequest } from "./ToolBroker";

/** The longest file a model is shown whole, and so may rewrite whole: what fits in what a runtime passes on. */
const MAX_WHOLE_FILE = 28_000;
const MAX_READ_BYTES = 64_000;

interface FileCheckpoint {
  providerId: string;
  filePath: string;
  sessionId: string;
  generation: string;
  taskId: string;
  afterHash: string;
}

const sha256 = (text: string): string =>
  crypto.createHash("sha256").update(text).digest("hex");

function extractFilePathFromChange(change: AgentChange): string | undefined {
  if (change.diff) {
    const match = /^---\s+([^\t\r\n]+)/m.exec(change.diff);
    const candidate = match?.[1]?.trim();
    if (candidate && candidate !== "/dev/null") return candidate;
  }
  const desc = change.description?.trim();
  if (!desc) return undefined;
  const idx = desc.indexOf(" — ");
  return idx >= 0 ? desc.slice(0, idx).trim() : desc;
}

/** File providers are resolved from the bound live session, never from model-supplied host IDs. */
export class FileTools {
  private checkpoints = new Map<string, FileCheckpoint>();

  constructor(
    private readonly bridge: IpcBridge,
    private readonly terminals: TerminalRegistry,
    private readonly changed: () => void,
  ) {}

  private async ensureProvider(session: ManagedTerminal): Promise<string> {
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
          // providerId is synthetic; the terminal's profile id identifies a demo target,
          // and live.controlPath reuses the active SSH ControlMaster socket without re-auth.
          {
            profileId: session.profileId,
            ...(live.controlPath ? { controlPath: live.controlPath } : {}),
          },
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
    return providerId;
  }

  private async readUtf8(providerId: string, filePath: string): Promise<string> {
    const value = await this.bridge.fileEditorService.readFile(
      this.bridge.storageRegistry,
      providerId,
      filePath,
      MAX_READ_BYTES,
    );
    if (value.truncated || value.isBinary || value.notUtf8)
      throw new Error(
        "Only complete UTF-8 text files under 64 KB are supported",
      );
    return value.content;
  }

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

    const providerId = await this.ensureProvider(session);
    const before = await this.readUtf8(providerId, file);
    assertTarget();
    const currentHash = sha256(before);

    // What a model is shown of a file: all of it, or it is told it saw only the start, and may not rewrite it whole.
    if (request.action === "file-read")
      return {
        content: clip(before, MAX_WHOLE_FILE),
        ...(before.length > MAX_WHOLE_FILE
          ? {
              complete: false,
              note: `Only the first ${MAX_WHOLE_FILE} of ${before.length} characters are shown. This file is too long to be rewritten whole through file_write; use file_patch with expectedHash and targeted edits, or a command in the terminal instead.`,
            }
          : {}),
        hash: currentHash,
        source: session.label + ":" + file,
        observedAt: Date.now(),
      };

    const isPatch =
      request.action === "file-patch" || request.action === "file_patch";
    let proposedContent: string;
    let expectedHash: string;
    let editsApplied: number | undefined;

    if (isPatch) {
      const candidateHash = request.expectedHash ?? request.expected;
      if (typeof candidateHash !== "string" || !candidateHash.trim())
        throw new Error("Read this file first and provide its expectedHash");
      if (candidateHash !== currentHash) {
        return {
          ok: false,
          mismatch: true,
          currentHash,
          source: session.label + ":" + file,
          error:
            "File hash mismatch: the file changed since your last read. Retry with currentHash after reviewing the latest content.",
        };
      }
      if (!Array.isArray(request.edits) || request.edits.length === 0)
        throw new Error("file_patch requires a non-empty edits array");
      if (request.edits.length > 50)
        throw new Error("file_patch accepts at most 50 edits per call");

      let patched = before;
      for (let i = 0; i < request.edits.length; i++) {
        const edit = request.edits[i];
        if (
          !edit ||
          typeof edit.oldText !== "string" ||
          edit.oldText.length === 0 ||
          typeof edit.newText !== "string"
        ) {
          throw new Error(
            `Invalid patch edit at index ${i}: oldText must be a non-empty string and newText must be a string`,
          );
        }
        const firstIdx = patched.indexOf(edit.oldText);
        if (firstIdx === -1) {
          throw new Error(
            `Patch hunk #${i + 1} not found in ${file}; re-read the target region and retry`,
          );
        }
        const secondIdx = patched.indexOf(edit.oldText, firstIdx + edit.oldText.length);
        if (secondIdx !== -1) {
          throw new Error(
            `Patch hunk #${i + 1} matched multiple locations in ${file}; include more surrounding context in oldText`,
          );
        }
        patched =
          patched.slice(0, firstIdx) +
          edit.newText +
          patched.slice(firstIdx + edit.oldText.length);
      }
      if (Buffer.byteLength(patched, "utf8") > MAX_READ_BYTES)
        throw new Error("Patched file content exceeds the 64 KB limit");
      proposedContent = patched;
      expectedHash = candidateHash;
      editsApplied = request.edits.length;
    } else {
      if (
        typeof request.content !== "string" ||
        Buffer.byteLength(request.content, "utf8") > MAX_READ_BYTES ||
        request.expected !== currentHash
      )
        throw new Error("Read this file first and provide its expected hash");
      if (before.length > MAX_WHOLE_FILE)
        throw new Error(
          `This file is ${before.length} characters long; a file is rewritten through the model only when it could be read whole (at most ${MAX_WHOLE_FILE}). Use file_patch or a command in the terminal instead.`,
        );
      proposedContent = request.content;
      expectedHash = request.expected;
    }

    if (containsSecrets(before))
      throw new Error(
        "This file contains redacted secrets. Edit it in the terminal without asking the model to reproduce secrets.",
      );
    // What is approved is what is written: new content that would be shown masked is refused like an old one.
    if (containsSecrets(proposedContent))
      throw new Error(
        "The new content contains something that looks like a secret, and it would be shown masked to the person approving it. Write the secret on the server yourself, not through the model.",
      );

    const change: AgentChange = {
      id: crypto.randomUUID(),
      kind: "file",
      target: session.label,
      // The path is always kept, whatever the agent says the change is.
      description: clip(
        request.description ? `${file} — ${request.description}` : file,
        300,
      ),
      before,
      after: proposedContent,
      beforeHash: currentHash,
      // What changes, line by line: what a person approves.
      diff: createTwoFilesPatch(
        file,
        file,
        before,
        proposedContent,
        "now",
        "proposed",
        { context: 3 },
      ),
      status: "pending",
      at: Date.now(),
    };
    task.changes.push(change);
    try {
      await authorize(change);
      assertTarget();
      const latestContent = await this.readUtf8(providerId, file);
      const latestHash = sha256(latestContent);
      if (latestHash !== expectedHash) {
        const mismatchErr = new Error(
          "File changed during review; no write performed",
        ) as Error & { currentHash?: string };
        mismatchErr.currentHash = latestHash;
        throw mismatchErr;
      }
      assertTarget();
    } catch (error) {
      if ((error as { code?: string })?.code === "approval_required") {
        change.status = "pending";
        this.changed();
        throw error;
      }
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
        proposedContent,
      );
      const actual = await this.readUtf8(providerId, file);
      if (actual !== proposedContent)
        throw new Error("Post-write verification failed");
      const finalHash = sha256(actual);
      this.checkpoints.set(change.id, {
        providerId,
        filePath: file,
        sessionId: session.id,
        generation: session.generation,
        taskId: task.id,
        afterHash: finalHash,
      });
      change.status = "completed";
      change.output =
        "File content read back and matched the proposed change. Application behavior still needs verification.";
      this.changed();
      return {
        changeId: change.id,
        hash: finalHash,
        beforeHash: currentHash,
        source: session.label + ":" + file,
        verified: "file-content-only",
        ...(editsApplied !== undefined ? { editsApplied } : {}),
      };
    } catch (error) {
      // A write that failed half-way leaves a file nobody wanted: put back what was there.
      let restored: boolean;
      try {
        await this.bridge.fileEditorService.saveFile(
          this.bridge.storageRegistry,
          providerId,
          file,
          before,
        );
        restored = (await this.readUtf8(providerId, file)) === before;
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

  /**
   * Restores a completed file change back to its `before` snapshot, refusing
   * if the file was modified since the change unless `force: true` is passed.
   */
  async restoreCheckpoint(
    change: AgentChange,
    options?: { task?: AgentTask; path?: string; force?: boolean },
  ): Promise<{
    restored: boolean;
    alreadyAtCheckpoint?: boolean;
    path: string;
    hash: string;
    beforeHash: string;
  }> {
    if (change.kind !== "file" || typeof change.before !== "string") {
      throw new Error("Only file changes with a saved before snapshot can be restored");
    }

    const checkpoint = this.checkpoints.get(change.id);
    const filePath =
      options?.path ?? checkpoint?.filePath ?? extractFilePathFromChange(change);
    if (!filePath) {
      throw new Error("Could not determine file path for checkpoint restore");
    }

    let providerId = checkpoint?.providerId;
    if (!providerId) {
      const targetRef = options?.task?.target;
      const session = targetRef
        ? this.terminals.get(targetRef.sessionId)
        : this.terminals
            .list()
            .find((s) => s.state !== "disconnected" && s.label === change.target);
      if (session) {
        providerId = await this.ensureProvider(session);
      }
    }
    if (!providerId || !this.bridge.storageRegistry.has(providerId)) {
      throw new Error(
        `No active storage provider available to restore ${filePath}`,
      );
    }

    const expectedBeforeHash = change.beforeHash ?? sha256(change.before);
    const expectedAfterHash =
      checkpoint?.afterHash ??
      (typeof change.after === "string" ? sha256(change.after) : undefined);

    const current = await this.readUtf8(providerId, filePath);
    const currentHash = sha256(current);

    if (!options?.force) {
      if (currentHash === expectedBeforeHash) {
        return {
          restored: true,
          alreadyAtCheckpoint: true,
          path: filePath,
          hash: currentHash,
          beforeHash: expectedBeforeHash,
        };
      }
      if (!expectedAfterHash || currentHash !== expectedAfterHash) {
        const err = new Error(
          `Stale checkpoint: ${filePath} was modified after this change (current hash ${currentHash})`,
        ) as Error & { currentHash?: string; expectedHash?: string };
        err.currentHash = currentHash;
        err.expectedHash = expectedAfterHash;
        throw err;
      }
    }

    await this.bridge.fileEditorService.saveFile(
      this.bridge.storageRegistry,
      providerId,
      filePath,
      change.before,
    );
    const verify = await this.readUtf8(providerId, filePath);
    const verifyHash = sha256(verify);
    if (verifyHash !== expectedBeforeHash) {
      throw new Error(`Checkpoint restore verification failed for ${filePath}`);
    }

    change.rollback = {
      command: `restoreCheckpoint(${filePath})`,
      ran: true,
      exitCode: 0,
      restored: true,
    };
    this.changed();
    return {
      restored: true,
      path: filePath,
      hash: verifyHash,
      beforeHash: expectedBeforeHash,
    };
  }
}
