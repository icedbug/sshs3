import type { SimHost } from "../SimHost";
import { fail, lines, NotSimulated, ok, parseArgs, type SimCommand } from "../SimShell";

/**
 * Stateful Kubernetes, NetApp Astra Trident, and DM-Multipath simulators.
 * State lives in `host.facts.get("k8s")` and `host.facts.get("multipath")`.
 */

export interface SimK8sPod {
  namespace: string;
  name: string;
  ready: string;
  status: string;
  restarts: number;
  age: string;
  node: string;
  pvc?: string;
  logs: string[];
  events: string[];
  deleted?: boolean;
}

export interface SimK8sPvc {
  namespace: string;
  name: string;
  status: "Bound" | "Pending" | "Lost";
  volume: string;
  capacity: string;
  accessModes: string;
  storageClass: string;
  age: string;
  forceDeleted?: boolean;
}

export interface SimK8sNode {
  name: string;
  status: string;
  roles: string;
  age: string;
  version: string;
}

export interface SimK8sStorageClass {
  name: string;
  provisioner: string;
  reclaimPolicy: string;
  bindingMode: string;
}

export interface SimTridentBackend {
  name: string;
  driver: string;
  svm: string;
  state: "online" | "degraded" | "failed";
  volumes: number;
}

export interface SimTridentVolume {
  name: string;
  size: string;
  storageClass: string;
  state: "online" | "degraded";
  protocol: "file" | "block";
  backend: string;
  exportPolicy?: string;
}

export interface SimK8sState {
  pods: SimK8sPod[];
  pvcs: SimK8sPvc[];
  nodes: SimK8sNode[];
  storageClasses: SimK8sStorageClass[];
  events: Array<{ namespace: string; lastSeen: string; type: "Normal" | "Warning"; reason: string; object: string; message: string }>;
  tridentBackends?: SimTridentBackend[];
  tridentVolumes?: SimTridentVolume[];
  restartedDeployments?: string[];
}

export interface SimMultipathState {
  device: string;
  wwid: string;
  vendor: string;
  size: string;
  pathGroupingPolicy: "group_by_prio" | "multibus" | "failover";
  paths: Array<{ dev: string; state: "active ready running" | "active faulty running" | "enabled ready running"; prio: number }>;
  reloaded?: boolean;
}

export const k8sStateOf = (host: SimHost): SimK8sState | undefined => host.facts.get("k8s") as SimK8sState | undefined;
export const multipathStateOf = (host: SimHost): SimMultipathState | undefined => host.facts.get("multipath") as SimMultipathState | undefined;

const padRow = (cols: string[], widths: number[]): string => cols.map((c, i) => (i === cols.length - 1 ? c : c.padEnd(widths[i]))).join("  ");

const formatTable = (rows: string[][]): string => {
  const widths: number[] = [];
  for (const row of rows) row.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, c.length); });
  return lines(rows.map((r) => padRow(r, widths)));
};

const kubectl: SimCommand = (ctx, args) => {
  const state = k8sStateOf(ctx.host);
  if (!state) return fail("bash: kubectl: command not found\n", 127);
  const { flags, values, rest } = parseArgs(args, ["n", "namespace", "o", "output", "l", "selector", "c", "container", "p", "patch", "grace-period"]);
  const allNs = flags.has("A") || flags.has("all-namespaces");
  const ns = allNs ? undefined : (values.get("n") ?? values.get("namespace") ?? "default");
  const sub = rest[0];
  if (!sub) return fail("kubectl controls the Kubernetes cluster manager.\n", 1);

  if (sub === "get") {
    const kind = (rest[1] ?? "").toLowerCase();
    const targetName = rest[2];
    if (kind.includes(",")) {
      // Several kinds at once (`get sc,pvc`): each list in turn, with a blank line between, as kubectl prints them.
      const parts = kind.split(",").filter(Boolean).map((one) => kubectl(ctx, args.map((a) => (a === rest[1] ? one : a))));
      return parts.find((p) => p.code !== 0) ?? ok(parts.map((p) => p.out).join("\n"));
    }
    if (kind === "pods" || kind === "pod" || kind === "po") {
      // `--field-selector=status.phase!=Running`: the pods that are not running, which is what it is asked for.
      const notRunning = /status\.phase!=Running/.test(values.get("field-selector") ?? "");
      const pods = state.pods.filter((p) => !p.deleted && (!ns || p.namespace === ns) && (!targetName || p.name === targetName) && (!notRunning || p.status !== "Running"));
      if (targetName && !pods.length) return fail(`Error from server (NotFound): pods "${targetName}" not found\n`, 1);
      if (notRunning && !pods.length) return ok("No resources found\n");
      if (values.get("o") === "json" || values.get("output") === "json") return ok(`${JSON.stringify({ items: pods }, null, 2)}\n`);
      const head = allNs ? ["NAMESPACE", "NAME", "READY", "STATUS", "RESTARTS", "AGE", "NODE"] : ["NAME", "READY", "STATUS", "RESTARTS", "AGE"];
      const rows = pods.map((p) => (allNs ? [p.namespace, p.name, p.ready, p.status, String(p.restarts), p.age, p.node] : [p.name, p.ready, p.status, String(p.restarts), p.age]));
      return ok(formatTable([head, ...rows]));
    }
    if (kind === "pvc" || kind === "pvcs" || kind === "persistentvolumeclaim" || kind === "persistentvolumeclaims") {
      const pvcs = state.pvcs.filter((p) => !p.forceDeleted && (!ns || p.namespace === ns) && (!targetName || p.name === targetName));
      if (targetName && !pvcs.length) return fail(`Error from server (NotFound): persistentvolumeclaims "${targetName}" not found\n`, 1);
      if (values.get("o") === "json" || values.get("output") === "json") return ok(`${JSON.stringify({ items: pvcs }, null, 2)}\n`);
      const head = allNs ? ["NAMESPACE", "NAME", "STATUS", "VOLUME", "CAPACITY", "ACCESS MODES", "STORAGECLASS", "AGE"] : ["NAME", "STATUS", "VOLUME", "CAPACITY", "ACCESS MODES", "STORAGECLASS", "AGE"];
      const rows = pvcs.map((p) => (allNs ? [p.namespace, p.name, p.status, p.volume, p.capacity, p.accessModes, p.storageClass, p.age] : [p.name, p.status, p.volume, p.capacity, p.accessModes, p.storageClass, p.age]));
      return ok(formatTable([head, ...rows]));
    }
    if (kind === "nodes" || kind === "node" || kind === "no") {
      const nodes = state.nodes.filter((n) => !targetName || n.name === targetName);
      const head = ["NAME", "STATUS", "ROLES", "AGE", "VERSION"];
      return ok(formatTable([head, ...nodes.map((n) => [n.name, n.status, n.roles, n.age, n.version])]));
    }
    if (kind === "events" || kind === "event" || kind === "ev") {
      const evs = state.events.filter((e) => !ns || e.namespace === ns);
      const head = allNs ? ["NAMESPACE", "LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"] : ["LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"];
      return ok(formatTable([head, ...evs.map((e) => (allNs ? [e.namespace, e.lastSeen, e.type, e.reason, e.object, e.message] : [e.lastSeen, e.type, e.reason, e.object, e.message]))]));
    }
    if (kind === "sc" || kind === "storageclass" || kind === "storageclasses") {
      const head = ["NAME", "PROVISIONER", "RECLAIMPOLICY", "VOLUMEBINDINGMODE"];
      return ok(formatTable([head, ...state.storageClasses.map((s) => [s.name, s.provisioner, s.reclaimPolicy, s.bindingMode])]));
    }
    if (kind === "volumeattachment" || kind === "volumeattachments") {
      // One for each volume a pod uses, on the node the pod is on: attached once the pod runs. They belong to no namespace.
      const rows = state.pods.flatMap((p) => {
        const pvc = p.deleted || !p.pvc ? undefined : state.pvcs.find((c) => c.name === p.pvc && c.namespace === p.namespace && !c.forceDeleted);
        return pvc ? [[`csi-${pvc.volume.replace(/[^a-z0-9]/g, "").slice(0, 16)}`, "csi.trident.netapp.io", pvc.volume, p.node, String(p.status === "Running"), p.age]] : [];
      });
      if (!rows.length) return ok("No resources found\n");
      return ok(formatTable([["NAME", "ATTACHER", "PV", "NODE", "ATTACHED", "AGE"], ...rows]));
    }
    throw new NotSimulated(`kubectl get ${kind}`);
  }

  if (sub === "describe") {
    const kind = (rest[1] ?? "").toLowerCase();
    const targetName = rest[2];
    if (kind === "pod" || kind === "po" || kind === "pods") {
      const pod = state.pods.find((p) => !p.deleted && (!ns || p.namespace === ns) && (!targetName || p.name === targetName));
      if (!pod) return fail(`Error from server (NotFound): pods "${targetName ?? ""}" not found\n`, 1);
      return ok(
        lines([
          `Name:         ${pod.name}`,
          `Namespace:    ${pod.namespace}`,
          `Node:         ${pod.node}`,
          `Status:       ${pod.status}`,
          `Ready:        ${pod.ready}`,
          `Restarts:     ${pod.restarts}`,
          ...(pod.pvc ? [`Volumes:      data (PersistentVolumeClaim: ${pod.pvc})`] : []),
          "Events:",
          ...(pod.events.length ? pod.events.map((e) => `  ${e}`) : ["  <none>"]),
        ]),
      );
    }
    if (kind === "pvc" || kind === "persistentvolumeclaim") {
      const pvc = state.pvcs.find((p) => !p.forceDeleted && (!ns || p.namespace === ns) && (!targetName || p.name === targetName));
      if (!pvc) return fail(`Error from server (NotFound): persistentvolumeclaims "${targetName ?? ""}" not found\n`, 1);
      return ok(
        lines([
          `Name:          ${pvc.name}`,
          `Namespace:     ${pvc.namespace}`,
          `StorageClass:  ${pvc.storageClass}`,
          `Status:        ${pvc.status}`,
          `Volume:        ${pvc.volume}`,
          `Capacity:      ${pvc.capacity}`,
          `Access Modes:  ${pvc.accessModes}`,
        ]),
      );
    }
    if (kind === "node" || kind === "no") {
      const node = state.nodes.find((n) => !targetName || n.name === targetName);
      if (!node) return fail(`Error from server (NotFound): nodes "${targetName ?? ""}" not found\n`, 1);
      return ok(lines([`Name:         ${node.name}`, `Roles:        ${node.roles}`, `Status:       ${node.status}`, `Version:      ${node.version}`]));
    }
    throw new NotSimulated(`kubectl describe ${kind}`);
  }

  if (sub === "logs") {
    const podName = rest[1];
    const pod = state.pods.find((p) => !p.deleted && (!ns || p.namespace === ns) && p.name === podName);
    if (!pod) return fail(`Error from server (NotFound): pods "${podName ?? ""}" not found\n`, 1);
    if (pod.status === "ContainerCreating" || pod.status === "Pending") {
      return fail(`Error from server (BadRequest): container "app" in pod "${pod.name}" is waiting to start: ${pod.status}\n`, 1);
    }
    return ok(lines(pod.logs));
  }

  if (sub === "rollout") {
    const action = rest[1];
    const resource = rest[2] ?? "deployment/app";
    if (action === "status") {
      const failing = state.pods.some((p) => !p.deleted && (!ns || p.namespace === ns) && p.status !== "Running");
      if (failing) return fail(`Waiting for ${resource} rollout to finish: 0 of 1 updated replicas are available...\n`, 1);
      return ok(`${resource} successfully rolled out\n`);
    }
    if (action === "restart") {
      state.restartedDeployments = [...(state.restartedDeployments ?? []), resource];
      return ok(`${resource} restarted\n`);
    }
    throw new NotSimulated(`kubectl rollout ${action ?? ""}`);
  }

  if (sub === "patch") {
    const kind = rest[1] ?? "";
    const name = rest[2] ?? "";
    return ok(`${kind}/${name} patched\n`);
  }

  if (sub === "delete") {
    const kind = (rest[1] ?? "").toLowerCase();
    const name = rest[2];
    const force = flags.has("force") || values.get("grace-period") === "0";
    if (kind === "pvc" || kind === "persistentvolumeclaim") {
      const pvc = state.pvcs.find((p) => (!ns || p.namespace === ns) && p.name === name);
      if (!pvc) return fail(`Error from server (NotFound): persistentvolumeclaims "${name ?? ""}" not found\n`, 1);
      pvc.forceDeleted = true;
      pvc.status = "Lost";
      return ok(`persistentvolumeclaim "${pvc.name}" ${force ? "force " : ""}deleted\n`);
    }
    if (kind === "pod" || kind === "po") {
      const pod = state.pods.find((p) => (!ns || p.namespace === ns) && p.name === name);
      if (!pod) return fail(`Error from server (NotFound): pods "${name ?? ""}" not found\n`, 1);
      pod.restarts += 1;
      return ok(`pod "${pod.name}" deleted\n`);
    }
    throw new NotSimulated(`kubectl delete ${kind}`);
  }

  throw new NotSimulated(`kubectl ${sub}`);
};

const tridentctl: SimCommand = (ctx, args) => {
  const state = k8sStateOf(ctx.host);
  if (!state?.tridentBackends) return fail("bash: tridentctl: command not found\n", 127);
  const { rest } = parseArgs(args, ["n", "namespace", "o", "output"]);
  const sub = rest[0];
  const kind = (rest[1] ?? "").toLowerCase();
  if (sub === "get" && (kind === "backend" || kind === "backends")) {
    const head = ["NAME", "STORAGE DRIVER", "SVM", "STATE", "VOLUMES"];
    return ok(formatTable([head, ...state.tridentBackends.map((b) => [b.name, b.driver, b.svm, b.state, String(b.volumes)])]));
  }
  if (sub === "get" && (kind === "volume" || kind === "volumes")) {
    const vols = state.tridentVolumes ?? [];
    const head = ["NAME", "SIZE", "STORAGE CLASS", "STATE", "PROTOCOL", "BACKEND", "EXPORT POLICY"];
    return ok(formatTable([head, ...vols.map((v) => [v.name, v.size, v.storageClass, v.state, v.protocol, v.backend, v.exportPolicy ?? "-"])]));
  }
  throw new NotSimulated(`tridentctl ${rest.join(" ")}`);
};

const multipath: SimCommand = (ctx, args) => {
  const mp = multipathStateOf(ctx.host);
  if (!mp) return fail("bash: multipath: command not found\n", 127);
  if (args.includes("-r") || args.includes("-v2")) {
    if (!ctx.root) return fail("multipath: must be run as root\n", 1);
    const conf = ctx.host.read("/etc/multipath.conf")?.content ?? "";
    const match = /path_grouping_policy\s+(\S+)/.exec(conf);
    if (match) {
      const policy = match[1].replace(/["']/g, "");
      if (policy === "group_by_prio" || policy === "multibus" || policy === "failover") {
        mp.pathGroupingPolicy = policy;
      }
    }
    mp.reloaded = true;
    for (const p of mp.paths) {
      if (mp.pathGroupingPolicy === "group_by_prio") {
        p.state = p.prio >= 50 ? "active ready running" : "enabled ready running";
      } else {
        p.state = p.prio >= 50 ? "active ready running" : "active faulty running";
      }
    }
    return ok(`reload: ${mp.device} (${mp.wwid}) dm-0 ${mp.vendor}\nsize=${mp.size} features='3 queue_if_no_path pg_init_retries 50' hwhandler='1 alua' wp=rw\n`);
  }
  if (args.includes("-ll") || args.includes("-l")) {
    const out = [
      `${mp.device} (${mp.wwid}) dm-0 ${mp.vendor}`,
      `size=${mp.size} features='3 queue_if_no_path pg_init_retries 50' hwhandler='1 alua' wp=rw`,
      `|-+- policy='service-time 0' prio=${mp.paths[0]?.prio ?? 50} status=active (path_grouping_policy: ${mp.pathGroupingPolicy})`,
      ...mp.paths.map((p, i) => `| ${i === mp.paths.length - 1 ? "`" : "|"}- 1:0:0:${i} ${p.dev} 8:${16 * (i + 1)} ${p.state} prio=${p.prio}`),
    ];
    return ok(lines(out));
  }
  throw new NotSimulated(`multipath ${args.join(" ")}`);
};

export const k8sCommands: Record<string, SimCommand> = {
  kubectl,
  tridentctl,
  multipath,
};
