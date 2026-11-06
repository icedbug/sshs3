import React, { useEffect, useState } from 'react';
import {
  Cable,
  CreditCard,
  FolderSync,
  Moon,
  Palette,
  Radio,
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
 * Displays active connection/session status, SSH CA / Smartcard status, active tunnels count,
 * the Global Transfer HUD (with 1-click expandable transfer queue drawer), and quick Theme Switcher.
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
  const { status: caStatus } = useSshCa();

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

  return (
    <footer
      data-testid="bottom-status-bar"
      aria-label="Application status bar"
      className="sshs3-status-bar relative z-30 flex h-7 shrink-0 items-center justify-between gap-3 px-3 select-none"
    >
      {/* Left section: Active tab/connection status, SSH CA / Smartcard status, Tunnels count */}
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
