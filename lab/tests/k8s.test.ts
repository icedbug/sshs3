import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { k8sNamespace, k8sUp, KUBECTL } from '../src/k8s';

const N = 9;

describe('Kubernetes in the lab', () => {
  it('the cluster answers and the shop deploys', async (ctx) => {
    const k8s = await k8sUp(N);
    if (!k8s) {
      ctx.skip();
      return;
    }
    const kubectl = (...args: string[]): string => execFileSync(KUBECTL, ['--kubeconfig', k8s.kubeconfigPath, ...args], { encoding: 'utf8' }).trim();
    expect(kubectl('get', 'nodes', '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}')).toBe('True');

    const ns = await k8sNamespace(N, `test-${Date.now()}`);
    try {
      kubectl('apply', '-n', ns, '-f', 'lab/k8s/shop.yaml');
      kubectl('wait', '-n', ns, '--for=condition=Available', 'deployment/shop-web', 'deployment/shop-worker', '--timeout=120s');
      expect(kubectl('get', '-n', ns, 'deployment', 'shop-web', '-o', 'jsonpath={.status.availableReplicas}')).toBe('2');
    } finally {
      kubectl('delete', 'namespace', ns, '--wait=false');
    }
  });
});
