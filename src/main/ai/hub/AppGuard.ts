import type { AgentMode, AgentSchedule, MissionAgent } from "../../../shared/types/aiHub";

/**
 * The rules an agent runs under are not the agent's to change. Most of what
 * the management tools do is ordinary work in the app (save a snippet, tag a
 * server); a few operations move the fence itself: the command safety policy,
 * which model endpoint the conversation and the stored key go to, programs
 * and addresses that agents may call, an agent or a schedule that acts on its
 * own without asking, where the team's data is synced to, and pulling a folder
 * of local files into the shared knowledge base. Those wait for a person, in
 * every mode: also in a conversation that otherwise only advises, where the
 * person is there to answer.
 */

const RANK: Record<AgentMode, number> = { advice: 0, assisted: 1, autonomous: 2 };
/**
 * More freedom than the run that asks has, of the kind that matters: acting
 * without a person. An agent or a schedule that asks before each command is
 * not that, whoever makes it.
 */
const actsAlone = (mode: AgentMode, run: { mode: AgentMode }): boolean => mode === "autonomous" && run.mode !== "autonomous";
const isMode = (value: unknown): value is AgentMode => value === "advice" || value === "assisted" || value === "autonomous";

/** The more careful of two modes. */
export const lowerMode = (a: AgentMode, b: AgentMode | undefined): AgentMode => (b && RANK[b] < RANK[a] ? b : a);

/** What each operation of the management tools is, for the one test that keeps this list whole. */
export type AppOpClass = "read" | "change" | "guard" | "guard-if";
export const APP_OPS: Record<string, { fallback: string; ops: Record<string, AppOpClass> }> = {
  sshs3_manage_server: { fallback: "upsert", ops: { upsert: "change", update_metadata: "change", delete: "change", set_local_override: "change", list_tunnels: "read", save_tunnel: "change", delete_tunnel: "change" } },
  sshs3_manage_cluster_and_folders: { fallback: "assign_cluster", ops: { assign_cluster: "change", create_folder: "change", rename_folder: "change", delete_folder: "change" } },
  sshs3_manage_memory_and_activity: { fallback: "save", ops: { save: "change", list: "read", delete: "change", feedback: "change", self_reflect: "change", log_activity: "change", core_append: "change", core_replace: "change" } },
  // A schedule runs later with nobody there: it may not be given more freedom than the run that makes it.
  sshs3_manage_schedule: { fallback: "list", ops: { list: "read", save: "guard-if", delete: "change", toggle: "guard-if" } },
  sshs3_manage_s3_and_sync: {
    fallback: "status",
    ops: { status: "read", list_dir_sync_profiles: "read", sync_now: "change", configure_s3_workspace: "guard", disconnect_s3_workspace: "guard", upsert_s3_profile: "change", delete_s3_profile: "change", save_dir_sync_profile: "guard", delete_dir_sync_profile: "change" },
  },
  sshs3_manage_app_and_settings: {
    fallback: "get_state",
    ops: { get_state: "read", update_settings: "guard-if", configure_ai: "guard-if", update_shortcuts: "guard-if", update_safety_policy: "guard", list_dotfiles: "read", save_dotfile: "change", delete_dotfile: "change", list_snippets: "read", save_snippet: "change", delete_snippet: "change", open_local_terminal: "change" },
  },
  sshs3_kb_manage: { fallback: "list", ops: { list: "read", add_document: "change", delete_document: "change", ingest_local_folder: "guard", ingest_s3_prefix: "guard" } },
  sshs3_tickets: { fallback: "list", ops: { list: "read", read: "read", create: "change", comment: "change" } },
  sshs3_workspace_layout: { fallback: "open_terminal", ops: { open_terminal: "change", open_cluster_split: "change", open_dual_pane_explorer: "change" } },
  sshs3_storage_ops: { fallback: "list_files", ops: { list_files: "read", read_remote_file: "read", diff_paths: "read" } },
  sshs3_agent_and_mcp_manage: {
    fallback: "list",
    ops: { list: "read", run_workforce: "change", delegate_to_agent: "change", handoff_agent: "change", install_mcp_preset: "guard", save_infra_edge: "change", delete_infra_edge: "change", save_agent: "guard-if", delete_agent: "change", run_agent_mission: "guard-if", save_mcp_server: "guard", delete_mcp_server: "change", test_mcp_server: "change" },
  },
};

const SAFETY_FIELDS = ["safetyPolicy", "autoApproveSafeReadOnly", "requireApprovalOnProdTags", "blockDestructiveWithoutConfirm"];
const ENDPOINT_FIELDS = ["aiProvider", "aiBaseUrl", "aiEnabled"];

export interface GuardAsk {
  /** What is asked for, in a line a person reads in the inbox. */
  title: string;
  /** Exactly what would change. */
  detail: string;
}

const has = (p: Record<string, unknown>, key: string): boolean => p[key] !== undefined && p[key] !== null && p[key] !== "";
const text = (p: Record<string, unknown>, key: string): string => (typeof p[key] === "string" ? (p[key] as string).trim() : "");
const show = (p: Record<string, unknown>, keys: string[]): string =>
  keys
    .filter((k) => has(p, k))
    .map((k) => `${k}: ${typeof p[k] === "string" ? p[k] : JSON.stringify(p[k])}`)
    .join("\n");

/**
 * Whether this call moves the fence, and if so what to ask the person. A call
 * that does not is ordinary work and returns nothing.
 */
/**
 * The agent a call names, by its id or its whole name. The same rule as the
 * one the tool itself uses: a part of a name, or no name at all, names
 * nobody — otherwise the guard and the tool could disagree about which agent
 * a call is about, and the guard would be looking at the wrong one.
 */
export function agentNamed<T extends Pick<MissionAgent, "id" | "name" | "defaultMode">>(
  agents: T[],
  payload: Record<string, unknown>,
  keys: string[],
): T | undefined {
  const q = keys.map((k) => text(payload, k)).find(Boolean)?.toLowerCase() ?? "";
  if (!q) return undefined;
  return agents.find((a) => a.id.toLowerCase() === q || a.name.toLowerCase() === q);
}

/** What each tool's delete takes away, said in the question a person is asked. */
const REMOVES: Record<string, string> = {
  sshs3_manage_server: "a server",
  sshs3_manage_cluster_and_folders: "a folder of servers",
  sshs3_manage_memory_and_activity: "a team memory or skill",
  sshs3_manage_schedule: "a schedule",
  sshs3_manage_s3_and_sync: "a storage or sync profile",
  sshs3_manage_app_and_settings: "a saved snippet or dotfile",
  sshs3_kb_manage: "a knowledge base source",
  sshs3_agent_and_mcp_manage: "an agent, an MCP server or a dependency",
};

export function guardAsk(
  tool: string,
  payload: Record<string, unknown>,
  run: { mode: AgentMode },
  known: { agents: Pick<MissionAgent, "id" | "name" | "defaultMode">[]; schedules: Pick<AgentSchedule, "id" | "title" | "mode">[] },
): GuardAsk | undefined {
  const spec = APP_OPS[tool];
  if (!spec) return undefined;
  const op = text(payload, "operation") || spec.fallback;

  // Taking something the team has out of the workspace — a server, an agent, a
  // source, a profile — is a person's decision in every mode. An agent that is
  // trusted to act on its own is trusted to change systems, not to make the
  // team's own things disappear; and what is deleted here is not always what
  // the model meant to name.
  if (op.startsWith("delete") && spec.ops[op] !== "read")
    return {
      title: `Remove ${REMOVES[tool] ?? "something"} from this workspace`,
      detail: show(payload, ["idOrName", "idOrTitle", "id", "name", "title", "folderName", "cluster", "s3ProfileId", "edgeId"]),
    };

  if (tool === "sshs3_manage_app_and_settings") {
    // The fields decide, not the operation's name: the same handler takes them under any of its names.
    if (SAFETY_FIELDS.some((k) => has(payload, k)))
      return { title: "Change the command safety policy", detail: show(payload, SAFETY_FIELDS) };
    if (ENDPOINT_FIELDS.some((k) => has(payload, k)))
      return {
        title: "Change which model endpoint is used",
        detail: `${show(payload, ENDPOINT_FIELDS)}\nEvery conversation is sent to this endpoint. A stored key is forgotten when the provider or the address changes.`,
      };
    return undefined;
  }

  if (tool === "sshs3_manage_s3_and_sync" && (op === "configure_s3_workspace" || op === "disconnect_s3_workspace"))
    return {
      title: op === "configure_s3_workspace" ? "Change where the team's workspace is synced to" : "Disconnect the team's shared workspace",
      detail: show(payload, ["endpoint", "region", "bucket", "prefix", "accessKeyId", "inviteCode"]).replace(/^(inviteCode): .*$/m, "$1: (given)") || op,
    };

  if (tool === "sshs3_manage_s3_and_sync" && op === "save_dir_sync_profile")
    return {
      title: "Set up syncing of a folder to a bucket",
      detail: `${show(payload, ["name", "localPath", "remotePath", "s3ProfileId", "direction", "intervalMinutes"]) || JSON.stringify(payload).slice(0, 600)}
What is in the folder is copied to the bucket.`,
    };

  if (tool === "sshs3_kb_manage" && (op === "ingest_local_folder" || op === "ingest_s3_prefix"))
    return {
      title: op === "ingest_local_folder" ? "Read a folder on this computer into the shared knowledge base" : "Read a bucket prefix into the shared knowledge base",
      detail: `${show(payload, ["folderPath", "path", "s3ProfileId", "idOrName", "profileId", "prefix", "cluster"])}\nWhat is read is shared with the team and given to agents.`,
    };

  if (tool === "sshs3_agent_and_mcp_manage") {
    if (op === "save_mcp_server")
      return {
        title: "Add or change an MCP server that agents can call",
        detail: `${show(payload, ["name", "transport", "command", "args", "url"])}\nA stdio server is a program started on this computer; an http server is an address tool calls are sent to.`,
      };
    if (op === "install_mcp_preset")
      return { title: "Install an MCP server from the list", detail: `${show(payload, ["presetId", "idOrName", "id", "name"])}\nInstalling starts the preset's program on this computer.` };
    if (op === "save_agent") {
      // The mode it would END UP with: a call that leaves the mode out keeps the one the
      // agent has, so rewriting an agent that already acts on its own is the same decision.
      const named = agentNamed(known.agents, payload, ["idOrName", "id", "name"]);
      const mode = isMode(payload.defaultMode) ? payload.defaultMode : named?.defaultMode;
      if (mode && actsAlone(mode, run))
        return {
          title: named
            ? `Change ${named.name}, an agent that acts on its own, without asking`
            : "Create an agent that acts on its own, without asking",
          detail: show(payload, ["name", "role", "defaultMode", "targetCluster", "mission"]),
        };
    }
    if (op === "run_agent_mission") {
      const agent = agentNamed(known.agents, payload, ["idOrName", "id", "name"]);
      if (agent && actsAlone(agent.defaultMode, run))
        return { title: `Start ${agent.name}, which acts on its own, without asking`, detail: show(payload, ["idOrName", "id", "name", "promptOverride"]) };
    }
    return undefined;
  }

  if (tool === "sshs3_manage_schedule" && op !== "list" && op !== "delete") {
    const q = (text(payload, "idOrTitle") || text(payload, "id") || text(payload, "title")).toLowerCase();
    const existing = q ? known.schedules.find((s) => s.id.toLowerCase() === q || s.title.toLowerCase() === q || s.title.toLowerCase().includes(q)) : undefined;
    // What the schedule will run as: asked for, else as it is, else the default of a new one.
    const mode: AgentMode = op === "toggle" ? (existing?.mode ?? "assisted") : isMode(payload.mode) ? payload.mode : (existing?.mode ?? "assisted");
    const switchesOn = op !== "toggle" || payload.enabled !== false;
    if (switchesOn && actsAlone(mode, run))
      return {
        title: `${op === "toggle" ? "Switch on" : "Save"} a schedule that acts on its own, without asking`,
        detail: `${show(payload, ["title", "idOrTitle", "prompt", "mode", "serverIdOrName", "intervalMinutes"])}\nA schedule runs on its own, with nobody there to answer.`,
      };
  }
  return undefined;
}
