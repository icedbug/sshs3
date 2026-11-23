import { demoServerFiles } from "../demo/DemoStorageProvider";
import { fileCommands } from "./commands/files";
import { netCommands } from "./commands/net";
import { systemCommands } from "./commands/system";
import { k8sCommands, type SimK8sState, type SimMultipathState } from "./programs/k8s";
import { SHOWCASE_ONTAP_COMMANDS, showcaseCommands, showcaseOntapState } from "./programs/showcase";
import { ontapStorageCommands } from "./programs/storage";
import type { SimHost } from "./SimHost";
import { baseFleetWanted, baseWorld, setBaseWorld, simWorld, SimWorld } from "./SimWorld";

const DAY = 86_400_000;

/**
 * The servers that are always there in a demo process: seven of the demo workspace's showcase servers,
 * simulated, so their terminals, files, facts and the demo's MCP tools work on servers that hold state.
 *
 * They tell the showcase's story, the one the demo's conversation, its scripted answers and its other
 * (scripted) servers tell: a scratch volume without a QoS limit on the ONTAP cluster, a GPU worker
 * whose multipath uses `multibus` where the control plane has `group_by_prio`, a SnapMirror
 * relationship that is broken off, a Ceph cluster with a warning. What an appliance says about its
 * cluster comes from the showcase's script (programs/showcase.ts), so the simulated node and the
 * scripted node of one cluster agree, and the files are the showcase's own (`demoServerFiles`).
 *
 * An incident's lab is a world of its own with this one behind it (`SimWorld.behind`): starting an
 * incident adds its servers beside these and takes nothing away, and ending it leaves these as they are.
 */
export function buildBaseFleet(clock?: () => number): SimWorld {
  const world = new SimWorld(clock);
  world.register(fileCommands);
  world.register(systemCommands);
  world.register(netCommands);
  world.register(k8sCommands);
  world.register(ontapStorageCommands);
  // After the others: on these servers the showcase's `volume`, `qos` and `storage` are the ones that answer.
  world.register(showcaseCommands);
  world.building = true;
  const now = world.now();

  // The cluster both Kubernetes nodes belong to: one state, so `kubectl` says the same on either.
  const k8s: SimK8sState = {
    nodes: [
      { name: "k8s-storage-cp-01", status: "Ready", roles: "control-plane", age: "94d", version: "v1.31.2" },
      { name: "k8s-gpu-io-worker-01", status: "Ready", roles: "worker", age: "94d", version: "v1.31.2" },
    ],
    pods: [
      {
        namespace: "trident",
        name: "trident-controller-67d9b8f9c-x8k2p",
        ready: "1/1",
        status: "Running",
        restarts: 0,
        age: "45d",
        node: "k8s-storage-cp-01",
        logs: ["Trident CSI 24.06.1 controller ready", "Connected to ONTAP SVM svm-prod-nfs (10.30.10.11)"],
        events: ["Normal  Started  45d  kubelet  Started container trident-main"],
      },
      {
        namespace: "trident",
        name: "trident-node-linux-9m4lw",
        ready: "2/2",
        status: "Running",
        restarts: 0,
        age: "45d",
        node: "k8s-gpu-io-worker-01",
        logs: ["Trident CSI 24.06.1 node plugin ready"],
        events: ["Normal  Started  45d  kubelet  Started container trident-main"],
      },
      {
        namespace: "ai-training",
        name: "dataset-loader-7c5d9f6b4-q2x8n",
        ready: "1/1",
        status: "Running",
        restarts: 0,
        age: "45d",
        node: "k8s-gpu-io-worker-01",
        pvc: "pvc-llm-dataset-flexgroup-01",
        logs: ["Mounted /mnt/trident/fg_llm_datasets (nfs4, nconnect=8)"],
        events: ["Normal  Started  45d  kubelet  Started container loader"],
      },
      {
        namespace: "ai-training",
        name: "llm-finetune-llama4-70b-0",
        ready: "1/1",
        status: "Running",
        restarts: 0,
        age: "12d",
        node: "k8s-gpu-io-worker-01",
        pvc: "pvc-llm-checkpoints-02",
        logs: ["checkpoint-step-12000 written", "p99 write latency above target on /checkpoints"],
        events: ["Normal  Started  12d  kubelet  Started container trainer"],
      },
      {
        namespace: "prod-db",
        name: "postgresql-ha-0",
        ready: "1/1",
        status: "Running",
        restarts: 0,
        age: "94d",
        node: "k8s-gpu-io-worker-01",
        pvc: "data-postgresql-ha-0",
        logs: ["database system is ready to accept connections"],
        events: ["Normal  Started  94d  kubelet  Started container postgresql"],
      },
    ],
    pvcs: [
      { namespace: "ai-training", name: "pvc-llm-dataset-flexgroup-01", status: "Bound", volume: "pvc-1192a8c0-ontap-fg", capacity: "80Ti", accessModes: "RWX", storageClass: "ontap-flexgroup-ai", age: "45d" },
      { namespace: "ai-training", name: "pvc-llm-checkpoints-02", status: "Bound", volume: "pvc-8f92a1b0-ontap-san", capacity: "4Ti", accessModes: "RWO", storageClass: "ontap-san-nvme", age: "12d" },
      { namespace: "prod-db", name: "data-postgresql-ha-0", status: "Bound", volume: "pvc-4401b2d9-ontap-san", capacity: "12Ti", accessModes: "RWO", storageClass: "ontap-san-nvme", age: "94d" },
    ],
    storageClasses: [
      { name: "ontap-flexgroup-ai", provisioner: "csi.trident.netapp.io", reclaimPolicy: "Retain", bindingMode: "Immediate" },
      { name: "ontap-nas-premium", provisioner: "csi.trident.netapp.io", reclaimPolicy: "Retain", bindingMode: "Immediate" },
      { name: "ontap-san-nvme", provisioner: "csi.trident.netapp.io", reclaimPolicy: "Retain", bindingMode: "WaitForFirstConsumer" },
    ],
    events: [{ namespace: "ai-training", lastSeen: "12m", type: "Normal", reason: "SuccessfulMountVolume", object: "pod/llm-finetune-llama4-70b-0", message: "MountVolume.SetUp succeeded for volume pvc-8f92a1b0-ontap-san" }],
    tridentBackends: [
      { name: "tbc-ontap-nas-premium", driver: "ontap-nas", svm: "svm-prod-nfs", state: "online", volumes: 38 },
      { name: "tbc-ontap-nas-flexgroup-ai", driver: "ontap-nas-flexgroup", svm: "svm-prod-nfs", state: "online", volumes: 14 },
      { name: "tbc-ontap-san-nvme-iscsi", driver: "ontap-san", svm: "svm-prod-iscsi", state: "online", volumes: 27 },
    ],
    tridentVolumes: [
      { name: "pvc-1192a8c0-ontap-fg", size: "80Ti", storageClass: "ontap-flexgroup-ai", state: "online", protocol: "file", backend: "tbc-ontap-nas-flexgroup-ai", exportPolicy: "trident_k8s_prod" },
      { name: "pvc-8f92a1b0-ontap-san", size: "4Ti", storageClass: "ontap-san-nvme", state: "online", protocol: "block", backend: "tbc-ontap-san-nvme-iscsi" },
      { name: "pvc-4401b2d9-ontap-san", size: "12Ti", storageClass: "ontap-san-nvme", state: "online", protocol: "block", backend: "tbc-ontap-san-nvme-iscsi" },
    ],
  };
  // The LUN both nodes see. The control plane follows the team's standard; the GPU worker does not, which is
  // the showcase's finding. Under multibus the paths that are not optimized carry I/O too, and the lab's
  // multipath (programs/k8s.ts) shows them as faulty until the policy is group_by_prio and the maps are reloaded.
  const multipath = (policy: SimMultipathState["pathGroupingPolicy"]): SimMultipathState => ({
    device: "mpatha",
    wwid: "3600a0980383146525a2b516a4b38724d",
    vendor: "NETAPP,LUN C-Mode",
    size: "4.0T",
    pathGroupingPolicy: policy,
    paths: [
      { dev: "sdb", state: "active ready running", prio: 50 },
      { dev: "sdc", state: "active ready running", prio: 50 },
      { dev: "sdd", state: policy === "group_by_prio" ? "enabled ready running" : "active faulty running", prio: 10 },
      { dev: "sde", state: policy === "group_by_prio" ? "enabled ready running" : "active faulty running", prio: 10 },
    ],
  });

  // 1. Kubernetes control plane + Trident CSI
  const k8sCp = world.addHost(
    {
      name: "k8s-storage-cp-01",
      address: "10.30.50.10",
      user: "ubuntu",
      cpus: 8,
      memoryMb: 32768,
      peers: [
        { localPort: 44812, remoteIp: "10.30.10.11", remotePort: 443, process: "trident-controller" },
        { localPort: 44910, remoteIp: "10.30.50.21", remotePort: 10250, process: "kube-apiserver" },
      ],
    },
    "demo-k8s-storage-cp-01",
  );
  k8sCp.disks = [{ mount: "/", device: "/dev/nvme0n1p2", fs: "ext4", sizeKb: 200 * 1024 * 1024, baseUsedKb: 42 * 1024 * 1024 }];
  k8sCp.packages = { "kubelet": "1.31.2-1.1", "kubectl": "1.31.2-1.1", "containerd.io": "1.7.22-1" };
  k8sCp.addService({ name: "kubelet", description: "Kubernetes Kubelet", ports: [{ proto: "tcp", port: 10250 }], command: "/usr/bin/kubelet" });
  k8sCp.addService({ name: "kube-apiserver", description: "Kubernetes API Server", ports: [{ proto: "tcp", port: 6443 }], command: "/usr/bin/kube-apiserver" });
  k8sCp.addService({ name: "multipathd", description: "Device-Mapper Multipath Device Controller", command: "/sbin/multipathd -d -s" });
  k8sCp.write("/etc/kubernetes/admin.conf", "apiVersion: v1\nkind: Config\ncurrent-context: k8s-trident-prod\n");
  k8sCp.write("/var/log/trident/trident-controller.log", `${new Date(now - 600_000).toISOString()} level=info msg="Trident backend tbc-ontap-nas-premium online"\n`);
  k8sCp.facts.set("k8s", k8s);
  k8sCp.facts.set("multipath", multipath("group_by_prio"));

  // 2. Kubernetes GPU/IO Worker
  const k8sWorker = world.addHost(
    {
      name: "k8s-gpu-io-worker-01",
      address: "10.30.50.21",
      user: "ubuntu",
      cpus: 32,
      memoryMb: 131072,
      peers: [
        { localPort: 51204, remoteIp: "10.30.10.11", remotePort: 2049, process: "nfsd" },
        { localPort: 51310, remoteIp: "10.30.50.10", remotePort: 6443, process: "kubelet" },
      ],
    },
    "demo-k8s-gpu-io-worker-01",
  );
  k8sWorker.disks = [
    { mount: "/", device: "/dev/nvme0n1p2", fs: "ext4", sizeKb: 400 * 1024 * 1024, baseUsedKb: 84 * 1024 * 1024 },
    { mount: "/var/lib/kubelet", device: "/dev/nvme1n1", fs: "xfs", sizeKb: 1000 * 1024 * 1024, baseUsedKb: 210 * 1024 * 1024 },
  ];
  k8sWorker.packages = { "kubelet": "1.31.2-1.1", "kubectl": "1.31.2-1.1", "containerd.io": "1.7.22-1" };
  k8sWorker.addService({ name: "kubelet", description: "Kubernetes Kubelet", ports: [{ proto: "tcp", port: 10250 }], command: "/usr/bin/kubelet" });
  k8sWorker.addService({ name: "multipathd", description: "Device-Mapper Multipath Device Controller", command: "/sbin/multipathd -d -s" });
  k8sWorker.facts.set("k8s", k8s);
  k8sWorker.facts.set("multipath", multipath("multibus"));

  // 3. NetApp ONTAP AFF A800 Node A
  const ontapA = world.addHost(
    { name: "netapp-aff-a800-01a", address: "10.30.10.11", user: "admin", kind: "ontap", os: { id: "ontap", version: "9.15.1P2", pretty: "NetApp Release 9.15.1P2" }, uptimeSeconds: 148 * 86_400 },
    "demo-netapp-aff-a800-01a",
  );
  ontapA.only = {
    commands: new Set(SHOWCASE_ONTAP_COMMANDS),
    unknown: (name) => `Error: "${name}" is not a recognized command`,
  };
  ontapA.facts.set("ontap", showcaseOntapState());
  ontapA.facts.set(
    "motd",
    [
      "NetApp ONTAP 9.15.1P2 cluster shell: netapp-aff-a800-01a (10.30.10.11)",
      "Cluster: NetApp-ONTAP-Prod-SE. HA partner: netapp-aff-a800-01b.",
      "Commands here: qos statistics volume latency show, volume show, storage aggregate show, storage failover show, snapmirror show, vserver show, cluster show, help.",
    ].join("\n"),
  );

  // 4. StorageGRID Gateway
  const sgAdmin = world.addHost(
    {
      name: "sg-admin-primary-01",
      address: "10.30.30.10",
      user: "admin",
      cpus: 16,
      memoryMb: 65536,
      peers: [
        { localPort: 54102, remoteIp: "10.30.30.21", remotePort: 18082, process: "ldr" },
        { localPort: 54103, remoteIp: "10.30.30.22", remotePort: 18082, process: "ldr" },
      ],
    },
    "demo-sg-admin-primary-01",
  );
  sgAdmin.disks = [{ mount: "/", device: "/dev/sda2", fs: "ext4", sizeKb: 500 * 1024 * 1024, baseUsedKb: 112 * 1024 * 1024 }];
  sgAdmin.addService({ name: "storagegrid-lb", description: "StorageGRID S3 Load Balancer", ports: [{ proto: "tcp", port: 10443 }], command: "/usr/sbin/storagegrid-lb" });
  sgAdmin.certs.set("/etc/ssl/certs/s3-dc1.pem", { subject: "CN=s3-dc1.storage.acme.se", issuer: "CN=Acme Internal CA", notBefore: now - 60 * DAY, notAfter: now + 180 * DAY, names: ["s3-dc1.storage.acme.se"] });
  sgAdmin.write("/etc/ssl/certs/s3-dc1.pem", "-----BEGIN CERTIFICATE-----\nSIMULATED-SG-CERT\n-----END CERTIFICATE-----\n");
  sgAdmin.facts.set("showcase-storagegrid", true);

  // 5. Ceph Monitor / Manager
  const cephMon = world.addHost(
    {
      name: "ceph-mon-mgr-01",
      address: "10.30.40.10",
      user: "cephadm",
      cpus: 16,
      memoryMb: 65536,
      peers: [{ localPort: 49210, remoteIp: "10.30.40.21", remotePort: 6800, process: "ceph-mon" }],
    },
    "demo-ceph-mon-mgr-01",
  );
  cephMon.disks = [{ mount: "/", device: "/dev/nvme0n1p2", fs: "ext4", sizeKb: 250 * 1024 * 1024, baseUsedKb: 58 * 1024 * 1024 }];
  cephMon.addService({ name: "ceph-mon", description: "Ceph cluster monitor daemon", ports: [{ proto: "tcp", port: 3300 }], command: "/usr/bin/ceph-mon -f" });
  cephMon.facts.set("showcase-ceph", true);

  // 6. Monitoring / ActiveIQ Harvest Host
  const aiq = world.addHost(
    {
      name: "ontap-aiq-um-01",
      address: "10.30.10.25",
      user: "maint",
      cpus: 8,
      memoryMb: 32768,
      peers: [
        { localPort: 47201, remoteIp: "10.30.10.11", remotePort: 443, process: "harvest" },
        { localPort: 47202, remoteIp: "10.30.30.10", remotePort: 10443, process: "prometheus" },
      ],
    },
    "demo-ontap-aiq-um-01",
  );
  aiq.disks = [{ mount: "/", device: "/dev/sda2", fs: "ext4", sizeKb: 200 * 1024 * 1024, baseUsedKb: 64 * 1024 * 1024 }];
  aiq.addService({ name: "prometheus", description: "Prometheus Monitoring Server", ports: [{ proto: "tcp", port: 9090 }], command: "/usr/bin/prometheus" });
  aiq.addService({ name: "grafana-server", description: "Grafana Dashboard Server", ports: [{ proto: "tcp", port: 3000 }], command: "/usr/sbin/grafana-server" });
  // Listed in the ONTAP cluster: what is run on every node of that cluster is answered here too.
  aiq.facts.set("showcase-ontap", true);

  // 7. SAN Bastion Jump Host
  const bastion = world.addHost(
    {
      name: "san-bastion-jump-01",
      address: "10.30.99.10",
      user: "jacob",
      cpus: 4,
      memoryMb: 16384,
      peers: [
        { localPort: 58100, remoteIp: "10.30.50.10", remotePort: 6443, process: "kubectl" },
        { localPort: 58101, remoteIp: "10.30.10.11", remotePort: 22, process: "ssh" },
      ],
    },
    "demo-san-bastion-jump-01",
  );
  bastion.disks = [{ mount: "/", device: "/dev/vda1", fs: "ext4", sizeKb: 100 * 1024 * 1024, baseUsedKb: 22 * 1024 * 1024 }];
  bastion.addService({ name: "sshd", description: "OpenBSD Secure Shell server", ports: [{ proto: "tcp", port: 22 }], command: "/usr/sbin/sshd -D" });
  bastion.write("/home/jacob/README.txt", "Demo lab jump host. Use ssh <host> '<cmd>' to inspect other simulated servers in this lab.\n");

  // The showcase's own files, the ones its scripted servers show in the file manager: on the worker
  // /etc/multipath.conf says multibus, on the others group_by_prio.
  for (const host of world.hosts.values()) writeShowcaseFiles(host);

  world.building = false;
  for (const host of world.hosts.values()) host.settingUp = false;
  world.settle();
  return world;
}

function writeShowcaseFiles(host: SimHost): void {
  for (const file of demoServerFiles(host.name)) host.write(file.path, `${file.content}\n`, { mode: file.permissions?.includes("x") ? 0o755 : 0o644 });
}

/**
 * Puts the base fleet in place when it is not there yet, and gives it back. It is built once for the
 * process and keeps its state from then on: an incident's lab comes and goes in front of it. Without
 * the fleet (a test switched it off) the lab is given back as it stands.
 */
export function ensureBaseFleet(): SimWorld {
  if (!baseFleetWanted()) return simWorld();
  const there = baseWorld();
  if (there) return there;
  const fleet = buildBaseFleet();
  setBaseWorld(fleet);
  return fleet;
}
