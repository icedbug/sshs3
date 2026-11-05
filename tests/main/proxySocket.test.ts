import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { createProxySocket } from '../../src/main/proxy/proxySocket';

describe('createProxySocket', () => {
  let servers: net.Server[] = [];

  afterEach(async () => {
    for (const server of servers) {
      await new Promise<void>((res) => server.close(() => res()));
    }
    servers = [];
  });

  function startServer(handler: (socket: net.Socket) => void): Promise<{ server: net.Server; port: number }> {
    return new Promise((resolve) => {
      const server = net.createServer(handler);
      servers.push(server);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        resolve({ server, port: addr.port });
      });
    });
  }

  describe('HTTP CONNECT proxy', () => {
    it('successfully connects through HTTP proxy with 200 response', async () => {
      let receivedReq = '';
      const { port } = await startServer((socket) => {
        socket.on('data', (chunk) => {
          receivedReq += chunk.toString();
          if (receivedReq.includes('\r\n\r\n')) {
            socket.write('HTTP/1.1 200 OK\r\n\r\n');
          }
        });
      });

      const sock = await createProxySocket(
        { enabled: true, type: 'http', host: '127.0.0.1', port },
        { host: 'target.example.com', port: 22 }
      );

      expect(sock).toBeDefined();
      expect(receivedReq).toContain('CONNECT target.example.com:22 HTTP/1.1');
      sock.destroy();
    });

    it('sends Proxy-Authorization header when username/password provided', async () => {
      let receivedReq = '';
      const { port } = await startServer((socket) => {
        socket.on('data', (chunk) => {
          receivedReq += chunk.toString();
          if (receivedReq.includes('\r\n\r\n')) {
            socket.write('HTTP/1.1 200 OK\r\n\r\n');
          }
        });
      });

      const sock = await createProxySocket(
        { enabled: true, type: 'http', host: '127.0.0.1', port, username: 'admin', password: 'secretpassword' },
        { host: 'target.example.com', port: 22 }
      );

      const expectedAuth = Buffer.from('admin:secretpassword').toString('base64');
      expect(receivedReq).toContain(`Proxy-Authorization: Basic ${expectedAuth}`);
      sock.destroy();
    });

    it('rejects when HTTP proxy returns 403 or 407', async () => {
      const { port } = await startServer((socket) => {
        socket.on('data', () => {
          socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        });
      });

      await expect(
        createProxySocket(
          { enabled: true, type: 'http', host: '127.0.0.1', port },
          { host: 'target.example.com', port: 22 }
        )
      ).rejects.toThrow(/HTTP proxy CONNECT failed with status/);
    });
  });

  describe('SOCKS5 proxy', () => {
    it('successfully connects through SOCKS5 without auth', async () => {
      const { port } = await startServer((socket) => {
        let step = 0;
        socket.on('data', (_data) => {
          if (step === 0) {
            // Greeting: respond with VER 5, METHOD 0 (no auth)
            socket.write(Buffer.from([0x05, 0x00]));
            step++;
          } else if (step === 1) {
            // Request: respond with VER 5, REP 0 (success), RSV 0, ATYP 1 (IPv4), BND.ADDR, BND.PORT
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 22]));
            step++;
          }
        });
      });

      const sock = await createProxySocket(
        { enabled: true, type: 'socks5', host: '127.0.0.1', port },
        { host: 'target.example.com', port: 22 }
      );

      expect(sock).toBeDefined();
      sock.destroy();
    });

    it('successfully connects through SOCKS5 with username/password auth', async () => {
      let authValidated = false;
      const { port } = await startServer((socket) => {
        let step = 0;
        socket.on('data', (data) => {
          if (step === 0) {
            // Respond with METHOD 2 (user/pass)
            socket.write(Buffer.from([0x05, 0x02]));
            step++;
          } else if (step === 1) {
            // Subnegotiation auth
            if (data[0] === 0x01) {
              authValidated = true;
              socket.write(Buffer.from([0x01, 0x00])); // status success
            }
            step++;
          } else if (step === 2) {
            // Request: respond success
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 22]));
            step++;
          }
        });
      });

      const sock = await createProxySocket(
        { enabled: true, type: 'socks5', host: '127.0.0.1', port, username: 'socksuser', password: 'sockspassword' },
        { host: 'target.example.com', port: 22 }
      );

      expect(sock).toBeDefined();
      expect(authValidated).toBe(true);
      sock.destroy();
    });

    it('rejects when SOCKS5 returns connection failure code', async () => {
      const { port } = await startServer((socket) => {
        let step = 0;
        socket.on('data', () => {
          if (step === 0) {
            socket.write(Buffer.from([0x05, 0x00]));
            step++;
          } else {
            // Reply with REP 0x05 (connection refused)
            socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          }
        });
      });

      await expect(
        createProxySocket(
          { enabled: true, type: 'socks5', host: '127.0.0.1', port },
          { host: 'target.example.com', port: 22 }
        )
      ).rejects.toThrow(/Connection refused/);
    });
  });

  describe('SOCKS4 proxy', () => {
    it('successfully connects through SOCKS4a', async () => {
      const { port } = await startServer((socket) => {
        socket.on('data', () => {
          // SOCKS4 reply: 8 bytes, second byte 0x5a (request granted)
          socket.write(Buffer.from([0x00, 0x5a, 0x00, 0x16, 127, 0, 0, 1]));
        });
      });

      const sock = await createProxySocket(
        { enabled: true, type: 'socks4', host: '127.0.0.1', port },
        { host: 'target.example.com', port: 22 }
      );

      expect(sock).toBeDefined();
      sock.destroy();
    });

    it('rejects when SOCKS4 request is rejected', async () => {
      const { port } = await startServer((socket) => {
        socket.on('data', () => {
          // SOCKS4 reply: second byte 0x5b (request rejected)
          socket.write(Buffer.from([0x00, 0x5b, 0x00, 0x00, 0, 0, 0, 0]));
        });
      });

      await expect(
        createProxySocket(
          { enabled: true, type: 'socks4', host: '127.0.0.1', port },
          { host: 'target.example.com', port: 22 }
        )
      ).rejects.toThrow(/SOCKS4 CONNECT failed/);
    });
  });

  // Low finding (code review 2026-11-03): a CR/LF in the target host went straight into the CONNECT request (header
  // injection), and SOCKS5 length bytes wrapped around for fields over 255 bytes (a corrupt handshake).
  describe('input that would corrupt the handshake', () => {
    // Nothing may even connect: the proxy here records whether anyone did.
    async function unreachableProxy() {
      let connections = 0;
      const { port } = await startServer(() => {
        connections++;
      });
      return { port, connections: () => connections };
    }

    it('refuses a target host with CR/LF or other control characters for an HTTP proxy', async () => {
      const proxy = await unreachableProxy();
      await expect(
        createProxySocket(
          { enabled: true, type: 'http', host: '127.0.0.1', port: proxy.port },
          { host: 'target.example.com\r\nX-Injected: 1', port: 22 }
        )
      ).rejects.toThrow(/invalid target host/i);
      expect(proxy.connections()).toBe(0);
    });

    it('refuses a SOCKS5 target host, user name or password longer than 255 bytes', async () => {
      const proxy = await unreachableProxy();
      const base = { enabled: true, type: 'socks5' as const, host: '127.0.0.1', port: proxy.port };

      await expect(createProxySocket(base, { host: `${'h'.repeat(256)}.example.com`, port: 22 })).rejects.toThrow(/255 bytes/);
      await expect(
        createProxySocket({ ...base, username: 'u'.repeat(256), password: 'p' }, { host: 'a.example.com', port: 22 })
      ).rejects.toThrow(/255 bytes/);
      // Counted in bytes, not characters: 128 two-byte characters are 256 bytes.
      await expect(
        createProxySocket({ ...base, username: 'u', password: 'é'.repeat(128) }, { host: 'a.example.com', port: 22 })
      ).rejects.toThrow(/255 bytes/);
      expect(proxy.connections()).toBe(0);
    });
  });
});
