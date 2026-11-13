import { describe, expect, it, vi } from "vitest";
import { MCP_TOOLS, callMcpTool, toolsForScopes } from "../../src/main/web/mcp/mcpTools";
import type { HubRequest, HubSnapshot } from "../../src/shared/types/aiHub";

const NOW = Date.now();
const HOUR = 3600_000;
const SNAP = {
  workspaceServers: [
    { id: "s1", name: "db01", host: "db01.internal", port: 22, username: "ops", cluster: "DB-Prod", description: "The primary" },
    { id: "s2", name: "web01", host: "web01.internal", port: 22, username: "ops", cluster: "Web" },
  ],
  serverFacts: {
    enabled: true,
    intervalHours: 6,
    exclude: [],
    watchPaths: [],
    collecting: [],
    servers: [
      {
        serverId: "s1",
        name: "db01",
        status: "ok",
        os: "Debian 12",
        kernel: "6.1.0",
        collectedAt: NOW - 2 * HOUR,
        bootAt: NOW - 100 * HOUR,
        packages: 812,
        services: 44,
        listening: 6,
        problems: [{ key: "disk:/", severity: "warning", text: "/ is 91% full" }],
        disks: [{ mount: "/", usedPct: 91 }],
        changes: [
          { at: NOW - 3 * HOUR, text: "postgresql upgraded 15.4 → 15.6" },
          { at: NOW - 400 * HOUR, text: "an old change" },
        ],
      },
      { serverId: "s2", name: "web01", status: "never", problems: [], changes: [] },
    ],
  },
  infraEdges: [
    { id: "e1", from: "web01", to: "db01", relation: "depends_on", label: "reads orders", updatedAt: 1 },
    { id: "e2", from: "web01", to: "cache01", relation: "routes_to", proposed: true, evidence: "saw a connection to 6379", updatedAt: 1 },
  ],
  workTickets: [
    { id: "t1", title: "Grow /data", status: "todo", target: "db01", assigneeName: "Watch", createdBy: "jacob", createdAt: 1, updatedAt: 2 },
    { id: "t2", title: "Old one", status: "done", createdBy: "jacob", createdAt: 1, updatedAt: 1 },
  ],
} as unknown as HubSnapshot;

function ctx(overrides: Partial<Parameters<typeof callMcpTool>[2]> = {}, replies: Partial<Record<string, unknown>> = {}) {
  const sent: HubRequest[] = [];
  const request = vi.fn(async (r: HubRequest) => {
    sent.push(r);
    if (r.action === "snapshot") return SNAP;
    if (r.action in replies) return { ...SNAP, reply: replies[r.action] } as HubSnapshot;
    return SNAP;
  });
  return { sent, request, ctx: { request, scopes: ["read"], actor: "Jacob", ...overrides } as Parameters<typeof callMcpTool>[2] };
}

describe("the tools somebody's own agent gets over MCP", () => {
  it("offers only what the key may use, and refuses the rest in words it can act on", async () => {
    expect(toolsForScopes(["read"]).map((t) => t.name)).toEqual([
      "list_servers",
      "server_facts",
      "recent_changes",
      "dependency_map",
      "kb_search",
      "kb_read_page",
      "tickets_list",
    ]);
    expect(toolsForScopes(["read", "tickets"]).map((t) => t.name)).toContain("ticket_create");
    const { ctx: c } = ctx();
    await expect(callMcpTool("ticket_create", { title: "x" }, c)).rejects.toThrow(/may not use ticket_create/);
    await expect(callMcpTool("rm_rf", {}, c)).rejects.toThrow(/No tool called rm_rf/);
    // Every tool says what it is for and whether it only looks.
    expect(MCP_TOOLS.every((t) => t.description.length > 80 && t.inputSchema.additionalProperties === false)).toBe(true);
    // Every tool that only looks is a reading tool, except the one that asks what became of
    // a command: that belongs to the key that asked for it.
    expect(MCP_TOOLS.filter((t) => t.readOnly && t.name !== "command_status").map((t) => t.scope)).toEqual(Array(7).fill("read"));
    expect(toolsForScopes(["read"]).map((t) => t.name)).not.toContain("command_status");
  });

  it("lists the servers and what was read from one of them", async () => {
    const { ctx: c, request } = ctx(
      {},
      { "server-facts-read": { serverFacts: { serverId: "s1", facts: { listening: [{ proto: "tcp", port: 5432, process: "postgres" }], failedServices: ["backup.service"], certs: [] }, changes: [] } } },
    );
    const list = (await callMcpTool("list_servers", {}, c)) as { servers: Array<{ name: string }>; clusters: string[] };
    expect(list.servers.map((s) => s.name)).toEqual(["db01", "web01"]);
    expect(list.clusters).toEqual(["DB-Prod", "Web"]);
    expect((await callMcpTool("list_servers", { cluster: "db-prod" }, c) as { servers: unknown[] }).servers).toHaveLength(1);

    const facts = (await callMcpTool("server_facts", { server: "db01" }, c)) as Record<string, unknown>;
    expect(facts).toMatchObject({ server: "db01", read: true, os: "Debian 12", problems: ["/ is 91% full"] });
    expect(facts.listening).toEqual([{ proto: "tcp", port: 5432, process: "postgres" }]);
    expect(request).toHaveBeenCalledWith({ action: "server-facts-read", serverId: "s1" });
    // A server that has never been read says so instead of pretending.
    expect(await callMcpTool("server_facts", { server: "web01" }, c)).toMatchObject({ read: false });
    await expect(callMcpTool("server_facts", { server: "nope" }, c)).rejects.toThrow(/No server called "nope"/);
  });

  it("gives what changed within the window, newest first, and says when there is nothing", async () => {
    const { ctx: c } = ctx();
    const recent = (await callMcpTool("recent_changes", { hours: 24 }, c)) as { changes: Array<{ what: string }>; note?: string };
    expect(recent.changes.map((x) => x.what)).toEqual(["postgresql upgraded 15.4 → 15.6"]);
    const nothing = (await callMcpTool("recent_changes", { server: "web01", hours: 1 }, c)) as { note?: string };
    expect(nothing.note).toContain("Nothing was seen to change");
  });

  it("marks a dependency nobody has confirmed as not confirmed", async () => {
    const { ctx: c } = ctx();
    const map = (await callMcpTool("dependency_map", { server: "web01" }, c)) as { links: Array<Record<string, unknown>> };
    expect(map.links).toHaveLength(2);
    expect(map.links[0]).toMatchObject({ from: "web01", to: "db01", relation: "depends_on", confirmed: true });
    expect(map.links[1].note).toContain("saw a connection to 6379");
  });

  it("searches the knowledge base and reads a page, warning about lines nothing backs", async () => {
    const { ctx: c } = ctx(
      {},
      {
        "kb-search": { kbSearch: { query: "disk full", byMeaning: false, hits: [{ pageId: "p1", docId: "p1", title: "A disk fills up", collection: "troubleshooting", heading: "When a disk is full", snippet: "Grow the quota." }, { docId: "d1", title: "Vendor manual", snippet: "Chapter 4." }] } },
        "kb-page-read": {
          kbPage: {
            id: "p1",
            kind: "troubleshooting",
            title: "A disk fills up",
            when: "When a disk is full",
            body: "Grow it.",
            targets: ["db01"],
            sources: [{ docId: "d1", title: "Vendor manual" }],
            revision: 1,
            createdAt: 1,
            updatedAt: NOW - 2 * HOUR,
            updatedBy: "assistant",
            history: [],
            unverified: { commands: ["zpool destroy tank"], citations: [] },
          },
        },
      },
    );
    const found = (await callMcpTool("kb_search", { query: "disk full" }, c)) as { pages: Array<{ page: string }>; sources: unknown[] };
    expect(found.pages[0].page).toBe("p1");
    expect(found.sources).toHaveLength(1);
    const read = (await callMcpTool("kb_read_page", { page: "p1" }, c)) as Record<string, unknown>;
    expect(read).toMatchObject({ page: "p1", restsOn: ["Vendor manual"] });
    expect(read.note).toContain("in none of the sources");
    await expect(callMcpTool("kb_search", { query: " " }, c)).rejects.toThrow(/needs a query/);
  });

  it("says plainly when the team has nothing written about something", async () => {
    const { ctx: c } = ctx({}, { "kb-search": { kbSearch: { query: "x", byMeaning: false, hits: [] } } });
    expect((await callMcpTool("kb_search", { query: "ceph key rotation" }, c)) as { nothingFound?: string }).toMatchObject({
      nothingFound: expect.stringContaining("rather than present a guess"),
    });
  });

  it("writes a ticket into the backlog, says where it came from, and starts nothing", async () => {
    const made = { id: "t3", title: "Grow /data on db01", status: "backlog", createdBy: "x", createdAt: 9, updatedAt: 9 };
    const sent: HubRequest[] = [];
    const request = vi.fn(async (r: HubRequest) => {
      sent.push(r);
      if (r.action === "ticket-save") return { ...SNAP, workTickets: [...(SNAP.workTickets ?? []), made] } as HubSnapshot;
      return SNAP;
    });
    const c = { request, scopes: ["read", "tickets"], actor: "Jacob" } as Parameters<typeof callMcpTool>[2];
    const out = (await callMcpTool("ticket_create", { title: "Grow /data on db01", description: "It is 91% full.", target: "db01" }, c)) as Record<string, unknown>;
    expect(out).toMatchObject({ ticket: "t3", status: "backlog" });
    expect(String(out.note)).toContain("nothing starts by itself");
    const saved = sent.find((r) => r.action === "ticket-save") as { ticket: { status: string; description: string } };
    expect(saved.ticket.status).toBe("backlog");
    expect(saved.ticket.description).toContain("Written from outside sshs3 by Jacob's agent");
    // Nothing was started.
    expect(sent.some((r) => r.action === "ticket-start" || r.action === "start")).toBe(false);
    await expect(callMcpTool("ticket_create", { title: " " }, c)).rejects.toThrow(/needs a title/);
  });

  it("adds a comment only to a ticket that exists, and signs it", async () => {
    const sent: HubRequest[] = [];
    const request = vi.fn(async (r: HubRequest) => {
      sent.push(r);
      return SNAP;
    });
    const c = { request, scopes: ["read", "tickets"], actor: "Jacob" } as Parameters<typeof callMcpTool>[2];
    await expect(callMcpTool("ticket_update", { ticket: "nope", comment: "hi" }, c)).rejects.toThrow(/No ticket nope/);
    await callMcpTool("ticket_update", { ticket: "t1", comment: "The quota is the cause." }, c);
    const comment = sent.find((r) => r.action === "ticket-comment") as { text: string };
    expect(comment.text).toContain("The quota is the cause.");
    expect(comment.text).toContain("Jacob's agent");
  });

  it("lists the board and filters it", async () => {
    const { ctx: c } = ctx();
    const all = (await callMcpTool("tickets_list", {}, c)) as { tickets: Array<{ ticket: string }> };
    expect(all.tickets.map((t) => t.ticket)).toEqual(["t1", "t2"]);
    expect(((await callMcpTool("tickets_list", { status: "todo" }, c)) as { tickets: unknown[] }).tickets).toHaveLength(1);
    expect(((await callMcpTool("tickets_list", { target: "DB01" }, c)) as { tickets: unknown[] }).tickets).toHaveLength(1);
  });
});
