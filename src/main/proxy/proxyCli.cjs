/**
 * sshs3 ProxyCommand CLI Helper for OpenSSH.
 * Usage: node proxyCli.cjs <type> <proxyHost> <proxyPort> <targetHost> <targetPort>
 *
 * Proxy username/password (if any) are read from the SSHS3_PROXY_USERNAME /
 * SSHS3_PROXY_PASSWORD environment variables rather than argv: this script
 * is invoked as an OpenSSH ProxyCommand, which OpenSSH always runs through a
 * shell — putting free-text credentials on that command line would let
 * shell metacharacters in them break out and execute arbitrary commands.
 * Environment variables carry arbitrary bytes safely with no shell parsing.
 */
const net = require('node:net');

function readChunk(sock, n) {
  return new Promise((resolve) => {
    let b = Buffer.alloc(0);
    const onData = (chunk) => {
      b = Buffer.concat([b, chunk]);
      if (b.length >= n) {
        sock.removeListener('data', onData);
        const res = b.subarray(0, n);
        const rest = b.subarray(n);
        if (rest.length > 0) sock.unshift(rest);
        resolve(res);
      }
    };
    sock.on('data', onData);
  });
}

function pipeStreams(socket, stdin, stdout, exit) {
  stdin.pipe(socket);
  socket.pipe(stdout);
  socket.on('close', () => exit(0));
}

function runProxyCli(argv, env = process.env, streams = {}) {
  const stdin = streams.stdin || process.stdin;
  const stdout = streams.stdout || process.stdout;
  const stderr = streams.stderr || process.stderr;
  const exit = streams.exit || process.exit;
  const connectFn = streams.connect || net.connect;

  const [type, proxyHost, proxyPortStr, targetHost, targetPortStr] = argv;
  const username = env.SSHS3_PROXY_USERNAME || '';
  const password = env.SSHS3_PROXY_PASSWORD || '';

  if (!type || !proxyHost || !proxyPortStr || !targetHost || !targetPortStr) {
    stderr.write('Usage: proxyCli.cjs <type> <proxyHost> <proxyPort> <targetHost> <targetPort> [username] [password]\n');
    return exit(1);
  }

  const proxyPort = parseInt(proxyPortStr, 10);
  const targetPort = parseInt(targetPortStr, 10);
  if (isNaN(proxyPort) || isNaN(targetPort)) {
    stderr.write('Usage: proxyCli.cjs <type> <proxyHost> <proxyPort> <targetHost> <targetPort> [username] [password]\n');
    return exit(1);
  }

  // Same rules as proxyHandshakeProblem() in proxySocket.ts: control characters in the target host would end up in
  // the CONNECT request, and SOCKS5 stores host, user name and password behind one length byte each.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(targetHost)) {
    stderr.write('Invalid target host: it contains whitespace or control characters\n');
    return exit(1);
  }
  if (type === 'socks5') {
    const tooLong = (value) => Buffer.byteLength(value || '') > 255;
    if (tooLong(targetHost)) {
      stderr.write('SOCKS5 cannot carry a target host longer than 255 bytes\n');
      return exit(1);
    }
    if (username && (tooLong(username) || tooLong(password))) {
      stderr.write('SOCKS5 cannot carry a user name or password longer than 255 bytes\n');
      return exit(1);
    }
  }

  const socket = connectFn({ host: proxyHost, port: proxyPort });

  socket.on('error', (err) => {
    stderr.write(`Proxy error: ${err.message}\n`);
    exit(1);
  });

  socket.on('connect', async () => {
    try {
      if (type === 'http') {
        let req = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
        if (username) {
          const auth = Buffer.from(`${username}:${password || ''}`).toString('base64');
          req += `Proxy-Authorization: Basic ${auth}\r\n`;
        }
        req += 'Proxy-Connection: Keep-Alive\r\n\r\n';
        socket.write(req);

        let resp = '';
        const onData = (chunk) => {
          resp += chunk.toString('latin1');
          const idx = resp.indexOf('\r\n\r\n');
          if (idx !== -1) {
            socket.removeListener('data', onData);
            const firstLine = resp.split('\r\n')[0];
            const match = firstLine.match(/^HTTP\/1\.[01]\s+(\d{3})/i);
            if (!match || parseInt(match[1], 10) < 200 || parseInt(match[1], 10) >= 300) {
              stderr.write(`HTTP proxy rejected CONNECT: ${firstLine}\n`);
              return exit(1);
            }
            const rest = Buffer.from(resp.slice(idx + 4), 'latin1');
            if (rest.length > 0) {
              stdout.write(rest);
            }
            pipeStreams(socket, stdin, stdout, exit);
          }
        };
        socket.on('data', onData);
      } else if (type === 'socks5') {
        // Greeting
        if (username) {
          socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
        } else {
          socket.write(Buffer.from([0x05, 0x01, 0x00]));
        }

        const methodBuf = await readChunk(socket, 2);
        if (methodBuf[1] === 0xff) {
          stderr.write('SOCKS5 proxy authentication error\n');
          return exit(1);
        }

        if (methodBuf[1] === 0x02) {
          const uBuf = Buffer.from(username || '');
          const pBuf = Buffer.from(password || '');
          socket.write(Buffer.concat([Buffer.from([0x01, uBuf.length]), uBuf, Buffer.from([pBuf.length]), pBuf]));
          const authRes = await readChunk(socket, 2);
          if (authRes[1] !== 0x00) {
            stderr.write('SOCKS5 user/pass authentication failed\n');
            return exit(1);
          }
        }

        const hBuf = Buffer.from(targetHost);
        socket.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hBuf.length]),
          hBuf,
          Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff])
        ]));

        const reply = await readChunk(socket, 4);
        if (reply[1] !== 0x00) {
          stderr.write(`SOCKS5 CONNECT failed with code ${reply[1]}\n`);
          return exit(1);
        }

        const atyp = reply[3];
        if (atyp === 0x01) await readChunk(socket, 6);
        else if (atyp === 0x03) {
          const l = await readChunk(socket, 1);
          await readChunk(socket, l[0] + 2);
        } else if (atyp === 0x04) await readChunk(socket, 18);

        pipeStreams(socket, stdin, stdout, exit);
      } else if (type === 'socks4') {
        const uBuf = Buffer.from(username || 'user');
        const hBuf = Buffer.from(targetHost);
        socket.write(Buffer.concat([
          Buffer.from([0x04, 0x01, (targetPort >> 8) & 0xff, targetPort & 0xff, 0x00, 0x00, 0x00, 0x01]),
          uBuf,
          Buffer.from([0x00]),
          hBuf,
          Buffer.from([0x00])
        ]));
        const reply = await readChunk(socket, 8);
        if (reply[1] !== 0x5a) {
          stderr.write(`SOCKS4 CONNECT rejected code: ${reply[1]}\n`);
          return exit(1);
        }
        pipeStreams(socket, stdin, stdout, exit);
      }
    } catch (err) {
      stderr.write(`Proxy handshake error: ${err.message}\n`);
      exit(1);
    }
  });

  return socket;
}

if (require.main === module) {
  runProxyCli(process.argv.slice(2), process.env);
}

module.exports = { runProxyCli, pipeStreams, readChunk };
