import React from 'react';
import type { CertificateInfo, CertificatePreviewResult } from '../../../shared/types/certificate';
import { describeChainStatus, describeValidity, type CertificateTone } from '../lib/certificatePreview';
import { classNames } from '../lib/format';
import { formatDateTime } from '../lib/dateFormat';
import { CopyValueButton } from './CopyValueButton';

const TONE_STYLES: Record<CertificateTone, string> = {
  ok: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  warn: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  bad: 'bg-red-500/15 text-red-200 ring-red-500/30',
};

const Row: React.FC<{ label: string; children: React.ReactNode; title?: string; copy?: { value: string; label: string } }> = ({
  label,
  children,
  title,
  copy,
}) => (
  <div className="flex gap-2 text-[11px] leading-relaxed">
    <span className="w-[4.75rem] shrink-0 text-txt-muted">{label}</span>
    <span className="min-w-0 flex-1 break-words text-txt-primary" title={title}>
      {children}
      {copy && <CopyValueButton value={copy.value} label={copy.label} />}
    </span>
  </div>
);

const Tag: React.FC<{ children: React.ReactNode; warn?: boolean }> = ({ children, warn }) => (
  <span
    className={classNames(
      'rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ring-1 ring-inset',
      warn ? TONE_STYLES.warn : 'bg-app-surface-hover text-txt-secondary ring-border-subtle'
    )}
  >
    {children}
  </span>
);

const Mono: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="font-mono text-[10px]">{children}</span>
);

const CertificateBlock: React.FC<{ cert: CertificateInfo; detailed: boolean; full: boolean; host?: string }> = ({
  cert,
  detailed,
  full,
  host,
}) => {
  const validity = describeValidity(cert);
  const sans = cert.moreSans > 0 ? [...cert.sans, `+${cert.moreSans} more`] : cert.sans;
  return (
    <div className="space-y-0.5" data-testid="certificate-block">
      <div className="mb-1 flex flex-wrap items-center gap-1">
        <span
          className={classNames(
            'rounded px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset',
            TONE_STYLES[validity.tone]
          )}
        >
          {validity.label}
        </span>
        {cert.isCa && <Tag>CA</Tag>}
        {cert.selfSigned && <Tag>Self-signed</Tag>}
        {cert.weakSignature && <Tag warn>Weak signature</Tag>}
        {host && cert.hostMatch !== undefined && (
          <span
            className={classNames(
              'rounded px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset',
              TONE_STYLES[cert.hostMatch ? 'ok' : 'bad']
            )}
          >
            {cert.hostMatch ? `Valid for ${host}` : `Not valid for ${host}`}
          </span>
        )}
      </div>
      <Row label="Subject" copy={full ? { value: cert.subject, label: 'subject' } : undefined}>
        {cert.subject || '—'}
      </Row>
      <Row label="Issuer">{cert.issuer || '—'}</Row>
      <Row label="Valid">
        {formatDateTime(cert.notBefore)} → {formatDateTime(cert.notAfter)}
      </Row>
      {sans.length > 0 && <Row label="SAN">{sans.join(', ')}</Row>}
      <Row label="Key">{[cert.publicKey, cert.signatureAlgorithm].filter(Boolean).join(' · ')}</Row>
      {full && cert.keyUsage.length > 0 && <Row label="Key usage">{cert.keyUsage.join(', ')}</Row>}
      {detailed && cert.extendedKeyUsage.length > 0 && <Row label="Usage">{cert.extendedKeyUsage.join(', ')}</Row>}
      {full && cert.isCa && (
        <Row label="Path length">{cert.pathLength === undefined ? 'Unlimited' : String(cert.pathLength)}</Row>
      )}
      {detailed && (
        <Row label="Serial" copy={full ? { value: cert.serialNumber, label: 'serial number' } : undefined}>
          {cert.serialNumber}
        </Row>
      )}
      {detailed && (
        <Row label="SHA-256" title={cert.sha256} copy={full ? { value: cert.sha256, label: 'SHA-256 fingerprint' } : undefined}>
          <Mono>{cert.sha256}</Mono>
        </Row>
      )}
      {full && (
        <>
          <Row label="SHA-1" title={cert.sha1} copy={{ value: cert.sha1, label: 'SHA-1 fingerprint' }}>
            <Mono>{cert.sha1}</Mono>
          </Row>
          <Row label="Key pin" title="Base64 SHA-256 of the public key (pin-sha256)" copy={{ value: cert.spkiSha256, label: 'public key pin' }}>
            <Mono>{cert.spkiSha256}</Mono>
          </Row>
          {cert.ocspUrls.length > 0 && <Row label="OCSP">{cert.ocspUrls.join(', ')}</Row>}
          {cert.caIssuerUrls.length > 0 && <Row label="CA issuer">{cert.caIssuerUrls.join(', ')}</Row>}
          {cert.crlUrls.length > 0 && <Row label="CRL">{cert.crlUrls.join(', ')}</Row>}
          <Row label="PEM" copy={{ value: cert.pem, label: 'certificate as PEM' }}>
            <span className="text-txt-muted">Copy this certificate alone</span>
          </Row>
        </>
      )}
    </div>
  );
};

/**
 * Human-readable view of the certificates in a file. The compact form (hover card) shows the summary;
 * `full` (the file manager dialog) adds key usage, revocation URLs, extra fingerprints and copy buttons.
 */
export const CertificatePreview: React.FC<{ result: CertificatePreviewResult; full?: boolean }> = ({
  result,
  full = false,
}) => {
  const { certs, moreCerts, chain, checkedHost, unreadableCerts } = result;
  const detailed = certs.length === 1;
  const chainLine = full && chain ? describeChainStatus(chain) : undefined;
  return (
    <div
      data-testid="certificate-preview"
      className="my-2.5 space-y-2 overflow-hidden rounded-xl border border-border-subtle bg-app-surface-subtle p-2 select-text"
    >
      {unreadableCerts !== undefined && unreadableCerts > 0 && (
        <div role="note" className={classNames('rounded-lg px-2 py-1 text-[10px] ring-1 ring-inset', TONE_STYLES.warn)}>
          {unreadableCerts} certificate{unreadableCerts === 1 ? '' : 's'} in this file could not be read and {unreadableCerts === 1 ? 'is' : 'are'} not shown.
        </div>
      )}
      {certs.length > 1 && (
        <div className="space-y-1 text-[10px] text-txt-muted">
          <div>
            {certs.length + moreCerts} certificates{moreCerts > 0 ? ` (first ${certs.length} shown)` : ''}
          </div>
          {chainLine && (
            <div
              data-testid="certificate-chain"
              className={classNames('rounded-lg px-2 py-1 ring-1 ring-inset', TONE_STYLES[chainLine.tone])}
            >
              {chainLine.label}
            </div>
          )}
        </div>
      )}
      {certs.map((cert, index) => (
        <div key={`${index}-${cert.sha256}`} className="border-t border-divider pt-2 first:border-t-0 first:pt-0">
          <CertificateBlock cert={cert} detailed={detailed || full} full={full} host={checkedHost} />
        </div>
      ))}
    </div>
  );
};
