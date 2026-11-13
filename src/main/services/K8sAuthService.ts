import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import { loadK8sClient } from './k8sClient';
import type { K8sLoginOptions, K8sLoginResult } from '../../shared/types/kubernetes';

/**
 * Normalizes cluster URL and formats standard OpenShift names for cluster, user, and context.
 */
export function formatClusterNames(
  serverUrl: string,
  username: string,
  namespace?: string
): { clusterName: string; userName: string; contextName: string; normalizedServer: string } {
  let normalized = serverUrl.trim();
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }
  normalized = normalized.replace(/\/+$/, '');

  const parsed = new URL(normalized);
  const hostSanitized = parsed.hostname.replace(/\./g, '-');
  const port = parsed.port ? `:${parsed.port}` : (parsed.protocol === 'https:' ? ':6443' : '');
  const clusterName = `${hostSanitized}${port}`;
  const userName = `${username}/${clusterName}`;
  const ns = namespace || 'default';
  const contextName = `${ns}/${clusterName}/${username}`;

  return { clusterName, userName, contextName, normalizedServer: normalized };
}

interface ClusterApiResponse {
  statusCode: number;
  body: any;
  headers: http.IncomingHttpHeaders;
}

/**
 * Performs an HTTPS/HTTP request to the cluster API using Node built-in networking.
 */
export function requestClusterApi(
  serverUrl: string,
  requestPath: string,
  token: string,
  insecureSkipTlsVerify: boolean = false
): Promise<ClusterApiResponse> {
  return new Promise((resolve, reject) => {
    let fullUrl: URL;
    try {
      fullUrl = new URL(requestPath, serverUrl);
    } catch {
      return reject(new Error(`Invalid cluster URL: ${serverUrl}`));
    }

    const isHttps = fullUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const req = client.request(
      fullUrl,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': 'sshs3-client',
        },
        rejectUnauthorized: !insecureSkipTlsVerify,
        timeout: 10000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({
            statusCode: res.statusCode || 0,
            body: parsed,
            headers: res.headers,
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Connection to ${serverUrl} timed out after 10s`));
    });

    req.on('error', (err: any) => {
      if (
        err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
        err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        err.code === 'CERT_HAS_EXPIRED' ||
        err.code === 'SELF_SIGNED_CERT_IN_CHAIN'
      ) {
        reject(
          new Error(
            `Certificate validation failed (${err.code}). If the cluster uses a self-signed or internal CA certificate, check "Skip TLS verification".`
          )
        );
      } else {
        reject(err);
      }
    });

    req.end();
  });
}

/**
 * Validates connection to OpenShift or Kubernetes cluster and extracts username and projects.
 */
export async function validateClusterAndToken(options: {
  server: string;
  token: string;
  insecureSkipTlsVerify?: boolean;
  username?: string;
}): Promise<{ username: string; isOpenShift: boolean; projects: string[] }> {
  const { server, token, insecureSkipTlsVerify } = options;

  let username = options.username || '';
  let isOpenShift = false;
  const projects: string[] = [];

  // 1. Try OpenShift user API
  try {
    const userRes = await requestClusterApi(
      server,
      '/apis/user.openshift.io/v1/users/~',
      token,
      insecureSkipTlsVerify
    );

    if (userRes.statusCode === 200) {
      isOpenShift = true;
      if (userRes.body && userRes.body.metadata?.name) {
        username = userRes.body.metadata.name;
      }
    } else if (userRes.statusCode === 401 || userRes.statusCode === 403) {
      throw new Error(`Authentication failed (HTTP ${userRes.statusCode}): Token was rejected by the cluster.`);
    }
  } catch (err: any) {
    if (err.message?.includes('Authentication failed') || err.message?.includes('Certificate validation failed')) {
      throw err;
    }
    // Network or other failure might still be standard K8s or unreachable
  }

  // 2. If not OpenShift, test generic Kubernetes API
  if (!isOpenShift) {
    try {
      const apiRes = await requestClusterApi(server, '/api', token, insecureSkipTlsVerify);
      if (apiRes.statusCode === 401 || apiRes.statusCode === 403) {
        throw new Error(`Authentication failed (HTTP ${apiRes.statusCode}): Token was rejected by the cluster.`);
      }
      if (apiRes.statusCode !== 200) {
        throw new Error(`Cluster API returned HTTP ${apiRes.statusCode}: ${typeof apiRes.body === 'string' ? apiRes.body : JSON.stringify(apiRes.body)}`);
      }
      if (!username) {
        username = 'token-user';
      }
    } catch (err: any) {
      if (err.message?.includes('Authentication failed') || err.message?.includes('Certificate validation failed')) {
        throw err;
      }
      throw new Error(`Cannot connect to cluster at ${server}: ${err.message || String(err)}`, { cause: err });
    }
  }

  // 3. If OpenShift, discover available projects
  if (isOpenShift) {
    try {
      const projRes = await requestClusterApi(
        server,
        '/apis/project.openshift.io/v1/projects',
        token,
        insecureSkipTlsVerify
      );
      if (projRes.statusCode === 200 && Array.isArray(projRes.body?.items)) {
        for (const item of projRes.body.items) {
          const pName = item.metadata?.name;
          if (pName) projects.push(pName);
        }
      }
    } catch {
      // Non-fatal if user has restrictive RBAC
    }
  }

  if (!username) {
    username = 'developer';
  }

  return { username, isOpenShift, projects };
}

/**
 * The kubeconfig file a login writes to: the explicit path, else the first entry of KUBECONFIG (a path list,
 * like kubectl, which writes new entries to the first file), else ~/.kube/config.
 */
export function resolveKubeConfigWritePath(explicitPath?: string, envValue = process.env.KUBECONFIG): string {
  if (explicitPath) return explicitPath;
  const first = (envValue ?? '').split(path.delimiter).find((p) => p.trim() !== '');
  return first ?? path.join(os.homedir(), '.kube', 'config');
}

/**
 * Validates credentials, saves them into kubeconfig, and returns details.
 */
export async function loginWithToken(options: K8sLoginOptions): Promise<K8sLoginResult> {
  if (!options.token?.trim()) {
    throw new Error('Token is required for login.');
  }
  if (!options.server?.trim()) {
    throw new Error('Server URL is required for login.');
  }

  const { username, projects } = await validateClusterAndToken({
    server: options.server,
    token: options.token,
    insecureSkipTlsVerify: options.insecureSkipTlsVerify,
    username: options.username,
  });

  // Determine active project/namespace: user-specified, or first discovered project, or 'default'
  let namespace = options.namespace?.trim();
  if (!namespace) {
    if (projects.length > 0) {
      // Prefer project matching username or first available project
      const match = projects.find((p) => p === username || p.includes(username));
      namespace = match || projects[0];
    } else {
      namespace = 'default';
    }
  }

  const { clusterName, userName, contextName, normalizedServer } = formatClusterNames(
    options.server,
    username,
    namespace
  );

  const kubeConfigPath = resolveKubeConfigWritePath(options.kubeConfigPath);
  const kubeDir = path.dirname(kubeConfigPath);
  if (!fs.existsSync(kubeDir)) {
    fs.mkdirSync(kubeDir, { recursive: true, mode: 0o700 });
  }

  const { loadYaml, dumpYaml } = await loadK8sClient();

  let doc: any = {
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [],
    users: [],
    contexts: [],
    'current-context': '',
  };

  const existing = fs.existsSync(kubeConfigPath);
  if (existing) {
    // Never replace a kubeconfig we cannot read: it may hold every other cluster the user has.
    try {
      const raw = fs.readFileSync(kubeConfigPath, 'utf8');
      const parsed = loadYaml(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = parsed;
        doc.clusters = Array.isArray(doc.clusters) ? doc.clusters : [];
        doc.users = Array.isArray(doc.users) ? doc.users : [];
        doc.contexts = Array.isArray(doc.contexts) ? doc.contexts : [];
      } else if (raw.trim() !== '') {
        throw new Error('it is not a kubeconfig document');
      }
    } catch (err: any) {
      throw new Error(
        `Your kubeconfig at ${kubeConfigPath} could not be read: ${err?.message || String(err)}. ` +
          'Fix or move it, then log in again.',
        { cause: err }
      );
    }
  }

  // Update or add cluster
  const clusterIndex = doc.clusters.findIndex((c: any) => c.name === clusterName);
  const clusterData: any = {
    server: normalizedServer,
  };
  if (options.insecureSkipTlsVerify) {
    clusterData['insecure-skip-tls-verify'] = true;
  } else if (clusterIndex >= 0 && doc.clusters[clusterIndex].cluster?.['certificate-authority-data']) {
    clusterData['certificate-authority-data'] = doc.clusters[clusterIndex].cluster['certificate-authority-data'];
  }

  if (clusterIndex >= 0) {
    doc.clusters[clusterIndex] = {
      name: clusterName,
      cluster: {
        ...doc.clusters[clusterIndex].cluster,
        ...clusterData,
      },
    };
  } else {
    doc.clusters.push({
      name: clusterName,
      cluster: clusterData,
    });
  }

  // Update or add user
  const userIndex = doc.users.findIndex((u: any) => u.name === userName);
  const userData = {
    token: options.token.trim(),
  };
  if (userIndex >= 0) {
    doc.users[userIndex] = {
      name: userName,
      user: {
        ...doc.users[userIndex].user,
        ...userData,
      },
    };
  } else {
    doc.users.push({
      name: userName,
      user: userData,
    });
  }

  // Update or add context
  const contextIndex = doc.contexts.findIndex((c: any) => c.name === contextName);
  const contextData = {
    cluster: clusterName,
    user: userName,
    namespace,
  };
  if (contextIndex >= 0) {
    doc.contexts[contextIndex] = {
      name: contextName,
      context: {
        ...doc.contexts[contextIndex].context,
        ...contextData,
      },
    };
  } else {
    doc.contexts.push({
      name: contextName,
      context: contextData,
    });
  }

  doc['current-context'] = contextName;

  const yamlOutput = dumpYaml(doc);

  // Keep a copy of the file as it was before this rewrite.
  if (existing) {
    const backupFile = `${kubeConfigPath}.sshs3-backup`;
    fs.copyFileSync(kubeConfigPath, backupFile);
    fs.chmodSync(backupFile, 0o600);
  }

  // Write atomically with 0o600 permissions
  const tempFile = `${kubeConfigPath}.tmp-${Date.now()}`;
  fs.writeFileSync(tempFile, yamlOutput, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempFile, kubeConfigPath);

  return {
    success: true,
    contextName,
    clusterName,
    userName,
    server: normalizedServer,
    namespace,
    projects,
  };
}
