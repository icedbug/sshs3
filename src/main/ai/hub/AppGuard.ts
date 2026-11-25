import type { AgentMode, AgentSchedule, ChangeSecretField, MissionAgent } from "../../../shared/types/aiHub";

/**
 * The rules an agent runs under are not the agent's to change. Most of what
 * the management tools do is ordinary work in the app (save a snippet, tag a
 * server); a few operations move the fence itself: the safety rules,
 * which model endpoint the conversation and the stored key go to, programs
 * and addresses that agents may call, an agent or a schedule that acts on its
 * own without asking, where the team's data is synced to, and pulling a folder
 * of local files into the shared knowledge base. Those wait for a person, in
 * every mode: also in a conversation that otherwise only advises, where the
 * person is there to answer.
 */

export const MODE_ORDER: Record<AgentMode, number> = { advice: 0, plan: 1, assisted: 2, autonomous: 3 };
const RANK: Record<AgentMode, number> = MODE_ORDER;
/**
 * Autonomous agents and schedules act without a human in the loop, so
 * creating, modifying, or launching one always requires HITL approval — even
 * when requested from an already-autonomous run.
 */
const actsAlone = (mode: AgentMode, _run?: { mode: AgentMode }): boolean => mode === "autonomous";
const isMode = (value: unknown): value is AgentMode =>
  value === "advice" || value === "plan" || value === "assisted" || value === "autonomous";

/** The more careful of two modes. */
export const lowerMode = (a: AgentMode, b: AgentMode | undefined): AgentMode => (b && RANK[b] < RANK[a] ? b : a);

/** What each operation of the management tools is, for the one test that keeps this list whole. */
export type AppOpClass = "read" | "change" | "guard" | "guard-if";
export const APP_OPS: Record<string, { fallback: string; ops: Record<string, AppOpClass> }> = {
  sshs3_manage_server: { fallback: "upsert", ops: { upsert: "guard-if", update_metadata: "change", delete: "change", set_local_override: "change", list_tunnels: "read", save_tunnel: "guard-if", delete_tunnel: "change" } },
  sshs3_manage_cluster_and_folders: { fallback: "assign_cluster", ops: { assign_cluster: "change", create_folder: "change", rename_folder: "change", delete_folder: "change" } },
  sshs3_manage_memory_and_activity: { fallback: "save", ops: { save: "guard-if", list: "read", delete: "change", feedback: "change", self_reflect: "change", log_activity: "change", core_append: "guard-if", core_replace: "guard-if" } },
  // A schedule runs later with nobody there: it always requires approval if autonomous (or when tainted).
  sshs3_manage_schedule: { fallback: "list", ops: { list: "read", save: "guard-if", delete: "change", toggle: "guard-if" } },
  sshs3_manage_s3_and_sync: {
    fallback: "status",
    ops: { status: "read", list_dir_sync_profiles: "read", sync_now: "change", configure_s3_workspace: "guard", disconnect_s3_workspace: "guard", upsert_s3_profile: "change", delete_s3_profile: "change", save_dir_sync_profile: "guard", delete_dir_sync_profile: "change" },
  },
  sshs3_manage_app_and_settings: {
    fallback: "get_state",
    ops: { get_state: "read", update_settings: "guard-if", configure_ai: "guard-if", update_shortcuts: "guard-if", update_safety_policy: "guard", list_dotfiles: "read", save_dotfile: "guard-if", delete_dotfile: "change", list_snippets: "read", save_snippet: "change", delete_snippet: "change", open_local_terminal: "change",
      // Which model profiles there are, and the rules a team server's administrators set for everyone.
      list_model_profiles: "read", save_model_profile: "guard", delete_model_profile: "guard", test_model: "change",
      get_team_rules: "read", update_team_rules: "guard", restore_builtin_agents: "guard",
    },
  },
  sshs3_kb_manage: { fallback: "list", ops: { list: "read", add_document: "guard-if", delete_document: "change", ingest_local_folder: "guard", ingest_s3_prefix: "guard" } },
  sshs3_tickets: { fallback: "list", ops: { list: "read", read: "read", create: "change", comment: "change" } },
  sshs3_chat_history: { fallback: "search", ops: { search: "read", thread: "read", channels: "read" } },
  sshs3_workspace_layout: { fallback: "open_terminal", ops: { open_terminal: "change", open_cluster_split: "change", open_dual_pane_explorer: "change" } },
  sshs3_storage_ops: { fallback: "list_files", ops: { list_files: "read", read_remote_file: "read", diff_paths: "read" } },
  sshs3_investigate: { fallback: "investigate", ops: { investigate: "read" } },
  sshs3_agent_and_mcp_manage: {
    fallback: "list",
    ops: { list: "read", run_workforce: "read", delegate_to_agent: "change", handoff_agent: "change", install_mcp_preset: "guard", save_infra_edge: "change", delete_infra_edge: "change", save_agent: "guard-if", delete_agent: "change", run_agent_mission: "guard-if", save_mcp_server: "guard", delete_mcp_server: "change", test_mcp_server: "change",
      // Programs that run as external agents, what an MCP tool may do unasked, and the keys other agents reach this app with.
      save_runner: "guard", delete_runner: "guard", test_runner: "guard", set_mcp_tool_policy: "guard",
      list_mcp_keys: "read", create_mcp_key: "guard", revoke_mcp_key: "guard", set_local_mcp_server: "guard",
    },
  },
  // The two chat bots of a team server: the context bot that only reads, and the agent bot that answers.
  sshs3_manage_team_chat: {
    fallback: "status",
    ops: {
      status: "read",
      context_connect: "guard", context_test: "change", context_disconnect: "guard", context_select_channel: "guard-if",
      context_read_back: "change", context_forget: "guard", context_retention: "guard",
      agent_connect: "guard", agent_disconnect: "guard", agent_settings: "guard", agent_set_channel: "guard", agent_remove_channel: "change",
      agent_copy_model: "guard", agent_new_ssh_key: "guard", agent_conversations: "read", agent_conversation: "read", agent_try: "guard",
      link_code: "guard", unlink: "guard-if",
    },
  },
  // Where sshs3 sends word, what it is connected to, what it collects by itself, and what starts on an alert.
  sshs3_manage_alerts_and_integrations: {
    fallback: "status",
    ops: {
      status: "read",
      save_notify_channel: "guard", delete_notify_channel: "guard", test_notify_channel: "change", notify_settings: "guard",
      atlassian_connect: "guard", atlassian_test: "change", atlassian_disconnect: "guard", jira_sync_now: "change",
      facts_configure: "guard", facts_collect_now: "guard",
      alert_hook_create: "guard", alert_hook_disable: "guard", alert_rules_save: "guard",
    },
  },
};

const SAFETY_FIELDS = ["safetyPolicy", "requireApprovalOnProdTags"];
const ENDPOINT_FIELDS = ["aiProvider", "aiBaseUrl", "aiEnabled"];
const SERVER_HOST_PROXY_FIELDS = ["host", "port", "username", "proxyJump", "proxyJumpProfileId", "extraOptions", "privateKeyPath", "pkcs11LibPath", "forwardAgent"];
/**
 * App settings an agent may change on its own: how things look. Everything
 * else (which image a debug pod runs, which PKCS#11 library ssh loads, the X11
 * server, sync, logging, updates, transfer limits …) reaches beyond the screen
 * and is a person's to change.
 */
const HARMLESS_APP_SETTINGS = new Set([
  "theme",
  "terminalFontSize",
  "terminalFontFamily",
  "terminalScrollback",
  "scrollbackLines",
  "terminalCursorStyle",
  "cursorStyle",
  "cursorBlink",
  "showHiddenFiles",
  "perfMetricsEnabled",
  "perfMetricsLayout",
  "perfMetricsItems",
  "perfMetricsIntervalSec",
  "perfBarVisible",
  "perfBarLayout",
  "defaultNewTabType",
]);
/** The app settings the settings tool knows (see AppActions). Any of them outside the harmless list is asked about. */
const APP_SETTING_FIELDS = [
  "defaultNewTabType", "copyOnSelect", "rightClickPaste", "clipboardHistoryScope", "clipboardHistoryClearOnExit",
  "sessionExitAction", "localTerminalAgentMode", "autoSyncLocalSshConfig", "confirmBeforeQuit", "confirmBeforeDelete",
  "defaultConflictPolicy", "verifyTransferIntegrity", "fileManagerGitIntegration", "shareFoldersAcrossTypes",
  "maxConcurrentTransfers", "maxBandwidthBps", "enableOpenShift", "k8sDebugImages", "smartcardAuthMode",
  "smartcardUnlockAtStartup", "smartcardLibPath", "x11ServerMode", "x11ServerPath", "x11ServerArgs",
  "dotfilesPoolEnabled", "logLevel", "autoCheckUpdates",
];

export interface GuardAsk {
  /** What is asked for, in a line a person reads in the inbox. */
  title: string;
  /** Exactly what would change. */
  detail: string;
  /**
   * Secrets the setting needs that the call did not carry. The person types them on the approval card,
   * so a token never has to be written in the conversation, where the model's provider would read it.
   */
  secrets?: ChangeSecretField[];
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

/** The same, for the tools whose deletes take away different kinds of thing. */
const REMOVES_BY_OP: Record<string, string> = {
  delete_model_profile: "a model profile",
  delete_runner: "an external agent's program",
  delete_notify_channel: "a notification channel",
};

/**
 * The secrets a setting takes are always asked for on the card. A call that carries one itself never
 * gets here: it is refused before anybody is asked (precheckSettingsOp), so nothing a person approves
 * rides along unseen.
 */
const askFor = (fields: ChangeSecretField[]): ChangeSecretField[] => fields;
const lines = (...parts: Array<string | undefined>): string => parts.filter((part): part is string => Boolean(part)).join("\n");

/** The settings tools that are wholly about the rules agents run under: one question per operation. */
function settingAsk(tool: string, op: string, payload: Record<string, unknown>, tainted: boolean): GuardAsk | undefined {
  if (tool === "sshs3_manage_app_and_settings") {
    if (op === "save_model_profile")
      return {
        title: "Add or change a model profile",
        detail: lines(
          show(payload, ["idOrName", "name", "provider", "model", "baseUrl", "apiProtocol", "activeRole", "egressPolicy", "embeddingModel", "reasoningEffort", "temperature", "maxOutputTokens", "contextWindowTokens"]),
          "Conversations that use this profile are sent to its address, with its key.",
        ),
        secrets: askFor([{ key: "apiKey", label: "the API key", optional: true }]),
      };
    if (op === "update_team_rules")
      return {
        title: "Change the rules for everyone on this server",
        detail: lines(show(payload, ["requirePeerApprovalOnProd", "freezeCluster", "freezeHours", "freezeWhy", "endFreeze"]), "Only an administrator of the server can change these."),
      };
    if (op === "restore_builtin_agents") return { title: "Put the built-in agents back as they were", detail: "Changes made to the built-in agents are lost." };
    return undefined;
  }

  if (tool === "sshs3_agent_and_mcp_manage") {
    if (op === "save_runner")
      return {
        title: "Add or change a program that runs as an external agent",
        detail: lines(show(payload, ["idOrName", "name", "command", "args", "cwd", "env"]), "The program is started on this computer, as you. It is given the path, home folder, language, terminal, temporary folder and proxy settings of this app's environment, and the variables listed under env."),
      };
    if (op === "test_runner") return { title: "Start an external agent's program once, to see that it answers", detail: show(payload, ["idOrName"]) || op };
    if (op === "set_mcp_tool_policy")
      return {
        title: "Change what an MCP tool may do without asking",
        detail: lines(show(payload, ["serverIdOrName", "toolName", "policy"]), "allow: it runs unasked. ask: a person approves each call. deny: it never runs."),
      };
    if (op === "create_mcp_key")
      return {
        title: "Make a key that lets another agent reach this app",
        detail: lines(
          show(payload, ["name", "scopes", "serverIdOrName", "expiresInDays", "neverExpires", "tools"]),
          payload.neverExpires === true ? "This key never stops working." : payload.expiresInDays === undefined ? "The key works for 30 days." : "",
          "The key is shown to you once, on this card. It is not given to the agent in this conversation.",
        ),
      };
    if (op === "revoke_mcp_key") return { title: "Take back a key another agent reaches this app with", detail: show(payload, ["idOrName"]) || op };
    if (op === "set_local_mcp_server")
      return { title: payload.enabled === false ? "Switch off this app's own MCP server" : "Switch on this app's own MCP server", detail: lines(show(payload, ["enabled", "port"]), "Other agents on this computer reach sshs3 through it, with a key.") };
    return undefined;
  }

  if (tool === "sshs3_manage_team_chat") {
    if (op === "context_connect")
      return {
        title: "Connect the context bot, which reads chosen channels",
        detail: lines(show(payload, ["service", "baseUrl", "enabled"]), "What the team writes in the channels you then choose is kept here and given to agents that search it."),
        secrets: askFor([{ key: "token", label: "the context bot's token", optional: true }]),
      };
    if (op === "context_disconnect")
      return { title: "Disconnect the context bot", detail: lines(show(payload, ["service", "forget"]), payload.forget === true ? "What it read is removed too." : undefined) };
    if (op === "context_select_channel" && payload.selected !== false)
      return { title: "Let the context bot read one more channel", detail: lines(show(payload, ["service", "channel"]), "What is written there is kept here and given to agents that search it.") };
    if (op === "context_forget") return { title: "Remove what the context bot read", detail: show(payload, ["service", "channel"]) || "Everything it read, in every channel." };
    if (op === "context_retention")
      return {
        title: "Change how long the team's chat is kept",
        detail: lines(show(payload, ["days"]), payload.days === 0 ? "0 days: messages are kept until somebody removes them." : "Messages older than this are removed."),
      };
    if (op === "agent_connect")
      return {
        title: "Connect the agent bot, which answers people in chat",
        detail: lines(show(payload, ["service", "baseUrl", "enabled"]), "It must be its own Slack app or bot account, not the context bot's."),
        secrets: askFor([
          { key: "token", label: "the agent bot's token", optional: true },
          ...(text(payload, "service").toLowerCase() === "slack" ? [{ key: "appToken", label: "the Slack app-level token (xapp-)", optional: true }] : []),
        ]),
      };
    if (op === "agent_disconnect") return { title: "Disconnect the agent bot", detail: show(payload, ["service"]) || op };
    if (op === "agent_settings")
      return {
        title: "Change how the agent bot answers in chat",
        detail:
          show(payload, ["enabled", "dmsEnabled", "dmsUnlinked", "dmsServers", "dmsClusters", "personNewPerHour", "personMessagesPerHour", "channelPerHour", "concurrentRuns", "monthlyTokenBudget", "approvalWaitMinutes"]) || op,
      };
    if (op === "agent_set_channel")
      return {
        title: "Let people in a chat channel ask the agent bot",
        detail: lines(
          show(payload, ["service", "channelId", "channelName", "servers", "clusters", "reach", "agentId", "approvers", "historyFrom"]),
          "Anyone in that channel can then make the agent work on these servers, as far as the reach allows.",
          has(payload, "channelName") ? "The channel's name is as the assistant wrote it. The id decides which channel it is: check it in the chat." : undefined,
        ),
      };
    if (op === "agent_copy_model") return { title: "Give the chat agent your model", detail: "Its conversations are then sent to your model's address, with your key and your data policy." };
    if (op === "agent_new_ssh_key") return { title: "Make a new SSH key for the agent bot", detail: "The old key stops working. The new public key must be added on every server the bot may reach." };
    if (op === "agent_try")
      return {
        title: "Write to the agent bot in a simulated chat",
        detail: lines(show(payload, ["channel", "as", "text"]), "The chat agent really runs, with its own model and servers. Nothing is sent to Slack or Mattermost."),
      };
    if (op === "link_code")
      return {
        title: "Make a code that links a chat account to your sshs3 account",
        detail: lines(show(payload, ["service"]), "Whoever sends the code to the agent bot can then approve in chat as you. It is shown to you once, on this card, and not given to the agent in this conversation."),
      };
    // Taking away one's own link is ordinary; somebody else's is an administrator's decision.
    if (op === "unlink" && (has(payload, "chatUserId") || tainted)) return { title: "Unlink a person's chat account", detail: show(payload, ["service", "chatUserId"]) || op };
    return undefined;
  }

  if (tool === "sshs3_manage_alerts_and_integrations") {
    if (op === "save_notify_channel") {
      // A channel is changed by its name or id. Without one a new channel is added, and nothing is saved yet to keep.
      const changing = has(payload, "idOrName");
      return {
        title: "Add or change where notifications are sent",
        detail: lines(
          show(payload, ["idOrName", "kind", "name", "enabled", "events", "includeCommand", "alertMinSeverity"]),
          `What waits for an answer is sent to the address you type below, with the command when includeCommand is on. ${
            changing ? "Left empty, the address already saved is kept." : "A new channel needs its address."
          }`,
        ),
        secrets: askFor([
          changing
            ? { key: "url", label: "the channel's address (the webhook URL)", optional: true }
            : { key: "url", label: "the channel's address (the webhook URL)" },
          ...(text(payload, "kind").toLowerCase() === "webhook"
            ? [
                changing
                  ? { key: "secret", label: "the secret that signs the webhook", optional: true }
                  : { key: "secret", label: "the secret that signs the webhook", ifEmpty: "Leave it empty to send without a signature." },
              ]
            : []),
        ]),
      };
    }
    if (op === "notify_settings")
      return {
        title: "Change the notification settings",
        detail: lines(show(payload, ["publicUrl", "reminderMinutes", "quietHours", "noiseBudgetPerHour"]), has(payload, "publicUrl") ? "Links in notifications point to this address." : undefined),
      };
    if (op === "atlassian_connect")
      return {
        title: `Connect ${text(payload, "product").toLowerCase() === "confluence" ? "Confluence" : "Jira"}`,
        detail: lines(
          show(payload, ["product", "variant", "baseUrl", "email", "enabled", "projects", "doneTransition", "closeOnApprove"]),
          "sshs3 then reads from that address as you, and writes ticket comments and moves there. What is not named here stays as it is.",
        ),
        secrets: askFor([{ key: "token", label: "the API token", optional: true }]),
      };
    if (op === "atlassian_disconnect") return { title: "Disconnect Jira or Confluence", detail: show(payload, ["product"]) || op };
    if (op === "facts_configure")
      return {
        title: "Change what sshs3 collects from servers by itself",
        detail: lines(
          show(payload, ["enabled", "intervalHours", "exclude", "watchPaths"]),
          "It runs read-only commands on every server that is not excluded, on a timer, and reads the watched files.",
          has(payload, "exclude") ? "exclude is the whole list: a server that is not on it is collected from." : undefined,
          has(payload, "watchPaths") ? "watchPaths is the whole list." : undefined,
        ),
      };
    if (op === "facts_collect_now")
      return {
        title: "Collect facts from servers now",
        detail: lines(show(payload, ["serverIdOrName"]) || "Every server that is not excluded.", "It runs its read-only commands there now, also when collecting is switched off."),
      };
    if (op === "alert_hook_create")
      return {
        title: "Make an address that monitoring can send alerts to",
        detail: "Whoever has the address can make alerts appear here. A new one replaces the old. It is shown to you once, on this card.",
      };
    if (op === "alert_hook_disable") return { title: "Switch off the address monitoring sends alerts to", detail: "Alerts sent to it are refused from then on." };
    if (op === "alert_rules_save")
      return { title: "Change which agent starts on which alert", detail: lines(show(payload, ["rules"]), "An agent named here starts by itself when a matching alert arrives.") };
    return undefined;
  }
  return undefined;
}

export function guardAsk(
  tool: string,
  payload: Record<string, unknown>,
  run: { mode: AgentMode; tainted?: boolean },
  known: { agents: Pick<MissionAgent, "id" | "name" | "defaultMode">[]; schedules: Pick<AgentSchedule, "id" | "title" | "mode">[] },
): GuardAsk | undefined {
  const spec = APP_OPS[tool];
  if (!spec) return undefined;
  const op = text(payload, "operation") || spec.fallback;
  const tainted = Boolean(run.tainted);

  // Taking something the team has out of the workspace — a server, an agent, a
  // source, a profile — is a person's decision in every mode. An agent that is
  // trusted to act on its own is trusted to change systems, not to make the
  // team's own things disappear; and what is deleted here is not always what
  // the model meant to name.
  if (op.startsWith("delete") && spec.ops[op] !== "read")
    return {
      title: `Remove ${REMOVES_BY_OP[op] ?? REMOVES[tool] ?? "something"} from this workspace`,
      detail: show(payload, ["idOrName", "idOrTitle", "id", "name", "title", "folderName", "cluster", "s3ProfileId", "edgeId"]),
    };

  // The operations that are wholly about sshs3's own rules and connections. Asked by the operation's
  // name: each has a handler of its own, which takes no other operation's fields.
  const setting = settingAsk(tool, op, payload, tainted);
  if (setting) return setting;

  if (tool === "sshs3_manage_server" && tainted) {
    if (op === "save_tunnel")
      return {
        title: "Create or change an SSH tunnel from a tainted run",
        detail: show(payload, ["serverIdOrName", "tunnelIdOrName", "tunnelName", "tunnelType", "localPort", "remoteHost", "remotePort"]) || op,
      };
    if (op === "upsert" && SERVER_HOST_PROXY_FIELDS.some((k) => has(payload, k)))
      return {
        title: "Create or change server host or proxy settings from a tainted run",
        detail: show(payload, ["serverIdOrName", "name", ...SERVER_HOST_PROXY_FIELDS]) || op,
      };
  }

  if (tool === "sshs3_manage_memory_and_activity" && tainted) {
    if (op === "core_append" || op === "core_replace")
      return {
        title: "Modify core pinned workspace memory from a tainted run",
        detail: show(payload, ["idOrTitle", "title", "scope", "tier", "text"]) || op,
      };
    if (op === "save") {
      const scope = (text(payload, "scope") || "workspace").toLowerCase();
      if (scope !== "personal")
        return {
          title: "Save shared workspace memory from a tainted run",
          detail: show(payload, ["title", "idOrTitle", "scope", "kind", "tier", "text"]) || op,
        };
    }
  }

  if (tool === "sshs3_manage_app_and_settings") {
    // The fields decide, not the operation's name: the same handler takes them under any of its names.
    if (SAFETY_FIELDS.some((k) => has(payload, k)))
      return { title: "Change the safety rules", detail: show(payload, SAFETY_FIELDS) };
    if (ENDPOINT_FIELDS.some((k) => has(payload, k)))
      return {
        title: "Change which model endpoint is used",
        detail: `${show(payload, ENDPOINT_FIELDS)}\nEvery conversation is sent to this endpoint. A stored key is forgotten when the provider or the address changes.`,
      };
    const reaching = APP_SETTING_FIELDS.filter((k) => has(payload, k) && !HARMLESS_APP_SETTINGS.has(k));
    if (reaching.length)
      return {
        title: "Change app settings that reach beyond the screen",
        detail: show(payload, reaching),
      };
    if (op === "save_dotfile" && tainted)
      return {
        title: "Save a synced dotfile from a tainted run",
        detail: show(payload, ["poolId", "poolName", "remotePath", "mode"]) || op,
      };
    return undefined;
  }

  if (tool === "sshs3_manage_s3_and_sync" && op === "disconnect_s3_workspace")
    return { title: "Disconnect the team's shared workspace", detail: op };
  // The keys and the invite code (which holds them) are typed on the card: a call that carries one is refused
  // before anybody is asked (AppActions.ts, refuseCarriedSecrets).
  if (tool === "sshs3_manage_s3_and_sync" && op === "configure_s3_workspace") {
    const where = show(payload, ["endpoint", "region", "bucket", "prefix", "enabled"]);
    return has(payload, "bucket")
      ? {
          title: "Change where the team's workspace is synced to",
          detail: lines(where, "Type the bucket's keys below."),
          secrets: askFor([
            { key: "accessKeyId", label: "the access key ID", optional: true },
            { key: "secretAccessKey", label: "the secret access key", optional: true },
          ]),
        }
      : {
          title: "Connect the team's shared workspace with an invite code",
          detail: lines(where, "Type the invite code below. It names the bucket and holds its keys."),
          secrets: askFor([{ key: "inviteCode", label: "the invite code" }]),
        };
  }

  if (tool === "sshs3_manage_s3_and_sync" && op === "save_dir_sync_profile")
    return {
      title: "Set up syncing of a folder to a bucket",
      detail: `${show(payload, ["name", "localPath", "remotePath", "s3ProfileId", "direction", "intervalMinutes"]) || JSON.stringify(payload).slice(0, 600)}
What is in the folder is copied to the bucket.`,
    };

  if (tool === "sshs3_kb_manage") {
    if (op === "ingest_local_folder" || op === "ingest_s3_prefix")
      return {
        title: op === "ingest_local_folder" ? "Read a folder on this computer into the shared knowledge base" : "Read a bucket prefix into the shared knowledge base",
        detail: `${show(payload, ["folderPath", "path", "s3ProfileId", "idOrName", "profileId", "prefix", "cluster"])}\nWhat is read is shared with the team and given to agents.`,
      };
    if (op === "add_document" && tainted)
      return {
        title: "Add a document to the shared knowledge base from a tainted run",
        detail: show(payload, ["title", "cluster", "tags", "content"]) || op,
      };
  }

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
      if (has(payload, "systemPrompt") || has(payload, "allowedTools") || tainted)
        return {
          title: named
            ? `Change ${named.name}'s prompt or tool permissions`
            : "Create an agent with custom prompt or tool permissions",
          detail: show(payload, ["idOrName", "name", "role", "defaultMode", "systemPrompt", "allowedTools", "targetCluster", "mission"]) || op,
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
    if (switchesOn && (actsAlone(mode, run) || tainted))
      return {
        title: `${op === "toggle" ? "Switch on" : "Save"} a schedule that ${actsAlone(mode, run) ? "acts on its own, without asking" : "was requested by a tainted run"}`,
        detail: `${show(payload, ["title", "idOrTitle", "prompt", "mode", "serverIdOrName", "intervalMinutes"])}\nA schedule runs on its own, with nobody there to answer.`,
      };
  }
  return undefined;
}
