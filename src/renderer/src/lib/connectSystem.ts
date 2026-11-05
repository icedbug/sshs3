import type { SSHConnectionConfig, SSHTunnelConfig } from '@shared/types/ssh';

export interface SystemConnectPlan {
  /** A terminal per server, in name order. */
  tabs: Array<{ title: string; config: SSHConnectionConfig; startDirectory?: string }>;
  /** Tunnels to start, each with the connection of the server it belongs to. */
  tunnels: Array<{ config: SSHConnectionConfig; tunnel: SSHTunnelConfig }>;
}

/**
 * What "Connect all" does for the servers of one system: a terminal for each server that has one
 * (unless switched off), started in its start directory, and the tunnels each server lists. A
 * tunnel id the server no longer has is skipped.
 */
export function planSystemConnect(members: readonly SSHConnectionConfig[]): SystemConnectPlan {
  const plan: SystemConnectPlan = { tabs: [], tunnels: [] };
  const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  for (const config of sorted) {
    const membership = config.system;
    if (membership?.shell !== false) {
      plan.tabs.push({
        title: config.name,
        config,
        ...(membership?.startDirectory ? { startDirectory: membership.startDirectory } : {}),
      });
    }
    for (const id of membership?.tunnelIds ?? []) {
      const tunnel = config.tunnels?.find((t) => t.id === id);
      if (tunnel) plan.tunnels.push({ config, tunnel });
    }
  }
  return plan;
}
