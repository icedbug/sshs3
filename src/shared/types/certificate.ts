/** Validity of a certificate's dates. Says nothing about trust: the chain and revocation are not checked. */
export type CertificateValidity = 'valid' | 'expiring' | 'expired' | 'not-yet-valid';

/** Human-readable facts about one X.509 certificate. Never contains raw certificate or key text. */
export interface CertificateInfo {
  subject: string;
  issuer: string;
  serialNumber: string;
  /** ISO 8601, or undefined when the date could not be read. */
  notBefore?: string;
  notAfter?: string;
  validity: CertificateValidity;
  /** Whole days until `notAfter` (negative once expired); undefined when `notAfter` is unknown. */
  daysLeft?: number;
  /** Subject Alternative Names such as `DNS:example.com`, at most `maxSans` of them. */
  sans: string[];
  /** SANs left out of `sans`. */
  moreSans: number;
  /** E.g. `RSA 2048`, `EC P-256`, `Ed25519`. */
  publicKey: string;
  /** E.g. `SHA-256 with RSA`; the dotted OID when unknown. */
  signatureAlgorithm?: string;
  /** The signature uses SHA-1 or MD5. */
  weakSignature: boolean;
  isCa: boolean;
  selfSigned: boolean;
  /** Key Usage bits that are set, e.g. `digitalSignature`, `keyCertSign`. */
  keyUsage: string[];
  /** Extended Key Usage names, e.g. `serverAuth`. */
  extendedKeyUsage: string[];
  /** Basic Constraints pathLenConstraint, when set. */
  pathLength?: number;
  /** Where revocation is checked and the issuer can be fetched (shown as text; never opened). */
  ocspUrls: string[];
  caIssuerUrls: string[];
  crlUrls: string[];
  /** `AA:BB:…` SHA-256 of the DER encoding. */
  sha256: string;
  /** `AA:BB:…` SHA-1 of the DER encoding (what Windows and many appliances show). */
  sha1: string;
  /** Base64 SHA-256 of the public key (SubjectPublicKeyInfo), as used in `pin-sha256` pins. */
  spkiSha256: string;
  /** The certificate alone as PEM, for copying one certificate out of a bundle. */
  pem: string;
  /** Only when a host name was checked: whether this certificate is valid for it (SAN, else CN). */
  hostMatch?: boolean;
}

/**
 * How the certificates of a bundle relate, as listed. A relationship between the certificates only:
 * says nothing about whether the top is trusted.
 */
export type CertificateChainStatus =
  /** Each certificate is issued by the next one. */
  | 'ordered'
  /** The certificates form a chain, but not in leaf-to-root order. */
  | 'out-of-order'
  /** At least one certificate is not issued by any other in the file. */
  | 'broken';

export interface CertificateChainInfo {
  status: CertificateChainStatus;
  /** The last listed certificate is self-signed (a root). Only known when every certificate is shown. */
  endsWithRoot?: boolean;
}

export type CertificatePreviewError =
  /** The file holds no certificate (or the name says it is not one). */
  | 'none'
  /** Larger than the preview reads; never parsed partially. */
  | 'too-large'
  /** Could not be read or parsed. */
  | 'unreadable';

export interface CertificatePreviewResult {
  certs: CertificateInfo[];
  /** Certificates in the file beyond `certs`. */
  moreCerts: number;
  /** Certificates that could not be parsed and are left out of `certs` (the chain is then not judged). */
  unreadableCerts?: number;
  /** Present when the file holds more than one certificate. */
  chain?: CertificateChainInfo;
  /** The host name the certificates were checked against, when one was given. */
  checkedHost?: string;
  error?: CertificatePreviewError;
}
