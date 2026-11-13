import path from "node:path";
import { app, } from "electron";
import type {
  WorkspaceServerSummary,
} from "../../../shared/types/aiHub";
import { createTwoFilesPatch } from "diff";


export function insideDataDirectory(file: string): boolean {
  try {
    const relative = path.relative(app.getPath("userData"), path.resolve(file));
    return (
      relative !== "" &&
      !path.isAbsolute(relative) &&
      relative.split(path.sep)[0] !== ".."
    );
  } catch {
    return false;
  }
}
/**
 * Secret values (an MCP server's environment and headers) as they come back
 * from a form that was never shown them: an empty value keeps what is stored
 * under that name, a typed value replaces it, a name that is gone is removed.
 * Nothing given at all keeps everything.
 */
export function keepSecrets(
  stored: Record<string, string> | undefined,
  given: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (given === undefined) return stored;
  const out: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(given)) {
    const name = rawName.trim();
    if (!name || typeof value !== "string") continue;
    if (value !== "") out[name] = value;
    else if (stored?.[name] !== undefined) out[name] = stored[name];
  }
  return Object.keys(out).length ? out : undefined;
}

export function requiredText(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Text is required");
  return value;
}
export function integer(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Expected integer between ${min} and ${max}`);
  return value;
}

export function extractResponseTextFromRaw(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{")) {
    try {
      return extractResponseText(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // fall through to SSE parsing
    }
  }
  const deltas: string[] = [];
  let completedText = "";
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const ev = JSON.parse(payload) as Record<string, unknown>;
      if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
        deltas.push(ev.delta);
      } else if (ev.type === "response.completed" && ev.response && typeof ev.response === "object") {
        completedText = extractResponseText(ev.response as Record<string, unknown>);
      } else if (ev.type === "response.output_item.done" && ev.item && typeof ev.item === "object") {
        const item = ev.item as Record<string, unknown>;
        if (Array.isArray(item.content)) {
          for (const c of item.content as Array<Record<string, unknown>>) {
            if (typeof c.text === "string") completedText += c.text;
          }
        }
      }
    } catch {
      // ignore non-JSON SSE lines
    }
  }
  return deltas.join("") || completedText;
}

export function extractResponseText(json: Record<string, unknown>): string {
  if (typeof json.output_text === "string") return json.output_text;
  if (Array.isArray(json.output)) {
    const parts: string[] = [];
    for (const item of json.output as Array<Record<string, unknown>>) {
      if (Array.isArray(item.content)) {
        for (const c of item.content as Array<Record<string, unknown>>) {
          if (typeof c.text === "string") parts.push(c.text);
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

export function parseInlineCommandJson(
  raw: string,
): { command: string; explanation: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof parsed.command === "string" && parsed.command.trim()) {
      return {
        command: parsed.command.trim(),
        explanation:
          typeof parsed.explanation === "string" && parsed.explanation.trim()
            ? parsed.explanation.trim()
            : "Föreslaget kommando från AI",
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function buildInstantCommandSuggestion(
  prompt: string,
  lower: string,
  shell: string,
): { command: string; explanation: string } {
  const isCmd = shell === "cmd";
  const isPwsh = shell === "powershell" || shell === "pwsh";
  const portMatch = lower.match(/port\s+(\d{2,5})/);
  if (portMatch) {
    const port = portMatch[1];
    if (isCmd) {
      return {
        command: `netstat -ano | findstr :${port}`,
        explanation: `Visar vilken process och PID som lyssnar på eller använder port ${port} i cmd.`,
      };
    }
    return isPwsh
      ? {
          command: `Get-NetTCPConnection -LocalPort ${port} | Select-Object LocalAddress,LocalPort,State,OwningProcess`,
          explanation: `Visar vilken process som lyssnar eller använder port ${port} i PowerShell.`,
        }
      : {
          command: `sudo lsof -i :${port} || sudo ss -tulpn | grep :${port}`,
          explanation: `Visar vilken process och PID som lyssnar på port ${port}.`,
        };
  }
  if (lower.includes("disk") || lower.includes("utrymme") || lower.includes("full")) {
    if (isCmd) {
      return {
        command: `powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N='Used(GB)';E={[math]::Round($_.Used/1GB,2)}}, @{N='Free(GB)';E={[math]::Round($_.Free/1GB,2)}}"`,
        explanation: "Visar ledigt och använt diskutrymme per volym.",
      };
    }
    return isPwsh
      ? {
          command: `Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N="Used(GB)";E={[math]::Round($_.Used/1GB,2)}}, @{N="Free(GB)";E={[math]::Round($_.Free/1GB,2)}}`,
          explanation: "Visar ledigt och använt diskutrymme per volym.",
        }
      : {
          command: `df -hT && sudo du -xhd1 /var/log 2>/dev/null | sort -hr | head -n 10`,
          explanation: "Visar diskutrymme per filsystem samt de största katalogerna i /var/log.",
        };
  }
  if (lower.includes("nginx")) {
    return {
      command: `sudo nginx -t && sudo systemctl status nginx --no-pager && sudo tail -n 30 /var/log/nginx/error.log`,
      explanation: "Validerar nginx-konfigurationen, visar tjänstestatus och de senaste 30 raderna i error.log.",
    };
  }
  if (lower.includes("k8s") || lower.includes("pod") || lower.includes("crash") || lower.includes("kubectl")) {
    return {
      command: `kubectl get pods -A | grep -Ev 'Running|Completed' && kubectl get events -A --sort-by=.lastTimestamp | tail -n 20`,
      explanation: "Hittar alla pods som inte är Running/Completed samt visar de 20 senaste klusterhändelserna.",
    };
  }
  if (lower.includes("postgres") || lower.includes("pgbouncer") || lower.includes("db")) {
    return {
      command: `sudo systemctl status postgresql pgbouncer --no-pager && sudo -u postgres psql -c "SELECT state, count(*) FROM pg_stat_activity GROUP BY state;"`,
      explanation: "Kontrollerar status för PostgreSQL/PgBouncer och antalet aktiva anslutningar per tillstånd.",
    };
  }
  if (lower.includes("docker") || lower.includes("container")) {
    return {
      command: `docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}" && docker stats --no-stream`,
      explanation: "Listar körande containrar med portar samt aktuell CPU/minnesförbrukning.",
    };
  }
  if (lower.includes("log") || lower.includes("fel") || lower.includes("error") || lower.includes("journal")) {
    if (isCmd) {
      return {
        command: `powershell -NoProfile -Command "Get-EventLog -LogName System -EntryType Error -Newest 15 | Format-Table TimeGenerated,Source,Message -AutoSize"`,
        explanation: "Visar de 15 senaste systemfelen i Windows Event Log.",
      };
    }
    return isPwsh
      ? {
          command: `Get-EventLog -LogName System -EntryType Error -Newest 15 | Format-Table TimeGenerated,Source,Message -AutoSize`,
          explanation: "Visar de 15 senaste systemfelen i Windows Event Log.",
        }
      : {
          command: `sudo journalctl -p err -n 40 --no-pager`,
          explanation: "Visar de 40 senaste felen från systemd-journalen.",
        };
  }
  if (isCmd) {
    return {
      command: `tasklist /FI "MEMUSAGE gt 50000" & systeminfo | findstr /B /C:"OS Name" /C:"System Boot Time" /C:"Total Physical Memory" /C:"Available Physical Memory"`,
      explanation: `Föreslaget diagnostikkommando för: "${prompt}"`,
    };
  }
  return isPwsh
    ? {
        command: `Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name,Id,CPU,WorkingSet`,
        explanation: `Föreslaget diagnostikkommando för: "${prompt}"`,
      }
    : {
        command: `uptime && free -h && df -h /`,
        explanation: `Föreslaget diagnostikkommando för: "${prompt}"`,
      };
}

export function simulateDemoNodeCommand(
  srv: WorkspaceServerSummary,
  command: string,
): string {
  const cmdLower = command.toLowerCase();
  if (srv.cluster === "NetApp-ONTAP-Prod-SE") {
    if (cmdLower.includes("qos") || cmdLower.includes("latency")) {
      return [
        `Workload             ID     Latency    Network    Cluster       Data       Disk    QoS-Max`,
        `--------------- ------ ---------- ---------- ---------- ---------- ---------- ----------`,
        `-total-              -     0.42ms     0.05ms     0.02ms     0.18ms     0.17ms     0.00ms`,
        `vol_pg_prod_01    4812     0.31ms     0.04ms     0.00ms     0.14ms     0.13ms     0.00ms`,
        `vol_k8s_pvc_prod  4901     0.48ms     0.06ms     0.03ms     0.21ms     0.18ms     0.00ms`,
        `vol_analytics_sc  5104     1.12ms     0.05ms     0.00ms     0.22ms     0.19ms     0.66ms (pg-batch-ceiling)`,
      ].join("\n");
    }
    if (cmdLower.includes("snapmirror")) {
      return [
        `Source Path                      Destination Path                 State          Status   Lag-Time Healthy`,
        `-------------------------------- -------------------------------- -------------- -------- -------- -------`,
        `svm-prod-nfs:vol_k8s_pvc_prod    svm-dr-uppsala:vol_k8s_pvc_dr    Snapmirrored   Idle     00:03:18 true`,
        `svm-prod-iscsi:vol_pg_prod_01    svm-dr-uppsala:vol_pg_prod_dr    Snapmirrored   Idle     00:02:44 true`,
      ].join("\n");
    }
    return [
      `Node: ${srv.name} (${srv.host}) · ONTAP Release 9.15.1P2`,
      `Aggregate: ${srv.id.endsWith("01a") ? "aggr1_nvme_prod (220TB, 64% used, online)" : "aggr2_nvme_db (180TB, 58% used, online)"}`,
      `HA Failover: Connected to partner, Storage Failover enabled`,
      `Executed: ${command}`,
    ].join("\n");
  }
  if (srv.cluster === "Ceph-NVMe-Block-Pool") {
    return [
      `  cluster:`,
      `    id:     9b41a7e2-3d11-4f88-a901-88c1e4a00912`,
      `    health: HEALTH_OK`,
      `  services:`,
      `    mon: 3 daemons, quorum ${srv.name}`,
      `    osd: 32 osds: 32 up, 32 in (BlueStore Gen5 NVMe)`,
      `  data:`,
      `    pools:   4 pools, 512 pgs (all active+clean)`,
      `    usage:   184 TiB used, 236 TiB / 420 TiB avail`,
    ].join("\n");
  }
  return `[${srv.name} (${srv.host})] OK (exit 0)\n$ ${command}\nUptime: 142 days, load average: 0.38, 0.44, 0.41 · All storage mounts healthy.`;
}

export function simulateDemoStorageOps(
  op: "list_files" | "read_remote_file" | "diff_paths",
  targetA: string,
  pathA: string,
  targetB?: string,
  pathB?: string,
): unknown {
  if (op === "list_files") {
    return {
      ok: true,
      operation: "list_files",
      target: targetA,
      path: pathA,
      entries: [
        { name: "multipath.conf", type: "file", size: 2480, modifiedAt: new Date().toISOString() },
        { name: "storageclass-ontap-flexgroup-ai.yaml", type: "file", size: 1420, modifiedAt: new Date().toISOString() },
        { name: "ontap-fabricpool-tier-policy.json", type: "file", size: 1890, modifiedAt: new Date().toISOString() },
        { name: "ceph.conf", type: "file", size: 1640, modifiedAt: new Date().toISOString() },
      ],
    };
  }
  if (op === "read_remote_file") {
    const isWorker = targetA.toLowerCase().includes("worker");
    return {
      ok: true,
      operation: "read_remote_file",
      target: targetA,
      path: pathA,
      content: [
        `# Configuration on ${targetA}:${pathA}`,
        `defaults {`,
        `    user_friendly_names yes`,
        `    find_multipaths yes`,
        `}`,
        `devices {`,
        `    device {`,
        `        vendor "NETAPP"`,
        `        product "LUN.*"`,
        `        path_grouping_policy ${isWorker ? "multibus" : "group_by_prio"}`,
        `        prio "ontap"`,
        `        path_checker "tur"`,
        `        features "2 pg_init_retries 50"`,
        `        no_path_retry "queue"`,
        `        rr_min_io_rq 1`,
        `    }`,
        `}`,
      ].join("\n"),
    };
  }
  // diff_paths — computed with real Myers O(ND) algorithm via open-source `diff`
  const b = targetB || "demo-k8s-storage-cp-01";
  const pb = pathB || pathA;
  const leftIsWorker = targetA.toLowerCase().includes("worker");
  const leftContent = [
    `# Configuration on ${targetA}:${pathA}`,
    `defaults {`,
    `    user_friendly_names yes`,
    `    find_multipaths yes`,
    `}`,
    `devices {`,
    `    device {`,
    `        vendor "NETAPP"`,
    `        product "LUN.*"`,
    `        path_grouping_policy ${leftIsWorker ? "multibus" : "group_by_prio"}`,
    `        no_path_retry "queue"`,
    `        rr_min_io_rq 1`,
    `    }`,
    `}`,
  ].join("\n");
  const rightContent = [
    `# Configuration on ${b}:${pb}`,
    `defaults {`,
    `    user_friendly_names yes`,
    `    find_multipaths yes`,
    `}`,
    `devices {`,
    `    device {`,
    `        vendor "NETAPP"`,
    `        product "LUN.*"`,
    `        path_grouping_policy ${leftIsWorker ? "group_by_prio" : "multibus"}`,
    `        no_path_retry 30`,
    `        rr_min_io_rq 4`,
    `    }`,
    `}`,
  ].join("\n");
  const unifiedDiff = createTwoFilesPatch(
    `${targetA}:${pathA}`,
    `${b}:${pb}`,
    leftContent,
    rightContent,
    "baseline",
    "drift-detected",
    { context: 3 },
  );
  return {
    ok: true,
    operation: "diff_paths",
    engine: "diff/Myers-O(ND)",
    left: { target: targetA, path: pathA },
    right: { target: b, path: pb },
    identical: leftContent === rightContent,
    unifiedDiff,
    diff: unifiedDiff,
  };
}

export function simulateDemoMcpTool(
  toolName: string,
  args: Record<string, unknown>,
): string {
  if (toolName === "ontap_get_volume_metrics") {
    return JSON.stringify(
      {
        cluster: "NetApp-ONTAP-Prod-SE",
        sampledAt: new Date().toISOString(),
        volumes: [
          {
            svm: "svm-prod-iscsi",
            volume: "vol_pg_prod_01",
            iops: 18420,
            throughputMBps: 412,
            latencyMs: 0.34,
            qosPolicy: "pg-prod-db-extreme",
          },
          {
            svm: "svm-prod-nfs",
            volume: "vol_k8s_pvc_prod",
            iops: 9650,
            throughputMBps: 680,
            latencyMs: 0.47,
            tieringPolicy: "snapshot-only",
          },
          {
            svm: "svm-prod-iscsi",
            volume: "vol_analytics_scratch",
            iops: 14980,
            throughputMBps: 590,
            latencyMs: 1.15,
            qosPolicy: "pg-batch-ceiling (throttling active)",
          },
        ],
        filter: args,
      },
      null,
      2,
    );
  }
  if (toolName === "ontap_list_snapmirror_lags") {
    return JSON.stringify(
      {
        cluster: "NetApp-ONTAP-Prod-SE -> Uppsala DC2 (netapp-fas9000-dr-01)",
        totalRelationships: 28,
        healthyCount: 28,
        maxLagSeconds: 215,
        snapLockCompliance: "ACTIVE (14d tamperproof retention)",
      },
      null,
      2,
    );
  }
  if (toolName === "storagegrid_ilm_queue_status") {
    return JSON.stringify(
      {
        grid: "NetApp-StorageGRID-S3 (11.8)",
        activePolicy: "ILM-Prod-FabricPool-EC63",
        evaluationRateObjectsPerSec: 4820,
        queuedObjects: 140,
        erasureCodingScheme: "6+3 Geo-Distributed (Stockholm DC1 / Uppsala DC2)",
        degradedFragments: 0,
      },
      null,
      2,
    );
  }
  return JSON.stringify({
    tool: toolName,
    status: "ok",
    timestamp: new Date().toISOString(),
    args,
  });
}
