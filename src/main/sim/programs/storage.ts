import type { SimHost } from "../SimHost";
import { fail, lines, ok, type SimCommand } from "../SimShell";

/**
 * Reusable ONTAP storage CLI helpers (export-policy, volume, QoS, cluster).
 * Hosts store state in `host.facts.get("ontap")`.
 */

export interface OntapExportRule {
  vserver: string;
  policy: string;
  ruleIndex: number;
  clientMatch: string;
  roRule: string;
  rwRule: string;
  superuser: string;
}

export interface OntapVolumeInfo {
  vserver: string;
  name: string;
  aggregate: string;
  state: "online" | "offline";
  sizeGb: number;
  usedPct: number;
  exportPolicy: string;
  qosPolicyGroup: string;
  latencyMs: number;
}

export interface OntapClusterState {
  clusterName: string;
  version: string;
  nodes: string[];
  volumes: OntapVolumeInfo[];
  exportRules: OntapExportRule[];
}

export const ontapStateOf = (host: SimHost): OntapClusterState | undefined => host.facts.get("ontap") as OntapClusterState | undefined;

const flagValue = (args: string[], flag: string): string | undefined => {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
};

export const ontapVserverCmd: SimCommand = (ctx, args) => {
  const state = ontapStateOf(ctx.host);
  if (!state) return fail('Error: "vserver" is not a recognized command\n', 1);
  if (args[0] === "export-policy" && args[1] === "rule") {
    const action = args[2];
    if (action === "show") {
      const vserver = flagValue(args, "-vserver");
      const policy = flagValue(args, "-policyname");
      const rules = state.exportRules.filter((r) => (!vserver || r.vserver === vserver) && (!policy || r.policy === policy));
      return ok(
        lines([
          "             Policy          Rule    Access   Client                RO",
          "Vserver      Name            Index   Protocol Match                 Rule",
          "------------ --------------- ------  -------- --------------------- ---------",
          ...rules.map(
            (r) =>
              `${r.vserver.padEnd(12)} ${r.policy.padEnd(15)} ${String(r.ruleIndex).padEnd(7)} nfs4     ${r.clientMatch.padEnd(21)} ${r.roRule} (rw=${r.rwRule}, superuser=${r.superuser})`,
          ),
          `${rules.length} entries were displayed.`,
        ]),
      );
    }
    if (action === "create") {
      const vserver = flagValue(args, "-vserver") ?? "svm-prod-nfs";
      const policy = flagValue(args, "-policyname") ?? "default";
      const clientMatch = flagValue(args, "-clientmatch");
      if (!clientMatch) return fail("Error: -clientmatch is required\n", 1);
      const roRule = flagValue(args, "-rorule") ?? "sys";
      const rwRule = flagValue(args, "-rwrule") ?? "sys";
      const superuser = flagValue(args, "-superuser") ?? "sys";
      const nextIdx = Math.max(0, ...state.exportRules.filter((r) => r.vserver === vserver && r.policy === policy).map((r) => r.ruleIndex)) + 1;
      state.exportRules.push({ vserver, policy, ruleIndex: nextIdx, clientMatch, roRule, rwRule, superuser });
      return ok("");
    }
    if (action === "modify") {
      const vserver = flagValue(args, "-vserver");
      const policy = flagValue(args, "-policyname");
      const idxStr = flagValue(args, "-ruleindex");
      const clientMatch = flagValue(args, "-clientmatch");
      const target = state.exportRules.find(
        (r) => (!vserver || r.vserver === vserver) && (!policy || r.policy === policy) && (!idxStr || r.ruleIndex === Number(idxStr)),
      );
      if (!target) return fail("Error: no matching export-policy rule found\n", 1);
      if (clientMatch) target.clientMatch = clientMatch;
      const rw = flagValue(args, "-rwrule");
      if (rw) target.rwRule = rw;
      const ro = flagValue(args, "-rorule");
      if (ro) target.roRule = ro;
      return ok("");
    }
  }
  if (args[0] === "show") {
    const svms = [...new Set(state.volumes.map((v) => v.vserver))];
    return ok(lines(["Vserver        Type    Subtype    State", "-------------- ------- ---------- ----------", ...svms.map((s) => `${s.padEnd(14)} data    default    running`)]));
  }
  return fail(`Error: "${args.join(" ")}" is not a recognized vserver command\n`, 1);
};

export const ontapVolumeCmd: SimCommand = (ctx, args) => {
  const state = ontapStateOf(ctx.host);
  if (!state) return fail('Error: "volume" is not a recognized command\n', 1);
  if (args[0] === "show") {
    const volFilter = flagValue(args, "-volume");
    const vols = state.volumes.filter((v) => !volFilter || v.name === volFilter);
    return ok(
      lines([
        "Vserver      Volume            Aggregate        State    Size    Used%  Export Policy    QoS Policy",
        "------------ ----------------- ---------------- -------- ------- ------ ---------------- -----------------",
        ...vols.map(
          (v) =>
            `${v.vserver.padEnd(12)} ${v.name.padEnd(17)} ${v.aggregate.padEnd(16)} ${v.state.padEnd(8)} ${`${v.sizeGb}GB`.padEnd(7)} ${`${v.usedPct}%`.padEnd(6)} ${v.exportPolicy.padEnd(16)} ${v.qosPolicyGroup}`,
        ),
        `${vols.length} entries were displayed.`,
      ]),
    );
  }
  if (args[0] === "modify") {
    const name = flagValue(args, "-volume");
    const vol = state.volumes.find((v) => v.name === name);
    if (!vol) return fail(`Error: volume "${name ?? ""}" not found\n`, 1);
    const qos = flagValue(args, "-qos-policy-group");
    if (qos) vol.qosPolicyGroup = qos;
    const pol = flagValue(args, "-policy");
    if (pol) vol.exportPolicy = pol;
    return ok("Volume modify successful on volume " + vol.name + "\n");
  }
  return fail(`Error: "volume ${args.join(" ")}" is not a recognized command\n`, 1);
};

export const ontapQosCmd: SimCommand = (ctx, args) => {
  const state = ontapStateOf(ctx.host);
  if (!state) return fail('Error: "qos" is not a recognized command\n', 1);
  if (args[0] === "statistics" && args[1] === "volume" && args[2] === "latency") {
    return ok(
      lines([
        "Workload            ID    Latency    Network    Cluster       Data       Disk        QoS",
        "--------------- ------ ---------- ---------- ---------- ---------- ---------- ----------",
        ...state.volumes.map(
          (v, i) =>
            `${v.name.padEnd(15)} ${String(1000 + i).padEnd(6)} ${`${v.latencyMs.toFixed(2)}ms`.padStart(10)} ${"0.12ms".padStart(10)} ${"0.05ms".padStart(10)} ${`${(v.latencyMs * 0.6).toFixed(2)}ms`.padStart(10)} ${`${(v.latencyMs * 0.25).toFixed(2)}ms`.padStart(10)} ${"0.00ms".padStart(10)}`,
        ),
      ]),
    );
  }
  if (args[0] === "policy-group" && args[1] === "show") {
    const groups = [...new Set(state.volumes.map((v) => v.qosPolicyGroup))];
    return ok(lines(["Name                  Vserver        Class", "--------------------- -------------- --------", ...groups.map((g) => `${g.padEnd(21)} svm-prod-nfs   user-defined`)]));
  }
  return fail(`Error: "qos ${args.join(" ")}" is not a recognized command\n`, 1);
};

export const ontapClusterCmd: SimCommand = (ctx, args) => {
  const state = ontapStateOf(ctx.host);
  if (!state) return fail('Error: "cluster" is not a recognized command\n', 1);
  if (args[0] === "show") {
    return ok(
      lines([
        `Cluster: ${state.clusterName} (${state.version})`,
        "Node                  Health  Eligibility",
        "--------------------- ------- ------------",
        ...state.nodes.map((n) => `${n.padEnd(21)} true    true`),
      ]),
    );
  }
  return fail(`Error: "cluster ${args.join(" ")}" is not a recognized command\n`, 1);
};

export const ontapStorageCmd: SimCommand = (ctx, args) => {
  const state = ontapStateOf(ctx.host);
  if (!state) return fail('Error: "storage" is not a recognized command\n', 1);
  if (args[0] === "aggregate" && args[1] === "show") {
    const aggrs = [...new Set(state.volumes.map((v) => v.aggregate))];
    return ok(
      lines([
        "Aggregate          Size  Available Used% State   #Vols  Nodes",
        "------------------ ----- --------- ----- ------- ------ --------------------",
        ...aggrs.map((a) => {
          const count = state.volumes.filter((v) => v.aggregate === a).length;
          return `${a.padEnd(18)} 220TB 84.2TB      62% online  ${String(count).padEnd(6)} ${state.nodes[0] ?? "node-01"}`;
        }),
        `${aggrs.length} entries were displayed.`,
      ]),
    );
  }
  return fail(`Error: "storage ${args.join(" ")}" is not a recognized command\n`, 1);
};

export const ontapStorageCommands: Record<string, SimCommand> = {
  vserver: ontapVserverCmd,
  volume: ontapVolumeCmd,
  vol: ontapVolumeCmd,
  qos: ontapQosCmd,
  cluster: ontapClusterCmd,
  storage: ontapStorageCmd,
};
