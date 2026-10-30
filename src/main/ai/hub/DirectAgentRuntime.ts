import { CodexAuthProvider, buildCodexHeaders } from "../CodexAuthProvider";
import type { HermesModelConfig } from "../HermesManager";
import type {
  AgentTask,
  KbDocument,
  McpServerConfig,
  MissionAgent,
} from "../../../shared/types/aiHub";
import type { ToolRequest } from "./ToolBroker";
import type { AgentRuntime, RunEvent } from "./AgentRuntime";
import { boundedContext, safeError } from "./privacy";

export type DirectToolInvoker = (request: ToolRequest) => Promise<unknown>;

interface FunctionToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const AGENT_TOOLS: FunctionToolDef[] = [
  {
    name: "workspace_context",
    description:
      "Read workspace infrastructure context: all shared and personal VMs/clusters with their descriptions and roles, open terminal sessions and their live output, the shared team activity log (who changed what on which VM/cluster), and shared memories/skills.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional filter query to search terminal history, servers, or team activity.",
        },
        sessionId: {
          type: "string",
          description: "Optional terminal sessionId to inspect in detail.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "terminal_command",
    description:
      "Run a shell command in an open sshs3 terminal session. Safe read-only diagnostic commands (ls, cat, systemctl status, journalctl, df, ps, kubectl get/describe/logs, docker ps/logs, git status/diff) run seamlessly; mutating commands prompt the user for one-click approval.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Non-interactive shell command to execute.",
        },
        description: {
          type: "string",
          description: "Brief human-readable explanation of what this command checks or changes.",
        },
        sessionId: {
          type: "string",
          description:
            "Optional terminal sessionId when working across multiple open terminals. Defaults to the task's active terminal.",
        },
      },
      required: ["command", "description"],
      additionalProperties: false,
    },
  },
  {
    name: "terminal_verify",
    description:
      "Run a verification command in an sshs3 terminal and check that the output contains an expected string and exits with code 0.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Verification command to run." },
        expected: { type: "string", description: "Substring expected in the command output." },
        description: { type: "string", description: "What this verification proves." },
        sessionId: { type: "string", description: "Optional terminal sessionId." },
      },
      required: ["command", "expected", "description"],
      additionalProperties: false,
    },
  },
  {
    name: "file_read",
    description:
      "Read a UTF-8 text file (up to 64 KB) on the target host and return its content and SHA-256 hash.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path on the target." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "file_write",
    description:
      "Propose a reviewed file replacement on the target host using the hash from a prior file_read. Shows a full diff to the user for approval and records the change in the shared team activity log.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path on the target." },
        content: { type: "string", description: "Complete new UTF-8 file content." },
        expected: { type: "string", description: "Expected SHA-256 hash from prior file_read." },
        description: { type: "string", description: "Summary of the configuration change." },
      },
      required: ["path", "content", "expected", "description"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace_remember",
    description:
      "Save a discovered server fact, configuration note, or reusable troubleshooting skill to the shared workspace memory so teammates and future AI sessions know about it.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the memory or skill." },
        text: { type: "string", description: "Detailed observation, configuration notes, or runbook steps." },
        kind: { type: "string", enum: ["memory", "skill"], description: "Whether this is a server memory or reusable skill." },
        scope: {
          type: "string",
          description: "Scope: 'workspace' (shared across the whole team), 'target:<profileId>', or 'personal'.",
        },
      },
      required: ["title", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "sshs3_manage_server",
    description:
      "Create, update, or delete SSH servers / VMs / cluster nodes in sshs3, or configure local SSH auth overrides. Always available in any mode.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["upsert", "update_metadata", "delete", "set_local_override"],
          description: "Operation: 'upsert' (create or update a server), 'update_metadata' (update cluster/role/description/tags), 'delete' (remove server), or 'set_local_override' (set local SSH user/key).",
        },
        serverIdOrName: {
          type: "string",
          description: "Existing server ID, name, or hostname/IP when updating or deleting.",
        },
        name: { type: "string", description: "Display name of the VM/node (e.g. 'prod-redis-01')." },
        host: { type: "string", description: "Hostname or IP address (e.g. '10.20.1.50')." },
        port: { type: "number", description: "SSH port (default 22)." },
        username: { type: "string", description: "SSH username (e.g. 'ubuntu', 'root', 'deploy')." },
        cluster: { type: "string", description: "Cluster name (e.g. 'Acme-Prod-Core', 'k8s-eu-north-1')." },
        nodeRole: {
          type: "string",
          description: "Role inside the cluster (e.g. 'control-plane', 'worker', 'primary-db', 'replica-db', 'ingress', 'cache', 'storage', 'bastion').",
        },
        role: {
          type: "string",
          description: "Infrastructure role category ('web', 'database', 'k8s', 'worker', 'storage', 'bastion', 'cache').",
        },
        folder: { type: "string", description: "Folder / group path in sshs3 (e.g. 'Acme Cloud / Prod')." },
        description: { type: "string", description: "Human-readable description of what this VM/node does." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "List of tags (e.g. ['redis', 'prod', 'cache']).",
        },
        shared: {
          type: "boolean",
          description: "Whether this server is shared with teammates via S3 Team Workspace / Web Server (default true) or personal (false).",
        },
        localUsername: { type: "string", description: "Optional local-only SSH username override." },
        localPrivateKeyPath: { type: "string", description: "Optional local-only SSH private key path override." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    name: "sshs3_manage_cluster_and_folders",
    description:
      "Organize or assign multiple servers into a cluster at once, or create, rename, or delete folders in sshs3.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["assign_cluster", "create_folder", "rename_folder", "delete_folder"],
          description: "Operation to perform.",
        },
        cluster: { type: "string", description: "Cluster name when operation is 'assign_cluster'." },
        serverIdsOrNames: {
          type: "array",
          items: { type: "string" },
          description: "Server IDs, names, or hosts to assign to the cluster.",
        },
        nodeRole: { type: "string", description: "Optional nodeRole to set on assigned servers." },
        role: { type: "string", description: "Optional role to set on assigned servers." },
        folderName: { type: "string", description: "Folder name for create_folder, rename_folder, or delete_folder." },
        newFolderName: { type: "string", description: "New folder name when operation is 'rename_folder'." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    name: "sshs3_manage_memory_and_activity",
    description:
      "List, create, update, or delete shared/personal AI memories and reusable troubleshooting skills in sshs3, or log a team activity note.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list", "save", "delete", "log_activity"],
          description: "Operation: 'list', 'save' (create/update memory or skill), 'delete', or 'log_activity'.",
        },
        idOrTitle: { type: "string", description: "Memory/skill ID or title to update or delete." },
        title: { type: "string", description: "Title for the memory/skill or target label for activity." },
        text: { type: "string", description: "Content for the memory/skill or summary for activity." },
        detail: { type: "string", description: "Optional command or config detail when logging activity." },
        kind: { type: "string", enum: ["memory", "skill"], description: "Whether entry is a memory or reusable skill." },
        scope: { type: "string", description: "Scope: 'workspace' (shared with team) or 'personal'." },
        activityKind: {
          type: "string",
          enum: ["note", "config-edit", "service", "deploy", "package", "command"],
          description: "Category when logging a team activity event.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    name: "sshs3_manage_schedule",
    description:
      "List, create, update, enable/disable, or delete scheduled recurring AI health checks and tasks in sshs3.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list", "save", "toggle", "delete"],
          description: "Operation: 'list', 'save' (create or update schedule), 'toggle' (enable/disable), or 'delete'.",
        },
        idOrTitle: { type: "string", description: "Schedule ID or title when updating, toggling, or deleting." },
        title: { type: "string", description: "Schedule title (e.g. 'Check PostgreSQL replication & disk')." },
        prompt: { type: "string", description: "AI instructions to run on schedule." },
        serverIdOrName: { type: "string", description: "Target server ID/name/host, or 'local' for local shell." },
        intervalMinutes: { type: "number", description: "How often to run in minutes (e.g. 60)." },
        mode: { type: "string", enum: ["advice", "assisted", "autonomous"], description: "Execution mode." },
        enabled: { type: "boolean", description: "Whether the schedule is active." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    name: "sshs3_manage_s3_and_sync",
    description:
      "Check S3 Team Workspace sync status and saved S3 bucket profiles, trigger an immediate S3 Team Workspace sync, or create/update/delete an S3 bucket profile in sshs3.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["status", "sync_now", "upsert_s3_profile", "delete_s3_profile"],
          description: "Operation to perform.",
        },
        idOrName: { type: "string", description: "S3 profile ID or name when updating or deleting." },
        name: { type: "string", description: "Display name for the S3 profile." },
        endpoint: { type: "string", description: "S3 endpoint URL (e.g. 'https://s3.eu-north-1.amazonaws.com')." },
        region: { type: "string", description: "S3 region (e.g. 'eu-north-1', 'auto')." },
        bucket: { type: "string", description: "Bucket name." },
        accessKeyId: { type: "string", description: "Access Key ID." },
        secretAccessKey: { type: "string", description: "Secret Access Key." },
        forcePathStyle: { type: "boolean", description: "Whether to use path-style S3 URLs (true for MinIO)." },
        group: { type: "string", description: "Optional folder/group name." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    name: "sshs3_manage_app_and_settings",
    description:
      "Read full sshs3 application state, update sshs3 settings (demoMode, actorName, theme, terminalFontSize, terminalFontFamily, scrollbackLines, cursorStyle, cursorBlink, confirmBeforeQuit, background, autoStart, inventory), manage command snippets, or open a local terminal session.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["get_state", "update_settings", "save_snippet", "delete_snippet", "open_local_terminal"],
          description: "Operation to perform.",
        },
        demoMode: { type: "boolean", description: "Enable or disable sshs3 Demo Mode (pre-populated Acme Cloud clusters, VMs, memories, and activity log)." },
        actorName: { type: "string", description: "User's display name in the team workspace & activity log." },
        theme: { type: "string", enum: ["dark", "light", "system"], description: "UI theme." },
        terminalFontSize: { type: "number", description: "Terminal font size in px (e.g. 14, 16)." },
        terminalFontFamily: { type: "string", description: "Terminal font family (e.g. 'JetBrains Mono', 'Fira Code')." },
        scrollbackLines: { type: "number", description: "Terminal scrollback buffer lines." },
        cursorStyle: { type: "string", enum: ["block", "underline", "bar"], description: "Terminal cursor style." },
        cursorBlink: { type: "boolean", description: "Whether terminal cursor blinks." },
        confirmBeforeQuit: { type: "boolean", description: "Ask confirmation before quitting sshs3." },
        background: { type: "boolean", description: "Keep sshs3 AI Hub running in background tray." },
        autoStart: { type: "boolean", description: "Start sshs3 automatically on login." },
        inventory: { type: "boolean", description: "Enable background TCP reachability checks." },
        snippetName: { type: "string", description: "Name of command snippet to save or delete." },
        snippetCommand: { type: "string", description: "Shell command for the snippet." },
        snippetCategory: { type: "string", description: "Optional snippet category." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    name: "sshs3_cluster_exec",
    description:
      "Execute a shell/CLI command in parallel across an entire cluster (e.g. 'NetApp-ONTAP-Prod-SE', 'Ceph-NVMe-Block-Pool') or a list of nodes, and return aggregated per-node output. In 'assisted' mode, prompts the user once to approve the multi-node run; in 'autonomous' mode, executes immediately.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Non-interactive command to execute across all target nodes.",
        },
        description: {
          type: "string",
          description: "Brief explanation of what this multi-node command checks or updates.",
        },
        cluster: {
          type: "string",
          description: "Cluster name to target (e.g. 'NetApp-ONTAP-Prod-SE').",
        },
        serverIdsOrNames: {
          type: "array",
          items: { type: "string" },
          description: "Explicit list of server IDs, names, or hosts when targeting specific nodes.",
        },
      },
      required: ["command", "description"],
      additionalProperties: false,
    },
  },
  {
    name: "sshs3_workspace_layout",
    description:
      "Orchestrate the sshs3 UI workspace layout: open a terminal tab for a server, open a Konsole-style multi-pane split view (2x2 grid, horizontal, or vertical) for a cluster or list of nodes, or open a Dual-Pane SFTP/S3 File Explorer tab.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["open_terminal", "open_cluster_split", "open_dual_pane_explorer"],
          description: "UI layout operation to trigger.",
        },
        cluster: {
          type: "string",
          description: "Cluster name whose nodes should be opened in a split-view grid.",
        },
        serverIdsOrNames: {
          type: "array",
          items: { type: "string" },
          description: "Server IDs or names to open in terminal / split panes.",
        },
        layout: {
          type: "string",
          enum: ["grid", "horizontal", "vertical"],
          description: "Split-pane layout style (default 'grid').",
        },
        leftTargetId: {
          type: "string",
          description: "Optional left pane server/S3 ID for open_dual_pane_explorer.",
        },
        rightTargetId: {
          type: "string",
          description: "Optional right pane server/S3 ID for open_dual_pane_explorer.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    name: "sshs3_storage_ops",
    description:
      "Perform deep SFTP / S3 / storage file operations: list files in a directory or S3 bucket prefix, read a remote configuration file, or compute a unified diff comparing a file/path across two servers or S3 buckets.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list_files", "read_remote_file", "diff_paths"],
          description: "Storage operation: 'list_files', 'read_remote_file', or 'diff_paths'.",
        },
        targetA: {
          type: "string",
          description: "Primary server name/ID or S3 profile name/ID.",
        },
        pathA: {
          type: "string",
          description: "File or directory path on targetA (e.g. '/etc/multipath.conf' or 'ontap-fabricpool-tier/').",
        },
        targetB: {
          type: "string",
          description: "Second server name/ID or S3 profile when operation is 'diff_paths'.",
        },
        pathB: {
          type: "string",
          description: "Optional file path on targetB (defaults to pathA).",
        },
      },
      required: ["operation", "targetA", "pathA"],
      additionalProperties: false,
    },
  },
  {
    name: "sshs3_kb_search",
    description:
      "Search the built-in sshs3 Knowledge Base (KB) for runbooks, architecture docs, NetApp ONTAP / StorageGRID / Ceph / Kubernetes Trident guides, and configuration standards.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords or question to search in the Knowledge Base.",
        },
        cluster: {
          type: "string",
          description: "Optional cluster name to prioritize matching KB documents.",
        },
        limit: {
          type: "number",
          description: "Maximum number of KB chunks to return (default 6).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "sshs3_kb_manage",
    description:
      "List, add, delete, or ingest local folder documentation into the sshs3 Knowledge Base (KB).",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list", "add_document", "delete_document", "ingest_local_folder"],
          description: "KB management operation.",
        },
        idOrTitle: {
          type: "string",
          description: "Document ID or title when deleting.",
        },
        title: {
          type: "string",
          description: "Title when adding a KB document.",
        },
        content: {
          type: "string",
          description: "Markdown or text content when adding a KB document.",
        },
        cluster: {
          type: "string",
          description: "Optional cluster association (e.g. 'NetApp-ONTAP-Prod-SE').",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for the KB document.",
        },
        folderPath: {
          type: "string",
          description: "Local directory path when operation is 'ingest_local_folder'.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    name: "sshs3_agent_and_mcp_manage",
    description:
      "List, create, update, delete, or launch specialized AI Mission Agents (with custom missions, system prompts, target clusters, KB docs, and MCP servers), or configure and test Model Context Protocol (MCP) servers.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "list",
            "save_agent",
            "delete_agent",
            "run_agent_mission",
            "save_mcp_server",
            "delete_mcp_server",
            "test_mcp_server",
          ],
          description: "Operation to perform.",
        },
        idOrName: {
          type: "string",
          description: "Agent or MCP server ID/name when updating, deleting, running, or testing.",
        },
        name: {
          type: "string",
          description: "Name of the Mission Agent or MCP server.",
        },
        role: {
          type: "string",
          description: "Short role/title for the Mission Agent.",
        },
        icon: {
          type: "string",
          description: "Emoji icon for the Mission Agent (e.g. '🗄️', '🪣', '⚡', '☸️').",
        },
        mission: {
          type: "string",
          description: "Primary mission / assignment description for the Mission Agent.",
        },
        systemPrompt: {
          type: "string",
          description: "Detailed system instructions for the Mission Agent.",
        },
        targetCluster: {
          type: "string",
          description: "Optional cluster bound to the Mission Agent.",
        },
        defaultMode: {
          type: "string",
          enum: ["advice", "assisted", "autonomous"],
          description: "Default execution mode for the Mission Agent.",
        },
        transport: {
          type: "string",
          enum: ["stdio", "http"],
          description: "MCP transport type when saving an MCP server.",
        },
        command: {
          type: "string",
          description: "Executable command for stdio MCP server (e.g. 'npx').",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Command arguments for stdio MCP server.",
        },
        url: {
          type: "string",
          description: "HTTP endpoint URL for http MCP server.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
];

function mapToolCallToBrokerRequest(name: string, args: Record<string, unknown>): ToolRequest {
  if (name.startsWith("sshs3_") || name.startsWith("mcp__")) {
    return {
      action: name,
      payload: args,
    };
  }
  switch (name) {
    case "workspace_context":
      return {
        action: "context",
        query: typeof args.query === "string" ? args.query : undefined,
        id: typeof args.sessionId === "string" ? args.sessionId : undefined,
      };
    case "terminal_command":
      return {
        action: "command",
        command: typeof args.command === "string" ? args.command : "",
        description: typeof args.description === "string" ? args.description : "Run terminal command",
        id: typeof args.sessionId === "string" ? args.sessionId : undefined,
      };
    case "terminal_verify":
      return {
        action: "verify",
        command: typeof args.command === "string" ? args.command : "",
        expected: typeof args.expected === "string" ? args.expected : "",
        description: typeof args.description === "string" ? args.description : "Verify terminal state",
        id: typeof args.sessionId === "string" ? args.sessionId : undefined,
      };
    case "file_read":
      return {
        action: "file-read",
        path: typeof args.path === "string" ? args.path : "",
      };
    case "file_write":
      return {
        action: "file-write",
        path: typeof args.path === "string" ? args.path : "",
        content: typeof args.content === "string" ? args.content : "",
        expected: typeof args.expected === "string" ? args.expected : "",
        description: typeof args.description === "string" ? args.description : "Update file",
      };
    case "workspace_remember":
      return {
        action: "memory-save",
        title: typeof args.title === "string" ? args.title : "Workspace note",
        text: typeof args.text === "string" ? args.text : "",
        kind: args.kind === "skill" ? "skill" : "memory",
        scope: typeof args.scope === "string" ? args.scope : "workspace",
        query: typeof args.title === "string" ? args.title : "Workspace note",
        content: typeof args.text === "string" ? args.text : "",
      };
    default:
      return { action: name, ...args } as ToolRequest;
  }
}

function resolveActiveAgent(
  task: AgentTask,
  initialContext?: unknown,
): MissionAgent | undefined {
  const ctx = (initialContext ?? {}) as { agents?: MissionAgent[] };
  const agents = Array.isArray(ctx.agents) ? ctx.agents : [];
  if (agents.length === 0) return undefined;
  if (task.agentId) {
    const byId = agents.find((a) => a.id === task.agentId);
    if (byId) return byId;
  }
  const lastUserText =
    task.messages
      .filter((m) => m.role === "user")
      .at(-1)
      ?.text.toLowerCase() ?? "";
  const mentionMatch = /@agent:([a-z0-9_-]+)/i.exec(lastUserText);
  if (mentionMatch) {
    const q = mentionMatch[1].toLowerCase();
    return agents.find(
      (a) =>
        a.id.toLowerCase().includes(q) ||
        a.name.toLowerCase().replace(/\s+/g, "-").includes(q) ||
        a.name.toLowerCase().includes(q),
    );
  }
  return undefined;
}

function toolsForTask(
  task: AgentTask,
  initialContext?: unknown,
): FunctionToolDef[] {
  const activeAgent = resolveActiveAgent(task, initialContext);
  let baseTools =
    task.mode === "advice" || !task.target
      ? AGENT_TOOLS.filter(
          (t) =>
            t.name === "workspace_context" ||
            t.name === "workspace_remember" ||
            t.name.startsWith("sshs3_"),
        )
      : [...AGENT_TOOLS];

  if (
    activeAgent?.allowedTools?.length &&
    !activeAgent.allowedTools.includes("all")
  ) {
    const allowed = new Set(activeAgent.allowedTools);
    baseTools = baseTools.filter(
      (t) =>
        allowed.has(t.name) ||
        t.name === "workspace_context" ||
        t.name === "sshs3_kb_search",
    );
  }

  // Dynamically append discovered MCP tools from enabled MCP servers
  const ctx = (initialContext ?? {}) as { mcpServers?: McpServerConfig[] };
  const mcpServers = Array.isArray(ctx.mcpServers) ? ctx.mcpServers : [];
  const allowedMcpIds = activeAgent?.mcpServerIds?.length
    ? new Set(activeAgent.mcpServerIds)
    : null;

  for (const srv of mcpServers) {
    if (!srv.enabled) continue;
    if (allowedMcpIds && !allowedMcpIds.has(srv.id)) continue;
    const safeSrvId = srv.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    for (const tool of srv.discoveredTools ?? []) {
      const safeToolName = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const qualified = `mcp__${safeSrvId}__${safeToolName}`;
      if (baseTools.some((t) => t.name === qualified)) continue;
      baseTools.push({
        name: qualified,
        description: `[MCP: ${srv.name}] ${tool.description || tool.name}`,
        parameters:
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? tool.inputSchema
            : {
                type: "object",
                properties: {},
                additionalProperties: true,
              },
      });
    }
  }

  return baseTools;
}

function extractAiRuntimeTuning(
  task: AgentTask,
  initialContext?: unknown,
): {
  snapshotMaxChars: number;
  maxOutputTokens: number;
  maxTurns: number;
  reasoningEffort: "low" | "medium" | "high";
  temperature: number;
} {
  const ctx = (initialContext ?? {}) as {
    appSettings?: { aiConfig?: Record<string, unknown> };
  };
  const cfg = ctx.appSettings?.aiConfig ?? {};
  const contextWindowTokens =
    typeof cfg.contextWindowTokens === "number"
      ? cfg.contextWindowTokens
      : 128_000;
  const maxOutputTokens =
    typeof cfg.maxOutputTokens === "number" ? cfg.maxOutputTokens : 8192;
  const maxToolTurns =
    typeof cfg.maxToolTurns === "number"
      ? cfg.maxToolTurns
      : Math.max(8, Math.min(35, task.maxCommands + 6));
  const reasoningEffort =
    cfg.reasoningEffort === "low" ||
    cfg.reasoningEffort === "medium" ||
    cfg.reasoningEffort === "high"
      ? cfg.reasoningEffort
      : "medium";
  const temperature =
    typeof cfg.temperature === "number" ? cfg.temperature : 0.2;
  // Scale snapshot char budget proportionally to contextWindowTokens (16k -> 12k chars, 128k+ -> 36k chars)
  const snapshotMaxChars = Math.max(
    8000,
    Math.min(64_000, Math.round(contextWindowTokens * 0.3)),
  );
  return {
    snapshotMaxChars,
    maxOutputTokens,
    maxTurns: Math.max(4, Math.min(60, maxToolTurns)),
    reasoningEffort,
    temperature,
  };
}

function buildSystemInstructions(
  task: AgentTask,
  initialContext?: unknown,
): string {
  const activeAgent = resolveActiveAgent(task, initialContext);
  const ctx = (initialContext ?? {}) as { kbDocuments?: KbDocument[] };
  const kbDocs = Array.isArray(ctx.kbDocuments) ? ctx.kbDocuments : [];

  const agentSection: string[] = [];
  if (activeAgent) {
    agentSection.push(
      "",
      `### ACTIVE MISSION AGENT: ${activeAgent.icon} ${activeAgent.name} (${activeAgent.role})`,
      `- **Mission Assignment**: ${activeAgent.mission}`,
      ...(activeAgent.targetCluster
        ? [`- **Bound Target Cluster**: \`${activeAgent.targetCluster}\``]
        : []),
      `- **Agent System Instructions**:\n${activeAgent.systemPrompt}`,
    );
    if (activeAgent.kbDocIds?.length) {
      const boundDocs = kbDocs.filter((d) =>
        activeAgent.kbDocIds!.includes(d.id),
      );
      if (boundDocs.length > 0) {
        agentSection.push(
          "- **Agent Bound Knowledge Base (KB) Excerpts**:",
          ...boundDocs.map(
            (d) =>
              `  * **${d.title}** (${d.cluster || "global"}):\n    ${boundedContext(d.content, 2000).replace(/\n/g, "\n    ")}`,
          ),
        );
      }
    }
  }

  return [
    "You are the built-in AI Copilot and Master Architect of **sshs3** — a modern cross-platform SSH, SFTP, S3, and Kubernetes/Cluster workspace platform with an integrated AI Workspace, Mission Agents, MCP (Model Context Protocol) support, Knowledge Base (KB), S3 Team Workspace sync, YubiKey/PIV Team Vault, and Multi-User Web Server mode.",
    `Current autonomy mode: ${task.mode}. Primary terminal target: ${JSON.stringify(task.target ?? null)}.`,
    ...agentSection,
    "",
    "### YOUR CORE MANDATE",
    "1. **YOU CAN ANSWER ANYTHING ABOUT SSHS3 & INFRASTRUCTURE**: You have complete, encyclopedic understanding of how `sshs3` works, how all its features are configured, and the user's current servers, clusters, folders, S3 buckets, memories, recent team changes, schedules, Mission Agents, MCP servers, Knowledge Base documents, and settings (provided automatically in `[Automatic Workspace & Terminal Snapshot]`).",
    "2. **YOU CAN DIRECTLY MODIFY & ORCHESTRATE SSHS3 AT ANY TIME**:",
    "   - Manage servers/VMs, clusters, folders, memories/skills, schedules, S3 profiles, snippets, and settings with `sshs3_manage_*` tools.",
    "   - Run commands in parallel across an entire cluster or list of nodes with `sshs3_cluster_exec`.",
    "   - Open single terminals, 2x2/horizontal/vertical Konsole split-pane grids for a cluster, or Dual-Pane SFTP/S3 File Explorer tabs directly in the UI with `sshs3_workspace_layout`.",
    "   - List/inspect remote SFTP & S3 files and diff configuration files across two nodes or buckets with `sshs3_storage_ops`.",
    "   - Search and manage the built-in Knowledge Base (KB) with `sshs3_kb_search` and `sshs3_kb_manage`.",
    "   - Create/manage/run Mission Agents and MCP servers with `sshs3_agent_and_mcp_manage`, and invoke discovered external MCP tools (`mcp__<server>__<tool>`).",
    "3. **TERMINAL & FILE EXECUTION**: When troubleshooting or operating on a single server/shell (and mode is `assisted` or `autonomous`), use `terminal_command`, `terminal_verify`, `file_read`, and `file_write`. Never run interactive full-screen TUI programs (`vim`, `nano`, `top`, `less` without flags).",
    "",
    "### COMPLETE KNOWLEDGE BASE OF SSHS3",
    "- **Workspace VMs & Clusters (`LandingView`)**: Servers have `name`, `host`, `port`, `username`, `cluster` (e.g. `NetApp-ONTAP-Prod-SE`, `NetApp-StorageGRID-S3`, `Ceph-NVMe-Block-Pool`, `K8s-Trident-CSI-Prod`), `nodeRole`, infrastructure `role`, `folder`, `tags`, `description`, and `shared`.",
    "- **@-Context Mentions in Chat**: Typing `@` autocompletes `@workspace`, `@team-changes`, `@cluster:<name>`, `@agent:<name>` (Mission Agents), `@kb:<title>` (Knowledge Base docs), or `@<server>`.",
    "- **Proactive 'Fix with AI' Terminal Banner & Inline AI (`Ctrl+K`)**: When a command fails in any terminal, sshs3 surfaces a 1-click `✨ Förklara & fixa felet` chip that attaches the failed command, exit code, and terminal output to AI chat.",
    "- **Mission Agents, MCP & Knowledge Base**: Users can configure specialized Mission Agents with custom system prompts, target clusters, KB collections, and stdio/HTTP MCP servers, plus control context window size (`16k`–`900k`), terminal scrollback budget, reasoning effort, and max tool turns.",
    "",
    "Always respond in the same language as the user (e.g. Swedish if the user writes in Swedish). Be clear, helpful, and proactive.",
  ].join("\n");
}

interface ParsedToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export class DirectAgentRuntime implements AgentRuntime {
  private abort = new AbortController();
  private cancelled = false;
  private steeringQueue: string[] = [];

  constructor(
    private readonly invokeBroker: DirectToolInvoker,
    private readonly authBaseDir?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async steer(text: string): Promise<void> {
    if (this.cancelled) throw new Error("Run is not active");
    this.steeringQueue.push(boundedContext(text));
  }

  async stop(): Promise<void> {
    this.cancelled = true;
    this.abort.abort();
  }

  async start(
    task: AgentTask,
    model: HermesModelConfig,
    onEvent: (event: RunEvent) => void,
  ): Promise<void> {
    try {
      if (model.kind === "openai-codex") {
        await this.runCodexResponsesLoop(task, model, onEvent);
      } else if (model.kind === "anthropic") {
        await this.runAnthropicLoop(task, model, onEvent);
      } else {
        await this.runOpenAiCompatibleLoop(task, model, onEvent);
      }
    } catch (error) {
      if (this.cancelled || this.abort.signal.aborted) {
        onEvent({ type: "run.cancelled" });
        return;
      }
      onEvent({
        type: "run.failed",
        error: safeError(error),
      });
    }
  }

  private async executeToolCall(call: ParsedToolCall): Promise<string> {
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = call.argumentsJson ? (JSON.parse(call.argumentsJson) as Record<string, unknown>) : {};
    } catch {
      return JSON.stringify({ error: "Invalid JSON arguments for tool " + call.name });
    }
    try {
      const req = mapToolCallToBrokerRequest(call.name, parsedArgs);
      const result = await this.invokeBroker(req);
      return JSON.stringify(result ?? { ok: true });
    } catch (error) {
      return JSON.stringify({ error: safeError(error) });
    }
  }

  private async runCodexResponsesLoop(
    task: AgentTask,
    model: Extract<HermesModelConfig, { kind: "openai-codex" }>,
    onEvent: (event: RunEvent) => void,
  ): Promise<void> {
    const auth = new CodexAuthProvider(this.authBaseDir);
    const creds = await auth.resolveCredentials(this.fetchImpl);
    if (!creds) {
      throw new Error(
        "No ChatGPT/Codex OAuth session found. Sign in with ChatGPT or configure an API key in AI settings.",
      );
    }
    const sanitizedBaseUrl =
      model.baseUrl && !model.baseUrl.includes("openrouter.ai")
        ? model.baseUrl
        : creds.baseUrl;
    const baseUrl = sanitizedBaseUrl.replace(/\/$/, "");
    const resolvedModel =
      !model.model ||
      model.model === "gpt-sol-latest" ||
      model.model === "local" ||
      model.model === "gpt-5.3-codex" ||
      model.model === "gpt-5.4" ||
      model.model === "gpt-5.4-mini" ||
      model.model === "gpt-5.2-codex" ||
      model.model === "gpt-5.1-codex-max" ||
      model.model.startsWith("claude-")
        ? creds.defaultModel || "gpt-6.1-sol"
        : model.model;
    let initialContext: unknown;
    try {
      initialContext = await this.invokeBroker({ action: "context" });
    } catch {
      // Non-fatal if context snapshot fails
    }
    const tuning = extractAiRuntimeTuning(task, initialContext);
    const instructions = buildSystemInstructions(task, initialContext);

    const inputItems: Array<Record<string, unknown>> = [];
    for (const msg of task.messages.slice(-30)) {
      if (msg.role === "system") continue;
      const role = msg.role === "assistant" ? "assistant" : "user";
      const contentParts: Array<Record<string, unknown>> = [
        {
          type: role === "user" ? "input_text" : "output_text",
          text: boundedContext(msg.text),
        },
      ];
      if (role === "user" && msg.images?.length) {
        for (const img of msg.images) {
          if (img.dataUrl?.startsWith("data:image/")) {
            contentParts.push({
              type: "input_image",
              image_url: img.dataUrl,
            });
          }
        }
      }
      inputItems.push({
        type: "message",
        role,
        content: contentParts,
      });
    }

    if (initialContext) {
      inputItems.unshift({
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `[Automatic Workspace & Terminal Snapshot]\n${boundedContext(JSON.stringify(initialContext), tuning.snapshotMaxChars)}`,
          },
        ],
      });
    }

    const wireTools = toolsForTask(task, initialContext).map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const maxTurns = tuning.maxTurns;
    let finalOutput = "";

    for (let turn = 0; turn < maxTurns && !this.cancelled; turn++) {
      while (this.steeringQueue.length > 0) {
        const steered = this.steeringQueue.shift()!;
        inputItems.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: steered }],
        });
      }

      const response = await this.fetchImpl(`${baseUrl}/responses`, {
        method: "POST",
        headers: buildCodexHeaders(creds.accessToken, baseUrl),
        body: JSON.stringify({
          model: resolvedModel,
          instructions,
          input: inputItems,
          tools: wireTools,
          store: false,
          stream: true,
        }),
        signal: this.abort.signal,
      });

      if (!response.ok) {
        const errText = boundedContext(await response.text().catch(() => ""), 1500);
        throw new Error(`Codex API (${response.status}): ${errText || response.statusText}`);
      }
      if (!response.body) throw new Error("Codex response stream missing");

      const toolCalls: ParsedToolCall[] = [];
      let turnText = "";
      let usage: Record<string, number> | undefined;

      await consumeSseStream(response.body, (data) => {
        if (data === "[DONE]") return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = String(event.type || "");
        if (type === "response.output_text.delta" && typeof event.delta === "string") {
          turnText += event.delta;
          onEvent({ type: "message.delta", delta: event.delta });
        } else if (type === "response.output_item.done" && event.item && typeof event.item === "object") {
          const item = event.item as Record<string, unknown>;
          if (item.type === "function_call") {
            const callId = String(item.call_id || item.id || `call_${toolCalls.length}`);
            const name = String(item.name || "");
            const args = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});
            toolCalls.push({ id: callId, name, argumentsJson: args });
          } else if (item.type === "message" && !turnText && Array.isArray(item.content)) {
            for (const part of item.content as Array<Record<string, unknown>>) {
              if (typeof part.text === "string") {
                turnText += part.text;
                onEvent({ type: "message.delta", delta: part.text });
              }
            }
          }
        } else if (type === "response.completed" && event.response && typeof event.response === "object") {
          const respObj = event.response as Record<string, unknown>;
          if (respObj.usage && typeof respObj.usage === "object") {
            const u = respObj.usage as Record<string, number>;
            usage = {
              input_tokens: u.input_tokens ?? 0,
              output_tokens: u.output_tokens ?? 0,
            };
          }
        } else if (type === "error" || type === "response.failed") {
          const msg =
            (event.error as { message?: string } | undefined)?.message ||
            ((event.response as { error?: { message?: string } } | undefined)?.error?.message) ||
            "Codex stream error";
          throw new Error(msg);
        }
      });

      if (turnText) {
        finalOutput = turnText;
        inputItems.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: turnText }],
        });
      }

      if (toolCalls.length === 0) {
        onEvent({
          type: "run.completed",
          output: finalOutput,
          usage,
        });
        return;
      }

      if (turnText) {
        onEvent({ type: "message.delta", delta: "\n\n" });
      }

      for (const call of toolCalls) {
        if (this.cancelled) break;
        inputItems.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.argumentsJson,
        });
        const output = await this.executeToolCall(call);
        inputItems.push({
          type: "function_call_output",
          call_id: call.id,
          output: boundedContext(output, 32_000),
        });
      }
    }

    onEvent({
      type: "run.completed",
      output: finalOutput || "Completed actions.",
    });
  }

  private async runOpenAiCompatibleLoop(
    task: AgentTask,
    model: Extract<HermesModelConfig, { kind: "custom" }>,
    onEvent: (event: RunEvent) => void,
  ): Promise<void> {
    const baseUrl = model.baseUrl.replace(/\/$/, "");
    let initialContext: unknown;
    try {
      initialContext = await this.invokeBroker({ action: "context" });
    } catch {
      // ignore
    }
    const tuning = extractAiRuntimeTuning(task, initialContext);
    const instructions = buildSystemInstructions(task, initialContext);
    const messages: Array<Record<string, unknown>> = [{ role: "system", content: instructions }];

    if (initialContext) {
      messages.push({
        role: "system",
        content: `Current Workspace & Terminal Snapshot:\n${boundedContext(JSON.stringify(initialContext), tuning.snapshotMaxChars)}`,
      });
    }

    for (const msg of task.messages.slice(-30)) {
      if (msg.role === "system") continue;
      if (msg.role === "user" && msg.images?.length) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: boundedContext(msg.text) },
            ...msg.images
              .filter((img) => img.dataUrl?.startsWith("data:image/"))
              .map((img) => ({
                type: "image_url",
                image_url: { url: img.dataUrl },
              })),
          ],
        });
      } else {
        messages.push({ role: msg.role, content: boundedContext(msg.text) });
      }
    }

    const tools = toolsForTask(task, initialContext).map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const maxTurns = tuning.maxTurns;
    let finalOutput = "";

    for (let turn = 0; turn < maxTurns && !this.cancelled; turn++) {
      while (this.steeringQueue.length > 0) {
        messages.push({ role: "user", content: this.steeringQueue.shift()! });
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (model.apiKey) headers.Authorization = `Bearer ${model.apiKey}`;

      const response = await this.fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: model.model,
          messages,
          tools,
          stream: true,
        }),
        signal: this.abort.signal,
      });

      if (!response.ok) {
        const errText = boundedContext(await response.text().catch(() => ""), 1500);
        throw new Error(`Model API (${response.status}): ${errText || response.statusText}`);
      }
      if (!response.body) throw new Error("Model response stream missing");

      let turnText = "";
      const toolCallsByIndex = new Map<number, ParsedToolCall>();
      let usage: Record<string, number> | undefined;

      await consumeSseStream(response.body, (data) => {
        if (data === "[DONE]") return;
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return;
        }
        if (chunk.usage && typeof chunk.usage === "object") {
          const u = chunk.usage as Record<string, number>;
          usage = {
            input_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
            output_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
          };
        }
        const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
        const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
        if (!delta) return;
        if (typeof delta.content === "string" && delta.content) {
          turnText += delta.content;
          onEvent({ type: "message.delta", delta: delta.content });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            const fn = (tc.function ?? {}) as Record<string, unknown>;
            const existing = toolCallsByIndex.get(idx) ?? {
              id: typeof tc.id === "string" ? tc.id : `call_${idx}`,
              name: "",
              argumentsJson: "",
            };
            if (typeof tc.id === "string" && tc.id) existing.id = tc.id;
            if (typeof fn.name === "string" && fn.name) existing.name += fn.name;
            if (typeof fn.arguments === "string" && fn.arguments) existing.argumentsJson += fn.arguments;
            toolCallsByIndex.set(idx, existing);
          }
        }
      });

      const toolCalls = [...toolCallsByIndex.values()].filter((c) => c.name);
      if (turnText) finalOutput = turnText;

      if (toolCalls.length === 0) {
        onEvent({ type: "run.completed", output: finalOutput, usage });
        return;
      }

      messages.push({
        role: "assistant",
        content: turnText || null,
        tool_calls: toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.argumentsJson || "{}" },
        })),
      });

      if (turnText) onEvent({ type: "message.delta", delta: "\n\n" });

      for (const call of toolCalls) {
        if (this.cancelled) break;
        const output = await this.executeToolCall(call);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: boundedContext(output, 32_000),
        });
      }
    }

    onEvent({ type: "run.completed", output: finalOutput || "Completed actions." });
  }

  private async runAnthropicLoop(
    task: AgentTask,
    model: Extract<HermesModelConfig, { kind: "anthropic" }>,
    onEvent: (event: RunEvent) => void,
  ): Promise<void> {
    const base = (model.baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
    const endpoint = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
    let initialContext: unknown;
    try {
      initialContext = await this.invokeBroker({ action: "context" });
    } catch {
      // ignore
    }
    const tuning = extractAiRuntimeTuning(task, initialContext);
    let systemInstructions = buildSystemInstructions(task, initialContext);
    if (initialContext) {
      systemInstructions += `\n\nCurrent Workspace & Terminal Snapshot:\n${boundedContext(JSON.stringify(initialContext), tuning.snapshotMaxChars)}`;
    }

    const messages: Array<Record<string, unknown>> = task.messages
      .filter((m) => m.role !== "system")
      .slice(-30)
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: boundedContext(m.text),
      }));

    const tools = toolsForTask(task, initialContext).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    const maxTurns = tuning.maxTurns;
    let finalOutput = "";

    for (let turn = 0; turn < maxTurns && !this.cancelled; turn++) {
      while (this.steeringQueue.length > 0) {
        messages.push({ role: "user", content: this.steeringQueue.shift()! });
      }

      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": model.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: model.model,
          max_tokens: 4096,
          system: systemInstructions,
          messages,
          tools,
          stream: true,
        }),
        signal: this.abort.signal,
      });

      if (!response.ok) {
        const errText = boundedContext(await response.text().catch(() => ""), 1500);
        throw new Error(`Anthropic API (${response.status}): ${errText || response.statusText}`);
      }
      if (!response.body) throw new Error("Anthropic response stream missing");

      let turnText = "";
      const toolCalls = new Map<number, ParsedToolCall>();
      let usage: Record<string, number> | undefined;

      await consumeSseStream(response.body, (data) => {
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = String(evt.type || "");
        if (type === "content_block_start" && evt.content_block && typeof evt.content_block === "object") {
          const block = evt.content_block as Record<string, unknown>;
          const idx = typeof evt.index === "number" ? evt.index : 0;
          if (block.type === "tool_use") {
            toolCalls.set(idx, {
              id: String(block.id || `tool_${idx}`),
              name: String(block.name || ""),
              argumentsJson: "",
            });
          }
        } else if (type === "content_block_delta" && evt.delta && typeof evt.delta === "object") {
          const delta = evt.delta as Record<string, unknown>;
          const idx = typeof evt.index === "number" ? evt.index : 0;
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            turnText += delta.text;
            onEvent({ type: "message.delta", delta: delta.text });
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const call = toolCalls.get(idx);
            if (call) call.argumentsJson += delta.partial_json;
          }
        } else if (type === "message_delta" && evt.usage && typeof evt.usage === "object") {
          const u = evt.usage as Record<string, number>;
          usage = {
            input_tokens: u.input_tokens ?? 0,
            output_tokens: u.output_tokens ?? 0,
          };
        }
      });

      const calls = [...toolCalls.values()].filter((c) => c.name);
      if (turnText) finalOutput = turnText;

      if (calls.length === 0) {
        onEvent({ type: "run.completed", output: finalOutput, usage });
        return;
      }

      const assistantContent: Array<Record<string, unknown>> = [];
      if (turnText) assistantContent.push({ type: "text", text: turnText });
      for (const c of calls) {
        let inputObj: Record<string, unknown> = {};
        try {
          inputObj = c.argumentsJson ? (JSON.parse(c.argumentsJson) as Record<string, unknown>) : {};
        } catch {
          inputObj = {};
        }
        assistantContent.push({
          type: "tool_use",
          id: c.id,
          name: c.name,
          input: inputObj,
        });
      }
      messages.push({ role: "assistant", content: assistantContent });

      if (turnText) onEvent({ type: "message.delta", delta: "\n\n" });

      const toolResults: Array<Record<string, unknown>> = [];
      for (const c of calls) {
        if (this.cancelled) break;
        const output = await this.executeToolCall(c);
        toolResults.push({
          type: "tool_result",
          tool_use_id: c.id,
          content: boundedContext(output, 32_000),
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    onEvent({ type: "run.completed", output: finalOutput || "Completed actions." });
  }
}

async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true }).replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart());
        if (dataLines.length > 0) {
          onData(dataLines.join("\n"));
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
