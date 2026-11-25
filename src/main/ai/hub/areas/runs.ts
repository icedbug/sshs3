import crypto from "node:crypto";
import { appendSourceCalls } from "../../../../shared/answerSources";
import path from "node:path";
import type { AgentChange, AgentSchedule, AgentTask, ChatOrigin, MissionAgent, StartAgentTask } from "../../../../shared/types/aiHub";
import { isPlainCommand } from "../../../../shared/types/aiHub";
import { acpWorkspaceAllowlist } from "../../../../shared/acpWorkspaceTools";
import { DEFAULT_AI_MODELS } from "../../../../shared/types/ai";
import { CodexAuthProvider } from "../../CodexAuthProvider";
import { HermesManager, type HermesModelConfig } from "../../HermesManager";
import { isProdTag } from "../safetyPolicy";
import { AcpRuntime } from "../AcpRuntime";
import { lowerMode } from "../AppGuard";
import { stepTerminal } from "../PlanMode";
import { CHAT_NOT_EXTERNAL, reachMode } from "../chatFence";
import { Replay } from "../EvalSuite";
import { getDemoTasks, isDemoMode } from "../demoWorkspace";
import { isDemoTarget } from "../../../demo/demoMode";
import { HermesRuntime, type RunEvent } from "../AgentRuntime";
import { finalRunStatus } from "../RunOutcome";
import { LocalMcpServer } from "../LocalMcpServer";
import { boundedContext, boundedPrompt, clip, HUB_PROMPT_MAX, maskContext, PERSON_PROMPT_MAX, safeError } from "../privacy";
import { addUsage, live, tokensLeft } from "../WorkBoard";
import { taskTranscript, worthDistilling } from "../MemoryDistiller";
import { requiredText } from "../hubHelpers";
import { log, STREAMED_EVENTS, STREAM_REFRESH_MS, active, budgetStopLine, isBackgroundRun } from "../hubShared";
import type { HubService } from "../HubService";

/** The longest answer a conversation keeps. */
const ANSWER_MAX = 128_000;
/**
 * While an answer streams, only this much of its end is masked again with each piece. Masking the
 * whole answer for every piece cost 26 seconds of the main process for an answer of 120,000
 * characters. The window is wide enough for a secret that arrives split over pieces to be whole
 * inside it; the whole answer is masked once when it is complete (`sealStreamed`).
 */
const STREAM_MASK_WINDOW = 2_048;
/**
 * What the answer that is streaming has delivered so far, as it came. Kept beside the conversation
 * and never stored, so that the whole of it can be masked in one go when the answer is complete.
 * The pieces come masked already: the runtime holds back what could still turn out to be a secret
 * (StreamingSecretMasker), so they add up to what masking the whole answer gives. Masking them once
 * more as a whole only catches what the window above missed between two pieces.
 */
const streamedRaw = new WeakMap<AgentTask, { messageId: string; raw: string }>();

/** The answer that was streaming is complete: its kept text becomes the whole of it, masked once. */
function sealStreamed(task: AgentTask): void {
  const held = streamedRaw.get(task);
  if (!held) return;
  streamedRaw.delete(task);
  const message = task.messages.find((m) => m.id === held.messageId);
  if (message) message.text = boundedContext(held.raw, ANSWER_MAX);
}

function cachedTokens(task: AgentTask): number {
  return (task.usage?.cacheReadTokens ?? 0) + (task.usage?.cacheCreationTokens ?? 0);
}

/**
 * A run: an agent at work in a conversation.
 *
 * Starting one, the events it sends while it works, what it spends, stopping it, and letting
 * go of what it held when it ends. Also runs on an external agent.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
export class RunsPart {
  /**
   * A terminal the hub opened for this run is closed when the run ends: it is
   * nobody's tab, and left open it reads to the team as a person connected to
   * that server.
   */
  closeWhenRunEnds(this: HubService, taskId: string, sessionId: string): void {
    const task = this.store.data.tasks.find((t) => t.id === taskId);
    if (!task || (!active(task) && !this.runtimes.has(taskId) && !this.launches.has(taskId))) {
      this.closeOwnTerminal(sessionId);
      return;
    }
    const set = this.runTerminals.get(taskId) ?? new Set<string>();
    set.add(sessionId);
    this.runTerminals.set(taskId, set);
  }

  /**
   * Closes a terminal the hub opened for itself, and takes it out of the list
   * of terminals: closed, it is nothing anybody can use or needs to see. Six
   * "disconnected" sessions after one ticket and one schedule is what leaving
   * them there looked like.
   */
  closeOwnTerminal(this: HubService, sessionId: string): void {
    this.host.closeSession?.(sessionId);
    this.terminals.forget(sessionId);
  }

  /**
   * A terminal whose process is gone without the terminal having been told
   * (it was killed from outside, its session was cleaned up) is not "ready".
   * Asked of the host on the timer; a host that cannot say is not asked.
   */
  sweepDeadTerminals(this: HubService): void {
    if (!this.host.sessionAlive) return;
    for (const session of this.terminals.list()) {
      if (session.state === "disconnected" || session.kind === "k8s") continue;
      let alive: boolean | undefined;
      try {
        alive = this.host.sessionAlive(session.id);
      } catch {
        alive = undefined;
      }
      if (alive === false) this.terminals.invalidate(session.id, "Terminal exited", true);
    }
  }

  /** Resolves when the task's model run has ended and its runtime is released. */
  whenSettled(this: HubService, task: AgentTask): Promise<void> {
    if (
      !active(task) &&
      !this.runtimes.has(task.id) &&
      !this.launches.has(task.id)
    )
      return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.settleWaiters.get(task.id) ?? [];
      list.push(resolve);
      this.settleWaiters.set(task.id, list);
    });
  }

  settled(this: HubService, taskId: string): void {
    this.scheduledRunEnded(taskId);
    // Told to whoever follows the run without a browser: the hub's own background work is not followed.
    const ended = this.store.data.tasks.find((t) => t.id === taskId);
    if (ended && !isBackgroundRun(ended)) this.emitRun({ type: "settled", taskId, status: ended.status });
    const list = this.settleWaiters.get(taskId);
    if (!list) return;
    this.settleWaiters.delete(taskId);
    for (const resolve of list) resolve();
  }

  async start(this: HubService,
    input: StartAgentTask,
    schedule?: AgentSchedule,
    readOnly?: {
      workforceRunId?: string;
      distillSourceId?: string;
      title: string;
      mainModel?: boolean;
      modelRole?: "backgroundDistill";
      investigator?: boolean;
      evalCaseId?: string;
    },
    /** For a test-case run: what answers its tool calls. */
    replay?: Replay,
    /** The ticket the run works, known before it starts: what it is offered depends on it. */
    ticketId?: string,
    /** The chat thread it was asked from (startFromChat): its fence holds from the first tool call. */
    chat?: ChatOrigin,
  ): Promise<AgentTask> {
    if (!["advice", "plan", "assisted", "autonomous"].includes(input.mode))
      throw new Error("Invalid autonomy mode");
    const terminal = input.sessionId
      ? this.terminals.get(input.sessionId)
      : undefined;
    if (input.sessionId && (!terminal || terminal.state === "disconnected"))
      throw new Error("Target unavailable");
    // A new conversation is not started on a terminal another run is working in: the person picked
    // that terminal, and is told whose run has it. (A reply in a conversation whose terminal another run
    // took since does run: its agent uses another terminal, or says what waits there.)
    if (terminal?.owner) {
      const other = this.store.data.tasks.find((t) => t.id === terminal.owner);
      throw new Error(
        `Another task owns this terminal${other ? `: “${clip(other.title.replace(/\s+/g, " "), 80)}” is running in it` : ""}. Pick another terminal, or wait until that run is done.`,
      );
    }
    const now = Date.now();
    const rawAttachments = (input.attachments ?? []).slice(0, 10);
    const startImages = rawAttachments
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
    const rawPrompt =
      input.prompt?.trim() ||
      (startImages.length > 0 ? "Analyze the attached image(s)." : "");
    // The hub's own prompts open with their instructions and quote bounded data after them:
    // they are passed whole. A person's message that is too long loses its middle, never its start.
    const prompt = boundedPrompt(requiredText(rawPrompt), readOnly ? HUB_PROMPT_MAX : PERSON_PROMPT_MAX);
    const matchedAgent = input.agentId
      ? this.getAgentsList().find((a) => a.id === input.agentId)
      : undefined;
    const task: AgentTask = {
      id: crypto.randomUUID(),
      title: readOnly?.title ?? prompt.slice(0, 100),
      ...(readOnly?.workforceRunId
        ? { workforceRunId: readOnly.workforceRunId }
        : {}),
      ...(readOnly?.distillSourceId
        ? { distillSourceId: readOnly.distillSourceId }
        : {}),
      ...(readOnly?.mainModel ? { mainModelOnly: true } : {}),
      ...(readOnly?.modelRole ? { modelRole: readOnly.modelRole } : {}),
      ...(readOnly?.investigator ? { investigator: true } : {}),
      ...(readOnly?.evalCaseId ? { evalCaseId: readOnly.evalCaseId } : {}),
      ...(ticketId ? { ticketId } : {}),
      ...(schedule ? { scheduleId: schedule.id } : {}),
      // Words from a channel, or from somebody who is not linked to an account, are from outside.
      ...(chat ? { chat, ...(chat.kind === "channel" || !chat.askedBy.accountId ? { tainted: true } : {}) } : {}),
      mode: input.mode,
      agentId: matchedAgent?.id ?? input.agentId,
      agentName: matchedAgent?.name ?? input.agentName,
      status: "queued",
      target: terminal
        ? {
            sessionId: terminal.id,
            generation: terminal.generation,
            label: terminal.label,
          }
        : undefined,
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          text: prompt,
          ...(startImages.length > 0 ? { images: startImages } : {}),
          at: now,
        },
      ],
      changes: [],
      sources: rawAttachments
        .filter((s) => !s.imageDataUrl && s.text?.trim())
        .map((s) => ({
          id: typeof s.id === "string" && s.id.trim() ? clip(s.id, 200) : crypto.randomUUID(),
          kind: s.kind,
          label: clip(requiredText(s.label), 200),
          text: boundedContext(requiredText(s.text)),
          observedAt: Number.isFinite(s.observedAt) ? s.observedAt : now,
        })),
      createdAt: now,
      updatedAt: now,
      // No run has a limit on commands, time or model turns: a person's conversation, a ticket, a
      // schedule and the hub's own background calls alike. It runs until it is done or somebody stops it.
      maxCommands: 0,
      maxMinutes: 0,
      verification: "not-verified",
    };
    this.store.data.tasks.push(task);
    if (replay) {
      this.evalReplays.set(task.id, replay);
      // The recording is only needed while the run lasts.
      void this.whenSettled(task).then(() => this.evalReplays.delete(task.id));
    }
    try {
      await this.launch(task, schedule);
    } catch (error) {
      // A person who stopped it while it started keeps the conversation they stopped. One that could
      // not be started at all (the terminal is taken, no model is set, three are running) was never
      // a conversation: the caller gets the error, and no failed, empty entry is left in the list.
      const neverStarted = active(task) || task.status === "failed";
      if (active(task)) {
        task.status = "failed";
        task.error = safeError(error);
      }
      this.broker.revoke(task.id);
      this.terminals.release(task.id);
      if (neverStarted) this.store.data.tasks = this.store.data.tasks.filter((t) => t !== task);
      this.changed();
      throw error;
    }
    return task;
  }

  async launch(this: HubService,
    task: AgentTask,
    schedule?: AgentSchedule,
  ): Promise<void> {
    if (this.runtimes.has(task.id) || this.launches.has(task.id))
      throw new Error("Task already running");
    // Every way into a run (a new message, a reply, resuming) holds an agent to its pause and its budget.
    // The hub's own background work is bounded by the run that asked for it.
    const as = task.agentId && !isBackgroundRun(task) ? this.getAgentsList().find((a) => a.id === task.agentId) : undefined;
    if (as) this.assertMayRun(as);
    // There is no limit on how many conversations a person runs at once.
    // A run from before the limits were taken away, or one made with some, carries them: they do not hold.
    task.maxCommands = 0;
    task.maxMinutes = 0;
    const launchMarker = Symbol(task.id);
    this.launches.set(task.id, launchMarker);
    task.status = "queued";
    // Every run counts from zero: what the last one used is not carried over.
    task.budgetStop = undefined;
    delete task.quietScheduleResult;
    task.commandsUsed = 0;
    task.runUsage = undefined;
    // What this run spends is its own to be counted: the earlier runs' share stays as it was put down.
    task.usageCountedCacheTokens ??= task.usageCounted || task.usageCountedTokens !== undefined ? cachedTokens(task) : 0;
    task.usageCountedTokens = this.usagePutDown(task, (task.usage?.inputTokens ?? 0) + (task.usage?.outputTokens ?? 0));
    task.usageCounted = undefined;
    try {
      await this.reattachTicket(task);
      await this.launchReserved(task, launchMarker, schedule);
    } catch (error) {
      this.broker.revoke(task.id);
      this.terminals.release(task.id);
      if (active(task)) {
        task.status = "failed";
        task.error = safeError(error);
      }
      if (task.ticketId) this.settleTickets();
      this.changed();
      throw error;
    } finally {
      if (this.launches.get(task.id) === launchMarker) this.launches.delete(task.id);
      // A launch that failed leaves a run that never ran. Whoever waits for it to
      // settle — a test case holding its recording, a ticket, the workforce — would
      // otherwise wait for ever.
      if (!this.runtimes.has(task.id) && !active(task)) this.settled(task.id);
    }
  }

  async launchReserved(this: HubService,
    task: AgentTask,
    launchMarker: symbol,
    schedule?: AgentSchedule,
  ): Promise<void> {
    const assertLaunching = (): void => {
      if (
        this.disposed ||
        this.launches.get(task.id) !== launchMarker ||
        !active(task)
      )
        throw new Error("Task was stopped during startup");
    };
    const role = task.modelRole ?? (schedule || task.mainModelOnly || !isBackgroundRun(task)
      ? "primary" : task.distillSourceId ? "backgroundDistill" : "fastTriage");
    const config = await this.config.getConfig(role, !task.mainModelOnly);
    assertLaunching();
    if (!config.enabled)
      throw new Error("No model is set up. Switch the assistant on and choose a model in AI settings first.");
    // An agent that is an external coding agent runs there, not on the configured model.
    const safetyCtx = this.resolveSafetyContext(task, task.target?.label);
    if (safetyCtx.clusterPolicy?.maxMode) {
      task.mode = lowerMode(task.mode, safetyCtx.clusterPolicy.maxMode);
    }
    // Asked for from chat: never further than the channel's reach, and never on its own.
    if (task.chat) task.mode = lowerMode(task.mode, reachMode(task.chat.fence.reach));
    // The workspace rules reach the run through its context (ContextService: `workspaceRules`, the ones
    // that apply to its target), not as a copy of every rule's text stored on every task.
    const viaRunner = !isBackgroundRun(task) && this.getAgentsList().some((a) => a.id === task.agentId && a.runnerId);
    if (!viaRunner) await this.assertModelEndpointReach(config.baseUrl);
    const external = isBackgroundRun(task)
      ? undefined
      : this.getAgentsList().find((a) => a.id === task.agentId && a.runnerId);
    // An external agent runs its commands on this machine, through no fence and no approval in the
    // thread: a conversation asked for from chat runs on the configured model only.
    if (external && this.chatLead(task)) throw new Error(CHAT_NOT_EXTERNAL);
    // An external agent is a program with a shell and file access of its own. Telling it to only
    // advise and refusing what it asks for does not stop what it does without asking: in Advice it
    // is not started at all.
    if (external && task.mode === "advice")
      throw new Error(
        `${external.name} runs on an external agent: a program on this computer that runs commands and edits files by itself. In Advice mode nothing may be run or changed, so it was not started. Choose another mode, or an agent that runs on the configured model.`,
      );
    if (external) return this.launchExternal(task, external, assertLaunching);
    // A schedule runs on the endpoint that is configured now. It keeps a model
    // of its own only while it was saved for this same endpoint: after a change
    // of provider or address it follows the configured model instead of being
    // refused for ever.
    const pinned = Boolean(schedule && schedule.provider === config.provider && (schedule.baseUrl ?? "") === (config.baseUrl ?? ""));
    const provider = config.provider;
    let model = (pinned && schedule?.model) || config.model;
    let baseUrl = config.baseUrl;
    const configDir =
      typeof this.config.getFilePath === "function"
        ? path.dirname(this.config.getFilePath())
        : undefined;
    {
      // The team's conversations go to the provider it chose, or nowhere: a missing key or address is
      // reported as the step that is missing, never quietly made up for by a ChatGPT sign-in on this machine.
      if (provider === "openai-codex") {
        if (baseUrl && baseUrl.includes("openrouter.ai")) {
          baseUrl = undefined;
        }
        if (
          !model ||
          model === "gpt-sol-latest" ||
          model === "local" ||
          model === "gpt-5.3-codex" ||
          model === "gpt-5.4" ||
          model === "gpt-5.4-mini" ||
          model === "gpt-5.2-codex" ||
          model === "gpt-5.1-codex-max" ||
          model.startsWith("claude-")
        ) {
          const codex = await new CodexAuthProvider(configDir).getStatus();
          model = codex.defaultModel || DEFAULT_AI_MODELS["openai-codex"];
        }
      }
    }
    if (!model) throw new Error("Choose a model");
    // An agent may be given a model of its own. It names a model of the endpoint that is
    // configured now; after a change of provider it follows the configured model instead
    // of being refused for ever — the same rule a schedule's own model follows.
    const runAgent = task.agentId ? this.getAgentsList().find((a) => a.id === task.agentId) : undefined;
    if ((role === "primary" || !config.activeProfileByRole?.[role]) && runAgent?.modelOverride?.trim() && (!runAgent.modelProvider || runAgent.modelProvider === provider))
      model = runAgent.modelOverride.trim();
    task.model = model;
    // The demo lab has no model: its scripted example answers instead, and says that it does.
    if (provider === "anthropic" && !config.apiKey && !isDemoMode())
      throw new Error("Anthropic API key missing. Add a key in AI settings, or choose another model there.");
    if (provider === "openai-compatible" && !baseUrl && !isDemoMode())
      throw new Error("Model endpoint missing. Set the model's address in AI settings.");
    const modelConfig: HermesModelConfig =
      provider === "openai-codex"
        ? { kind: "openai-codex", model, baseUrl }
        : provider === "anthropic"
          ? { kind: "anthropic", model, apiKey: config.apiKey, baseUrl }
          : { kind: "custom", model, apiKey: config.apiKey, baseUrl: baseUrl! };
    modelConfig.profileId = config.profileId;
    modelConfig.fallbackProfileIds = config.fallbackProfileIds ?? [];
    modelConfig.tuning = {
      contextWindowTokens: config.contextWindowTokens,
      maxOutputTokens: config.maxOutputTokens,
      reasoningEffort: config.reasoningEffort,
      temperature: config.temperature,
    };
    modelConfig.apiProtocol = config.apiProtocol;
    modelConfig.egressPolicy = config.egressPolicy;
    modelConfig.zdrConfirmed = config.zdrConfirmed;
    if (task.target && task.mode !== "advice") {
      const live = this.terminals.get(task.target.sessionId);
      // Held by another run (it took the terminal after this conversation began): not taken from it.
      // This run goes on, and its agent uses another terminal or says what waits in this one.
      if (live && live.state === "ready" && live.shell && (!live.owner || live.owner === task.id)) {
        this.terminals.claim(
          task.target.sessionId,
          live.generation,
          task.id,
        );
        task.target.generation = live.generation;
      }
    }
    task.status = "running";
    task.error = undefined;
    task.maxCommands = 0;
    task.maxMinutes = 0;
    const capability = await this.broker.issue(task);
    assertLaunching();
    const runtime = new HermesRuntime(
      new HermesManager({
        homeDir: path.join(
          this.directory,
          "runtime",
          crypto.createHash("sha256").update(task.id).digest("hex"),
        ),
        toolEndpoint: capability,
      }),
      (req) => this.broker.invoke(capability.key, req),
      this.evalReplays.get(task.id)?.answer.bind(this.evalReplays.get(task.id)),
      this.evalReplays.get(task.id)?.isLive.bind(this.evalReplays.get(task.id)),
      // On a shared server or in the demo, only this workspace's own sign-in: never the host's ~/.codex.
      // The desktop app's own process may use the person's `codex login`.
      isDemoMode() || this.hosted() ? configDir : undefined,
      {
        ...this.outboundGuard(),
        ...(this.kbNetwork?.lookup ? { lookup: this.kbNetwork.lookup } : {}),
        egressPolicy: config.egressPolicy,
        piiMode: config.piiScrubbing,
        getConnectionProfile: (id) => this.config.getConnectionProfile(id),
        onModelRequest: this.host.onModelRequest,
      },
    );
    this.runtimes.set(task.id, runtime);
    this.changed();
    void runtime
      .start(task, modelConfig, (event) => this.event(task, event))
      .catch((error) => {
        if (active(task)) {
          task.status = "failed";
          task.error = safeError(error);
          task.verification = "incomplete";
        }
      })
      .finally(async () => {
        // A run that was let go of while it hung (see `releaseStuckRun`) ends here much later, perhaps
        // beside a new run of the same conversation: it has nothing left to end.
        if (this.runtimes.get(task.id) !== runtime) return;
        this.broker.revoke(task.id);
        this.terminals.release(task.id);
        if (active(task)) {
          task.status = "interrupted";
          task.error = "Model connection ended without a final result.";
        }
        await runtime.stop();
        // Hermes files are task-local. Erase runtime history: the redacted Hub store is authoritative.
        const fs = await import("node:fs/promises");
        await fs
          .rm(
            path.join(
              this.directory,
              "runtime",
              crypto.createHash("sha256").update(task.id).digest("hex"),
            ),
            { recursive: true, force: true },
          )
          .catch(() => {});
        if (this.runtimes.get(task.id) === runtime)
          this.runtimes.delete(task.id);
        this.settled(task.id);
        this.changed();
        // A specialist or a memory run is not a task of the user's own.
        if (!isBackgroundRun(task) && !task.quietScheduleResult)
          this.notify(
            task.status === "completed"
              ? "Task finished"
              : "Task needs attention",
            task.title,
          );
      });
  }

  event(this: HubService, task: AgentTask, event: RunEvent): void {
    const now = Date.now();
    const mapUsage = (u: Record<string, number>, prevCost?: number) => ({
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      ...(u.cache_read_input_tokens !== undefined ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
      ...(u.cache_creation_input_tokens !== undefined ? { cacheCreationTokens: u.cache_creation_input_tokens } : {}),
      ...(u.cost_usd !== undefined || prevCost !== undefined
        ? { costUsd: (prevCost ?? 0) + (u.cost_usd ?? 0) }
        : {}),
    });
    if (!active(task)) {
      sealStreamed(task);
      // A run that was already stopped still says what it spent when it ends: that counts too.
      if (/^run\./.test(event.type)) task.runUsage = undefined;
      if (/^run\./.test(event.type) && event.usage && !task.usageCounted) {
        const mapped = mapUsage(event.usage, task.usage?.costUsd);
        task.usage = {
          inputTokens: (task.usage?.inputTokens ?? 0) + mapped.inputTokens,
          outputTokens: (task.usage?.outputTokens ?? 0) + mapped.outputTokens,
          ...(mapped.cacheReadTokens !== undefined || task.usage?.cacheReadTokens !== undefined
            ? { cacheReadTokens: (task.usage?.cacheReadTokens ?? 0) + (mapped.cacheReadTokens ?? 0) }
            : {}),
          ...(mapped.cacheCreationTokens !== undefined || task.usage?.cacheCreationTokens !== undefined
            ? { cacheCreationTokens: (task.usage?.cacheCreationTokens ?? 0) + (mapped.cacheCreationTokens ?? 0) }
            : {}),
          costUsd: mapped.costUsd,
        };
        this.countAgentUsage(task);
        this.changed();
      }
      return;
    }
    if (event.type === "message.delta" && event.delta) {
      let message = task.messages.at(-1);
      if (!message || message.role !== "assistant") {
        message = {
          id: crypto.randomUUID(),
          role: "assistant",
          text: "",
          at: now,
        };
        task.messages.push(message);
      }
      if (event.sourceCalls) appendSourceCalls(message.sourceCalls ??= [], event.sourceCalls);
      let held = streamedRaw.get(task);
      if (held?.messageId !== message.id) {
        // The answer goes on in another message (the person wrote in between): the earlier part is complete.
        sealStreamed(task);
        held = { messageId: message.id, raw: message.text };
        streamedRaw.set(task, held);
      }
      held.raw += event.delta;
      // Only the last ANSWER_MAX characters are ever kept: an endless answer does not grow this without bound.
      if (held.raw.length > 4 * ANSWER_MAX) held.raw = held.raw.slice(-2 * ANSWER_MAX);
      const cut = Math.max(0, message.text.length - STREAM_MASK_WINDOW);
      const text = message.text.slice(0, cut) + maskContext(message.text.slice(cut) + event.delta);
      message.text = text.length > ANSWER_MAX ? `[earlier output omitted]\n${text.slice(-ANSWER_MAX)}` : text;
      this.host.delta?.({
        taskId: task.id,
        type: "message.delta",
        messageId: message.id,
        at: now,
        delta: event.delta,
        length: message.text.length,
      });
    }
    // An answer that broke off in the middle is asked for again: what was shown of it is taken back,
    // so the conversation does not hold it twice. The windows get the corrected text with the next
    // refresh, which follows at once (this event is not a streamed piece).
    if (event.type === "message.retract" && (event.text || event.earlier?.length)) {
      /**
       * Takes the end of the answer at `at` back; says whether the answer was taken from there. One with
       * nothing left in it goes, unless it holds what the run has read: the last answer then stays where
       * it is, and the answer is written again into it.
       */
      const takeBack = (at: number, text: string, last: boolean): boolean => {
        const message = task.messages[at];
        const held = streamedRaw.get(task);
        if (held?.messageId === message.id) held.raw = held.raw.slice(0, Math.max(0, held.raw.length - text.length));
        message.text = message.text.slice(0, Math.max(0, message.text.length - maskContext(text).length));
        if (message.text || (last && message.sourceCalls?.length)) return false;
        task.messages.splice(at, 1);
        if (held?.messageId === message.id) streamedRaw.delete(task);
        // An earlier one that holds what the run has read: that goes with the answer written again, after the person's message.
        if (message.sourceCalls?.length) {
          const end = task.messages.at(-1);
          if (end?.role === "assistant") appendSourceCalls(end.sourceCalls ??= [], message.sourceCalls);
          else task.messages.push(message);
        }
        return true;
      };
      let at = task.messages.length - 1;
      if (event.text && task.messages[at]?.role === "assistant" && takeBack(at, event.text, true)) at--;
      // What was shown before each message the person sent during the turn stands just before it.
      for (const part of [...(event.earlier ?? [])].reverse()) {
        while (at >= 0 && task.messages[at].role !== "user") at--;
        at--;
        if (at < 0) break;
        if (part && task.messages[at].role === "assistant" && takeBack(at, part, false)) at--;
      }
    }
    if (event.type === "todos.updated" && event.todos) task.todos = event.todos;
    if (event.type === "usage.updated" && event.usage) {
      const mapped = mapUsage(event.usage);
      task.runUsage = mapped;
      if (event.usage.context_tokens) task.contextTokens = event.usage.context_tokens;
      this.host.delta?.({
        taskId: task.id,
        type: "usage.updated",
        at: now,
        usage: {
          ...mapped,
          ...(event.usage.context_tokens ? { contextTokens: event.usage.context_tokens } : {}),
        },
      });
      this.stopWhenBudgetSpent(task);
    }
    if (event.type === "hypotheses.updated" && event.hypotheses) {
      task.hypotheses = event.hypotheses;
      if (event.nextObservation) task.nextDiagnosticObservation = event.nextObservation;
    }
    if (event.type === "tool.result" && event.tool) {
      const entry = { ...event.tool, at: now };
      task.toolStepCount = (task.toolStepCount ?? task.toolLog?.length ?? 0) + 1;
      task.toolLog = [...(task.toolLog ?? []), entry].slice(-60);
      this.host.delta?.({
        taskId: task.id,
        type: "tool.result",
        at: now,
        tool: entry,
        toolStepCount: task.toolStepCount,
      });
    }
    if (event.type === "run.retrying") {
      const extraEv = event as RunEvent & {
        attempt?: number;
        maxAttempts?: number;
        delayMs?: number;
        endpoint?: string;
        status?: number;
      };
      this.host.delta?.({
        taskId: task.id,
        type: "run.retrying",
        at: now,
        retry: {
          text: event.text,
          attempt: extraEv.attempt,
          maxAttempts: extraEv.maxAttempts,
          delayMs: extraEv.delayMs,
          endpoint: extraEv.endpoint,
          status: extraEv.status,
        },
      });
    }
    if (event.type === "run.degraded") {
      const extraEv = event as RunEvent & {
        fromProvider?: string;
        fromModel?: string;
        toProvider?: string;
        toModel?: string;
      };
      if (extraEv.toModel) task.model = extraEv.toModel;
      if (event.text) {
        task.messages.push({
          id: crypto.randomUUID(),
          role: "system",
          text: boundedContext(event.text, 600),
          at: now,
        });
      }
      this.host.delta?.({
        taskId: task.id,
        type: "run.degraded",
        at: now,
        degraded: {
          text: event.text,
          error: event.error,
          fromProvider: extraEv.fromProvider,
          fromModel: extraEv.fromModel,
          toProvider: extraEv.toProvider,
          toModel: extraEv.toModel,
        },
      });
    }
    const outcome = finalRunStatus(event.type);
    if (outcome) {
      task.status = outcome;
      if (task.status === "interrupted") task.verification = "incomplete";
      task.runUsage = undefined;
      if (event.usage?.context_tokens) task.contextTokens = event.usage.context_tokens;
      if (event.usage) {
        const mapped = mapUsage(event.usage, task.usage?.costUsd);
        task.usage = {
          inputTokens: (task.usage?.inputTokens ?? 0) + mapped.inputTokens,
          outputTokens: (task.usage?.outputTokens ?? 0) + mapped.outputTokens,
          ...(mapped.cacheReadTokens !== undefined || task.usage?.cacheReadTokens !== undefined
            ? { cacheReadTokens: (task.usage?.cacheReadTokens ?? 0) + (mapped.cacheReadTokens ?? 0) }
            : {}),
          ...(mapped.cacheCreationTokens !== undefined || task.usage?.cacheCreationTokens !== undefined
            ? { cacheCreationTokens: (task.usage?.cacheCreationTokens ?? 0) + (mapped.cacheCreationTokens ?? 0) }
            : {}),
          costUsd: mapped.costUsd,
        };
      }
      // The run has ended: what is kept of its answer is masked as a whole, once. A run that names
      // its answer has it put in place of what was streamed; one that does not keeps what was streamed.
      if (event.output) {
        const last = task.messages.at(-1);
        const held = streamedRaw.get(task);
        if (held && held.messageId !== last?.id) sealStreamed(task);
        streamedRaw.delete(task);
        if (last?.role === "assistant")
          last.text = boundedContext(event.output, ANSWER_MAX);
        else
          task.messages.push({
            id: crypto.randomUUID(),
            role: "assistant",
            text: boundedContext(event.output, ANSWER_MAX),
            at: Date.now(),
          });
      } else sealStreamed(task);
      // What the run read is kept with its answer. A run that ended without one (it failed, or was
      // stopped, before it wrote anything) keeps it with the last message there is: an observation
      // recorded for a hypothesis points to it, and would otherwise point to nothing.
      const answer = task.messages.at(-1);
      if (event.sourceCalls && answer) appendSourceCalls(answer.sourceCalls ??= [], event.sourceCalls);
      if (event.error) task.error = boundedContext(event.error);
      this.noteBudgetStop(task);
      if (task.status === "completed" || task.status === "failed") this.reflectTaskCompletion(task);
      // Whatever way it ended, what it spent is put down to the agent.
      this.countAgentUsage(task);
      // A handover asked for during the run happens now.
      const next = task.handoffTo && this.getAgentsList().find((a) => a.id === task.handoffTo!.agentId);
      if (next) this.applyHandoff(task, next, task.handoffTo!.reason);
      if (!isBackgroundRun(task)) this.notePageOutcome(task);
      if (
        !isBackgroundRun(task) &&
        this.store.data.preferences.proposeMemories !== false &&
        this.learnsFrom(task) &&
        worthDistilling(task)
      )
        void this.queueForLearning(
          {
            id: `task:${task.id}`,
            title: `Session: ${task.title}`,
            transcript: taskTranscript(task),
          },
          `${task.title} ${task.target?.label ?? ""}`,
          // The conversation itself: one about a personal server is not uploaded or learned from.
          task,
        ).catch((e) => log.warn("Memory proposal run failed", safeError(e)));
    }
    task.updatedAt = Date.now();
    if (task.ticketId && !active(task)) this.settleTickets();
    // A piece of the answer is not news to a follower: it reads the stored text when the run settles.
    if (!isBackgroundRun(task) && event.type !== "message.delta") this.emitRun({ type: "progress", taskId: task.id, event: event.type });
    // A piece of text, a usage count, a tool's answer: the windows were sent it as it came (host.delta)
    // and put it into the conversation themselves. Telling them to fetch everything again for each piece
    // is what a long answer did hundreds of times a second.
    if (this.host.delta && STREAMED_EVENTS.has(event.type)) this.streamed();
    else this.changed();
  }
  /**
   * While a run streams: the windows are told to fetch everything again at most once a second (a window
   * that missed a piece catches up then), and the store is saved as after any change.
   */
  streamed(this: HubService): void {
    if (this.disposed) return;
    this.streamTimer ??= setTimeout(() => {
      this.streamTimer = undefined;
      this.changed();
    }, STREAM_REFRESH_MS);
  }

  /**
   * What a run spent, put down to the agent it ran as. A ticket run was the
   * only one counted, so a mission run or a chat with an agent selected spent
   * nothing as far as the budget was concerned — and the budget is what the
   * screen calls "tokens this month".
   */
  countAgentUsage(this: HubService, task: AgentTask, agentId = task.agentId): void {
    if (!agentId) return;
    const used = (task.usage?.inputTokens ?? 0) + (task.usage?.outputTokens ?? 0);
    // `task.usage` is the whole conversation's: every run of it (a reply, an approved plan, "Continue")
    // adds to it, and only what was not put down yet is added to the agent's month.
    const cached = cachedTokens(task);
    const countedCache = task.usageCountedCacheTokens ?? (task.usageCounted ? cached : 0);
    const fresh = used - this.usagePutDown(task, used) + cached - countedCache;
    // Nothing new reported yet (a stopped run says what it spent a moment later): not counted yet either.
    if (fresh <= 0) return;
    task.usageCounted = true;
    task.usageCountedTokens = used;
    task.usageCountedCacheTokens = cached;
    this.store.data.agentUsage = addUsage(this.store.data.agentUsage ?? {}, agentId, fresh);
    this.lastWorkSync = 0;
  }

  /**
   * An agent's monthly token budget holds while it runs, not only when a run is started: each time
   * the run says what it has spent so far, that is added to the month, and the run is stopped when
   * the budget is used up. One long run could otherwise spend any amount over it.
   */
  stopWhenBudgetSpent(this: HubService, task: AgentTask): void {
    // An investigator spends for the run that asked it: that run's agent's budget holds for it, and
    // that run is stopped when it is spent (its investigators stop with it).
    const asker = task.workforceRunId ? this.investigations.get(task.workforceRunId) : undefined;
    const run = asker ? this.store.data.tasks.find((t) => t.id === asker) : task;
    if (!run?.agentId || isBackgroundRun(run) || !active(run)) return;
    const agent = this.getAgentsList().find((a) => a.id === run.agentId);
    if (!agent?.monthlyTokenBudget || agent.monthlyTokenBudget <= 0) return;
    if (tokensLeft(agent, this.usageTotal()) - this.spendingUnderWay(agent.id) > 0) return;
    void this.stop(
      run,
      `${agent.name} has used its token budget for this month (${agent.monthlyTokenBudget.toLocaleString("en-US")} tokens), so this run was stopped. Raise the budget or wait for the new month.`,
    );
  }

  /**
   * What an agent's runs have spent and not yet put down to its month: every run of it that is under
   * way or has not yet said what it spent in the end (several can work at once), and the
   * investigators those runs asked, whose spending is put down to the agent when they are all done.
   * Each is counted as the month will count it.
   */
  spendingUnderWay(this: HubService, agentId: string): number {
    const tasks = this.store.data.tasks;
    let sum = 0;
    for (const t of tasks) {
      if (t.agentId !== agentId || isBackgroundRun(t) || !t.runUsage) continue;
      // A run is counted as the month counts it when it ends: what was read, written and cached.
      const u = t.runUsage;
      sum += (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0);
    }
    for (const [runId, askerId] of this.investigations) {
      if (tasks.find((t) => t.id === askerId)?.agentId !== agentId) continue;
      for (const t of tasks) {
        if (t.workforceRunId !== runId) continue;
        // An investigator is put down as read and written (areas/agents.ts investigate): what it has said so far.
        const u = t.runUsage ?? t.usage;
        sum += (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0);
      }
    }
    return sum;
  }

  /** How many of a conversation's tokens are already on an agent's month. A conversation counted before this was kept per run was counted whole. */
  usagePutDown(this: HubService, task: AgentTask, used: number): number {
    return task.usageCountedTokens ?? (task.usageCounted ? used : 0);
  }

  async stop(this: HubService, task: AgentTask, reason: string): Promise<void> {
    if (!active(task)) return;
    this.launches.delete(task.id);
    // What was streamed up to here is what stays: masked as a whole now.
    sealStreamed(task);
    task.status = "interrupted";
    // A spent budget is said in the conversation, with the way on: not as an error.
    if (task.budgetStop) this.noteBudgetStop(task);
    else task.error = reason;
    task.verification = "incomplete";
    task.updatedAt = Date.now();
    this.broker.revoke(task.id);
    this.terminals.release(task.id);
    if (task.ticketId) this.settleTickets();
    this.changed();
    const runtime = this.runtimes.get(task.id);
    await runtime?.stop();
    if (runtime) this.releaseStuckRun(task, runtime);
    // Stopping a workforce conversation stops its specialists too.
    for (const [runId, leadId] of this.workforceLeads) {
      if (leadId !== task.id) continue;
      for (const child of this.store.data.tasks.filter(
        (t) => t.workforceRunId === runId && active(t),
      ))
        await this.stop(child, reason);
    }
  }
  releaseStuckRun(this: HubService, task: AgentTask, runtime: { stop(): Promise<void> }): void {
    const timer = setTimeout(() => {
      if (this.disposed || this.runtimes.get(task.id) !== runtime) return;
      log.warn("A stopped run did not end by itself; letting go of it", task.id);
      this.broker.revoke(task.id);
      this.terminals.release(task.id);
      this.runtimes.delete(task.id);
      task.updatedAt = Date.now();
      this.settled(task.id);
      if (task.ticketId) this.settleTickets();
      this.changed();
    }, this.runStopGraceMs);
    timer.unref?.();
  }
  /** Ends the conversation with the line that says its budget was used, once per run. */
  noteBudgetStop(this: HubService, task: AgentTask): void {
    if (!task.budgetStop) return;
    const text = budgetStopLine(task.budgetStop);
    const last = task.messages.at(-1);
    if (last?.role === "system" && last.text === text) return;
    task.messages.push({ id: crypto.randomUUID(), role: "system", text, at: Date.now() });
  }
  scope(this: HubService, task: AgentTask): string {
    const terminal = task.target && this.terminals.get(task.target.sessionId);
    return terminal
      ? `target:${terminal.profileId ?? terminal.id}`
      : "personal";
  }
  task(this: HubService, id: string): AgentTask {
    const t = this.store.data.tasks.find((x) => x.id === id);
    if (t) return t;
    // A demo conversation is listed without being stored. The first time something is done to it, it becomes a real one.
    const demo = isDemoMode() ? getDemoTasks().find((x) => x.id === id) : undefined;
    if (!demo) throw new Error("Task not found");
    const copy = structuredClone(demo);
    this.store.data.tasks.push(copy);
    return copy;
  }
  /**
   * Runs the task on an external coding agent over ACP. The agent works in
   * the folder its runner names, with its own tools; every action it asks
   * permission for is judged by the same rules as sshS3's own commands.
   */
  async launchExternal(this: HubService,
    task: AgentTask,
    agent: MissionAgent,
    assertLaunching: () => void,
  ): Promise<void> {
    this.assertRunnerAllowed();
    const runner = (this.store.data.externalRunners ?? []).find((r) => r.id === agent.runnerId);
    if (!runner)
      throw new Error(
        `${agent.name} runs on the external agent "${agent.runnerId}", which is not set up on this computer. Add it under Agents & MCP.`,
      );
    const ticket = live(this.store.data.workTickets).find((t) => t.id === task.ticketId);
    // Bridge local MCP server into ACP external agent when enabled, using an ephemeral scoped token.
    let acpLocalMcp:
      | {
          server: LocalMcpServer;
          token: string;
          scopes: ("read" | "tickets" | "run")[];
          tools?: string[];
        }
      | undefined;
    let acpTokenId: string | undefined;
    const tools = acpWorkspaceAllowlist(agent.allowedTools);
    if (this.store.data.preferences.localMcp?.enabled && !this.localMcp?.address()) {
      await this.applyLocalMcp().catch(() => undefined);
    }
    if (this.localMcp?.address() && (!tools || tools.length > 0)) {
      await this.mcpTokens().initialize().catch(() => undefined);
      const serverId = task.target && this.terminals.get(task.target.sessionId)?.profileId;
      const scopes: ("read" | "tickets" | "run")[] =
        task.mode === "advice" || !serverId ? ["read"] : ["read", "run"];
      const made = await this.mcpTokens()
        .create({
          userId: "local",
          name: `acp-${task.id.slice(0, 8)}`,
          createdBy: agent.name,
          scopes,
          serverId,
          expiresInDays: 1,
          ...(tools ? { tools } : {}),
        })
        .catch((error) => { throw new Error(`Could not connect this agent to the workspace: ${safeError(error)}`); });
      if (made) {
        acpTokenId = made.view.id;
        acpLocalMcp = {
          server: this.localMcp,
          token: made.token,
          scopes,
          ...(tools ? { tools } : {}),
        };
      }
    }
    // The change each of the agent's tool calls became, by the agent's id for the call: how it ended is written onto it.
    const changeOfCall = new Map<string, AgentChange>();
    let actions = 0;
    const runtime = new AcpRuntime(runner, {
      ...(acpLocalMcp ? { localMcp: acpLocalMcp } : {}),
      preface: [
        `You are working as "${agent.name}" (${agent.role}) for a team that uses sshS3.`,
        task.mode === "advice"
          ? "This conversation is advice only: do not change files, run commands or take any action; read and explain. Anything you ask permission for will be refused."
          : "",
        agent.systemPrompt?.trim() ? agent.systemPrompt.trim() : "",
        ticket
          ? "You were given one ticket from the team's board. Do that ticket and nothing beside it, and end with a report a person can review: what you did, what you verified and how, and what is left."
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      settled: (callId, outcome) => {
        const change = changeOfCall.get(callId);
        if (!change || change.status !== "approved") return;
        change.status = outcome.failed ? "failed" : "completed";
        change.output = outcome.output ? maskContext(outcome.output) : change.output;
        changeOfCall.delete(callId);
        this.changed();
      },
      ask: async (question) => {
        // A command the agent asks to run is a plain command, as any agent's is: it runs in every mode
        // that runs commands and nobody is asked. An action it gave no command for (an edit, a delete,
        // a move) is not one: it waits for a person as a file write does.
        const change: AgentChange = {
          id: crypto.randomUUID(),
          kind: "command",
          target: `${runner.name} in ${runner.cwd ?? "?"}`,
          description: clip(question.title, 300),
          // The command, or else everything the agent said it would do: a person is not asked about a title alone.
          command: question.command ? maskContext(question.command) : question.rawInput ? maskContext(question.rawInput) : undefined,
          ...(question.command && maskContext(question.command) !== question.command ? { hiddenValues: true } : {}),
          ...(question.command ? {} : { toolCall: true }),
          status: "pending",
          at: Date.now(),
        };
        const plain = isPlainCommand(change);
        if (question.toolCallId) changeOfCall.set(question.toolCallId, change);
        const safetyCtx = this.resolveSafetyContext(task, change.target);
        this.broker.rememberPolicy(task, change);
        const effectiveMode = safetyCtx.clusterPolicy?.maxMode
          ? lowerMode(task.mode, safetyCtx.clusterPolicy.maxMode)
          : task.mode;
        if (effectiveMode === "advice") {
          change.status = "denied";
          change.decidedHow = "policy";
          task.changes.push(change);
          this.changed();
          return false;
        }
        if (
          !plain &&
          safetyCtx.clusterPolicy?.frozenUntil &&
          safetyCtx.clusterPolicy.frozenUntil > Date.now()
        ) {
          change.status = "denied";
          change.decidedHow = "policy";
          change.output = `A change freeze holds here until ${new Date(safetyCtx.clusterPolicy.frozenUntil).toISOString()}. No change card or file write is run here until it ends.`;
          task.changes.push(change);
          this.changed();
          return false;
        }
        // Counted for the person to see. A run has no limit on them (`launch` sets maxCommands to 0).
        task.commandsUsed = ++actions;
        // How many people it needs. A plain command needs nobody.
        let requiredApprovals = plain ? 1 : Math.max(1, safetyCtx.clusterPolicy?.requiredApprovals ?? 1);
        const isProd = (safetyCtx.targetTags ?? []).some(isProdTag);
        if (!plain && safetyCtx.policy.requirePeerApprovalOnProd && isProd) {
          requiredApprovals = Math.max(requiredApprovals, 2);
        }
        if (requiredApprovals > 1) change.requiredApprovals = requiredApprovals;
        if (requiredApprovals === 2 && !safetyCtx.peerApproval && safetyCtx.canApproveAlone) {
          change.adminExceptionAvailable = true;
        } else if (requiredApprovals > 1 && !safetyCtx.peerApproval) {
          // Nobody else can be asked here: refused now, not after ten minutes of waiting.
          change.status = "denied";
          change.decidedHow = "policy";
          change.output = `This change needs the approval of ${requiredApprovals} different people, and only one person can approve in this app.`;
          task.changes.push(change);
          this.changed();
          return false;
        }
        const needsApproval =
          !plain &&
          (requiredApprovals > 1 ||
            // Without a command, a change to files or a deletion is always put to a person.
            ["edit", "delete", "execute", "move"].includes(question.kind ?? "execute") ||
            // Anything else it gave no command for: asked about, except in Auto off production.
            effectiveMode !== "autonomous" ||
            (isProd && safetyCtx.policy.requireApprovalOnProdTags));
        if (!needsApproval) {
          change.status = "approved";
          change.decidedHow = "policy";
          task.changes.push(change);
        } else if (!await this.broker.askApproval(task, change, safetyCtx.requesterId)) {
          return false;
        }
        try {
          await this.broker.beforeAction(task, change);
          this.changed();
          return true;
        } catch {
          return false;
        }
      },
    });
    task.model = runner.name;
    task.status = "running";
    task.error = undefined;
    assertLaunching();
    this.runtimes.set(task.id, runtime);
    this.changed();
    void runtime
      .start(task, undefined, (event) => this.event(task, event))
      .catch((error) => {
        if (active(task)) {
          task.status = "failed";
          task.error = safeError(error);
          task.verification = "incomplete";
        }
      })
      .finally(async () => {
        // A run that was let go of while it hung (see `releaseStuckRun`) ends here much later, perhaps
        // beside a new run of the same conversation: only its own token is left to let go of.
        if (this.runtimes.get(task.id) !== runtime) {
          if (acpTokenId) await this.mcpTokens().revoke("local", acpTokenId).catch(() => undefined);
          return;
        }
        this.broker.revoke(task.id);
        if (active(task)) {
          task.status = "interrupted";
          task.error = "The external agent ended without a final result.";
        }
        await runtime.stop();
        if (acpTokenId) await this.mcpTokens().revoke("local", acpTokenId).catch(() => undefined);
        if (this.runtimes.get(task.id) === runtime) this.runtimes.delete(task.id);
        if (task.ticketId) this.settleTickets();
        this.settled(task.id);
        this.changed();
        if (!task.quietScheduleResult) this.notify(task.status === "completed" ? "Task finished" : "Task needs attention", task.title);
      });
  }

  /**
   * The steps of a plan were bound to the terminal they were proposed for. When the hub opened that
   * terminal itself, it was closed at the end of the run and is opened again under a new id when the
   * conversation goes on (reviveOwnTerminal, a chat run naming the server again). The steps not run
   * yet follow it to the new terminal on the same server: the approval was for that server, and would
   * otherwise ask again for every step. A step bound to a terminal that is still open stays with it.
   */
  rebindPlanSteps(this: HubService, task: AgentTask, profileId: string, sessionId: string, formerKey?: string): void {
    const plan = task.plan;
    const session = this.terminals.get(sessionId);
    if (!plan || plan.status === "rejected" || !session) return;
    const key = JSON.stringify([session.id, session.generation]);
    const servers = this.getKnownServers();
    // The step's target names this server and no other one, as it names a server when the plan is proposed.
    const names = (target: string | undefined): boolean =>
      servers.some((s) => s.id === profileId) && stepTerminal(target, [session], servers, undefined) === session;
    for (const step of plan.steps) {
      if (step.ranAt || !step.approvedTarget || step.approvedTarget === key) continue;
      let boundTo: string | undefined;
      try {
        const parsed: unknown = JSON.parse(step.approvedTarget);
        if (Array.isArray(parsed) && typeof parsed[0] === "string") boundTo = parsed[0];
      } catch {
        continue;
      }
      const was = boundTo ? this.terminals.get(boundTo) : undefined;
      if (was && was.state !== "disconnected") continue;
      const sameServer = was ? was.profileId === profileId : step.approvedTarget === formerKey || names(step.target);
      if (sameServer) step.approvedTarget = key;
    }
  }

  /**
   * A conversation whose terminal the hub opened itself goes on: the terminal
   * was closed when its last run ended, and is opened again on the same
   * target. Left as it is when it cannot be opened; the caller then treats
   * the conversation as one without a terminal.
   */
  async reviveOwnTerminal(this: HubService, task: AgentTask): Promise<void> {
    const own = task.ownTerminal;
    // In the demo lab only a terminal on one of its own simulated servers is opened again.
    if (!own || (isDemoMode() && !isDemoTarget(own.profileId))) return;
    const session = task.target && this.terminals.get(task.target.sessionId);
    if (session && session.state !== "disconnected") return;
    try {
      const id =
        own.via === "server"
          ? await this.host.openServerTerminal!(own.profileId)
          : await this.openUnattendedTerminal({ profileId: own.profileId, shell: own.shell }, own.label);
      const opened = this.terminals.get(id);
      if (!opened) return;
      const before = task.target ? JSON.stringify([task.target.sessionId, task.target.generation]) : undefined;
      task.target = { sessionId: opened.id, generation: opened.generation, label: opened.label };
      this.rebindPlanSteps(task, own.profileId, opened.id, before);
      // Closed again when the run that is about to start ends (also when it fails to start).
      const set = this.runTerminals.get(task.id) ?? new Set<string>();
      set.add(id);
      this.runTerminals.set(task.id, set);
    } catch (error) {
      log.info("The run's own terminal could not be opened again", safeError(error));
    }
  }
}
