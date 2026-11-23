import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DemoStorageProvider, demoServerFiles } from "../../src/main/demo/DemoStorageProvider";
import { demoClusterState, DemoVirtualPty, executeDemoServerCommand, scriptedDemoText } from "../../src/main/demo/DemoVirtualPty";
import { setDemoModeForTesting } from "../../src/main/demo/demoMode";
import { HubService, type HubHost } from "../../src/main/ai/hub/HubService";
import { getDemoSchedules, getDemoServers, getDemoTasks, getDemoWorkforceRuns } from "../../src/main/ai/hub/demoWorkspace";
import { simulateDemoMcpTool } from "../../src/main/ai/hub/hubHelpers";
import { buildBaseFleet, ensureBaseFleet } from "../../src/main/sim/baseFleet";
import { stopScenario } from "../../src/main/sim/lab";
import { SimStorageProvider } from "../../src/main/sim/SimStorageProvider";
import { baseWorld, setBaseFleetForTesting, setBaseWorld, simWorld, type SimWorld } from "../../src/main/sim/SimWorld";
import { StorageRegistry } from "../../src/main/storage/StorageRegistry";
import type { AgentTask } from "../../src/shared/types/aiHub";

/**
 * The servers that are always there in the demo (the base fleet): seven of the showcase's servers,
 * simulated. They were added to answer more than the scripted servers they replaced, and answered
 * less: the commands the demo itself suggests were not found on them, their data told another story
 * than the demo's own texts, and an incident replaced them. Hub tests ran without them, so nothing
 * showed it. These tests run with the fleet on, as every demo process has it.
 */

const FLEET = ["k8s-storage-cp-01", "k8s-gpu-io-worker-01", "netapp-aff-a800-01a", "sg-admin-primary-01", "ceph-mon-mgr-01", "ontap-aiq-um-01", "san-bastion-jump-01"];

const dirs: string[] = [];
const hubs: HubService[] = [];

const resetShowcase = (): void => {
  demoClusterState.ontapQosFixed = false;
  demoClusterState.snapmirrorResynced = false;
  demoClusterState.cephScrubFixed = false;
  demoClusterState.multipathFixed = false;
};

beforeEach(resetShowcase);
afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.dispose();
  await new Promise((r) => setTimeout(r, 30));
  stopScenario();
  setDemoModeForTesting(undefined);
  resetShowcase();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function makeHub(demo = true): Promise<HubService> {
  setDemoModeForTesting(demo);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-fleet-"));
  dirs.push(dir);
  const host: HubHost = {
    changed: () => undefined,
    inventoryTargets: async () => [],
    openSchedule: async () => "sched",
    workspaceServers: async () => (demo ? getDemoServers() : []),
    backgroundChanged: async () => undefined,
    show: () => undefined,
    aiConfigFilePath: path.join(dir, "ai-config.json"),
  };
  const hub = new HubService(host, dir);
  await hub.initialize();
  hubs.push(hub);
  return hub;
}

/** Runs a line on a server and holds it to an answer: exit 0, and nothing the lab does not simulate. */
function answers(world: SimWorld, server: string, line: string): string {
  const host = world.host(server);
  expect(host, `${server} is not in the lab`).toBeDefined();
  const shell = world.shell(host!);
  const ran = shell.run(line);
  expect({ server, line, code: ran.code, notSimulated: shell.unsupported, output: ran.output.slice(0, 200) }).toMatchObject({ code: 0, notSimulated: [] });
  return ran.output;
}

/** The fleet's servers of a cluster of the demo workspace. */
const fleetOf = (cluster: string): string[] => getDemoServers().filter((s) => s.cluster === cluster && FLEET.includes(s.name)).map((s) => s.name);

describe("the demo's base fleet", () => {
  it("is on in a demo hub without anything being set, off when a test says so, and never outside the demo", async () => {
    await makeHub(true);
    expect(baseWorld()).toBeDefined();
    expect(simWorld()).toBe(baseWorld());
    expect([...simWorld().hosts.values()].map((h) => h.name).sort()).toEqual([...FLEET].sort());
    for (const server of getDemoServers().filter((s) => FLEET.includes(s.name))) expect(simWorld().host(server.id)?.name, server.id).toBe(server.name);

    // The explicit switch a test of the scripted servers uses. Nothing reads VITEST for this.
    setBaseFleetForTesting(false);
    expect(baseWorld()).toBeUndefined();
    await makeHub(true);
    expect(simWorld().host("netapp-aff-a800-01a")).toBeUndefined();

    setBaseFleetForTesting(true);
    await makeHub(false);
    expect(baseWorld()).toBeUndefined();
  });

  it("answers every command the demo's own schedules, runbooks, workforce runs, conversation and scripted answer name", async () => {
    const hub = await makeHub();
    const world = simWorld();
    const asked: string[] = [];
    const ask = (servers: string[], line: string): void => {
      expect(servers.length, `no fleet server for: ${line}`).toBeGreaterThan(0);
      for (const server of servers) {
        answers(world, server, line);
        asked.push(`${server}: ${line}`);
      }
    };

    // The seeded runbooks, on the fleet's servers of the cluster each one is for.
    const runbooks = (await hub.snapshot()).runbooks ?? [];
    expect(runbooks.map((r) => r.id)).toEqual(["demo-runbook-k8s-multipath", "demo-runbook-ontap-health"]);
    for (const runbook of runbooks) {
      const values = Object.fromEntries(runbook.inputs.map((i) => [i.name, String(i.defaultValue ?? "")]));
      for (const step of runbook.steps) if (step.command) ask(fleetOf(runbook.targetSelector!.cluster!), step.command.replace(/\{\{(\w+)\}\}/g, (_, name: string) => values[name] ?? ""));
    }

    // The scripted workforce run: what it recommends for each cluster, on that cluster's servers.
    const clusters = [...new Set(getDemoServers().map((s) => s.cluster!).filter(Boolean))];
    for (const cluster of clusters) {
      const run = await hub.simulateDemoWorkforceRun({ prompt: `Check ${cluster}`, targetCluster: cluster });
      for (const step of run.steps) {
        const servers = fleetOf(step.targetCluster ?? "");
        // A step for no cluster of the workspace recommends the general Linux check: on the fleet's Linux servers.
        for (const line of step.recommendedCommands ?? []) ask(servers.length ? servers : FLEET.filter((name) => world.host(name)!.kind === "linux"), line);
      }
    }

    // The workforce run that comes with the demo.
    for (const run of getDemoWorkforceRuns()) for (const step of run.steps) for (const line of step.recommendedCommands ?? []) ask(fleetOf(step.targetCluster ?? ""), line);
    resetShowcase();

    // The seeded schedules: the commands their prompts quote, on the server each schedule runs on.
    const quoted = getDemoSchedules().flatMap((s) => [...s.prompt.matchAll(/`([^`]+)`/g)].map((m) => ({ server: getDemoServers().find((x) => x.id === s.profileId)!.name, line: m[1] })));
    expect(quoted.map((q) => q.line)).toEqual(["ceph health detail", "ceph df"]);
    for (const q of quoted) ask([q.server], q.line);

    // The demo's conversation: what its agent ran on the second ONTAP node, here on the first node of the same cluster.
    for (const change of getDemoTasks().flatMap((t) => t.changes)) {
      expect(change.target).toBe("netapp-aff-a800-01b");
      for (const line of [change.command, change.check?.command, change.rollback?.command]) if (line) ask(["netapp-aff-a800-01a"], line);
    }
    resetShowcase();

    // The scripted answer of the demo (DEMO_SHOWCASE_RESPONSE, renderer): its proposed commands.
    const { DEMO_SHOWCASE_RESPONSE } = await import("../../src/renderer/src/components/AiHub/panel/panelHelpers");
    const block = /### 3\. Proposed commands[\s\S]*?```bash\n([\s\S]*?)```/.exec(DEMO_SHOWCASE_RESPONSE)![1].trim().split("\n");
    expect(block).toEqual([
      "# On netapp-aff-a800-01b:",
      "volume modify -vserver svm-prod-nfs -volume vol_ai_scratch_03 -qos-policy-group pg-batch-ceiling",
      "qos statistics volume latency show -iterations 3",
      "# On k8s-gpu-io-worker-01:",
      "sudo multipath -r && sudo multipath -ll",
    ]);
    ask(["netapp-aff-a800-01a"], block[1]);
    ask(["netapp-aff-a800-01a"], block[2]);
    ask(["k8s-gpu-io-worker-01"], block[4]);

    // Nothing above was an empty list: the reviewer's own probe is in it.
    for (const line of ["ceph-mon-mgr-01: ceph status && ceph osd df tree", "netapp-aff-a800-01a: snapmirror show", "k8s-gpu-io-worker-01: kubectl get pvc,volumeattachment -A -o wide", "netapp-aff-a800-01a: storage aggregate show", "sg-admin-primary-01: iostat -xz 1 2"]) expect(asked).toContain(line);
    expect(asked.length).toBeGreaterThan(30);
  });

  it("answers what the showcase's servers answered before it, and the snippets written for these servers", () => {
    const world = buildBaseFleet();
    for (const line of ["storage failover show", "storage aggregate show -fields size,usedsize,percent-used,state", "snapmirror show -fields source-path,destination-path,state,status,healthy,lag-time", "qos statistics volume latency show -iterations 5 -rows 15", "qos statistics volume performance show", "qos policy-group show", "vserver show", "cluster show", "version", "uptime", "help"]) answers(world, "netapp-aff-a800-01a", line);
    for (const line of ["ceph -s && ceph osd df tree && ceph df detail", "ceph health", "zpool status -v && zfs list -o name,used,avail,refer,compressratio,mountpoint", "cat /etc/ceph/ceph.conf"]) answers(world, "ceph-mon-mgr-01", line);
    for (const line of ["storagegrid-status", "aws s3 ls", "uptime && free -h && vmstat 1 3 && iostat -xz 1 2"]) answers(world, "sg-admin-primary-01", line);
    for (const line of ["tridentctl get backend -n trident && kubectl get sc,pvc -A -o wide", "kubectl get pods,pvc -A -o wide", "kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded && kubectl get events -A --sort-by='.lastTimestamp' | tail -n 25", "kubectl get pvc,volumeattachment -n ai-training -o wide", "cat /etc/multipath.conf"]) {
      answers(world, "k8s-storage-cp-01", line);
      answers(world, "k8s-gpu-io-worker-01", line);
    }
    // What the showcase's made-up error is for: a failing command to try "Explain and fix the error" on.
    const error = world.shell(world.host("k8s-gpu-io-worker-01")!).run("simulate-error");
    expect(error.code).toBe(32);
    expect(error.output).toContain("path_grouping_policy mismatch (configured: multibus, expected ALUA: group_by_prio)");

    // An appliance's program is where the appliance is, and nowhere else.
    const bastion = world.shell(world.host("san-bastion-jump-01")!);
    expect(bastion.run("ceph status")).toMatchObject({ code: 127, output: "bash: ceph: command not found\n" });
    expect(bastion.run("volume show").code).toBe(127);
    // What the fleet's ONTAP node does not have, it says, and the lab writes down.
    const ontap = world.shell(world.host("netapp-aff-a800-01a")!);
    expect(ontap.run("system health alert show")).toMatchObject({ code: 1, output: 'Error: "system" is not a recognized command\n' });
    expect(ontap.run("volume delete -vserver svm-prod-nfs -volume vol_ai_scratch_03").code).toBe(2);
    expect(ontap.unsupported).toEqual(["system health alert show", "volume delete -vserver svm-prod-nfs -volume vol_ai_scratch_03"]);
  });

  it("tells the showcase's story: what the scripted texts say is what the servers report, and a fix shows on both nodes of a cluster", async () => {
    const world = buildBaseFleet();
    // In place as the lab, so the demo's MCP tools read these servers.
    setBaseWorld(world);
    const volumeMetrics = (): { volumes: Array<{ volume: string }> } => JSON.parse(simulateDemoMcpTool("ontap_get_volume_metrics", {}, "demo-mcp-netapp-harvest"));
    const on = (server: string, line: string): string => world.shell(world.host(server)!).run(line).output;

    // "On k8s-gpu-io-worker-01, multipath uses multibus instead of ALUA group_by_prio": the scripted answer, the seeded conversation and workforce run.
    expect(on("k8s-gpu-io-worker-01", "multipath -ll")).toContain("path_grouping_policy: multibus");
    expect(on("k8s-storage-cp-01", "multipath -ll")).toContain("path_grouping_policy: group_by_prio");
    // The diff of the scripted answer, line for line.
    expect(on("k8s-storage-cp-01", "grep path_grouping_policy /etc/multipath.conf")).toBe("        path_grouping_policy group_by_prio\n");
    expect(on("k8s-gpu-io-worker-01", "grep path_grouping_policy /etc/multipath.conf")).toBe("        path_grouping_policy multibus\n");
    // And it can be fixed, the way the demo's conversation says: set the policy, reload, list.
    expect(on("k8s-gpu-io-worker-01", "sudo sed -i 's/path_grouping_policy multibus/path_grouping_policy group_by_prio/' /etc/multipath.conf && sudo multipath -r && sudo multipath -ll")).toContain("path_grouping_policy: group_by_prio");

    // "vol_ai_scratch_03 has no QoS policy ... 2.45 ms ... vol_pg_prod_db01 (1.88 ms)".
    const scripted = (line: string): string => scriptedDemoText("netapp-aff-a800-01b", line)!.text;
    const latency = on("netapp-aff-a800-01a", "qos statistics volume latency show -iterations 1");
    expect(latency).toMatch(/vol_ai_scratch_03\s+4812\s+2\.45ms/);
    expect(latency).toMatch(/vol_pg_prod_db01\s+4109\s+1\.88ms/);
    // Two nodes of one cluster say the same: the simulated one and the scripted one.
    for (const line of ["qos statistics volume latency show -iterations 1", "volume show", "storage aggregate show", "snapmirror show", "storage failover show"]) expect(on("netapp-aff-a800-01a", line), line).toBe(`${scripted(line)}\n`);
    const check = "volume show -vserver svm-prod-nfs -volume vol_ai_scratch_03 -fields qos-policy-group";
    expect(on("netapp-aff-a800-01a", check)).toBe("vserver      volume            qos-policy-group\n------------ ----------------- ----------------\nsvm-prod-nfs vol_ai_scratch_03 none\n1 entry was displayed.\n");
    // The demo's MCP tool reads the same volume.
    expect(volumeMetrics().volumes.find((v) => v.volume === "vol_ai_scratch_03")).toMatchObject({ qosPolicy: "none", latencyMs: 2.45 });

    // The fix the demo proposes, on the simulated node: the seeded check passes, and the scripted node shows it too.
    on("netapp-aff-a800-01a", "volume modify -vserver svm-prod-nfs -volume vol_ai_scratch_03 -qos-policy-group pg-batch-ceiling");
    expect(on("netapp-aff-a800-01a", check)).toContain("svm-prod-nfs vol_ai_scratch_03 pg-batch-ceiling");
    expect(on("netapp-aff-a800-01a", "qos statistics volume latency show")).toMatch(/vol_ai_scratch_03\s+4812\s+0\.41ms/);
    expect(scripted("qos statistics volume performance show")).toMatch(/vol_ai_scratch_03.*pg-batch-ceiling/);
    expect(volumeMetrics().volumes.find((v) => v.volume === "vol_ai_scratch_03")).toMatchObject({ qosPolicy: "pg-batch-ceiling", latencyMs: 0.41 });
    // And the seeded rollback takes it off again, on both.
    on("netapp-aff-a800-01a", "volume modify -vserver svm-prod-nfs -volume vol_ai_scratch_03 -qos-policy-group none");
    expect(on("netapp-aff-a800-01a", check)).toContain("svm-prod-nfs vol_ai_scratch_03 none");
    expect(scripted("qos statistics volume performance show")).toMatch(/vol_ai_scratch_03.*none \(UNBOUNDED!\)/);

    // The Ceph cluster of `ceph status` is the one `ceph df` and `ceph health` describe.
    expect(on("ceph-mon-mgr-01", "ceph status")).toContain("health: HEALTH_WARN (2 pgs not deep-scrubbed in time; 1 slow ops on osd.4)");
    expect(on("ceph-mon-mgr-01", "ceph health detail")).toContain("HEALTH_WARN 2 pgs not deep-scrubbed in time; 1 slow ops on osd.4");
    expect(on("ceph-mon-mgr-01", "ceph df")).toContain("TOTAL  491 TiB  177 TiB  314 TiB");
    on("ceph-mon-mgr-01", "ceph pg deep-scrub 4.1a");
    expect(on("ceph-mon-mgr-01", "ceph health detail")).toBe("HEALTH_OK\n");
    expect(executeDemoServerCommand("ceph-osd-nvme-01", "ceph status").output).toContain("health: HEALTH_OK");

    // The cluster kubectl describes is the one the demo's texts name: the same on both nodes.
    const pvcs = on("k8s-gpu-io-worker-01", "kubectl get pvc -n ai-training");
    expect(pvcs).toContain("pvc-llm-checkpoints-02");
    expect(pvcs).toContain("ontap-flexgroup-ai");
    expect(on("k8s-storage-cp-01", "kubectl get pvc -n ai-training")).toBe(pvcs);
    expect(on("k8s-storage-cp-01", "tridentctl get backend -n trident")).toContain("tbc-ontap-nas-flexgroup-ai");
  });

  it("holds the files the showcase's file manager showed, on every server", async () => {
    setDemoModeForTesting(true);
    ensureBaseFleet();
    const registry = new StorageRegistry();
    for (const server of getDemoServers().filter((s) => FLEET.includes(s.name))) {
      const sftpConfig = { id: server.id, name: server.name, host: server.host, port: 22, username: server.username, authType: "password" as const, password: "demo" }; // pragma: allowlist secret
      const provider = await registry.getOrCreate({ id: `sftp-${server.id}`, name: server.name, type: "sftp", sftpConfig });
      expect(provider, server.name).toBeInstanceOf(SimStorageProvider);
      // What the scripted file manager of this server shows, folder by folder and file by file.
      const before = new DemoStorageProvider({ id: "before", name: server.name, type: "sftp", hostOrBucket: server.name });
      for (const folder of ["/", "/etc", "/etc/ceph", "/etc/trident", "/var/log", "/root/runbooks"]) {
        const now = (await provider.list(folder)).map((e) => e.name);
        for (const entry of await before.list(folder)) expect(now, `${server.name}:${folder}`).toContain(entry.name);
      }
      for (const file of demoServerFiles(server.name)) expect((await provider.readFile!(file.path)).toString("utf8"), `${server.name}:${file.path}`).toBe(`${file.content}\n`);
    }
    // The file the reviewer missed: /etc on the NetApp.
    const netapp = await registry.getOrCreate({ id: "sftp-demo-netapp-aff-a800-01a", name: "netapp-aff-a800-01a", type: "sftp", sftpConfig: { id: "demo-netapp-aff-a800-01a", name: "netapp-aff-a800-01a", host: "10.30.10.11", port: 22, username: "admin", authType: "password", password: "demo" } }); // pragma: allowlist secret
    expect((await netapp.list("/etc")).map((e) => e.name)).toContain("multipath.conf");
    await registry.disconnectAll();
  });

  it("greets in a terminal as the machine it is, and runs there what the terminal of the scripted node runs", async () => {
    setDemoModeForTesting(true);
    ensureBaseFleet();
    const pty = new DemoVirtualPty({ id: "session-1", name: "netapp-aff-a800-01a", host: "10.30.10.11", port: 22, username: "admin", authType: "password" } as never);
    let shown = "";
    pty.onData((data) => (shown += data));
    await new Promise((r) => setTimeout(r, 60));
    expect(shown).toContain("NetApp ONTAP 9.15.1P2 cluster shell: netapp-aff-a800-01a");
    expect(shown).not.toContain("Ubuntu");
    expect(shown.endsWith("netapp-aff-a800-01a::> ")).toBe(true);
    shown = "";
    pty.write("snapmirror show\r");
    expect(shown).toContain("svm-prod-nfs:fg_llm_datasets_prod  XDP   svm-dr-uppsala:vol_ai_checkpoints_dr Broken-off");
    expect(shown.endsWith("netapp-aff-a800-01a::> ")).toBe(true);
    pty.kill();
  });

  it("stays, as it was left, when an incident starts and when it ends: the incident's servers are added beside it", async () => {
    const hub = await makeHub();
    const fleet = baseWorld()!;
    const bastion = fleet.host("san-bastion-jump-01")!;
    fleet.shell(bastion).run("echo kept > /home/jacob/note.txt");
    fleet.shell(fleet.host("k8s-gpu-io-worker-01")!).run("no-such-command --at-all");

    const started = await hub.request({ action: "sim-start", scenarioId: "pg-wal-full" });
    const lab = simWorld();
    expect(lab).not.toBe(fleet);
    expect(baseWorld()).toBe(fleet);
    // The incident's own servers, and the fleet's, each found by name, by address and by the id of its saved server.
    expect([...lab.hosts.keys()].sort()).toEqual(["pg-prod-db01", "pg-prod-db02"]);
    expect(lab.everyHost().map((h) => h.name).sort()).toEqual([...FLEET, "pg-prod-db01", "pg-prod-db02"].sort());
    expect(lab.host("san-bastion-jump-01")).toBe(bastion);
    expect(lab.host("10.30.99.10")).toBe(bastion);
    expect(lab.host("demo-san-bastion-jump-01")).toBe(bastion);
    expect(lab.shell(bastion).run("cat /home/jacob/note.txt").output).toBe("kept\n");
    for (const server of FLEET) expect(lab.host(server), server).toBe(fleet.host(server));
    // The same commands as without an incident.
    answers(lab, "netapp-aff-a800-01a", "snapmirror show");
    answers(lab, "ceph-mon-mgr-01", "ceph status");
    answers(lab, "k8s-gpu-io-worker-01", "kubectl get pvc,volumeattachment -A -o wide");

    // What is run on the fleet is no part of the incident's score: not its commands, not what the lab lacks.
    const running = started.simulation!.running!;
    const after = (await hub.snapshot()).simulation!.running!;
    expect(running.commands).toBe(0);
    expect(after.commands).toBe(0);
    expect(after.unsupported).toEqual([]);
    lab.shell(lab.host("pg-prod-db01")!).run("df -h /var/lib/postgresql");
    expect((await hub.snapshot()).simulation!.running!.commands).toBe(1);

    // A cluster run on the fleet's cluster, while the incident runs: the simulated node answers from its state.
    const task: AgentTask = { id: "task-fleet", title: "Fleet", mode: "autonomous", status: "running", messages: [], changes: [], sources: [], createdAt: Date.now(), updatedAt: Date.now(), maxCommands: 10, maxMinutes: 5, verification: "not-verified" };
    const cap = await hub.broker.issue(task);
    const ran = (await hub.broker.invoke(cap.key, { action: "sshs3_cluster_exec", payload: { cluster: "NetApp-ONTAP-Prod-SE", command: "storage aggregate show" } })) as { results: Array<{ node: string; source: string; note?: string; output: string; exitCode: number }> };
    const simulated = ran.results.find((r) => r.node === "netapp-aff-a800-01a")!;
    const scriptedNode = ran.results.find((r) => r.node === "netapp-aff-a800-01b")!;
    expect(simulated).toMatchObject({ source: "demo-cluster:demo-netapp-aff-a800-01a", exitCode: 0 });
    expect(simulated.note).toBeUndefined();
    expect(scriptedNode.note).toMatch(/scripted examples/);
    expect(simulated.output).toContain("aggr1_nvme_prod    220TB     61.6TB     72%");
    expect(scriptedNode.output).toContain("aggr1_nvme_prod    220TB     61.6TB     72%");

    const ended = await hub.request({ action: "sim-reset" });
    expect(ended.simulation!.running).toBeUndefined();
    expect(simWorld()).toBe(fleet);
    expect(simWorld().host("pg-prod-db01")).toBeUndefined();
    expect(simWorld().shell(bastion).run("cat /home/jacob/note.txt").output).toBe("kept\n");
  });
});
