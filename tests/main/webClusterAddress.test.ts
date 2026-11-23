import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

vi.mock('electron', async () => await import('../../src/main/web/electronShim'));

import { forgetAllowedClusterAddressesForTesting } from '../../src/main/services/k8sKubeConfig';
import { startWebServer, type WebServerKit } from '../helpers/webServerKit';

/**
 * A cluster's address is one an account types. On a web server that several accounts share, a member
 * signing in to "a cluster" made the server call any address on its own network with the member's
 * token, and the answer came back in the error message. The address is now held to the rule the other
 * endpoints an account names are held to: private and loopback addresses are refused on a shared
 * server unless the administrator allows them.
 */
describe('a cluster address on a web server', () => {
  let kit: WebServerKit | undefined;
  let inside: http.Server | undefined;
  let hits: Array<{ url?: string; auth?: string }>;
  let insidePort: number;
  const envBefore = { ...process.env };

  /** A service only the server itself can reach. `asCluster` makes it answer like a cluster's API. */
  const startInside = async (asCluster: boolean): Promise<void> => {
    hits = [];
    inside = http.createServer((req, res) => {
      hits.push({ url: req.url, auth: req.headers.authorization });
      if (asCluster && req.url === '/api') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ kind: 'APIVersions', versions: ['v1'] }));
        return;
      }
      res.writeHead(asCluster ? 404 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ secret: 'internal-only-data-42', filler: 'x'.repeat(2000) }));
    });
    insidePort = await new Promise((resolve) => {
      inside!.listen(0, '127.0.0.1', () => resolve((inside!.address() as { port: number }).port));
    });
  };

  beforeEach(() => {
    delete process.env.SSHS3_ALLOW_PRIVATE_ADDRESSES;
    forgetAllowedClusterAddressesForTesting();
  });

  afterEach(async () => {
    inside?.close();
    inside = undefined;
    await kit?.stop();
    kit = undefined;
    process.env = { ...envBefore };
  });

  const loginText = async (cookie: string): Promise<string> => {
    const client = await kit!.connect(cookie);
    try {
      await client.invoke('k8s:login', { server: `http://127.0.0.1:${insidePort}`, token: 'member-chosen-token', insecureSkipTlsVerify: true });
      return 'signed in';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      client.close();
    }
  };

  it('a member of a shared server cannot make it call its own network by signing in to a cluster', async () => {
    await startInside(false);
    kit = await startWebServer();
    const { memberCookie } = await kit.team();

    const answer = await loginText(memberCookie);

    expect(hits).toEqual([]);
    expect(answer).not.toContain('internal-only-data-42');
    expect(answer).toContain('not reached from this server');
    expect(answer).toContain('SSHS3_ALLOW_PRIVATE_ADDRESSES=1');
  });

  it('a cluster already in the account\'s kubeconfig is not called there either', async () => {
    await startInside(true);
    kit = await startWebServer();
    const { memberCookie, memberId } = await kit.team();
    const own = path.join(kit.dataDir, 'users', memberId, '.kube', 'config');
    await fs.mkdir(path.dirname(own), { recursive: true });
    await fs.writeFile(
      own,
      [
        'apiVersion: v1',
        'kind: Config',
        'current-context: inside',
        'clusters:',
        '- name: inside',
        '  cluster:',
        `    server: http://127.0.0.1:${insidePort}`,
        'users:',
        '- name: omar',
        '  user:',
        '    token: member-chosen-token',
        'contexts:',
        '- name: inside',
        '  context:',
        '    cluster: inside',
        '    user: omar',
        '',
      ].join('\n'),
    );
    const omar = await kit.connect(memberCookie);
    try {
      await omar.invoke('k8s:reload');
      // The context is listed (that reads a file, it calls nothing) ...
      const contexts = await omar.invoke('k8s:list-contexts');
      expect(JSON.stringify(contexts)).toContain('inside');
      // ... and asking the cluster anything is refused before a request leaves the server.
      await expect(omar.invoke('k8s:list-namespaces', 'inside')).rejects.toThrow(/not reached from this server/);
      await expect(omar.invoke('k8s:list-pods', 'inside', 'default')).rejects.toThrow(/not reached from this server/);
    } finally {
      omar.close();
    }
    expect(hits).toEqual([]);
  });

  it('the administrator can allow the server\'s own network, and then an error carries only the start of the answer', async () => {
    process.env.SSHS3_ALLOW_PRIVATE_ADDRESSES = '1';
    await startInside(false);
    kit = await startWebServer();
    const { memberCookie } = await kit.team();

    const answer = await loginText(memberCookie);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].auth).toBe('Bearer member-chosen-token');
    expect(answer).toContain('HTTP 500');
    // The whole answer was 2,000 characters and more.
    expect(answer.length).toBeLessThan(700);
  });

  it('a server with one account is its owner\'s own network: the address is called', async () => {
    await startInside(true);
    kit = await startWebServer();
    const setup = await kit.send('POST', '/api/auth/setup', { username: 'maria', password: 'maria-password-123' }); // pragma: allowlist secret
    expect(setup.status).toBe(200);

    const answer = await loginText(setup.cookie);

    expect(hits.map((hit) => hit.url)).toContain('/api');
    expect(answer).not.toContain('not reached from this server');
  });
});
