/** TLS errors that mean "the chain does not end in a root this computer trusts"; a root fingerprint or CA file can fix these. */
const UNTRUSTED_ROOT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

/**
 * A message for a failed TLS handshake, or undefined if `err` is not a certificate error. Only a missing trust anchor
 * gets `untrustedMessage` (which sends the user to the root CA); an expired certificate or a host name that the
 * certificate does not cover cannot be fixed that way and gets its own message.
 */
export function certErrorMessage(err: unknown, untrustedMessage: string): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code !== 'string') return undefined;
  if (UNTRUSTED_ROOT_CODES.has(code)) return untrustedMessage;
  if (code === 'CERT_HAS_EXPIRED') return "The server's certificate has expired. Ask the administrator to renew it.";
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return "The server's certificate is not valid for this host name. Use the host name the certificate was issued for.";
  }
  return undefined;
}
