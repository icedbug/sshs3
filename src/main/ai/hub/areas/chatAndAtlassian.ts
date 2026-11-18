import type { HubReply, TicketChatRef } from "../../../../shared/types/aiHub";
import { hostOf } from "../Notifier";
import { chatTerms } from "../ChatIndex";
import { clip, safeError } from "../privacy";
import { live } from "../WorkBoard";
import { requiredText, integer } from "../hubHelpers";
import { log } from "../hubShared";
import type { HubService } from "../HubService";
import type { Handled, RequestsOf } from "./routes";

/**
 * What the team says in chat, and Jira and Confluence.
 *
 * The requests that set up the team's chat bot and choose what it reads, search what it read, and put a
 * thread into the knowledge base; and the ones that connect Jira and Confluence. The reading itself is
 * ChatBridge and AtlassianBridge: this is where a person's request reaches them.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
export class ChatAndAtlassianPart {
  /** A change to what the bot reads or keeps is written down with who made it. */
  async chatDone(this: HubService, done: { target: string; what: string }): Promise<void> {
    await this.audit()
      .append({ kind: "setting", actor: await this.resolveActorName(), ...done, outcome: "completed" })
      .catch((e) => log.warn("Could not write the audit log", safeError(e)));
  }

  /** The bot is the team's, one for everybody on a shared server: there it is the administrator's to connect, point at channels and empty. */
  assertChatAdmin(this: HubService): void {
    if (this.sharedServer() && !this.host.teamAdmin?.())
      throw new Error("Only an administrator of this server sets up the team's chat bot or changes what it reads.");
  }

  /**
   * What the team said in chat about what a ticket is about, in the last week:
   * threads that name its server or cluster, or its alert. A thread has to
   * hold every word of the name it was found by: "pg-01" is not found by a
   * thread that only says "pg".
   */
  chatAbout(this: HubService, names: (string | undefined)[], now = Date.now()): TicketChatRef[] {
    if (!this.chat.active()) return [];
    const found = new Map<string, TicketChatRef & { score: number }>();
    for (const name of names) {
      const terms = [...new Set(chatTerms(name ?? ""))];
      if (!terms.length) continue;
      for (const hit of this.chat.search({ query: name!, sinceMs: now - 7 * 86_400_000, limit: 5 }, now)) {
        const said = new Set(chatTerms(this.chat.thread(hit.service, hit.channelId, hit.threadId).map((m) => m.text).join(" ")));
        if (!terms.every((term) => said.has(term))) continue;
        const id = `${hit.service}:${hit.channelId}:${hit.threadId}`;
        if ((found.get(id)?.score ?? -1) >= hit.score) continue;
        found.set(id, {
          service: hit.service,
          channelId: hit.channelId,
          channel: hit.channel,
          threadId: hit.threadId,
          at: hit.at,
          link: hit.link,
          excerpt: hit.messages
            .slice(-4)
            .map((m) => `${m.author}: ${clip(m.text, 400)}`)
            .join("\n"),
          score: hit.score,
        });
      }
    }
    return [...found.values()]
      .sort((a, b) => b.score - a.score || b.at - a.at)
      .slice(0, 3)
      .map(({ score: _score, ...ref }) => ref);
  }

  /**
   * An alert's ticket that came in where there is no bot (a teammate's
   * installation, through the bucket) gets what was said in chat from the
   * installation that has one, once for the team.
   */
  async fillChatOnTickets(this: HubService, now = Date.now()): Promise<void> {
    if (!this.chat.active()) return;
    for (const ticket of live(this.store.data.workTickets)) {
      if (!ticket.alert || ticket.status === "done" || ticket.chatLookedAt || now - ticket.createdAt > 24 * 3_600_000) continue;
      const sync = this.work();
      if (sync && !(await sync.markOnce(`chat-ticket-${ticket.id}`, this.clientId(), this.notifySettle).catch(() => false))) {
        // A teammate's installation has it: looked at here no more.
        ticket.chatLookedAt = now;
        continue;
      }
      const refs = this.chatAbout([ticket.target, ticket.alert.name], now);
      const current = this.store.data.workTickets?.find((t) => t.id === ticket.id && !t.deleted);
      if (current) this.putTicket({ ...current, chatLookedAt: now, ...(refs.length ? { chatRefs: refs } : {}), updatedAt: Math.max(now, current.updatedAt + 1) });
    }
  }
  /** The requests this part answers. What a case leaves in `reply` goes back with the snapshot. */
  async handleChatAndAtlassian(this: HubService, request: RequestsOf<"chatAndAtlassian">): Promise<Handled> {
    let reply: HubReply | undefined;
    switch (request.action) {
      case "atlassian-save": {
        await this.atlassian.save(request.connection);
        void this.audit()
          .append({
            kind: "setting",
            actor: await this.resolveActorName(),
            target: "sshs3 on this computer",
            what: `Connection to ${request.connection.product === "jira" ? "Jira" : "Confluence"} saved: ${hostOf(request.connection.baseUrl)}${request.connection.product === "jira" && request.connection.projects?.length ? `, projects ${request.connection.projects.join(", ")}` : ""}`,
            outcome: "completed",
          })
          .catch(() => undefined);
        break;
      }
      case "atlassian-test":
        reply = { atlassianTest: await this.atlassian.test(request.product) };
        break;
      case "atlassian-disconnect": {
        await this.atlassian.disconnect(request.product);
        void this.audit()
          .append({ kind: "setting", actor: await this.resolveActorName(), target: "sshs3 on this computer", what: `Connection to ${request.product === "jira" ? "Jira" : "Confluence"} removed`, outcome: "completed" })
          .catch(() => undefined);
        break;
      }
      case "kb-ingest-confluence":
        reply = { ingest: await this.atlassian.addConfluence({ spaceKey: request.spaceKey, pageId: request.pageId }, await this.resolveActorName()) };
        await this.store.save().catch(() => undefined);
        break;
      case "kb-page-publish": {
        const page = (this.store.data.kbPages ?? []).find((x) => x.id === request.id);
        if (!page) throw new Error("Page not found");
        const published = await this.atlassian.publishPage(page, { spaceKey: request.spaceKey, parentId: request.parentId }, await this.resolveActorName());
        // Read again: the page may have been edited while Confluence answered. Where it was published is
        // not a change of its text: no new revision, but a newer copy, so the team sees it too.
        const now = (this.store.data.kbPages ?? []).find((x) => x.id === request.id);
        if (now) {
          now.published = published;
          now.updatedAt = Math.max(Date.now(), now.updatedAt + 1);
          this.lastWorkSync = 0;
          reply = { kbPage: now };
        }
        break;
      }
      case "chat-source-save":
        this.assertChatAdmin();
        await this.chatDone(await this.chat.save(request.connection));
        break;
      case "chat-source-test":
        this.assertChatAdmin();
        reply = { chatTest: await this.chat.test(request.service) };
        break;
      case "chat-source-disconnect":
        this.assertChatAdmin();
        await this.chatDone(await this.chat.disconnect(request.service, request.forget === true));
        break;
      case "chat-channel-select":
        this.assertChatAdmin();
        await this.chatDone(await this.chat.select(request.service, requiredText(request.channelId), request.selected === true));
        break;
      case "chat-channel-read-back":
        this.assertChatAdmin();
        await this.chat.readBack(request.service, requiredText(request.channelId), integer(request.days, 1, 3650));
        break;
      case "chat-forget":
        this.assertChatAdmin();
        await this.chatDone(await this.chat.forget(request.service, request.channelId));
        break;
      case "chat-retention":
        this.assertChatAdmin();
        await this.chat.setRetention(request.days === undefined ? undefined : integer(request.days, 1, 3650));
        break;
      case "chat-search": {
        const query = requiredText(request.query);
        reply = {
          chatSearch: {
            query,
            hits: this.chat
              .search({
                query,
                channel: request.channel,
                sinceMs: request.sinceDays ? Date.now() - integer(request.sinceDays, 1, 3650) * 86_400_000 : undefined,
                limit: Math.max(1, Math.min(20, request.limit ?? 8)),
              })
              .map(({ score: _score, ...hit }) => hit),
          },
        };
        break;
      }
      case "chat-thread-to-kb": {
        const thread = this.chat.thread(request.service, requiredText(request.channelId), requiredText(request.threadId));
        if (!thread.length) throw new Error("That thread is not in what was read.");
        const channel = this.chat.index.channel(request.service, request.channelId)?.name ?? request.channelId;
        const day = new Date(thread[0].at).toISOString().slice(0, 10);
        // A person chose this thread: it becomes a source like a pasted text, and the pages are written from it by the same rules.
        reply = {
          ingest: await this.ingestExtracted(
            {
              text: [`A thread in the team's chat, #${channel}, ${day}. What people wrote to each other, not checked.`, "", ...thread.map((m) => `${m.author}: ${m.text}`)].join("\n"),
              format: "text",
              title: `Chat thread in #${channel}, ${day}: ${clip(thread[0].text, 80)}`,
            },
            { name: `#${channel} ${day}`, sourceType: "paste", sourceRef: thread[0].link || `chat:${request.service}/${request.channelId}/${request.threadId}` },
          ),
        };
        break;
      }
      case "kb-confluence-unfollow":
        await this.atlassian.unfollowConfluence(requiredText(request.ref));
        break;
      case "jira-sync-now":
        reply = { jiraSync: await this.atlassian.syncJira(Date.now(), true) };
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
