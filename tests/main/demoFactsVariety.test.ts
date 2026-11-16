import { describe, expect, it } from "vitest";
import { demoFactsOutput } from "../../src/main/ai/hub/demoFacts";
import { parseFacts } from "../../src/main/ai/hub/ServerFacts";

const NOW = Date.UTC(2026, 10, 12, 12);
const DAY = 86_400_000;
const read = (name: string) => parseFacts(demoFactsOutput({ name, host: "10.1.1.1" }, NOW, 0), NOW);

// The servers the demo lab lists that answer the script.
const LINUX = ["ceph-mon-mgr-01", "ceph-osd-nvme-01", "k8s-gpu-io-worker-01", "k8s-storage-cp-01", "minio-aistor-edge-01", "san-bastion-jump-01"];

describe("demo server facts", () => {
  it("does not read StorageGRID or TrueNAS appliances as Ubuntu", () => {
    for (const name of ["sg-admin-primary-01", "sg-sn-nvme-01", "sg-sn-nvme-02", "truenas-zfs-vault-01", "storagegrid-gw-01", "netapp-aff-a800-01a"])
      expect(read(name).unsupported, name).toBe(true);
    // A name that only contains "sg-" inside a word is still a server.
    expect(read("msg-queue-01").unsupported).toBeUndefined();
  });

  it("is not one release and one kernel everywhere, and the package manager fits the release", () => {
    const names = [...LINUX, "web-prod-01", "web-prod-02", "pg-prod-01", "pg-prod-02", "cache-01", "build-01"];
    const all = names.map(read);
    for (const f of all) expect(f.unsupported).toBeUndefined();
    expect(new Set(all.map((f) => f.os?.pretty)).size).toBeGreaterThan(1);
    expect(new Set(all.map((f) => f.kernel)).size).toBeGreaterThan(1);
    expect(new Set(LINUX.map((n) => read(n).os?.pretty)).size).toBeGreaterThan(1);
    for (const f of all) {
      expect(f.packageManager).toBe(/Rocky/.test(f.os?.pretty ?? "") ? "rpm" : "dpkg");
      expect(Object.keys(f.packages ?? {}).length).toBeGreaterThan(2);
    }
    // A Kubernetes node runs a kubelet, not a web server.
    expect(read("k8s-storage-cp-01").runningServices).toContain("kubelet");
    expect(read("k8s-storage-cp-01").runningServices).not.toContain("nginx");
  });

  it("has at most one certificate close to its end among the demo lab's servers", () => {
    const soon = LINUX.flatMap((n) => read(n).certs ?? []).filter((c) => c.notAfter - NOW < 30 * DAY);
    expect(soon.length).toBe(1);
  });
});
