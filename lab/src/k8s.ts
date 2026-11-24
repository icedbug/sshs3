import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadLab } from './lab';
import { STATE_DIR, type ExecResult } from './ssh';

const BIN = path.join(STATE_DIR, 'bin');
export const KIND = path.join(BIN, 'kind');
export const KUBECTL = path.join(BIN, 'kubectl');
const DOWNLOADS: Array<[string, string]> = [
  [KIND, 'https://github.com/kubernetes-sigs/kind/releases/download/v0.27.0/kind-linux-amd64'],
  [KUBECTL, 'https://dl.k8s.io/release/v1.32.2/bin/linux/amd64/kubectl'],
];
// The workloads' images, pulled once on this machine and loaded into the cluster: a task's run pulls nothing.
const IMAGES = ['docker.io/library/nginx:1.27-alpine', 'docker.io/library/busybox:1.36'];

function run(file: string, args: string[], timeoutMs = 10 * 60_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

async function must(file: string, args: string[], what: string, timeoutMs?: number): Promise<string> {
  const r = await run(file, args, timeoutMs);
  if (r.code !== 0) throw new Error(`${what} failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(-1500)}`);
  return r.stdout;
}

const clusterName = (n: number): string => `sshs3lab${n}`;
const reasonPath = (n: number): string => path.join(STATE_DIR, `k8s-${n}.reason`);

/**
 * The lab's Kubernetes cluster: kind, one node, its API on this machine's loopback. Returns undefined,
 * with the reason written beside the lab's state, when a cluster cannot run here: the tasks that need
 * one are then skipped and the report says why.
 */
export async function k8sUp(n: number): Promise<{ kubeconfigPath: string; server: string } | undefined> {
  // A cluster that could not run here is not tried again on every call (each try takes minutes), unless asked.
  if (process.env.SSHS3_LAB_K8S_RETRY !== '1') {
    try {
      await fs.access(reasonPath(n));
      return undefined;
    } catch {
      // Not tried, or it ran: go on.
    }
  }
  try {
    await fs.mkdir(BIN, { recursive: true });
    for (const [file, url] of DOWNLOADS) {
      try {
        await fs.access(file);
      } catch {
        await must('curl', ['-sSfL', '-m', '300', '-o', file, url], `Downloading ${path.basename(file)}`);
        await fs.chmod(file, 0o755);
      }
    }
    const name = clusterName(n);
    const clusters = (await must(KIND, ['get', 'clusters'], 'Listing kind clusters')).split('\n').map((l) => l.trim());
    if (!clusters.includes(name)) await must(KIND, ['create', 'cluster', '--name', name, '--wait', '180s'], 'Creating the kind cluster', 15 * 60_000);
    const kubeconfigPath = path.join(STATE_DIR, `lab-${n}`, 'kubeconfig');
    await fs.mkdir(path.dirname(kubeconfigPath), { recursive: true });
    await fs.writeFile(kubeconfigPath, await must(KIND, ['get', 'kubeconfig', '--name', name], 'Reading the kubeconfig'), { mode: 0o600 });
    for (const image of IMAGES) {
      if ((await run('docker', ['image', 'inspect', image], 30_000)).code !== 0) await must('docker', ['pull', '-q', image], `Pulling ${image}`);
      await must(KIND, ['load', 'docker-image', image, '--name', name], `Loading ${image} into the cluster`);
    }
    const server = (await must(KUBECTL, ['--kubeconfig', kubeconfigPath, 'config', 'view', '-o', 'jsonpath={.clusters[0].cluster.server}'], 'Reading the API address')).trim();
    try {
      const lab = await loadLab(n);
      lab.k8s = { kubeconfigPath, server };
      await fs.writeFile(path.join(STATE_DIR, `lab-${n}.json`), JSON.stringify(lab, null, 2), { mode: 0o600 });
    } catch {
      // No lab state yet: the cluster stands on its own.
    }
    await fs.rm(reasonPath(n), { force: true });
    return { kubeconfigPath, server };
  } catch (error) {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(reasonPath(n), error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/** A namespace of a run's own: what a task does in the cluster stays in it, and is deleted afterwards. */
export async function k8sNamespace(n: number, runId: string): Promise<string> {
  const ns = `run-${runId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63).replace(/-+$/, '');
  const kubeconfigPath = path.join(STATE_DIR, `lab-${n}`, 'kubeconfig');
  await must(KUBECTL, ['--kubeconfig', kubeconfigPath, 'create', 'namespace', ns], `Creating the namespace ${ns}`);
  return ns;
}
