import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDemoModeForTesting } from "../../src/main/demo/demoMode";
import { HubService, type HubHost } from "../../src/main/ai/hub/HubService";
import { ChatBridge } from "../../src/main/ai/hub/ChatBridge";
import { parseFacts } from "../../src/main/ai/hub/ServerFacts";
import { getDemoActivityLog, getDemoMcpServers, getDemoServers, mcpCatalog } from "../../src/main/ai/hub/demoWorkspace";
import { buildBaseFleet } from "../../src/main/sim/baseFleet";
import { simFactsOutput } from "../../src/main/sim/facts";
import { emptyLab, scenarioById, startScenario, stopScenario } from "../../src/main/sim/lab";
import { querySimMcpTool } from "../../src/main/sim/SimMcpBridge";
import { setSimWorld, simWorld } from "../../src/main/sim/SimWorld";
import { SLACK_APPROVE_ACTION, SLACK_DENY_ACTION } from "../../src/main/web/chatAgent/chatFormat";
import { SimChat } from "../../src/main/web/chatAgent/simChat";
import type { AgentTask } from "../../src/shared/types/aiHub";

const tempDirs: string[] = [];
const hubs: HubService[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createDemoHub(): Promise<{ hub: HubService; dir: string }> {
  setDemoModeForTesting(true);
  const dir = await makeTempDir("sshs3-m1-demo-");
  const host: HubHost = {
    changed: () => undefined,
    inventoryTargets: async () => [],
    openSchedule: async () => "sched-sess",
    workspaceServers: async () => getDemoServers(),
    backgroundChanged: async () => undefined,
    show: () => undefined,
  };
  const hub = new HubService(host, dir);
  await hub.initialize();
  hubs.push(hub);
  return { hub, dir };
}

afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.dispose();
  await new Promise((r) => setTimeout(r, 30));
  stopScenario();
  setSimWorld(undefined);
  setDemoModeForTesting(false);
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("M1 Core Simulation Engine Upgrades", () => {
  it("runs world.laws across hosts and emits @@sshs3:peers parsed by ServerFacts", () => {
    const world = emptyLab();
    const web = world.addHost({
      name: "web-01",
      address: "10.30.80.10",
      peers: [{ localPort: 45120, remoteIp: "10.30.80.20", remotePort: 8080, process: "nginx" }],
    });
    const app = world.addHost({ name: "app-01", address: "10.30.80.20" });
    app.addService({ name: "api", description: "API", state: "inactive", ports: [{ proto: "tcp", port: 8080 }] });
    world.laws.push((w) => {
      const up = w.host("app-01")?.service("api")?.state === "active";
      web.facts.set("upstream_ok", up);
    });
    world.settle();
    expect(web.facts.get("upstream_ok")).toBe(false);

    const appShell = world.shell(app);
    appShell.run("sudo systemctl start api");
    expect(web.facts.get("upstream_ok")).toBe(true);

    const rawFacts = simFactsOutput(web);
    expect(rawFacts).toContain("@@sshs3:peers");
    expect(rawFacts).toContain("10.30.80.20:8080");
    const parsed = parseFacts(rawFacts, Date.now());
    expect(parsed.peers).toContain("10.30.80.20:8080");
  });

  it("supports ssh cross-host execution, ss filters, iptables, nft, ufw show raw, find -printf, jq, xargs, column, and sysctl", () => {
    const world = buildBaseFleet();
    const bastion = world.host("san-bastion-jump-01")!;
    bastion.facts.set("ufw", { active: true, allow: ["22/tcp", "443/tcp"] });
    bastion.write("/tmp/data.json", JSON.stringify({ items: [{ name: "a", n: 2 }, { name: "b", n: 5 }] }));
    bastion.write("/tmp/rows.txt", "host role\nweb-01 edge\napp-01 api\n");

    const sh = world.shell(bastion);

    // Cross-host ssh inside the same SimWorld
    const sshRes = sh.run("ssh k8s-storage-cp-01 'hostname'");
    expect(sshRes.code).toBe(0);
    expect(sshRes.output.trim()).toBe("k8s-storage-cp-01");

    // ss with filters and established peers
    const ssListen = sh.run("ss -tln 'sport = :22'");
    expect(ssListen.code).toBe(0);
    expect(ssListen.output).toContain(":22");
    const ssEstab = sh.run("ss -tn state established");
    expect(ssEstab.code).toBe(0);
    expect(ssEstab.output).toContain("10.30.50.10:6443");

    // iptables, nft, ufw show raw
    expect(sh.run("sudo iptables -S").output).toContain("-A INPUT -p tcp --dport 443 -j ACCEPT");
    expect(sh.run("sudo iptables -L -n").output).toContain("tcp dpt:443");
    expect(sh.run("sudo nft list ruleset").output).toContain("tcp dport 443 accept");
    expect(sh.run("sudo ufw show raw").output).toContain("Chain INPUT (policy DROP)");

    // find -printf
    const fp = sh.run("find /tmp -maxdepth 1 -name 'data.json' -printf '%f %s\\n'");
    expect(fp.code).toBe(0);
    expect(fp.output).toMatch(/^data\.json \d+\n$/);

    // jq
    const jqSel = sh.run("jq -r '.items[] | select(.n > 3) | .name' /tmp/data.json");
    expect(jqSel.code).toBe(0);
    expect(jqSel.output.trim()).toBe("b");
    expect(sh.run("jq '.items | length' /tmp/data.json").output.trim()).toBe("2");
    expect(sh.run("jq 'keys' /tmp/data.json").output).toContain('"items"');

    // xargs & column
    const xr = sh.run("printf 'one two\\n' | xargs -n 1 echo item:");
    expect(xr.code).toBe(0);
    expect(xr.output).toBe("item: one\nitem: two\n");
    const col = sh.run("column -t /tmp/rows.txt");
    expect(col.code).toBe(0);
    expect(col.output).toContain("web-01  edge");

    // sysctl
    expect(sh.run("sysctl -a").output).toContain("vm.swappiness = 10");
    expect(sh.run("sudo sysctl -w vm.swappiness=1").code).toBe(0);
    expect(sh.run("sysctl -n vm.swappiness").output.trim()).toBe("1");

    expect(sh.unsupported).toEqual([]);
  });

  it("answers the tools the demo's own MCP servers list from the lab's servers and the running incident", () => {
    setDemoModeForTesting(true);
    startScenario(scenarioById("k8s-pvc-mount-cascade")!);
    // The servers a demo workspace really has: the two it comes with and the ones its catalog offers.
    const offered = [
      ...getDemoMcpServers().map((s) => ({ id: s.id, tools: (s.discoveredTools ?? []).map((t) => t.name) })),
      ...mcpCatalog().map((p) => ({ id: p.id, tools: p.defaultTools.map((t) => t.name) })),
    ];
    const ask = (tool: string, args: Record<string, unknown> = {}) => {
      const server = offered.find((s) => s.tools.includes(tool));
      expect(server, `no demo MCP server lists ${tool}`).toBeDefined();
      const answer = querySimMcpTool(tool, args, server!.id);
      expect(answer, `${tool} has no answer from the lab`).toBeDefined();
      const parsed = JSON.parse(answer!);
      expect(parsed).toMatchObject({ simulated: true, server: server!.id, tool });
      return parsed;
    };

    const prom = ask("prometheus_query_range", { query: "up" });
    expect(prom.server).toBe("demo-mcp-prometheus");
    expect(prom.hosts.some((h: { host: string }) => h.host === "k8s-worker-01")).toBe(true);

    // The same server lists the alert tool: it answers with alerts, not with the metrics.
    const am = ask("alertmanager_list_firing_alerts");
    expect(am.server).toBe("demo-mcp-prometheus");
    expect(am.alerts.find((a: { alertname: string }) => a.alertname === "KubePodVolumeMountFailed")).toMatchObject({ status: "firing" });

    const netbox = ask("netbox_get_device_cables");
    expect(netbox.server).toBe("demo-mcp-netbox-ipam");
    expect(netbox.devices.some((d: { name: string }) => d.name === "netapp-prod-cl01")).toBe(true);

    const graf = ask("grafana_get_dashboard_summary");
    expect(graf.server).toBe("demo-mcp-grafana-loki");
    expect(graf.scenario).toBe("k8s-pvc-mount-cascade");
    expect(Array.isArray(ask("loki_query_logs").lines)).toBe(true);

    const pods = ask("k8s_list_pods_and_events");
    expect(pods.server).toBe("demo-mcp-kubernetes-helm");
    expect(pods.pods.length).toBeGreaterThan(0);
    expect(ask("trident_inspect_pvc_mapping").pvcs.length).toBeGreaterThan(0);
    expect(ask("ontap_get_volume_metrics").volumes.length).toBeGreaterThan(0);

    // A tool nobody lists has no answer from the lab, whatever server id is given with it.
    expect(querySimMcpTool("list_incidents", {}, "demo-mcp-prometheus")).toBeUndefined();
  });

  it("allows storage aggregate show on netapp-prod-cl01 during k8s-pvc-mount-cascade", () => {
    const world = startScenario(scenarioById("k8s-pvc-mount-cascade")!);
    const filer = world.host("netapp-prod-cl01")!;
    const sh = world.shell(filer);
    const res = sh.run("storage aggregate show");
    expect(res.code).toBe(0);
    expect(res.output).toContain("aggr1_nvme_prod");
    expect(sh.unsupported).toEqual([]);
  });

  it("supports xargs -0/--null with find -print0, sysctl -p (with and without path), and column -t -s hyphen delimiters", () => {
    const world = buildBaseFleet();
    const bastion = world.host("san-bastion-jump-01")!;
    bastion.write("/tmp/a.txt", "hello\n");
    bastion.write("/tmp/testfile.txt", "alpha\nfoo bar\nbeta\n");
    bastion.write("/etc/sysctl.conf", "# tuning\nvm.swappiness = 5\nnet.core.somaxconn = 4096\n");
    bastion.write("/tmp/custom-sysctl.conf", "vm.dirty_ratio = 15\n");
    const sh = world.shell(bastion);

    // Fix 4: xargs -0/--null and POSIX option-parsing stop at first non-option (child command)
    const x0 = sh.run("find /tmp/a.txt -print0 | xargs -0 echo");
    expect(x0.code).toBe(0);
    expect(x0.output).toBe("/tmp/a.txt\n");
    const xNull = sh.run("find /tmp/a.txt -print0 | xargs --null echo");
    expect(xNull.code).toBe(0);
    expect(xNull.output).toBe("/tmp/a.txt\n");
    const xR0 = sh.run("printf '/tmp/a.txt\\0/tmp/b space.txt\\0' | xargs -r0 echo");
    expect(xR0.code).toBe(0);
    expect(xR0.output).toBe("/tmp/a.txt /tmp/b space.txt\n");
    const xR0Empty = sh.run("printf '' | xargs -r0 echo hi");
    expect(xR0Empty.code).toBe(0);
    expect(xR0Empty.output).toBe("");
    const xDashDash = sh.run("printf 'foo\\0bar\\0' | xargs -0 -- echo");
    expect(xDashDash.code).toBe(0);
    expect(xDashDash.output).toBe("foo bar\n");
    const xEcho0 = sh.run("printf 'foo bar\\n' | xargs echo -0");
    expect(xEcho0.code).toBe(0);
    expect(xEcho0.output).toBe("-0 foo bar\n");
    const xEchoNull = sh.run("printf 'foo bar\\n' | xargs echo --null");
    expect(xEchoNull.code).toBe(0);
    expect(xEchoNull.output).toBe("--null foo bar\n");
    const xEchoR = sh.run("printf 'foo bar\\n' | xargs echo -r");
    expect(xEchoR.code).toBe(0);
    expect(xEchoR.output).toBe("-r foo bar\n");
    const xGrepN = sh.run("printf '/tmp/testfile.txt\\0' | xargs -0 grep -n foo");
    expect(xGrepN.code).toBe(0);
    expect(xGrepN.output).toContain("2:foo bar");
    const xLsLd = sh.run("printf '/tmp/testfile.txt\\n' | xargs ls -ld");
    expect(xLsLd.code).toBe(0);
    expect(xLsLd.output).toMatch(/^-rw.*\/tmp\/testfile\.txt/);
    const xReplaceDash0 = sh.run("printf 'hello\\n' | xargs -I -0 echo val:-0");
    expect(xReplaceDash0.code).toBe(0);
    expect(xReplaceDash0.output).toBe("val:hello\n");

    // Fix 5: sysctl -p and sysctl -p <path>
    const spDefault = sh.run("sysctl -p");
    expect(spDefault.code).toBe(0);
    expect(spDefault.output).toContain("vm.swappiness = 5");
    expect(spDefault.output).toContain("net.core.somaxconn = 4096");
    expect(sh.run("sysctl -n vm.swappiness").output.trim()).toBe("5");

    const spExplicit = sh.run("sysctl -p /etc/sysctl.conf");
    expect(spExplicit.code).toBe(0);
    expect(spExplicit.output).toContain("net.core.somaxconn = 4096");

    const spCustom = sh.run("sysctl -p /tmp/custom-sysctl.conf");
    expect(spCustom.code).toBe(0);
    expect(spCustom.output).toContain("vm.dirty_ratio = 15");
    expect(sh.run("sysctl -n vm.dirty_ratio").output.trim()).toBe("15");

    // Fix 6: column -t -s with hyphen range characters
    const colHyphen = sh.run("printf 'foo-barzqux\\n' | column -t -s 'z-a'");
    expect(colHyphen.code).toBe(0);
    expect(colHyphen.output).not.toContain("Invalid regular expression");
    expect(colHyphen.output).toContain("foo");
    expect(colHyphen.output).toContain("qux");

    expect(sh.unsupported).toEqual([]);
  });
});

describe("M1 Backend Bug Fixes, Demo Seeding & Interactive Actions", () => {
  it("BUG-1: correlates alerts using demo infrastructure edges", async () => {
    const { hub } = await createDemoHub();
    // Create an initial alert on netapp-aff-a800-01a (10.30.10.11)
    const first = await hub.request({
      action: "alert-paste",
      text: JSON.stringify({
        status: "firing",
        alerts: [
          {
            status: "firing",
            fingerprint: "fp-demo-edge-1",
            labels: { alertname: "OntapLatencyHigh", severity: "critical", instance: "10.30.10.11:9100" },
            annotations: { summary: "High latency on netapp-aff-a800-01a" },
          },
        ],
      }),
    });
    expect(first.reply?.alerts?.created.length).toBe(1);

    // Second alert on dependent k8s-gpu-io-worker-01 (10.30.50.21) connected via demo infra edge edge-k8s-mounts-ontap
    const second = await hub.request({
      action: "alert-paste",
      text: JSON.stringify({
        status: "firing",
        alerts: [
          {
            status: "firing",
            fingerprint: "fp-demo-edge-2",
            labels: { alertname: "KubePvcSlow", severity: "warning", instance: "10.30.50.21:9100" },
            annotations: { summary: "PVC mount latency on k8s-gpu-io-worker-01" },
          },
        ],
      }),
    });
    expect(second.reply?.alerts?.updated).toContain(first.reply?.alerts?.created[0]);
    expect(second.reply?.alerts?.created.length).toBe(0);
  });

  it("BUG-2: enforces toolPolicy ask and deny gates on demo MCP servers", async () => {
    const { hub } = await createDemoHub();
    await hub.request({
      action: "mcp-tool-policy",
      serverId: "demo-mcp-netapp-harvest",
      toolName: "ontap_get_volume_metrics",
      policy: "deny",
    });
    const task: AgentTask = {
      id: "task-bug2",
      title: "Check MCP policy",
      mode: "assisted",
      status: "running",
      messages: [],
      changes: [],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 10,
      maxMinutes: 5,
      verification: "not-verified",
    };
    hub.store.data.tasks.push(task);
    const cap = await hub.broker.issue(task);
    await expect(
      hub.broker.invoke(cap.key, {
        action: "mcp__demo-mcp-netapp-harvest__ontap_get_volume_metrics",
        payload: {},
      }),
    ).rejects.toThrow(/denied by tool policy/i);

    // Switch to "ask": invoking must create a pending approval change and wait on authorize
    await hub.request({
      action: "mcp-tool-policy",
      serverId: "demo-mcp-netapp-harvest",
      toolName: "ontap_get_volume_metrics",
      policy: "ask",
    });
    const pendingCall = hub.broker
      .invoke(cap.key, {
        action: "mcp__demo-mcp-netapp-harvest__ontap_get_volume_metrics",
        payload: {},
      })
      .then(
        () => ({ rejected: false }),
        () => ({ rejected: true }),
      );
    await new Promise((r) => setTimeout(r, 20));
    expect(task.changes.length).toBe(1);
    expect(task.changes[0].status).toBe("pending");
    expect(task.changes[0].forceApproval).toBe(true);
    await hub.request({ action: "approve", taskId: task.id, changeId: task.changes[0].id, approved: false });
    expect(await pendingCall).toEqual({ rejected: true });
  });

  it("BUG-3 & interactive actions: sim-replay, and sim-reset cleans up sim-* activity", async () => {
    const { hub } = await createDemoHub();
    const started = await hub.request({ action: "sim-start", scenarioId: "k8s-pvc-mount-cascade" });
    expect(started.simulation?.running?.id).toBe("k8s-pvc-mount-cascade");
    expect(started.simulation?.running?.tags).toEqual(["Multi-host", "Kubernetes", "Storage"]);
    expect(started.simulation?.running?.servers?.length).toBe(2);
    expect(getDemoActivityLog().some((e) => e.id.startsWith("sim-k8s-pvc-mount-cascade-"))).toBe(true);

    // The lab's clock is not a request: nothing in the app asked for it, so the hub does not know it.
    await expect(hub.request({ action: "sim-advance-time", minutes: 30 } as never)).rejects.toThrow("Unknown AI request: sim-advance-time");

    // Scripted careful walkthrough via sim-replay
    const replay = await hub.request({ action: "sim-replay", mode: "careful" });
    expect(replay.reply?.simReplay?.ok).toBe(true);
    expect(replay.reply?.simReplay?.score.passed).toBe(replay.reply?.simReplay?.score.total);
    expect(replay.simulation?.running?.lastReplay?.mode).toBe("careful");

    // Reset clears sim-* activity events (BUG-3)
    const reset = await hub.request({ action: "sim-reset" });
    expect(reset.simulation?.running).toBeUndefined();
    expect(getDemoActivityLog().some((e) => e.id.startsWith("sim-"))).toBe(false);
  });

  it("BUG-4: scheduleEvent scans active demo schedules in demo mode", async () => {
    const { hub } = await createDemoHub();
    await hub.request({ action: "configure", config: { enabled: true } });
    const launchSpy = vi.spyOn(hub, "launchSchedule").mockResolvedValue(undefined);
    await hub.scheduleEvent("facts_drift", ["demo-netapp-aff-a800-01a"]);
    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy.mock.calls[0][0].id).toBe("demo-sched-ontap-health");
    launchSpy.mockRestore();
  });

  it("marks simulated ChatBridge connections with simulated: true", async () => {
    const dir = await makeTempDir("sshs3-chat-sim-");
    const bridge = new ChatBridge(dir, { guard: () => ({ server: false, allowPrivate: false }) });
    await bridge.simulate("Acme", [{ id: "C1", name: "ops" }], []);
    const views = bridge.view();
    expect(views.length).toBe(1);
    expect(views[0].simulated).toBe(true);
  });

  it("seeds demo proposals, eval cases, daily report, runbooks, sends nothing on notify-channel-test, and records isolated demo audit log", async () => {
    const { hub, dir } = await createDemoHub();
    const snap = await hub.snapshot();
    expect(snap.memoryProposals?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(snap.evalCases?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(snap.dailyReport?.text).toBeTruthy();
    expect(snap.runbooks?.length ?? 0).toBeGreaterThanOrEqual(2);

    // notify-channel-test in demo mode sends nothing
    const saved = await hub.request({
      action: "notify-channel-save",
      channel: {
        name: "Ops Webhook",
        kind: "webhook",
        url: "https://93.184.216.34/ops",
        enabled: true,
        events: ["alert", "approval"],
        includeCommand: true,
      },
    });
    const channelId = saved.notifications?.channels[0]?.id;
    expect(channelId).toBeTruthy();
    // A delivery an earlier version made up for this channel is on it.
    hub.notifyStore.data.channels[0].last = { at: Date.now() - 60_000, ok: true, status: 200 };
    const tested = await hub.request({ action: "notify-channel-test", id: channelId! });
    // Nothing was sent, and the answer says so: it is not a delivery, and none is kept on the channel.
    expect(tested.reply?.notifyTest).toEqual({ ok: false, error: "Demo: nothing is sent from the demo lab." });
    expect(tested.notifications?.channels[0]?.last).toBeUndefined();
    expect(hub.notifyStore.data.channels[0].last).toBeUndefined();

    // The demo's audit notice says what is not recorded (AuditLogView): an incident that is started, a command
    // somebody types, a scripted walkthrough and a change of the safety rules leave the log empty.
    await hub.request({ action: "sim-start", scenarioId: "pg-wal-full" });
    simWorld().shell(simWorld().host("pg-prod-db01")!).run("df -h");
    await hub.request({ action: "sim-replay", mode: "careful" });
    await hub.request({ action: "safety-policy-save", policy: { clusterPolicies: { "Postgres-Prod": { maxMode: "assisted" } } } } as never);
    await new Promise((r) => setTimeout(r, 50));
    expect((await hub.request({ action: "audit-read", limit: 20 })).reply?.audit?.entries).toEqual([]);
    await hub.request({ action: "sim-reset" });

    // And what is: what an agent's run did. The log is kept in the demo's own folder.
    hub.store.data.tasks.push({
      id: "task-demo-audit-1",
      title: "Demo audit check",
      mode: "assisted",
      status: "completed",
      messages: [],
      changes: [
        {
          id: "chg-demo-audit-1",
          kind: "command",
          target: "k8s-worker-01",
          description: "Check pods",
          command: "kubectl get pods",
          status: "completed",
          exitCode: 0,
          at: Date.now(),
        },
      ],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 5,
      maxMinutes: 5,
      verification: "not-verified",
    });
    hub.auditFinishedChanges();
    await new Promise((r) => setTimeout(r, 50));
    const auditRes = await hub.request({ action: "audit-read", limit: 20 });
    expect(auditRes.reply?.audit?.entries.some((e) => e.changeId === "chg-demo-audit-1")).toBe(true);
    expect(auditRes.reply?.audit?.verification.ok).toBe(true);
    const files = await fs.readdir(path.join(dir, "audit"));
    expect(files.length).toBeGreaterThan(0);
  });

  it("SimChat supports click and react interactions for approval workflows", async () => {
    const chat = new SimChat({ service: "slack" });
    const events: string[] = [];
    const line = chat.transport("slack", {
      onEvent: (ev) => {
        if (ev.kind === "action") events.push(`action:${ev.value}`);
        else if (ev.kind === "reaction") events.push(`reaction:${ev.emoji}`);
      },
      onStatus: () => undefined,
      onIdentity: () => undefined,
    });
    await line.start();
    const posted = await chat.api.slackPost(
      { botToken: ["xoxb", "sim", "test"].join("-"), appToken: ["xapp", "sim", "test"].join("-") },
      {
        channel: "COPS",
        text: "Approve restart?",
        blocks: [
          {
            type: "actions",
            elements: [
              { type: "button", action_id: SLACK_APPROVE_ACTION, value: "v1.approve" },
              { type: "button", action_id: SLACK_DENY_ACTION, value: "v1.deny" },
            ],
          },
        ],
      },
    );
    chat.click(posted.ts, "approve", "UADMIN");
    chat.react(posted.ts, "white_check_mark", "UADMIN");
    await new Promise((r) => setImmediate(r));
    expect(events).toContain("action:v1.approve");
    expect(events).toContain("reaction:white_check_mark");
  });
});
