import { demoClusterState, scriptedDemoText } from "../../demo/DemoVirtualPty";
import type { SimHost } from "../SimHost";
import { fail, lines, NotSimulated, ok, type SimCommand, type SimContext, type SimResult } from "../SimShell";
import type { OntapClusterState, OntapVolumeInfo } from "./storage";

/**
 * The showcase's own programs, for the base fleet's servers (sim/baseFleet.ts).
 *
 * The demo workspace has more servers than the fleet simulates: the second ONTAP node, the DR
 * system, the storage nodes. Those answer from a script (demo/DemoVirtualPty.ts). A fleet server
 * is the same cluster seen from another node, so what an appliance says about the cluster comes
 * from that same script and the same record of what was fixed (`demoClusterState`): the volume
 * that has no QoS limit on one node has none on the other, and a fix made on one shows on both.
 * What the script does not answer exactly is answered here, from that same record.
 *
 * Everything else about a fleet server (its files, services, disks, ports) is the server's own
 * state, as on any simulated server.
 */

/**
 * The script's answer to a line on this server, as a command's result. A line it has no answer for is
 * not simulated. The shell is told, so a model is told the answer is the script's (sim/scripted.ts).
 */
function scripted(ctx: SimContext, line: string): SimResult {
  const answer = scriptedDemoText(ctx.host.name, line);
  if (!answer) throw new NotSimulated(line);
  ctx.shell.answeredFromScript();
  return answer.exitCode === 0 ? ok(`${answer.text}\n`) : fail(`${answer.text}\n`, answer.exitCode);
}

const flagValue = (args: string[], flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : undefined;
};

// ---- ONTAP -------------------------------------------------------------------------------------

const SCRATCH = "vol_ai_scratch_03";
const QOS_CEILING = "pg-batch-ceiling";

interface ShowcaseVolume {
  vserver: string;
  name: string;
  aggregate: string;
  type: string;
  size: string;
  sizeGb: number;
  avail: string;
  usedPct: number;
  tiering: string;
  exportPolicy: string;
  qos: () => string;
  latencyMs: () => number;
}

/** The cluster's volumes, as `volume show` in the script lists them. The scratch volume's limit and the latencies follow what was fixed. */
const VOLUMES: ShowcaseVolume[] = [
  { vserver: "svm-prod-nfs", name: "vol_k8s_pvc_prod", aggregate: "aggr1_nvme_prod", type: "RW", size: "16.0TB", sizeGb: 16_384, avail: "4.16TB", usedPct: 74, tiering: "snapshot-only", exportPolicy: "trident_k8s_prod", qos: () => "pg-trident-premium", latencyMs: () => 0.38 },
  { vserver: "svm-prod-nfs", name: SCRATCH, aggregate: "aggr2_nvme_db", type: "RW", size: "24.0TB", sizeGb: 24_576, avail: "3.84TB", usedPct: 84, tiering: "auto", exportPolicy: "trident_k8s_prod", qos: () => (demoClusterState.ontapQosFixed ? QOS_CEILING : "none"), latencyMs: () => (demoClusterState.ontapQosFixed ? 0.41 : 2.45) },
  { vserver: "svm-prod-nfs", name: "fg_llm_datasets_prod", aggregate: "aggr1_nvme_prod", type: "RW-FG", size: "80.0TB", sizeGb: 81_920, avail: "22.40TB", usedPct: 72, tiering: "auto", exportPolicy: "trident_k8s_prod", qos: () => "none", latencyMs: () => 0.36 },
  { vserver: "svm-prod-iscsi", name: "vol_pg_prod_db01", aggregate: "aggr2_nvme_db", type: "RW", size: "12.0TB", sizeGb: 12_288, avail: "4.68TB", usedPct: 61, tiering: "snapshot-only", exportPolicy: "default", qos: () => "pg-prod-db-extreme", latencyMs: () => (demoClusterState.ontapQosFixed ? 0.32 : 1.88) },
  { vserver: "svm-prod-s3", name: "fg_ontap_s3_buckets", aggregate: "aggr1_nvme_prod", type: "RW-FG", size: "40.0TB", sizeGb: 40_960, avail: "14.00TB", usedPct: 65, tiering: "auto", exportPolicy: "default", qos: () => "none", latencyMs: () => 0.44 },
];

/**
 * The cluster as the server's own state holds it: what `vserver show`, `cluster show` and the demo's
 * MCP tools read. The same volumes as above, read each time they are asked for.
 */
export function showcaseOntapState(): OntapClusterState {
  return {
    clusterName: "NetApp-ONTAP-Prod-SE",
    version: "ONTAP 9.15.1P2",
    nodes: ["netapp-aff-a800-01a", "netapp-aff-a800-01b"],
    volumes: VOLUMES.map((v) => {
      const volume = { vserver: v.vserver, name: v.name, aggregate: v.aggregate, state: "online", sizeGb: v.sizeGb, usedPct: v.usedPct, exportPolicy: v.exportPolicy } as OntapVolumeInfo;
      Object.defineProperty(volume, "qosPolicyGroup", { enumerable: true, get: v.qos });
      Object.defineProperty(volume, "latencyMs", { enumerable: true, get: v.latencyMs });
      return volume;
    }),
    exportRules: [{ vserver: "svm-prod-nfs", policy: "trident_k8s_prod", ruleIndex: 1, clientMatch: "10.30.50.0/24", roRule: "sys", rwRule: "sys", superuser: "sys" }],
  };
}

/** The fields `volume show -fields` knows here, by the names ONTAP gives them. */
const VOLUME_FIELDS: Record<string, (v: ShowcaseVolume) => string> = {
  vserver: (v) => v.vserver,
  volume: (v) => v.name,
  aggregate: (v) => v.aggregate,
  state: () => "online",
  type: (v) => v.type,
  size: (v) => v.size,
  avail: (v) => v.avail,
  available: (v) => v.avail,
  "percent-used": (v) => `${v.usedPct}%`,
  "tiering-policy": (v) => v.tiering,
  "qos-policy-group": (v) => v.qos(),
};

const table = (rows: string[][]): string[] => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const row = (cells: string[]): string => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join(" ");
  return [row(rows[0]), widths.map((w) => "-".repeat(w)).join(" "), ...rows.slice(1).map(row)];
};

const volume: SimCommand = (ctx, args) => {
  const line = `volume ${args.join(" ")}`;
  const vserver = flagValue(args, "-vserver");
  const name = flagValue(args, "-volume");
  if (args[0] === "show") {
    const fields = flagValue(args, "-fields");
    // The whole list, as the script prints it on every node of the cluster.
    if (!vserver && !name && !fields) return scripted(ctx, "volume show");
    const found = VOLUMES.filter((v) => (!vserver || v.vserver === vserver) && (!name || v.name === name));
    if (!found.length) return ok("There are no entries matching your query.\n");
    const wanted = fields ? ["vserver", "volume", ...fields.split(",").map((f) => f.trim()).filter((f) => f && f !== "vserver" && f !== "volume")] : ["vserver", "volume", "aggregate", "state", "size", "percent-used", "qos-policy-group"];
    const unknown = wanted.find((f) => !VOLUME_FIELDS[f]);
    if (unknown) throw new NotSimulated(`volume show -fields ${unknown}`);
    return ok(lines([...table([wanted, ...found.map((v) => wanted.map((f) => VOLUME_FIELDS[f](v)))]), `${found.length} ${found.length === 1 ? "entry was" : "entries were"} displayed.`]));
  }
  if (args[0] === "modify") {
    const qos = flagValue(args, "-qos-policy-group");
    const target = VOLUMES.find((v) => v.name === name && (!vserver || v.vserver === vserver));
    if (!target) return fail(`Error: command failed: Volume "${name ?? ""}" in Vserver "${vserver ?? ""}" does not exist.\n`, 1);
    // The one change the showcase is about: the scratch volume's QoS limit, put on and taken off again.
    if (target.name !== SCRATCH || (qos !== QOS_CEILING && qos !== "none")) throw new NotSimulated(line);
    if (qos === QOS_CEILING) return scripted(ctx, line);
    demoClusterState.ontapQosFixed = false;
    return ok(`Volume modify successful on volume "${SCRATCH}" in Vserver "svm-prod-nfs": QoS policy group set to "none".\n`);
  }
  throw new NotSimulated(line);
};

const qos: SimCommand = (ctx, args) => {
  const line = `qos ${args.join(" ")}`;
  if (args[0] === "statistics" && args[1] === "volume" && (args[2] === "latency" || args[2] === "performance") && args[3] === "show") return scripted(ctx, line);
  if (args[0] === "policy-group" && args[1] === "show") {
    return ok(
      lines([
        ...table([
          ["Name", "Vserver", "Class", "Wklds", "Throughput"],
          [QOS_CEILING, "svm-prod-nfs", "user-defined", demoClusterState.ontapQosFixed ? "1" : "0", "0-15000IOPS,600MB/s"],
          ["pg-prod-db-extreme", "svm-prod-iscsi", "user-defined", "1", "10000-120000IOPS"],
          ["pg-trident-premium", "svm-prod-nfs", "user-defined", "1", "0-60000IOPS"],
        ]),
        "3 entries were displayed.",
      ]),
    );
  }
  throw new NotSimulated(line);
};

const storage: SimCommand = (ctx, args) => {
  const line = `storage ${args.join(" ")}`;
  if ((args[0] === "aggregate" || args[0] === "failover") && args[1] === "show") return scripted(ctx, line);
  throw new NotSimulated(line);
};

const snapmirror: SimCommand = (ctx, args) => {
  const line = `snapmirror ${args.join(" ")}`;
  if (args[0] === "show" || args[0] === "resync" || args[0] === "update") return scripted(ctx, line);
  throw new NotSimulated(line);
};

/** What the showcase's script says to a command by this name, whatever follows it. */
const asScripted =
  (name: string): SimCommand =>
  (ctx, args) =>
    scripted(ctx, [name, ...args].join(" "));

/** A program that is on some of the fleet's servers only: elsewhere the shell does not find it. */
const where =
  (has: (host: SimHost) => boolean, name: string, command: SimCommand): SimCommand =>
  (ctx, args) =>
    has(ctx.host) ? command(ctx, args) : fail(`bash: ${name}: command not found\n`, 127);

/** The ONTAP node, and the Active IQ server beside it, which the showcase lists in the same cluster and which answered these before. */
const seesOntap = (host: SimHost): boolean => host.kind === "ontap" || host.facts.has("showcase-ontap");
const hasCeph = (host: SimHost): boolean => host.facts.has("showcase-ceph");
const hasStorageGrid = (host: SimHost): boolean => host.facts.has("showcase-storagegrid");

/** The ONTAP commands the showcase answers. `vserver` and `cluster` are the simulated ones (programs/storage.ts), over `showcaseOntapState`. */
const ontapCommands: Record<string, SimCommand> = {
  volume,
  vol: volume,
  qos,
  storage,
  snapmirror,
  help: asScripted("help"),
  "?": asScripted("?"),
};

/** The names an ONTAP node of the fleet knows: its command line has these and no others. */
export const SHOWCASE_ONTAP_COMMANDS = ["vserver", "cluster", ...Object.keys(ontapCommands), "version", "uptime", "simulate-error", "test-error"];

// ---- Ceph, ZFS, StorageGRID --------------------------------------------------------------------

const ceph: SimCommand = (ctx, args) => {
  const line = `ceph ${args.join(" ")}`;
  const sub = args[0];
  if (sub === "status" || sub === "-s" || (sub === "osd" && args[1] === "df")) return scripted(ctx, line);
  // What the showcase lets be fixed: a deep scrub of the late placement group, or more backfills.
  if ((sub === "pg" && args[1] === "deep-scrub") || line.includes("osd_max_backfills")) return scripted(ctx, line);
  if (sub === "health") {
    if (demoClusterState.cephScrubFixed) return ok("HEALTH_OK\n");
    const head = "HEALTH_WARN 2 pgs not deep-scrubbed in time; 1 slow ops on osd.4";
    if (args[1] !== "detail") return ok(`${head}\n`);
    return ok(
      lines([
        head,
        "[WRN] PG_NOT_DEEP_SCRUBBED: 2 pgs not deep-scrubbed in time",
        "    pg 4.1a not deep-scrubbed since 2026-10-12T03:14:07.512+0000",
        "    pg 4.2f not deep-scrubbed since 2026-10-12T03:41:55.120+0000",
        "[WRN] SLOW_OPS: 1 slow ops, oldest one blocked for 34 sec, osd.4 has slow ops",
      ]),
    );
  }
  if (sub === "df") {
    // The same cluster `ceph status` describes: 491 TiB raw, 314 used, 6 pools, 1024 placement groups, 84.21M objects.
    return ok(
      lines([
        "--- RAW STORAGE ---",
        "CLASS     SIZE    AVAIL     USED  RAW USED  %RAW USED",
        "nvme   491 TiB  177 TiB  314 TiB   314 TiB      63.88",
        "TOTAL  491 TiB  177 TiB  314 TiB   314 TiB      63.88",
        "",
        "--- POOLS ---",
        "POOL                        ID   PGS   STORED  OBJECTS     USED  %USED  MAX AVAIL",
        "rbd-nvme-prod                1   512   82 TiB   61.40M  246 TiB  62.10     50 TiB",
        "cephfs_data                  2   256   14 TiB   14.80M   42 TiB  21.90     50 TiB",
        "cephfs_metadata              3    32  210 GiB    1.10M  630 GiB   0.41     50 TiB",
        "default.rgw.buckets.data     4   128  7.6 TiB    6.70M   23 TiB  13.30     50 TiB",
        "default.rgw.buckets.index    5    64   12 GiB  200.00k   36 GiB   0.02     50 TiB",
        ".mgr                         6    32  128 MiB       10  384 MiB      0     50 TiB",
      ]),
    );
  }
  throw new NotSimulated(line);
};

const aws: SimCommand = (ctx, args) => {
  const line = `aws ${args.join(" ")}`;
  // The bucket list is all the showcase has of S3 on the command line.
  if (args.includes("s3") && args[args.indexOf("s3") + 1] === "ls" && !args.some((a) => a.startsWith("s3://"))) return scripted(ctx, line);
  throw new NotSimulated(line);
};

// ---- Linux servers of the fleet ------------------------------------------------------------------

/** `iostat`: one report from the server's own disks. Nothing here runs for an interval, so the count is not waited for. */
const iostat: SimCommand = (ctx) => {
  const host = ctx.host;
  // The whole device a filesystem is on: nvme0n1p2 is on nvme0n1, sda2 on sda.
  const whole = (device: string): string => {
    const name = device.replace(/^\/dev\//, "");
    return /^nvme\d+n\d+/.exec(name)?.[0] ?? name.replace(/\d+$/, "");
  };
  const devices = [...new Set(host.disks.map((d) => whole(d.device)))];
  return ok(
    lines([
      `Linux ${host.kernel} (${host.name}) \t${new Date(host.now()).toISOString().slice(0, 10)} \t_x86_64_\t(${host.cpus} CPU)`,
      "",
      "avg-cpu:  %user   %nice %system %iowait  %steal   %idle",
      "           3.12    0.00    1.04    0.21    0.00   95.63",
      "",
      "Device            r/s     rkB/s   r_await     w/s     wkB/s   w_await  aqu-sz  %util",
      ...devices.map((dev, i) => `${dev.padEnd(12)} ${(18.4 + i * 6.2).toFixed(2).padStart(8)} ${(612.4 + i * 180).toFixed(2).padStart(9)} ${(0.21 + i * 0.03).toFixed(2).padStart(9)} ${(42.6 + i * 9.1).toFixed(2).padStart(7)} ${(1840.2 + i * 410).toFixed(2).padStart(9)} ${(0.34 + i * 0.04).toFixed(2).padStart(9)} ${(0.02 + i * 0.01).toFixed(2).padStart(7)} ${(1.8 + i * 0.7).toFixed(2).padStart(6)}`),
    ]),
  );
};

/** `vmstat`: one line from the server's memory and processor count. */
const vmstat: SimCommand = (ctx) => {
  const freeKb = Math.round(ctx.host.memoryMb * 1024 * 0.42);
  const cacheKb = Math.round(ctx.host.memoryMb * 1024 * 0.31);
  return ok(
    lines([
      "procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----",
      " r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st",
      ` 1  0      0 ${String(freeKb).padStart(6)} 184320 ${String(cacheKb).padStart(6)}    0    0    12    48  420  810  3  1 96  0  0`,
    ]),
  );
};

/**
 * What the base fleet's servers have beside the lab's usual commands. An appliance's program answers
 * where that appliance is, and is not found elsewhere.
 */
export const showcaseCommands: Record<string, SimCommand> = {
  ...Object.fromEntries(Object.entries(ontapCommands).map(([name, command]) => [name, where(seesOntap, name, command)])),
  // The release and the system, as the script gives them on an ONTAP node.
  version: where((host) => host.kind === "ontap", "version", (ctx) => scripted(ctx, "uptime")),
  ceph: where(hasCeph, "ceph", ceph),
  // The script prints the backup pool for `zpool` and `zfs` on every server of the Ceph and ZFS cluster.
  zpool: where(hasCeph, "zpool", asScripted("zpool")),
  zfs: where(hasCeph, "zfs", asScripted("zfs")),
  "storagegrid-status": where(hasStorageGrid, "storagegrid-status", asScripted("storagegrid-status")),
  "storagegrid-cli": where(hasStorageGrid, "storagegrid-cli", asScripted("storagegrid-cli")),
  aws: where(hasStorageGrid, "aws", aws),
  iostat,
  vmstat,
  // The showcase's made-up error, for trying "Explain and fix the error": on every one of its servers.
  "simulate-error": asScripted("simulate-error"),
  "test-error": asScripted("test-error"),
};
