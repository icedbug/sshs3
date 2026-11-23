import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', async () => await import('../../src/main/web/electronShim'));

import { resolveKubeConfigWritePath } from '../../src/main/services/K8sAuthService';
import { K8sDiscoveryService } from '../../src/main/services/K8sDiscoveryService';
import { loadKubeConfigForContext } from '../../src/main/services/k8sKubeConfig';
import { isWebServerProcess, setWebServerProcess } from '../../src/main/web/tenantBoundary';
import { startWebServer, type WebClient, type WebServerKit } from '../helpers/webServerKit';

const kubeconfig = (context: string, user: string, userLines: string[]): string =>
  [
    'apiVersion: v1',
    'kind: Config',
    `current-context: ${context}`,
    'clusters:',
    '- name: prod',
    '  cluster:',
    '    server: https://prod.example.invalid:6443',
    'users:',
    `- name: ${user}`,
    '  user:',
    ...userLines.map((line) => `    ${line}`),
    'contexts:',
    `- name: ${context}`,
    '  context:',
    '    cluster: prod',
    `    user: ${user}`,
    '',
  ].join('\n');

/**
 * W2: every Kubernetes service fell back to the process' own kubeconfig, so each account saw, and could
 * use, every cluster another account had signed in to.
 */
describe('web server: an account sees its own Kubernetes clusters only', () => {
  let kit: WebServerKit;
  let maria: WebClient;
  let omar: WebClient;
  let adminId: string;
  let memberId: string;
  const envBefore = { ...process.env };

  beforeEach(async () => {
    kit = await startWebServer();
    // The server's own kubeconfig, where every account's sign-in used to land.
    process.env.KUBECONFIG = path.join(kit.tmpDir, 'server-kubeconfig');
    await fs.writeFile(process.env.KUBECONFIG, kubeconfig('servers-own-prod', 'operator', ['token: the-servers-own-token']));
    await fs.mkdir(path.join(os.homedir(), '.kube'), { recursive: true });
    await fs.writeFile(path.join(os.homedir(), '.kube', 'config'), kubeconfig('servers-home-prod', 'operator', ['token: the-servers-home-token']));
    const team = await kit.team();
    adminId = team.adminId;
    memberId = team.memberId;
    maria = await kit.connect(team.adminCookie);
    omar = await kit.connect(team.memberCookie);
  });

  afterEach(async () => {
    maria.close();
    omar.close();
    await kit.stop();
    process.env = { ...envBefore };
  });

  it('nobody is shown the server\'s own kubeconfig', async () => {
    for (const client of [maria, omar]) {
      await client.invoke('k8s:reload');
      expect(await client.invoke('k8s:list-contexts')).toEqual([]);
    }
  });

  it('a cluster one account signed in to is not shown to another', async () => {
    // Where a sign-in of Maria's is written: her own folder (k8s:login needs a live cluster, so the file is put there).
    const mariasFile = path.join(kit.dataDir, 'users', adminId, '.kube', 'config');
    await fs.mkdir(path.dirname(mariasFile), { recursive: true });
    await fs.writeFile(mariasFile, kubeconfig('marias-prod', 'maria', ['token: marias-secret-token']));
    await maria.invoke('k8s:reload');
    await omar.invoke('k8s:reload');
    const seenByMaria = JSON.stringify(await maria.invoke('k8s:list-contexts'));
    const seenByOmar = JSON.stringify(await omar.invoke('k8s:list-contexts'));
    expect(seenByMaria).toContain('marias-prod');
    expect(seenByMaria).not.toContain('servers-own-prod');
    expect(seenByOmar).toBe('[]');

    // Every service of an account was given that account's file, and a sign-in is written there.
    const users = await kit.server.auth.listUsers();
    for (const [id, name] of [[adminId, 'maria'], [memberId, 'omar']] as const) {
      const tenant = await kit.server.tenants.getOrCreateTenant(users.find((u) => u.username === name)!);
      const own = path.join(kit.dataDir, 'users', id, '.kube', 'config');
      expect(tenant.bridge.tenantKubeConfigPath).toBe(own);
      expect(tenant.bridge.k8sDiscoveryService.getKubeconfigPath()).toBe(own);
      for (const service of [tenant.bridge.k8sDebugService, tenant.bridge.k8sTerminalManager, tenant.bridge.k8sLogManager, tenant.bridge.k8sPortForwardManager, tenant.bridge.perfMetricsService]) {
        expect((service as unknown as { kubeConfigPath?: string }).kubeConfigPath).toBe(own);
      }
      // A connection to a pod's files reads the same file.
      const pod = await tenant.bridge.storageRegistry.getOrCreate({ id: 'k8s-x', name: 'x', type: 'k8s', k8sConfig: { contextName: 'c', namespace: 'n', podName: 'p' } as never });
      expect((pod as unknown as { kubeConfigPath?: string }).kubeConfigPath).toBe(own);
    }
  });

  it('a user entry that signs in by running a program is left out', async () => {
    const mariasFile = path.join(kit.dataDir, 'users', adminId, '.kube', 'config');
    await fs.mkdir(path.dirname(mariasFile), { recursive: true });
    const marker = path.join(kit.tmpDir, 'program-ran');
    await fs.writeFile(
      mariasFile,
      kubeconfig('with-program', 'runner', ['exec:', '  apiVersion: client.authentication.k8s.io/v1', '  command: /bin/sh', `  args: ["-c", "touch ${marker}"]`]),
    );
    const kc = await loadKubeConfigForContext('with-program', mariasFile);
    expect(kc.getUsers()).toEqual([]);
    expect(kc.getContexts().map((c) => c.name)).toEqual(['with-program']);
    await maria.invoke('k8s:reload');
    // Listing namespaces would have run the program to get a token; the entry is gone, so nothing runs.
    await maria.invoke('k8s:list-namespaces', 'with-program').catch(() => undefined);
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it('on a web server nothing reads or writes a kubeconfig it was not given', async () => {
    expect(isWebServerProcess()).toBe(true);
    await expect(loadKubeConfigForContext('servers-own-prod')).rejects.toThrow(/not set up for an account of this server/);
    await expect(new K8sDiscoveryService().listContexts()).rejects.toThrow(/not set up for an account of this server/);
    expect(() => resolveKubeConfigWritePath()).toThrow(/not set up for an account of this server/);
    expect(resolveKubeConfigWritePath('/data/users/u1/.kube/config')).toBe('/data/users/u1/.kube/config');
    // An account that never signed in to a cluster has no file: that is no clusters, not an error.
    const none = await loadKubeConfigForContext('x', path.join(kit.tmpDir, 'no-such-kubeconfig'));
    expect(none.getContexts()).toEqual([]);
  });

  it('the desktop app reads the person\'s own kubeconfig as before', async () => {
    setWebServerProcess(false);
    try {
      expect(resolveKubeConfigWritePath()).toBe(process.env.KUBECONFIG);
      const contexts = await new K8sDiscoveryService().listContexts();
      expect(JSON.stringify(contexts)).toContain('servers-own-prod');
      // A program entry is the person's own business there.
      const file = path.join(kit.tmpDir, 'desktop-kubeconfig');
      await fs.writeFile(file, kubeconfig('with-program', 'runner', ['exec:', '  apiVersion: client.authentication.k8s.io/v1', '  command: aws']));
      expect((await loadKubeConfigForContext('with-program', file)).getUsers().map((u) => u.name)).toEqual(['runner']);
    } finally {
      setWebServerProcess(true);
    }
  });
});
