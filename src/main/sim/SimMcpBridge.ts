import { runningScenario, scoreRunning } from "./lab";
import { k8sStateOf } from "./programs/k8s";
import { ontapStateOf } from "./programs/storage";
import { simWorld } from "./SimWorld";

/**
 * Stateful simulated MCP bridge for demo MCP servers.
 * Derives live metrics, topology, alerts, and storage state from `simWorld()`
 * whenever simulated hosts exist, and marks every response clearly as simulated.
 */
export function querySimMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  serverId?: string,
): string | undefined {
  const world = simWorld();
  const hosts = [...world.hosts.values()];
  const scenario = runningScenario();
  const score = scoreRunning();
  const nowIso = new Date(world.now()).toISOString();

  // 1. NetApp Harvest / ActiveIQ MCP
  if (toolName === "ontap_get_volume_metrics" || serverId === "demo-mcp-netapp-harvest") {
    if (toolName === "ontap_get_volume_metrics") {
      const ontapHost = hosts.find((h) => h.kind === "ontap" || h.facts.has("ontap"));
      const ontap = ontapHost ? ontapStateOf(ontapHost) : undefined;
      if (ontap?.volumes.length) {
        return JSON.stringify(
          {
            simulated: true,
            source: "demo-lab-sim-mcp",
            cluster: ontap.clusterName || "NetApp-ONTAP-Prod-SE",
            sampledAt: nowIso,
            volumes: ontap.volumes.map((v) => ({
              svm: v.vserver,
              volume: v.name,
              aggregate: v.aggregate,
              state: v.state,
              usedPct: v.usedPct,
              latencyMs: v.latencyMs,
              qosPolicy: v.qosPolicyGroup,
              exportPolicy: v.exportPolicy,
            })),
            filter: args,
          },
          null,
          2,
        );
      }
      return undefined;
    }
    if (toolName === "trident_inspect_pvc_mapping") {
      const k8sHost = hosts.find((h) => h.facts.has("k8s"));
      const k8s = k8sHost ? k8sStateOf(k8sHost) : undefined;
      if (k8s?.pvcs.length) {
        return JSON.stringify(
          {
            simulated: true,
            source: "demo-lab-sim-mcp",
            sampledAt: nowIso,
            pvcs: k8s.pvcs,
            tridentVolumes: k8s.tridentVolumes ?? [],
            tridentBackends: k8s.tridentBackends ?? [],
          },
          null,
          2,
        );
      }
      return undefined;
    }
  }

  // 2. Prometheus MCP (metrics derived from live SimWorld hosts)
  if (serverId === "demo-mcp-prometheus" || toolName.startsWith("prom_") || toolName.startsWith("prometheus_") || toolName === "query_metrics") {
    const metrics = hosts.map((h) => ({
      host: h.name,
      address: h.address,
      kind: h.kind,
      disks: h.disks.map((d) => ({ mount: d.mount, ...h.diskUse(d) })),
      services: [...h.services.values()].map((s) => ({
        name: s.name,
        state: s.state,
        healthy: s.state === "active" && !s.healthy?.(h),
        detail: s.healthy?.(h) ?? undefined,
      })),
    }));
    return JSON.stringify(
      {
        simulated: true,
        source: "demo-lab-sim-mcp",
        server: serverId ?? "demo-mcp-prometheus",
        tool: toolName,
        sampledAt: nowIso,
        query: args.query ?? args.expr ?? "up",
        hosts: metrics,
      },
      null,
      2,
    );
  }

  // 3. NetBox MCP (hosts, IPs, services, and peer topology from SimWorld)
  if (serverId === "demo-mcp-netbox" || toolName.startsWith("netbox_") || toolName === "list_devices" || toolName === "get_topology") {
    const devices = hosts.map((h) => ({
      name: h.name,
      primaryIp: h.address,
      kind: h.kind,
      os: h.os.pretty,
      cpus: h.cpus,
      memoryMb: h.memoryMb,
      listeningPorts: h.listening().map((l) => `${l.proto}/${l.port} (${l.process})`),
      peers: h.peers ?? [],
    }));
    return JSON.stringify(
      {
        simulated: true,
        source: "demo-lab-sim-mcp",
        server: serverId ?? "demo-mcp-netbox",
        tool: toolName,
        sampledAt: nowIso,
        deviceCount: devices.length,
        devices,
      },
      null,
      2,
    );
  }

  // 4. Alertmanager MCP (active scenario alert & failing checks from SimWorld)
  if (serverId === "demo-mcp-alertmanager" || toolName.startsWith("alertmanager_") || toolName === "list_alerts") {
    const alerts: Array<Record<string, unknown>> = [];
    if (scenario?.alert) {
      const resolved = score ? score.checks.filter((c) => c.kind === "resolved").every((c) => c.pass) : false;
      alerts.push({
        alertname: scenario.alert.name,
        severity: scenario.alert.severity,
        instance: scenario.alert.instance,
        summary: scenario.alert.summary,
        status: resolved ? "resolved" : "firing",
      });
    }
    for (const h of hosts) {
      for (const s of h.services.values()) {
        if (s.state === "failed") {
          alerts.push({ alertname: "SystemdUnitFailed", severity: "critical", instance: `${h.address}:9100`, summary: `${s.name}.service is failed on ${h.name}`, status: "firing" });
        }
      }
      for (const d of h.disks) {
        const use = h.diskUse(d);
        if (use.pct >= 85) {
          alerts.push({ alertname: "FilesystemNearFull", severity: use.pct >= 95 ? "critical" : "warning", instance: `${h.address}:9100`, summary: `${d.mount} on ${h.name} is ${use.pct}% full`, status: "firing" });
        }
      }
    }
    return JSON.stringify(
      {
        simulated: true,
        source: "demo-lab-sim-mcp",
        server: serverId ?? "demo-mcp-alertmanager",
        tool: toolName,
        sampledAt: nowIso,
        alerts,
      },
      null,
      2,
    );
  }

  // 5. Grafana MCP (dashboards reflecting live SimWorld hosts)
  if (serverId === "demo-mcp-grafana" || toolName.startsWith("grafana_") || toolName === "get_dashboard") {
    return JSON.stringify(
      {
        simulated: true,
        source: "demo-lab-sim-mcp",
        server: serverId ?? "demo-mcp-grafana",
        tool: toolName,
        sampledAt: nowIso,
        scenario: scenario?.id ?? "base-fleet",
        panels: hosts.map((h) => ({
          host: h.name,
          activeServices: [...h.services.values()].filter((s) => s.state === "active").length,
          failedServices: [...h.services.values()].filter((s) => s.state === "failed").length,
          maxDiskPct: Math.max(0, ...h.disks.map((d) => h.diskUse(d).pct)),
        })),
      },
      null,
      2,
    );
  }

  // 6. PagerDuty MCP (active incident summary from running scenario)
  if (serverId === "demo-mcp-pagerduty" || toolName.startsWith("pagerduty_") || toolName === "list_incidents") {
    return JSON.stringify(
      {
        simulated: true,
        source: "demo-lab-sim-mcp",
        server: serverId ?? "demo-mcp-pagerduty",
        tool: toolName,
        sampledAt: nowIso,
        incidents: scenario?.alert
          ? [
              {
                id: `PD-SIM-${scenario.id.toUpperCase()}`,
                title: scenario.alert.summary,
                urgency: scenario.alert.severity === "critical" ? "high" : "low",
                status: score && score.checks.filter((c) => c.kind === "resolved").every((c) => c.pass) ? "resolved" : "triggered",
                target: scenario.target,
              },
            ]
          : [],
      },
      null,
      2,
    );
  }

  return undefined;
}
