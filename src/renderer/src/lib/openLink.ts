import type { MouseEvent } from 'react';
import { isWebBrowserMode } from './webClientBridge';

/**
 * The address a link may open outside the app: a web address (http, https) or a mail address
 * (mailto). Anything else, such as a file, a script or another program's own scheme, is not opened.
 */
export function safeLinkTarget(url: string | undefined | null): string | undefined {
  const text = (url ?? '').trim();
  if (!text) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return undefined; // relative or malformed
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') return undefined;
  return text;
}

/**
 * Opens a web or mail link outside the app, the way each platform can: the desktop app hands it to the
 * system (its browser, its mail program), and in a browser it opens in a new tab. The one way to open a
 * link from the app's own pages: the desktop window opens no windows itself, and the web server has no
 * browser to open anything in. Returns whether the link was handed on.
 */
export function openLink(url: string | undefined | null): boolean {
  const target = safeLinkTarget(url);
  if (!target) return false;
  const viaApp = isWebBrowserMode() || target.startsWith('mailto:') ? undefined : window.multissh?.openExternal;
  if (viaApp) {
    // A refused or failed open has nothing to show here; it must not become an unhandled rejection.
    void Promise.resolve(window.multissh.openExternal(target)).catch(() => {});
    return true;
  }
  // A browser opens a new tab. The desktop window refuses the new window and hands the address to the
  // system instead (windows/createAppWindow.ts).
  window.open(target, '_blank', 'noopener,noreferrer');
  return true;
}

/** What a link to another site carries: where it goes as its tooltip, and a click that opens it with `openLink`. */
export function externalLinkProps(url: string | undefined | null): {
  href: string | undefined;
  target: '_blank';
  rel: string;
  title: string | undefined;
  onClick: (event: MouseEvent) => void;
} {
  const href = url ?? undefined;
  return {
    href,
    target: '_blank',
    rel: 'noreferrer noopener',
    title: href,
    onClick: (event) => {
      // The page itself never follows the link: it would leave the app, or do nothing on the desktop.
      event.preventDefault();
      openLink(href);
    },
  };
}
