import { useCallback, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { TabType } from '../components/TabBar';
import type { AppSettings } from '@shared/types/settings';
import type { SSHConnectionConfig, LocalShellType } from '@shared/types/ssh';
import type { PaneOrientation } from '@shared/types/session';
import type { K8sTerminalTarget } from '@shared/types/kubernetes';
import type { S3Config } from '@shared/types/storage';
import { isEmptyUnconnectedTab, type AppTab } from './tabs';
import { planSystemConnect } from './connectSystem';
import { prepareConnect } from './openProfile';
import { describeIpcError, formatDateTime } from './format';
import { closePane, countLeaves, createLeaf, findLeaf, getFirstLeafId, splitPane, updateLeaf, updateSplitWeights } from './paneTree';
import { extractHostnameFromTitle, isSameHost } from './terminalTitle';
import type { OpenEditorTabDetail } from './editorTabEvents';
import { statIfExists } from './storageLookup';
import type { ConfirmOptions } from '../components/ConfirmDialog';

export interface TabActionsContext {
  tabs: AppTab[];
  activeTabId: string;
  settings: AppSettings;
  localHostname: string;
  setTabs: Dispatch<SetStateAction<AppTab[]>>;
  setActiveTabId: Dispatch<SetStateAction<string>>;
  setTabBarFocused: Dispatch<SetStateAction<boolean>>;
  setConnectTarget: Dispatch<SetStateAction<{ tabId: string; paneId?: string } | null>>;
  setProfilesModalOpen: Dispatch<SetStateAction<boolean>>;
  /** The app's confirmation dialog (ConfirmDialog's useConfirm), used before discarding unsaved changes. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** Shows a short message that no dialog is open to show (for example tunnels that failed to start). */
  notify?: (message: string) => void;
}

/** Everything that creates, closes, splits or connects tabs and panes. */
export function useTabActions(ctx: TabActionsContext) {
  const { tabs, activeTabId, settings, localHostname, setTabs, setActiveTabId, setTabBarFocused, setConnectTarget, setProfilesModalOpen, confirm, notify } = ctx;

  const handleSelectTab = (id: string) => {
    setActiveTabId(id);
    setTabBarFocused(false);
  };

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const handleCloseTab = useCallback(async (id: string) => {
    // Confirm outside the state updater: updaters must stay pure (StrictMode runs them twice).
    const closing = tabsRef.current.find((t) => t.id === id);
    if (closing?.isDirty) {
      const discard = await confirm({
        title: 'Discard unsaved changes',
        message: `Discard your unsaved changes to ${closing.title}?`,
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing',
      });
      if (!discard) return;
    }
    setTabs((prev) => {
      const index = prev.findIndex((t) => t.id === id);
      const remaining = prev.filter((t) => t.id !== id);

      if (id === activeTabId && remaining.length > 0) {
        const nextIndex = Math.max(0, index - 1);
        setActiveTabId(remaining[nextIndex].id);
      }

      return remaining;
    });
  }, [activeTabId, setActiveTabId, setTabs, confirm]);

  const handleNewTab = useCallback((type?: TabType, options?: { remote?: boolean }) => {
    const tabType = type || settings.defaultNewTabType || 'terminal';
    const newId = `${tabType === 'terminal' ? 'term' : 'fm'}-${Date.now()}`;

    setTabs((prev) => {
      let nextNum = 1;
      const usedNums = new Set<number>();

      if (tabType === 'terminal') {
        for (const t of prev) {
          if (t.type === 'terminal') {
            const m = t.title.match(/Terminal\s+(\d+)/);
            if (m) usedNums.add(parseInt(m[1], 10));
          }
        }
        while (usedNums.has(nextNum)) {
          nextNum++;
        }
        const newTab: AppTab = {
          id: newId,
          type: 'terminal',
          title: `Terminal ${nextNum}`,
          paneTree: createLeaf(`${newId}-root`),
        };
        return [...prev, newTab];
      } else {
        for (const t of prev) {
          if (t.type === 'filemanager') {
            const m = t.title.match(/File Manager\s+(\d+)/);
            if (m) usedNums.add(parseInt(m[1], 10));
          }
        }
        while (usedNums.has(nextNum)) {
          nextNum++;
        }
        const newTab: AppTab = {
          id: newId,
          type: 'filemanager',
          title: `File Manager ${nextNum}`,
          ...(options?.remote ? { promptRemote: true } : {}),
        };
        return [...prev, newTab];
      }
    });

    setActiveTabId(newId);
  }, [settings.defaultNewTabType, setActiveTabId, setTabs]);

  /** Splits `paneId` (defaulting to the tab's active/first pane) without ever recreating existing panes. */
  const handleSplitPane = useCallback((tabId: string, orientation: PaneOrientation, paneId?: string) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId || t.type !== 'terminal' || !t.paneTree) return t;
        const targetPaneId = paneId ?? t.activePaneId ?? getFirstLeafId(t.paneTree);
        const { tree, newPaneId } = splitPane(t.paneTree, targetPaneId, orientation, t.id);
        // Splitting un-zooms: the new pane would otherwise be created hidden.
        return { ...t, paneTree: tree, activePaneId: newPaneId, zoomedPaneId: undefined };
      })
    );
  }, [setTabs]);

  /** Shows only `paneId` (default: the active pane) full-size, or restores the layout if already zoomed. */
  const handleToggleZoom = useCallback((tabId: string, paneId?: string) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId || t.type !== 'terminal' || !t.paneTree) return t;
        if (t.zoomedPaneId) return { ...t, zoomedPaneId: undefined };
        const target = paneId ?? t.activePaneId ?? getFirstLeafId(t.paneTree);
        if (t.paneTree.type === 'leaf' || !findLeaf(t.paneTree, target)) return t;
        return { ...t, zoomedPaneId: target, activePaneId: target };
      })
    );
  }, [setTabs]);

  /** Sets a split node's relative pane sizes (§23) — only the 2-child case is draggable today. */
  const handleResizeSplit = useCallback((tabId: string, splitId: string, weights: number[]) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId || t.type !== 'terminal' || !t.paneTree) return t;
        return { ...t, paneTree: updateSplitWeights(t.paneTree, splitId, weights) };
      })
    );
  }, [setTabs]);

  /** Closes one specific pane (à la Konsole), leaving every other pane's session untouched. */
  const handleClosePane = useCallback((tabId: string, paneId: string) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId || t.type !== 'terminal' || !t.paneTree) return t;
        const nextTree = closePane(t.paneTree, paneId);
        if (!nextTree) return t; // sole pane: caller should close the whole tab instead
        return {
          ...t,
          paneTree: nextTree,
          activePaneId: t.activePaneId === paneId ? getFirstLeafId(nextTree) : t.activePaneId,
          zoomedPaneId: t.zoomedPaneId === paneId || nextTree.type === 'leaf' ? undefined : t.zoomedPaneId,
        };
      })
    );
  }, [setTabs]);

  /** Keeps only the active pane, closing every other split in the tab (a quick "unsplit"). */
  const handleUnsplit = useCallback((tabId: string) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId || t.type !== 'terminal' || !t.paneTree) return t;
        const keepId = t.activePaneId ?? getFirstLeafId(t.paneTree);
        const keptLeaf = findLeaf(t.paneTree, keepId);
        if (!keptLeaf) return t;
        return { ...t, paneTree: keptLeaf, activePaneId: keptLeaf.id, zoomedPaneId: undefined };
      })
    );
  }, [setTabs]);

  const handleSelectPane = useCallback((tabId: string, paneId: string) => {
    setTabBarFocused(false);
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId || t.type !== 'terminal' || !t.paneTree) return t;
        const leaf = findLeaf(t.paneTree, paneId);
        const baseTitle =
          leaf?.config?.name ||
          (leaf?.local
            ? leaf.shellType === 'wsl'
              ? leaf.wslDistro
                ? `WSL: ${leaf.wslDistro}`
                : 'WSL'
              : 'Local Shell'
            : t.title);
        const title = leaf?.dynamicHost || baseTitle || t.title;
        return { ...t, activePaneId: paneId, title };
      })
    );
  }, [setTabBarFocused, setTabs]);

  const handleConnectTerminal = (
    target: { tabId: string; paneId?: string },
    config: SSHConnectionConfig
  ) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== target.tabId || t.type !== 'terminal' || !t.paneTree) return t;
        const paneId = target.paneId ?? getFirstLeafId(t.paneTree);
        const paneTree = updateLeaf(t.paneTree, paneId, (leaf) => ({
          ...leaf,
          config,
          local: false,
          shellType: undefined,
          baseHost: config.host,
          dynamicHost: undefined,
        }));
        const leavesCount = countLeaves(paneTree);
        const isDefaultTitle = !t.title || /^Terminal\s+\d+$/.test(t.title);
        const title = isDefaultTitle || leavesCount <= 1 ? config.name : t.title;
        return { ...t, paneTree, title };
      })
    );
    setConnectTarget(null);
  };

  const handleConnectK8sTerminal = (
    target: { tabId: string; paneId?: string },
    k8sTarget: K8sTerminalTarget
  ) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== target.tabId || t.type !== 'terminal' || !t.paneTree) return t;
        const paneId = target.paneId ?? getFirstLeafId(t.paneTree);
        const paneTree = updateLeaf(t.paneTree, paneId, (leaf) => ({
          ...leaf,
          config: undefined,
          local: false,
          shellType: undefined,
          k8sTarget,
          baseHost: `${k8sTarget.podName}/${k8sTarget.containerName}`,
          dynamicHost: undefined,
        }));
        const leavesCount = countLeaves(paneTree);
        const isDefaultTitle = !t.title || /^Terminal\s+\d+$/.test(t.title);
        const title = isDefaultTitle || leavesCount <= 1 ? k8sTarget.podName : t.title;
        return { ...t, paneTree, title };
      })
    );
    setConnectTarget(null);
  };

  /**
   * Connection Manager's Connect: fills the active tab when it is an empty terminal, otherwise opens
   * a new terminal tab titled `title` around `leaf`; the modal closes either way.
   */
  const openInTerminalTab = (
    title: string,
    leaf: { config: SSHConnectionConfig } | { k8sTarget: K8sTerminalTarget },
    fillActive: (tabId: string) => void
  ) => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (activeTab && activeTab.type === 'terminal' && isEmptyUnconnectedTab(activeTab)) {
      fillActive(activeTab.id);
    } else {
      const newId = `term-${Date.now()}`;
      const newTab: AppTab = { id: newId, type: 'terminal', title, paneTree: createLeaf(`${newId}-root`, leaf) };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newId);
    }
    setProfilesModalOpen(false);
  };

  const handleOpenSSHInTab = (config: SSHConnectionConfig) =>
    openInTerminalTab(config.name, { config }, (tabId) => handleConnectTerminal({ tabId }, config));

  const handleOpenK8sInTab = (k8sTarget: K8sTerminalTarget) =>
    openInTerminalTab(k8sTarget.podName, { k8sTarget }, (tabId) => handleConnectK8sTerminal({ tabId }, k8sTarget));

  /**
   * "Connect all" for a system: a terminal tab per server (all created in one update so their ids
   * cannot collide, the first one selected) and the tunnels its servers list. `source` is the
   * Connection Manager's tab key: a personal server gets its last-used time written, a Team Vault
   * one never does. A tunnel that fails to start does not stop the rest; they are reported together.
   */
  const handleConnectSystem = useCallback(
    async (members: SSHConnectionConfig[], source: string) => {
      const plan = planSystemConnect(members);
      if (plan.tabs.length === 0 && plan.tunnels.length === 0) return;

      if (plan.tabs.length > 0) {
        const stamp = Date.now();
        const opened: AppTab[] = plan.tabs.map(({ title, config, startDirectory }, i) => {
          const id = `term-${stamp}-${i}`;
          return {
            id,
            type: 'terminal',
            title,
            paneTree: createLeaf(`${id}-root`, { config }),
            ...(startDirectory ? { initialCwd: startDirectory } : {}),
          };
        });
        setTabs((prev) => [...prev, ...opened]);
        setActiveTabId(opened[0].id);
      }
      setProfilesModalOpen(false);

      void Promise.all(
        members.map((member) => prepareConnect(member, source, (profile) => window.multissh.profilesSaveSSH(profile)))
      ).catch(() => {});

      const results = await Promise.allSettled(plan.tunnels.map(({ config, tunnel }) => window.multissh.sshTunnelStart(config, tunnel)));
      const failures = results.flatMap((result, i) =>
        result.status === 'rejected'
          ? [`${plan.tunnels[i].config.name}: ${plan.tunnels[i].tunnel.name} (${describeIpcError(result.reason, 'could not start')})`]
          : []
      );
      if (failures.length > 0) {
        notify?.(`${failures.length} of ${plan.tunnels.length} tunnels could not start. ${failures.join('; ')}`);
      }
    },
    [notify, setActiveTabId, setProfilesModalOpen, setTabs]
  );

  const handleViewK8sLogs = useCallback((k8sLogTarget: K8sTerminalTarget) => {
    const newId = `term-${Date.now()}`;
    const newTab: AppTab = {
      id: newId,
      type: 'terminal',
      title: `Logs: ${k8sLogTarget.podName}`,
      paneTree: createLeaf(`${newId}-root`, { k8sLogTarget }),
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
  }, [setActiveTabId, setTabs]);

  const handleOpenLocalTerminal = useCallback(
    (target: { tabId: string; paneId?: string }, shellType?: LocalShellType, wslDistro?: string) => {
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== target.tabId || t.type !== 'terminal' || !t.paneTree) return t;
          const paneId = target.paneId ?? getFirstLeafId(t.paneTree);
          const baseHost = localHostname || undefined;
          const paneTree = updateLeaf(t.paneTree, paneId, (leaf) => ({
            ...leaf,
            config: undefined,
            local: true,
            shellType,
            wslDistro,
            baseHost,
            dynamicHost: undefined,
          }));
          const defaultTitle =
            shellType === 'wsl'
              ? wslDistro
                ? `WSL: ${wslDistro}`
                : 'WSL'
              : 'Local Shell';
          const leavesCount = countLeaves(paneTree);
          const isDefaultTitle = !t.title || /^Terminal\s+\d+$/.test(t.title);
          const title = isDefaultTitle || leavesCount <= 1 ? defaultTitle : t.title;
          return { ...t, paneTree, title };
        })
      );
    },
    [localHostname, setTabs]
  );

  const handlePaneTitleChange = useCallback(
    async (tabId: string, paneId: string, rawTitle: string) => {
      const host = extractHostnameFromTitle(rawTitle);
      if (!host && rawTitle !== '__EXIT__') return;

      let activeLocalHostname = localHostname;
      if (!activeLocalHostname && window.multissh?.getHostname) {
        try {
          activeLocalHostname = (await window.multissh.getHostname()) || '';
        } catch {
          activeLocalHostname = '';
        }
      }

      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== tabId || t.type !== 'terminal' || !t.paneTree) return t;
          const leaf = findLeaf(t.paneTree, paneId);
          if (!leaf) return t;

          const baseTitle =
            leaf.config?.name ||
            (leaf.local
              ? leaf.shellType === 'wsl'
                ? leaf.wslDistro
                  ? `WSL: ${leaf.wslDistro}`
                  : 'WSL'
                : 'Local Shell'
              : 'Terminal');

          // User typed exit, logout, or pressed Ctrl+D
          if (rawTitle === '__EXIT__') {
            if (!leaf.dynamicHost) return t;
            const updatedTree = updateLeaf(t.paneTree, paneId, (l) => ({
              ...l,
              dynamicHost: undefined,
            }));
            const isSoleOrActive = countLeaves(t.paneTree) === 1 || t.activePaneId === paneId;
            const nextTitle = isSoleOrActive ? baseTitle : t.title;
            return { ...t, paneTree: updatedTree, title: nextTitle };
          }

          if (!host) return t;

          const effectiveBaseHost =
            leaf.baseHost || (leaf.local ? (activeLocalHostname || 'localhost') : leaf.config?.host);

          // Check if current host is the base host
          const isBase =
            (Boolean(effectiveBaseHost) && isSameHost(host, effectiveBaseHost)) ||
            (Boolean(leaf.config?.host) && isSameHost(host, leaf.config!.host)) ||
            (Boolean(activeLocalHostname) && isSameHost(host, activeLocalHostname)) ||
            isSameHost(host, baseTitle) ||
            isSameHost(host, 'localhost') ||
            isSameHost(host, '127.0.0.1');

          const nextDynamicHost = isBase ? undefined : host;
          if (leaf.dynamicHost === nextDynamicHost) return t;

          const updatedTree = updateLeaf(t.paneTree, paneId, (l) => ({
            ...l,
            baseHost: effectiveBaseHost,
            dynamicHost: nextDynamicHost,
          }));

          const isSoleOrActive = countLeaves(t.paneTree) === 1 || t.activePaneId === paneId;
          const nextTitle = isSoleOrActive ? (nextDynamicHost || baseTitle) : t.title;

          return { ...t, paneTree: updatedTree, title: nextTitle };
        })
      );
    },
    [localHostname, setTabs]
  );

  const handleOpenTerminalAt = useCallback(
    (config: SSHConnectionConfig, path: string) => {
      const newId = `term-${Date.now()}`;
      const newTab: AppTab = {
        id: newId,
        type: 'terminal',
        title: config.name,
        paneTree: createLeaf(`${newId}-root`, { config }),
        initialCwd: path,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newId);
    },
    [setActiveTabId, setTabs]
  );

  // Ctrl+click on a file path in an SSH terminal: browse that folder over SFTP in a new file manager tab.
  const handleOpenRemotePath = useCallback(async (config: SSHConnectionConfig, rawPath: string) => {
    const home = config.username === 'root' ? '/root' : `/home/${config.username || 'user'}`;
    const absolute = rawPath === '~' ? home : rawPath.startsWith('~/') ? `${home}${rawPath.slice(1)}` : rawPath;
    let isDir = absolute.endsWith('/');
    if (!isDir) {
      // A miss falls back to the filename check below.
      const stat = await statIfExists(`sftp-${config.id || config.host}`, absolute);
      if (stat?.isDirectory) isDir = true;
    }
    const lastSlash = absolute.lastIndexOf('/');
    const folder = isDir ? absolute : lastSlash === -1 ? home : absolute.slice(0, lastSlash) || '/';
    const selectPath = isDir ? undefined : absolute;
    const newId = `fm-${Date.now()}`;
    const newTab: AppTab = {
      id: newId,
      type: 'filemanager',
      title: `${config.name} (SFTP)`,
      initialSSHConfig: { ...config, initialPath: folder },
      initialSelectedPath: selectPath,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
  }, [setActiveTabId, setTabs]);

  // Click on a file path in a local terminal: browse that folder on Local Disk in a new file manager tab.
  const handleOpenLocalPath = useCallback(async (rawPath: string) => {
    let resolved = rawPath;
    if (resolved === '~' || resolved.startsWith('~/')) {
      const home = (await window.multissh?.getHomeDir?.()) || '';
      if (home) {
        resolved = resolved === '~' ? home : `${home.replace(/\/+$/, '')}/${resolved.slice(2)}`;
      }
    }
    // A Windows path (drive letter or UNC) separates with backslashes; everything else is unchanged.
    const isWindowsPath = /^[A-Za-z]:|^\\\\/.test(resolved);
    let isDir = resolved.endsWith('/') || (isWindowsPath && resolved.endsWith('\\'));
    if (!isDir) {
      const stat = await statIfExists('local', resolved);
      if (stat?.isDirectory) isDir = true;
    }
    const lastSlash = Math.max(resolved.lastIndexOf('/'), isWindowsPath ? resolved.lastIndexOf('\\') : -1);
    let folder = isDir ? resolved : lastSlash === -1 ? '/' : resolved.slice(0, lastSlash) || '/';
    // "C:" alone means the drive's current directory; the root needs its separator.
    if (isWindowsPath && /^[A-Za-z]:$/.test(folder)) folder = `${folder}\\`;
    const selectPath = isDir ? undefined : resolved;
    const newId = `fm-${Date.now()}`;
    const newTab: AppTab = {
      id: newId,
      type: 'filemanager',
      title: 'Local Files',
      initialLocalPath: folder,
      initialSelectedPath: selectPath,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
  }, [setActiveTabId, setTabs]);

  const handleOpenK8sTerminalAt = useCallback((target: K8sTerminalTarget, folderPath: string) => {
    const newId = `term-${Date.now()}`;
    const shellCommand = folderPath && folderPath !== '/' ? `cd ${JSON.stringify(folderPath)} && exec /bin/sh` : undefined;
    const newTab: AppTab = {
      id: newId,
      type: 'terminal',
      title: target.podName,
      paneTree: createLeaf(`${newId}-root`, {
        k8sTarget: shellCommand ? { ...target, shell: shellCommand } : target,
      }),
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
  }, [setActiveTabId, setTabs]);

  const handleBrowseK8sFiles = useCallback((target: K8sTerminalTarget) => {
    const newId = `fm-${Date.now()}`;
    const newTab: AppTab = {
      id: newId,
      type: 'filemanager',
      title: `${target.podName} (${target.containerName})`,
      initialK8sTarget: target,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
    setProfilesModalOpen(false);
  }, [setActiveTabId, setProfilesModalOpen, setTabs]);

  const handleConnectSFTP = useCallback((config: SSHConnectionConfig) => {
    const newId = `fm-${Date.now()}`;
    const newTab: AppTab = {
      id: newId,
      type: 'filemanager',
      title: `${config.name} (SFTP)`,
      initialSSHConfig: config,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
    setProfilesModalOpen(false);
    setConnectTarget(null);
  }, [setActiveTabId, setConnectTarget, setProfilesModalOpen, setTabs]);

  const handleConnectS3 = useCallback((config: S3Config) => {
    const newId = `fm-${Date.now()}`;
    const newTab: AppTab = {
      id: newId,
      type: 'filemanager',
      title: `${config.name} (S3)`,
      initialS3Config: config,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
    setProfilesModalOpen(false);
  }, [setActiveTabId, setProfilesModalOpen, setTabs]);

  // UX audit finding #3: clicking this landing-page card used to create an
  // empty, unconnected leaf — landing on a "No connection selected for this
  // tab" screen that then needed a second click ("Open Local Terminal") for
  // what the card itself frames as the single most common action. Open a
  // local shell immediately instead, same as that second click would have
  // done. Ctrl+Shift+T and the "+" menu's "New Terminal" keep the original
  // unconnected-tab behavior (tab-number reuse relies on it being possible
  // to have a placeholder "Terminal N" tab open).
  const handleQuickStartTerminal = useCallback(() => {
    const newId = `term-${Date.now()}`;
    const newTab: AppTab = {
      id: newId,
      type: 'terminal',
      title: 'Local Shell',
      paneTree: createLeaf(`${newId}-root`, { local: true, baseHost: localHostname || undefined }),
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
  }, [localHostname, setActiveTabId, setTabs]);

  const handleConnectRecentSSH = useCallback((profile: SSHConnectionConfig) => {
    if (profile.id.startsWith('demo-')) {
      const newId = `term-${Date.now()}`;
      const newTab: AppTab = {
        id: newId,
        type: 'terminal',
        title: `${profile.name} (Demo)`,
        paneTree: createLeaf(`${newId}-root`, { local: true, baseHost: profile.name }),
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newId);
      return;
    }
    const updated = { ...profile, lastUsedAt: formatDateTime(new Date()) };
    void window.multissh?.profilesSaveSSH?.(updated).catch(() => {});
    const newId = `term-${Date.now()}`;
    const newTab: AppTab = {
      id: newId,
      type: 'terminal',
      title: updated.name,
      paneTree: createLeaf(`${newId}-root`, { config: updated }),
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
  }, [setActiveTabId, setTabs]);

  const handleOpenEditorTab = useCallback((detail: OpenEditorTabDetail) => {
    const newId = `editor-${Date.now()}`;
    const newTab: AppTab = {
      id: newId,
      type: 'editor',
      title: detail.entry.name || 'Editor',
      editorEntry: detail.entry,
      editorProviderId: detail.providerId,
      editorSourceType: detail.sourceType,
      editorInitialMode: detail.initialMode,
      editorTailMode: detail.isTailMode,
      editorInitialContent: detail.initialContent,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
  }, [setActiveTabId, setTabs]);

  return {
    handleSelectTab,
    handleCloseTab,
    handleNewTab,
    handleSplitPane,
    handleResizeSplit,
    handleClosePane,
    handleToggleZoom,
    handleUnsplit,
    handleSelectPane,
    handleConnectTerminal,
    handleConnectK8sTerminal,
    handleOpenSSHInTab,
    handleOpenK8sInTab,
    handleConnectSystem,
    handleViewK8sLogs,
    handleOpenLocalTerminal,
    handlePaneTitleChange,
    handleOpenTerminalAt,
    handleOpenRemotePath,
    handleOpenLocalPath,
    handleOpenK8sTerminalAt,
    handleBrowseK8sFiles,
    handleConnectSFTP,
    handleConnectS3,
    handleQuickStartTerminal,
    handleConnectRecentSSH,
    handleOpenEditorTab,
  };
}
