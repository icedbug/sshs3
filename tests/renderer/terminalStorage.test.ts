import { describe, it, expect } from 'vitest';
import {
  pathBasename,
  terminalProviderId,
  terminalStorageConnectConfig,
} from '../../src/renderer/src/lib/terminalStorage';

const k8sTarget = { contextName: 'ctx', namespace: 'ns', podName: 'pod', containerName: 'c' };
const config = { id: 'abc', host: 'example.com', username: 'me' } as any;

describe('terminalStorage', () => {
  it('derives the provider id per terminal kind', () => {
    expect(terminalProviderId({ local: true })).toBe('local');
    expect(terminalProviderId({ k8sTarget })).toBe('k8s-ctx/ns/pod/c');
    expect(terminalProviderId({ config })).toBe('sftp-abc');
    expect(terminalProviderId({ config: { ...config, id: undefined } })).toBe('sftp-example.com');
    expect(terminalProviderId({})).toBe('');
  });

  it('builds the matching connect config', () => {
    expect(terminalStorageConnectConfig({})).toBeNull();
    expect(terminalStorageConnectConfig({ local: true })).toEqual({ id: 'local', name: 'Local Disk', type: 'local' });
    expect(terminalStorageConnectConfig({ k8sTarget })).toMatchObject({
      id: 'k8s-ctx/ns/pod/c',
      type: 'k8s',
      k8sConfig: { podName: 'pod', containerName: 'c' },
    });
    expect(terminalStorageConnectConfig({ config })).toMatchObject({
      id: 'sftp-abc',
      type: 'sftp',
      sftpConfig: { id: 'abc', name: 'example.com', port: 22 },
    });
  });

  it('names the terminal session only for SSH hosts', () => {
    expect(terminalStorageConnectConfig({ config, sessionId: 's1' })).toMatchObject({ terminalSessionId: 's1' });
    expect(terminalStorageConnectConfig({ config })).not.toHaveProperty('terminalSessionId');
    expect(terminalStorageConnectConfig({ config, sessionId: null })).not.toHaveProperty('terminalSessionId');
    expect(terminalStorageConnectConfig({ local: true, sessionId: 's1' })).not.toHaveProperty('terminalSessionId');
    expect(terminalStorageConnectConfig({ k8sTarget, sessionId: 's1' })).not.toHaveProperty('terminalSessionId');
  });

  it('takes the last path segment', () => {
    expect(pathBasename('/a/b/c.txt')).toBe('c.txt');
    expect(pathBasename('C:\\dir\\file.md')).toBe('file.md');
    expect(pathBasename('/')).toBe('/');
  });
});
