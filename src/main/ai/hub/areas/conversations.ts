import crypto from "node:crypto";
import { app } from "electron";
import type {
  AgentMode,
  AgentChange,
  HubReply,
  AgentTask,
  InlineCommandSuggestion,
  MemoryEntry,
  TerminalSession,
  WorkspaceActivityEvent,
} from "../../../../shared/types/aiHub";
import { CONTEXT_NOTE_PREFIX, SHELL_KINDS } from "../../../../shared/types/aiHub";
import { DEFAULT_AI_MODELS, usesResponsesApi } from "../../../../shared/types/ai";
import { analyzeCommandSafety } from "../CommandSafetyService";
import { hostOf } from "../Notifier";
import { getBuiltinSkillsAndMemories, getDemoTasks, getDemoWorkforceRuns, isDemoMode } from "../demoWorkspace";
import { type DetectedCommandActivity } from "../TerminalRegistry";
import { scopedMemory } from "../ContextService";
import { boundedContext, boundedPrompt, clip, maskContext, maskProviderText, safeError, workspaceHostNames } from "../privacy";
import {
  requiredText,
  integer,
  extractResponseTextFromRaw,
  extractResponseText,
  parseInlineCommandJson,
  buildInstantCommandSuggestion,
} from "../hubHelpers";
import { log, checkedSuggestion, active, INLINE_SUGGEST_TIMEOUT_MS } from "../hubShared";
import type { HubService } from "../HubService";
import type { Handled, RequestsOf } from "./routes";

/**
 * A person's requests about a conversation, and the settings.
 *
 * Starting and answering, stopping, going back to a checkpoint, taking a change back, forking and
 * compacting; the AI settings; a one-line command suggestion; and what is written to the team's
 * activity log.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
export class ConversationsPart {
  /**
   * Whether a model answers at an address: asked once, nothing kept. What it
   * says is for the person choosing a model, so it names the address and what to do.
   */
  async probeModel(this: HubService, baseUrl?: string): Promise<{ ok: boolean; detail: string; models?: string[] }> {
    const view = await this.config.getView();
    const url = (baseUrl ?? view.baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!baseUrl && !view.enabled) return { ok: false, detail: "The assistant is switched off. Switch it on in AI settings." };
    if (!url) {
      if (view.codexConnected) return { ok: true, detail: "Signed in. The sign-in is checked when a message is sent." };
      return view.hasApiKey
        ? { ok: true, detail: "A key is saved. It is checked when a message is sent." }
        : { ok: false, detail: "No key is saved and no model address is set. Add one in AI settings." };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        const saved = await this.config.getConfig();
        const headers: Record<string, string> = {};
        if (saved.apiKey && saved.baseUrl?.trim().replace(/\/+$/, "") === url) {
          if (saved.provider === "openai-compatible") headers.Authorization = `Bearer ${saved.apiKey}`;
          if (saved.provider === "anthropic") {
            headers["x-api-key"] = saved.apiKey;
            headers["anthropic-version"] = "2023-06-01";
          }
        }
        const res = await this.fetchModel(saved, `${url}/models`, { headers, signal: controller.signal });
        if (res.status === 401 || res.status === 403) return { ok: false, detail: Object.keys(headers).length
          ? `${hostOf(url)} refused the saved key. Check the key in AI settings.`
          : `${hostOf(url)} requires a key to list models. Save the address and its key in AI settings.` };
        if (!res.ok) return { ok: false, detail: `${hostOf(url)} answered with an error (${res.status}). Check the address in AI settings.` };
        const body = (await res.json().catch(() => undefined)) as { data?: { id?: string }[] } | undefined;
        const models = (body?.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean).slice(0, 50);
        return { ok: true, detail: models.length ? `${hostOf(url)} answers. It offers ${models.length} model${models.length === 1 ? "" : "s"}.` : `${hostOf(url)} answers.`, models };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const local = /127\.0\.0\.1|localhost|\[::1\]/.test(url);
      const why = e instanceof Error && e.name === "AbortError" ? "did not answer in time" : "did not answer";
      return { ok: false, detail: `No model answered: ${hostOf(url)} ${why}.${local ? " Start the local model (for Ollama: ollama serve), or choose another one in AI settings." : " Check the address, or choose another model in AI settings."}${local ? "" : ` (${clip(safeError(e), 120)})`}` };
    }
  }

  appendActivityEvent(this: HubService, event: WorkspaceActivityEvent): void {
    this.store.data.activityLog ??= [];
    this.store.data.activityLog = [
      ...this.store.data.activityLog.filter((x) => x.id !== event.id),
      event,
    ].slice(-500);
  }

  async recordTerminalCommandActivity(this: HubService,
    session: TerminalSession,
    commandLine: string,
    classified: DetectedCommandActivity,
  ): Promise<void> {
    try {
      const activeFailure = classified.resolvedFailure;
      const actor = await this.resolveActorName();
      const event: WorkspaceActivityEvent = {
        id: crypto.randomUUID(),
        at: Date.now(),
        actor,
        profileId: session.profileId,
        targetLabel: session.label,
        kind: classified.kind,
        summary: clip(classified.summary, 400),
        detail: boundedContext(commandLine, 1000),
      };
      this.appendActivityEvent(event);

      // Voyager Failure->Fix Self-Learning: if this session resolved a prior failure with exitCode 0, capture the recovery command
      if (activeFailure && activeFailure.command.trim() !== commandLine.trim()) {
        const res = this.selfLearning.learnFromCommandResolution({
          memories: this.store.data.memories,
          failure: activeFailure,
          fixCommand: commandLine,
          scope: `server:${session.label}`,
        });
        this.store.data.memories = res.memories;
        this.terminals.dismissFailure(session.id);
        // What a person happened to run next is a note on this computer, not a skill for the team:
        // nothing showed it was the fix. Only a proven fix (core) is shared.
        if (res.learnedSkill && res.learnedSkill.scope !== "personal" && res.learnedSkill.tier === "core") {
          await this.host.saveWorkspaceMemory?.(res.learnedSkill).catch(() => {});
        }
      }

      await this.host.recordWorkspaceActivity?.(event).catch(() => {});
      await this.syncAutoMemoryForTarget(session.profileId, session.label);
      this.s3Workspace.schedulePush();
      this.changed();
    } catch {
      // Never let activity logging disrupt terminal operation
    }
  }

  async recordAgentChangeActivity(this: HubService,
    task: AgentTask,
    change: AgentChange,
    sessionId?: string,
  ): Promise<void> {
    try {
      const session = sessionId
        ? this.terminals.get(sessionId)
        : task.target
          ? this.terminals.get(task.target.sessionId)
          : undefined;
      // Only a command that is shown to have worked may be learned as the fix for a failure.
      // A change with its own check counts only when the check passed and had not passed before:
      // otherwise the "failure" before it is its own failed check, and the change is what broke it.
      const provenFix =
        change.kind === "command" &&
        change.exitCode === 0 &&
        // A plain command proves nothing about a failure before it; only a change whose own check showed it.
        Boolean(change.check && change.status === "completed" && change.check.after === true && change.check.before === false);
      const activeFailure =
        session && provenFix
          ? this.terminals.consumeResolvedFailure(session.id)
          : undefined;
      const actor = `${await this.resolveActorName()} (AI)`;
      const targetLabel = change.target || session?.label || task.title;
      const how = change.rollback?.ran
        ? change.rollback.restored === false
          ? "rolled back, not as it was"
          : "rolled back"
        : change.status === "completed"
          ? ""
          : change.status;
      const event: WorkspaceActivityEvent = {
        // Named after the change, so this computer's own Changes list shows it once, not twice.
        id: `change-${change.id}`,
        at: Date.now(),
        actor,
        profileId: session?.profileId,
        targetLabel,
        kind: change.kind === "file" ? "config-edit" : "command",
        summary: clip(
          `${change.description}${how ? ` (${how})` : change.exitCode !== undefined && change.exitCode !== 0 ? ` (exit ${change.exitCode})` : ""}`,
          400,
        ),
        detail: change.command
          ? boundedContext(change.command, 1000)
          : change.kind === "file"
            ? boundedContext(`File: ${change.target}`, 400)
            : undefined,
      };
      this.appendActivityEvent(event);

      // Voyager Failure->Fix Self-Learning: if an AI command succeeded on a session with a prior failure
      if (
        session &&
        activeFailure &&
        change.kind === "command" &&
        change.exitCode === 0 &&
        change.command &&
        activeFailure.command.trim() !== change.command.trim()
      ) {
        const res = this.selfLearning.learnFromCommandResolution({
          memories: this.store.data.memories,
          failure: activeFailure,
          fixCommand: change.command,
          fixOutput: change.output,
          scope: `server:${targetLabel}`,
          // Only reached for a proven fix (see provenFix above).
          proven: true,
        });
        this.store.data.memories = res.memories;
        this.terminals.dismissFailure(session.id);
        if (res.learnedSkill && res.learnedSkill.scope !== "personal") {
          await this.host.saveWorkspaceMemory?.(res.learnedSkill).catch(() => {});
        }
      }

      await this.host.recordWorkspaceActivity?.(event).catch(() => {});
      await this.syncAutoMemoryForTarget(session?.profileId, targetLabel);
      this.s3Workspace.schedulePush();
    } catch {
      // Non-fatal
    }
  }

  async generateInlineSuggestion(this: HubService,
    prompt: string,
    sessionId?: string,
    context?: string,
    shell?: string,
  ): Promise<InlineCommandSuggestion> {
    const q = prompt.trim();
    const lower = q.toLowerCase();
    const session = sessionId ? this.terminals.get(sessionId) : undefined;
    const targetShell =
      shell ||
      session?.shell ||
      (process.platform === "win32" && session?.kind === "local"
        ? "powershell"
        : "bash");

    const dismissed = new Set(
      this.store.data.preferences.dismissedBuiltinIds ?? [],
    );
    const deletedMemoryIds = this.store.data.deletedMemoryIds ?? {};
    const candidateSkills: MemoryEntry[] = [
      ...this.store.data.memories.filter((m) => Boolean(m.sourceCommand)),
      ...getBuiltinSkillsAndMemories().filter(
        (m) =>
          Boolean(m.sourceCommand) &&
          !dismissed.has(m.id) &&
          (deletedMemoryIds[m.id] ?? 0) < (m.updatedAt ?? 0) &&
          !this.store.data.memories.some((x) => x.id === m.id),
      ),
    ];

    // Check Voyager Self-Learning & built-in skills first for POSIX shells, then fast heuristic fallback
    const learnedMatch =
      targetShell !== "cmd" &&
      targetShell !== "powershell" &&
      targetShell !== "pwsh"
        ? this.selfLearning.findBestLearnedCommand(
            // Only what applies here: a command saved for another server is not offered on this one.
            session
              ? [
                  ...scopedMemory(candidateSkills, `target:${session.profileId ?? session.id}`, true, {
                    targetLabel: session.label,
                    serverName: this.getKnownServers().find((s) => s.id === session.profileId)?.name,
                    serverHost: this.getKnownServers().find((s) => s.id === session.profileId)?.host,
                    cluster: this.getKnownServers().find((s) => s.id === session.profileId)?.cluster,
                  }),
                ]
              : candidateSkills.filter((m) => !/^(server|target|cluster):/.test(m.scope)),
            q,
          )
        : undefined;
    const fallback =
      learnedMatch ?? buildInstantCommandSuggestion(q, lower, targetShell);

    const sysPrompt = `You are an inline terminal command generator for ${targetShell}. Return ONLY a JSON object {"command":"...","explanation":"..."} with a single safe shell command matching the user's request and a 1-sentence explanation in the user's language.`;

    try {
      const config = await this.config.getConfig();
      if (config.enabled) {
        const hosts = config.piiScrubbing === "strict" ? workspaceHostNames(this.getKnownServers(), session?.label) : undefined;
        const question = clip(maskProviderText(q, config.piiScrubbing, hosts), 1000);
        const output = context ? boundedContext(maskProviderText(context, config.piiScrubbing, hosts), 1500) : "";
        const userPrompt = `Request: ${question}\n${output ? `Terminal output context:\n${output}` : ""}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), INLINE_SUGGEST_TIMEOUT_MS);
        try {
          let outputText = "";
          if (config.provider === "openai-codex") {
            const { CodexAuthProvider, buildCodexHeaders } = await import(
              "../../CodexAuthProvider"
            );
            // The same sign-in a run would use: the workspace's own folder, and on the desktop app
            // the person's `codex login` too.
            const configDir =
              typeof this.config.codexAuthDir === "function"
                ? this.config.codexAuthDir()
                : undefined;
            const auth = new CodexAuthProvider(configDir);
            const creds = await auth.resolveCredentials();
            if (creds) {
              const baseUrl = (config.baseUrl || creds.baseUrl).replace(/\/$/, "");
              const resp = await this.fetchModel(config, `${baseUrl}/responses`, {
                method: "POST",
                headers: buildCodexHeaders(creds.accessToken, baseUrl),
                body: JSON.stringify({
                  model: config.model || creds.defaultModel || "gpt-6.1-sol",
                  // A reasoning model at its default effort takes 5 to 11 seconds for this; one command does not need it.
                  reasoning: { effort: "low" },
                  instructions: sysPrompt,
                  input: [
                    {
                      type: "message",
                      role: "user",
                      content: [{ type: "input_text", text: userPrompt }],
                    },
                  ],
                  store: false,
                  stream: true,
                }),
                signal: controller.signal,
              });
              if (resp.ok) {
                if (typeof resp.text === "function") {
                  outputText = extractResponseTextFromRaw(await resp.text());
                } else if (typeof resp.json === "function") {
                  outputText = extractResponseText(
                    (await resp.json()) as Record<string, unknown>,
                  );
                }
              }
            }
          } else if (config.provider === "openai-compatible" && config.baseUrl && usesResponsesApi(config.baseUrl, config.apiProtocol)) {
            const url = config.baseUrl.replace(/\/$/, "") + "/responses";
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
            const resp = await this.fetchModel(config, url, {
              method: "POST", headers, signal: controller.signal,
              body: JSON.stringify({ model: config.model, instructions: sysPrompt, input: userPrompt, max_output_tokens: 400, store: false }),
            });
            if (resp.ok) {
              const result = await resp.json() as Record<string, unknown>;
              if (result.status === "completed") outputText = extractResponseText(result);
            }
          } else if (config.provider === "openai-compatible" && config.baseUrl) {
            const baseUrl = config.baseUrl.replace(/\/$/, "");
            const headers: Record<string, string> = {
              "Content-Type": "application/json",
            };
            if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
            // `plain`: the limit under the name OpenAI's newer models take, and no temperature (they take their own only).
            const ask = (plain: boolean): Promise<Response> =>
              this.fetchModel(config, `${baseUrl}/chat/completions`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                  model: config.model || DEFAULT_AI_MODELS["openai-compatible"],
                  messages: [
                    { role: "system", content: sysPrompt },
                    { role: "user", content: userPrompt },
                  ],
                  ...(plain ? { max_completion_tokens: 400 } : { max_tokens: 400, temperature: 0.1 }),
                  stream: false,
                }),
                signal: controller.signal,
              });
            let resp = await ask(false);
            if (resp.status === 400) resp = await ask(true);
            if (resp.ok) {
              const json = (await resp.json()) as {
                choices?: Array<{ message?: { content?: string } }>;
              };
              outputText = json.choices?.[0]?.message?.content ?? "";
            }
          } else if (config.provider === "anthropic" && config.apiKey) {
            const base = (config.baseUrl || "https://api.anthropic.com").replace(
              /\/$/,
              "",
            );
            const endpoint = base.endsWith("/v1")
              ? `${base}/messages`
              : `${base}/v1/messages`;
            const resp = await this.fetchModel(config, endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": config.apiKey,
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify({
                model: config.model || DEFAULT_AI_MODELS.anthropic,
                max_tokens: 400,
                system: sysPrompt,
                messages: [{ role: "user", content: userPrompt }],
              }),
              signal: controller.signal,
            });
            if (resp.ok) {
              const json = (await resp.json()) as {
                content?: Array<{ type?: string; text?: string }>;
              };
              outputText = (json.content ?? [])
                .filter((b) => typeof b.text === "string")
                .map((b) => b.text)
                .join("\n");
            }
          }
          const parsed = parseInlineCommandJson(outputText);
          if (parsed) {
            return {
              command: parsed.command,
              explanation: parsed.explanation,
              sessionId,
              createdAt: Date.now(),
              source: "model",
            };
          }
        } finally {
          clearTimeout(timeout);
        }
      }
    } catch {
      // Fall back to instant deterministic command suggestion
    }

    // No model answered (none is connected, it took too long, or it did not give a command).
    return {
      ...fallback,
      sessionId,
      createdAt: Date.now(),
      source: learnedMatch ? "skill" : "fallback",
    };
  }
  /** The requests this part answers. What a case leaves in `reply` goes back with the snapshot. */
  async handleConversations(this: HubService, request: RequestsOf<"conversations">): Promise<Handled> {
    let reply: HubReply | undefined;
    switch (request.action) {
      case "snapshot":
        return { snapshot: await this.snapshot() };
      case "inspect":
        this.previewId = request.sessionId;
        break;
      case "resume": {
        const task = this.task(request.taskId);
        if (active(task)) throw new Error("Task is still active");
        await this.reviveOwnTerminal(task);
        if (task.target) {
          const session = this.terminals.get(task.target.sessionId);
          if (!session || session.state === "disconnected") {
            if (task.mode === "advice") {
              task.target = undefined;
            } else {
              throw new Error("Target terminal is no longer connected");
            }
          } else {
            task.target = {
              sessionId: session.id,
              generation: session.generation,
              label: session.label,
            };
          }
        }
        // After a spent budget, resuming is "Continue": the run gets the same budget again.
        const spent = task.budgetStop;
        const more = spent
          ? `You have ${task.maxCommands} more commands and ${task.maxMinutes} more minutes. Continue where you stopped. `
          : "";
        task.messages.push({
          id: crypto.randomUUID(),
          role: "user",
          text: task.target
            ? `${more}Resume on this terminal. Recheck the current state; do not replay any uncertain command.`
            : spent
              ? more.trim()
              : "Resume the conversation.",
          at: Date.now(),
        });
        await this.launch(task);
        break;
      }
      case "configure": {
        // The preferences are worked out on a copy and checked first: a request that is refused
        // changes nothing, neither the preferences nor the AI settings sent with them.
        const next = { ...this.store.data.preferences };
        if (request.preferences) {
          const p = request.preferences;
          if (p.retentionDays !== undefined)
            next.retentionDays = integer(
              p.retentionDays,
              1,
              365,
            );
          for (const key of ["background", "autoStart", "inventory"] as const)
            if (p[key] !== undefined)
              next[key] = p[key] === true;
          if (p.recordSessions !== undefined) {
            next.recordSessions = p.recordSessions === true;
            this.recorder?.setPolicy({ allowHumanOptIn: next.recordSessions });
          }
          if (p.proposeMemories !== undefined)
            next.proposeMemories =
              p.proposeMemories === true;
          if (p.autoSaveMemories !== undefined)
            next.autoSaveMemories =
              p.autoSaveMemories === true;
          if (p.workforceAutopilot !== undefined)
            next.workforceAutopilot =
              p.workforceAutopilot === true;
          if (p.approvalWaitMinutes !== undefined)
            next.approvalWaitMinutes = integer(p.approvalWaitMinutes, 0, 10_080);
          // On a shared server the path is the server's own and set by its administrator: not by whoever is signed in.
          if (p.sharedWorkspacePath !== undefined && !this.hosted()) {
            const cleanedPath = p.sharedWorkspacePath.trim();
            if (cleanedPath) {
              next.sharedWorkspacePath = cleanedPath;
            } else {
              delete next.sharedWorkspacePath;
            }
          }
          if (
            next.autoStart &&
            !next.background
          )
            throw new Error("Autostart requires background mode");
        }
        // Preferences can be changed on their own: the AI settings are touched only when they were sent.
        if (request.config?.baseUrl?.trim()) await this.assertModelEndpointReach(request.config.baseUrl.trim());
        if (request.config) await this.config.update(request.config);
        if (request.preferences) {
          if (!("sharedWorkspacePath" in next)) delete this.store.data.preferences.sharedWorkspacePath;
          Object.assign(this.store.data.preferences, next);
          await this.host.backgroundChanged(
            this.background,
            this.store.data.preferences.autoStart,
          );
        }
        const config = await this.config.getView();
        this.terminals.observe(config.enabled);
        if (!config.enabled)
          for (const task of this.store.data.tasks.filter(active))
            await this.stop(task, "AI disabled");
        break;
      }
      case "start": {
        // Chatting with an agent runs that agent: its pause and its budget hold here too.
        const as = request.task.agentId ? this.getAgentsList().find((a) => a.id === request.task.agentId) : undefined;
        if (as) this.assertMayRun(as);
        reply = { started: { taskId: (await this.start(request.task)).id } };
        break;
      }
      case "reply": {
        const task = this.task(request.taskId);
        const rawAttachments = (request.attachments ?? []).slice(0, 10);
        const replyImages = rawAttachments
          .filter(
            (s) =>
              typeof s.imageDataUrl === "string" &&
              s.imageDataUrl.startsWith("data:image/"),
          )
          .map((s) => ({
            label: clip(s.label || "image", 200),
            dataUrl: s.imageDataUrl!.slice(0, 6_000_000),
            mimeType: s.mimeType,
          }));
        for (const s of rawAttachments) {
          if (!s.imageDataUrl && s.text?.trim()) {
            task.sources.push({
              id: crypto.randomUUID(),
              label: clip(s.label || "attachment", 200),
              text: boundedContext(s.text),
              observedAt: Date.now(),
            });
          }
        }
        const rawText =
          request.text?.trim() ||
          (replyImages.length > 0 ? "Analyze the attached image(s)." : "");
        // Asked again: the question that is already there, answered anew.
        const again = request.retry === true;
        if (again && active(task)) throw new Error("This conversation is still running. Stop it first, then ask again.");
        const asked = again ? task.messages.map((m) => m.role).lastIndexOf("user") : -1;
        if (again && asked < 0) throw new Error("There is no question here to ask again.");
        // A message is read from its start: what a person says first (or an approval's instruction) is kept.
        const text = again ? "" : clip(requiredText(rawText), 16_000);
        if (active(task)) {
          await this.runtimes.get(task.id)?.steer(text);
          task.messages.push({
            id: crypto.randomUUID(),
            role: "user",
            text,
            ...(replyImages.length > 0 ? { images: replyImages } : {}),
            at: Date.now(),
          });
        } else {
          // The run has ended but may still be releasing its runtime: a reply
          // sent in that instant must not fail with "Task already running".
          await this.whenSettled(task);
          if (request.sessionId) {
            const explicitTerminal = this.terminals.get(request.sessionId);
            if (explicitTerminal && explicitTerminal.state !== "disconnected") {
              task.target = {
                sessionId: explicitTerminal.id,
                generation: explicitTerminal.generation,
                label: explicitTerminal.label,
              };
            }
          } else if (task.target) {
            await this.reviveOwnTerminal(task);
            const terminal = this.terminals.get(task.target.sessionId);
            if (terminal && terminal.state !== "disconnected") {
              task.target = {
                sessionId: terminal.id,
                generation: terminal.generation,
                label: terminal.label,
              };
            } else {
              task.target = undefined;
            }
          }
          if (again) {
            // What followed the question was the answer being asked again: the new one takes its place.
            // The question is asked now, so what the earlier try ran (still in the tool log) comes
            // before it, and the model knows what was already done.
            task.messages.splice(asked + 1);
            task.messages[asked] = { ...task.messages[asked], at: Date.now() };
          } else
            task.messages.push({
              id: crypto.randomUUID(),
              role: "user",
              text,
              ...(replyImages.length > 0 ? { images: replyImages } : {}),
              at: Date.now(),
            });
          await this.launch(task);
        }
        break;
      }
      case "stop":
        await this.stop(this.task(request.taskId), "Stopped by user");
        break;
      case "task-read": {
        // Read as it is: a demo conversation that is only listed is not made a stored one by being looked at.
        const found =
          this.store.data.tasks.find((t) => t.id === request.taskId) ??
          (isDemoMode() ? getDemoTasks().find((t) => t.id === request.taskId) : undefined);
        if (!found) throw new Error("Task not found");
        reply = { task: { id: found.id, messages: found.messages, changes: found.changes } };
        break;
      }
      case "takeover":
        this.terminals.takeover(request.sessionId);
        break;
      case "arm":
        if (!SHELL_KINDS.includes(request.shell))
          throw new Error("Unsupported shell");
        await this.terminals.arm(request.sessionId, request.shell);
        break;
      case "inline-suggest": {
        reply = {
          inlineSuggestion: checkedSuggestion(
            await this.generateInlineSuggestion(
              requiredText(request.prompt),
              request.sessionId,
              request.context,
              request.shell,
            ),
          ),
        };
        break;
      }
      case "ai-probe":
        reply = { probe: await this.probeModel(request.baseUrl?.trim() || undefined) };
        break;
      case "layout-event-ack": {
        if (this.pendingLayoutEvent?.id === request.id) {
          this.pendingLayoutEvent = undefined;
        }
        break;
      }
      case "forget-history":
        if (this.store.data.tasks.some(active))
          throw new Error("Stop active tasks before deleting history");
        this.store.data.tasks = [];
        this.store.data.history = [];
        this.store.data.workforceRuns = [];
        if (isDemoMode()) {
          for (const dt of getDemoTasks()) {
            this.markBuiltinDismissed(dt.id, getDemoTasks());
          }
          for (const dw of getDemoWorkforceRuns()) {
            this.markBuiltinDismissed(dw.id, getDemoWorkforceRuns());
          }
        }
        this.terminals.observe(false);
        this.terminals.observe((await this.config.getView()).enabled);
        break;
      case "restore-checkpoint": {
        const task = this.task(request.taskId);
        const change = task.changes.find((c) => c.id === request.changeId);
        if (!change) throw new Error("Change not found");
        if (!this.host.restoreCheckpoint) {
          throw new Error("Checkpoint restore is unavailable");
        }
        await this.host.restoreCheckpoint(change, { task, force: request.force });
        task.updatedAt = Date.now();
        if (!isDemoMode()) {
          void this.audit()
            .append({
              kind: "file-write",
              actor: await this.resolveActorName(),
              target: change.target,
              what: change.rollback?.command || `restoreCheckpoint(${change.description})`,
              outcome: "rolled-back",
              taskId: task.id,
              changeId: change.id,
            })
            .catch((e) => log.warn("Could not write to the audit log", safeError(e)));
        }
        break;
      }
      case "rollback-change": {
        const task = this.task(request.taskId);
        const change = task.changes.find((c) => c.id === request.changeId);
        if (!change) throw new Error("Change not found");
        if (change.kind === "file" && this.host.restoreCheckpoint) {
          await this.host.restoreCheckpoint(change, { task });
          task.updatedAt = Date.now();
          break;
        }
        const rollbackCmd = change.rollback?.command?.trim();
        if (!rollbackCmd) throw new Error("This change has no rollback command");
        // Only what actually ran can be taken back, and only once: the rollback of a change that was
        // refused or never ran would be a new change that nobody approved.
        if (!["completed", "failed", "uncertain"].includes(change.status))
          throw new Error("This change did not run, so there is nothing to take back.");
        if (change.rollback?.ran) throw new Error("This change has already been taken back.");
        // The rollback is the model's own command. It was shown on the change the person approved; one
        // that is destructive (or a check that is not read-only) is not run from a button: it goes
        // through the agent, where it is asked about like any other command.
        const rollbackRisk = analyzeCommandSafety(rollbackCmd);
        if (rollbackRisk.riskLevel === "destructive")
          throw new Error(
            `The rollback command is destructive (${rollbackRisk.riskReason}). Ask the assistant to take the change back, so that the command is approved like any other.`,
          );
        const checkCmd = change.check?.command?.trim();
        const checkIsReadOnly = !!checkCmd && analyzeCommandSafety(checkCmd).riskLevel === "safe";
        const sessionId = task.target?.sessionId;
        const session = sessionId ? this.terminals.get(sessionId) : undefined;
        if (!session || session.state !== "ready" || !session.shell) {
          throw new Error("No ready terminal is bound to this task for rollback");
        }
        if (session.owner && session.owner !== task.id) {
          throw new Error("Terminal is currently busy with another task");
        }
        const alreadyOwned = session.owner === task.id;
        if (!alreadyOwned) {
          this.terminals.claim(session.id, session.generation, task.id);
        }
        let runRes: { output: string; exitCode: number };
        let restored: boolean | undefined;
        try {
          runRes = await this.terminals.execute(session.id, session.generation, task.id, rollbackCmd, 120_000);
          if (request.verify !== false && checkCmd && checkIsReadOnly) {
            const checkRes = await this.terminals.execute(
              session.id,
              session.generation,
              task.id,
              checkCmd,
              60_000,
            );
            restored = checkRes.exitCode === 0;
          }
        } finally {
          if (!alreadyOwned) {
            this.terminals.release(task.id);
          }
        }
        change.rollback = {
          ...change.rollback,
          command: rollbackCmd,
          ran: true,
          exitCode: runRes.exitCode,
          output: maskContext(runRes.output),
          ...(restored !== undefined ? { restored } : {}),
        };
        task.updatedAt = Date.now();
        if (!isDemoMode()) {
          void this.audit()
            .append({
              kind: "change",
              actor: await this.resolveActorName(),
              target: change.target,
              what: `Rollback: ${rollbackCmd}`,
              outcome: runRes.exitCode === 0 ? "rolled-back" : "failed",
              exitCode: runRes.exitCode,
              taskId: task.id,
              changeId: change.id,
            })
            .catch((e) => log.warn("Could not write to the audit log", safeError(e)));
        }
        break;
      }
      case "task-fork": {
        const parent = this.task(request.taskId);
        const mode: AgentMode = request.mode ?? parent.mode;
        if (!["advice", "plan", "assisted", "autonomous"].includes(mode)) {
          throw new Error("Invalid autonomy mode");
        }
        let sourceMessages = parent.messages;
        if (request.fromMessageId) {
          const cutIdx = parent.messages.findIndex((m) => m.id === request.fromMessageId);
          if (cutIdx < 0) throw new Error("Fork message not found");
          sourceMessages = parent.messages.slice(0, cutIdx + 1);
        }
        const now = Date.now();
        const forked: AgentTask = {
          id: crypto.randomUUID(),
          title: clip(request.title?.trim() || `Fork: ${parent.title}`, 120),
          mode,
          agentId: parent.agentId,
          agentName: parent.agentName,
          status: sourceMessages.some((m) => m.role === "assistant") ? "completed" : "interrupted",
          target: parent.target ? { ...parent.target } : undefined,
          messages: sourceMessages.map((m) => ({
            ...m,
            id: crypto.randomUUID(),
            ...(m.images ? { images: m.images.map((img) => ({ ...img })) } : {}),
          })),
          changes: [],
          sources: parent.sources.map((s) => ({ ...s })),
          ...(parent.todos ? { todos: parent.todos.map((td) => ({ ...td })) } : {}),
          ...(parent.hypotheses ? { hypotheses: parent.hypotheses.map((h) => ({ ...h })) } : {}),
          ...(parent.handoffChain ? { handoffChain: [...parent.handoffChain] } : {}),
          parentTaskId: parent.id,
          ...(request.fromMessageId ? { forkedFromMessageId: request.fromMessageId } : {}),
          createdAt: now,
          updatedAt: now,
          maxCommands: parent.maxCommands,
          maxMinutes: parent.maxMinutes,
          verification: "not-verified",
        };
        this.store.data.tasks.push(forked);
        reply = { started: { taskId: forked.id } };
        break;
      }
      case "compact-task": {
        const task = this.task(request.taskId);
        if (active(task)) {
          throw new Error("Stop the running task before compacting its conversation");
        }
        const keepRecent = 4;
        if (task.messages.length > keepRecent) {
          const older = task.messages.slice(0, task.messages.length - keepRecent);
          const recent = task.messages.slice(-keepRecent);
          // What was asked first is the task itself: it is kept whole (as far as a summary can hold it).
          const asked = older.filter((m) => m.role === "user" && m.text.trim());
          const firstAsk = asked[0] ? [`Asked first:\n${boundedPrompt(asked[0].text.trim(), 2000)}`] : [];
          const userGoals = asked
            .slice(1)
            .slice(-3)
            .map((m) => `- User: ${clip(m.text.trim(), 240)}`);
          const keyFindings = older
            .filter((m) => m.role === "assistant" && m.text.trim())
            .slice(-3)
            .map((m) => `- Assistant: ${clip(m.text.trim(), 320)}`);
          const changeNotes = task.changes
            .slice(-5)
            .map((c) => `- Change [${c.status}]: ${clip(c.description, 160)}`);
          const focusLine = request.focus?.trim()
            ? `Focus: ${clip(request.focus.trim(), 200)}`
            : "";
          const summaryParts = [
            `Summary of ${older.length} earlier message(s) of this conversation, which were compacted.`,
            focusLine,
            ...firstAsk,
            ...userGoals,
            ...keyFindings,
            ...changeNotes,
          ].filter(Boolean);
          task.messages = [
            {
              id: crypto.randomUUID(),
              role: "system",
              // Marked as context: the model is given it. An ordinary system note is for the person only,
              // and the earlier conversation would be gone from the model's view altogether.
              text: CONTEXT_NOTE_PREFIX + clip(summaryParts.join("\n"), 6000),
              at: Date.now(),
            },
            ...recent,
          ];
          task.updatedAt = Date.now();
        }
        break;
      }
      case "quit":
        app.quit();
        break;
      default: {
        // Every request of this part has a case above: one that is given to it and not handled does not compile.
        const unhandled: never = request;
        throw new Error(`Unknown AI request: ${String((unhandled as { action?: unknown })?.action)}`);
      }
    }
    return reply ? { reply } : {};
  }
}
