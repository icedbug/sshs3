import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import https from 'node:https';
import { EventEmitter } from 'node:events';

const { getCAs, getMerged } = vi.hoisted(() => ({
  getCAs: vi.fn<() => string[]>(),
  getMerged: vi.fn<() => string[]>(),
}));
vi.mock('../../src/main/crypto/SystemTrustStore', () => ({
  SystemTrustStore: { getCAs, getMergedRootCertificates: getMerged },
}));

type RequestJson = typeof import('../../src/main/oauth/requestJson').requestJson;

/** A fresh copy of the module, so the roots it caches do not leak between tests. */
async function loadRequestJson(): Promise<RequestJson> {
  vi.resetModules();
  return (await import('../../src/main/oauth/requestJson')).requestJson;
}

/** Replaces https.request with a stub that records the options of every call and answers `{}`. */
function stubHttps(): { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  vi.spyOn(https, 'request').mockImplementation(((_url: unknown, options: Record<string, unknown>, cb: (res: unknown) => void) => {
    calls.push(options);
    const req = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn(), end: () => {
      const res = Object.assign(new EventEmitter(), { statusCode: 200 });
      cb(res);
      res.emit('data', Buffer.from('{}'));
      res.emit('end');
    } });
    return req;
  }) as never);
  return { calls };
}

describe('requestJson trust roots', () => {
  beforeEach(() => {
    getCAs.mockReturnValue(['OS-ROOT']);
    getMerged.mockReturnValue(['MOZILLA-ROOT', 'OS-ROOT']);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    getCAs.mockReset();
    getMerged.mockReset();
  });

  it('verifies against Node roots plus the OS trust store when the caller names no CA', async () => {
    const requestJson = await loadRequestJson();
    const stub = stubHttps();
    await requestJson('https://ca.example.com/x', { method: 'GET', timeoutMs: 1000 });
    expect(stub.calls[0].ca).toEqual(['MOZILLA-ROOT', 'OS-ROOT']);
    expect(stub.calls[0].rejectUnauthorized).toBe(true);
  });

  it('builds the merged list once, not on every request', async () => {
    const requestJson = await loadRequestJson();
    const stub = stubHttps();
    for (let i = 0; i < 3; i++) await requestJson('https://ca.example.com/x', { method: 'GET', timeoutMs: 1000 });
    expect(getMerged).toHaveBeenCalledTimes(1);
    expect(stub.calls[2].ca).toBe(stub.calls[0].ca);
  });

  it('does not touch the roots when certificate verification is switched off', async () => {
    const requestJson = await loadRequestJson();
    const stub = stubHttps();
    await requestJson('https://ca.example.com/x', { method: 'GET', timeoutMs: 1000, insecureSkipTlsVerify: true });
    expect(stub.calls[0].ca).toBeUndefined();
    expect(stub.calls[0].rejectUnauthorized).toBe(false);
    expect(getMerged).not.toHaveBeenCalled();
  });

  it('lets an explicit CA replace the defaults', async () => {
    const requestJson = await loadRequestJson();
    const stub = stubHttps();
    await requestJson('https://ca.example.com/x', { method: 'GET', timeoutMs: 1000, ca: 'PINNED' });
    expect(stub.calls[0].ca).toBe('PINNED');
    expect(getMerged).not.toHaveBeenCalled();
  });

  it('keeps Node defaults when the OS store could not be read', async () => {
    getCAs.mockReturnValue([]);
    const requestJson = await loadRequestJson();
    const stub = stubHttps();
    await requestJson('https://ca.example.com/x', { method: 'GET', timeoutMs: 1000 });
    expect(stub.calls[0].ca).toBeUndefined();
    expect(getMerged).not.toHaveBeenCalled();
  });
});
