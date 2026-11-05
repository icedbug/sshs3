import type { PaneNode } from './types/session';

/**
 * Strips every credential from a pane tree before it is persisted as the saved
 * session (password, key passphrase, smartcard/FIDO2 PIN, proxy password), so the
 * session file never contains secrets. Shared by the main process (SessionStore)
 * and the renderer.
 */
export function sanitizePaneNode(node: PaneNode): PaneNode {
  if (node.type === 'leaf') {
    if (!node.config) return node;
    const { password: _password, passphrase: _passphrase, pin: _pin, ...restConfig } = node.config;
    if (restConfig.proxy) {
      const { password: _proxyPassword, ...restProxy } = restConfig.proxy;
      restConfig.proxy = restProxy;
    }
    return {
      ...node,
      config: restConfig,
    };
  }
  if (node.type === 'split' && Array.isArray(node.children)) {
    return {
      ...node,
      children: node.children.map(sanitizePaneNode),
    };
  }
  return node;
}

function withoutSecrets<T extends object>(config: T, secretFields: readonly string[]): T {
  const result = { ...config } as Record<string, unknown>;
  for (const field of secretFields) delete result[field];
  const proxy = result.proxy;
  if (proxy && typeof proxy === 'object') {
    const { password: _proxyPassword, ...restProxy } = proxy as Record<string, unknown>;
    result.proxy = restProxy;
  }
  return result as T;
}

/**
 * Strips the credentials a file manager tab carries in `initialSSHConfig` / `initialS3Config`
 * (the connection it was opened with, secrets included) before the tab is persisted. Applies to
 * any tab, with or without a pane tree. Shared by the renderer and the main process (SessionStore),
 * so a tab saved by an older or buggy caller is cleaned on the way to disk as well.
 */
export function sanitizeTabConfigs<T extends object>(tab: T): T {
  const source = tab as Record<string, unknown>;
  const ssh = source.initialSSHConfig;
  const s3 = source.initialS3Config;
  if (!ssh && !s3) return tab;
  const result: Record<string, unknown> = { ...source };
  if (ssh && typeof ssh === 'object') result.initialSSHConfig = withoutSecrets(ssh, ['password', 'passphrase', 'pin']);
  if (s3 && typeof s3 === 'object') result.initialS3Config = withoutSecrets(s3, ['secretAccessKey', 'sessionToken']);
  return result as T;
}
