import type {
  KbDocument,
  MemoryEntry,
  MissionAgent,
  RunbookTemplate,
} from "../../../shared/types/aiHub";
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
    {
      id: "builtin-snip-listening-ports",
      name: "Starter: Listening TCP/UDP ports",
      command: "ss -tulpen",
    },
    {
      id: "builtin-snip-inode-usage",
      name: "Starter: Filesystem inode usage",
      command: "df -i",
    },
    {
      id: "builtin-snip-uptime-load",
      name: "Starter: Host uptime, load & kernel",
      command: "uname -a && uptime",
    },
  ];
}

export interface StarterChecklistItem {
  id: string;
  label: string;
  command: string;
  expected: string;
}

export interface StarterInspectionChecklist {
  id: string;
  title: string;
  description: string;
  category: "linux" | "kubernetes" | "network";
  readOnly: true;
  starter: true;
  items: StarterChecklistItem[];
  promptTemplate: string;
}

export interface StarterKbTemplate {
  id: string;
  title: string;
  kind: NonNullable<KbDocument["kind"]>;
  summary: string;
  tags: string[];
  starter: true;
  content: string;
}

/**
 * Zero-config, read-only starter runbook templates for first-time non-demo users.
 * Every step uses read-only `check` or `ai_diagnose` operations (never mutating commands).
 * New objects on every call.
 */
export function getDefaultRunbookTemplates(): RunbookTemplate[] {
  return [
    {
      id: "builtin-rb-host-triage",
      name: "Starter: Linux Host Health Triage (Read-Only)",
      description:
        "Safe first-pass inspection of disk space, inodes, memory, failed services, and recent journal errors.",
      inputs: [],
      steps: [
        {
          id: "step-disk",
          title: "Check filesystem space",
          kind: "check",
          command: "df -h",
          expected: "All mounted filesystems below 85% capacity",
        },
        {
          id: "step-inodes",
          title: "Check filesystem inodes",
          kind: "check",
          command: "df -i",
          expected: "Inode usage below 85% on critical mounts",
        },
        {
          id: "step-memory",
          title: "Check memory and swap",
          kind: "check",
          command: "free -h",
          expected: "Available memory healthy and swap not thrashing",
        },
        {
          id: "step-systemd",
          title: "Check failed systemd units",
          kind: "check",
          command: "systemctl --failed --no-pager",
          expected: "0 loaded units listed as failed",
        },
        {
          id: "step-journal",
          title: "Inspect recent error logs",
          kind: "check",
          command: "journalctl -p err -n 50 --no-pager",
          expected: "No recurring critical errors",
        },
        {
          id: "step-summarize",
          title: "Summarize findings (no changes)",
          kind: "ai_diagnose",
          prompt:
            "Summarize the read-only host triage outputs above, highlight any saturated resources or failed units, and recommend safe next checks without making changes.",
        },
      ],
      dispatchStrategy: "sequential",
      author: "sshs3",
      createdAt: DEFAULTS_UPDATED_AT,
      updatedAt: DEFAULTS_UPDATED_AT,
    },
    {
      id: "builtin-rb-k8s-triage",
      name: "Starter: Kubernetes Namespace Triage (Read-Only)",
      description:
        "Inspect non-running pods, recent warning events, and node status in a namespace without altering cluster state.",
      inputs: [
        {
          name: "namespace",
          label: "Namespace",
          type: "string",
          required: true,
          defaultValue: "default",
          description: "Kubernetes namespace to inspect",
        },
      ],
      steps: [
        {
          id: "step-nodes",
          title: "Check cluster node readiness",
          kind: "check",
          command: "kubectl get nodes",
          expected: "All nodes report Ready",
        },
        {
          id: "step-pods",
          title: "List non-running pods in namespace",
          kind: "check",
          command:
            "kubectl get pods -n {{namespace}} --field-selector=status.phase!=Running,status.phase!=Succeeded",
          expected: "No pods stuck in Pending, CrashLoopBackOff, or Failed",
        },
        {
          id: "step-events",
          title: "Inspect recent namespace warning events",
          kind: "check",
          command:
            "kubectl get events -n {{namespace}} --field-selector=type=Warning --sort-by=.lastTimestamp | tail -n 25",
          expected: "No active scheduling, probe, or image-pull errors",
        },
        {
          id: "step-diagnose",
          title: "Correlate pod and event findings",
          kind: "ai_diagnose",
          prompt:
            "Review the node, pod, and warning event outputs above. Identify root causes and propose read-only follow-up commands (such as kubectl describe or logs).",
        },
      ],
      dispatchStrategy: "sequential",
      author: "sshs3",
      createdAt: DEFAULTS_UPDATED_AT,
      updatedAt: DEFAULTS_UPDATED_AT,
    },
    {
      id: "builtin-rb-network-tls",
      name: "Starter: Network & TLS Endpoint Check (Read-Only)",
      description:
        "Verify listening sockets and inspect remote TLS certificate validity dates safely.",
      inputs: [
        {
          name: "host",
          label: "Target hostname",
          type: "string",
          required: true,
          defaultValue: "localhost",
          description: "Hostname for SNI and TLS certificate inspection",
        },
        {
          name: "port",
          label: "Port",
          type: "number",
          required: true,
          defaultValue: 443,
          description: "TCP port to inspect",
        },
      ],
      steps: [
        {
          id: "step-sockets",
          title: "List local listening sockets",
          kind: "check",
          command: "ss -tulpen",
          expected: "Expected services are bound and listening",
        },
        {
          id: "step-dns",
          title: "Resolve target host DNS",
          kind: "check",
          command: "getent hosts {{host}}",
          expected: "Hostname resolves to expected address(es)",
        },
        {
          id: "step-tls",
          title: "Inspect TLS certificate dates",
          kind: "check",
          command:
            "openssl s_client -connect {{host}}:{{port}} -servername {{host}} -brief",
          expected: "Certificate chain and protocol negotiate cleanly",
        },
      ],
      dispatchStrategy: "sequential",
      author: "sshs3",
      createdAt: DEFAULTS_UPDATED_AT,
      updatedAt: DEFAULTS_UPDATED_AT,
    },
  ];
}

/**
 * Zero-config 1-click safe inspection checklists for first-time non-demo users.
 * Every command is strictly read-only. New objects on every call.
 */
export function getDefaultInspectionChecklists(): StarterInspectionChecklist[] {
  return [
    {
      id: "builtin-chk-linux-health",
      title: "Starter: Linux Host Health Checklist",
      description: "Read-only baseline for CPU load, memory, disk space, inodes, and failed services.",
      category: "linux",
      readOnly: true,
      starter: true,
      items: [
        {
          id: "chk-uptime",
          label: "Uptime & load average",
          command: "uname -a && uptime",
          expected: "Load average within core count",
        },
        {
          id: "chk-disk",
          label: "Filesystem usage",
          command: "df -h",
          expected: "Free space above 15% on all mounts",
        },
        {
          id: "chk-inodes",
          label: "Inode usage",
          command: "df -i",
          expected: "Inode utilization below 85%",
        },
        {
          id: "chk-mem",
          label: "Memory & swap pressure",
          command: "free -h",
          expected: "Healthy available memory",
        },
        {
          id: "chk-services",
          label: "Failed systemd services",
          command: "systemctl --failed --no-pager",
          expected: "No failed units",
        },
      ],
      promptTemplate:
        "Run a strictly read-only health inspection on the current host (uptime, df -h, df -i, free -h, systemctl --failed --no-pager) and summarize any anomalies.",
    },
    {
      id: "builtin-chk-k8s-quick",
      title: "Starter: Kubernetes Quick Inspection",
      description: "Read-only overview of cluster nodes, unhealthy pods, and recent warning events.",
      category: "kubernetes",
      readOnly: true,
      starter: true,
      items: [
        {
          id: "chk-k8s-nodes",
          label: "Node readiness",
          command: "kubectl get nodes",
          expected: "All nodes Ready",
        },
        {
          id: "chk-k8s-pods",
          label: "Non-running pods",
          command: "kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded",
          expected: "Zero failing or stuck pods",
        },
        {
          id: "chk-k8s-events",
          label: "Recent warning events",
          command: "kubectl get events -A --field-selector=type=Warning --sort-by=.lastTimestamp | tail -n 25",
          expected: "No ongoing warning bursts",
        },
      ],
      promptTemplate:
        "Run a read-only Kubernetes cluster check (nodes, non-running pods, recent warning events) and explain what needs attention.",
    },
    {
      id: "builtin-chk-network-ports",
      title: "Starter: Network & Socket Inspection",
      description: "Read-only view of listening TCP/UDP sockets and top processes.",
      category: "network",
      readOnly: true,
      starter: true,
      items: [
        {
          id: "chk-ports",
          label: "Listening TCP/UDP sockets",
          command: "ss -tulpen",
          expected: "Only expected ports are listening",
        },
        {
          id: "chk-procs",
          label: "Top CPU processes",
          command: "ps aux --sort=-%cpu | head -n 15",
          expected: "No runaway network or worker process",
        },
      ],
      promptTemplate:
        "Inspect listening ports (ss -tulpen) and top processes (ps aux --sort=-%cpu | head -n 15) read-only, flagging unexpected listeners or CPU spikes.",
    },
  ];
}

/**
 * Opt-in starter knowledge-base runbook templates (non-destructive, zero demo references)
 * that a new user can adopt with 1 click without polluting an empty KB by default.
 */
export function getDefaultKbTemplates(): StarterKbTemplate[] {
  return [
    {
      id: "builtin-kb-tpl-incident-triage",
      title: "Starter Template: Safe Incident Triage Runbook",
      kind: "runbook",
      summary: "Non-destructive read-only triage sequence for high CPU, full disks, or failing services.",
      tags: ["starter", "triage", "read-only"],
      starter: true,
      content: [
        "# Safe Incident Triage Runbook (Starter Template)",
        "",
        "1. **Verify host identity & load**: `uname -a && uptime`",
        "2. **Check disk & inode saturation**: `df -h` and `df -i`",
        "3. **Check memory & top processes**: `free -h` and `ps aux --sort=-%cpu | head -n 15`",
        "4. **Check failed services & recent errors**: `systemctl --failed --no-pager` and `journalctl -p err -n 50 --no-pager`",
        "5. **Before any change**: Use `/plan` (or Plan mode) with an explicit verification command and rollback step.",
      ].join("\n"),
    },
    {
      id: "builtin-kb-tpl-change-checklist",
      title: "Starter Template: Pre-Change Verification Checklist",
      kind: "reference",
      summary: "Pre-flight, verification, and rollback checklist for production configuration edits.",
      tags: ["starter", "change-management", "safety"],
      starter: true,
      content: [
        "# Pre-Change Verification Checklist (Starter Template)",
        "",
        "- Confirm target host/cluster and check recent team activity for colliding edits.",
        "- Capture a read-only baseline (`nginx -t`, `ss -tulpen`, or service status) before changing anything.",
        "- Specify an exit-0 verification command and a concrete rollback command for medium/high risk steps.",
        "- Require peer review before applying changes tagged production or critical.",
      ].join("\n"),
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
