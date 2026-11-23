import { useCallback, useRef } from 'react';
import { useOptionalConfirm } from '../components/ConfirmDialog';
import { openLink, safeLinkTarget } from './openLink';

/**
 * Opens a link whose address the terminal does not show. A program can print a hyperlink (OSC 8) with
 * any text over any address, so the address is shown and asked about before anything is opened.
 */
export function useOpenHiddenLink(): (url: string) => void {
  const confirm = useOptionalConfirm();
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  return useCallback((url: string) => {
    const target = safeLinkTarget(url);
    if (!target) return;
    const ask = confirmRef.current;
    const answer = ask
      ? ask({
          title: 'Open this link?',
          message: (
            <>
              <span className="block break-all font-mono text-txt-primary" data-testid="hidden-link-target">
                {target}
              </span>
              <span className="mt-1 block">The text in the terminal can say something else than where the link goes.</span>
            </>
          ),
          confirmLabel: 'Open link',
          danger: false,
        })
      : // Outside the app's own dialogs (a part drawn on its own) the browser's question is used.
        Promise.resolve(window.confirm(`Open this link?\n\n${target}`));
    void answer.then((yes) => {
      if (yes) openLink(target);
    });
  }, []);
}
