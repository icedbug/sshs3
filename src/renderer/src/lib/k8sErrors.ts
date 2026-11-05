import { ELECTRON_IPC_PREFIX } from './format';

/** Known technical failure substrings mapped to actionable, user-facing text. */
export const KNOWN_ERROR_HINTS: Array<{ match: RegExp; hint: string }> = [
  {
    match: /HTTP protocol is not allowed when skipTLSVerify is not set or false/i,
    hint:
      "This cluster's API server uses plain HTTP. Enable \"Skip TLS verification\" for this context, or update your kubeconfig to use an HTTPS endpoint.",
  },
  {
    match: /ECONNREFUSED/,
    hint:
      "Connection refused — the cluster's API server is unreachable at this address. Check that any required port-forward, VPN or proxy is running.",
  },
  {
    match: /ENOTFOUND|EAI_AGAIN/,
    hint: "Host not found — check the cluster's API server address in your kubeconfig.",
  },
  {
    match: /certificate|x509|self[- ]signed/i,
    hint:
      'TLS certificate problem — this app does not trust the certificate presented by the cluster. Check your kubeconfig\'s certificate authority, or enable "Skip TLS verification" if you trust this cluster.',
  },
  {
    match: /\b401\b|unauthorized/i,
    hint: 'Not authorized — your credentials for this context have expired or are invalid. Try logging in again.',
  },
];

/**
 * The k8s client wraps connection failures in a bare `TypeError: fetch failed`
 * with the actual reason (e.g. ECONNREFUSED) nested in `.cause`. Walk the
 * chain, strip Electron's internal IPC error prefix, and map known causes to
 * actionable text instead of showing raw system errors (UX review #12).
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [err.message];
  let cause: unknown = (err as { cause?: unknown }).cause;
  while (cause instanceof Error) {
    parts.push(cause.message);
    cause = (cause as { cause?: unknown }).cause;
  }
  const raw = parts.join(' — caused by: ').replace(ELECTRON_IPC_PREFIX, '');
  const known = KNOWN_ERROR_HINTS.find((h) => h.match.test(raw));
  return known ? known.hint : raw;
}
