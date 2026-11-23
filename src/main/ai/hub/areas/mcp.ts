import crypto from "node:crypto";
import type { AgentChange, HubReply, AgentTask, McpServerConfig, McpToolPolicy } from "../../../../shared/types/aiHub";
import { guardUrl, type GuardedTarget } from "../Notifier";
import { deleteDemoMcpServer, getDemoMcpServers, isDemoMode, mcpCatalog, saveDemoMcpServer } from "../demoWorkspace";
import { DEMO_MCP_REFUSAL, isDemoTarget } from "../../../demo/demoMode";
import { LocalMcpServer } from "../LocalMcpServer";
import { McpTokenStore } from "../../../web/McpTokenStore";
import { clip, safeError } from "../privacy";
import { keepSecrets, requiredText } from "../hubHelpers";
import type { HubService } from "../HubService";
import type { Handled, RequestsOf } from "./routes";

/**
 * MCP: the servers agents may call, and this app as an MCP server for somebody's own agent.
 *
 * Adding, testing and removing MCP servers and what each of their tools may do; the keys an outside
 * client connects with; and a command an outside client asks to have run.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
export class McpPart {
  /**
   * The MCP servers as they may leave the hub (to the interface, to a model):
   * with the names of their environment variables and headers, and no values.
   * An empty value means "set, not shown".
   */
  mcpServersShown(this: HubService): McpServerConfig[] {
    const names = (values?: Record<string, string>): Record<string, string> | undefined =>
      values && Object.keys(values).length ? Object.fromEntries(Object.keys(values).map((k) => [k, ""])) : undefined;
    return this.getMcpServersList().map((s) => ({
      ...s,
      env: names(s.env),
      headers: names(s.headers),
      ...(isDemoTarget(s.id) ? { demo: true } : {}),
    }));
  }

  getMcpServersList(this: HubService): McpServerConfig[] {
    const stored = this.store.data.mcpServers ?? [];
    if (!isDemoMode()) return stored;
    const dismissed = new Set(this.store.data.preferences.dismissedBuiltinIds ?? []);
    return [
      ...stored,
      ...getDemoMcpServers().filter(
        (dm) => !dismissed.has(dm.id) && !stored.some((m) => m.id === dm.id),
      ),
    ];
  }

  /**
   * A stdio MCP server is a program started on this machine as the app's own account. On a shared
   * server that account holds every user's keys and sign-ins, so only an administrator adds or starts one.
   */
  assertMcpProgramAllowed(this: HubService, server: Pick<McpServerConfig, "transport">): void {
    if (server.transport !== "http" && this.sharedServer() && !this.host.teamAdmin?.())
      throw new Error("An MCP server that runs as a program runs on the shared server itself. Only an administrator of this server adds or starts one. Use one with an address (HTTP) instead.");
  }

  /** Asked each time an MCP server is about to be started or called: see McpClientManager. */
  async assertMcpReach(this: HubService, server: McpServerConfig): Promise<GuardedTarget | void> {
    // The last line of defence for the demo: whatever path led here, nothing is started and nothing is called.
    if (isDemoMode()) throw new Error(DEMO_MCP_REFUSAL);
    this.assertMcpProgramAllowed(server);
    if (server.transport !== "http") return;
    const url = server.url?.trim();
    if (!url) return;
    // The person's own machine may talk to a plain-http server on its own network; a shared server may not be sent anywhere.
    // The address checked is the one connected to (McpClientManager pins it).
    return await guardUrl(url, { ...this.outboundGuard(), allowPlainHttp: !this.sharedServer(), ...(this.kbNetwork ? { lookup: this.kbNetwork.lookup } : {}) });
  }

  /**
   * A command asked for from outside sshs3, over MCP.
   *
   * The fence is in what this will not do. It runs on the one server the key
   * names and nowhere else, in a terminal that is already open for that
   * server — never "whichever terminal happens to be open", which is what the
   * ordinary path falls back to. It is always assisted: the change waits in
   * the inbox until a person approves it, in every mode, whatever the safety
   * policy says, because nobody is watching the agent that asked. And it
   * returns at once with the id of what is waiting; the agent asks again for
   * the outcome instead of holding a connection open.
   */
  async runForMcp(this: HubService, input: {
    serverId: string;
    command: string;
    description: string;
    by: string;
    check?: { command: string; expected: string };
    rollback?: string;
  }): Promise<{ changeId: string; taskId: string; status: AgentChange["status"] }> {
    if (isDemoMode()) throw new Error("This is the demo lab; nothing is run on a real server here.");
    const command = requiredText(input.command);
    const wanted = requiredText(input.serverId).toLowerCase();
    const server = this.getKnownServers().find((s) => s.id.toLowerCase() === wanted || s.name.toLowerCase() === wanted);
    if (!server) throw new Error(`No server called "${input.serverId}" in this workspace.`);
    // The one terminal of that server. Not any other, and not a new one: a command from
    // outside does not get to open a connection nobody asked for.
    const session = this.terminals
      .list()
      .find((t) => t.state !== "disconnected" && (t.profileId === server.id || t.label.toLowerCase() === server.name.toLowerCase()));
    if (!session)
      throw new Error(
        `Nothing is connected to ${server.name} in sshs3 right now. A command from outside runs in the terminal that is already open for that server; open one and ask again.`,
      );
    const task: AgentTask = {
      id: `mcp-${crypto.randomUUID()}`,
      title: clip(`From outside: ${input.description || command}`, 120),
      agentName: `${input.by}'s agent, through MCP`,
      // Assisted, whatever anything else says: a person approves every one of these.
      mode: "assisted",
      status: "running",
      // Nobody here is watching whoever asked: every command of this run is put to a person.
      fromOutside: true,
      target: { sessionId: session.id, generation: session.generation, label: session.label },
      messages: [{ id: crypto.randomUUID(), role: "user", text: clip(input.description || command, 2000), at: Date.now() }],
      changes: [],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 1,
      maxMinutes: 30,
      verification: "not-verified",
    };
    this.store.data.tasks.push(task);
    const capability = await this.broker.issue(task);
    const request = input.check?.command
      ? {
          action: "change" as const,
          command,
          description: input.description || command,
          check: input.check,
          rollback: input.rollback ?? "",
          observeSeconds: 0,
          id: session.id,
        }
      : { action: "command" as const, command, description: input.description || command, id: session.id };
    // Not awaited: the answer is "it is waiting", and the agent asks again.
    let settled: { error?: unknown } | undefined;
    const running = this.broker
      .invoke(capability.key, request as never)
      .then(() => {
        // Done is not the same as worked: a change that failed its check, or was taken back, did not.
        task.status = task.changes[0]?.status === "completed" ? "completed" : "failed";
        settled = {};
      })
      .catch((error) => {
        task.status = "failed";
        task.error = safeError(error);
        settled = { error };
      })
      .finally(() => {
        task.updatedAt = Date.now();
        this.broker.revoke(task.id);
        // The terminal is the person's again: a command from outside holds it only while it runs.
        this.terminals.release(task.id);
        this.changed();
      });
    // The change the broker made for it, once it exists: getting the terminal ready can take a while.
    const until = Date.now() + 20_000;
    while (task.changes.length === 0 && !settled && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    const change = task.changes[0];
    if (!change) {
      if (settled?.error) throw settled.error instanceof Error ? settled.error : new Error(String(settled.error));
      // Still not ready after this long: it is called off, so that asking again does not leave two behind.
      this.broker.revoke(task.id);
      await running;
      throw new Error("The terminal did not get ready in time. Nothing has run; ask again in a moment.");
    }
    this.changed();
    return { changeId: change.id, taskId: task.id, status: change.status };
  }

  /** What became of a command asked for over MCP. */
  mcpCommandStatus(this: HubService, changeId: string): { status: AgentChange["status"]; output?: string; exitCode?: number; check?: AgentChange["check"]; rollback?: AgentChange["rollback"]; target: string } | undefined {
    for (const task of this.store.data.tasks) {
      if (!task.id.startsWith("mcp-")) continue;
      const change = task.changes.find((c) => c.id === changeId);
      if (change)
        return {
          status: change.status,
          output: change.output,
          exitCode: change.exitCode,
          check: change.check,
          rollback: change.rollback,
          target: change.target,
        };
    }
    return undefined;
  }

  /** This installation's own MCP keys, kept beside the hub's other data. */
  mcpTokens(this: HubService): McpTokenStore {
    this.mcpTokenStore ??= new McpTokenStore(this.directory);
    return this.mcpTokenStore;
  }

  /**
   * Starts or stops the listener that lets this person's own agent reach this
   * app. It is off until they switch it on, and it listens on 127.0.0.1 only.
   */
  async applyLocalMcp(this: HubService): Promise<void> {
    const want = this.store.data.preferences.localMcp;
    this.localMcpError = undefined;
    if (!want?.enabled) {
      await this.localMcp?.stop();
      return;
    }
    await this.mcpTokens().initialize();
    this.localMcp ??= new LocalMcpServer({
      tokens: this.mcpTokens(),
      hubFor: async () => ({
        request: (r) => this.request(r),
        actor: await this.resolveActorName(),
        runCommand: (input) => this.runForMcp({ ...input, by: "your agent" }),
        commandStatus: (id) => this.mcpCommandStatus(id),
        audit: (entry) => this.audit().append(entry),
      }),
    });
    try {
      await this.localMcp.set(true, want.port ?? 0);
    } catch (error) {
      this.localMcpError = safeError(error);
    }
  }

  /** What the settings screen shows about the local listener. */
  localMcpView(this: HubService): { enabled: boolean; address?: string; keys: unknown[]; error?: string } {
    return {
      enabled: Boolean(this.store.data.preferences.localMcp?.enabled),
      address: this.localMcp?.address(),
      keys: this.mcpTokenStore?.list("local") ?? [],
      error: this.localMcpError,
    };
  }
  /** The requests this part answers. What a case leaves in `reply` goes back with the snapshot. */
  async handleMcp(this: HubService, request: RequestsOf<"mcp">): Promise<Handled> {
    let reply: HubReply | undefined;
    switch (request.action) {
      case "mcp-install-preset": {
        // The demo's presets were once called preset-mcp-…: that spelling still finds them.
        const wanted = isDemoMode() ? request.presetId.replace(/^preset-mcp-/, "demo-mcp-") : request.presetId;
        const preset = mcpCatalog().find(
          (p) =>
            p.id === wanted ||
            p.name.toLowerCase() === request.presetId.toLowerCase(),
        );
        if (!preset) throw new Error(`MCP preset "${request.presetId}" not found`);
        // In the demo lab a preset is a scripted fixture: nothing is started for it.
        if (!isDemoMode()) this.assertMcpProgramAllowed(preset);
        // Its id is what makes it simulated. One without a demo id would be refused at every use, so it is not added.
        else if (!isDemoTarget(preset.id)) throw new Error(DEMO_MCP_REFUSAL);
        const installed: McpServerConfig = {
          id: preset.id,
          name: preset.name,
          transport: preset.transport,
          command: preset.command,
          args: preset.args,
          url: preset.url,
          enabled: true,
          status: "unknown",
          discoveredTools: [],
          updatedAt: Date.now(),
        };
        if (isDemoMode()) {
          // The demo lab's servers are scripted; there is nothing to start.
          installed.status = "connected";
          installed.lastTestedAt = Date.now();
          installed.discoveredTools = preset.defaultTools;
        } else if (!preset.needs) {
          // Connected, and its tools, are what the server itself answered.
          const result = await this.mcp.testAndDiscover(installed);
          installed.status = result.ok ? "connected" : "error";
          installed.lastError = result.error;
          installed.lastTestedAt = Date.now();
          installed.discoveredTools = result.tools;
        }
        this.store.data.mcpServers = [
          ...(this.store.data.mcpServers ?? []).filter((x) => x.id !== installed.id),
          installed,
        ];
        if (isDemoMode()) saveDemoMcpServer(installed);
        break;
      }
      case "mcp-save": {
        const s = request.server;
        const id = s.id?.trim() || crypto.randomUUID();
        const existing = this.getMcpServersList().find((x) => x.id === id);
        const saved: McpServerConfig = {
          id,
          name: clip(requiredText(s.name), 120),
          transport: s.transport === "http" ? "http" : "stdio",
          command: s.command?.trim() || undefined,
          args: s.args?.map((x) => x.trim()).filter(Boolean),
          env: keepSecrets(existing?.env, s.env),
          url: s.url?.trim() || undefined,
          headers: keepSecrets(existing?.headers, s.headers),
          // Editing a server does not switch it back on.
          enabled: s.enabled ?? existing?.enabled ?? true,
          discoveredTools: s.discoveredTools ?? existing?.discoveredTools ?? [],
          status: existing?.status ?? "unknown",
          lastError: existing?.lastError,
          lastTestedAt: existing?.lastTestedAt,
          // What a person decided about this server's tools is kept over an edit: a tool that was
          // denied must not run again because the server's name or address was changed.
          toolPolicies: existing?.toolPolicies,
          trustReadOnlyHint: s.trustReadOnlyHint ?? existing?.trustReadOnlyHint,
          oauth: s.oauth ?? existing?.oauth,
        };
        this.assertMcpProgramAllowed(saved);
        const reach = (x: McpServerConfig): string =>
          JSON.stringify([x.transport, x.command, x.args ?? [], x.url]);
        if (existing && reach(existing) !== reach(saved)) {
          // It is a different server now: what the old one answered no longer holds, and neither does
          // trust in what it says about its own tools. A tool that was denied stays denied, and one
          // set to ask still asks. "Allow" was said about the old server's tool: a tool of the same
          // name on the new one is asked about again until a person allows it there.
          const allowed = Object.entries(saved.toolPolicies ?? {}).filter(([, policy]) => policy === "allow").map(([tool]) => tool);
          if (allowed.length) {
            saved.toolPolicies = Object.fromEntries(Object.entries(saved.toolPolicies ?? {}).filter(([, policy]) => policy !== "allow"));
            reply = { notes: [`${saved.name} now points somewhere else. ${allowed.length === 1 ? `The tool "${allowed[0]}" was set to Allow for the old server and is` : `${allowed.length} tools were set to Allow for the old server and are`} asked about again. Tools set to Ask or Deny stay as they were.`] };
          }
          saved.trustReadOnlyHint = s.trustReadOnlyHint ?? false;
          saved.discoveredTools = [];
          saved.status = "unknown";
          saved.lastError = undefined;
          saved.lastTestedAt = undefined;
        }
        this.store.data.mcpServers = [
          ...(this.store.data.mcpServers ?? []).filter((x) => x.id !== id),
          saved,
        ];
        if (isDemoMode()) saveDemoMcpServer(saved);
        break;
      }
      case "mcp-delete": {
        this.store.data.mcpServers = (this.store.data.mcpServers ?? []).filter(
          (s) => s.id !== request.id,
        );
        if (isDemoMode()) {
          this.markBuiltinDismissed(request.id, getDemoMcpServers());
          deleteDemoMcpServer(request.id);
        }
        break;
      }
      case "mcp-test": {
        const found = this.getMcpServersList().find((s) => s.id === request.id);
        if (!found) throw new Error("MCP server not found");
        const srv: McpServerConfig = { ...found };
        if (!srv.enabled) {
          srv.lastTestedAt = Date.now();
          reply = {
            notes: [`${srv.name} is turned off. Turn it on before testing.`],
          };
        } else if (isDemoTarget(srv.id)) {
          // A demo MCP fixture is scripted (simulateDemoMcpTool): there is no server to start or reach.
          srv.status = "connected";
          srv.demo = true;
          srv.lastError = undefined;
          srv.lastTestedAt = Date.now();
          const toolCount = srv.discoveredTools?.length ?? 0;
          reply = {
            notes: [
              `${srv.name} is a demo server. Its ${toolCount} tool${toolCount === 1 ? "" : "s"} are simulated locally and not connected to a real network.`,
            ],
          };
        } else if (isDemoMode()) {
          // Not one of the demo's own servers (a person typed it in): it is not tested, and its status says nothing new.
          reply = { notes: [`${srv.name} was not tested. ${DEMO_MCP_REFUSAL}`] };
        } else {
          const result = await this.mcp.testAndDiscover(srv);
          srv.status = result.ok ? "connected" : "error";
          srv.lastError = result.error;
          srv.lastTestedAt = Date.now();
          // What it answered, including an empty list: a server that no longer offers a tool
          // must not keep offering it here, and a name that cannot be resolved is not offered.
          if (result.ok) srv.discoveredTools = result.tools;
          const toolCount = srv.discoveredTools?.length ?? 0;
          const errDetail = result.error?.trim() || "connection failed";
          reply = {
            notes: [
              result.ok
                ? `Connected to ${srv.name}: found ${toolCount} tool${toolCount === 1 ? "" : "s"}.`
                : `Could not connect to ${srv.name}: ${errDetail}${/[.!?]$/.test(errDetail) ? "" : "."}`,
            ],
          };
        }
        this.store.data.mcpServers = [
          ...(this.store.data.mcpServers ?? []).filter((x) => x.id !== srv.id),
          srv,
        ];
        if (isDemoMode()) saveDemoMcpServer(srv);
        break;
      }
      case "mcp-key-list":
        await this.mcpTokens().initialize();
        break;
      case "mcp-key-create": {
        const made = await this.mcpTokens().create({
          userId: "local",
          name: requiredText(request.name),
          createdBy: await this.resolveActorName(),
          scopes: (request.scopes ?? []).filter((x): x is "read" | "tickets" | "run" => ["read", "tickets", "run"].includes(x)),
          serverId: request.serverId,
          expiresInDays: request.expiresInDays,
          // Never only when the request says so: the field for it, or 0 days, which is what "Never" in the settings sends.
          neverExpires: request.neverExpires === true || request.expiresInDays === 0,
          tools: request.tools,
        });
        // The only time the key itself leaves this process.
        reply = { mcpKey: { token: made.token, key: made.view } };
        break;
      }
      case "mcp-key-revoke":
        await this.mcpTokens().revoke("local", requiredText(request.id));
        break;
      case "mcp-local-set": {
        // The listener is a port on the machine sshs3 runs on. On a shared server that machine is not a member's to open ports on.
        if (request.enabled && this.sharedServer() && !this.host.teamAdmin?.())
          throw new Error("Only an administrator of this server switches on its local MCP listener. Outside agents reach your workspace through the server's own MCP address and a key from your account page.");
        const port = Math.max(0, Math.min(65535, request.port ?? this.store.data.preferences.localMcp?.port ?? 0));
        this.store.data.preferences.localMcp = { enabled: request.enabled, port };
        await this.applyLocalMcp();
        break;
      }
      case "mcp-tool-policy": {
        const policy: McpToolPolicy = request.policy;
        if (!["allow", "ask", "deny"].includes(policy)) {
          throw new Error("Invalid MCP tool policy");
        }
        const serverId = requiredText(request.serverId);
        const toolName = requiredText(request.toolName);
        const existing = this.getMcpServersList().find((s) => s.id === serverId);
        if (!existing) throw new Error("MCP server not found");
        const updated: McpServerConfig = {
          ...existing,
          toolPolicies: { ...(existing.toolPolicies ?? {}), [toolName]: policy },
          updatedAt: Date.now(),
        };
        this.store.data.mcpServers = [
          ...(this.store.data.mcpServers ?? []).filter((s) => s.id !== existing.id),
          updated,
        ];
        if (isDemoMode()) saveDemoMcpServer(updated);
        this.mcp.invalidate(existing.id);
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
