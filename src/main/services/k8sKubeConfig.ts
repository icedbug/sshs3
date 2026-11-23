import type * as k8s from '@kubernetes/client-node';
import fs from 'node:fs';
import { loadK8sClient } from './k8sClient';
import { isWebServerProcess } from '../web/tenantBoundary';
import { effectivePolicy, resolveAndValidateTarget, SsrfBlockedError, type GuardedHttpTarget } from '../oauth/requestJson';

/**
 * Names of kubeconfig users configured with an `exec:` credential plugin —
 * an arbitrary external command/args that @kubernetes/client-node runs to
 * fetch credentials the first time that context is actually used (e.g. the
 * sidebar tree expanding a namespace, or K8sDiscoveryService's fs.watch
 * auto-reload after the file changes on disk). This is completely standard
 * for real-world cloud providers (`aws eks get-token`, `gke-gcloud-auth-plugin`,
 * etc.), so its mere presence is not itself suspicious — callers use this to
 * warn only when a *newly appeared* exec entry shows up in a kubeconfig that
 * changed while the app was already running (see the H8 code-review
 * finding), not on every ordinary load of the user's own long-standing file.
 */
export function getExecAuthUserNames(kc: k8s.KubeConfig): Set<string> {
  const names = new Set<string>();
  for (const user of kc.getUsers()) {
    if ((user as unknown as { exec?: unknown }).exec) {
      names.add(user.name);
    }
  }
  return names;
}

/** How long an address that was allowed is not looked up again. A cluster is called many times a minute. */
const ALLOWED_FOR_MS = 60_000;
const allowedUntil = new Map<string, number>();

/**
 * A cluster's address is one an account typed. On a web server several accounts share, it must not
 * make the server call its own network: the same rule as for the other endpoints an account names
 * (`userEndpointPolicy`). Private and loopback addresses are refused there unless the administrator
 * allows them, and link-local and cloud metadata addresses are refused on every web server.
 * On the desktop the network is the person's own and nothing is checked here.
 *
 * Returns the address that was checked, for a caller that connects by itself and wants to connect to
 * exactly that one (a name could answer with another address a moment later).
 */
export async function assertClusterAddressAllowed(serverUrl: string, fresh = false): Promise<GuardedHttpTarget | undefined> {
  if (!isWebServerProcess()) return undefined;
  const now = Date.now();
  if (!fresh && (allowedUntil.get(serverUrl) ?? 0) > now) return undefined;
  let target: GuardedHttpTarget;
  try {
    target = await resolveAndValidateTarget(serverUrl, effectivePolicy({ allowHttp: true }));
  } catch (error) {
    allowedUntil.delete(serverUrl);
    // A name that cannot be looked up reaches nothing. The call itself then says so, as it always did.
    if (!(error instanceof SsrfBlockedError) && typeof (error as NodeJS.ErrnoException).code === 'string') return undefined;
    if (!(error instanceof SsrfBlockedError) && /^Could not resolve /.test(error instanceof Error ? error.message : '')) return undefined;
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `This cluster's address is not reached from this server (${why}). On a server that several accounts share, an administrator allows addresses on the server's own network with SSHS3_ALLOW_PRIVATE_ADDRESSES=1.`,
      { cause: error },
    );
  }
  if (allowedUntil.size > 500) allowedUntil.clear();
  allowedUntil.set(serverUrl, now + ALLOWED_FOR_MS);
  return target;
}

/** For tests: forget which addresses were allowed. */
export function forgetAllowedClusterAddressesForTesting(): void {
  allowedUntil.clear();
}

/**
 * Builds a KubeConfig pinned to a single context, reconstructed from the base
 * kubeconfig's already-parsed clusters/users/contexts. Shared by every k8s
 * service (discovery, exec, logs) that needs to act against one context
 * without mutating a shared KubeConfig's `currentContext`.
 */
export async function loadKubeConfigForContext(contextName: string, kubeConfigPath?: string): Promise<k8s.KubeConfig> {
  const { KubeConfig } = await loadK8sClient();
  const base = new KubeConfig();
  readKubeConfig(base, kubeConfigPath);

  const kc = new KubeConfig();
  kc.loadFromOptions({
    contexts: base.getContexts(),
    clusters: base.getClusters(),
    users: base.getUsers(),
    currentContext: contextName,
  });
  // Every call against a cluster starts here, so here is where its address is checked on a web server.
  if (isWebServerProcess()) {
    const server = kc.getCurrentCluster()?.server;
    if (server) await assertClusterAddressAllowed(server);
  }
  return kc;
}

/**
 * Reads the kubeconfig a service works with into `kc`. On the desktop: the file it was given, else the
 * person's own (KUBECONFIG or ~/.kube/config).
 *
 * On a web server one process serves every account, so the process' own kubeconfig is the server's and
 * is never read: a service has to be given the account's own file, and without one it is refused. A
 * file that is not there yet is an account that has not signed in to a cluster: no contexts. A user
 * entry that signs in by running a program is left out, because that program would run on the server.
 */
export function readKubeConfig(kc: k8s.KubeConfig, kubeConfigPath?: string): void {
  if (!isWebServerProcess()) {
    if (kubeConfigPath) kc.loadFromFile(kubeConfigPath);
    else kc.loadFromDefault();
    return;
  }
  if (!kubeConfigPath) throw new Error('Kubernetes was not set up for an account of this server, so no cluster is read.');
  if (!fs.existsSync(kubeConfigPath)) {
    kc.loadFromOptions({ contexts: [], clusters: [], users: [], currentContext: '' });
    return;
  }
  kc.loadFromFile(kubeConfigPath);
  const runsProgram = (user: k8s.User): boolean => Boolean((user as { exec?: unknown }).exec || (user as { authProvider?: unknown }).authProvider);
  if (kc.getUsers().some(runsProgram)) {
    kc.loadFromOptions({
      contexts: kc.getContexts(),
      clusters: kc.getClusters(),
      users: kc.getUsers().filter((user) => !runsProgram(user)),
      currentContext: kc.getCurrentContext(),
    });
  }
}
