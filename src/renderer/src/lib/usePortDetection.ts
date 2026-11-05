import { useState, useRef, useEffect, useCallback } from 'react';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import { detectPortsInOutput, type PortDetectionResult } from './portDetection';

export interface UsePortDetectionOptions {
  enabled?: boolean;
  customRegex?: string;
  isRemote: boolean;
  config?: SSHConnectionConfig;
}

export function usePortDetection({
  enabled = true,
  customRegex,
  isRemote,
  config,
}: UsePortDetectionOptions) {
  const [detectedPorts, setDetectedPorts] = useState<PortDetectionResult[]>([]);
  const dismissedPortsRef = useRef<Set<number>>(new Set());
  const activeTunnelsRef = useRef<Map<number, { id: string; localPort: number }>>(new Map()); // remote port -> tunnel
  const configRef = useRef(config);
  configRef.current = config;
  const isRemoteRef = useRef(isRemote);
  isRemoteRef.current = isRemote;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const customRegexRef = useRef(customRegex);
  customRegexRef.current = customRegex;

  // Clear detected ports if disabled via settings
  useEffect(() => {
    if (!enabled) {
      setDetectedPorts([]);
    }
  }, [enabled]);

  // Clean up auto-created tunnels on unmount
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    const activeTunnels = activeTunnelsRef.current;
    return () => {
      mountedRef.current = false;
      const tunnels = Array.from(activeTunnels.values());
      for (const tunnel of tunnels) {
        window.multissh?.sshTunnelStop?.(tunnel.id).catch(() => {});
      }
      activeTunnels.clear();
    };
  }, []);

  const scanOutput = useCallback((chunk: string) => {
    if (!enabledRef.current || !chunk) return;

    const found = detectPortsInOutput(chunk, customRegexRef.current);
    if (found.length === 0) return;

    setDetectedPorts((prev) => {
      const existing = new Set(prev.map((p) => p.port));
      const newlyAdded: PortDetectionResult[] = [];

      for (const item of found) {
        if (!existing.has(item.port) && !dismissedPortsRef.current.has(item.port)) {
          newlyAdded.push(item);
          existing.add(item.port);
        }
      }

      if (newlyAdded.length === 0) return prev;
      return [...prev, ...newlyAdded];
    });
  }, []);

  const dismissPort = useCallback((port: number) => {
    dismissedPortsRef.current.add(port);
    setDetectedPorts((prev) => prev.filter((p) => p.port !== port));
  }, []);

  const handleForwardAndOpen = useCallback(
    async (port: number, protocol: 'http' | 'https') => {
      if (!isRemoteRef.current || !configRef.current) {
        // Local terminal session: directly open in browser
        const url = `${protocol}://localhost:${port}`;
        await window.multissh?.openExternal?.(url);
        return;
      }

      // Remote SSH session: check if tunnel already active
      let targetLocalPort = port;
      const existingTunnel = activeTunnelsRef.current.get(port);

      if (existingTunnel) {
        // Reuse the local port the tunnel was actually created on (it may differ from the remote port)
        targetLocalPort = existingTunnel.localPort;
      } else {
        // Check if preferred local port is free
        const isPortFree = await window.multissh?.sshTunnelCheckPort?.(port).catch(() => true);
        if (!isPortFree) {
          // Find alternative free port
          let candidate = port + 1000;
          for (let i = 0; i < 5; i++) {
            const free = await window.multissh?.sshTunnelCheckPort?.(candidate).catch(() => false);
            if (free) {
              targetLocalPort = candidate;
              break;
            }
            candidate++;
          }
        }

        const tunnelConfig = {
          id: `auto-port-${port}-${Date.now()}`,
          name: `Auto port ${port}`,
          type: 'local' as const,
          localPort: targetLocalPort,
          remoteHost: '127.0.0.1',
          remotePort: port,
        };

        const activeTunnel = await window.multissh?.sshTunnelStart?.(configRef.current, tunnelConfig);
        if (!mountedRef.current) {
          // The terminal was closed while the tunnel was starting: the cleanup above has already run, so this
          // one would never be stopped (M10).
          if (activeTunnel?.id) window.multissh?.sshTunnelStop?.(activeTunnel.id)?.catch(() => {});
          return;
        }
        if (activeTunnel?.id) {
          activeTunnelsRef.current.set(port, { id: activeTunnel.id, localPort: targetLocalPort });
        }
      }

      const url = `${protocol}://localhost:${targetLocalPort}`;
      await window.multissh?.openExternal?.(url);
    },
    []
  );

  return {
    detectedPorts,
    scanOutput,
    dismissPort,
    handleForwardAndOpen,
  };
}
