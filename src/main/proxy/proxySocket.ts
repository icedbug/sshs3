import net from 'node:net';
import type { ProxyConfig } from '../../shared/types/storage';

export interface TargetEndpoint {
  host: string;
  port: number;
}

class SocketReader {
  private buffer = Buffer.alloc(0);
  private waitingResolve: (() => void) | null = null;
  private waitingReject: ((err: Error) => void) | null = null;
  private closed = false;
  private error: Error | null = null;

  constructor(private socket: net.Socket) {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  private onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.waitingResolve) {
      const resolve = this.waitingResolve;
      this.waitingResolve = null;
      this.waitingReject = null;
      resolve();
    }
  };

  private onError = (err: Error) => {
    this.error = err;
    if (this.waitingReject) {
      const reject = this.waitingReject;
      this.waitingResolve = null;
      this.waitingReject = null;
      reject(err);
    }
  };

  private onClose = () => {
    this.closed = true;
    if (this.waitingReject) {
      const reject = this.waitingReject;
      this.waitingResolve = null;
      this.waitingReject = null;
      reject(new Error('Proxy connection closed prematurely'));
    }
  };

  async readBytes(n: number): Promise<Buffer> {
    while (this.buffer.length < n) {
      if (this.error) throw this.error;
      if (this.closed) throw new Error('Proxy connection closed prematurely');
      await new Promise<void>((resolve, reject) => {
        this.waitingResolve = resolve;
        this.waitingReject = reject;
      });
    }
    const result = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return result;
  }

  async readUntil(delimiter: string): Promise<string> {
    const delimBuf = Buffer.from(delimiter);
    while (true) {
      const idx = this.buffer.indexOf(delimBuf);
      if (idx !== -1) {
        const result = this.buffer.subarray(0, idx + delimBuf.length).toString('latin1');
        this.buffer = this.buffer.subarray(idx + delimBuf.length);
        return result;
      }
      if (this.error) throw this.error;
      if (this.closed) throw new Error('Proxy connection closed prematurely');
      await new Promise<void>((resolve, reject) => {
        this.waitingResolve = resolve;
        this.waitingReject = reject;
      });
    }
  }

  cleanup(): void {
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('error', this.onError);
    this.socket.removeListener('close', this.onClose);
    if (this.buffer.length > 0) {
      this.socket.unshift(this.buffer);
    }
  }
}

/**
 * Why the proxy handshake cannot be built safely from these values, or null when it can. A control character in
 * the target host would be written into the HTTP CONNECT request (header injection), and the SOCKS5 handshake
 * stores each of host, user name and password behind a single length byte, which wraps around above 255 bytes.
 * (The same rules live in proxyCli.cjs, which runs as a separate process and cannot import this file.)
 */
export function proxyHandshakeProblem(proxy: ProxyConfig, target: TargetEndpoint): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(target.host)) return 'Invalid target host: it contains whitespace or control characters';
  if (proxy.type === 'socks5') {
    const tooLong = (value: string | undefined) => Buffer.byteLength(value ?? '') > 255;
    if (tooLong(target.host)) return 'SOCKS5 cannot carry a target host longer than 255 bytes';
    if (proxy.username && (tooLong(proxy.username) || tooLong(proxy.password))) {
      return 'SOCKS5 cannot carry a user name or password longer than 255 bytes';
    }
  }
  return null;
}

/**
 * Creates and establishes a TCP connection to the target host and port
 * through the specified HTTP or SOCKS proxy.
 */
export async function createProxySocket(
  proxy: ProxyConfig,
  target: TargetEndpoint,
  timeoutMs = 15000
): Promise<net.Socket> {
  const problem = proxyHandshakeProblem(proxy, target);
  if (problem) throw new Error(problem);
  const socket = net.connect({ host: proxy.host, port: proxy.port });

  return new Promise<net.Socket>((resolve, reject) => {
    let resolved = false;

    const cleanupAndReject = (err: Error) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeoutMs, () => {
      cleanupAndReject(new Error(`Proxy connection timed out to ${proxy.host}:${proxy.port}`));
    });

    socket.once('error', (err) => {
      cleanupAndReject(new Error(`Proxy connection error (${proxy.host}:${proxy.port}): ${err.message}`));
    });

    socket.once('connect', async () => {
      const reader = new SocketReader(socket);
      try {
        if (proxy.type === 'http') {
          await performHttpConnect(socket, reader, proxy, target);
        } else if (proxy.type === 'socks5') {
          await performSocks5Connect(socket, reader, proxy, target);
        } else if (proxy.type === 'socks4') {
          await performSocks4Connect(socket, reader, proxy, target);
        } else {
          throw new Error(`Unsupported proxy type: ${(proxy as any).type}`);
        }

        reader.cleanup();
        socket.setTimeout(0); // clear handshake timeout
        resolved = true;
        resolve(socket);
      } catch (err: any) {
        reader.cleanup();
        cleanupAndReject(err);
      }
    });
  });
}

async function performHttpConnect(
  socket: net.Socket,
  reader: SocketReader,
  proxy: ProxyConfig,
  target: TargetEndpoint
): Promise<void> {
  let connectReq = `CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n`;
  if (proxy.username) {
    const auth = Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
    connectReq += `Proxy-Authorization: Basic ${auth}\r\n`;
  }
  connectReq += 'Proxy-Connection: Keep-Alive\r\n\r\n';

  socket.write(connectReq);

  const responseHeaders = await reader.readUntil('\r\n\r\n');
  const statusLine = responseHeaders.split('\r\n')[0] || '';
  const match = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/i);
  const statusCode = match ? parseInt(match[1], 10) : 0;

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`HTTP proxy CONNECT failed with status: ${statusLine}`);
  }
}

async function performSocks5Connect(
  socket: net.Socket,
  reader: SocketReader,
  proxy: ProxyConfig,
  target: TargetEndpoint
): Promise<void> {
  // 1. Send Greeting
  if (proxy.username) {
    socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02])); // Auth methods: NO AUTH (0x00), USER/PASS (0x02)
  } else {
    socket.write(Buffer.from([0x05, 0x01, 0x00])); // Auth method: NO AUTH (0x00)
  }

  const methodBuf = await reader.readBytes(2);
  if (methodBuf[0] !== 0x05) {
    throw new Error(`Invalid SOCKS5 version in greeting response: ${methodBuf[0]}`);
  }
  const selectedMethod = methodBuf[1];

  if (selectedMethod === 0xff) {
    throw new Error('SOCKS5 proxy rejected authentication methods');
  }

  // 2. Subnegotiation if USER/PASS
  if (selectedMethod === 0x02) {
    const userBuf = Buffer.from(proxy.username || '');
    const passBuf = Buffer.from(proxy.password || '');
    const authBuf = Buffer.concat([
      Buffer.from([0x01, userBuf.length]),
      userBuf,
      Buffer.from([passBuf.length]),
      passBuf,
    ]);
    socket.write(authBuf);

    const authRes = await reader.readBytes(2);
    if (authRes[1] !== 0x00) {
      throw new Error('SOCKS5 username/password authentication failed');
    }
  }

  // 3. Send CONNECT request
  const hostBuf = Buffer.from(target.host);
  const reqBuf = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
    hostBuf,
    Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]),
  ]);
  socket.write(reqBuf);

  // 4. Read reply header (at least 4 bytes: VER, REP, RSV, ATYP)
  const replyHeader = await reader.readBytes(4);
  if (replyHeader[0] !== 0x05) {
    throw new Error(`Invalid SOCKS5 version in reply: ${replyHeader[0]}`);
  }
  const replyCode = replyHeader[1];
  if (replyCode !== 0x00) {
    const errorCodes: Record<number, string> = {
      0x01: 'General SOCKS server failure',
      0x02: 'Connection not allowed by ruleset',
      0x03: 'Network unreachable',
      0x04: 'Host unreachable',
      0x05: 'Connection refused',
      0x06: 'TTL expired',
      0x07: 'Command not supported',
      0x08: 'Address type not supported',
    };
    throw new Error(`SOCKS5 CONNECT failed: ${errorCodes[replyCode] || `Error code ${replyCode}`}`);
  }

  const atyp = replyHeader[3];
  if (atyp === 0x01) {
    // IPv4: 4 bytes addr + 2 bytes port
    await reader.readBytes(6);
  } else if (atyp === 0x03) {
    // Domain name: 1 byte len + len bytes + 2 bytes port
    const lenBuf = await reader.readBytes(1);
    await reader.readBytes(lenBuf[0] + 2);
  } else if (atyp === 0x04) {
    // IPv6: 16 bytes addr + 2 bytes port
    await reader.readBytes(18);
  }
}

async function performSocks4Connect(
  socket: net.Socket,
  reader: SocketReader,
  proxy: ProxyConfig,
  target: TargetEndpoint
): Promise<void> {
  // SOCKS4a protocol to support domain name resolution
  const userBuf = Buffer.from(proxy.username || 'user');
  const hostBuf = Buffer.from(target.host);

  const req = Buffer.concat([
    Buffer.from([
      0x04, // SOCKS version 4
      0x01, // CONNECT
      (target.port >> 8) & 0xff,
      target.port & 0xff,
      0x00,
      0x00,
      0x00,
      0x01, // 0.0.0.1 invalid IP triggers SOCKS4a domain lookup
    ]),
    userBuf,
    Buffer.from([0x00]),
    hostBuf,
    Buffer.from([0x00]),
  ]);

  socket.write(req);

  const reply = await reader.readBytes(8);
  if (reply[1] !== 0x5a) {
    const errorCodes: Record<number, string> = {
      0x5b: 'Request rejected or failed',
      0x5c: 'Request failed: identd is not running or not reachable',
      0x5d: 'Request failed: identd reported differing user IDs',
    };
    throw new Error(`SOCKS4 CONNECT failed: ${errorCodes[reply[1]] || `Error code ${reply[1]}`}`);
  }
}
