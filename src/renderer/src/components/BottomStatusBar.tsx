import React, { useEffect, useRef, useState } from 'react';
import {
  Cable,
  CreditCard,
  FolderSync,
  Layers,
  Moon,
  Palette,
  Plus,
  Radio,
  RefreshCw,
  Shield,
  ShieldCheck,
  Sparkles,
  Sun,
} from 'lucide-react';
import type { SSHActiveTunnel } from '@shared/types/ssh';
import type { AppSettings } from '@shared/types/settings';
import type { AppTab } from '../lib/tabs';
import { GlobalTransferHud } from './GlobalTransferHud';
import { useSshCa } from '../lib/useSshCa';
import { hubRequest, useHub } from '../lib/aiHub';

export interface BottomStatusBarProps {
  tabs: AppTab[];
  activeTabId: string;
  theme: AppSettings['theme'];
  onChangeTheme: (theme: 'dark' | 'light' | 'breeze') => void;
  smartcardAuthMode?: AppSettings['smartcardAuthMode'];
  onOpenTunnels?: () => void;
  onOpenDirSync?: () => void;
  onOpenSettings?: () => void;
  onOpenConnections?: () => void;
  onToggleAi?: () => void;
  aiOpen?: boolean;
}

/**
 * Persistent Bottom Status Bar (`F6` — Option 1B + 3A).
 * Mounted at the bottom of the application shell across Mission Control, Terminal, SFTP, and S3 tabs.
 * Displays active connection/session status, connected workspaces switcher, SSH CA / Smartcard status,
 * active tunnels count, the Global Transfer HUD, and quick Theme Switcher.
 */
export const BottomStatusBar: React.FC<BottomStatusBarProps> = ({
  tabs,
  activeTabId,
  theme,
  onChangeTheme,
  smartcardAuthMode,
  onOpenTunnels,
  onOpenDirSync,
  onOpenSettings,
  onOpenConnections,
  onToggleAi,
  aiOpen = false,
}) => {
  const [activeTunnels, setActiveTunnels] = useState<SSHActiveTunnel[]>([]);
  const [transferDrawerOpen, setTransferDrawerOpen] = useState(false);
  const [workspacesPopoverOpen, setWorkspacesPopoverOpen] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const { status: caStatus } = useSshCa();
  const rawHub = useHub();
  const lastHubRef = useRef(rawHub);
  if (rawHub) {
    lastHubRef.current = rawHub;
  }
  const hub = rawHub ?? lastHubRef.current;

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(
    hub?.activeWorkspaceId ?? 'ALL'
  );

  useEffect(() => {
    if (hub?.activeWorkspaceId) {
      setSelectedWorkspaceId(hub.activeWorkspaceId);
    }
  }, [hub?.activeWorkspaceId]);

  useEffect(() => {
    const onWorkspaceSelect = (e: Event) => {
      const detail = (e as CustomEvent<{ workspaceId?: string }>).detail;
      if (detail?.workspaceId) {
        setSelectedWorkspaceId(detail.workspaceId);
      }
    };
    window.addEventListener('sshs3:workspace-select', onWorkspaceSelect);
    return () => window.removeEventListener('sshs3:workspace-select', onWorkspaceSelect);
  }, []);

  useEffect(() => {
    window.multissh
      ?.sshTunnelList?.()
      ?.then((list) => {
        if (Array.isArray(list)) setActiveTunnels(list);
      })
      ?.catch(() => {});
    const unsubscribe = window.multissh?.onSshTunnelEvent?.(setActiveTunnels);
    return () => unsubscribe?.();
  }, []);

  const liveTunnels = activeTunnels.filter((t) => t.status === 'active').length;
  const erroredTunnels = activeTunnels.filter((t) => t.status === 'error').length;

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const statusLabel = activeTab
    ? `${activeTab.type === 'terminal' ? 'SSH / Terminal' : activeTab.type === 'filemanager' ? 'Storage / SFTP · S3' : 'Editor'} · ${activeTab.title}`
    : 'Mission Control · Fleet Ready';

  const currentTheme: 'dark' | 'light' | 'breeze' =
    theme === 'light' ? 'light' : theme === 'breeze' ? 'breeze' : 'dark';

  const workspaces = hub?.workspaces ?? [];
  const connectedCount =
    workspaces.filter((w) => w.connected).length || workspaces.length || 1;
  const activeWs =
    selectedWorkspaceId !== 'ALL'
      ? workspaces.find((w) => w.id === selectedWorkspaceId)
      : undefined;

  const handleSelectWorkspace = (wsId: string) => {
    setSelectedWorkspaceId(wsId);
    window.dispatchEvent(new CustomEvent('sshs3:workspace-select', { detail: { workspaceId: wsId } }));
    void hubRequest({ action: 'workspace-select', workspaceId: wsId }).catch(() => {});
  };

  const handleSyncAllWorkspaces = async () => {
    setSyncingAll(true);
    try {
      await hubRequest({ action: 'workspace-s3-sync-now' });
    } catch {
      // Ignore in mocked/offline environments
    } finally {
      setSyncingAll(false);
    }
  };

  return (
    <footer
      data-testid="bottom-status-bar"
      aria-label="Application status bar"
      className="sshs3-status-bar relative z-30 flex h-7 shrink-0 items-center justify-between gap-3 px-3 select-none"
    >
      {/* Left section: Active tab/connection status, Connected Workspaces badge & popover, SSH CA / Smartcard status, Tunnels count */}
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          data-testid="status-connection-indicator"
          onClick={onOpenConnections}
          title="Active workspace status (Click to open Connections & Inventory)"
          className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-2xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
        >
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              activeTab ? 'bg-emerald-400 sshs3-sonar-emerald' : 'bg-sky-400'
            }`}
          />
          <span className="truncate max-w-[240px]">{statusLabel}</span>
          {tabs.length > 0 && (
            <span className="rounded bg-app-surface-subtle px-1 py-0.2 font-mono text-[10px] text-txt-muted">
              {tabs.length} {tabs.length === 1 ? 'tab' : 'tabs'}
            </span>
          )}
        </button>

        <span className="h-3 w-px bg-divider shrink-0" aria-hidden="true" />

        {/* Multi-Workspace status badge & quick switcher popover */}
        <div className="relative">
          <button
            type="button"
            data-testid="status-workspaces-badge"
            aria-expanded={workspacesPopoverOpen}
            onClick={() => setWorkspacesPopoverOpen((prev) => !prev)}
            title="Connected Workspaces — switch active workspace or sync all"
            className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-2xs font-mono transition-colors ${
              workspacesPopoverOpen
                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/35'
                : 'text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
            }`}
          >
            <Layers className="h-3 w-3 text-sky-400 shrink-0" />
            <span>
              {connectedCount} {connectedCount === 1 ? 'Workspace' : 'Workspaces'}
            </span>
            <span className="text-txt-muted">·</span>
            <span className="truncate max-w-[120px] text-sky-300">
              {activeWs ? activeWs.name : 'All Connected'}
            </span>
          </button>

          {workspacesPopoverOpen && (
            <div
              data-testid="status-workspaces-popover"
              className="sshs3-glass-panel sshs3-drawer-anim absolute bottom-8 left-0 z-50 w-72 rounded-xl border border-border-subtle p-2.5 shadow-2xl space-y-2"
            >
              <div className="flex items-center justify-between gap-2 border-b border-divider pb-1.5">
                <span className="text-[10px] font-mono font-semibold uppercase tracking-wider text-txt-muted">
                  Connected Workspaces ({workspaces.length || 1})
                </span>
                <button
                  type="button"
                  data-testid="status-workspace-sync-all"
                  disabled={syncingAll}
                  onClick={() => void handleSyncAllWorkspaces()}
                  className="inline-flex items-center gap-1 rounded border border-border-subtle bg-app-surface-subtle hover:bg-app-surface-hover px-2 py-0.5 text-[10px] font-mono text-txt-secondary hover:text-txt-primary disabled:opacity-50"
                >
                  <RefreshCw className={`h-2.5 w-2.5 text-emerald-400 ${syncingAll ? 'animate-spin' : ''}`} />
                  <span>Sync All Workspaces</span>
                </button>
              </div>

              <div className="space-y-1 max-h-52 overflow-y-auto">
                <button
                  type="button"
                  data-testid="status-workspace-select-ALL"
                  aria-pressed={selectedWorkspaceId === 'ALL'}
                  onClick={() => {
                    handleSelectWorkspace('ALL');
                    setWorkspacesPopoverOpen(false);
                  }}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-mono transition-colors ${
                    selectedWorkspaceId === 'ALL'
                      ? 'bg-sky-500/20 text-sky-200 border border-sky-400/40'
                      : 'text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
                  }`}
                >
                  <span>All Connected Workspaces</span>
                  <span className="rounded bg-app-surface-subtle px-1.5 py-0.2 text-[10px] text-txt-muted">
                    {(hub?.workspaceServers ?? []).length}
                  </span>
                </button>

                {workspaces.map((ws) => {
                  const isActive = selectedWorkspaceId === ws.id;
                  return (
                    <button
                      key={ws.id}
                      type="button"
                      data-testid={`status-workspace-select-${ws.id}`}
                      aria-pressed={isActive}
                      onClick={() => {
                        handleSelectWorkspace(ws.id);
                        setWorkspacesPopoverOpen(false);
                      }}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-mono transition-colors ${
                        isActive
                          ? 'bg-sky-500/20 text-sky-200 border border-sky-400/40'
                          : 'text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            ws.connected ? 'bg-emerald-400' : 'bg-txt-muted'
                          }`}
                        />
                        <span className="truncate">{ws.name}</span>
                      </span>
                      <span className="shrink-0 rounded bg-app-surface-subtle px-1.5 py-0.2 text-[10px] text-txt-muted">
                        {ws.serverCount}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="border-t border-divider pt-1.5">
                <button
                  type="button"
                  data-testid="status-workspace-open-hub"
                  onClick={() => {
                    setWorkspacesPopoverOpen(false);
                    onOpenConnections?.();
                    window.dispatchEvent(new CustomEvent('sshs3:open-workspace-hub'));
                  }}
                  className="flex w-full items-center justify-center gap-1 rounded-lg border border-sky-400/30 bg-sky-500/15 hover:bg-sky-500/25 px-2.5 py-1 text-[10.5px] font-mono text-sky-200 transition-colors"
                >
                  <Plus className="h-3 w-3" />
                  <span>Connect Another Workspace</span>
                </button>
              </div>
            </div>
          )}
        </div>

        <span className="h-3 w-px bg-divider shrink-0" aria-hidden="true" />

        {/* SSH CA / Smartcard status badge */}
        <button
          type="button"
          data-testid="status-ca-smartcard-badge"
          onClick={onOpenSettings}
          title={
            caStatus.active
              ? `SSH CA Active (${caStatus.username})`
              : smartcardAuthMode === 'agent-global'
                ? 'Smartcard Global Agent Active'
                : 'SSH CA / Smartcard status'
          }
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
        >
          {caStatus.active ? (
            <>
              <ShieldCheck className="h-3 w-3 text-emerald-400 shrink-0" />
              <span className="text-emerald-300 font-medium">CA: {caStatus.username || 'Active'}</span>
            </>
          ) : smartcardAuthMode === 'agent-global' ? (
            <>
              <CreditCard className="h-3 w-3 text-amber-400 shrink-0" />
              <span className="text-amber-300">PIV/FIDO2</span>
            </>
          ) : (
            <>
              <Shield className="h-3 w-3 shrink-0" />
              <span>CA Idle</span>
            </>
          )}
        </button>

        {/* Active SSH Tunnels indicator */}
        <button
          type="button"
          data-testid="status-tunnels-badge"
          onClick={onOpenTunnels}
          title="Open SSH Tunnels slide-over drawer"
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs transition-colors hover:bg-app-surface-hover ${
            erroredTunnels > 0
              ? 'text-rose-400 font-medium'
              : liveTunnels > 0
                ? 'text-emerald-400 font-medium'
                : 'text-txt-muted hover:text-txt-primary'
          }`}
        >
          <Cable className="h-3 w-3 shrink-0" />
          <span className="font-mono">
            {liveTunnels > 0
              ? `${liveTunnels} tunnel${liveTunnels === 1 ? '' : 's'}`
              : erroredTunnels > 0
                ? `${erroredTunnels} tunnel err`
                : '0 tunnels'}
          </span>
        </button>

        {onOpenDirSync && (
          <button
            type="button"
            data-testid="status-dirsync-badge"
            onClick={onOpenDirSync}
            title="Open Directory Sync Profiles drawer"
            className="hidden sm:flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            <FolderSync className="h-3 w-3 shrink-0" />
            <span>DirSync</span>
          </button>
        )}
      </div>

      {/* Center section: Global Transfer HUD */}
      <div className="flex items-center justify-center">
        <GlobalTransferHud
          drawerOpen={transferDrawerOpen}
          onToggleDrawer={() => setTransferDrawerOpen((prev) => !prev)}
        />
      </div>

      {/* Right section: Quick Theme Switcher (Dark / Light / Breeze) & AI Copilot status */}
      <div className="flex items-center gap-2">
        <div
          data-testid="status-theme-switcher"
          role="group"
          aria-label="Theme switcher"
          className="flex items-center gap-0.5 rounded-md border border-border-subtle bg-app-surface-subtle p-0.5"
        >
          {(
            [
              { id: 'dark' as const, label: 'Dark', icon: Moon },
              { id: 'light' as const, label: 'Light', icon: Sun },
              { id: 'breeze' as const, label: 'Breeze', icon: Palette },
            ] as const
          ).map(({ id, label, icon: Icon }) => {
            const active = currentTheme === id;
            return (
              <button
                key={id}
                type="button"
                data-testid={`status-theme-${id}`}
                aria-pressed={active}
                title={`Switch to ${label} theme`}
                onClick={() => onChangeTheme(id)}
                className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                  active
                    ? 'bg-sky-600 text-white shadow-xs'
                    : 'text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary'
                }`}
              >
                <Icon className="h-2.5 w-2.5 shrink-0" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>

        {onToggleAi && (
          <button
            type="button"
            data-testid="status-ai-indicator"
            onClick={onToggleAi}
            title="Toggle AI Co-Pilot & RAG Hub drawer"
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium transition-colors ${
              aiOpen
                ? 'bg-sky-500/15 text-sky-400 border border-sky-500/30'
                : 'text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary'
            }`}
          >
            <Sparkles className="h-3 w-3 shrink-0 text-sky-400" />
            <span className="hidden md:inline">AI Co-Pilot</span>
            <Radio className="h-2.5 w-2.5 text-emerald-400 shrink-0" />
          </button>
        )}
      </div>
    </footer>
  );
};

export default BottomStatusBar;
