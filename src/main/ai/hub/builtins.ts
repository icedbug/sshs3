import type { KbDocument, MemoryEntry, MissionAgent } from "../../../shared/types/aiHub";
import type { Snippet } from "../../../shared/types/snippets";

/**
 * What sshs3 ships outside demo mode: a small, neutral and generic set of defaults. The getBuiltin*
 * functions in demoWorkspace.ts serve these; the demo workspace's own fixtures (NetApp/Acme lab) are
 * built-in only in demo mode.
 *
 * Built-ins are not stored: they are merged into the user's lists when read. A built-in the user deletes
 * is remembered by id so it stays hidden (agents, KB documents and memories: hub
 * `preferences.dismissedBuiltinIds`; snippets: `hiddenBuiltinIds` in snippets.json). An id must therefore
 * never change, nor be reused for something else.
 */

/** When these defaults were last revised: built-ins carry a fixed time, not the launch time. */
const DEFAULTS_UPDATED_AT = Date.UTC(2026, 10, 5);

/** One general-purpose assistant. New objects on every call, so callers never share state. */
export function getDefaultAgents(): MissionAgent[] {
  return [
    {
      id: "builtin-agent-general",
      name: "General Assistant",
      role: "General-purpose assistant for servers, containers and storage",
      icon: "🤖",
      mission:
        "Help with everyday work on your servers: answer questions, explain command output and diagnose problems, starting with read-only checks.",
      systemPrompt: [
        "You are a general-purpose assistant for the servers, containers and storage the user manages in sshs3.",
        "- Start with read-only commands to understand the current state before you propose anything that changes it.",
        "- Explain what a command does before you run it, and ask before you run anything that changes the system.",
        "- Back up a configuration file before you edit it, and check the result after every change.",
      ].join("\n"),
      defaultMode: "assisted",
      allowedTools: ["all"],
      kbDocIds: [],
      mcpServerIds: [],
      updatedAt: DEFAULTS_UPDATED_AT,
      author: "sshs3",
    },
  ];
}

/** Generic Linux and Kubernetes diagnostics, all read-only. New objects on every call. */
export function getDefaultSnippets(): Snippet[] {
  return [
    { id: "builtin-snip-disk-usage", name: "Disk usage", command: "df -h" },
    { id: "builtin-snip-memory-usage", name: "Memory usage", command: "free -h" },
    {
      id: "builtin-snip-top-processes",
      name: "Top processes by CPU",
      command: "ps aux --sort=-%cpu | head -n 15",
    },
    {
      id: "builtin-snip-journal-errors",
      name: "Recent journal errors",
      command: "journalctl -p err -n 50 --no-pager",
    },
    {
      id: "builtin-snip-failed-services",
      name: "Failed systemd services",
      command: "systemctl --failed --no-pager",
    },
    {
      id: "builtin-snip-k8s-pods-not-running",
      name: "Kubernetes: pods not Running (completed ones excluded)",
      command: "kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded",
    },
    {
      id: "builtin-snip-k8s-warning-events",
      name: "Kubernetes: recent warning events",
      command: "kubectl get events -A --field-selector=type=Warning --sort-by=.lastTimestamp | tail -n 25",
    },
  ];
}

/** No knowledge-base documents: the knowledge base holds the user's own documents. */
export function getDefaultKbDocuments(): KbDocument[] {
  return [];
}

/** No pre-seeded skills or memories: memory is what the user and the AI record. */
export function getDefaultSkillsAndMemories(): MemoryEntry[] {
  return [];
}
