import { atom } from 'nanostores';
import { registry } from '@/contrib/registry';
import { $sshs3Compact, $sshs3Tools } from '@/sshs3-presentation';
import { TitlebarIcon } from '@/app/shell/titlebar-icon';

interface ShellState { mode: 'closed' | 'panel' | 'full'; width: number }
interface ShellBridge { get(): Promise<ShellState>; set(update: Partial<ShellState>): Promise<ShellState>; onChange(listener: (state: ShellState) => void): () => void }
const bridge = (window as Window & { sshs3Shell?: ShellBridge & import('@/sshs3-shared/nativeHermes').NativeHermesApi }).sshs3Shell;
const state = atom<ShellState>({ mode: 'full', width: 380 });
const style = document.createElement('style');
style.textContent = `
html[data-sshs3-mode=panel] #root{width:100%!important;margin:0!important}
html[data-sshs3-mode=panel] [data-slot=sidebar-wrapper],html[data-sshs3-mode=panel] [data-contrib-shell]{width:100%!important}
html[data-sshs3-mode=closed] #root{visibility:hidden}
#sshs3-chat-divider{position:fixed;left:0;top:0;bottom:0;width:6px;padding:0;border:0;background:transparent;cursor:col-resize;z-index:999;touch-action:none}
#sshs3-chat-divider:hover{background:var(--ui-accent)}
html:not([data-sshs3-mode=panel]) #sshs3-chat-divider{display:none}
`;
document.head.append(style);

function present(next: ShellState) {
  state.set(next);
  $sshs3Compact.set(next.mode === 'panel');
  document.documentElement.dataset.sshs3Mode = next.mode;
  document.documentElement.style.setProperty('--sshs3-chat-width', `${next.width}px`);
  publishControls();
}

function publishControls() {
  if (!bridge) return;
  const panel = state.get().mode === 'panel';
  // The native right cluster is reserved for fixed Hermes controls. Its pane
  // tools occupy that same slot outside preview routes, so use the extension
  // group at the left edge to keep our control visible and clickable.
  registry.register({ id: 'sshs3-shell', area: 'titleBar.tools.left', source: 'sshs3', order: 110,
    data: { id: 'sshs3-shell', label: panel ? 'Expand Hermes' : 'Return to terminal',
      icon: <TitlebarIcon name={panel ? 'screen-full' : 'layout-sidebar-right'} />,
      onSelect: () => void bridge.set({ mode: panel ? 'full' : 'panel' }),
    },
  });
}

if (bridge) {
  const divider = document.createElement('button');
  divider.id = 'sshs3-chat-divider';
  divider.setAttribute('aria-label', 'Resize AI chat');
  document.body.append(divider);
  let startWidth = 380;
  let startX = 0;
  divider.onpointerdown = event => { startWidth = state.get().width; startX = event.screenX; divider.setPointerCapture(event.pointerId); };
  let queuedWidth: number | undefined;
  let frame = 0;
  const resize = () => { frame = 0; if (queuedWidth !== undefined) void bridge.set({ width: queuedWidth }); };
  divider.onpointermove = event => {
    if (!divider.hasPointerCapture(event.pointerId)) return;
    queuedWidth = Math.max(280, Math.min(640, startWidth + startX - event.screenX));
    if (!frame) frame = requestAnimationFrame(resize);
  };
  divider.onpointerup = event => divider.releasePointerCapture(event.pointerId);
  divider.onkeydown = event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    void bridge.set({ width: state.get().width + (event.key === 'ArrowLeft' ? 20 : -20) });
  };
  bridge.onChange(present);
  bridge.onToolsChanged(snapshot => $sshs3Tools.set(snapshot));
  void bridge.tools().then(snapshot => $sshs3Tools.set(snapshot));
  void bridge.get().then(present);
  // Original full-window dialogs must not be hidden beneath the terminal overlay.
  let openingFullSurface = false;
  const revealFullSurface = () => {
    if (openingFullSurface || state.get().mode !== 'panel' ||
      !document.querySelector('.sshs3-full-surface,[data-slot="dialog-overlay"][data-state="open"]')) return;
    openingFullSurface = true;
    void bridge.set({ mode: 'full' }).finally(() => { openingFullSurface = false; });
  };
  new MutationObserver(revealFullSurface).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] });
  revealFullSurface();
  window.addEventListener('hashchange', () => {
    if (state.get().mode === 'panel' && /#\/(settings|capabilities|messaging|cron|profiles|artifacts)/.test(location.hash)) {
      void bridge.set({ mode: 'full' });
    }
  });
}
