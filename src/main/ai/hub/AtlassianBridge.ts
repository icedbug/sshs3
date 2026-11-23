import type {
  AtlassianConnectionInput,
  AtlassianConnectionView,
  ExternalIssueRef,
  HubReply,
  KbDocument,
  KbPage,
  WorkTicket,
  WorkTicketComment,
} from "../../../shared/types/aiHub";
import {
  AtlassianError,
  boardJql,
  boardStatusFor,
  confluence,
  isProjectKey,
  jira,
  markdownToStorage,
  pickDoneTransition,
  siteOf,
  storageToHtml,
  issueTextHash,
  ticketIdFor,
  ticketTextBefore,
  ticketTextFor,
  type AtlassianAuth,
  type AtlassianTransport,
  type ConfluencePage,
  type JiraIssue,
} from "./Atlassian";
import { htmlToMarkdown, type Extracted } from "./KbExtract";
import { AtlassianStore, type AtlassianConnection, type AtlassianProduct } from "./AtlassianStore";
import { guardUrl, request, type GuardOptions } from "./Notifier";
import { unreadSecretNote } from "../../crypto/SecretFieldCrypto";
import { clip, maskContext, safeError } from "./privacy";

/** What the bridge needs of the hub: the board, and the few things only the hub knows. */
export interface BridgeHost {
  /** Every ticket, removed ones included. */
  tickets(): WorkTicket[];
  putTicket(ticket: WorkTicket): void;
  /** Whether an agent is running it now, here or on a teammate's computer. */
  ticketRuns(ticket: WorkTicket): Promise<boolean>;
  /** True for the one installation of the team that should do a thing; true always without a team bucket. */
  once(key: string): Promise<boolean>;
  guard(): GuardOptions;
  /** The knowledge base's documents as stored: what a read of Confluence adds to and revises. */
  kbDocs(): KbDocument[];
  /** Adds a text to the knowledge base the way every source is added (same text: not again; same address: revised). */
  ingest(
    extracted: Extracted,
    source: { name: string; sourceType: "confluence"; sourceRef: string },
  ): Promise<NonNullable<HubReply["ingest"]>>;
  /** Writes the hub's own store: documents were added or marked. */
  persist(): Promise<void>;
  record(entry: { actor: string; target: string; what: string; outcome: string }): void;
  changed(): void;
}

/** How often the board asks Jira what changed. */
export const JIRA_SYNC_INTERVAL_MS = 2 * 60_000;
/** Read again from a little before the newest change seen: clocks differ, and an index lags. */
const OVERLAP_MINUTES = 5;
const MAX_COMMENTS = 40;

const jiraCommentId = (id: string): string => `jira-${id}`;

function withNote(ticket: WorkTicket, comment: WorkTicketComment): WorkTicket {
  if ((ticket.comments ?? []).some((c) => c.id === comment.id)) return ticket;
  return {
    ...ticket,
    comments: [...(ticket.comments ?? []), comment].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).slice(-MAX_COMMENTS),
  };
}

/**
 * Jira on the board.
 *
 * Reading: every open issue of the chosen projects is a ticket; its title,
 * text, status and comments follow the issue. What is written in Jira is text
 * from outside the team, so such a ticket waits in Backlog for a person and
 * never starts an agent by itself.
 *
 * Writing, and only this: an agent's result as one comment when its run ends,
 * a person's decision as a comment, and the issue closed when the ticket is
 * done here. What is owed is read off the ticket each pass, not remembered in
 * a queue: whichever installation holds a connection does it, once.
 */
export class AtlassianBridge {
  private running: Promise<unknown> = Promise.resolve();
  private lastJiraSync = 0;
  /** Replaced in tests: how a call reaches the service. */
  transport?: AtlassianTransport;

  constructor(
    readonly store: AtlassianStore,
    private readonly host: BridgeHost,
  ) {}

  /** Checks the address, pins what it resolved to, and never follows a redirect. */
  private readonly send: AtlassianTransport = async (r) => {
    if (this.transport) return this.transport(r);
    const target = await guardUrl(r.url, this.host.guard());
    const answer = await request(target, { method: r.method, headers: r.headers, body: r.body });
    return { status: answer.status, body: answer.body };
  };

  view(product: AtlassianProduct): AtlassianConnectionView | undefined {
    const c = this.store.data[product];
    if (!c) return undefined;
    return {
      product,
      variant: c.variant,
      baseUrl: c.baseUrl,
      email: c.email,
      hasToken: Boolean(c.token),
      account: c.account,
      enabled: c.enabled,
      projects: c.projects,
      doneTransition: c.doneTransition,
      closeOnApprove: c.closeOnApprove !== false,
      lastSyncAt: c.lastSyncAt,
      // A token that could not be read on this start is said here, where a failed read is said.
      lastError: this.store.tokenUnread(product) ? unreadSecretNote("The token") : c.lastError,
      watched: c.watched,
    };
  }

  async save(input: AtlassianConnectionInput): Promise<void> {
    if (input.product !== "jira" && input.product !== "confluence") throw new Error("Unknown product");
    const had = this.store.data[input.product];
    const variant = input.variant === "datacenter" ? "datacenter" : "cloud";
    const baseUrl = (input.baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!baseUrl) throw new Error("The connection needs the site's address, like https://team.atlassian.net");
    // Said at once when the address is wrong or not allowed, and checked again on every call.
    const target = await guardUrl(baseUrl, this.host.guard());
    const sameSite = had ? new URL(had.baseUrl).origin === target.url.origin : false;
    // A token is for one site: at another address it is not sent along.
    const token = input.token?.trim() || (sameSite ? had?.token : "") || "";
    // A token for this site that is stored but could not be read on this start stays as it is stored.
    const kept = sameSite && this.store.tokenUnread(input.product);
    if (!token && !kept) throw new Error(had && !sameSite ? "The address changed, so the token has to be entered again." : "The connection needs a token.");
    const email = variant === "cloud" ? (input.email ?? "").trim() : undefined;
    if (variant === "cloud" && !email) throw new Error("Atlassian Cloud signs in with the account's e-mail and an API token.");
    const projects = [...new Set((input.projects ?? had?.projects ?? []).map((p) => p.trim().toUpperCase()).filter(isProjectKey))].slice(0, 50);
    const sameScope = sameSite && JSON.stringify(projects) === JSON.stringify(had?.projects ?? []);
    const next: AtlassianConnection = {
      ...(sameSite ? had : {}),
      variant,
      baseUrl,
      email,
      token,
      enabled: input.enabled !== false,
      ...(input.product === "jira"
        ? {
            projects,
            doneTransition: input.doneTransition?.trim().slice(0, 80) || undefined,
            closeOnApprove: input.closeOnApprove !== false,
            // Other projects or another site: the board is filled from the start again.
            ...(sameScope ? {} : { filled: false, syncedTo: undefined }),
          }
        : {}),
      lastError: undefined,
    };
    this.store.data[input.product] = next;
    await this.store.save();
    this.lastJiraSync = 0;
  }

  async disconnect(product: AtlassianProduct): Promise<void> {
    this.store.data[product] = undefined;
    await this.store.save();
  }

  async test(product: AtlassianProduct): Promise<NonNullable<HubReply["atlassianTest"]>> {
    const auth = this.store.auth(product, true);
    if (!auth) return { ok: false, error: this.store.tokenUnread(product) ? unreadSecretNote("The token") : "Save the address and the token first." };
    try {
      if (product === "jira") {
        const me = await jira.myself(this.send, auth);
        const projects = await jira.projects(this.send, auth);
        this.store.data.jira!.account = me.name;
        await this.store.save();
        return { ok: true, account: me.name, projects };
      }
      const spaces = await confluence.spaces(this.send, auth);
      this.store.data.confluence!.account = this.store.data.confluence!.email ?? "a token";
      await this.store.save();
      return { ok: true, spaces: spaces.map((s) => ({ key: s.key, name: s.name })) };
    } catch (error) {
      return { ok: false, error: clip(safeError(error), 300) };
    }
  }

  /** Asks for a read at the next tick: something on the board changed that Jira is owed. */
  kick(): void {
    this.lastJiraSync = 0;
  }

  /** Reads Jira and writes what is owed, one pass at a time. A failure is kept on the connection and shown, never thrown at the board. */
  syncJira(now = Date.now(), force = false): Promise<NonNullable<HubReply["jiraSync"]> | undefined> {
    const run = this.running.then(async () => {
      const connection = this.store.data.jira;
      const auth = this.store.auth("jira");
      if (!connection || !auth || !connection.projects?.length) {
        if (force) throw new Error(this.store.tokenUnread("jira") ? unreadSecretNote("The token") : "Connect Jira and choose at least one project first.");
        return undefined;
      }
      if (!force && now - this.lastJiraSync < JIRA_SYNC_INTERVAL_MS) return undefined;
      this.lastJiraSync = now;
      try {
        const result = await this.pass(connection, auth, now);
        // Something was written there: read again at the next tick, so the board shows what it became.
        if (result.written > 0) this.lastJiraSync = 0;
        connection.lastSyncAt = now;
        connection.lastError = undefined;
        await this.store.save();
        this.host.changed();
        return result;
      } catch (error) {
        connection.lastError = clip(safeError(error), 300);
        await this.store.save().catch(() => undefined);
        this.host.changed();
        if (force) throw error;
        return undefined;
      }
    });
    this.running = run.catch(() => undefined);
    return run;
  }

  private async pass(connection: AtlassianConnection, auth: AtlassianAuth, now: number): Promise<NonNullable<HubReply["jiraSync"]>> {
    const site = new URL(siteOf(auth)).host;
    const jql = connection.filled
      ? boardJql(connection.projects!, Math.max(1, (now - (connection.syncedTo ?? now)) / 60_000) + OVERLAP_MINUTES)
      : boardJql(connection.projects!);
    const found = await jira.search(this.send, auth, jql);
    let added = 0;
    let updated = 0;
    let newest = connection.syncedTo ?? 0;
    for (const issue of found.issues) {
      newest = Math.max(newest, issue.updatedAt);
      const outcome = await this.take(auth, site, issue, now);
      if (outcome === "added") added++;
      else if (outcome === "updated") updated++;
    }
    connection.syncedTo = newest || now;
    connection.filled = true;
    const written = await this.writeOwed(connection, auth, site, now);
    return { added, updated, written, more: found.more };
  }

  /** One issue onto the board. */
  private async take(auth: AtlassianAuth, site: string, issue: JiraIssue, now: number): Promise<"added" | "updated" | "same" | "skipped"> {
    const id = ticketIdFor(site, issue.id);
    const had = this.host.tickets().find((t) => t.id === id);
    // Removed from the board by a person: it stays removed, whatever happens to the issue.
    if (had?.deleted) return "skipped";
    const text = ticketTextFor(issue);
    const textHash = issueTextHash(issue);
    if (!had) {
      if (issue.statusCategory === "done") return "skipped";
      let ticket: WorkTicket = {
        id,
        title: text.title,
        description: text.description,
        // Text from outside the team: a person reads it and moves it before any agent works on it.
        status: "backlog",
        outside: `Jira issue ${issue.key}`,
        external: { system: "jira", key: issue.key, url: issue.url, status: issue.status, statusCategory: issue.statusCategory, remoteUpdatedAt: issue.updatedAt, textHash },
        createdBy: "Jira",
        createdAt: now,
        updatedAt: now,
      };
      ticket = await this.withJiraComments(auth, ticket, issue);
      this.host.putTicket(ticket);
      return "added";
    }
    const was = had.external;
    if (was && was.remoteUpdatedAt === issue.updatedAt && was.status === issue.status && had.title === text.title) return "same";
    // Whether what is written in the issue was changed there since it was last read. A ticket from before
    // the mark was kept is compared by its text, as it is made now and as it was made then.
    const before = ticketTextBefore(issue);
    const rewritten = was?.textHash
      ? was.textHash !== textHash
      : !((had.title === text.title || had.title === before.title) && (had.description === text.description || had.description === before.description));
    let next: WorkTicket = {
      ...had,
      title: text.title,
      description: text.description,
      external: {
        ...(was ?? { system: "jira" as const, key: issue.key, url: issue.url }),
        key: issue.key,
        url: issue.url,
        status: issue.status,
        statusCategory: issue.statusCategory,
        remoteUpdatedAt: issue.updatedAt,
        textHash,
      },
    };
    const moved = boardStatusFor(issue.statusCategory, had.status, was?.statusCategory);
    // Whether an agent runs it is asked only where the answer decides something: it may be a question to the team's store.
    let running = moved ? await this.host.ticketRuns(had) : undefined;
    const movedNow = Boolean(moved) && running === false;
    if (moved && movedNow) {
      next = withNote(
        { ...next, status: moved, claim: undefined, external: { ...next.external!, ...(moved === "backlog" ? { doneSentAt: undefined } : {}) } },
        {
          // The same on every installation that reads it: the note is made once.
          id: `jira-status-${issue.id}-${issue.updatedAt}`,
          at: now,
          author: "Jira",
          text: moved === "done" ? `${issue.key} was closed in Jira (${issue.status}).` : `${issue.key} was opened again in Jira (${issue.status}).`,
        },
      );
    }
    const notesBefore = new Set((next.comments ?? []).map((c) => c.id));
    next = await this.withJiraComments(auth, next, issue);
    const newComments = (next.comments ?? []).filter((c) => !notesBefore.has(c.id)).length;
    // A person read the ticket and put it in front of an agent. What was written in Jira after that
    // (the issue's text, or a comment) is new text from outside that nobody here has read: the ticket
    // waits in Backlog again. One that an agent is running stays with the run, with a note for whoever
    // reviews its result. Review and Blocked wait for a person already.
    if ((rewritten || newComments > 0) && !movedNow && (had.status === "todo" || had.status === "in_progress")) {
      running ??= await this.host.ticketRuns(had);
      const what = [rewritten ? "its text" : "", newComments ? (newComments === 1 ? "a new comment" : `${newComments} new comments`) : ""].filter(Boolean).join(" and ");
      const back = had.status === "todo" && !running;
      next = withNote(back ? { ...next, status: "backlog", claim: undefined } : next, {
        // The same on every installation that reads it: the note is made once.
        id: `jira-changed-${issue.id}-${issue.updatedAt}`,
        at: now,
        author: "Jira",
        text: back
          ? `${issue.key} was changed in Jira after this ticket was put in To do (${what}). Moved to Backlog: read it again, and move it back when it should be worked.`
          : `${issue.key} was changed in Jira after this run started (${what}). The run works from what the ticket said before: read the change when you review its result.`,
      });
    }
    this.host.putTicket({ ...next, updatedAt: Math.max(now, had.updatedAt + 1) });
    return "updated";
  }

  /** New comments of the issue, as notes on the ticket. What this side wrote there is not read back. */
  private async withJiraComments(auth: AtlassianAuth, ticket: WorkTicket, issue: JiraIssue): Promise<WorkTicket> {
    let comments;
    try {
      comments = await jira.comments(this.send, auth, issue.key);
    } catch {
      // The issue is still mirrored; its comments come with the next change.
      return ticket;
    }
    const ours = new Set(ticket.external?.postedCommentIds ?? []);
    let next = ticket;
    for (const c of comments) {
      if (ours.has(c.id) || !c.text.trim()) continue;
      next = withNote(next, { id: jiraCommentId(c.id), at: c.at || Date.now(), author: `${clip(c.author, 80)} (Jira)`, text: clip(c.text, 4000) });
    }
    return next;
  }

  /** The marks this installation holds: what it took on, and tries again if the write failed. */
  private readonly taken = new Set<string>();

  /**
   * Whether a write is this installation's to do. One of the team takes it;
   * the others leave it owed and see it done when the ticket syncs. The one
   * that took it tries again while it fails.
   */
  private async mineToDo(key: string): Promise<boolean> {
    if (this.taken.has(key)) return true;
    if (!(await this.host.once(key))) return false;
    this.taken.add(key);
    return true;
  }

  /**
   * What the board owes Jira, read off the tickets: a result not yet written,
   * a decision not yet written, an issue not yet closed. Each is done by one
   * installation of the team, and a failure is kept on the ticket.
   */
  private async writeOwed(connection: AtlassianConnection, auth: AtlassianAuth, site: string, now: number): Promise<number> {
    let written = 0;
    // Only tickets of the site this connection is for: a board can hold another site's from a teammate.
    const ofThisSite = ticketIdFor(site, "");
    const mine = (t: WorkTicket): boolean => !t.deleted && t.external?.system === "jira" && t.id.startsWith(ofThisSite);
    const once = (key: string): Promise<boolean> => this.mineToDo(key);
    for (const snapshot of this.host.tickets().filter(mine)) {
      let ticket = snapshot;
      const patch = (external: Partial<ExternalIssueRef>): void => {
        ticket = { ...ticket, external: { ...ticket.external!, ...external }, updatedAt: Math.max(Date.now(), ticket.updatedAt + 1) };
      };
      const key = ticket.external!.key;
      try {
        // 1. The agent's result, once per run.
        const runEnded = (ticket.status === "review" || ticket.status === "blocked") && ticket.result && ticket.taskId;
        if (runEnded && ticket.external!.resultPostedFor !== ticket.taskId) {
          if (await once(`jira-result-${ticket.id}-${ticket.taskId}`)) {
            const said =
              ticket.status === "review"
                ? `${ticket.assigneeName ?? "An agent"} finished this in sshS3, and it waits for a person's review:`
                : `${ticket.assigneeName ?? "An agent"} stopped on this in sshS3:`;
            const made = await jira.addComment(this.send, auth, key, `${said}\n\n${clip(ticket.result!, 6000)}`);
            this.host.record({ actor: ticket.assigneeName ?? "An agent", target: `Jira ${key}`, what: "Wrote the run's result as a comment", outcome: "completed" });
            written++;
            patch({ resultPostedFor: ticket.taskId, postedCommentIds: [...(ticket.external!.postedCommentIds ?? []), made.id].filter(Boolean).slice(-50), error: undefined });
          }
        }
        // 2. A person's decision.
        for (const comment of (ticket.comments ?? []).filter((c) => c.push === "jira")) {
          if (ticket.external!.pushedCommentIds?.includes(comment.id)) continue;
          if (await once(`jira-comment-${ticket.id}-${comment.id}`)) {
            const made = await jira.addComment(this.send, auth, key, `${comment.author} in sshS3: ${comment.text}`);
            this.host.record({ actor: comment.author, target: `Jira ${key}`, what: `Wrote a comment: ${clip(comment.text, 200)}`, outcome: "completed" });
            written++;
            patch({
              pushedCommentIds: [...(ticket.external!.pushedCommentIds ?? []), comment.id].slice(-50),
              postedCommentIds: [...(ticket.external!.postedCommentIds ?? []), made.id].filter(Boolean).slice(-50),
              error: undefined,
            });
          }
        }
        // 3. Done here, still open there.
        if (ticket.status === "done" && ticket.external!.statusCategory !== "done" && !ticket.external!.doneSentAt && connection.closeOnApprove !== false) {
          if (await once(`jira-done-${ticket.id}-${ticket.statusAt ?? 0}`)) {
            const way = pickDoneTransition(await jira.transitions(this.send, auth, key), connection.doneTransition);
            if (!way) {
              patch({
                doneSentAt: now,
                error: connection.doneTransition
                  ? `Jira offers no transition called "${connection.doneTransition}" for ${key}, so it was not closed there.`
                  : `Jira has more than one way to close ${key}, or none this account may take. Name the one to use in the Jira settings; it was not closed there.`,
              });
            } else {
              await jira.transition(this.send, auth, key, way.id);
              this.host.record({ actor: "sshS3", target: `Jira ${key}`, what: `Closed the issue (${way.name}) after the ticket was done here`, outcome: "completed" });
              written++;
              // Closed there now; its new status name comes with the next read.
              patch({ doneSentAt: now, statusCategory: "done", error: undefined });
            }
          }
        }
      } catch (error) {
        const said = error instanceof AtlassianError ? error.message : safeError(error);
        if (ticket.external!.error !== said) patch({ error: clip(said, 300) });
      }
      if (ticket !== snapshot) this.host.putTicket(ticket);
    }
    return written;
  }

  // ---- Confluence as a source of the knowledge base ---------------------------

  /** Where a page's document says it is from: the same for the same page, whatever its title becomes. */
  private pageRef(site: string, pageId: string): string {
    return `confluence://${site}/${pageId}`;
  }

  /**
   * Adds the pages of a space, or one page with what is under it, as sources,
   * and follows them: they are read again when they change. Returns what was
   * added, as every way of adding sources does.
   */
  async addConfluence(from: { spaceKey?: string; pageId?: string }, by: string, now = Date.now()): Promise<NonNullable<HubReply["ingest"]>> {
    const connection = this.store.data.confluence;
    const auth = this.store.auth("confluence");
    if (!connection || !auth) throw new Error("Connect Confluence first.");
    const spaceKey = from.spaceKey?.trim();
    const pageId = from.pageId?.trim();
    if (!spaceKey && !pageId) throw new Error("Give a space key, or the id of a page whose tree to add.");
    const watch = spaceKey ? { kind: "space" as const, ref: spaceKey } : { kind: "tree" as const, ref: pageId! };
    const result = await this.readConfluence(connection, auth, watch, now);
    connection.watched = [
      ...(connection.watched ?? []).filter((w) => !(w.kind === watch.kind && w.ref === watch.ref)),
      { ...watch, addedAt: now, by, lastReadAt: now, pages: result.seen },
    ].slice(-40);
    connection.lastError = undefined;
    await this.store.save();
    return result.reply;
  }

  async unfollowConfluence(ref: string): Promise<void> {
    const connection = this.store.data.confluence;
    if (!connection) return;
    connection.watched = (connection.watched ?? []).filter((w) => w.ref !== ref);
    await this.store.save();
  }

  /** A person removed this document: the page it was is not added again by a later read. */
  async skipConfluence(doc: Pick<KbDocument, "sourceType" | "sourceRef">): Promise<void> {
    const connection = this.store.data.confluence;
    if (!connection || doc.sourceType !== "confluence" || !doc.sourceRef) return;
    connection.skipped = [...new Set([...(connection.skipped ?? []), doc.sourceRef])].slice(-2000);
    await this.store.save();
  }

  /** Reads what is followed again, once a day: a changed page revises its document, a page that is gone is said so on it. */
  async rereadConfluence(now = Date.now()): Promise<void> {
    const connection = this.store.data.confluence;
    const auth = this.store.auth("confluence");
    if (!connection || !auth) return;
    for (const watch of connection.watched ?? []) {
      if (now - (watch.lastReadAt ?? 0) < 20 * 3_600_000) continue;
      watch.lastReadAt = now;
      try {
        watch.pages = (await this.readConfluence(connection, auth, watch, now)).seen;
        connection.lastError = undefined;
      } catch (error) {
        connection.lastError = clip(safeError(error), 300);
      }
    }
    await this.store.save().catch(() => undefined);
  }

  private async readConfluence(
    connection: AtlassianConnection,
    auth: AtlassianAuth,
    watch: { kind: "space" | "tree"; ref: string },
    now: number,
  ): Promise<{ reply: NonNullable<HubReply["ingest"]>; seen: number }> {
    const site = new URL(siteOf(auth)).host;
    const found = await confluence.pages(this.send, auth, watch.kind === "space" ? { spaceKey: watch.ref } : { pageId: watch.ref });
    const reply: NonNullable<HubReply["ingest"]> = { added: [], duplicates: [], failed: [], updated: [], notes: [] };
    const skipped = new Set(connection.skipped ?? []);
    const watchKey = `${watch.kind}:${watch.ref}`;
    const seen = new Set<string>();
    for (const page of found.pages) {
      const ref = this.pageRef(site, page.id);
      seen.add(ref);
      if (skipped.has(ref)) continue;
      const had = this.host.kbDocs().find((d) => d.sourceType === "confluence" && d.sourceRef === ref);
      if (had?.external?.version === page.version) {
        had.sourceCheck = { at: now };
        continue;
      }
      try {
        const text = await this.pageText(page);
        // A page with nothing on it (a folder of a tree, a title only) is not a source.
        if (text.trim().length < 40) continue;
        const one = await this.host.ingest({ text, format: "html", title: page.title }, { name: page.title, sourceType: "confluence", sourceRef: ref });
        reply.added.push(...one.added);
        reply.duplicates.push(...one.duplicates);
        reply.updated!.push(...(one.updated ?? []));
        const doc = this.host.kbDocs().find((d) => d.sourceType === "confluence" && d.sourceRef === ref);
        if (doc) {
          doc.external = { system: "confluence", pageId: page.id, url: page.url, version: page.version, watch: watchKey };
          doc.sourceCheck = { at: now };
        }
      } catch (error) {
        reply.failed.push({ name: page.title, error: clip(safeError(error), 200) });
      }
    }
    // What came through this space or tree and is no longer in it: said on the document, which keeps its text.
    if (!found.more)
      for (const doc of this.host.kbDocs()) {
        if (doc.sourceType !== "confluence" || doc.external?.watch !== watchKey || !doc.sourceRef || seen.has(doc.sourceRef)) continue;
        doc.sourceCheck = { at: now, error: "This page is no longer in Confluence where it was read from.", failures: (doc.sourceCheck?.failures ?? 0) + 1 };
      }
    if (found.more) reply.notes!.push("There were more pages than are read at once (500); the rest were left out. Add a smaller tree to get them.");
    if (!reply.notes!.length) delete reply.notes;
    await this.host.persist().catch(() => undefined);
    this.host.changed();
    return { reply, seen: seen.size };
  }

  /** A page's text as the knowledge base keeps text, with what looks like a secret masked: a wiki is where passwords get pasted. */
  private async pageText(page: ConfluencePage): Promise<string> {
    const { text } = await htmlToMarkdown(`<html><body>${storageToHtml(page.storage)}</body></html>`, page.url, false);
    return maskContext(text);
  }

  // ---- a knowledge base page, published to Confluence -------------------------

  /**
   * Writes a page to Confluence: a new page the first time, the same page
   * after that. When somebody changed it there since it was last published,
   * nothing is written and that is said: their change is not overwritten.
   */
  async publishPage(
    page: Pick<KbPage, "id" | "title" | "when" | "body" | "revision" | "published">,
    where: { spaceKey?: string; parentId?: string },
    by: string,
    now = Date.now(),
  ): Promise<NonNullable<KbPage["published"]>> {
    const auth = this.store.auth("confluence");
    if (!auth) throw new Error("Connect Confluence first.");
    const storage = [
      page.when.trim() ? `<p><em>${markdownToStorage(page.when.trim()).replace(/^<p>|<\/p>$/g, "")}</em></p>` : "",
      markdownToStorage(page.body),
      `<p><em>Published from the sshS3 knowledge base by ${markdownToStorage(by).replace(/^<p>|<\/p>$/g, "")}, revision ${page.revision}. Changes made here are replaced by the next publish.</em></p>`,
    ]
      .filter(Boolean)
      .join("\n");
    let made;
    if (page.published) {
      const there = await confluence.page(this.send, auth, page.published.pageId).catch((error) => {
        if (error instanceof AtlassianError && error.status === 404)
          throw new Error("The page is no longer in Confluence where it was published. Publish it as a new page by giving a space.");
        throw error;
      });
      if (there.version !== page.published.version)
        throw new Error(
          `The page was changed in Confluence since it was published from here (version ${there.version} there, version ${page.published.version} published). Nothing was written: look at it there first.`,
        );
      made = await confluence.update(this.send, auth, { id: there.id, version: there.version, title: page.title, storage });
    } else {
      const spaceKey = where.spaceKey?.trim();
      if (!spaceKey) throw new Error("Say which space to publish the page in.");
      made = await confluence.create(this.send, auth, { spaceKey, parentId: where.parentId?.trim() || undefined, title: page.title, storage });
    }
    this.host.record({ actor: by, target: `Confluence ${made.url}`, what: `Published the page "${clip(page.title, 120)}" (revision ${page.revision})`, outcome: "completed" });
    return { system: "confluence", pageId: made.id, url: made.url, version: made.version, revision: page.revision, at: now, by };
  }
}
