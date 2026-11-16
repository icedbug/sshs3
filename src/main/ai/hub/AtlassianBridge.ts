import type {
  AtlassianConnectionInput,
  AtlassianConnectionView,
  ExternalIssueRef,
  HubReply,
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
  pickDoneTransition,
  siteOf,
  ticketIdFor,
  ticketTextFor,
  type AtlassianAuth,
  type AtlassianTransport,
  type JiraIssue,
} from "./Atlassian";
import { AtlassianStore, type AtlassianConnection, type AtlassianProduct } from "./AtlassianStore";
import { guardUrl, request, type GuardOptions } from "./Notifier";
import { clip, safeError } from "./privacy";

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
      lastError: c.lastError,
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
    if (!token) throw new Error(had && !sameSite ? "The address changed, so the token has to be entered again." : "The connection needs a token.");
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
    if (!auth) return { ok: false, error: "Save the address and the token first." };
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
        if (force) throw new Error("Connect Jira and choose at least one project first.");
        return undefined;
      }
      if (!force && now - this.lastJiraSync < JIRA_SYNC_INTERVAL_MS) return undefined;
      this.lastJiraSync = now;
      try {
        const result = await this.pass(connection, auth, now);
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
    if (!had) {
      if (issue.statusCategory === "done") return "skipped";
      let ticket: WorkTicket = {
        id,
        title: text.title,
        description: text.description,
        // Text from outside the team: a person reads it and moves it before any agent works on it.
        status: "backlog",
        outside: `Jira issue ${issue.key}`,
        external: { system: "jira", key: issue.key, url: issue.url, status: issue.status, statusCategory: issue.statusCategory, remoteUpdatedAt: issue.updatedAt },
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
      },
    };
    const moved = boardStatusFor(issue.statusCategory, had.status, was?.statusCategory);
    if (moved && !(await this.host.ticketRuns(had))) {
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
    next = await this.withJiraComments(auth, next, issue);
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
}
