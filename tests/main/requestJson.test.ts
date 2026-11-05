import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { requestJson } from '../../src/main/oauth/requestJson';

describe('requestJson cancellation', () => {
  let server: http.Server | undefined;
  let hits = 0;
  let closedByClient = false;

  async function startServer(handler: http.RequestListener): Promise<string> {
    hits = 0;
    closedByClient = false;
    server = http.createServer((req, res) => {
      hits++;
      req.on('close', () => {
        closedByClient = true;
      });
      handler(req, res);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
  }

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it('aborts an in-flight request and tears the connection down', async () => {
    const url = await startServer(() => {
      /* never answers */
    });
    const controller = new AbortController();

    const pending = requestJson(url, { method: 'GET', timeoutMs: 10_000, allowHttp: true, signal: controller.signal });
    for (let i = 0; i < 100 && hits === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(hits).toBe(1);
    controller.abort();

    await expect(pending).rejects.toThrow('Request was cancelled');
    for (let i = 0; i < 100 && !closedByClient; i++) await new Promise((r) => setTimeout(r, 10));
    expect(closedByClient).toBe(true);
  });

  it('never sends a request whose signal is already aborted', async () => {
    const url = await startServer((_req, res) => {
      res.end('{}');
    });
    const controller = new AbortController();
    controller.abort();

    await expect(requestJson(url, { method: 'GET', timeoutMs: 5_000, allowHttp: true, signal: controller.signal })).rejects.toThrow(
      'Request was cancelled'
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(hits).toBe(0);
  });

  it('still reports ordinary network failures with the host', async () => {
    await expect(requestJson('http://127.0.0.1:1/x', { method: 'GET', timeoutMs: 2_000, allowHttp: true })).rejects.toThrow(
      /Could not reach 127\.0\.0\.1:1/
    );
  });
});
