/**
 * The tooltip of a link: where it really goes, after the title its author gave it (`[text](url "title")`)
 * when there is one, so that the destination is never hidden behind the author's own words.
 */
export function linkTitle(authorTitle: string | undefined, destination: string | undefined): string | undefined {
  const title = authorTitle?.trim();
  if (title && destination) return `${title} (${destination})`;
  return title || destination || undefined;
}

/**
 * The address a link of the markdown preview may open in the system browser, or null when it must not
 * be opened at all (relative links, `#anchors`, `mailto:`, `javascript:`, `file:`, `data:` …).
 *
 * The file being previewed is not trusted: it may live on a server, so only absolute http(s) addresses
 * are accepted, and not ones with a user name or password in them, because
 * `https://github.com@evil.example/` shows a trusted name in front of an untrusted host.
 */
export function externalLinkTarget(href: string | undefined): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return null; // relative or malformed
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  // The normalised form (lower-case scheme and host, escaped spaces) is what the main process checks and opens.
  return url.href;
}
