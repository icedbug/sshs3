import { useEffect, useState } from 'react';
import { isCertificateFileName } from '../../../shared/certificateFileName';
import type { CertificatePreviewResult } from '../../../shared/types/certificate';

export interface CertificatePreviewState {
  /** The certificates, once found; undefined when the file holds none or the lookup does not apply. */
  result: CertificatePreviewResult | undefined;
  /** The lookup applies to this file and has not answered yet. */
  pending: boolean;
}

/**
 * Loads the certificate facts for a hovered file. The main process reads and parses the file, so nothing
 * but those facts reaches the renderer (a .pem often holds a private key too). Only files named like a
 * certificate are looked at. `pending` lets the caller wait before reading the same file as text, so it is
 * not fetched twice.
 */
export function useCertificatePreview(
  providerId: string | undefined,
  filePath: string,
  enabled: boolean
): CertificatePreviewState {
  const [answer, setAnswer] = useState<{ key: string; result?: CertificatePreviewResult }>();
  const key = `${providerId}\0${filePath}`;
  const applicable =
    enabled && Boolean(providerId) && Boolean(window.multissh?.certificatePreview) && isCertificateFileName(filePath);

  useEffect(() => {
    if (!applicable || !providerId) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      window.multissh
        .certificatePreview(providerId, filePath)
        .then((res) => {
          if (!cancelled) setAnswer({ key, result: res.certs.length > 0 ? res : undefined });
        })
        .catch(() => {
          // No preview; the card shows what it always did.
          if (!cancelled) setAnswer({ key });
        });
    }, 40);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [applicable, providerId, filePath, key]);

  const settled = answer?.key === key;
  return { result: settled ? answer.result : undefined, pending: applicable && !settled };
}
