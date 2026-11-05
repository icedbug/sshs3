import { describe, it, expect, vi } from 'vitest';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runProxyCli, readChunk } = require('../../src/main/proxy/proxyCli.cjs');

describe('proxyCli.cjs', () => {
  it('exits with code 1 and writes usage when arguments are missing or invalid', async () => {
    const stderrChunks: string[] = [];
    let exitCode: number | null = null;

    const streams = {
      stderr: {
        write: (str: string) => {
          stderrChunks.push(str);
          return true;
        },
      },
      exit: (code: number) => {
        exitCode = code;
      },
    };

    // Missing arguments
    runProxyCli(['http', '127.0.0.1'], {}, streams);
    expect(exitCode).toBe(1);
    expect(stderrChunks.join('')).toContain('Usage: proxyCli.cjs');

    // Invalid non-numeric port
    stderrChunks.length = 0;
    exitCode = null;
    runProxyCli(['http', '127.0.0.1', 'not-a-port', 'target.com', '22'], {}, streams);
    expect(exitCode).toBe(1);
    expect(stderrChunks.join('')).toContain('Usage: proxyCli.cjs');
  });

  it('exits with code 1 when connection to proxy host fails', async () => {
    const stderrChunks: string[] = [];
    let exitCode: number | null = null;

    const streams = {
      stderr: {
        write: (str: string) => {
          stderrChunks.push(str);
          return true;
        },
      },
      exit: (code: number) => {
        exitCode = code;
      },
    };

    // Connect to an unused high port that rejects connections
    const socket = runProxyCli(['http', '127.0.0.1', '59998', 'target.com', '22'], {}, streams);

    await new Promise<void>((resolve) => {
      socket.on('error', () => {
        setTimeout(resolve, 20);
      });
    });

    expect(exitCode).toBe(1);
    expect(stderrChunks.join('')).toContain('Proxy error:');
  });

  it('successfully handshakes with an HTTP proxy without auth', async () => {
    let receivedReq = '';
    const server = net.createServer((sock) => {
      sock.on('data', (d) => {
        receivedReq += d.toString('utf-8');
        if (receivedReq.includes('\r\n\r\n')) {
          sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = { write: vi.fn() };

    const socket = runProxyCli(
      ['http', '127.0.0.1', String(port), 'remote.host.internal', '22'],
      {},
      { stdin, stdout, stderr, exit: vi.fn() }
    );

    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        setTimeout(resolve, 50);
      });
    });

    expect(receivedReq).toContain('CONNECT remote.host.internal:22 HTTP/1.1');
    expect(receivedReq).not.toContain('Proxy-Authorization');

    // Test data piping
    const stdoutData: string[] = [];
    stdout.on('data', (c) => stdoutData.push(c.toString('utf-8')));

    socket.emit('data', Buffer.from('SSH-2.0-OpenSSH\r\n'));
    expect(stdoutData.join('')).toContain('SSH-2.0-OpenSSH');

    socket.destroy();
    server.close();
  });

  it('successfully handshakes with an HTTP proxy with basic auth and trailing buffer', async () => {
    let receivedReq = '';
    const server = net.createServer((sock) => {
      sock.on('data', (d) => {
        receivedReq += d.toString('utf-8');
        if (receivedReq.includes('\r\n\r\n')) {
          sock.write('HTTP/1.1 200 OK\r\n\r\nSSH-2.0-RemoteServer\r\n');
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = { write: vi.fn() };
    const stdoutChunks: string[] = [];
    stdout.on('data', (c) => stdoutChunks.push(c.toString('utf-8')));

    const socket = runProxyCli(
      ['http', '127.0.0.1', String(port), 'target.domain', '2222'],
      { SSHS3_PROXY_USERNAME: 'testuser', SSHS3_PROXY_PASSWORD: 'secretpassword' }, // pragma: allowlist secret
      { stdin, stdout, stderr, exit: vi.fn() }
    );

    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        setTimeout(resolve, 50);
      });
    });

    expect(receivedReq).toContain('CONNECT target.domain:2222 HTTP/1.1');
    const expectedAuth = Buffer.from('testuser:secretpassword').toString('base64');
    expect(receivedReq).toContain(`Proxy-Authorization: Basic ${expectedAuth}`);
    expect(stdoutChunks.join('')).toContain('SSH-2.0-RemoteServer');

    socket.destroy();
    server.close();
  });

  it('handles HTTP proxy CONNECT rejection', async () => {
    const server = net.createServer((sock) => {
      sock.on('data', () => {
        sock.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const stderrChunks: string[] = [];
    let exitCode: number | null = null;

    const socket = runProxyCli(
      ['http', '127.0.0.1', String(port), 'target.domain', '22'],
      {},
      {
        stderr: { write: (s: string) => { stderrChunks.push(s); return true; } },
        exit: (c: number) => { exitCode = c; },
      }
    );

    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        setTimeout(resolve, 50);
      });
    });

    expect(exitCode).toBe(1);
    expect(stderrChunks.join('')).toContain('HTTP proxy rejected CONNECT: HTTP/1.1 403 Forbidden');

    socket.destroy();
    server.close();
  });

  it('successfully handshakes with SOCKS5 proxy without authentication', async () => {
    const server = net.createServer((sock) => {
      let stage = 0;
      sock.on('data', (d) => {
        if (stage === 0) {
          // Greeting
          expect(d[0]).toBe(0x05);
          sock.write(Buffer.from([0x05, 0x00])); // No auth required
          stage = 1;
        } else if (stage === 1) {
          // Connect request
          expect(d[0]).toBe(0x05);
          expect(d[1]).toBe(0x01); // CONNECT
          // Reply success with IPv4 address 127.0.0.1:22
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 22]));
          stage = 2;
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let exitCode: number | null = null;

    const socket = runProxyCli(
      ['socks5', '127.0.0.1', String(port), 'target.internal', '22'],
      {},
      { stdin, stdout, stderr: { write: vi.fn() }, exit: (c: number) => { exitCode = c; } }
    );

    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        setTimeout(resolve, 60);
      });
    });

    expect(exitCode).toBeNull(); // Still open and piped

    socket.destroy();
    server.close();
  });

  it('successfully handshakes with SOCKS5 proxy using username and password', async () => {
    let authVerified = false;
    const server = net.createServer((sock) => {
      let stage = 0;
      sock.on('data', (d) => {
        if (stage === 0) {
          // Greeting with user/pass method offered
          sock.write(Buffer.from([0x05, 0x02])); // Username/password auth required
          stage = 1;
        } else if (stage === 1) {
          // Auth subnegotiation: [0x01, ulen, user, plen, pass]
          expect(d[0]).toBe(0x01);
          const ulen = d[1];
          const user = d.subarray(2, 2 + ulen).toString('utf-8');
          const plen = d[2 + ulen];
          const pass = d.subarray(3 + ulen, 3 + ulen + plen).toString('utf-8');
          if (user === 'socksuser' && pass === 'sockspass') {
            authVerified = true;
            sock.write(Buffer.from([0x01, 0x00])); // Auth success
            stage = 2;
          } else {
            sock.write(Buffer.from([0x01, 0x01])); // Auth failure
          }
        } else if (stage === 2) {
          // CONNECT request: domain name atyp 0x03
          // Reply with domain name atyp (0x03)
          const domain = Buffer.from('localhost');
          sock.write(Buffer.concat([
            Buffer.from([0x05, 0x00, 0x00, 0x03, domain.length]),
            domain,
            Buffer.from([0x00, 0x16])
          ]));
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let exitCode: number | null = null;

    const socket = runProxyCli(
      ['socks5', '127.0.0.1', String(port), 'target.internal', '22'],
      { SSHS3_PROXY_USERNAME: 'socksuser', SSHS3_PROXY_PASSWORD: 'sockspass' }, // pragma: allowlist secret
      { stdin, stdout, stderr: { write: vi.fn() }, exit: (c: number) => { exitCode = c; } }
    );

    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        setTimeout(resolve, 80);
      });
    });

    expect(authVerified).toBe(true);
    expect(exitCode).toBeNull();

    socket.destroy();
    server.close();
  });

  it('handles SOCKS5 auth rejection and connection rejection', async () => {
    // 1. SOCKS5 server rejects greeting methods (0xff)
    const serverReject = net.createServer((sock) => {
      sock.on('data', () => {
        sock.write(Buffer.from([0x05, 0xff])); // No acceptable auth
      });
    });
    await new Promise<void>((resolve) => serverReject.listen(0, '127.0.0.1', resolve));
    const rejectPort = (serverReject.address() as net.AddressInfo).port;

    const stderrChunks: string[] = [];
    let exitCode: number | null = null;

    const sock1 = runProxyCli(
      ['socks5', '127.0.0.1', String(rejectPort), 'target.internal', '22'],
      {},
      {
        stderr: { write: (s: string) => { stderrChunks.push(s); return true; } },
        exit: (c: number) => { exitCode = c; },
      }
    );

    await new Promise<void>((resolve) => {
      sock1.on('connect', () => setTimeout(resolve, 50));
    });

    expect(exitCode).toBe(1);
    expect(stderrChunks.join('')).toContain('SOCKS5 proxy authentication error');

    sock1.destroy();
    serverReject.close();

    // 2. SOCKS5 connect rejection code
    let failStage = 0;
    const serverFailConnect = net.createServer((sock) => {
      sock.on('data', () => {
        if (failStage === 0) {
          sock.write(Buffer.from([0x05, 0x00]));
          failStage = 1;
        } else {
          sock.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // Connection refused (0x05)
        }
      });
    });
    await new Promise<void>((resolve) => serverFailConnect.listen(0, '127.0.0.1', resolve));
    const failPort = (serverFailConnect.address() as net.AddressInfo).port;

    stderrChunks.length = 0;
    exitCode = null;

    const sock2 = runProxyCli(
      ['socks5', '127.0.0.1', String(failPort), 'target.internal', '22'],
      {},
      {
        stderr: { write: (s: string) => { stderrChunks.push(s); return true; } },
        exit: (c: number) => { exitCode = c; },
      }
    );

    await new Promise<void>((resolve) => {
      sock2.on('connect', () => setTimeout(resolve, 50));
    });

    expect(exitCode).toBe(1);
    expect(stderrChunks.join('')).toContain('SOCKS5 CONNECT failed with code 5');

    sock2.destroy();
    serverFailConnect.close();

    // 3. SOCKS5 user/pass subnegotiation failure
    const serverAuthFail = net.createServer((sock) => {
      let stage = 0;
      sock.on('data', () => {
        if (stage === 0) {
          sock.write(Buffer.from([0x05, 0x02]));
          stage = 1;
        } else if (stage === 1) {
          sock.write(Buffer.from([0x01, 0x01])); // Auth failed
        }
      });
    });
    await new Promise<void>((resolve) => serverAuthFail.listen(0, '127.0.0.1', resolve));
    const authFailPort = (serverAuthFail.address() as net.AddressInfo).port;

    stderrChunks.length = 0;
    exitCode = null;

    const sock3 = runProxyCli(
      ['socks5', '127.0.0.1', String(authFailPort), 'target.internal', '22'],
      { SSHS3_PROXY_USERNAME: 'user', SSHS3_PROXY_PASSWORD: 'wrongpassword' }, // pragma: allowlist secret
      {
        stderr: { write: (s: string) => { stderrChunks.push(s); return true; } },
        exit: (c: number) => { exitCode = c; },
      }
    );

    await new Promise<void>((resolve) => {
      sock3.on('connect', () => setTimeout(resolve, 50));
    });

    expect(exitCode).toBe(1);
    expect(stderrChunks.join('')).toContain('SOCKS5 user/pass authentication failed');

    sock3.destroy();
    serverAuthFail.close();
  });

  it('supports SOCKS4 connect success and rejection', async () => {
    // 1. Success 0x5a
    const serverSocks4 = net.createServer((sock) => {
      sock.on('data', () => {
        sock.write(Buffer.from([0x00, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
      });
    });
    await new Promise<void>((resolve) => serverSocks4.listen(0, '127.0.0.1', resolve));
    const s4Port = (serverSocks4.address() as net.AddressInfo).port;

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let exitCode: number | null = null;

    const sock1 = runProxyCli(
      ['socks4', '127.0.0.1', String(s4Port), 'target.internal', '22'],
      { SSHS3_PROXY_USERNAME: 'socks4user' },
      { stdin, stdout, stderr: { write: vi.fn() }, exit: (c: number) => { exitCode = c; } }
    );

    await new Promise<void>((resolve) => {
      sock1.on('connect', () => setTimeout(resolve, 50));
    });

    expect(exitCode).toBeNull();
    sock1.destroy();
    serverSocks4.close();

    // 2. Rejection 0x5b
    const serverSocks4Reject = net.createServer((sock) => {
      sock.on('data', () => {
        sock.write(Buffer.from([0x00, 0x5b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
      });
    });
    await new Promise<void>((resolve) => serverSocks4Reject.listen(0, '127.0.0.1', resolve));
    const s4RejectPort = (serverSocks4Reject.address() as net.AddressInfo).port;

    const stderrChunks: string[] = [];
    exitCode = null;

    const sock2 = runProxyCli(
      ['socks4', '127.0.0.1', String(s4RejectPort), 'target.internal', '22'],
      {},
      {
        stderr: { write: (s: string) => { stderrChunks.push(s); return true; } },
        exit: (c: number) => { exitCode = c; },
      }
    );

    await new Promise<void>((resolve) => {
      sock2.on('connect', () => setTimeout(resolve, 50));
    });

    expect(exitCode).toBe(1);
    expect(stderrChunks.join('')).toContain('SOCKS4 CONNECT rejected code: 91');

    sock2.destroy();
    serverSocks4Reject.close();
  });

  it('readChunk resolves buffered chunks correctly', async () => {
    const emitter = new PassThrough();
    const chunkPromise = readChunk(emitter, 4);

    emitter.write(Buffer.from([1, 2]));
    emitter.write(Buffer.from([3, 4, 5, 6]));

    const result = await chunkPromise;
    expect(result).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  // Low finding (code review 2026-11-03): same input checks as proxySocket.ts, before any connection is made.
  it('refuses a target host with CR/LF, and SOCKS5 fields over 255 bytes, without connecting', () => {
    const run = (argv: string[], env: Record<string, string> = {}) => {
      const stderr: string[] = [];
      let exitCode: number | null = null;
      const connect = vi.fn();
      runProxyCli(argv, env, {
        stderr: { write: (s: string) => (stderr.push(s), true) },
        exit: (code: number) => {
          exitCode = code;
        },
        connect,
      });
      return { stderr: stderr.join(''), exitCode, connect };
    };

    const injected = run(['http', '127.0.0.1', '3128', 'target.example.com\r\nX-Injected: 1', '22']);
    expect(injected.exitCode).toBe(1);
    expect(injected.stderr).toMatch(/invalid target host/i);
    expect(injected.connect).not.toHaveBeenCalled();

    const longHost = run(['socks5', '127.0.0.1', '1080', `${'h'.repeat(256)}.example.com`, '22']);
    expect(longHost.exitCode).toBe(1);
    expect(longHost.stderr).toMatch(/255 bytes/);
    expect(longHost.connect).not.toHaveBeenCalled();

    const longPassword = run(['socks5', '127.0.0.1', '1080', 'a.example.com', '22'], {
      SSHS3_PROXY_USERNAME: 'u',
      SSHS3_PROXY_PASSWORD: 'é'.repeat(128),
    });
    expect(longPassword.exitCode).toBe(1);
    expect(longPassword.stderr).toMatch(/255 bytes/);
    expect(longPassword.connect).not.toHaveBeenCalled();
  });
});
