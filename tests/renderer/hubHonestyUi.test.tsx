// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubSnapshot } from "../../src/shared/types/aiHub";
import { AgentsAndMcpView } from "../../src/renderer/src/components/AiHub/AgentsAndMcpView";
import { Settings } from "../../src/renderer/src/components/AiHub/SettingsView";
import { WorkforceView } from "../../src/renderer/src/components/AiHub/WorkforceView";
import { ServerFactsCard } from "../../src/renderer/src/components/AiHub/ServerFactsCard";
import { InfrastructureView } from "../../src/renderer/src/components/AiHub/InfrastructureView";
import { KnowledgeBaseView } from "../../src/renderer/src/components/AiHub/KnowledgeBaseView";
import { isLocalOrPrivateUrl, WebAuthGate } from "../../src/renderer/src/components/WebAuthGate";

let mockWebMode = false;
vi.mock("../../src/renderer/src/lib/webClientBridge", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  isWebBrowserMode: () => mockWebMode,
  ensureWebClientBridgeInstalled: () => undefined,
  connectWebClientBridge: () => undefined,
  disconnectWebClientBridge: () => undefined,
  getStoredWebSessionToken: () => "tok-test",
  setStoredWebSessionToken: () => undefined,
  onWebConnectionStateChange: () => () => undefined,
}));

afterEach(() => {
  cleanup();
  mockWebMode = false;
  vi.restoreAllMocks();
});

const baseHub = (extra: Partial<HubSnapshot> = {}): HubSnapshot =>
  ({
    config: { provider: "openai-codex", model: "default", enabled: true },
    preferences: { background: false, autoStart: false, inventory: false, retentionDays: 30 },
    runtime: { bundled: false },
    sessions: [],
    tasks: [],
    agents: [],
    mcpServers: [],
    inventory: [],
    workspaceServers: [],
    kbDocuments: [],
    kbPages: [],
    memories: [],
    workTickets: [],
    workGoals: [],
    ...extra,
  }) as unknown as HubSnapshot;

describe("Milestone 2 UI honesty and clarity fixes", () => {
  it("labels demo MCP servers neutrally and shows inline feedback after testing", async () => {
    const act = vi.fn(async () =>
      baseHub({
        reply: {
          notes: [
            "NetApp Harvest & ActiveIQ MCP is a demo server. Its 4 tool(s) are simulated locally and not connected to a real network.",
          ],
        },
      }),
    );

    render(
      <AgentsAndMcpView
        hub={baseHub({
          demoMode: true,
          mcpServers: [
            {
              id: "demo-mcp-netapp-harvest",
              name: "NetApp Harvest & ActiveIQ MCP",
              transport: "http",
              url: "http://10.30.10.25:8890/mcp",
              enabled: true,
              status: "connected",
              demo: true,
              lastTestedAt: Date.now() - 60_000,
              discoveredTools: [{ name: "harvest_clusters", description: "List clusters", readOnly: true }],
            },
          ],
        })}
        act={act}
        selectedAgentId=""
        onSelectAgentForChat={() => {}}
        onStartedMission={() => {}}
      />,
    );

    const card = screen.getByTestId("mcp-server-demo-mcp-netapp-harvest");
    const badge = within(card).getByTestId("mcp-demo-badge-demo-mcp-netapp-harvest");
    expect(badge).toHaveTextContent("Demo (simulated)");
    expect(badge).not.toHaveClass("ai-badge-success");
    expect(within(card).getByTestId("mcp-demo-note-demo-mcp-netapp-harvest")).toHaveTextContent(
      /Simulated demo server/,
    );
    expect(within(card).getByTestId("mcp-counts-demo-mcp-netapp-harvest")).toHaveTextContent(/Tested/);

    fireEvent.click(within(card).getByRole("button", { name: "Test" }));
    await waitFor(() =>
      expect(within(card).getByTestId("mcp-test-status-demo-mcp-netapp-harvest")).toHaveTextContent(
        /simulated locally/,
      ),
    );
  });

  it("shows inline status for Restore built-ins and exposes MCP endpoint and instructions in web mode Settings", async () => {
    mockWebMode = true;
    const act = vi.fn(async () =>
      baseHub({
        reply: { notes: ["Restored 2 built-in item(s)."] },
      }),
    );

    render(<Settings hub={baseHub()} act={act} />);

    const webMcp = screen.getByTestId("web-mcp");
    expect(within(webMcp).getByTestId("mcp-endpoint-url")).toHaveTextContent("/api/mcp");
    expect(within(webMcp).getByTestId("mcp-connection-info")).toHaveTextContent(/Claude Code/);
    expect(within(webMcp).getByTestId("mcp-connection-info")).toHaveTextContent(/Cursor/);
    expect(screen.queryByTestId("local-mcp")).not.toBeInTheDocument();

    // McpKeysPanel inputs inside SettingsView must not use HTML required attributes that block Save settings.
    const keyNameInput = within(webMcp).getByLabelText("What the key is for");
    expect(keyNameInput).not.toHaveAttribute("required");
    expect(keyNameInput).toHaveAttribute("aria-required", "true");
    fireEvent.click(within(webMcp).getByRole("checkbox", { name: /Run commands on one server/ }));
    const serverIdInput = within(webMcp).getByLabelText("The one server it may run on");
    expect(serverIdInput).not.toHaveAttribute("required");
    expect(serverIdInput).toHaveAttribute("aria-required", "true");
    const form = webMcp.closest("form")!;
    expect(form.checkValidity()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith(expect.objectContaining({ action: "configure" })));

    fireEvent.click(screen.getByRole("button", { name: "Restore built-in agents, runbooks and skills" }));
    expect(await screen.findByTestId("restore-builtins-status")).toHaveTextContent("Restored 2 built-in item(s).");
  });

  it("renders clean KB page references on alert tickets and clarifies web-server board sharing", () => {
    mockWebMode = true;
    const opened: unknown[] = [];
    const listener = (ev: Event) => opened.push((ev as CustomEvent).detail);
    window.addEventListener("sshs3:ai-open", listener);

    try {
      render(
        <WorkforceView
          hub={baseHub({
            kbPages: [
              {
                id: "p-local",
                kind: "troubleshooting",
                title: "Local keyword-matched page",
                when: "When disk fills",
                targets: [],
                keys: [],
                body: "",
                sources: [],
                history: [],
                revision: 1,
                createdAt: 1,
                updatedAt: 1,
                updatedBy: "tester",
              },
            ],
            workTickets: [
              {
                id: "k1",
                title: "Alert (critical): pg-wal-full",
                description: "The alert fired for pg-01.",
                status: "todo",
                createdAt: 1,
                updatedAt: 2,
                kbPages: [
                  { id: "p-wal", title: "PostgreSQL: the data disk fills up", known: true },
                  { id: "p-local", title: "Local keyword-matched page", known: false },
                  { id: "p-gone", title: "Archived guide", known: false },
                ],
              } as NonNullable<HubSnapshot["workTickets"]>[number],
            ],
          })}
          act={vi.fn(async () => undefined)}
          onOpenTask={() => {}}
          openTicketId="k1"
        />,
      );

      expect(screen.getByText(/Board is personal to your account/)).toBeVisible();
      const kbBox = screen.getByTestId("ticket-kb-pages");
      expect(kbBox).not.toHaveTextContent("sshs3_kb_search");
      expect(within(kbBox).getByTestId("ticket-kb-page-p-gone")).toHaveTextContent("Archived guide (not in local KB)");
      expect(within(kbBox).getByTestId("ticket-kb-page-p-local")).toHaveTextContent("Local keyword-matched page");
      expect(within(kbBox).getByTestId("ticket-kb-page-p-local")).not.toHaveTextContent("(not in local KB)");

      fireEvent.click(within(kbBox).getByTestId("ticket-kb-page-p-wal"));
      expect(opened).toContainEqual({ view: "Knowledge Base", mode: "hub", kbTab: "pages", pageId: "p-wal" });

      fireEvent.click(within(kbBox).getByTestId("ticket-kb-page-p-local"));
      expect(opened).toContainEqual({ view: "Knowledge Base", mode: "hub", kbTab: "pages", pageId: "p-local" });
    } finally {
      window.removeEventListener("sshs3:ai-open", listener);
    }
  });

  it("opens the requested KB page when KnowledgeBaseView receives openTab with pageId", async () => {
    const page = {
      id: "p-wal",
      kind: "troubleshooting" as const,
      title: "PostgreSQL: the data disk fills up",
      when: "When pg_wal fills",
      targets: ["pg-01"],
      keys: ["pg_wal"],
      body: "Check archive_command status.",
      sources: [],
      history: [],
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      updatedBy: "tester",
    };
    const request = vi.fn(async (req: { action: string; id?: string }) =>
      req.action === "kb-page-read" && req.id === "p-wal"
        ? baseHub({ kbPages: [page], reply: { kbPage: page } as never })
        : baseHub({ kbPages: [page] }),
    );
    render(
      <KnowledgeBaseView
        hub={baseHub({ kbPages: [page] })}
        act={vi.fn(async () => undefined)}
        request={request}
        onAttachDoc={() => {}}
        openTab={{ tab: "pages", pageId: "p-wal", seq: 1 }}
      />,
    );
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: "kb-page-read", id: "p-wal" }));
    expect(await screen.findByText("Check archive_command status.")).toBeVisible();
  });

  it("labels demo server facts clearly and styles demo/proxy infrastructure targets neutrally", () => {
    render(
      <>
        <ServerFactsCard
          hub={baseHub({
            demoMode: true,
            serverFacts: {
              enabled: true,
              intervalHours: 6,
              exclude: [],
              watchPaths: [],
              collecting: [],
              servers: [
                {
                  serverId: "demo-pg-01",
                  name: "pg-01",
                  status: "ok",
                  via: "demo",
                  demo: true,
                  collectedAt: Date.now() - 60_000,
                  os: "Debian 12",
                  packages: 420,
                  services: 32,
                  listening: 6,
                  problems: [],
                  changes: [],
                },
              ],
            },
          })}
          act={vi.fn(async () => undefined)}
        />
        <InfrastructureView
          hub={baseHub({
            workspaceServers: [
              { id: "demo-pg-01", name: "pg-01", host: "10.0.0.10", port: 22, username: "ops", shared: true },
              { id: "srv-jump", name: "db-private", host: "10.0.0.20", port: 22, username: "ops", shared: true },
              { id: "srv-down", name: "web-down", host: "10.0.0.30", port: 22, username: "ops", shared: true },
            ],
            inventory: [
              {
                id: "demo-pg-01",
                kind: "ssh",
                label: "pg-01",
                address: "10.0.0.10:22",
                status: "blocked",
                reasonKind: "demo",
                detail: "A server of the demo lab: there is no real address to check.",
                observedAt: 1000,
              },
              {
                id: "srv-jump",
                kind: "ssh",
                label: "db-private",
                address: "10.0.0.20:22",
                status: "blocked",
                reasonKind: "proxy",
                detail: "Reachable only through a configured proxy; not probed directly.",
                observedAt: 1000,
              },
              {
                id: "srv-down",
                kind: "ssh",
                label: "web-down",
                address: "10.0.0.30:22",
                status: "unreachable",
                detail: "Connection refused",
                observedAt: 1000,
              },
            ],
          })}
          act={vi.fn(async () => undefined)}
          busy={false}
          onAsk={() => {}}
          onUseTerminal={() => {}}
        />
      </>,
    );

    expect(screen.getByTestId("facts-demo-badge")).toHaveTextContent("Demo lab (simulated)");
    expect(screen.getByTestId("facts-demo-note")).toHaveTextContent(/Simulated demo readings/);
    expect(screen.getByTestId("facts-demo-demo-pg-01")).toHaveTextContent("Demo (simulated)");

    const demoRow = screen.getByTestId("infra-server-demo-pg-01");
    expect(within(demoRow).getByTestId("infra-status-demo-pg-01")).toHaveTextContent("demo (not probed)");
    expect(within(demoRow).getByTestId("infra-status-demo-pg-01")).not.toHaveClass("ai-badge-danger");
    expect(within(demoRow).getByRole("button", { name: "Ask about it" })).toBeVisible();

    const jumpRow = screen.getByTestId("infra-server-srv-jump");
    expect(within(jumpRow).getByTestId("infra-status-srv-jump")).toHaveTextContent("via jump host");
    expect(within(jumpRow).getByTestId("infra-status-srv-jump")).not.toHaveClass("ai-badge-danger");
    expect(within(jumpRow).getByRole("button", { name: "Ask about it" })).toBeVisible();

    const downRow = screen.getByTestId("infra-server-srv-down");
    expect(within(downRow).getByTestId("infra-status-srv-down")).toHaveClass("ai-badge-danger");
    expect(within(downRow).getByRole("button", { name: "Investigate" })).toBeVisible();
  });

  it("warns on local invite addresses and lets admins override or prefill SSHS3_PUBLIC_URL", async () => {
    mockWebMode = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/status") {
        return new Response(
          JSON.stringify({
            initialized: true,
            authenticated: true,
            user: {
              id: "u1",
              username: "admin",
              displayName: "Admin",
              role: "admin",
              createdAt: 1,
              sshPublicKey: "ssh-ed25519 AAAA test",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/admin/users") {
        return new Response(JSON.stringify({ users: [] }), { status: 200 });
      }
      if (url === "/api/admin/invites" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            invite: {
              token: "inv-abc",
              role: "member",
              createdBy: "admin",
              createdAt: 1,
              expiresAt: 2,
              maxUses: 5,
              uses: 0,
            },
          }),
          { status: 200 },
        );
      }
      if (url === "/api/admin/invites") {
        return new Response(JSON.stringify({ invites: [] }), { status: 200 });
      }
      if (url === "/api/mcp-keys") {
        return new Response(JSON.stringify({ keys: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WebAuthGate>
        <div>workspace-child</div>
      </WebAuthGate>,
    );

    await screen.findByText("workspace-child");
    fireEvent.click(screen.getByRole("button", { name: /Invite \/ team/ }));

    expect(await screen.findByTestId("invite-local-warning")).toHaveTextContent(/local or private/);
    const baseInput = screen.getByTestId("invite-base-url");
    const createInviteBtn = screen.getByRole("button", { name: "Create and copy invite link" });

    // Invalid or empty URL shows an inline validation error and disables invite creation.
    fireEvent.change(baseInput, { target: { value: "not-a-url" } });
    expect(screen.getByTestId("invite-base-url-error")).toBeVisible();
    expect(createInviteBtn).toBeDisabled();

    fireEvent.change(baseInput, { target: { value: "" } });
    expect(screen.getByTestId("invite-base-url-error")).toBeVisible();
    expect(createInviteBtn).toBeDisabled();

    fireEvent.change(baseInput, { target: { value: "https://ops.example.com/" } });
    expect(screen.queryByTestId("invite-local-warning")).not.toBeInTheDocument();
    expect(screen.queryByTestId("invite-base-url-error")).not.toBeInTheDocument();
    expect(createInviteBtn).toBeEnabled();

    // Clipboard failure reports an honest status instead of claiming the invite link was copied.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("Clipboard denied")) },
      configurable: true,
    });
    fireEvent.click(createInviteBtn);
    expect(await screen.findByText("https://ops.example.com/?invite=inv-abc")).toBeVisible();
    expect(screen.getByTestId("invite-copy-error")).toHaveTextContent(/Could not copy automatically/);
    expect(screen.queryByText(/copied to the clipboard/)).not.toBeInTheDocument();
  });

  it("detects IPv6 ULA/link-local and schemeless local/private hosts in isLocalOrPrivateUrl", () => {
    expect(isLocalOrPrivateUrl("http://[fd12:3456::1]:8810")).toBe(true);
    expect(isLocalOrPrivateUrl("http://[fc00::1]")).toBe(true);
    expect(isLocalOrPrivateUrl("http://[fe80::1]")).toBe(true);
    expect(isLocalOrPrivateUrl("fd00::1")).toBe(true);
    expect(isLocalOrPrivateUrl("fe80::1")).toBe(true);
    expect(isLocalOrPrivateUrl("localhost:8810")).toBe(true);
    expect(isLocalOrPrivateUrl("192.168.1.50")).toBe(true);
    expect(isLocalOrPrivateUrl("https://[2001:db8::1]")).toBe(false);
    expect(isLocalOrPrivateUrl("https://ops.example.com")).toBe(false);
  });
});
