import { createHash } from "node:crypto";
import path from "node:path";
import type { AiConfig } from "../../../../shared/types/ai";
import { pinnedNodeFetch, validateLlmEndpointAndEgress } from "../DirectAgentRuntime";
import type {
  HubReply,
  KbPage,
  KbPageSource,
  KbPageUse,
  AgentTask,
  KbDocument,
  WorkspaceServerSummary,
} from "../../../../shared/types/aiHub";
import {
  MAX_UPLOAD_BYTES,
  contentHash,
  extractText,
  fetchUrl,
  firstHeading,
  splitLongText,
  titleFromName,
  type Extracted,
} from "../KbExtract";
import { buildReadingPrompt, parseReading } from "../KbEnrich";
import {
  applyPageOps,
  isPrivateKbPage,
  buildCompilePrompt,
  buildLearnPrompt,
  buildRebuildPrompt,
  candidatePages,
  cleanKeys,
  markHeldAgainst,
  parsePageOps,
  savePageByPerson,
  searchPages,
  sourceParts,
  sumPageUse,
  undoPageChange,
  withUse,
  MAX_NEW_PAGES_PER_SOURCE,
  PAGE_KINDS,
} from "../KbCompile";
import { buildContradictionPrompt, noteGap, pairsToCompare, parseContradictions } from "../KbLint";
import { documentRevisedBy, sectionsOf } from "../KnowledgeBaseService";
import { deleteDemoKbDocument, getBuiltinKbDocuments, isDemoMode, saveDemoKbDocument } from "../demoWorkspace";
import { boundedContext, clip, maskContext, safeError, workspaceHostNames } from "../privacy";
import { live } from "../WorkBoard";
import { openAiCompatibleEmbedder, type Embedder } from "../EmbeddingIndex";
import { confirmedSomething, type DistillSource } from "../MemoryDistiller";
import { requiredText } from "../hubHelpers";
import { log } from "../hubShared";
import type { HubService } from "../HubService";
import type { Handled, RequestsOf } from "./routes";

/**
 * The knowledge base: documents, and the pages written from them.
 *
 * Taking in a file, a text, a link, a folder or a bucket prefix; reading documents in the background
 * and writing pages from them; keeping pages in step with their sources; searching; and what was
 * looked for and not found.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
function originalDirectoryName(id: string): string {
  const name = id.replace(/[^A-Za-z0-9._-]/g, "_");
  if (name && !name.endsWith(".") && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return name;
  return "document-" + createHash("sha256").update(id).digest("hex");
}

export class KnowledgePart {
  getKbDocumentsList(this: HubService): KbDocument[] {
    const stored = this.store.data.kbDocuments ?? [];
    const dismissed = new Set(this.store.data.preferences.dismissedBuiltinIds ?? []);
    const builtins = getBuiltinKbDocuments();
    return [
      ...stored,
      ...builtins.filter(
        (bk) => !dismissed.has(bk.id) && !stored.some((k) => k.id === bk.id),
      ),
    ];
  }

  /** For tests: what a finished run did, put down to the pages it worked from. */
  notePageOutcomeForTesting(this: HubService, task: AgentTask): void {
    this.notePageOutcome(task);
  }

  // ---- knowledge base: what is dropped in ----------------------------------

  kbOriginalDir(this: HubService, docId: string): string {
    return path.join(this.directory, "kb-originals", originalDirectoryName(docId));
  }
  kbOriginalKey(this: HubService, doc: Pick<KbDocument, "id" | "original">): string {
    const name = (doc.original?.name ?? "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(-120);
    return `kb/originals/${originalDirectoryName(doc.id)}/${name}`;
  }

  /** The file a document was taken from: from this computer, else from the team bucket (and then kept here). */
  async readKbOriginal(this: HubService, doc: KbDocument): Promise<Buffer | undefined> {
    const fsp = await import("node:fs/promises");
    const local = path.join(this.kbOriginalDir(doc.id), path.basename(this.kbOriginalKey(doc)));
    try {
      return await fsp.readFile(local);
    } catch {
      // Not here: a teammate added it.
    }
    const team = this.teamStore();
    if (doc.shared === false || doc.original?.keptLocal || !team) return undefined;
    const remote = await team.read(this.kbOriginalKey(doc)).catch(() => undefined);
    if (remote) {
      await fsp.mkdir(path.dirname(local), { recursive: true }).catch(() => undefined);
      await fsp.writeFile(local, remote).catch(() => undefined);
    }
    return remote;
  }

  /** This computer's copy of a document's original file. Also called when a teammate removed the document. */
  async removeLocalKbOriginal(this: HubService, docId: string): Promise<void> {
    const fsp = await import("node:fs/promises");
    await fsp.rm(this.kbOriginalDir(docId), { recursive: true, force: true }).catch(() => undefined);
  }

  async removeKbOriginal(this: HubService, docId: string): Promise<void> {
    const doc = { id: docId };
    await this.removeLocalKbOriginal(docId);
    const team = this.teamStore();
    if (!team) return;
    const dir = path.posix.dirname(this.kbOriginalKey(doc));
    const names = await team.list(dir).catch(() => [] as string[]);
    for (const name of names) await team.remove(`${dir}/${name}`).catch(() => undefined);
  }

  /**
   * Text that was taken out of a file, a link or a paste becomes one document
   * (or several, when it is very long), queued to be read for title, summary
   * and tags. Text that is already in the knowledge base is not added again.
   */
  async ingestExtracted(this: HubService,
    extracted: Extracted,
    source: {
      name: string;
      sourceType: KbDocument["sourceType"];
      sourceRef?: string;
      original?: { name: string; mime?: string; data: Buffer; keptLocal?: boolean };
    },
  ): Promise<NonNullable<HubReply["ingest"]>> {
    const hash = contentHash(extracted.text);
    const all = this.getKbDocumentsList();
    const twin = all.find((d) => (d.contentHash ?? contentHash(d.content)) === hash);
    if (twin) return { added: [], duplicates: [twin.title], failed: [] };
    const baseTitle = extracted.title?.trim() || titleFromName(source.name);
    const parts = splitLongText(extracted.text);
    const author = await this.resolveActorName();
    const now = Date.now();
    // An address names one thing: fetched again with a new text, it is the same source revised, not a
    // second source that the pages would then have to reconcile with the first. (A file's name names nothing.)
    // A pasted text is that document revised only under the same title too: otherwise a new one, said so.
    const { earlier, notes } = documentRevisedBy(this.store.data.kbDocuments ?? [], source, baseTitle, parts.length);
    if (earlier) {
      earlier.content = parts[0];
      earlier.chunks = sectionsOf(earlier.id, parts[0]);
      earlier.contentHash = hash;
      earlier.updatedAt = now;
      earlier.pages = extracted.pages;
      earlier.sourceCheck = { at: now };
      earlier.reading = { state: "queued", at: now, revised: this.pagesRestOn(earlier.id) };
      this.lastWorkSync = 0;
      this.kbRetryAt = 0;
      void this.readNextKb();
      return { added: [], duplicates: [], failed: [], updated: [earlier.title] };
    }
    const added: KbDocument[] = parts.map((text, i) => ({
      ...this.kb.createDocument({
        title: parts.length > 1 ? `${baseTitle} — part ${i + 1} of ${parts.length}` : baseTitle,
        sourceType: source.sourceType,
        sourceRef: source.sourceRef,
        content: text,
        author,
      }),
      contentHash: parts.length > 1 ? contentHash(text) : hash,
      titleFromSource: !extracted.title,
      pages: extracted.pages,
      reading: { state: "queued" as const, at: now + i },
    }));
    if (source.original) {
      const first = added[0];
      first.original = {
        name: source.original.name,
        mime: source.original.mime,
        size: source.original.data.length,
        ...(source.original.keptLocal ? { keptLocal: true as const } : {}),
      };
      const fsp = await import("node:fs/promises");
      const local = path.join(this.kbOriginalDir(first.id), path.basename(this.kbOriginalKey(first)));
      await fsp.mkdir(path.dirname(local), { recursive: true });
      await fsp.writeFile(local, source.original.data);
      const team = source.original.keptLocal ? undefined : this.teamStore();
      if (team)
        void team
          .write(this.kbOriginalKey(first), source.original.data)
          .catch((e) => log.warn("Could not upload a knowledge base original", safeError(e)));
    }
    this.store.data.kbDocuments = [...(this.store.data.kbDocuments ?? []), ...added];
    this.lastWorkSync = 0;
    void this.readNextKb();
    return { added: added.map((d) => d.title), duplicates: [], failed: [], ...(notes ? { notes } : {}) };
  }

  // ---- knowledge base: the pages agents read --------------------------------

  knownSystems(this: HubService, servers: WorkspaceServerSummary[]): { clusters: string[]; servers: string[] } {
    return {
      clusters: [...new Set(servers.map((s) => s.cluster).filter((c): c is string => Boolean(c)))],
      servers: servers.map((s) => s.name),
    };
  }

  /** How this installation's runs used the pages. Counts earlier versions kept on the pages are moved here once. */
  myPageUse(this: HubService): Record<string, KbPageUse> {
    const use = (this.store.data.kbUse ??= {});
    for (const page of this.store.data.kbPages ?? []) {
      if (page.opens === undefined && page.lastOpenedAt === undefined && page.proven === undefined && page.lastProvenAt === undefined) continue;
      if (!this.store.data.kbUseMoved && page.opens)
        use[page.id] = { ...use[page.id], opens: (use[page.id]?.opens ?? 0) + page.opens, lastOpenedAt: page.lastOpenedAt };
      // A page that came from an app that still counts on the page: the count is its app's, not this one's.
      delete page.opens;
      delete page.lastOpenedAt;
      delete page.proven;
      delete page.lastProvenAt;
    }
    this.store.data.kbUseMoved = true;
    return use;
  }
  /** How the team's runs used the pages: this installation's count plus what the others reported. */
  pageUse(this: HubService): Record<string, KbPageUse> {
    return sumPageUse([this.myPageUse(), ...this.othersPageUse]);
  }

  /** The pages as agents and the review list see them: with how they were used. */
  pagesWithUse(this: HubService): KbPage[] {
    const use = this.pageUse();
    return withUse(this.store.data.kbPages ?? [], use);
  }

  /**
   * Sources that came from a link are fetched again at night. A text that
   * changed brings the pages resting on it in line with it (the same way as
   * dropping the link in again); one that cannot be fetched twice in a row is
   * put up for review, and the pages keep what it last said.
   */
  async refetchWatchedSources(this: HubService, now = Date.now()): Promise<void> {
    const due = (this.store.data.kbDocuments ?? [])
      .filter(
        (d) =>
          d.sourceType === "url" &&
          d.sourceRef &&
          this.pagesRestOn(d.id) &&
          now - (d.sourceCheck?.at ?? 0) > 20 * 3_600_000,
      )
      .slice(0, 20);
    for (const doc of due) {
      if (this.disposed) return;
      try {
        const fetched = await fetchUrl(doc.sourceRef!, this.kbNetwork?.fetchImpl, {
          ...this.outboundGuard(),
          allowPlainHttp: true,
          lookup: this.kbNetwork?.lookup,
        });
        const current = (this.store.data.kbDocuments ?? []).find((d) => d.id === doc.id);
        if (!current) continue;
        const fetchedHash = contentHash(fetched.text);
        if (fetchedHash === (current.contentHash ?? contentHash(current.content))) {
          current.sourceCheck = { at: now };
          continue;
        }
        current.content = fetched.text;
        current.chunks = sectionsOf(current.id, fetched.text);
        current.contentHash = fetchedHash;
        current.pages = fetched.pages;
        current.updatedAt = now;
        current.sourceCheck = { at: now };
        current.reading = { state: "queued", at: now, revised: true };
        this.lastWorkSync = 0;
        this.kbRetryAt = 0;
      } catch (error) {
        const current = (this.store.data.kbDocuments ?? []).find((d) => d.id === doc.id);
        if (current)
          current.sourceCheck = {
            at: now,
            error: clip(safeError(error), 200),
            failures: (current.sourceCheck?.failures ?? 0) + 1,
          };
      }
    }
    await this.store.save().catch(() => undefined);
    void this.readNextKb();
  }

  pagesRestOn(this: HubService, docId: string): boolean {
    return (this.store.data.kbPages ?? []).some((p) => p.sources.some((s) => s.docId === docId));
  }

  /** The questions that found nothing, as the model writing pages is shown them. */
  openGaps(this: HubService): string[] {
    return (this.store.data.kbGaps ?? []).map((g) => g.query);
  }

  /** A question that found nothing is closed when one of the pages just written answers it. */
  closeAnsweredGaps(this: HubService, changedIds: string[]): void {
    const changed = (this.store.data.kbPages ?? []).filter((p) => changedIds.includes(p.id));
    if (!changed.length || !this.store.data.kbGaps?.length) return;
    this.store.data.kbGaps = this.store.data.kbGaps.filter((g) => searchPages(changed, g.query).length === 0);
  }

  /**
   * One model run that proposes page changes, applied at once (they can be
   * undone). What the pages then say is held against `sourceText`. Returns
   * how many pages changed.
   */
  async runPageOps(this: HubService,
    prompt: string,
    shown: KbPage[],
    source: KbPageSource,
    run: { id: string; title: string },
    known: { clusters: string[]; servers: string[] },
    options: { sourceText: string; updatesOnly?: boolean; mayCreate?: number; correctPersonText?: boolean },
  ): Promise<number> {
    const task = await this.runBackground(
      { prompt, mode: "advice", agentName: "Knowledge base", maxCommands: 1, maxMinutes: 8 },
      // KB authoring uses its assigned profile, or the main model when no role is assigned.
      { distillSourceId: run.id, title: clip(run.title, 100), mainModel: true, modelRole: "backgroundDistill" },
    );
    if (task.status !== "completed") throw new Error(task.error || "The run did not finish.");
    if (source.hash) {
      const current = this.getKbDocumentsList().find((d) => d.id === source.docId);
      if (!current || (current.contentHash ?? contentHash(current.content)) !== source.hash || (current.shared === false) !== Boolean(source.private)) return 0;
    }
    // A previously shared page may have become private while the model was working.
    const privateDocs = this.privateDocumentIds();
    if (!source.private && shown.some((p) => this.store.data.kbPages?.some((q) => q.id === p.id && isPrivateKbPage(q, privateDocs)) && !options.updatesOnly)) return 0;
    const answer = task.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
    // The pages the model was shown are the only ones it may update, and only as they are now.
    const now = this.store.data.kbPages ?? [];
    const stillShown = shown.flatMap((p) => now.filter((q) => q.id === p.id && q.revision === p.revision));
    const unusable = { count: 0 };
    const ops = parsePageOps(answer, stillShown, known, {
      allTitles: now.map((p) => p.title),
      updatesOnly: options.updatesOnly,
      mayCreate: options.mayCreate,
      unusable,
    });
    if (!ops) throw new Error("The model's answer could not be used.");
    // Pages that were answered but not in the format asked for are a failed run, not a run that found nothing to write.
    if (ops.length === 0 && unusable.count > 0)
      throw new Error(
        `The model answered with ${unusable.count} page${unusable.count === 1 ? "" : "s"} in a format that could not be read, so nothing was saved.`,
      );
    const applied = applyPageOps(now, ops, {
      by: "assistant",
      source,
      sourceText: options.sourceText,
      correctPersonText: options.correctPersonText,
    });
    // Shown and left as they were: held against the source all the same.
    this.store.data.kbPages = markHeldAgainst(applied.pages, stillShown.map((p) => p.id), source);
    if (applied.changed.length) this.closeAnsweredGaps(applied.changed.map((c) => c.id));
    this.lastWorkSync = 0;
    this.changed();
    return applied.changed.length;
  }

  privateDocumentIds(this: HubService): Set<string> {
    return new Set((this.store.data.kbDocuments ?? []).filter((d) => d.shared === false).map((d) => d.id));
  }

  /** Works a source into pages with the same sharing scope. */
  async compileSource(this: HubService,
    doc: KbDocument,
    known: { clusters: string[]; servers: string[] },
    revised = false,
  ): Promise<number> {
    const parts = sourceParts(doc);
    const source: KbPageSource = { docId: doc.id, title: doc.title, hash: doc.contentHash ?? contentHash(doc.content), ...(doc.shared === false ? { private: true } : {}) };
    let touched = 0;
    for (let i = 0; i < parts.length; i++) {
      const privateDocs = this.privateDocumentIds();
      const pages = (this.store.data.kbPages ?? []).filter((p) => isPrivateKbPage(p, privateDocs) === (doc.shared === false));
      // One source may not fill the knowledge base: new pages are counted over all its stretches.
      const mayCreate = MAX_NEW_PAGES_PER_SOURCE - pages.filter((p) => p.sources[0]?.docId === doc.id).length;
      touched += await this.runPageOps(
        buildCompilePrompt(doc, parts[i], pages, known, parts.length > 1 ? { index: i + 1, of: parts.length } : undefined, {
          revised,
          gaps: this.openGaps(),
          mayCreate,
        }),
        candidatePages(pages, `${doc.title} ${parts[i]}`, 6, doc.id),
        source,
        { id: `kbc:${doc.id}:${i}`, title: `Pages · ${doc.title}` },
        known,
        { sourceText: doc.content, mayCreate },
      );
    }
    return touched;
  }

  /** Has one page held against the sources it rests on and written again where it needs it. */
  async rebuildPage(this: HubService, pageId: string, docs: KbDocument[]): Promise<number> {
    const known = this.knownSystems((await this.collectExtraContext()).workspaceServers ?? []);
    let changed = 0;
    for (const doc of docs) {
      const parts = sourceParts(doc);
      for (let i = 0; i < parts.length; i++) {
        const page = (this.store.data.kbPages ?? []).find((p) => p.id === pageId);
        if (!page) return changed;
        changed += await this.runPageOps(
          buildRebuildPrompt(page, doc, parts[i], known, parts.length > 1 ? { index: i + 1, of: parts.length } : undefined),
          [page],
          { docId: doc.id, title: doc.title, hash: doc.contentHash ?? contentHash(doc.content), ...(doc.shared === false ? { private: true as const } : {}) },
          { id: `kbr:${pageId}:${doc.id}:${i}`, title: `Rebuilding · ${page.title}` },
          known,
          // A person asked for this page to be put right from its sources.
          { sourceText: doc.content, updatesOnly: true, correctPersonText: true },
        );
      }
    }
    await this.store.save().catch(() => undefined);
    return changed;
  }

  /**
   * What a finished conversation or ticket established, added to the pages:
   * a confirmed cause, a red herring, a procedure that was carried out. Only
   * from a record in which something was confirmed, and only while the
   * assistant may save what it learns without asking.
   */
  async learnPagesFrom(this: HubService, source: DistillSource): Promise<void> {
    if (isDemoMode() || !source.id.startsWith("task:")) return;
    if (this.store.data.preferences.autoSaveMemories === false || !confirmedSomething(source.transcript)) return;
    const known = this.knownSystems((await this.collectExtraContext()).workspaceServers ?? []);
    const remembered = (this.store.data.memoryProposals ?? [])
      .filter((p) => p.sourceId === source.id)
      .map((p) => `${p.title}: ${p.text}`);
    const privateDocs = this.privateDocumentIds();
    const pages = (this.store.data.kbPages ?? []).filter((p) => !isPrivateKbPage(p, privateDocs));
    await this.runPageOps(
      buildLearnPrompt(source, pages, known, remembered, this.openGaps()),
      candidatePages(pages, `${source.title} ${source.transcript}`),
      { docId: source.id, title: source.title },
      { id: `kbl:${source.id}`, title: `Pages · ${source.title}` },
      known,
      { sourceText: source.transcript },
    );
  }
  /**
   * Compares pages about the same systems and keeps where they disagree, for
   * the review list. One run reads a dozen pairs; with more, each check takes
   * the next dozen, and what earlier checks found about the others is kept.
   */
  async checkContradictions(this: HubService): Promise<void> {
    if (this.checkingContradictions) return;
    const all = this.store.data.kbPages ?? [];
    const { pairs, total, next } = pairsToCompare(all, 12, this.store.data.kbPairOffset ?? 0);
    if (pairs.length === 0) {
      this.store.data.kbContradictions = [];
      this.lastContradictionCheck = { at: Date.now(), found: 0, compared: 0, of: 0 };
      return;
    }
    this.checkingContradictions = true;
    this.changed();
    try {
      const task = await this.runBackground(
        { prompt: buildContradictionPrompt(pairs), mode: "advice", agentName: "Knowledge base", maxCommands: 1, maxMinutes: 8 },
        { distillSourceId: `kbx:${Date.now()}`, title: "Checking pages for contradictions", mainModel: true, modelRole: "backgroundDistill" },
      );
      const answer = task.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
      const found = task.status === "completed" ? parseContradictions(answer, pairs) : undefined;
      if (found) {
        const compared = new Set(pairs.map(([a, b]) => `${a.id}:${b.id}`));
        const alive = new Set(all.map((p) => p.id));
        this.store.data.kbContradictions = [
          // What was found about pairs this run did not read still stands, as long as both pages exist.
          ...(this.store.data.kbContradictions ?? []).filter(
            (c) => !compared.has(`${c.pageId}:${c.otherPageId}`) && alive.has(c.pageId ?? "") && alive.has(c.otherPageId ?? ""),
          ),
          ...found,
        ];
        this.store.data.kbPairOffset = next;
      }
      this.lastContradictionCheck = found
        ? { at: Date.now(), found: found.length, compared: pairs.length, of: total }
        : { at: Date.now(), found: 0, error: clip(task.error || "The model gave no answer that could be read.", 200) };
      await this.store.save().catch(() => undefined);
    } catch (error) {
      this.lastContradictionCheck = { at: Date.now(), found: 0, error: safeError(error) };
      throw error;
    } finally {
      this.checkingContradictions = false;
      this.changed();
    }
  }

  /**
   * Documents read from a folder or a bucket take the same way in as anything
   * else: the same text is not added twice, an unchanged file is left alone,
   * and what is new is queued to be read and is shared at the next sync.
   */
  addIngestedDocs(this: HubService,
    docs: KbDocument[],
    author?: string,
    failed: { name: string; error: string }[] = [],
  ): NonNullable<HubReply["ingest"]> {
    const map = new Map((this.store.data.kbDocuments ?? []).map((x) => [x.id, x]));
    const known = new Set([...map.values()].map((x) => x.contentHash).filter((h): h is string => Boolean(h)));
    const result = { added: [] as string[], duplicates: [] as string[], failed, updated: [] as string[] };
    for (const doc of docs) {
      doc.contentHash = contentHash(doc.content);
      const existing = map.get(doc.id);
      if (existing?.contentHash === doc.contentHash || (!existing && known.has(doc.contentHash))) {
        result.duplicates.push(doc.title);
        continue;
      }
      (existing ? result.updated : result.added).push(doc.title);
      known.add(doc.contentHash);
      doc.titleFromSource = true;
      doc.summary = existing?.summary;
      // Whoever read the folder or the bucket in is the author, as for a file dropped in.
      doc.author = existing?.author ?? doc.author ?? author;
      doc.reading = { state: "queued", at: Date.now() };
      map.set(doc.id, doc);
      if (isDemoMode()) saveDemoKbDocument(doc);
    }
    this.store.data.kbDocuments = Array.from(map.values());
    this.lastWorkSync = 0;
    void this.readNextKb();
    return result;
  }

  /**
   * An agent opened a page: counted, so pages nobody uses show up, and noted
   * on the conversation, so how the work ended can be put down to the page.
   * A test run counts nothing: it is not use.
   */
  notePageOpened(this: HubService, id: string, task?: AgentTask): void {
    if (task?.evalCaseId) return;
    const use = this.myPageUse();
    use[id] = { ...use[id], opens: (use[id]?.opens ?? 0) + 1, lastOpenedAt: Date.now() };
    if (task && !task.kbPages?.includes(id)) task.kbPages = [...(task.kbPages ?? []), id].slice(-20);
  }

  /**
   * A run ended: what it did since the last time is put down to the pages it
   * worked from. A change that passed its own check counts for the page; a
   * change that had to be taken back counts against it, and is put up for
   * review with the run's name. On a ticket an alert made, the page is noted
   * as the one for that alert, so the next ticket for it names the page.
   */
  notePageOutcome(this: HubService, task: AgentTask): void {
    const opened = (task.kbPages ?? []).filter((id) => (this.store.data.kbPages ?? []).some((p) => p.id === id));
    const fresh = task.changes.slice(task.kbCounted ?? 0);
    task.kbCounted = task.changes.length;
    if (!opened.length || isDemoMode()) return;
    const now = Date.now();
    const use = this.myPageUse();
    const rolledBack = fresh.some((c) => c.rollback?.ran);
    const proven = !rolledBack && fresh.some((c) => c.check?.after === true);
    for (const id of opened) {
      const have = use[id] ?? { opens: 0 };
      if (proven) use[id] = { ...have, proven: (have.proven ?? 0) + 1, lastProvenAt: now };
      if (rolledBack)
        use[id] = { ...have, rolledBack: [{ at: now, title: clip(task.title, 120) }, ...(have.rolledBack ?? [])].slice(0, 5) };
    }
    const ticket = task.ticketId ? live(this.store.data.workTickets).find((t) => t.id === task.ticketId) : undefined;
    const alert = ticket?.alert?.name;
    if (alert && task.status === "completed" && !rolledBack) {
      for (const page of this.store.data.kbPages ?? []) {
        if (!opened.includes(page.id) || page.kind === "system") continue;
        if ((page.alerts ?? []).some((a) => a.toLowerCase() === alert.toLowerCase())) continue;
        page.alerts = [...(page.alerts ?? []), alert].slice(-12);
        page.updatedAt = now;
        this.lastWorkSync = 0;
      }
    }
  }

  /** An agent's search found nothing: kept for the review list. */
  noteKbGap(this: HubService, query: string, task: AgentTask): void {
    this.store.data.kbGaps = noteGap(this.store.data.kbGaps ?? [], {
      query,
      agent: task.agentName,
      target: task.target?.label,
    });
  }

  /**
   * Reads the next document that is waiting: one model run gives it a title,
   * a summary, tags and a place. With a team bucket the document is claimed
   * first, so the team's installations (a server included) share the queue
   * instead of all reading the same document.
   */
  async readNextKb(this: HubService, now = Date.now()): Promise<void> {
    if (this.kbReadingId || this.disposed || isDemoMode() || now < this.kbRetryAt) return;
    const waiting = (this.store.data.kbDocuments ?? [])
      .filter(
        (d) =>
          d.reading &&
          (d.reading.state === "queued" ||
            (d.reading.state === "reading" && now - d.reading.at > 10 * 60_000)) &&
          (this.kbSkipUntil.get(d.id) ?? 0) < now,
      )
      .sort((a, b) => a.reading!.at - b.reading!.at);
    const doc = waiting[0];
    if (!doc) return;
    if (!(await this.config.getView().catch(() => ({ enabled: false }))).enabled) {
      this.kbNeedsModel = true;
      return;
    }
    this.kbReadingId = doc.id;
    const client = this.clientId();
    const sync = doc.shared !== false ? this.work() : undefined;
    let claimed = false;
    try {
      if (sync) {
        const held = await sync.claim(`kb-${doc.id}`, { by: await this.resolveActorName(), client }, now);
        if (held.client !== client) {
          this.kbSkipUntil.set(doc.id, now + 3 * 60_000);
          return;
        }
        claimed = true;
      }
      const revised = Boolean(doc.reading?.revised);
      doc.reading = { ...doc.reading!, state: "reading", at: now };
      this.changed();
      const extra = await this.collectExtraContext();
      const servers = extra.workspaceServers ?? [];
      const known = {
        clusters: [...new Set(servers.map((s) => s.cluster).filter((c): c is string => Boolean(c)))],
        servers: servers.map((s) => s.name),
        collections: [
          ...new Set(
            this.getKbDocumentsList()
              .map((d) => d.collection)
              .filter((c): c is string => Boolean(c) && c !== "General"),
          ),
        ],
      };
      const task = await this.runBackground(
        {
          prompt: buildReadingPrompt(doc, known),
          mode: "advice",
          agentName: "Knowledge base",
          maxCommands: 1,
          maxMinutes: 5,
        },
        { distillSourceId: `kb:${doc.id}`, title: `Reading · ${clip(doc.title, 80)}` },
      );
      const answer = task.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
      if (task.status !== "completed") throw new Error(task.error || "The reading run did not finish.");
      const reading = parseReading(answer, known);
      if (!reading) throw new Error("The model's answer could not be used.");
      // The document may have been edited or removed while it was read.
      const current = (this.store.data.kbDocuments ?? []).find((d) => d.id === doc.id);
      if (current) {
        if (current.titleFromSource && reading.title) current.title = reading.title;
        current.titleFromSource = false;
        current.summary = reading.summary;
        current.kind = reading.kind;
        current.tags = [...new Set([...(current.tags ?? []), ...reading.tags])].slice(0, 12);
        if (reading.cluster && !current.cluster) {
          current.cluster = reading.cluster;
          current.targetCluster = reading.cluster;
        }
        if (reading.collection && (!current.collection || current.collection === "General"))
          current.collection = reading.collection;
        current.reading = { state: "done", at: Date.now() };
        current.updatedAt = Date.now();
        this.lastWorkSync = 0;
        // Then what it says is worked into the pages agents read. A failure
        // here leaves the document read and searchable; it can be read again.
        try {
          const touched = await this.compileSource(current, known, revised);
          current.compiled = { at: Date.now(), pages: touched };
        } catch (error) {
          current.reading = { state: "done", at: Date.now(), error: `Not worked into the pages: ${boundedContext(safeError(error), 200)}` };
        }
        current.updatedAt = Date.now();
      }
      this.kbNeedsModel = false;
      // The model reads again. Documents whose reading failed may have failed only because it did
      // not then (a provider that was down, a setting it refused): they get another try, a bounded
      // number of times, so a document that cannot be read at all is not tried for ever.
      for (const other of this.store.data.kbDocuments ?? [])
        if (other.reading?.state === "failed" && (other.reading.attempts ?? 0) < 4)
          other.reading = { state: "queued", attempts: other.reading.attempts, at: Date.now() };
    } catch (error) {
      const reason = safeError(error);
      const current = (this.store.data.kbDocuments ?? []).find((d) => d.id === doc.id);
      if (/api key|choose a model|endpoint missing|enable ai|not signed in|oauth/i.test(reason)) {
        // Nothing is wrong with the document: there is no model to read it with yet.
        this.kbNeedsModel = true;
        this.kbRetryAt = Date.now() + 5 * 60_000;
        if (current) current.reading = { state: "queued", at: current.reading?.at ?? now };
      } else if (current) {
        const attempts = (current.reading?.attempts ?? 0) + 1;
        current.reading =
          attempts >= 2
            ? { state: "failed", attempts, error: boundedContext(reason, 300), at: Date.now() }
            : { state: "queued", attempts, at: Date.now() };
      }
    } finally {
      if (claimed) await sync?.release(`kb-${doc.id}`, client).catch(() => undefined);
      this.kbReadingId = undefined;
      await this.store.save().catch(() => undefined);
      this.changed();
    }
    if (!this.disposed) void this.readNextKb();
  }

  /**
   * A removed document's pages: one written from it alone goes with it (a person may have removed the
   * document for what it says, and the page says the same); one that rests on other sources too
   * no longer names it. A page a person edited is kept, without the source.
   */
  forgetKbSource(this: HubService, docId: string, wasPrivate = false): void {
    const pages = this.store.data.kbPages ?? [];
    if (wasPrivate) {
      const privateDoc = new Set([docId]);
      for (const page of pages) if (isPrivateKbPage(page, privateDoc)) page.private = true;
    }
    if (!pages.some((p) => p.sources.some((s) => s.docId === docId))) return;
    const now = Date.now();
    this.store.data.kbPages = pages.flatMap((p) => {
      if (!p.sources.some((s) => s.docId === docId)) return [p];
      const rest = p.sources.filter((s) => s.docId !== docId);
      if (!rest.length && !p.editedByPerson) {
        this.markSharedRemoved("pages", p.id);
        return [];
      }
      return [{ ...p, ...(wasPrivate || p.sources.some((source) => source.private) ? { private: true as const } : {}), sources: rest, updatedAt: Math.max(now, p.updatedAt + 1) }];
    });
    this.changed();
  }

  /**
   * The embedder for knowledge base search: the configured OpenAI-compatible
   * endpoint with an embedding model set. Other providers have no embeddings
   * endpoint, and demo documents are never sent anywhere; search is then
   * lexical.
   */
  async kbEmbedder(this: HubService): Promise<Embedder | undefined> {
    if (isDemoMode()) return undefined;
    const config = await this.config.getConfig("embedding").catch(() => undefined);
    if (
      !config?.enabled ||
      config.provider !== "openai-compatible" ||
      !config.baseUrl ||
      !config.embeddingModel
    )
      return undefined;
    return openAiCompatibleEmbedder({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey || undefined,
      model: config.embeddingModel,
      piiMode: config.piiScrubbing,
      hosts: config.piiScrubbing === "strict" ? workspaceHostNames(this.getKnownServers()) : undefined,
      fetchImpl: (url, init) => this.fetchModel(config, String(url), init ?? {}),
    });
  }
  /** Checks the configured data policy and connects to the address that passed the check. */
  async fetchModel(this: HubService, config: Pick<AiConfig, "provider" | "model" | "egressPolicy" | "zdrConfirmed">, url: string, init: RequestInit): Promise<Response> {
    const target = await validateLlmEndpointAndEgress(url, {
      provider: config.provider, model: config.model, baseUrl: url,
      egressPolicy: config.egressPolicy, zdrConfirmed: config.zdrConfirmed,
      ...this.outboundGuard(), lookup: this.kbNetwork?.lookup,
    });
    const request: RequestInit = { ...init, redirect: "manual" };
    const response = this.kbNetwork
      ? await this.kbNetwork.fetchImpl(url, request)
      : await pinnedNodeFetch(target, request);
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => {});
      throw new Error("The model service redirected the request.");
    }
    return response;
  }

  /** The requests this part answers. What a case leaves in `reply` goes back with the snapshot. */
  async handleKnowledge(this: HubService, request: RequestsOf<"knowledge">): Promise<Handled> {
    let reply: HubReply | undefined;
    switch (request.action) {
      case "kb-save": {
        const d = request.doc;
        const before = d.id ? this.getKbDocumentsList().find((x) => x.id === d.id) : undefined;
        const doc = this.kb.createDocument({
          id: d.id,
          collection: d.collection,
          title: requiredText(d.title),
          sourceType: d.sourceType || "note",
          sourceRef: d.sourceRef,
          cluster: d.cluster,
          tags: d.tags,
          content: requiredText(d.content),
          shared: d.shared ?? before?.shared ?? true,
          author: await this.resolveActorName(),
        });
        if (before) {
          doc.restoredAt = before.restoredAt;
          doc.republishedAt = before.republishedAt;
          if (before.shared === false && doc.shared !== false) {
            doc.republishedAt = Math.max(Date.now(), (this.store.data.sharedRemoved?.kb?.[doc.id] ?? 0) + 1);
            doc.updatedAt = Math.max(doc.updatedAt, doc.republishedAt);
          }
          // Whoever brought it in stays its author; an edit does not take the document over.
          if (before.author) doc.author = before.author;
          // An edit keeps what the reading and the upload gave the document.
          doc.summary = before.summary;
          doc.kind = before.kind;
          doc.original = before.original;
          if (doc.shared === false && before.original && !before.original.keptLocal && before.shared !== false) {
            const team = this.teamStore();
            // Keep the owner's own copy before withdrawing the original from the team. Without team
            // storage the file is here when it was added here: then it was never uploaded, or it was
            // uploaded to a store that is not connected now, and its copy there is taken out when the
            // store is next reached (`withdraw`, see syncSharedSetup). Only a file that is not here
            // needs the store, to be fetched from it first.
            if (!(await this.readKbOriginal(before)))
              throw new Error(
                team
                  ? "The original file could not be saved here. Try again when your team storage is available."
                  : "The original file is not on this computer, because a teammate added it. Connect to your team storage to make this original private.",
              );
            if (team) await team.remove(this.kbOriginalKey(before));
            doc.original = { ...before.original, keptLocal: true, ...(team ? {} : { withdraw: true }) };
          }
          if (doc.shared === false) {
            const sourceId = new Set([doc.id]);
            for (const page of this.store.data.kbPages ?? []) {
              if (isPrivateKbPage(page, sourceId)) page.private = true;
            }
            if (before.shared !== false) this.markSharedRemoved("kb", doc.id);
          }
          doc.pages = before.pages;
          doc.reading = before.reading;
          doc.compiled = before.compiled;
          doc.sourceCheck = before.sourceCheck;
          // A person set the title: the reading does not replace it any more.
          doc.titleFromSource = before.title === doc.title ? before.titleFromSource : false;
        }
        doc.contentHash = contentHash(doc.content);
        // What it says now has to reach the pages agents read: a new text is worked in, a changed one
        // brings the pages resting on it in line. (The demo lab has no model to do it with.)
        if (!isDemoMode() && (!before || (before.contentHash ?? contentHash(before.content)) !== doc.contentHash)) {
          doc.reading = { state: "queued", at: Date.now(), revised: this.pagesRestOn(doc.id) };
          this.kbRetryAt = 0;
          queueMicrotask(() => void this.readNextKb());
        }
        this.store.data.kbDocuments = [
          ...(this.store.data.kbDocuments ?? []).filter((x) => x.id !== doc.id),
          doc,
        ];
        if (isDemoMode()) saveDemoKbDocument(doc);
        this.lastWorkSync = 0;
        break;
      }
      case "kb-delete": {
        const removedDoc = this.getKbDocumentsList().find((d) => d.id === request.id);
        if (!removedDoc) throw new Error("Document not found");
        // A page of a followed Confluence space: removed here, it is not read in again tomorrow.
        await this.atlassian.skipConfluence(removedDoc);
        this.store.data.kbDocuments = (this.store.data.kbDocuments ?? []).filter(
          (d) => d.id !== request.id,
        );
        this.markSharedRemoved("kb", request.id);
        this.forgetKbSource(request.id, removedDoc.shared === false);
        void this.removeKbOriginal(request.id);
        // Before deleteDemoKbDocument: in demo mode the built-ins are the demo store's documents.
        this.markBuiltinDismissed(request.id, getBuiltinKbDocuments());
        if (isDemoMode()) deleteDemoKbDocument(request.id);
        break;
      }
      case "kb-ingest-file": {
        const data = Buffer.from(String(request.dataBase64 ?? ""), "base64");
        const name = boundedContext(requiredText(request.name), 200);
        if (data.length > MAX_UPLOAD_BYTES)
          throw new Error(`"${name}" is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`);
        const extracted = await extractText({ name, mime: request.mime, data });
        // A file that is dropped in may hold a password (a .env, a configuration file). Its text is masked
        // here, as it is on its way to the team, so that this computer and the teammates keep the same text.
        const masked = maskContext(extracted.text);
        reply = {
          ingest: await this.ingestExtracted(
            { ...extracted, text: masked },
            {
              name,
              sourceType: "upload",
              sourceRef: name,
              // The file itself cannot be masked. One whose text needed masking stays on this computer.
              original: { name, mime: request.mime, data, keptLocal: masked !== extracted.text },
            },
          ),
        };
        break;
      }
      case "kb-ingest-text": {
        // A file out of an editor may hold a password; a note somebody wrote for the team is kept as written.
        const text = request.mask ? maskContext(requiredText(request.text)) : requiredText(request.text);
        const title = request.title?.trim() || firstHeading(text);
        reply = {
          ingest: await this.ingestExtracted(
            { text, format: "text", title },
            {
              name: title || text.trim().split("\n")[0].replace(/^[#>*\s-]+/, "").slice(0, 80) || "Pasted note",
              sourceType: "paste",
              sourceRef: request.sourceRef ? boundedContext(request.sourceRef, 300) : undefined,
            },
          ),
        };
        break;
      }
      case "kb-ingest-url": {
        const fetched = await fetchUrl(requiredText(request.url), this.kbNetwork?.fetchImpl, {
          ...this.outboundGuard(),
          allowPlainHttp: true,
          lookup: this.kbNetwork?.lookup,
        });
        reply = {
          ingest: await this.ingestExtracted(fetched, {
            name: fetched.title || fetched.url,
            sourceType: "url",
            sourceRef: fetched.url,
          }),
        };
        break;
      }
      case "kb-read": {
        const found = this.getKbDocumentsList().find((d) => d.id === request.id);
        if (!found) throw new Error("Document not found");
        reply = { kbDocument: found };
        break;
      }
      case "kb-search": {
        const query = requiredText(request.query);
        const docs = this.getKbDocumentsList();
        const result = await this.kb.searchHybrid(
          docs,
          { query, limit: Math.max(1, Math.min(20, request.limit ?? 8)) },
          await this.kbEmbedder(),
          this.embeddings,
        );
        const byId = new Map(docs.map((d) => [d.id, d]));
        reply = {
          kbSearch: {
            query,
            byMeaning: result.retrieval === "hybrid",
            hits: [
              ...searchPages(this.store.data.kbPages ?? [], query).map((h) => ({
                pageId: h.page.id,
                docId: h.page.id,
                title: h.page.title,
                collection: h.page.kind,
                heading: h.page.when,
                snippet: boundedContext(h.snippet, 420),
                score: h.score,
              })),
              ...result.matches.map((m) => ({
              docId: m.docId,
              title: m.title,
              collection: m.collection,
              heading: byId.get(m.docId)?.chunks?.[m.chunkIndex]?.heading,
              snippet: boundedContext(m.snippet, 420),
              score: m.score,
            })),
            ],
          },
        };
        break;
      }
      case "kb-original": {
        const found = this.getKbDocumentsList().find((d) => d.id === request.id);
        if (!found?.original) throw new Error("This document has no original file.");
        const data = await this.readKbOriginal(found);
        if (!data && found.original.keptLocal)
          throw new Error(
            `The original file holds something that looks like a password or a key, so it was not shared with the team. ${found.author ? `${found.author} has it` : "The person who added it has it"}; the text here has those parts masked.`,
          );
        if (!data) throw new Error("The original file is not on this computer and could not be fetched from the team bucket.");
        reply = {
          download: {
            name: found.original.name,
            mime: found.original.mime || "application/octet-stream",
            dataBase64: data.toString("base64"),
          },
        };
        break;
      }
      case "kb-reread": {
        const found = (this.store.data.kbDocuments ?? []).find((d) => d.id === request.id);
        if (!found) throw new Error("Document not found");
        found.reading = { state: "queued", at: Date.now() };
        found.compiled = undefined;
        this.kbRetryAt = 0;
        void this.readNextKb();
        break;
      }
      case "kb-page-read": {
        const found = (this.store.data.kbPages ?? []).find((p) => p.id === request.id);
        if (!found) throw new Error("Page not found");
        reply = { kbPage: found };
        break;
      }
      case "kb-page-save": {
        const p = request.page;
        if (!PAGE_KINDS.includes(p.kind)) throw new Error("Unknown kind of page");
        const existing = (this.store.data.kbPages ?? []).find((x) => x.id === p.id);
        // Removed (here, or by a teammate and synced): saving the old view does not bring it back.
        if (p.id && !existing && this.store.data.sharedRemoved?.pages?.[p.id])
          throw new Error("This page was removed, so the change was not saved. Create a new page to keep the text.");
        const saved = savePageByPerson(
          existing,
          { kind: p.kind, title: requiredText(p.title), when: requiredText(p.when), body: requiredText(p.body), targets: p.targets, keys: p.keys },
          await this.resolveActorName(),
        );
        if (p.alerts) saved.alerts = cleanKeys(p.alerts).length ? cleanKeys(p.alerts) : undefined;
        // The version this edit was made from: a teammate's removal after it wins over the edit.
        if (existing) saved.baseAt = existing.updatedAt;
        this.store.data.kbPages = [...(this.store.data.kbPages ?? []).filter((x) => x.id !== saved.id), saved];
        this.lastWorkSync = 0;
        reply = { kbPage: saved };
        break;
      }
      case "kb-page-delete":
        if (!(this.store.data.kbPages ?? []).some((p) => p.id === request.id)) throw new Error("Page not found");
        this.store.data.kbPages = (this.store.data.kbPages ?? []).filter((p) => p.id !== request.id);
        this.markSharedRemoved("pages", request.id);
        break;
      case "kb-page-undo": {
        const found = (this.store.data.kbPages ?? []).find((p) => p.id === request.id);
        if (!found) throw new Error("Page not found");
        const result = undoPageChange(found, await this.resolveActorName());
        if (!result.undone) throw new Error("The text this change replaced is no longer kept, so it cannot be undone.");
        // Undoing the creation of a page removes it. That is offered for a page the assistant created;
        // a page a person wrote has nothing to go back to, and is deleted only by deleting it.
        if (!result.page && found.history[0]?.by !== "assistant")
          throw new Error("This page has only its first version, so there is nothing to undo. To remove it, delete the page.");
        if (!result.page) reply = { kbPageRemoved: { id: found.id, title: found.title } };
        this.store.data.kbPages = (this.store.data.kbPages ?? []).flatMap((p) =>
          p.id === found.id ? (result.page ? [result.page] : []) : [p],
        );
        if (!result.page) this.markSharedRemoved("pages", found.id);
        this.lastWorkSync = 0;
        break;
      }
      case "kb-page-rebuild": {
        const found = (this.store.data.kbPages ?? []).find((p) => p.id === request.id);
        if (!found) throw new Error("Page not found");
        const docs = this.getKbDocumentsList().filter((d) => found.sources.some((s) => s.docId === d.id));
        if (docs.length === 0)
          throw new Error(
            found.sources.some((s) => !s.docId.startsWith("task:"))
              ? "None of this page's sources is in the knowledge base any more."
              : "This page rests on no source document (it was written by hand or learned from finished work), so there is nothing to update it from.",
          );
        this.rebuildingPages.add(found.id);
        this.lastRebuilds.delete(found.id);
        void this.rebuildPage(found.id, docs)
          .then((changed) => this.lastRebuilds.set(found.id, { at: Date.now(), changed: changed > 0 }))
          .catch((e) => {
            log.warn("Rebuilding a page failed", safeError(e));
            this.lastRebuilds.set(found.id, { at: Date.now(), changed: false, error: clip(safeError(e), 200) });
          })
          .finally(() => {
            this.rebuildingPages.delete(found.id);
            this.changed();
          });
        break;
      }
      case "kb-check-contradictions":
        void this.checkContradictions().catch((e) => log.warn("Contradiction check failed", safeError(e)));
        break;
      case "kb-finding-dismiss": {
        const id = requiredText(request.id);
        if (id.startsWith("gap:"))
          this.store.data.kbGaps = (this.store.data.kbGaps ?? []).filter((g) => `gap:${g.id}` !== id);
        else if (id.startsWith("contradiction:"))
          this.store.data.kbContradictions = (this.store.data.kbContradictions ?? []).filter((c) => c.id !== id);
        else if (id.startsWith("unverified:")) {
          // Not hidden: answered. A person says the lines are right, and the page stops calling them unverified.
          const pageId = id.split(":")[1];
          const by = await this.resolveActorName();
          this.store.data.kbPages = (this.store.data.kbPages ?? []).map((p) =>
            p.id === pageId && p.unverified
              ? {
                  ...p,
                  unverified: undefined,
                  updatedAt: Date.now(),
                  updatedBy: by,
                  history: [{ at: Date.now(), by, summary: "Checked the commands that were in none of the sources" }, ...p.history.map((h) => ({ at: h.at, by: h.by, summary: h.summary }))].slice(0, 12),
                }
              : p,
          );
          this.lastWorkSync = 0;
        } else this.store.data.kbDismissedFindings = [...(this.store.data.kbDismissedFindings ?? []), id].slice(-300);
        break;
      }
      case "kb-gap-answered": {
        const gap = (this.store.data.kbGaps ?? []).find((g) => `gap:${g.id}` === request.id || g.id === request.id);
        const page = (this.store.data.kbPages ?? []).find((p) => p.id === request.pageId);
        if (!gap) throw new Error("That question is no longer on the list.");
        if (!page) throw new Error("Page not found");
        // The words the agent used become one of the page's search phrases: the same question finds it next time.
        page.keys = cleanKeys([gap.query, ...(page.keys ?? [])]);
        page.updatedAt = Date.now();
        this.store.data.kbGaps = (this.store.data.kbGaps ?? []).filter((g) => g.id !== gap.id);
        this.lastWorkSync = 0;
        break;
      }
      case "kb-ingest-folder": {
        // A folder path here would be a folder on the server, readable by any signed-in user through the knowledge base.
        // Also in a demo on a shared server: the folder is still a folder of the machine it runs on.
        if (this.sharedServer()) throw new Error("A folder on the server cannot be read into the knowledge base from the browser. Drop the files in instead.");
        const docs = await this.kb.ingestLocalFolder(
          requiredText(request.folderPath),
          {
            collection: request.collection,
            cluster: request.cluster ?? request.targetCluster,
            tags: request.tags,
          },
        );
        reply = { ingest: this.addIngestedDocs(docs, await this.resolveActorName()) };
        break;
      }
      case "kb-ingest-s3": {
        const prefix = request.prefix?.trim() || "runbooks/";
        const targetCluster = request.cluster?.trim() || request.targetCluster?.trim() || undefined;
        const isDemoS3Target =
          (await this.isDemoTargetRef(request.s3ProfileId)) ||
          (isDemoMode() && request.s3ProfileId === "sg-fabricpool-dc1");

        if (this.host.resolveStorageProvider && !isDemoS3Target) {
          await this.assertStorageReach(request.s3ProfileId);
          const provider = await this.host.resolveStorageProvider(
            request.s3ProfileId,
          );
          if (!provider) {
            throw new Error(`S3 profile "${request.s3ProfileId}" not found`);
          }
          const left: { name: string; error: string }[] = [];
          const docs = await this.kb.ingestFromStorageProvider(
            provider,
            prefix,
            request.collection?.trim() || `S3:${request.s3ProfileId}`,
            targetCluster,
            undefined,
            { failed: left },
          );
          reply = { ingest: this.addIngestedDocs(docs, await this.resolveActorName(), left) };
          break;
        }

        if (!isDemoMode()) {
          throw new Error(`S3 profile "${request.s3ProfileId}" not found`);
        }

        const doc = this.kb.createDocument({
          title: `S3 KB Sync: ${request.s3ProfileId} (${prefix})`,
          sourceType: "s3",
          sourceRef: `s3://${request.s3ProfileId}/${prefix}`,
          cluster: targetCluster || "NetApp-StorageGRID-S3",
          tags: ["s3-kb", "runbook", request.s3ProfileId],
          content: [
            `# Knowledge base from S3 (${request.s3ProfileId}/${prefix})`,
            "",
            "Demo data: this stands in for the documents a real bucket prefix would hold (operations notes, runbooks, configuration standards).",
            "- Check the S3 ILM rules and the Object Lock (WORM) status at every release.",
            "- Check the FabricPool link between ONTAP (`aggr1_nvme_prod`, `aggr2_nvme_db`) and StorageGRID.",
          ].join("\n"),
          shared: true,
        });
        this.store.data.kbDocuments = [
          ...(this.store.data.kbDocuments ?? []).filter((x) => x.id !== doc.id),
          doc,
        ];
        saveDemoKbDocument(doc);
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
