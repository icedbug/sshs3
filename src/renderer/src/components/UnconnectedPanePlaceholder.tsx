import React, { useEffect, useMemo, useRef } from 'react';
import { Terminal } from 'lucide-react';
import type { LocalShellType } from '@shared/types/ssh';
import { FOCUSABLE_OVERLAY_SELECTOR, isElementVisible, navigateInOverlay, type NavigationDirection } from '../lib/spatialNavigation';
import { useHub } from '../lib/aiHub';

/** Buttons for launching a local shell (no SSH connection) in a pane. */
export const LocalTerminalButtons: React.FC<{
  platform: string;
  onOpen: (shellType?: LocalShellType, wslDistro?: string) => void;
}> = ({ platform, onOpen }) => {
  const [pwshAvailable, setPwshAvailable] = React.useState(false);
  const [wslAvailable, setWslAvailable] = React.useState(false);
  const [wslDistros, setWslDistros] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (platform !== 'win32') return;
    void window.multissh?.detectLocalShells?.().then((res) => {
      setPwshAvailable(Boolean(res?.pwsh));
      setWslAvailable(Boolean(res?.wsl));
      setWslDistros(res?.wslDistros || []);
    });
  }, [platform]);

  if (platform !== 'win32') {
    return (
      <button
        type="button"
        data-testid="open-local-terminal-btn"
        onClick={() => onOpen()}
        className="rounded-lg border border-border-subtle px-3 py-1 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover transition-colors"
      >
        Open Local Terminal
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-center gap-1.5">
      <button
        type="button"
        onClick={() => onOpen('cmd')}
        className="rounded-lg border border-border-subtle px-3 py-1 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover transition-colors"
      >
        Command Prompt
      </button>
      <button
        type="button"
        onClick={() => onOpen('powershell')}
        className="rounded-lg border border-border-subtle px-3 py-1 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover transition-colors"
      >
        PowerShell
      </button>
      {pwshAvailable && (
        <button
          type="button"
          onClick={() => onOpen('pwsh')}
          title="PowerShell 7+ (pwsh.exe)"
          className="rounded-lg border border-border-subtle px-3 py-1 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover transition-colors"
        >
          PowerShell 7
        </button>
      )}
      {wslAvailable &&
        (wslDistros.length > 1 ? (
          wslDistros.map((distro) => (
            <button
              key={distro}
              type="button"
              onClick={() => onOpen('wsl', distro)}
              title={`Windows Subsystem for Linux (${distro})`}
              className="rounded-lg border border-border-subtle px-3 py-1 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover transition-colors"
            >
              {distro}
            </button>
          ))
        ) : (
          <button
            type="button"
            onClick={() => onOpen('wsl', wslDistros[0])}
            title={
              wslDistros[0]
                ? `Windows Subsystem for Linux (${wslDistros[0]})`
                : 'Windows Subsystem for Linux (wsl.exe)'
            }
            className="rounded-lg border border-border-subtle px-3 py-1 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover transition-colors"
          >
            {wslDistros[0] ? `WSL (${wslDistros[0]})` : 'WSL'}
          </button>
        ))}
    </div>
  );
};

export interface UnconnectedPanePlaceholderProps {
  leafId: string;
  isSole: boolean;
  isActive: boolean;
  platform: string;
  onChangeConnection: (paneId: string) => void;
  onOpenLocalTerminal: (paneId: string, shellType?: LocalShellType, wslDistro?: string) => void;
  onNavigateToTabBar?: () => void;
}

export const UnconnectedPanePlaceholder: React.FC<UnconnectedPanePlaceholderProps> = ({
  leafId,
  isSole,
  isActive,
  platform,
  onChangeConnection,
  onOpenLocalTerminal,
  onNavigateToTabBar,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
  const hub = useHub();

  const workspaceClusters = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of hub?.workspaceServers ?? []) {
      if (s.cluster) {
        const list = map.get(s.cluster) ?? [];
        list.push(s.id);
        map.set(s.cluster, list);
      }
    }
    return Array.from(map.entries()).slice(0, 4);
  }, [hub?.workspaceServers]);

  useEffect(() => {
    if (isActive) {
      const timer = setTimeout(() => {
        primaryButtonRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isActive]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const dir: NavigationDirection =
        e.key === 'ArrowDown' ? 'down' : e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowLeft' ? 'left' : 'right';

      if (dir === 'up' && isSole && containerRef.current) {
        const candidates = Array.from(
          containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_OVERLAY_SELECTOR)
        ).filter(isElementVisible);
        const active = document.activeElement as HTMLElement | null;
        if (active && (candidates[0] === active || active === primaryButtonRef.current) && onNavigateToTabBar) {
          onNavigateToTabBar();
          return;
        }
      }

      if (containerRef.current) {
        navigateInOverlay(containerRef.current, dir);
      }
    } else if (e.key === 'Escape') {
      if (isSole && onNavigateToTabBar) {
        e.preventDefault();
        onNavigateToTabBar();
      }
    }
  };

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      data-testid={`unconnected-pane-${leafId}`}
      onKeyDown={handleKeyDown}
      className={`flex h-full flex-1 flex-col items-center justify-center ${
        isSole ? 'gap-3' : 'gap-2'
      } bg-app text-txt-muted outline-none select-none`}
    >
      <Terminal className={isSole ? 'h-10 w-10 text-txt-muted' : 'h-7 w-7 text-txt-muted'} />
      <p className={isSole ? 'text-sm text-txt-secondary' : 'text-xs text-txt-secondary'}>
        {isSole ? 'No connection selected for this tab' : 'No connection selected'}
      </p>
      <button
        ref={primaryButtonRef}
        type="button"
        data-testid="select-ssh-connection-btn"
        onClick={() => onChangeConnection(leafId)}
        className={`rounded-lg bg-sky-600 ${
          isSole ? 'px-3.5 py-1.5' : 'px-3 py-1'
        } text-xs font-medium text-white hover:bg-sky-500 shadow-sm transition-colors`}
      >
        Select SSH Connection
      </button>
      <LocalTerminalButtons
        platform={platform}
        onOpen={(shellType, wslDistro) => onOpenLocalTerminal(leafId, shellType, wslDistro)}
      />
      {workspaceClusters.length > 0 && (
        <div className="mt-2 flex flex-col items-center gap-1.5 max-w-md px-4">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-txt-muted">
            Eller öppna Workspace-kluster i 2×2 Split-View:
          </span>
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {workspaceClusters.map(([cName, ids]) => (
              <button
                key={cName}
                type="button"
                title={`Öppna alla ${ids.length} noder i ${cName} som en 2×2 Konsole Split-View`}
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('sshs3:open-cluster-split', {
                      detail: { cluster: cName, serverIds: ids, layout: 'grid' },
                    })
                  )
                }
                className="inline-flex items-center gap-1 rounded-md border border-indigo-500/40 bg-indigo-500/15 px-2.5 py-1 text-2xs font-medium text-indigo-300 hover:bg-indigo-500/25 transition-colors"
              >
                <span>🧩 {cName}</span>
                <span className="opacity-70">({ids.length})</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('sshs3:ai-open', {
                    detail: { view: 'Work', mode: 'panel' },
                  })
                )
              }
              className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/15 px-2.5 py-1 text-2xs font-medium text-sky-300 hover:bg-sky-500/25 transition-colors"
            >
              <span>✨ Fråga AI Hub</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
