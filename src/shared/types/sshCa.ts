export type SshCaBackendType = 'step-ca' | 'vault';
export type SshCaKeySource = 'ephemeral' | 'piv';

export interface SshCaConfig {
  id: string;
  name: string;
  backend: SshCaBackendType;
  caUrl: string;
  /** Custom root CA certificate in PEM format or fingerprint, used to verify private CA certificates. */
  rootCaCert?: string;
  oidcIssuerUrl: string;
  oidcClientId: string;
  keySource: SshCaKeySource;
  defaultPrincipals?: string[];
  /** Vault / OpenBao auth method mount path. Defaults to 'jwt'. */
  vaultAuthPath?: string;
  /** Vault / OpenBao auth role name for JWT/OIDC authentication. Defaults to 'default'. */
  vaultRole?: string;
  /** Vault / OpenBao SSH secrets engine mount path. Defaults to 'ssh'. */
  vaultSshMount?: string;
  /** Vault / OpenBao SSH secrets engine role name for signing user keys. Defaults to 'client' or vaultRole. */
  vaultSshRole?: string;
  /** Optional Vault namespace (for Vault Enterprise / HCP Vault). */
  vaultNamespace?: string;
}

export interface SshCaCertificateInfo {
  certType: 'user' | 'host';
  keyId: string;
  principals: string[];
  validAfter: string;
  validBefore: string;
  serial: string;
  signatureKeyFingerprint: string;
  publicKeyFingerprint: string;
}

export interface SshCaStatus {
  active: boolean;
  configId?: string;
  username?: string;
  principals?: string[];
  expiresAt?: string;
  validSecondsRemaining?: number;
  certInfo?: SshCaCertificateInfo;
  certificateFilePath?: string;
  error?: string;
}

export interface SshCaSignRequest {
  /** The OpenSSH public key wire bytes encoded in standard base64 (field 2 of an OpenSSH .pub line). */
  publicKeyWireBase64: string;
  /** OpenSSH key type, e.g. 'ssh-ed25519' or 'ssh-rsa'. */
  keyType: string;
  /** Raw OpenSSH single-line public key representation, e.g. 'ssh-ed25519 AAA...'. */
  publicKeyLine: string;
  /** OIDC identity token (JWT); never logged, never persisted. */
  identityToken: string;
  /** Authenticated user identity (e.g. email or username). */
  username: string;
  /** Requested principals (the CA may grant a subset or superset). */
  principals?: string[];
}

export interface SshCaSignResponse {
  /** The base64-encoded OpenSSH certificate wire bytes (same format Step-CA returns as `crt`). */
  certificateWireBase64: string;
  /** The complete OpenSSH single-line certificate string, e.g. 'ssh-ed25519-cert-v01@openssh.com AAA... comment'. */
  certificateLine: string;
}

export interface ISshCaProvider {
  readonly id: SshCaBackendType;
  sign(request: SshCaSignRequest, config: SshCaConfig, signal: AbortSignal): Promise<SshCaSignResponse>;
}

/** Input to "Detect": the CA to ask, and the root CA fingerprint the user trusts (optional). */
export interface SshCaDetectRequest {
  caUrl: string;
  /** SHA-256 fingerprint of the root CA certificate (hex, as `step certificate fingerprint` prints it). */
  rootFingerprint?: string;
  /** Custom root CA in PEM form, if the user has already entered one. */
  rootCaCert?: string;
}

export interface SshCaDetectedProvisioner {
  name: string;
  clientId: string;
  /** The OIDC issuer URL: the provisioner's configuration endpoint without `/.well-known/openid-configuration`. */
  issuerUrl: string;
}

export interface SshCaDetectedRoot {
  /** The root certificate in PEM form, only returned after it matched the fingerprint. */
  pem: string;
  subject: string;
  /** ISO 8601. */
  validTo: string;
  /** SHA-256, lowercase hex. */
  fingerprint: string;
}

export interface SshCaDetectResult {
  provisioners: SshCaDetectedProvisioner[];
  /** Set when the root certificate was fetched and verified against the given fingerprint. */
  root?: SshCaDetectedRoot;
}

/** Input to "Detect" for Vault / OpenBao. */
export interface SshCaVaultDetectRequest {
  caUrl: string;
  /** Optional Vault namespace (sent as `X-Vault-Namespace`). */
  namespace?: string;
  /** Custom root CA in PEM form, if the server uses a private one. */
  rootCaCert?: string;
}

export interface SshCaDetectedSshMount {
  /** Mount path without slashes, e.g. `ssh` or `ssh-client-signer`. */
  mount: string;
  keyType: string;
  /** OpenSSH-style `SHA256:...` fingerprint of the CA's public key. */
  fingerprint: string;
}

export interface SshCaDetectedAuthMount {
  mount: string;
  type: 'jwt' | 'oidc';
}

export interface SshCaVaultDetectResult {
  /** Server version, when the server does not redact it. */
  version?: string;
  sshMounts: SshCaDetectedSshMount[];
  /** Only mounts the server lists without a token (`listing_visibility=unauth`). */
  authMounts: SshCaDetectedAuthMount[];
}

/** Part of the Detect error shown when the server's certificate is not trusted; the UI uses it to offer the next step. */
export const SSH_CA_UNTRUSTED_MARKER = 'is not trusted by this computer';
