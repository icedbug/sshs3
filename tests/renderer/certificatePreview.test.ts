import { describe, it, expect } from 'vitest';
import { describeChainStatus, describeValidity } from '../../src/renderer/src/lib/certificatePreview';
import { isCertificateFileName } from '../../src/shared/certificateFileName';

describe('describeValidity', () => {
  it('words each state without claiming trust', () => {
    expect(describeValidity({ validity: 'valid', daysLeft: 82 })).toEqual({ label: 'Valid, 82 days left', tone: 'ok' });
    expect(describeValidity({ validity: 'valid', daysLeft: 1 }).label).toBe('Valid, 1 day left');
    expect(describeValidity({ validity: 'expiring', daysLeft: 3 })).toEqual({ label: 'Expires in 3 days', tone: 'warn' });
    expect(describeValidity({ validity: 'expiring', daysLeft: 0 }).label).toBe('Expires today');
    expect(describeValidity({ validity: 'expired', daysLeft: -10 })).toEqual({ label: 'Expired 10 days ago', tone: 'bad' });
    expect(describeValidity({ validity: 'expired', daysLeft: 0 }).label).toBe('Expired today');
    expect(describeValidity({ validity: 'not-yet-valid', notBefore: '2030-01-02T03:04:00Z' }).tone).toBe('bad');
  });
});

describe('isCertificateFileName', () => {
  it('matches certificate extensions case-insensitively, on any path style', () => {
    for (const p of ['/etc/ssl/a.crt', 'a.CER', 'C:\\certs\\site.Pem', '/x/tls.cert', '/x/ca.der']) {
      expect(isCertificateFileName(p)).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const p of ['/etc/passwd', '/x/server.key', '/x/crt', '/x/.crt', '/x/a.crt.bak', '/x/a.', '/x/dir/']) {
      expect(isCertificateFileName(p)).toBe(false);
    }
  });
});

describe('describeChainStatus', () => {
  it('words each chain state without calling the top trusted', () => {
    expect(describeChainStatus({ status: 'ordered', endsWithRoot: true })).toEqual({
      label: 'Each certificate is issued by the next, ending with a self-signed root.',
      tone: 'ok',
    });
    expect(describeChainStatus({ status: 'ordered', endsWithRoot: false }).label).toMatch(/root is not included/);
    expect(describeChainStatus({ status: 'ordered' }).label).toMatch(/shown is issued by the next/);
    expect(describeChainStatus({ status: 'out-of-order' }).tone).toBe('warn');
    expect(describeChainStatus({ status: 'broken' }).tone).toBe('bad');
  });
});
