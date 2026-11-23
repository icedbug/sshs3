import React from 'react';
import { isWebBrowserMode } from '../../lib/webClientBridge';

/** The one line a control gets in the browser when it needs the person's own computer. */
export const DESKTOP_ONLY_NOTE = 'Only in the desktop app.';

/** Whether this is the web app, where what needs the person's own computer cannot work. */
export const desktopOnlyHere = (): boolean => isWebBrowserMode();

/**
 * Controls that work in the desktop app only: they open a port, a browser, a window or a card reader on
 * the computer the app runs on, and on a web server that computer is the server. In the desktop app
 * they are drawn as they are. In the browser they are drawn disabled, with one line that says why, so
 * nobody presses a button that can only answer with a refusal.
 */
export const DesktopOnly: React.FC<{
  children: React.ReactNode;
  /** Sits in a row of buttons: the line follows the controls on the same row. */
  inline?: boolean;
  className?: string;
  /** The spacing the controls had between them, kept inside the disabled group. */
  innerClassName?: string;
}> = ({ children, inline = false, className = '', innerClassName = '' }) => {
  if (!isWebBrowserMode()) return <>{children}</>;
  const Wrap = inline ? 'span' : 'div';
  return (
    <Wrap
      data-testid="desktop-only"
      className={`${inline ? 'inline-flex flex-wrap items-center gap-2' : 'flex flex-col gap-1.5'} ${className}`}
    >
      {!inline && (
        <span className="text-[11px] text-txt-muted" data-testid="desktop-only-note">
          {DESKTOP_ONLY_NOTE}
        </span>
      )}
      {/* A disabled fieldset switches off every button and field inside it. */}
      <fieldset
        disabled
        className={`pointer-events-none m-0 min-w-0 border-0 p-0 opacity-60 ${inline ? 'inline-flex items-center gap-2' : ''} ${innerClassName}`}
      >
        {children}
      </fieldset>
      {inline && (
        <span className="text-[11px] text-txt-muted" data-testid="desktop-only-note">
          {DESKTOP_ONLY_NOTE}
        </span>
      )}
    </Wrap>
  );
};
