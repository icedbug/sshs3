import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound } from 'lucide-react';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import type { S3Config, SFTPConfig } from '@shared/types/storage';
import type { SavedPaneState } from '@shared/types/session';
import type { K8sTerminalTarget, K8sStorageConfig } from '@shared/types/kubernetes';
import { ConnectionManagerModal } from '../ConnectionModal/ConnectionManagerModal';
import { DragDropProvider } from './DragDropLayer';
import { FilePane } from './FilePane';
import { TransferQueueDrawer } from './TransferQueueDrawer';
import { FILEMANAGER_FOCUS_SIDE_EVENT, type PaneSide, type PaneSource, type SourceType } from './types';
import type { TransferConflictResolution } from '@shared/types/ipc';
import { isElementVisible } from '../../lib/spatialNavigation';
import { describeIpcError } from '../../lib/format';
import { sftpUnavailableReason } from '../../lib/platform';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { createRendererLogger } from '../../lib/log';
const log = createRendererLogger('DualPaneExplorer');

const DEFAULT_SOURCE: Record<PaneSide, PaneSource> = {
  left: { providerId: 'local', sourceType: 'local', label: 'Local Disk' },
  right: { providerId: 'local', sourceType: 'local', label: 'Local Disk' },
};

interface PaneState {
  source: PaneSource;
  path: string;
}

interface DualPaneExplorerProps {
  onOpenTerminal?: (config: SSHConnectionConfig, path: string) => void;
  onOpenK8sTerminal?: (target: K8sTerminalTarget, path: string) => void;
  /** Current keyboard shortcut bindings, forwarded to each pane for Search in Files. */
  shortcuts?: Record<string, string>;
  /** Automatically connect one of the panes to this K8s container on mount. */
  initialK8sTarget?: K8sTerminalTarget;
  /** Automatically connect the right pane to this SSH/SFTP profile on mount. */
  initialSSHConfig?: SSHConnectionConfig;
  /** Settings > Files & Storage > "Show hidden files and dotfiles". Off by default. */
  showHiddenFiles?: boolean;
  /** Settings > Git & GitHub > "SFTP & File Manager Git Integration". On by default. */
  gitIntegrationEnabled?: boolean;
}

export const DualPaneExplorer: React.FC<DualPaneExplorerProps> = ({
  onOpenTerminal,
  onOpenK8sTerminal,
  shortcuts,
  initialK8sTarget,
  initialSSHConfig,
  showHiddenFiles = false,
  gitIntegrationEnabled = true,
}) => {
  const [panes, setPanes] = useState<Record<PaneSide, PaneState>>({
    left: { source: DEFAULT_SOURCE.left, path: '/' },
    right: { source: DEFAULT_SOURCE.right, path: '/' },
  });
  const [activeSide, setActiveSide] = useState<PaneSide>('left');
  const [refreshToken, setRefreshToken] = useState(0);
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [connectionRequest, setConnectionRequest] = useState<{ side: PaneSide; type: SourceType } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [homeDir, setHomeDir] = useState<string>('/');
  const [passwordPrompt, setPasswordPrompt] = useState<{
    config: SSHConnectionConfig;
    side: PaneSide;
  } | null>(null);
  const [promptPassword, setPromptPassword] = useState('');
  useModalDismiss(() => setPasswordPrompt(null), !!passwordPrompt, !connecting);
  const [savePasswordToProfile, setSavePasswordToProfile] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const autoConnectedK8sRef = useRef(false);
  const autoConnectedSSHRef = useRef(false);

  useEffect(() => {
    const handleFocusSide = (e: Event) => {
      const side = (e as CustomEvent<PaneSide>).detail;
      const root = rootRef.current;
      // Inactive file-manager tabs stay mounted (display:none); only the visible one may react.
      if (!root || !isElementVisible(root)) return;
      if (side === 'left' || side === 'right') {
        setActiveSide(side);
        // The pane wrapper isn't focusable; the list inside it owns the arrow-key handling.
        const pane = root.querySelector<HTMLElement>(`[data-testid="file-pane-${side}"]`);
        (pane?.querySelector<HTMLElement>('[data-file-list="true"]') ?? pane)?.focus();
      }
    };
    window.addEventListener(FILEMANAGER_FOCUS_SIDE_EVENT, handleFocusSide);
    return () => window.removeEventListener(FILEMANAGER_FOCUS_SIDE_EVENT, handleFocusSide);
  }, []);

  useEffect(() => {
    let mounted = true;
    void window.multissh
      .connectStorage({ id: 'local', name: 'Local Disk', type: 'local' })
      .then(async () => {
        if (!mounted) return;
        const [session, profiles, userHome] = await Promise.all([
          window.multissh.sessionGet?.(),
          window.multissh.profilesGet?.(),
          window.multissh.getHomeDir?.(),
        ]);
        if (!mounted) return;
        if (userHome) setHomeDir(userHome);

        const restoreSide = async (_side: PaneSide, savedPane?: SavedPaneState): Promise<PaneState> => {
          if (!savedPane || savedPane.sourceType === 'local') {
            const localPath = session?.lastPaths?.['local'] || savedPane?.path || userHome || '/';
            return {
              source: { providerId: 'local', sourceType: 'local', label: 'Local Disk' },
              path: localPath,
            };
          }

          if (savedPane.sourceType === 's3' && profiles?.s3) {
            const s3Profile = profiles.s3.find((p) => `s3-${p.id}` === savedPane.providerId);
            if (s3Profile) {
              try {
                await window.multissh.connectStorage({
                  id: savedPane.providerId,
                  name: s3Profile.name,
                  type: 's3',
                  s3Config: s3Profile,
                });
                return {
                  source: { providerId: savedPane.providerId, sourceType: 's3', label: s3Profile.name },
                  path: savedPane.path || session?.lastPaths?.[savedPane.providerId] || '/',
                };
              } catch (err) {
                log.warn('Could not auto-reconnect S3 pane on startup:', err);
              }
            }
          }

          if (savedPane.sourceType === 'sftp' && profiles?.ssh) {
            const sshProfile = profiles.ssh.find((p) => `sftp-${p.id}` === savedPane.providerId);
            // Only auto-connect SFTP if non-interactive credentials exist (saved password, private key, or agent)
            if (
              sshProfile &&
              sshProfile.authType !== 'smartcard' &&
              (sshProfile.password || sshProfile.privateKeyPath || sshProfile.authType === 'agent')
            ) {
              try {
                const sftpConfig: SFTPConfig = {
                  id: sshProfile.id,
                  name: sshProfile.name,
                  host: sshProfile.host,
                  port: sshProfile.port ?? 22,
                  username: sshProfile.username,
                  authType: sshProfile.authType,
                  password: sshProfile.password,
                  privateKeyPath: sshProfile.privateKeyPath,
                  passphrase: sshProfile.passphrase,
                  agentPath: sshProfile.agentPath,
                  pkcs11LibPath: sshProfile.pkcs11LibPath,
                  fido2Resident: sshProfile.fido2Resident,
                  initialPath: sshProfile.initialPath,
                  proxy: sshProfile.proxy,
                  proxyJump: sshProfile.proxyJump,
                  proxyJumpProfileId: sshProfile.proxyJumpProfileId,
                };
                await window.multissh.connectStorage({
                  id: savedPane.providerId,
                  name: sshProfile.name,
                  type: 'sftp',
                  sftpConfig,
                });
                const defaultHome = sshProfile.username === 'root' ? '/root' : `/home/${sshProfile.username || 'user'}`;
                let path = savedPane.path || session?.lastPaths?.[savedPane.providerId];
                if (!path || path === '/') {
                  try {
                    path = await window.multissh.storageGetHomeDir(savedPane.providerId);
                  } catch {
                    path = sshProfile.initialPath || defaultHome;
                  }
                  if (!path || path === '/') {
                    path = sshProfile.initialPath || defaultHome;
                  }
                }
                return {
                  source: { providerId: savedPane.providerId, sourceType: 'sftp', label: sshProfile.name },
                  path: path || defaultHome,
                };
              } catch (err) {
                log.warn('Could not auto-reconnect SFTP pane on startup:', err);
              }
            }
          }

          if (savedPane.sourceType === 'k8s') {
            const match = savedPane.providerId.replace(/^k8s-/, '').split('/');
            if (match.length === 4) {
              const [contextName, namespace, podName, containerName] = match;
              try {
                const k8sConfig: K8sStorageConfig = {
                  id: savedPane.providerId,
                  name: savedPane.label,
                  contextName,
                  namespace,
                  podName,
                  containerName,
                  initialPath: savedPane.path || '/',
                };
                await window.multissh.connectStorage({
                  id: savedPane.providerId,
                  name: savedPane.label,
                  type: 'k8s',
                  k8sConfig,
                });
                return {
                  source: { providerId: savedPane.providerId, sourceType: 'k8s', label: savedPane.label },
                  path: savedPane.path || session?.lastPaths?.[savedPane.providerId] || '/',
                };
              } catch (err) {
                log.warn('Could not auto-reconnect K8s pane on startup:', err);
              }
            }
          }

          // Fallback safely to local disk if remote provider cannot be auto-connected
          return {
            source: { providerId: 'local', sourceType: 'local', label: 'Local Disk' },
            path: session?.lastPaths?.['local'] || '/',
          };
        };

        const left = await restoreSide('left', session?.panes?.left);
        const right = await restoreSide('right', session?.panes?.right);

        if (mounted) {
          setPanes({ left, right });
          setReady(true);
          // UX audit finding #7: a brand-new File Manager tab used to default
          // both panes to Local Disk — two identical, useless mirrors of the
          // same folder. When there's nothing saved for the right pane and
          // it isn't being auto-connected to a specific target, prompt for a
          // remote connection instead of silently leaving it on Local Disk.
          if (!session?.panes?.right && !initialSSHConfig && !initialK8sTarget) {
            setConnectionRequest({ side: 'right', type: 'sftp' });
          }
        }
      })
      .catch((err) => {
        if (mounted) {
          setInitError(describeIpcError(err, 'Could not connect to local disk'));
          setReady(true);
        }
      });
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run only on initial mount to restore saved panes
  }, []);

  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    const unsub = window.multissh.onTransferProgress((progress) => {
      if (progress.status === 'completed') {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          setRefreshToken((t) => t + 1);
        }, 300);
      }
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const persistPaneState = (updatedPanes: Record<PaneSide, PaneState>) => {
    void window.multissh.sessionGet?.().then((session) => {
      const lastPaths = {
        ...(session?.lastPaths || {}),
        [updatedPanes.left.source.providerId]: updatedPanes.left.path,
        [updatedPanes.right.source.providerId]: updatedPanes.right.path,
      };
      void window.multissh.sessionSave?.({
        tabs: session?.tabs || [],
        activeTabId: session?.activeTabId || '',
        lastPaths,
        panes: {
          left: {
            sourceType: updatedPanes.left.source.sourceType,
            providerId: updatedPanes.left.source.providerId,
            label: updatedPanes.left.source.label,
            path: updatedPanes.left.path,
          },
          right: {
            sourceType: updatedPanes.right.source.sourceType,
            providerId: updatedPanes.right.source.providerId,
            label: updatedPanes.right.source.label,
            path: updatedPanes.right.path,
          },
        },
      });
    });
  };

  const setPanePath = useCallback((side: PaneSide, path: string) => {
    setPanes((prev) => {
      const next = { ...prev, [side]: { ...prev[side], path } };
      persistPaneState(next);
      return next;
    });
  }, []);

  const setPaneSourceType = useCallback((side: PaneSide, type: SourceType) => {
    if (type === 'local') {
      setPanes((prev) => {
        const defaultPath = prev[side].source.sourceType === 'local' ? prev[side].path : (homeDir || '/');
        const next = {
          ...prev,
          [side]: { source: { providerId: 'local', sourceType: 'local', label: 'Local Disk' }, path: defaultPath },
        };
        persistPaneState(next);
        return next;
      });
      return;
    }
    setConnectionRequest({ side, type });
  }, [homeDir]);

  const connectPaneToSSH = useCallback(
    async (config: SSHConnectionConfig, overridePassword?: string, targetSide?: PaneSide) => {
      const side = targetSide || (connectionRequest ? connectionRequest.side : passwordPrompt?.side) || 'right';
      if (!side) return;

      const passwordToUse = overridePassword !== undefined ? overridePassword : config.password;
      // A Team Vault member profile never carries its real password here (redacted by
      // getPayloadForRenderer for non-admins) — main resolves it server-side via
      // `teamVaultProfileRef` instead, so skip the "no password configured" prompt below.
      const isTeamVaultProfile = Boolean(config.teamVaultProfileRef);

      const unavailableReason = sftpUnavailableReason(config.authType);
      if (unavailableReason) {
        window.alert(unavailableReason);
        setConnectionRequest(null);
        return;
      }

      // If the profile uses password authentication but has no password configured, prompt for it
      if (!isTeamVaultProfile && config.authType === 'password' && !passwordToUse) {
        setPasswordPrompt({ config, side });
        setPromptPassword('');
        setSavePasswordToProfile(false);
        setConnectionRequest(null);
        return;
      }

      setConnecting(true);
      try {
        const sftpConfig: SFTPConfig = {
          id: config.id,
          name: config.name,
          host: config.host,
          port: config.port ?? 22,
          username: config.username,
          authType: config.authType,
          password: passwordToUse,
          privateKeyPath: config.privateKeyPath,
          passphrase: config.passphrase,
          agentPath: config.agentPath,
          pkcs11LibPath: config.pkcs11LibPath,
          fido2Resident: config.fido2Resident,
          initialPath: config.initialPath,
          proxy: config.proxy,
          proxyJump: config.proxyJump,
          proxyJumpProfileId: config.proxyJumpProfileId,
          teamVaultProfileRef: config.teamVaultProfileRef,
        };
        const providerId = `sftp-${config.id}`;
        await window.multissh.connectStorage({ id: providerId, name: config.name, type: 'sftp', sftpConfig });
        const defaultHome = config.username === 'root' ? '/root' : `/home/${config.username || 'user'}`;
        let initialPath = config.initialPath?.trim();
        if (!initialPath) {
          try {
            initialPath = await window.multissh.storageGetHomeDir(providerId);
          } catch {
            initialPath = defaultHome;
          }
          if (!initialPath || initialPath === '/') {
            initialPath = defaultHome;
          }
        }
        setPanes((prev) => {
          const next = {
            ...prev,
            [side]: { source: { providerId, sourceType: 'sftp' as const, label: config.name }, path: initialPath },
          };
          persistPaneState(next);
          return next;
        });
        setConnectionRequest(null);
        setPasswordPrompt(null);
      } catch (err) {
        let msg = describeIpcError(err, 'Could not connect to the SFTP server');
        msg = msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, '');
        window.alert(msg);
      } finally {
        setConnecting(false);
      }
    },
    [connectionRequest, passwordPrompt]
  );

  const handlePasswordPromptSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordPrompt) return;
    const { config } = passwordPrompt;
    const entered = promptPassword;
    if (savePasswordToProfile && entered) {
      try {
        await window.multissh.profilesSaveSSH?.({ ...config, password: entered });
      } catch (saveErr) {
        log.warn('Could not save password to profile:', saveErr);
      }
    }
    await connectPaneToSSH(config, entered);
  };

  const connectPaneToS3 = useCallback(
    async (config: S3Config) => {
      if (!connectionRequest) return;
      const { side } = connectionRequest;
      setConnecting(true);
      try {
        const providerId = `s3-${config.id}`;
        const session = await window.multissh.sessionGet?.();
        const initialPath = config.initialPath?.trim() || session?.lastPaths?.[providerId] || '/';
        await window.multissh.connectStorage({ id: providerId, name: config.name, type: 's3', s3Config: config });
        setPanes((prev) => {
          const next = {
            ...prev,
            [side]: { source: { providerId, sourceType: 's3' as const, label: config.name }, path: initialPath },
          };
          persistPaneState(next);
          return next;
        });
        setConnectionRequest(null);
      } catch (err) {
        window.alert(describeIpcError(err, 'Could not connect to S3'));
      } finally {
        setConnecting(false);
      }
    },
    [connectionRequest]
  );

  const connectPaneToK8s = useCallback(
    async (target: K8sTerminalTarget, targetSide?: PaneSide) => {
      const side = targetSide || (connectionRequest ? connectionRequest.side : 'left');
      setConnecting(true);
      try {
        const providerId = `k8s-${target.contextName}/${target.namespace}/${target.podName}/${target.containerName}`;
        const k8sConfig: K8sStorageConfig = {
          id: providerId,
          name: `${target.podName} (${target.containerName})`,
          contextName: target.contextName,
          namespace: target.namespace,
          podName: target.podName,
          containerName: target.containerName,
          initialPath: '/',
        };
        const session = await window.multissh.sessionGet?.();
        const initialPath = session?.lastPaths?.[providerId] || '/';
        await window.multissh.connectStorage({
          id: providerId,
          name: `${target.podName} (${target.containerName})`,
          type: 'k8s',
          k8sConfig,
        });
        setPanes((prev) => {
          const next = {
            ...prev,
            [side]: {
              source: {
                providerId,
                sourceType: 'k8s' as const,
                label: `${target.podName} (${target.containerName})`,
              },
              path: initialPath,
            },
          };
          persistPaneState(next);
          return next;
        });
        setConnectionRequest(null);
      } catch (err) {
        window.alert(describeIpcError(err, 'Could not connect to Kubernetes pod'));
      } finally {
        setConnecting(false);
      }
    },
    [connectionRequest]
  );

  useEffect(() => {
    if (initialK8sTarget && ready && !autoConnectedK8sRef.current) {
      autoConnectedK8sRef.current = true;
      void connectPaneToK8s(initialK8sTarget, 'left');
    }
    // Runs once per mount: connectPaneToK8s is recreated whenever connectionRequest
    // changes (e.g. the user opens the connection modal for the other pane), and
    // must not re-fire this auto-connect every time that happens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialK8sTarget, ready]);

  useEffect(() => {
    if (initialSSHConfig && ready && !autoConnectedSSHRef.current) {
      autoConnectedSSHRef.current = true;
      void connectPaneToSSH(initialSSHConfig, undefined, 'right');
    }
    // Runs once per mount, for the same reason as the k8s effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSSHConfig, ready]);

  const handleOpenTerminal = useCallback(
    async (providerId: string, path: string) => {
      if (providerId.startsWith('k8s-') && onOpenK8sTerminal) {
        const match = providerId.replace(/^k8s-/, '').split('/');
        if (match.length === 4) {
          const [contextName, namespace, podName, containerName] = match;
          onOpenK8sTerminal({ contextName, namespace, podName, containerName }, path);
          return;
        }
      }
      if (!onOpenTerminal || !providerId.startsWith('sftp-')) return;
      const sshId = providerId.slice('sftp-'.length);
      const profiles = await window.multissh.profilesGet?.();
      const sshProfile = profiles?.ssh?.find((p) => p.id === sshId);
      if (!sshProfile) {
        window.alert('Could not find SSH profile for this SFTP connection');
        return;
      }
      onOpenTerminal(sshProfile, path);
    },
    [onOpenTerminal, onOpenK8sTerminal]
  );

  const handleTransferRequested = useCallback(
    (targetSide: PaneSide, params: { sourceProviderId: string; sourcePaths: string[]; targetPath: string }) => {
      const targetProviderId = panes[targetSide].source.providerId;
      void (async () => {
        let batchPolicy: TransferConflictResolution | undefined;
        for (const sourcePath of params.sourcePaths) {
          const result = await window.multissh.transferAdd({
            sourceProviderId: params.sourceProviderId,
            sourcePath,
            targetProviderId,
            targetPath: params.targetPath,
            conflictPolicy: batchPolicy,
          });
          if (result.appliedToAll && result.resolvedPolicy) {
            batchPolicy = result.resolvedPolicy;
          }
        }
      })();
    },
    [panes]
  );

  const handleLeftPathChange = useCallback((path: string) => setPanePath('left', path), [setPanePath]);
  const handleRightPathChange = useCallback((path: string) => setPanePath('right', path), [setPanePath]);

  const handleLeftFocus = useCallback(() => setActiveSide('left'), []);
  const handleRightFocus = useCallback(() => setActiveSide('right'), []);

  const handleLeftSourceTypeRequest = useCallback((type: SourceType) => setPaneSourceType('left', type), [setPaneSourceType]);
  const handleRightSourceTypeRequest = useCallback((type: SourceType) => setPaneSourceType('right', type), [setPaneSourceType]);

  const handleLeftTransferRequested = useCallback(
    (params: { sourceProviderId: string; sourcePaths: string[]; targetPath: string }) => handleTransferRequested('left', params),
    [handleTransferRequested]
  );
  const handleRightTransferRequested = useCallback(
    (params: { sourceProviderId: string; sourcePaths: string[]; targetPath: string }) => handleTransferRequested('right', params),
    [handleTransferRequested]
  );

  const handleLeftOpenTerminal = useMemo(() => {
    return onOpenTerminal || onOpenK8sTerminal
      ? (path: string) => void handleOpenTerminal(panes.left.source.providerId, path)
      : undefined;
  }, [onOpenTerminal, onOpenK8sTerminal, handleOpenTerminal, panes.left.source.providerId]);

  const handleRightOpenTerminal = useMemo(() => {
    return onOpenTerminal || onOpenK8sTerminal
      ? (path: string) => void handleOpenTerminal(panes.right.source.providerId, path)
      : undefined;
  }, [onOpenTerminal, onOpenK8sTerminal, handleOpenTerminal, panes.right.source.providerId]);

  const otherPaneForLeft = useMemo(() => ({ ...panes.right.source, path: panes.right.path }), [panes.right.source, panes.right.path]);
  const otherPaneForRight = useMemo(() => ({ ...panes.left.source, path: panes.left.path }), [panes.left.source, panes.left.path]);

  if (!ready) {
    return <div className="flex flex-1 items-center justify-center text-sm text-txt-muted">Initializing file manager...</div>;
  }

  return (
    <DragDropProvider>
      <div
        ref={rootRef}
        className="flex min-h-0 flex-1 flex-col bg-app"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {initError && (
          <div className="border-b border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs text-red-300">{initError}</div>
        )}
        <div
          data-testid="dual-pane-ai-bar"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-divider bg-app-surface/70 px-3 py-1 text-2xs text-txt-secondary"
        >
          <div className="flex items-center gap-2 min-w-0 truncate">
            <span className="font-semibold text-sky-400">✨ AI Storage &amp; SFTP/S3:</span>
            <span className="truncate font-mono text-txt-muted">
              {panes.left.source.label} ({panes.left.path}) ↔ {panes.right.source.label} ({panes.right.path})
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              data-testid="dual-pane-ai-diff-btn"
              title="Jämför vänster och höger panel med AI (sshs3_storage_ops diff_paths)"
              onClick={() => {
                const leftTarget = panes.left.source.providerId.replace(/^(sftp-|s3-)/, '');
                const rightTarget = panes.right.source.providerId.replace(/^(sftp-|s3-)/, '');
                window.dispatchEvent(
                  new CustomEvent('sshs3:ai-attach', {
                    detail: {
                      label: `@storage:${panes.left.source.label}↔${panes.right.source.label}`,
                      text: [
                        `Dual-Pane Explorer Context:`,
                        `- Left Pane: ${panes.left.source.label} [provider=${panes.left.source.providerId}, type=${panes.left.source.sourceType}] path=${panes.left.path}`,
                        `- Right Pane: ${panes.right.source.label} [provider=${panes.right.source.providerId}, type=${panes.right.source.sourceType}] path=${panes.right.path}`,
                      ].join('\n'),
                      prompt: `Jämför innehållet och konfigurationsfilerna mellan vänster panel (${leftTarget}:${panes.left.path}) och höger panel (${rightTarget}:${panes.right.path}) med sshs3_storage_ops.`,
                    },
                  })
                );
              }}
              className="inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-2xs font-semibold text-sky-300 hover:bg-sky-500/25 transition-colors"
            >
              <span>🔍 AI Diff Vänster ↔ Höger</span>
            </button>
            <button
              type="button"
              data-testid="dual-pane-ingest-kb-btn"
              title="Indexera aktiv mapp eller S3-prefix direkt i Knowledge Base (@kb)"
              onClick={() => {
                const activePane = panes[activeSide];
                window.dispatchEvent(
                  new CustomEvent('sshs3:ai-attach', {
                    detail: {
                      label: `@kb-ingest:${activePane.source.label}`,
                      text: `KB Ingest Request:\nSource: ${activePane.source.label} (${activePane.source.sourceType})\nProvider ID: ${activePane.source.providerId}\nPath: ${activePane.path}`,
                      prompt: `Indexera och spara viktig dokumentation/runbooks eller konfigurationsfiler från ${activePane.source.label} (${activePane.path}) in i vår Knowledge Base (@kb).`,
                    },
                  })
                );
              }}
              className="inline-flex items-center gap-1 rounded border border-purple-500/40 bg-purple-500/15 px-2 py-0.5 text-2xs font-semibold text-purple-300 hover:bg-purple-500/25 transition-colors"
            >
              <span>📥 Indexera i KB</span>
            </button>
            <button
              type="button"
              data-testid="dual-pane-open-kb-btn"
              title="Öppna Kunskapsbasen (KB) i AI Hub för att söka eller synka S3/lokala runbooks"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent('sshs3:ai-open', {
                    detail: { view: 'Knowledge Base', mode: 'hub' },
                  })
                );
              }}
              className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-2xs font-semibold text-emerald-300 hover:bg-emerald-500/25 transition-colors"
            >
              <span>📚 Kunskapsbas (KB)</span>
            </button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 gap-1.5 p-1.5">
          <FilePane
            side="left"
            source={panes.left.source}
            currentPath={panes.left.path}
            isActive={activeSide === 'left'}
            onFocus={handleLeftFocus}
            onPathChange={handleLeftPathChange}
            onSourceTypeRequest={handleLeftSourceTypeRequest}
            onTransferRequested={handleLeftTransferRequested}
            onOpenTerminal={handleLeftOpenTerminal}
            refreshToken={refreshToken}
            otherPane={otherPaneForLeft}
            shortcuts={shortcuts}
            showHiddenFiles={showHiddenFiles}
            gitIntegrationEnabled={gitIntegrationEnabled}
          />
          <FilePane
            side="right"
            source={panes.right.source}
            currentPath={panes.right.path}
            isActive={activeSide === 'right'}
            onFocus={handleRightFocus}
            onPathChange={handleRightPathChange}
            onSourceTypeRequest={handleRightSourceTypeRequest}
            onTransferRequested={handleRightTransferRequested}
            onOpenTerminal={handleRightOpenTerminal}
            refreshToken={refreshToken}
            otherPane={otherPaneForRight}
            shortcuts={shortcuts}
            showHiddenFiles={showHiddenFiles}
            gitIntegrationEnabled={gitIntegrationEnabled}
          />
        </div>
        <TransferQueueDrawer />
      </div>
      <ConnectionManagerModal
        open={connectionRequest !== null}
        initialTab={
          connectionRequest?.type === 's3'
            ? 's3'
            : connectionRequest?.type === 'k8s'
              ? 'k8s'
              : 'ssh'
        }
        onClose={() => {
          if (!connecting) setConnectionRequest(null);
        }}
        onConnectSSH={connecting ? undefined : (config) => void connectPaneToSSH(config)}
        onConnectS3={connecting ? undefined : (config) => void connectPaneToS3(config)}
        onBrowseK8sFiles={connecting ? undefined : (target) => void connectPaneToK8s(target)}
      />
      {passwordPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4">
          <div role="dialog" aria-modal="true" aria-label="Password required for SFTP" className="w-full max-w-sm rounded-xl border border-border-subtle bg-app-surface p-5 shadow-2xl space-y-4 text-xs">
            <div className="flex items-center gap-2 text-sky-400 font-semibold text-sm">
              <KeyRound className="h-4 w-4" />
              <span>Password Required for SFTP</span>
            </div>
            <p className="text-txt-muted text-xs leading-relaxed">
              Profile <strong className="text-txt-primary">{passwordPrompt.config.name}</strong> has no saved password. File Manager runs in the background and needs a password to connect.
            </p>
            <form onSubmit={handlePasswordPromptSubmit} className="space-y-3">
              <input
                aria-label="Password"
                type="password"
                required
                autoFocus
                placeholder="Enter password"
                value={promptPassword}
                onChange={(e) => setPromptPassword(e.target.value)}
                className="w-full rounded-lg border border-border-subtle bg-app-input px-3 py-2 text-sm text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
              />
              <label className="flex items-center gap-2 cursor-pointer text-txt-secondary select-none">
                <input
                  type="checkbox"
                  checked={savePasswordToProfile}
                  onChange={(e) => setSavePasswordToProfile(e.target.checked)}
                  className="rounded border-border-subtle text-sky-500 focus:ring-0"
                />
                <span>Save the password in the profile</span>
              </label>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setPasswordPrompt(null)}
                  className="rounded-lg border border-border-subtle px-3 py-1.5 text-xs text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={connecting}
                  className="rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-500 transition-colors disabled:opacity-50"
                >
                  {connecting ? 'Connecting...' : 'Connect'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </DragDropProvider>
  );
};

export default DualPaneExplorer;
