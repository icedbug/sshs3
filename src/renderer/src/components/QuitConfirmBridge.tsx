import { useEffect } from 'react';
import type { QuitConfirmPromptEvent } from '@shared/types/ipc';
import { useConfirm } from './ConfirmDialog';
import { plural } from '../lib/plural';

/**
 * UX audit finding #2: quitting used to pop a native `dialog.showMessageBoxSync`
 * box — the one confirmation in the app that didn't look or behave like the
 * rest (no default-focused Cancel, no themed styling). The main process now
 * asks over IPC instead of showing that box itself; this component is the
 * renderer side of that request, rendering the same `ConfirmDialog` used for
 * every other confirmation (delete a profile, delete a folder, ...).
 */
export const QuitConfirmBridge: React.FC = () => {
  const confirm = useConfirm();

  useEffect(() => {
    if (!window.multissh?.onQuitConfirmPrompt) return;

    const unsubscribe = window.multissh.onQuitConfirmPrompt((event: QuitConfirmPromptEvent) => {
      void (async () => {
        const proceed =
          event.kind === 'close-window'
            ? await confirm({
                title: 'Close this window?',
                message: `${plural(event.sessionCount ?? 0, 'open session')} in this window will be closed.`,
                confirmLabel: 'Close Window',
                cancelLabel: 'Cancel',
                danger: true,
              })
            : event.kind === 'active-transfers'
            ? await confirm({
                title: 'Transfers in progress',
                message: `${plural(event.activeTransferCount ?? 0, 'file transfer')} in progress. If you quit now, they will be cancelled and files may be left incomplete.`,
                confirmLabel: 'Quit Anyway',
                cancelLabel: 'Cancel',
                danger: true,
              })
            : await confirm({
                title: 'Quit sshs3?',
                message: 'Any open SSH sessions and tunnels will be closed.',
                confirmLabel: 'Quit',
                cancelLabel: 'Cancel',
                danger: false,
              });
        await window.multissh.respondQuitConfirm(event.id, proceed);
      })();
    });

    return () => {
      unsubscribe();
    };
  }, [confirm]);

  return null;
};
