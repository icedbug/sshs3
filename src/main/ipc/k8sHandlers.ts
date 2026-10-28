import { isPasswordPrompt } from '../ssh/askpassPrompt';
import { loginWithToken } from '../services/K8sAuthService';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { K8sClusterNode, K8sNamespaceNode, K8sPodNode, K8sTerminalTarget, K8sPodDescription, K8sPortForwardTarget, K8sActivePortForward, K8sDebugTarget, K8sLoginOptions, K8sLoginResult } from '../../shared/types/kubernetes';
import type { SSHConnectionConfig, SSHTunnelConfig, SSHActiveTunnel } from '../../shared/types/ssh';
import type { IpcBridge } from '../IpcBridge';
import type { SmartcardCoordinator } from '../smartcard/SmartcardCoordinator';

/** The part of IpcBridge this handler group may use. */
export type K8sHost = Pick<
  IpcBridge,
  'getWebContents' | 'k8sDebugService' | 'k8sDiscoveryService' | 'k8sLogManager' | 'k8sPortForwardManager' | 'k8sTerminalManager' | 'perfMetricsService' | 'promptForPinDirect' | 'registerHandler' | 'resolveProxyJumpConfig' | 'sshTunnelManager'
> & {
  aiHub?: IpcBridge['aiHub'];
  smartcard: Pick<SmartcardCoordinator, 'prepareFido2Config' | 'prepareSmartcardConfig'>;
};

export function registerK8sHandlers(bridge: K8sHost): void {
  bridge.registerHandler(IPC_CHANNELS.K8S_LIST_CONTEXTS, async (): Promise<K8sClusterNode[]> => {
    return bridge.k8sDiscoveryService.listContexts();
  });

  bridge.registerHandler(
    IPC_CHANNELS.K8S_LIST_NAMESPACES,
    async (_event, contextName: string): Promise<K8sNamespaceNode[]> => {
      return await bridge.k8sDiscoveryService.listNamespaces(contextName);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.K8S_LIST_PODS,
    async (_event, contextName: string, namespace: string): Promise<K8sPodNode[]> => {
      return await bridge.k8sDiscoveryService.listPods(contextName, namespace);
    }
  );

  bridge.registerHandler(IPC_CHANNELS.K8S_RELOAD, async (): Promise<void> => {
    bridge.k8sDiscoveryService.reload();
  });

  bridge.registerHandler(
    IPC_CHANNELS.K8S_LOGIN,
    async (_event, options: K8sLoginOptions): Promise<K8sLoginResult> => {
      const result = await loginWithToken(options);
      bridge.k8sDiscoveryService.reload();
      const webContents = bridge.getWebContents();
      if (webContents && !webContents.isDestroyed?.()) {
        webContents.send(IPC_CHANNELS.K8S_CONFIG_CHANGED);
      }
      return result;
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.K8S_TERMINAL_CREATE,
    async (
      _event,
      target: K8sTerminalTarget,
      options?: { cols?: number; rows?: number }
    ): Promise<{ sessionId: string }> => {
      const sessionId = await bridge.k8sTerminalManager.createSession(target, options);
      bridge.aiHub?.terminals.register({ id: sessionId, label: `${target.contextName}/${target.namespace}/${target.podName}:${target.containerName}`, kind: 'k8s', profileId: `k8s:${target.contextName}/${target.namespace}/${target.podName}/${target.containerName}` }, (data) => bridge.k8sTerminalManager.write(sessionId, data));
      return { sessionId };
    }
  );

  bridge.registerHandler(IPC_CHANNELS.K8S_TERMINAL_WRITE, async (_event, sessionId: string, data: string) => {
    bridge.aiHub?.terminals.observeHumanInput(sessionId, data);
    bridge.k8sTerminalManager.write(sessionId, data);
  });

  bridge.registerHandler(
    IPC_CHANNELS.K8S_TERMINAL_RESIZE,
    async (_event, sessionId: string, cols: number, rows: number) => {
      bridge.k8sTerminalManager.resize(sessionId, cols, rows);
    }
  );

  bridge.registerHandler(IPC_CHANNELS.K8S_TERMINAL_KILL, async (_event, sessionId: string) => {
    bridge.aiHub?.terminals.invalidate(sessionId, 'Terminal closed', true);
    bridge.k8sTerminalManager.kill(sessionId);
  });

  // Performance bar. The renderer only sends a session id / pod target; host and mux socket are resolved here.
  bridge.registerHandler(IPC_CHANNELS.PERF_SSH_SAMPLE, async (_event, sessionId: unknown) =>
    bridge.perfMetricsService.sampleSsh(sessionId)
  );
  bridge.registerHandler(IPC_CHANNELS.PERF_LOCAL_SAMPLE, async () => bridge.perfMetricsService.sampleLocal());
  bridge.registerHandler(IPC_CHANNELS.PERF_K8S_SAMPLE, async (_event, target: unknown) =>
    bridge.perfMetricsService.sampleK8s(target)
  );

  bridge.registerHandler(
    IPC_CHANNELS.K8S_LOG_START,
    async (
      _event,
      target: K8sTerminalTarget,
      options?: { tailLines?: number; timestamps?: boolean; previous?: boolean }
    ): Promise<{ sessionId: string }> => {
      const sessionId = await bridge.k8sLogManager.startFollow(target, options);
      return { sessionId };
    }
  );

  bridge.registerHandler(IPC_CHANNELS.K8S_LOG_STOP, async (_event, sessionId: string) => {
    bridge.k8sLogManager.stop(sessionId);
  });

  bridge.registerHandler(
    IPC_CHANNELS.K8S_POD_DESCRIBE,
    async (
      _event,
      contextName: string,
      namespace: string,
      podName: string
    ): Promise<K8sPodDescription> => {
      return await bridge.k8sDiscoveryService.describePod(contextName, namespace, podName);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.K8S_PORT_FORWARD_START,
    async (_event, target: K8sPortForwardTarget): Promise<K8sActivePortForward> => {
      return await bridge.k8sPortForwardManager.startPortForward(target);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.K8S_PORT_FORWARD_STOP,
    async (_event, id: string): Promise<boolean> => {
      return await bridge.k8sPortForwardManager.stopPortForward(id);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.K8S_PORT_FORWARD_LIST,
    async (): Promise<K8sActivePortForward[]> => {
      return bridge.k8sPortForwardManager.listActive();
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.K8S_DEBUG_ATTACH,
    async (_event, target: K8sDebugTarget): Promise<{ containerName: string }> => {
      return await bridge.k8sDebugService.attachEphemeralContainer(target);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.SSH_TUNNEL_START,
    async (
      _event,
      rawConfig: SSHConnectionConfig,
      tunnel: SSHTunnelConfig
    ): Promise<SSHActiveTunnel> => {
      // Same as terminal/SFTP sessions: pre-load a PKCS#11/FIDO2 resident credential
      // into a private agent so the ssh child just points IdentityAgent at it, rather
      // than needing an interactive PIN/passphrase for every standalone tunnel.
      let config = await bridge.resolveProxyJumpConfig(rawConfig);
      config = await bridge.smartcard.prepareSmartcardConfig(config);
      config = await bridge.smartcard.prepareFido2Config(config);
      const hostLabel = config.name ? `${config.name} (${config.host})` : config.host;
      return await bridge.sshTunnelManager.startTunnel(config, tunnel, (rawPrompt) => {
        const isPassword = isPasswordPrompt(rawPrompt);
        const promptText = isPassword
          ? rawPrompt.trim()
          : `Enter the passphrase/PIN to connect via SSH to ${hostLabel}:`;
        return bridge.promptForPinDirect(
          promptText,
          isPassword ? 'password' : 'smartcard',
          isPassword ? `SSH: ${hostLabel}` : `Smartcard: ${hostLabel}`
        );
      });
    }
  );

  bridge.registerHandler(IPC_CHANNELS.SSH_TUNNEL_STOP, async (_event, id: string): Promise<boolean> => {
    return await bridge.sshTunnelManager.stopTunnel(id);
  });

  bridge.registerHandler(IPC_CHANNELS.SSH_TUNNEL_LIST, async (): Promise<SSHActiveTunnel[]> => {
    return bridge.sshTunnelManager.listActive();
  });

  bridge.registerHandler(IPC_CHANNELS.SSH_TUNNEL_CHECK_PORT, async (_event, port: number): Promise<boolean> => {
    return await bridge.sshTunnelManager.isPortFree(port);
  });
}
