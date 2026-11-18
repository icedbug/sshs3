import crypto from "node:crypto";
import type {
  HubReply,
  AgentTask,
  MemoryDistillStatus,
  MemoryEntry,
  MemoryProposal,
  WorkspaceActivityEvent,
} from "../../../../shared/types/aiHub";
import { MAX_MEMORY_TEXT } from "../KnowledgeBaseService";
import {
  getBuiltinSkillsAndMemories,
  getDemoInfraEdges,
  getDemoMemories,
  getDemoTasks,
  isDemoMode,
  saveDemoMemory,
} from "../demoWorkspace";
import { isDemoTarget } from "../../../demo/demoMode";
import { boundedContext, clip, safeError } from "../privacy";
import { LearningQueue } from "../LearningQueue";
import { removedMessage } from "../WorkBoard";
import { firstActivityCursor, nextActivityBatch } from "../ActivityBatcher";
import {
  MAX_STORED_PROPOSALS,
  activityTranscript,
  buildDistillPrompt,
  parseDistillAnswer,
  mayLearnUnreviewed,
  replacesPersonMemory,
  taskTranscript,
  worthDistilling,
  type DistillSource,
  type GovernedMemoryProposal,
} from "../MemoryDistiller";
import { requiredText } from "../hubHelpers";
import { log, isBackgroundRun } from "../hubShared";
import type { HubService } from "../HubService";
import type { Handled, RequestsOf } from "./routes";

/**
 * Team memory and what the hub learns.
 *
 * Saving, correcting and forgetting memories; the proposals the hub makes from finished runs and from
 * the team's activity, with the queue they are read from; and tidying up.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
export class MemoryPart {
  /** What to tell somebody who saves a team memory that was removed (and not saved again since), or undefined. */
  memoryRemovedMessage(this: HubService, id: string): string | undefined {
    const at = this.store.data.deletedMemoryIds?.[id];
    if (!at || this.store.data.memories.some((m) => m.id === id && (m.updatedAt ?? 0) > at)) return undefined;
    return removedMessage("This memory", this.store.data.deletedMemoryBy?.[id], at, "so the change was not saved. Save it as a new memory to keep the text.");
  }

  /** What a person did to the team's memory: in the audit log, and in the team's activity when asked. */
  async memoryDone(this: HubService, what: string, title: string, activity: boolean): Promise<void> {
    const actor = await this.resolveActorName();
    if (activity) {
      const event: WorkspaceActivityEvent = { id: crypto.randomUUID(), at: Date.now(), actor, targetLabel: clip(title, 120), kind: "note", summary: what };
      this.appendActivityEvent(event);
      await this.host.recordWorkspaceActivity?.(event).catch(() => {});
    }
    if (isDemoMode()) return;
    await this.audit()
      .append({ kind: "setting", actor, target: "team memory", what, outcome: "completed" })
      .catch((e) => log.warn("Could not write the audit log", safeError(e)));
  }

  /** Saves a proposal as a team memory, or applies its update to the memory it names. */
  async applyMemoryProposal(this: HubService,
    proposal: MemoryProposal,
    edited: { title?: string; text?: string } = {},
  ): Promise<MemoryEntry> {
    const title = edited.title?.trim() || proposal.title;
    const text = edited.text?.trim() || proposal.text;
    // What the distiller worked out about it travels with it: dropped here, a skill lost its command.
    const p = proposal as MemoryProposal & Partial<GovernedMemoryProposal>;
    const extra = {
      ...(p.commandTemplate ? { commandTemplate: p.commandTemplate } : {}),
      ...(p.verifyCommand ? { verifyCommand: p.verifyCommand } : {}),
      ...(p.preconditions?.length ? { preconditions: p.preconditions } : {}),
      ...(p.sourceTrust ? { sourceTrust: p.sourceTrust } : {}),
      ...(p.proven !== undefined ? { proven: p.proven } : {}),
    };
    if (proposal.op === "update") {
      const target = this.store.data.memories.find(
        (m) => m.id === proposal.targetId,
      );
      if (!target)
        throw new Error(
          "The memory this proposal updates no longer exists; reject the proposal or save it as a new memory",
        );
      if (p.invalidate || p.intendedOp === "invalidate") {
        // Said to be wrong or obsolete: it is marked so, with why, and keeps what it said.
        return this.saveMemoryInternal({
          id: target.id,
          kind: target.kind,
          tier: target.tier,
          cluster: target.cluster,
          scope: target.scope,
          title: target.title,
          text: target.text,
          extra: { staleReason: clip(p.staleReason || edited.text?.trim() || "Contradicted by a later record", 240) },
        });
      }
      return this.saveMemoryInternal({
        id: target.id,
        kind: target.kind,
        tier: p.tier ?? target.tier,
        cluster: p.cluster ?? target.cluster,
        scope: target.scope,
        title,
        text,
        confidence: p.confidence,
        errorSignature: p.errorSignature,
        sourceCommand: p.sourceCommand,
        supersede: true,
        extra,
      });
    }
    return this.saveMemoryInternal({
      kind: proposal.kind,
      tier: p.tier ?? "archival",
      cluster: p.cluster,
      scope: proposal.scope,
      title,
      text,
      confidence: p.confidence,
      errorSignature: p.errorSignature,
      sourceCommand: p.sourceCommand,
      autoLearned: true,
      extra,
    });
  }

  /** The team's queue of records waiting to be read for memory, when a bucket is in use. */
  queue(this: HubService): LearningQueue | undefined {
    if (!this.s3Workspace.canUseBucket()) return undefined;
    this.learningQueue ??= new LearningQueue(this.s3Workspace.objects);
    return this.learningQueue;
  }

  /**
   * Hands a record over to be read for team memory. With a team bucket it is
   * uploaded to the shared queue at once and read later by whichever
   * teammate's app is running (this one included), so closing this computer
   * right after the work does not lose it. Without a bucket, or when the
   * upload fails, this app reads it itself now.
   */
  async queueForLearning(this: HubService,
    source: DistillSource,
    query: string,
  ): Promise<void> {
    if (this.store.data.preferences.proposeMemories === false) return;
    if (isDemoMode()) return;
    const queued = this.store.data.queuedSourceIds ?? [];
    const seen = this.store.data.distilledSourceIds ?? [];
    if (queued.includes(source.id) || seen.includes(source.id)) return;
    const queue = this.queue();
    if (queue) {
      try {
        await queue.enqueue({
          v: 1,
          id: source.id,
          title: source.title,
          transcript: source.transcript,
          query: boundedContext(query, 600),
          actor: await this.resolveActorName(),
          createdAt: Date.now(),
          attempts: 0,
        });
        this.store.data.queuedSourceIds = [...queued, source.id].slice(-300);
        this.changed();
        return;
      } catch (error) {
        log.warn("Could not queue a record for learning", safeError(error));
      }
    }
    await this.proposeMemoriesFrom(source, query);
  }

  /**
   * Reads one record from the team's queue with this app's model. Called
   * from the periodic tick, at most every twenty seconds and one record at a
   * time. A record whose reading fails goes back for another app to try.
   */
  async readLearningQueue(this: HubService, now = Date.now()): Promise<void> {
    if (this.readingQueue || now - this.lastQueueCheck < 20_000) return;
    if (this.store.data.preferences.proposeMemories === false) return;
    const queue = this.queue();
    if (!queue) return;
    this.lastQueueCheck = now;
    this.readingQueue = true;
    try {
      const claimed = await queue.claimNext(await this.resolveActorName(), now);
      if (!claimed) return;
      const { record } = claimed;
      const status = await this.proposeMemoriesFrom(
        {
          id: record.id,
          title: clip(`${record.title} (${record.actor})`, 200),
          transcript: boundedContext(record.transcript, 24_000),
        },
        record.query,
        { again: true },
      );
      // No status: another run of this app is reading the same record right now.
      if (status && !status.error) await queue.complete(claimed.name);
      else await queue.release(claimed);
    } finally {
      this.readingQueue = false;
    }
  }

  /**
   * Hands the team's activity over for learning: everyone's changes since the
   * shared cursor, as one record in the queue (ActivityBatcher). Any running
   * app does this, so a colleague's changes are handed over although their
   * computer is closed. Checked at most every five minutes.
   */
  async queueTeamActivity(this: HubService, now = Date.now()): Promise<void> {
    if (now - this.lastActivityCheck < 5 * 60_000) return;
    if (this.store.data.preferences.proposeMemories === false) return;
    const queue = this.queue();
    if (!queue) return;
    this.lastActivityCheck = now;
    const cursorPath = "learn/activity-cursor.json";
    const objects = this.s3Workspace.objects;
    let cursor = firstActivityCursor(now);
    try {
      const raw = await objects.read(cursorPath);
      const stored = raw
        ? (JSON.parse(raw.toString("utf8")) as { through?: unknown }).through
        : undefined;
      if (typeof stored === "number" && Number.isFinite(stored)) cursor = stored;
    } catch {
      // An unreadable cursor is treated as none: the first one is written below.
    }
    const batch = nextActivityBatch(this.store.data.activityLog ?? [], cursor, now);
    if (!batch) return;
    if (batch.events.length > 0) {
      const clock = (at: number): string =>
        new Date(at).toISOString().slice(0, 16).replace("T", " ");
      await queue.enqueue({
        v: 1,
        id: batch.id,
        title: `Team activity ${clock(batch.from)} – ${clock(batch.through)} UTC`,
        transcript: activityTranscript(batch.events),
        query: boundedContext(
          batch.events
            .slice(-20)
            .map((e) => `${e.targetLabel} ${e.summary}`)
            .join(" "),
          600,
        ),
        actor: "team",
        // The same for every app that cuts this batch, so the record's name is too.
        createdAt: batch.through,
        attempts: 0,
      });
    }
    // Never move the cursor back: another app may have handed over further meanwhile.
    try {
      const raw = await objects.read(cursorPath);
      const latest = raw
        ? (JSON.parse(raw.toString("utf8")) as { through?: unknown }).through
        : undefined;
      if (typeof latest === "number" && latest >= batch.through) return;
    } catch {
      // Unreadable: write ours.
    }
    await objects.write(
      cursorPath,
      Buffer.from(JSON.stringify({ through: batch.through }), "utf8"),
    );
  }

  /**
   * Finished sessions that were never handed over for learning, because the
   * app was closed before it got to them, are handed over now. Once per start.
   */
  async recoverUnreadSessions(this: HubService, now = Date.now()): Promise<void> {
    if (this.recoveredSessions) return;
    this.recoveredSessions = true;
    const recent = this.store.data.tasks
      .filter(
        (t) =>
          !isBackgroundRun(t) &&
          worthDistilling(t) &&
          now - t.updatedAt < 7 * 86_400_000,
      )
      .slice(-10);
    for (const task of recent)
      await this.queueForLearning(
        {
          id: `task:${task.id}`,
          title: `Session: ${task.title}`,
          transcript: taskTranscript(task),
        },
        `${task.title} ${task.target?.label ?? ""}`,
      );
  }

  /**
   * Reads this user's own recent activity for memories, at most every six
   * hours and only when enough has happened. Each teammate's app reads its own
   * user's activity, so a change is read once, not once per teammate.
   */
  async maybeLearnFromOwnActivity(this: HubService, now = Date.now()): Promise<void> {
    if (this.store.data.preferences.proposeMemories === false) return;
    // With a team bucket the whole team's activity is handed over together (queueTeamActivity).
    if (this.queue()) return;
    const last = this.store.data.lastActivityDistillAt ?? 0;
    if (now - last < 6 * 3_600_000) return;
    const actor = (await this.resolveActorName()).trim().toLowerCase();
    const own = (this.store.data.activityLog ?? []).filter(
      (e) => e.at > last && e.actor.trim().toLowerCase() === actor,
    );
    if (own.length < 8) return;
    this.store.data.lastActivityDistillAt = now;
    const events = own.slice(-80);
    await this.queueForLearning(
      {
        id: `activity:${events.at(-1)!.id}`,
        title: "My recent activity",
        transcript: activityTranscript(events),
      },
      events
        .slice(-20)
        .map((e) => `${e.targetLabel} ${e.summary}`)
        .join(" "),
    );
  }

  /**
   * Has the model read one record and stores what it proposes to remember
   * (MemoryDistiller). A record is read once unless `again` is set. Proposals
   * stay local and unused until a person accepts them. The outcome, including
   * a failed or unusable model answer, is kept as `lastMemoryDistill`.
   */
  async proposeMemoriesFrom(this: HubService,
    source: DistillSource,
    query: string,
    opts: { again?: boolean } = {},
  ): Promise<MemoryDistillStatus | undefined> {
    const seen = this.store.data.distilledSourceIds ?? [];
    if (this.distilling.has(source.id)) return undefined;
    if (!opts.again && seen.includes(source.id)) return undefined;
    if (isDemoMode()) return undefined; // the demo copilot is scripted, it reads nothing
    this.distilling.add(source.id);
    this.changed();
    const finish = (
      proposed: number,
      error?: string,
      pagesError?: string,
    ): MemoryDistillStatus => {
      const status: MemoryDistillStatus = {
        at: Date.now(),
        sourceTitle: clip(source.title, 160),
        proposed,
        ...(error ? { error } : {}),
        ...(pagesError ? { pagesError } : {}),
      };
      this.store.data.lastMemoryDistill = status;
      this.store.data.distilledSourceIds = [
        ...(this.store.data.distilledSourceIds ?? []).filter(
          (id) => id !== source.id,
        ),
        source.id,
      ].slice(-300);
      return status;
    };
    try {
      // Only team memory is compared and proposed: a personal note stays private.
      const shared = this.store.data.memories.filter(
        (m) => m.scope !== "personal",
      );
      const existing = this.kb.rankMemories(shared, query, undefined, 10);
      const task = await this.runBackground(
        {
          prompt: buildDistillPrompt(source, existing),
          mode: "advice",
          agentName: "Memory",
          maxCommands: 1,
          maxMinutes: 5,
        },
        {
          distillSourceId: source.id,
          title: `Memory · ${clip(source.title, 80)}`,
        },
      );
      const answer =
        task.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
      if (task.status !== "completed")
        return finish(0, task.error ?? `The run ended as ${task.status}.`);
      const proposals = parseDistillAnswer(answer, source, existing);
      if (!proposals)
        return finish(0, "The model did not answer in the requested format.");
      const pending = this.store.data.memoryProposals ?? [];
      const fresh = proposals.filter(
        (p) =>
          !pending.some(
            (q) =>
              q.text === p.text ||
              (p.op === "update" &&
                q.op === "update" &&
                !q.appliedMemoryId &&
                q.targetId === p.targetId),
          ),
      );
      // The default: what the assistant learned is saved and shared at once,
      // so the team's memory grows without anyone tending it. Each entry stays
      // in the list as a record that can be undone.
      // Not everything: what would take the place of a memory a person wrote, and what comes from a
      // conversation in which nothing was run and shown (the assistant's own answer), waits in the
      // list for a person to accept.
      // Nor what the memory rules put to a person: an invalidation, a "core" rule, a skill that
      // carries a command, a note the model itself was unsure of.
      if (this.store.data.preferences.autoSaveMemories !== false && mayLearnUnreviewed(source))
        for (const proposal of fresh) {
          if (proposal.requiresApproval || proposal.invalidate) continue;
          if (replacesPersonMemory(proposal, this.store.data.memories)) continue;
          const saved = await this.applyMemoryProposal(proposal).catch(
            (e) => {
              log.warn("Could not save a learned memory", safeError(e));
              return undefined;
            },
          );
          if (saved) proposal.appliedMemoryId = saved.id;
        }
      this.store.data.memoryProposals = [...pending, ...fresh].slice(
        -MAX_STORED_PROPOSALS,
      );
      // The same record may also belong on a page: what was confirmed about a
      // symptom or a procedure. `learnPagesFrom` decides whether the record
      // confirmed anything; a chat about nothing teaches no page.
      // A page that could not be written is said where the outcome of this reading is shown, not only
      // logged. It is not the reading's own failure: the record is not read again because of it.
      const pagesError = await this.learnPagesFrom(source).then(
        () => undefined,
        (e) => {
          log.warn("Could not add what was learned to the pages", safeError(e));
          return clip(safeError(e), 200);
        },
      );
      return finish(fresh.length, undefined, pagesError);
    } catch (error) {
      return finish(0, safeError(error));
    } finally {
      this.distilling.delete(source.id);
      this.changed();
    }
  }

  /**
   * Always-On Automatic Workspace Memory:
   * Whenever any user or AI modifies a node/cluster or runs notable commands on a target,
   * automatically keep a shared workspace memory entry up to date for that target.
   */
  async syncAutoMemoryForTarget(this: HubService,
    profileId?: string,
    targetLabel?: string,
  ): Promise<void> {
    try {
      const key = (profileId || targetLabel || "").trim();
      if (!key) return;
      const extra = await this.collectExtraContext();
      const server = (extra.workspaceServers ?? []).find(
        (s) => s.id === profileId || s.name === targetLabel || s.id === key,
      );
      const displayName = server?.name || targetLabel || key;
      const recentEvents = (extra.activityLog ?? [])
        .filter(
          (a) =>
            (profileId && a.profileId === profileId) ||
            a.targetLabel === displayName ||
            a.targetLabel === targetLabel,
        )
        .slice(0, 6);

      const lines: string[] = [];
      if (server) {
        lines.push(
          `Server: ${server.name} (${server.username}@${server.host}:${server.port})`,
        );
        if (server.cluster) lines.push(`Cluster: ${server.cluster}`);
        if (server.nodeRole) lines.push(`Node role: ${server.nodeRole}`);
        if (server.role) lines.push(`Role: ${server.role}`);
        if (server.tags?.length)
          lines.push(`Tags: ${server.tags.join(", ")}`);
        if (server.description)
          lines.push(`Description: ${server.description}`);
      } else {
        lines.push(`Target: ${displayName}`);
      }
      if (recentEvents.length > 0) {
        lines.push("Latest recorded changes:");
        for (const evt of recentEvents) {
          lines.push(
            `- [${new Date(evt.at).toISOString()}] ${evt.actor} (${evt.kind}): ${evt.summary}${evt.detail ? ` — ${evt.detail}` : ""}`,
          );
        }
      }
      await this.saveMemoryInternal({
        id: `auto-node:${server?.id || key}`,
        kind: "memory",
        // The card of a server a person keeps to themselves stays with them too.
        scope: server?.shared === false ? "personal" : "workspace",
        title: `Server card: ${displayName}${server?.cluster ? ` (${server.cluster})` : ""}`,
        text: lines.join("\n"),
        author: "Auto-Memory",
      });
    } catch {
      // Never block main flow on auto-memory
    }
  }

  /**
   * What an agent writes into memory during a run. It is saved at once only
   * when the workspace saves memories without review (the default) and it
   * does not overwrite something a person wrote; otherwise it becomes a
   * suggestion a person accepts or not, as the review switch promises. Its
   * author is the agent, so a person's note is never mistaken for one.
   */
  async rememberFromRun(this: HubService,
    task: AgentTask,
    input: { id?: string; kind: "memory" | "skill"; tier?: MemoryEntry["tier"]; cluster?: string; scope: string; title: string; text: string; sourceCommand?: string },
  ): Promise<{ entry?: MemoryEntry; proposal?: MemoryProposal }> {
    const memories = this.store.data.memories;
    const existing = input.id ? memories.find((m) => m.id === input.id) : undefined;
    const author = `${task.agentName ?? "Assistant"} (agent)`;
    const scope = /^(workspace|personal|(server|cluster|target):.+)$/.test(input.scope) ? input.scope : "workspace";
    const writtenByPerson = Boolean(existing && !existing.autoLearned && !/\(agent\)$|assistant|learner|learning|distill/i.test(existing.author ?? ""));
    if (this.store.data.preferences.autoSaveMemories === false || writtenByPerson) {
      const proposal: MemoryProposal = {
        id: crypto.randomUUID(),
        op: existing ? "update" : "add",
        ...(existing ? { targetId: existing.id, previousText: existing.text } : {}),
        kind: input.kind,
        scope,
        title: clip(input.title, 200),
        text: boundedContext(input.text, MAX_MEMORY_TEXT),
        evidence: writtenByPerson ? `Would change a memory ${existing!.author} wrote.` : "Written by an agent during a run.",
        sourceId: task.id,
        sourceTitle: clip(task.title, 160),
        createdAt: Date.now(),
      };
      this.store.data.memoryProposals = [...(this.store.data.memoryProposals ?? []), proposal].slice(-MAX_STORED_PROPOSALS);
      this.changed();
      return { proposal };
    }
    // An agent does not pin for the whole team: pinned (core) is a person's choice.
    // Saying something else about the same memory replaces it, and keeps what it said as history; adding to it does not.
    const supersede = Boolean(existing && !input.text.trim().startsWith(existing.text.trim()));
    const entry = await this.saveMemoryInternal({ ...input, scope, author, tier: input.tier === "core" ? "archival" : input.tier, supersede });
    return { entry };
  }

  async saveMemoryInternal(this: HubService, input: {
    id?: string;
    kind: "memory" | "skill";
    tier?: "core" | "archival" | "episodic";
    cluster?: string;
    scope: string;
    title: string;
    text: string;
    author?: string;
    confidence?: number;
    autoLearned?: boolean;
    sourceCommand?: string;
    errorSignature?: string;
    /** A newer memory replaces the one it matches; the old one is kept as history. */
    supersede?: boolean;
    /** What a learned skill carries besides its text, and a memory marked as no longer right. */
    extra?: Partial<Pick<MemoryEntry, "commandTemplate" | "verifyCommand" | "preconditions" | "staleReason" | "sourceTrust" | "proven">>;
  }): Promise<MemoryEntry> {
    const author = input.author?.trim() || (await this.resolveActorName());
    const before = new Map(this.store.data.memories.map((m) => [m.id, m.updatedAt]));
    const { memories, saved: merged, superseded } = this.kb.deduplicateOrMergeMemory(
      this.store.data.memories,
      {
        id: input.id,
        kind: input.kind,
        tier: input.tier,
        cluster: input.cluster?.trim() || undefined,
        scope: input.scope,
        title: clip(input.title, 200),
        text: boundedContext(input.text),
        author: clip(author, 80),
        confidence: input.confidence,
        autoLearned: input.autoLearned,
        sourceCommand: input.sourceCommand
          ? boundedContext(input.sourceCommand, 500)
          : undefined,
        errorSignature: input.errorSignature
          ? boundedContext(input.errorSignature, 160)
          : undefined,
        ...input.extra,
        supersede: input.supersede,
      },
    );
    // The version this edit started from: a teammate's removal made after it wins over the edit.
    const base = before.get(merged.id);
    const saved: MemoryEntry = base !== undefined && base !== merged.updatedAt ? { ...merged, baseAt: base } : merged;
    this.store.data.memories = memories.map((m) => (m.id === saved.id ? saved : m));
    if (superseded && superseded.scope !== "personal")
      await this.host.saveWorkspaceMemory?.(superseded).catch(() => {});
    if (this.store.data.deletedMemoryIds?.[saved.id]) {
      delete this.store.data.deletedMemoryIds[saved.id];
    }
    if (saved.scope !== "personal") {
      await this.host.saveWorkspaceMemory?.(saved).catch(() => {});
      this.s3Workspace.schedulePush();
    }
    this.changed();
    return saved;
  }
  /** The requests this part answers. What a case leaves in `reply` goes back with the snapshot. */
  async handleMemory(this: HubService, request: RequestsOf<"memory">): Promise<Handled> {
    let reply: HubReply | undefined;
    switch (request.action) {
      case "memory-save": {
        const entry = request.entry;
        if (!["memory", "skill"].includes(entry.kind))
          throw new Error("Invalid memory type");
        const memoryWasThere = Boolean(entry.id && this.store.data.memories.some((m) => m.id === entry.id));
        const scope = requiredText(entry.scope);
        if (
          scope !== "personal" &&
          scope !== "workspace" &&
          !scope.startsWith("target:") &&
          !scope.startsWith("workspace:") &&
          !scope.startsWith("server:") &&
          !scope.startsWith("cluster:")
        )
          throw new Error("Invalid memory scope");
        if (entry.id && scope !== "personal") {
          // The team's memories as they are now: a memory a teammate removed is not saved back from an old view.
          await this.pullTeamWorkspace();
          const removed = this.memoryRemovedMessage(entry.id);
          if (removed) throw new Error(removed);
        }
        const savedMemory = await this.saveMemoryInternal({
          id: entry.id,
          kind: entry.kind,
          tier: entry.tier,
          cluster: entry.cluster,
          scope,
          title: requiredText(entry.title),
          text: requiredText(entry.text),
          // On a server with accounts the memory is the signed-in person's: nobody writes one in a teammate's name.
          author: this.hosted() ? await this.resolveActorName() : entry.author,
          sourceCommand: entry.sourceCommand,
          confidence: entry.confidence,
        });
        if (savedMemory.scope !== "personal") await this.memoryDone(`${memoryWasThere ? "Changed" : "Saved"} the team ${savedMemory.kind === "skill" ? "skill" : "memory"} "${clip(savedMemory.title, 120)}"`, savedMemory.title, !savedMemory.editedBy);
        // A teammate's memory changed by somebody else keeps its author, and the change is in the team's activity.
        if (savedMemory.editedBy && savedMemory.scope !== "personal") {
          const event: WorkspaceActivityEvent = {
            id: crypto.randomUUID(),
            at: Date.now(),
            actor: savedMemory.editedBy,
            targetLabel: savedMemory.title,
            kind: "note",
            summary: `Changed ${savedMemory.author}'s memory "${clip(savedMemory.title, 120)}"`,
          };
          this.appendActivityEvent(event);
          await this.host.recordWorkspaceActivity?.(event).catch(() => {});
        }
        break;
      }
      case "memory-delete": {
        // A server card is written again from the server list every time the memories are read:
        // answering "deleted" would not be true. The card of a server that is gone is not written again.
        if (request.id.startsWith("auto-node:") || request.id.startsWith("auto-cluster:")) {
          const servers = (await this.collectExtraContext().catch(() => undefined))?.workspaceServers ?? [];
          const [kind, rest] = [request.id.slice(0, request.id.indexOf(":")), request.id.slice(request.id.indexOf(":") + 1)];
          const stillThere = kind === "auto-node" ? servers.some((s) => s.id === rest) : servers.some((s) => s.cluster && rest.includes(s.cluster));
          if (stillThere || !this.store.data.memories.some((m) => m.id === request.id))
            throw new Error("This card is written by sshs3 from the server list, so it cannot be forgotten: it would be written again. Remove the server, or correct what it says with a memory of your own.");
        }
        // On a shared server a team memory is forgotten by the person who wrote it or by an administrator.
        const target = this.store.data.memories.find((m) => m.id === request.id);
        if (target && target.scope !== "personal" && target.author && !target.id.startsWith("auto-") && this.sharedServer() && !this.host.teamAdmin?.() && target.author !== (await this.resolveActorName()))
          throw new Error(`Only ${target.author}, who wrote it, or an administrator of this server forgets a memory the team shares. Correct it instead: the change is saved with your name.`);
        // Forgetting a memory forgets the history it replaced too.
        const gone = new Set([request.id]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const m of this.store.data.memories)
            if (m.supersededBy && gone.has(m.supersededBy) && !gone.has(m.id)) {
              gone.add(m.id);
              grew = true;
            }
        }
        this.store.data.memories = this.store.data.memories.filter(
          (m) => !gone.has(m.id),
        );
        this.markBuiltinDismissed(request.id, getBuiltinSkillsAndMemories());
        this.store.data.deletedMemoryIds ??= {};
        this.store.data.deletedMemoryBy ??= {};
        const remover = await this.resolveActorName();
        for (const id of gone) {
          this.store.data.deletedMemoryIds[id] = Date.now();
          this.store.data.deletedMemoryBy[id] = remover;
          await this.host.deleteWorkspaceMemory?.(id).catch(() => {});
        }
        this.s3Workspace.schedulePush(400);
        if (target && target.scope !== "personal") await this.memoryDone(`Forgot the team ${target.kind === "skill" ? "skill" : "memory"} "${clip(target.title, 120)}"`, target.title, true);
        break;
      }
      case "memory-feedback": {
        const storedIds = new Set(this.store.data.memories.map((m) => m.id));
        const builtinOrDemoIds = new Set([
          ...getBuiltinSkillsAndMemories().map((m) => m.id),
          ...(isDemoMode() ? getDemoMemories().map((m) => m.id) : []),
        ]);
        const extra = await this.collectExtraContext();
        const combined = [...this.store.data.memories];
        for (const m of extra.memories ?? []) {
          if (!combined.some((x) => x.id === m.id)) combined.push(m);
        }
        const { memories, updated } = this.selfLearning.applyMemoryFeedback(
          combined,
          request.id,
          request.delta,
          // One vote per signed-in person on a server with accounts: a made-up voter is not a person.
          (!this.hosted() && request.voter?.trim()) || (await this.resolveActorName()),
        );
        if (
          updated &&
          isDemoMode() &&
          (builtinOrDemoIds.has(updated.id) || isDemoTarget(updated.id))
        ) {
          saveDemoMemory(updated);
        }
        if (!updated) throw new Error("Memory not found");
        this.store.data.memories = memories.filter((m) => {
          if (storedIds.has(m.id)) return true;
          if (
            m.id === request.id &&
            !m.id.startsWith("auto-node:") &&
            !m.id.startsWith("auto-cluster:") &&
            !m.id.startsWith("builtin-") &&
            !m.id.startsWith("demo-") &&
            !builtinOrDemoIds.has(m.id) &&
            !isDemoTarget(m.id)
          ) {
            return true;
          }
          return false;
        });
        if (
          updated &&
          updated.scope !== "personal" &&
          !updated.id.startsWith("auto-node:") &&
          !updated.id.startsWith("auto-cluster:") &&
          !builtinOrDemoIds.has(updated.id) &&
          !isDemoTarget(updated.id)
        ) {
          await this.host.saveWorkspaceMemory?.(updated).catch(() => {});
          this.s3Workspace.schedulePush(400);
        }
        break;
      }
      case "self-learn-reflect": {
        const storedMemoryIds = new Set(
          this.store.data.memories.map((m) => m.id),
        );
        const builtinOrDemoMemoryIds = new Set([
          ...getBuiltinSkillsAndMemories().map((m) => m.id),
          ...(isDemoMode() ? getDemoMemories().map((m) => m.id) : []),
        ]);
        const storedEdgeIds = new Set(
          (this.store.data.infraEdges ?? []).map((e) => e.id),
        );
        const demoEdgeIds = new Set(
          isDemoMode() ? getDemoInfraEdges().map((e) => e.id) : [],
        );
        const extra = await this.collectExtraContext();
        const dismissedReflect = new Set(
          this.store.data.preferences.dismissedBuiltinIds ?? [],
        );
        const allTasks = isDemoMode()
          ? [
              ...getDemoTasks().filter(
                (dt) =>
                  !dismissedReflect.has(dt.id) &&
                  !this.store.data.tasks.some((t) => t.id === dt.id),
              ),
              ...this.store.data.tasks,
            ]
          : this.store.data.tasks;
        const combinedMemories = [...this.store.data.memories];
        for (const m of extra.memories ?? []) {
          if (
            !m.id.startsWith("auto-node:") &&
            !m.id.startsWith("auto-cluster:") &&
            !combinedMemories.some((x) => x.id === m.id)
          ) {
            combinedMemories.push(m);
          }
        }
        // How the memory read before: what was done is told afterwards, not left for the person to find.
        const asText = (m: MemoryEntry): string => [m.title, m.text, m.tier ?? "", m.supersededBy ?? ""].join("\u0000");
        const wasMemories = new Map(this.store.data.memories.map((m) => [m.id, asText(m)]));
        const waitingNow = (): number => (this.store.data.memoryProposals ?? []).filter((p) => !p.appliedMemoryId).length;
        const wasWaiting = waitingNow();
        const reflected = this.selfLearning.runReflectionCycle({
          memories: combinedMemories,
          tasks: allTasks,
          activityLog: extra.activityLog ?? this.store.data.activityLog ?? [],
          infraEdges: this.getInfraEdgesList(),
          servers: extra.workspaceServers ?? [],
          lastFailures: this.terminals.failures(),
          targetCluster: request.targetCluster,
        });
        this.store.data.memories = reflected.memories.filter(
          (m) =>
            storedMemoryIds.has(m.id) ||
            (!m.id.startsWith("auto-node:") &&
              !m.id.startsWith("auto-cluster:") &&
              !m.id.startsWith("builtin-") &&
              !m.id.startsWith("demo-") &&
              !builtinOrDemoMemoryIds.has(m.id) &&
              !isDemoTarget(m.id)),
        );
        this.store.data.infraEdges = reflected.infraEdges.filter(
          (e) =>
            storedEdgeIds.has(e.id) ||
            (!demoEdgeIds.has(e.id) && !isDemoTarget(e.id)),
        );
        // What it did, said plainly: what it wrote straight away, and what waits for a person.
        const wrote = this.store.data.memories.filter((m) => !wasMemories.has(m.id));
        const changedNow = this.store.data.memories.filter((m) => wasMemories.has(m.id) && wasMemories.get(m.id) !== asText(m));
        const links = this.store.data.infraEdges.filter((e) => !storedEdgeIds.has(e.id)).length;
        const waits = Math.max(0, waitingNow() - wasWaiting);
        const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
        const names = (list: MemoryEntry[]): string => {
          const shown = list.slice(0, 3).map((m) => `"${clip(m.title, 60)}"`).join(", ");
          return list.length > 3 ? `${shown} and ${list.length - 3} more` : shown;
        };
        const did = [
          ...(wrote.length ? [`Wrote ${count(wrote.length, "new entry", "new entries")}: ${names(wrote)}.`] : []),
          ...(changedNow.length ? [`Changed ${count(changedNow.length, "entry", "entries")}: ${names(changedNow)}.`] : []),
          ...(links ? [`Added ${count(links, "link", "links")} between servers.`] : []),
        ];
        reply = {
          notes: [
            ...(did.length ? ["Tidy up did this without asking:", ...did] : []),
            ...(waits ? [`${count(waits, "suggestion waits", "suggestions wait")} above for you to accept or reject.`] : []),
            ...(!did.length && !waits ? ["Tidy up found nothing to change."] : []),
          ],
        };
        this.s3Workspace.schedulePush(400);
        break;
      }
      case "activity-record": {
        // On a shared server the entry is the signed-in person's: nobody writes the team's log as another.
        const actor = (!this.hosted() && request.event.actor?.trim()) || (await this.resolveActorName());
        const event: WorkspaceActivityEvent = {
          id: crypto.randomUUID(),
          at: Date.now(),
          actor: clip(actor, 80),
          profileId: request.event.profileId,
          targetLabel: clip(
            requiredText(request.event.targetLabel),
            200,
          ),
          // One of the kinds the log knows; anything else is a note.
          kind: (["config-edit", "service-action", "service", "package-change", "deploy", "command", "ai-action", "profile-update", "note"] as const).includes(
            request.event.kind as never,
          )
            ? request.event.kind
            : "note",
          summary: clip(requiredText(request.event.summary), 400),
          detail: request.event.detail
            ? boundedContext(request.event.detail, 2000)
            : undefined,
        };
        this.appendActivityEvent(event);
        await this.host.recordWorkspaceActivity?.(event).catch(() => {});
        this.s3Workspace.schedulePush(400);
        break;
      }
      case "memory-proposal-accept": {
        const proposal = (this.store.data.memoryProposals ?? []).find(
          (p) => p.id === request.id,
        );
        if (!proposal) throw new Error("Proposal not found");
        if (!proposal.appliedMemoryId)
          await this.applyMemoryProposal(proposal, {
            title: request.title,
            text: request.text,
          });
        this.store.data.memoryProposals = (
          this.store.data.memoryProposals ?? []
        ).filter((p) => p.id !== proposal.id);
        break;
      }
      case "memory-proposal-undo": {
        const proposal = (this.store.data.memoryProposals ?? []).find(
          (p) => p.id === request.id,
        );
        if (!proposal?.appliedMemoryId)
          throw new Error("There is nothing to undo for this entry");
        const memoryId = proposal.appliedMemoryId;
        const current = this.store.data.memories.find((m) => m.id === memoryId);
        const replaced = this.store.data.memories.find((m) => m.supersededBy === memoryId);
        if (proposal.op === "update" && replaced) {
          // The update was saved as a new memory: forget it and bring back the one it replaced.
          if (current && current.text !== proposal.text)
            throw new Error(
              "This memory has been changed since; edit it in the list instead",
            );
          delete replaced.supersededBy;
          delete replaced.supersededAt;
          replaced.updatedAt = Date.now();
          await this.request({ action: "memory-delete", id: memoryId });
          if (replaced.scope !== "personal")
            await this.host.saveWorkspaceMemory?.(replaced).catch(() => {});
          this.s3Workspace.schedulePush();
        } else if (proposal.op === "update") {
          // Put the earlier text back, unless somebody has edited it since.
          if (current && current.text === proposal.text && proposal.previousText)
            await this.saveMemoryInternal({
              id: current.id,
              kind: current.kind,
              tier: current.tier,
              cluster: current.cluster,
              scope: current.scope,
              title: current.title,
              text: proposal.previousText,
            });
          else if (current)
            throw new Error(
              "This memory has been changed since; edit it in the list instead",
            );
        } else if (current) {
          await this.request({ action: "memory-delete", id: memoryId });
        }
        this.store.data.memoryProposals = (
          this.store.data.memoryProposals ?? []
        ).filter((p) => p.id !== proposal.id);
        break;
      }
      case "memory-proposal-reject": {
        if (!(this.store.data.memoryProposals ?? []).some((p) => p.id === request.id))
          throw new Error("Proposal not found");
        this.store.data.memoryProposals = (
          this.store.data.memoryProposals ?? []
        ).filter((p) => p.id !== request.id);
        break;
      }
      case "memory-distill-activity": {
        const events = (this.store.data.activityLog ?? []).slice(-80);
        const last = events.at(-1);
        if (!last) throw new Error("There is no team activity to read yet");
        const status = await this.proposeMemoriesFrom(
          {
            id: `activity:${last.id}`,
            title: "Recent team activity",
            transcript: activityTranscript(events),
          },
          events
            .slice(-20)
            .map((e) => `${e.targetLabel} ${e.summary}`)
            .join(" "),
          { again: true },
        );
        if (status?.error) throw new Error(status.error);
        break;
      }
      default: {
        // Every request of this part has a case above: one that is given to it and not handled does not compile.
        const unhandled: never = request;
        throw new Error(`Unknown AI request: ${String((unhandled as { action?: unknown })?.action)}`);
      }
    }
    return reply ? { reply } : {};
  }
}
