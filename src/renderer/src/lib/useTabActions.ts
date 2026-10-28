import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { TabType } from '../components/TabBar';
import type { AppSettings } from '@shared/types/settings';
import type { SSHConnectionConfig, LocalShellType } from '@shared/types/ssh';
import type { PaneOrientation } from '@shared/types/session';
import type { K8sTerminalTarget } from '@shared/types/kubernetes';
import type { AppTab } from './tabs';
import { formatDateTime } from './format';
import { closePane, countLeaves, createLeaf, findLeaf, getFirstLeafId, splitPane, updateLeaf } from './paneTree';
import { extractHostnameFromTitle, isSameHost } from './terminalTitle';

export interface TabActionsContext {
  activeTabId: string;
  settings: AppSettings;
  localHostname: string;
  setTabs: Dispatch<SetStateAction<AppTab[]>>;
  setActiveTabId: Dispatch<SetStateAction<string>>;
  setTabBarFocused: Dispatch<SetStateAction<boolean>>;
  setConnectTarget: Dispatch<SetStateAction<{ tabId: string; paneId?: string } | null>>;
  setProfilesModalOpen: Dispatch<SetStateAction<boolean>>;
}

/** Everything that creates, closes, splits or connects tabs and panes. */
export function useTabActions(ctx: TabActionsContext) {
  const { activeTabId, settings, localHostname, setTabs, setActiveTabId, setTabBarFocused, setConnectTarget, setProfilesModalOpen } = ctx;

  const handleSelectTab = (id: string) => {
    setActiveTabId(id);
    setTabBarFocused(false);
  };

  const handleCloseTab = useCallback((id: string) => {
    setTabs((prev) => {
      const index = prev.findIndex((t) => t.id === id);
      const remaining = prev.filter((t) => t.id !== id);

      if (id === activeTabId && remaining.length > 0) {
        const nextIndex = Math.max(0, index - 1);
        setActiveTabId(remaining[nextIndex].id);
      }

      return remaining;
    });
  }, [activeTabId, setActiveTabId, setTabs]);

  const handleNewTab = useCallback((type?: TabType) => {
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
        return { ...t, paneTree: tree, activePaneId: newPaneId };
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
        return { ...t, paneTree: keptLeaf, activePaneId: keptLeaf.id };
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
  const handleOpenRemotePath = useCallback((config: SSHConnectionConfig, rawPath: string) => {
    const home = config.username === 'root' ? '/root' : `/home/${config.username || 'user'}`;
    const absolute = rawPath === '~' ? home : rawPath.startsWith('~/') ? `${home}${rawPath.slice(1)}` : rawPath;
    // The terminal can't tell files from folders: a trailing slash means folder, anything else opens its parent.
    const folder = absolute.endsWith('/') ? absolute : absolute.slice(0, absolute.lastIndexOf('/')) || '/';
    const newId = `fm-${Date.now()}`;
    const newTab: AppTab = {
      id: newId,
      type: 'filemanager',
      title: `${config.name} (SFTP)`,
      initialSSHConfig: { ...config, initialPath: folder },
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

  return {
    handleSelectTab,
    handleCloseTab,
    handleNewTab,
    handleSplitPane,
    handleClosePane,
    handleUnsplit,
    handleSelectPane,
    handleConnectTerminal,
    handleConnectK8sTerminal,
    handleViewK8sLogs,
    handleOpenLocalTerminal,
    handlePaneTitleChange,
    handleOpenTerminalAt,
    handleOpenRemotePath,
    handleOpenK8sTerminalAt,
    handleBrowseK8sFiles,
    handleConnectSFTP,
    handleQuickStartTerminal,
    handleConnectRecentSSH,
  };
}
