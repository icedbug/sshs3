import React, { useEffect, useRef, useState } from 'react';
import { KeyRound } from 'lucide-react';

interface PresencePromptItem {
  id: string;
  sessionId?: string;
  message: string;
}

/**
 * Non-blocking banner shown while a smartcard/FIDO2 operation is waiting for
 * a physical touch on the key. Unlike SmartcardPinModal this never expects a
 * reply — OpenSSH isn't asking us for input here, it's just stuck until the
 * user touches the device — so the banner is purely informational and never
 * captures focus or blocks interaction with the rest of the app.
 */
export const TouchPresenceBanner: React.FC = () => {
  const [prompts, setPrompts] = useState<PresencePromptItem[]>([]);
  // Per-id fallback-timeout handles, tracked outside React state: a long-running operation (e.g.
  // Team Vault's PIN entry taking the user longer than 4s before the real touch moment) re-sends
  // the same prompt id to keep the banner alive — found via real-world use, the banner was
  // vanishing on the ORIGINAL 4s timer regardless, since nothing reset it on a repeat.
  const timeoutsRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (!window.multissh?.onPresencePrompt || !window.multissh?.onPresenceClear) return;

    const clearFallbackTimeout = (id: string) => {
      const existing = timeoutsRef.current.get(id);
      if (existing) {
        clearTimeout(existing);
        timeoutsRef.current.delete(id);
      }
    };

    const unsubscribePrompt = window.multissh.onPresencePrompt((event) => {
      setPrompts((prev) => (prev.some((p) => p.id === event.id) ? prev : [...prev, event]));
      clearFallbackTimeout(event.id);
      timeoutsRef.current.set(
        event.id,
        setTimeout(() => {
          timeoutsRef.current.delete(event.id);
          setPrompts((prev) => prev.filter((p) => p.id !== event.id));
        }, 4000)
      );
    });
    const unsubscribeClear = window.multissh.onPresenceClear(({ id, sessionId }) => {
      setPrompts((prev) => {
        const removed = prev.filter((p) => (id && p.id === id) || (sessionId && p.sessionId === sessionId));
        for (const p of removed) clearFallbackTimeout(p.id);
        return prev.filter((p) => !removed.includes(p));
      });
    });

    const timeouts = timeoutsRef.current;
    return () => {
      unsubscribePrompt();
      unsubscribeClear();
      for (const timeoutId of timeouts.values()) clearTimeout(timeoutId);
      timeouts.clear();
    };
  }, []);

  return (
    <>
      {/* Mounted before any prompt exists and only its text changes: a live region inserted together with its
          text is announced unreliably, one that is already in the page is. The visible banner below is not live. */}
      <div role="status" aria-live="polite" data-testid="touch-presence-announcer" className="sr-only">
        {prompts.map((prompt) => prompt.message).join(' ')}
      </div>
      {prompts.length > 0 && (
        <div
          data-testid="touch-presence-banner"
          className="fixed bottom-6 left-1/2 z-[110] flex -translate-x-1/2 flex-col gap-2"
        >
          {prompts.map((prompt) => (
            <div
              key={prompt.id}
              className="flex items-center gap-3 rounded-xl border border-sky-500/60 bg-app-card px-5 py-3 shadow-2xl ring-4 ring-sky-500/20 animate-in fade-in slide-in-from-bottom-2 duration-150"
            >
              <KeyRound className="h-6 w-6 shrink-0 animate-pulse text-sky-400" />
              <p className="text-base font-medium text-txt-primary">{prompt.message}</p>
            </div>
          ))}
        </div>
      )}
    </>
  );
};

export default TouchPresenceBanner;
