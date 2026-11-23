import { runningScenario, scoreRunning } from "./lab";
import { k8sStateOf } from "./programs/k8s";
import { ontapStateOf } from "./programs/storage";
import { simWorld } from "./SimWorld";

/**
 * What the demo's MCP servers answer, read from the simulated servers as they stand.
 *
 * The demo's MCP servers are the two that come with the demo workspace and the ones its catalog offers
 * (ai/hub/demoWorkspace.ts: `demo-mcp-netapp-harvest`, `demo-mcp-prometheus`, `demo-mcp-grafana-loki`,
 * `demo-mcp-kubernetes-helm`, `demo-mcp-netbox-ipam` and the rest). A tool is found here by the name its
 * server lists, so a tool answers the same whichever demo server offers it. Every answer says
 * `simulated: true`. A tool the lab has nothing to read from for gets no answer here (undefined), and the
 * caller gives a scripted one.
 *
 * Nothing here starts a program or calls an address.
 */
export function querySimMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  serverId?: string,
): string | undefined {
  const world = simWorld();
  const hosts = world.everyHost();
  const scenario = runningScenario();
  const score = scoreRunning();
  const nowIso = new Date(world.now()).toISOString();
  const answer = (body: Record<string, unknown>): string =>
    JSON.stringify({ simulated: true, source: "demo-lab-sim-mcp", ...(serverId ? { server: serverId } : {}), tool: toolName, sampledAt: nowIso, ...body }, null, 2);

  // NetApp Harvest and ActiveIQ: the volumes of the lab's ONTAP system, when it has one.
  if (toolName === "ontap_get_volume_metrics") {
    const ontapHost = hosts.find((h) => h.kind === "ontap" || h.facts.has("ontap"));
    const ontap = ontapHost ? ontapStateOf(ontapHost) : undefined;
    if (!ontap?.volumes.length) return undefined;
    return answer({
      cluster: ontap.clusterName || "NetApp-ONTAP-Prod-SE",
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
    });
  }
  if (toolName === "trident_inspect_pvc_mapping") {
    const k8sHost = hosts.find((h) => h.facts.has("k8s"));
    const k8s = k8sHost ? k8sStateOf(k8sHost) : undefined;
    if (!k8s?.pvcs.length) return undefined;
    return answer({ pvcs: k8s.pvcs, tridentVolumes: k8s.tridentVolumes ?? [], tridentBackends: k8s.tridentBackends ?? [] });
  }

  // Kubernetes: pods and events of the lab's cluster, when it has one.
  if (toolName === "k8s_list_pods_and_events") {
    const k8sHost = hosts.find((h) => h.facts.has("k8s"));
    const k8s = k8sHost ? k8sStateOf(k8sHost) : undefined;
    if (!k8s) return undefined;
    return answer({
      nodes: k8s.nodes,
      pods: k8s.pods.filter((p) => !p.deleted).map((p) => ({ namespace: p.namespace, name: p.name, ready: p.ready, status: p.status, restarts: p.restarts, node: p.node, ...(p.pvc ? { pvc: p.pvc } : {}) })),
      events: k8s.events,
    });
  }

  // Prometheus: what every server of the lab would report about itself.
  if (toolName.startsWith("prometheus_")) {
    return answer({
      query: args.query ?? args.expr ?? "up",
      hosts: hosts.map((h) => ({
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
      })),
    });
  }

  // Alertmanager: the running incident's alert, and what follows from the servers' state.
  if (toolName.startsWith("alertmanager_")) {
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
    return answer({ alerts });
  }

  // Grafana: one panel per server.
  if (toolName.startsWith("grafana_")) {
    return answer({
      scenario: scenario?.id ?? "base-fleet",
      panels: hosts.map((h) => ({
        host: h.name,
        activeServices: [...h.services.values()].filter((s) => s.state === "active").length,
        failedServices: [...h.services.values()].filter((s) => s.state === "failed").length,
        maxDiskPct: Math.max(0, ...h.disks.map((d) => h.diskUse(d).pct)),
      })),
    });
  }

  // Loki: the newest lines of the servers' journals.
  if (toolName.startsWith("loki_")) {
    const wanted = typeof args.query === "string" ? args.query.toLowerCase() : "";
    const linesOf = hosts
      .flatMap((h) => h.journal.map((l) => ({ host: h.name, at: new Date(l.at).toISOString(), unit: l.unit, priority: l.priority ?? 6, text: l.text })))
      .filter((l) => !wanted || `${l.host} ${l.unit} ${l.text}`.toLowerCase().includes(wanted))
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-50);
    return answer({ query: args.query ?? "", lines: linesOf });
  }

  // NetBox: the lab's servers, their addresses and who they talk to.
  if (toolName.startsWith("netbox_")) {
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
    return answer({ deviceCount: devices.length, devices });
  }

  return undefined;
}
