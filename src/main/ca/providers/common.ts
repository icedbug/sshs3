import type { SshCaConfig, SshCaSignRequest } from '../../../shared/types/sshCa';

/**
 * The configured root CA as a TLS `ca` option, or undefined when none is set. A blank value counts as
 * "not set": passing a whitespace-only `ca` to Node would replace the system roots with nothing and make
 * every TLS handshake fail.
 */
export function rootCaBuffer(config: Pick<SshCaConfig, 'rootCaCert'>): Buffer | undefined {
  const pem = config.rootCaCert?.trim();
  return pem ? Buffer.from(pem, 'utf8') : undefined;
}

/** Base URL of a CA as configured by the user: `https://` is assumed when there is no scheme, no trailing slashes. */
export function normalizeCaBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

/** `<type>-cert-v01@openssh.com <wire> sshs3-ca:<user>` for a CA that only returns the certificate blob. */
export function buildCertificateLine(
  request: Pick<SshCaSignRequest, 'keyType' | 'username'>,
  certificateWireBase64: string
): string {
  const certType = request.keyType.endsWith('-cert-v01@openssh.com')
    ? request.keyType
    : `${request.keyType}-cert-v01@openssh.com`;
  return `${certType} ${certificateWireBase64} sshs3-ca:${request.username}`;
}

export function throwIfCancelled(signal: AbortSignal | undefined, backendLabel: string): void {
  if (signal?.aborted) {
    throw new Error(`${backendLabel} request was cancelled`);
  }
}
