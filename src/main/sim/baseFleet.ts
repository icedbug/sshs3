import { fileCommands } from "./commands/files";
import { netCommands } from "./commands/net";
import { systemCommands } from "./commands/system";
import { k8sCommands, type SimK8sState, type SimMultipathState } from "./programs/k8s";
import { ontapStorageCommands, type OntapClusterState } from "./programs/storage";
import { setSimWorld, simWorld, SimWorld } from "./SimWorld";

const DAY = 86_400_000;

/**
 * Builds an always-on stateful base fleet matching the core demo workspace servers.
 * Used in `SSHS3_DEMO=1` when no specific incident scenario is active, so terminals,
 * SFTP, ServerFacts, and SimMcpBridge operate on genuine stateful SimHosts instead
 * of falling back to stateless canned strings.
 *
 * Unit tests that call `emptyLab()` directly continue to get an empty SimWorld.
 */
export function buildBaseFleet(clock?: () => number): SimWorld {
  const world = new SimWorld(clock);
  world.register(fileCommands);
  world.register(systemCommands);
  world.register(netCommands);
  world.register(k8sCommands);
  world.register(ontapStorageCommands);
  world.building = true;
  const now = world.now();

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
  k8sCp.write("/etc/kubernetes/admin.conf", "apiVersion: v1\nkind: Config\ncurrent-context: k8s-trident-prod\n");
  k8sCp.write("/var/log/trident/trident-controller.log", `${new Date(now - 600_000).toISOString()} level=info msg="Trident backend ontap-nas-prod online"\n`);
  k8sCp.facts.set("k8s", {
    nodes: [
      { name: "k8s-storage-cp-01", status: "Ready", roles: "control-plane", age: "94d", version: "v1.31.2" },
      { name: "k8s-gpu-io-worker-01", status: "Ready", roles: "worker", age: "94d", version: "v1.31.2" },
    ],
    pods: [
      {
        namespace: "trident",
        name: "trident-controller-7c9d4b8c5-x2p9k",
        ready: "6/6",
        status: "Running",
        restarts: 0,
        age: "14d",
        node: "k8s-storage-cp-01",
        logs: ["Trident CSI 24.06 controller ready", "Connected to ONTAP SVM svm-prod-nfs (10.30.10.11)"],
        events: ["Normal  Started  14d  kubelet  Started container trident-main"],
      },
      {
        namespace: "prod",
        name: "orders-api-6d4f8b9c7-k9m2p",
        ready: "1/1",
        status: "Running",
        restarts: 0,
        age: "6d",
        node: "k8s-gpu-io-worker-01",
        pvc: "orders-data-pvc",
        logs: ["Listening on :8080", "Connected to PostgreSQL and ONTAP NFS volume"],
        events: ["Normal  Started  6d  kubelet  Started container orders-api"],
      },
    ],
    pvcs: [
      {
        namespace: "prod",
        name: "orders-data-pvc",
        status: "Bound",
        volume: "pvc-8f2a109c",
        capacity: "500Gi",
        accessModes: "RWX",
        storageClass: "ontap-nas-prod",
        age: "42d",
      },
    ],
    storageClasses: [
      { name: "ontap-nas-prod", provisioner: "csi.trident.netapp.io", reclaimPolicy: "Retain", bindingMode: "Immediate" },
      { name: "ontap-san-nvme", provisioner: "csi.trident.netapp.io", reclaimPolicy: "Retain", bindingMode: "WaitForFirstConsumer" },
    ],
    events: [{ namespace: "prod", lastSeen: "12m", type: "Normal", reason: "SuccessfulMountVolume", object: "pod/orders-api-6d4f8b9c7-k9m2p", message: "MountVolume.SetUp succeeded for volume pvc-8f2a109c" }],
    tridentBackends: [{ name: "ontap-nas-prod", driver: "ontap-nas", svm: "svm-prod-nfs", state: "online", volumes: 18 }],
    tridentVolumes: [{ name: "pvc-8f2a109c", size: "500Gi", storageClass: "ontap-nas-prod", state: "online", protocol: "file", backend: "ontap-nas-prod", exportPolicy: "trident_k8s_prod" }],
  } satisfies SimK8sState);

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
  k8sWorker.addService({ name: "kubelet", description: "Kubernetes Kubelet", ports: [{ proto: "tcp", port: 10250 }], command: "/usr/bin/kubelet" });
  k8sWorker.addService({ name: "multipathd", description: "Device-Mapper Multipath Device Controller", command: "/sbin/multipathd -d -s" });
  k8sWorker.write("/etc/multipath.conf", "defaults {\n    user_friendly_names yes\n    path_grouping_policy group_by_prio\n    prio alua\n}\n");
  k8sWorker.facts.set("multipath", {
    device: "mpatha",
    wwid: "3600a09803831456b722b524f31426631",
    vendor: "NETAPP,LUN C-Mode",
    size: "2.0T",
    pathGroupingPolicy: "group_by_prio",
    paths: [
      { dev: "sda", state: "active ready running", prio: 50 },
      { dev: "sdb", state: "enabled ready running", prio: 10 },
    ],
  } satisfies SimMultipathState);

  // 3. NetApp ONTAP AFF A800 Node A
  const ontapA = world.addHost(
    { name: "netapp-aff-a800-01a", address: "10.30.10.11", user: "admin", kind: "ontap" },
    "demo-netapp-aff-a800-01a",
  );
  ontapA.only = {
    commands: new Set(["vserver", "volume", "vol", "qos", "cluster", "storage"]),
    unknown: (name) => `Error: "${name}" is not a recognized command\n`,
  };
  ontapA.facts.set("ontap", {
    clusterName: "NetApp-ONTAP-Prod-SE",
    version: "ONTAP 9.15.1",
    nodes: ["netapp-aff-a800-01a", "netapp-aff-a800-01b"],
    volumes: [
      { vserver: "svm-prod-iscsi", name: "vol_pg_prod_01", aggregate: "aggr1_nvme_prod", state: "online", sizeGb: 4096, usedPct: 62, exportPolicy: "default", qosPolicyGroup: "pg-prod-db-extreme", latencyMs: 0.34 },
      { vserver: "svm-prod-nfs", name: "vol_k8s_pvc_prod", aggregate: "aggr1_nvme_prod", state: "online", sizeGb: 8192, usedPct: 54, exportPolicy: "trident_k8s_prod", qosPolicyGroup: "pg-k8s-prod", latencyMs: 0.47 },
      { vserver: "svm-prod-iscsi", name: "vol_analytics_scratch", aggregate: "aggr2_nvme_db", state: "online", sizeGb: 2048, usedPct: 48, exportPolicy: "default", qosPolicyGroup: "pg-batch-ceiling", latencyMs: 1.15 },
    ],
    exportRules: [
      { vserver: "svm-prod-nfs", policy: "trident_k8s_prod", ruleIndex: 1, clientMatch: "10.30.50.0/24", roRule: "sys", rwRule: "sys", superuser: "sys" },
    ],
  } satisfies OntapClusterState);

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
  cephMon.write("/etc/ceph/ceph.conf", "[global]\nfsid = 4b8e2f0a-91d4-4c6e-a123-90e4b1c8d771\nmon_host = 10.30.40.10\n");

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

  world.building = false;
  for (const host of world.hosts.values()) host.settingUp = false;
  world.settle();
  return world;
}

/**
 * Ensures the process-wide SimWorld has at least the stateful base fleet loaded
 * when no scenario is active. Does not overwrite an already-populated SimWorld.
 */
export function ensureBaseFleet(): SimWorld {
  const current = simWorld();
  if (current.hosts.size > 0) return current;
  const fleet = buildBaseFleet();
  setSimWorld(fleet);
  return fleet;
}
