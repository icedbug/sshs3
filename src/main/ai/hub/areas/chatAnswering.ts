import type { HubService } from "../HubService";
import type { Handled, RequestsOf } from "./routes";

/**
 * The agent bot in chat: its settings, its connection, linking a chat account, and answering its
 * changes in the app.
 *
 * The agent bot is one for everybody on a web server, kept by the server and not by any one person's
 * hub. So this part only hands each request to the server (`host.chatAnswering`), which knows who
 * asks and checks what they may do. Where there is no such server (the desktop app), it says so.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
export class ChatAnsweringPart {
  async handleChatAnswering(this: HubService, request: RequestsOf<"chatAnswering">): Promise<Handled> {
    const server = this.host.chatAnswering;
    if (!server) throw new Error("The agent bot answers in chat from a web server several people share. It is not part of this app.");
    const reply = await server.request(request);
    return reply ? { reply } : {};
  }
}
