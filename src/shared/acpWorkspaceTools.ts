/** Workspace tools available to an external runner. Its token and target still limit this list. */
export const ACP_WORKSPACE_TOOLS = [
  { name: "list_servers", label: "List workspace servers", scope: "read" },
  { name: "server_facts", label: "Read recorded server facts", scope: "read" },
  { name: "recent_changes", label: "List recent server changes", scope: "read" },
  { name: "dependency_map", label: "Read service dependencies", scope: "read" },
  { name: "kb_search", label: "Search the team's knowledge base", scope: "read" },
  { name: "kb_read_page", label: "Read a knowledge base page", scope: "read" },
  { name: "tickets_list", label: "List the team's tickets", scope: "read" },
  { name: "run_command", label: "Request an approved command on this run's target", scope: "run" },
  { name: "change_with_check", label: "Request an approved change with a check and rollback", scope: "run" },
  { name: "command_status", label: "Read the status of a requested command", scope: "run" },
] as const;

type ToolName = (typeof ACP_WORKSPACE_TOOLS)[number]["name"];

// Older agent forms saved the direct assistant's identifiers for external runners too.
const legacyNames: Readonly<Partial<Record<string, readonly ToolName[]>>> = {
  sshs3_tickets: ["tickets_list"],
  terminal_command: ["run_command", "command_status"],
  sshs3_change: ["change_with_check", "command_status"],
  sshs3_kb_search: ["kb_search"],
  sshs3_kb_read_page: ["kb_read_page"],
};

/** Preserve unknown restrictions in the editor so simply opening and saving an agent cannot widen access. */
export function acpEditorTools(selected: readonly string[] = []): string[] {
  if (selected.includes("all")) return [];
  return [...new Set(selected.flatMap<string>(name => Object.hasOwn(legacyNames, name) ? legacyNames[name]! : [name]))];
}

/** Absent means use the token's scopes. An empty result means there is no workspace bridge for this run. */
export function acpWorkspaceAllowlist(selected?: readonly string[]): string[] | undefined {
  if (!selected?.length || selected.includes("all")) return undefined;
  const requested = new Set(acpEditorTools(selected));
  return ACP_WORKSPACE_TOOLS.filter(tool => requested.has(tool.name)).map(tool => tool.name);
}
