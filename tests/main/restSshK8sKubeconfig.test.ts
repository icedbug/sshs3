import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { loginWithToken, resolveKubeConfigWritePath } from '../../src/main/services/K8sAuthService';

// Code review: a login silently replaced a kubeconfig it could not parse with a blank one (losing every other
// cluster), never kept a backup, and treated a KUBECONFIG path list as one file name.
describe('K8sAuthService kubeconfig safety', () => {
  let tmpDir: string;
  let kubeConfigPath: string;
  let server: http.Server;
  let serverUrl: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-kubecfg-test-'));
    kubeConfigPath = path.join(tmpDir, 'config');
    server = http.createServer((req, res) => {
      if (req.url === '/apis/user.openshift.io/v1/users/~') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ metadata: { name: 'testuser' } }));
      } else if (req.url === '/apis/project.openshift.io/v1/projects') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [{ metadata: { name: 'project-alpha' } }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    serverUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterEach(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses to log in when the existing kubeconfig cannot be parsed, and leaves it untouched', async () => {
    const broken = 'apiVersion: v1\nclusters:\n  - name: prod\n    cluster: {server: "https://prod\n  bad: [unclosed\n';
    fs.writeFileSync(kubeConfigPath, broken);

    await expect(loginWithToken({ server: serverUrl, token: 'sha256~t', kubeConfigPath })).rejects.toThrow(
      `Your kubeconfig at ${kubeConfigPath} could not be read`
    );
    expect(fs.readFileSync(kubeConfigPath, 'utf8')).toBe(broken);
  });

  it('refuses when the file parses to something that is not a kubeconfig document', async () => {
    fs.writeFileSync(kubeConfigPath, 'just some text\n');
    await expect(loginWithToken({ server: serverUrl, token: 'sha256~t', kubeConfigPath })).rejects.toThrow(
      /could not be read: .*Fix or move it, then log in again\./
    );
    expect(fs.readFileSync(kubeConfigPath, 'utf8')).toBe('just some text\n');
  });

  it('keeps a backup of an existing kubeconfig before rewriting it, and keeps its other entries', async () => {
    const original =
      'apiVersion: v1\nkind: Config\nclusters:\n- name: prod\n  cluster:\n    server: https://prod.example:6443\n' +
      'users: []\ncontexts: []\ncurrent-context: ""\n';
    fs.writeFileSync(kubeConfigPath, original);

    await loginWithToken({ server: serverUrl, token: 'sha256~t', kubeConfigPath });

    expect(fs.readFileSync(`${kubeConfigPath}.sshs3-backup`, 'utf8')).toBe(original);
    const written = fs.readFileSync(kubeConfigPath, 'utf8');
    expect(written).toContain('prod.example');
    expect(written).toContain('testuser');
  });

  it('writes no backup when there was no kubeconfig yet', async () => {
    await loginWithToken({ server: serverUrl, token: 'sha256~t', kubeConfigPath });
    expect(fs.existsSync(kubeConfigPath)).toBe(true);
    expect(fs.existsSync(`${kubeConfigPath}.sshs3-backup`)).toBe(false);
  });

  it('uses the first entry of a KUBECONFIG path list', () => {
    const a = path.join(tmpDir, 'a');
    const b = path.join(tmpDir, 'b');
    expect(resolveKubeConfigWritePath(undefined, `${a}${path.delimiter}${b}`)).toBe(a);
    expect(resolveKubeConfigWritePath(undefined, `${path.delimiter}${b}`)).toBe(b);
    expect(resolveKubeConfigWritePath('/explicit', `${a}${path.delimiter}${b}`)).toBe('/explicit');
    expect(resolveKubeConfigWritePath(undefined, '')).toBe(path.join(os.homedir(), '.kube', 'config'));
  });

  it('login writes to the first file of KUBECONFIG', async () => {
    const a = path.join(tmpDir, 'a');
    const b = path.join(tmpDir, 'b');
    const saved = process.env.KUBECONFIG;
    process.env.KUBECONFIG = `${a}${path.delimiter}${b}`;
    try {
      await loginWithToken({ server: serverUrl, token: 'sha256~t' });
    } finally {
      if (saved === undefined) delete process.env.KUBECONFIG;
      else process.env.KUBECONFIG = saved;
    }
    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(b)).toBe(false);
  });
});
