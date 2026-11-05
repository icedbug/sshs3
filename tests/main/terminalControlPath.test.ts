import { describe, it, expect } from 'vitest';
import { resolveTerminalControlPath } from '../../src/main/storage/terminalControlPath';

const sftp = { host: 'example.com', port: 22, username: 'alice' };
const session = { config: { host: 'example.com', username: 'alice' }, controlPath: '/run/user/1000/s3m/abc.sock' };
const exists = () => true;

describe('resolveTerminalControlPath', () => {
  it('returns the terminal socket for the same endpoint (default port 22)', () => {
    expect(resolveTerminalControlPath(session, sftp, 'linux', exists)).toBe(session.controlPath);
  });

  it('ignores an unknown session or one without a socket', () => {
    expect(resolveTerminalControlPath(undefined, sftp, 'linux', exists)).toBeUndefined();
    expect(resolveTerminalControlPath({ config: session.config }, sftp, 'linux', exists)).toBeUndefined();
  });

  it('ignores a session for another host, port or user', () => {
    expect(resolveTerminalControlPath(session, { ...sftp, host: 'other.com' }, 'linux', exists)).toBeUndefined();
    expect(resolveTerminalControlPath(session, { ...sftp, port: 2222 }, 'linux', exists)).toBeUndefined();
    expect(resolveTerminalControlPath(session, { ...sftp, username: 'bob' }, 'linux', exists)).toBeUndefined();
  });

  it('ignores a socket that is gone, and Windows', () => {
    expect(resolveTerminalControlPath(session, sftp, 'linux', () => false)).toBeUndefined();
    expect(resolveTerminalControlPath(session, sftp, 'win32', exists)).toBeUndefined();
  });
});
