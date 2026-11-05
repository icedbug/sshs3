import { describe, it, expect, vi } from 'vitest';
import {
  createFileSource,
  createRegistrySource,
  describeUntrustedPolicyDir,
  describeUntrustedPolicyFile,
  getPolicySources,
  policyFilePath,
  systemRegExePath,
  type PolicyFileIo,
  type PolicyFileStat,
} from '../../src/main/policy/policySources';
import { loadPolicy } from '../../src/main/policy/loadPolicy';

const stat = (over: Partial<PolicyFileStat> = {}): PolicyFileStat => ({
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
  uid: 0,
  mode: 0o100644,
  ...over,
});

describe('policy sources per platform', () => {
  it('uses the registry on Windows and a root-owned file elsewhere', () => {
    expect(getPolicySources('win32', { SystemRoot: 'C:\\Windows' }).map((s) => s.name)).toEqual([
      'registry HKLM\\SOFTWARE\\Policies\\sshs3',
    ]);
    expect(policyFilePath('linux')).toBe('/etc/sshs3/policy.conf');
    expect(policyFilePath('darwin')).toBe('/Library/Application Support/sshs3/policy.conf');
    expect(policyFilePath('win32')).toBeNull();
    expect(getPolicySources('freebsd')).toEqual([]);
  });

  it('resolves reg.exe to an absolute System32 path', () => {
    expect(systemRegExePath({ SystemRoot: 'D:\\WINNT' })).toBe('D:\\WINNT\\System32\\reg.exe');
    expect(systemRegExePath({})).toBe('C:\\Windows\\System32\\reg.exe');
  });
});

describe('describeUntrustedPolicyFile', () => {
  it('trusts a root-owned file that only root can write', () => {
    expect(describeUntrustedPolicyFile(stat())).toBeNull();
    expect(describeUntrustedPolicyFile(stat({ mode: 0o100600 }))).toBeNull();
  });
  it.each([
    [{ uid: 1000 }, 'not owned by root'],
    [{ mode: 0o100664 }, 'writable by group or others'],
    [{ mode: 0o100646 }, 'writable by group or others'],
    [{ isSymbolicLink: () => true }, 'symbolic link'],
    [{ isFile: () => false }, 'not a regular file'],
  ] as const)('rejects %j', (over, reason) => {
    expect(describeUntrustedPolicyFile(stat(over as Partial<PolicyFileStat>))).toContain(reason);
  });
});

describe('describeUntrustedPolicyDir', () => {
  const dir = (over: Partial<PolicyFileStat> = {}) => stat({ isFile: () => false, isDirectory: () => true, mode: 0o40755, ...over });

  it('trusts a root-owned folder that only root can write', () => {
    expect(describeUntrustedPolicyDir(dir())).toBeNull();
  });
  it.each([
    [{ uid: 1000 }, 'not owned by root'],
    [{ mode: 0o40775 }, 'writable by group or others'],
    [{ mode: 0o40757 }, 'writable by group or others'],
    [{ isSymbolicLink: () => true }, 'symbolic link'],
    [{ isDirectory: () => false }, 'not a directory'],
  ] as const)('rejects %j', (over, reason) => {
    expect(describeUntrustedPolicyDir(dir(over as Partial<PolicyFileStat>))).toContain(reason);
  });
});

describe('createFileSource', () => {
  const dirStat = (over: Partial<PolicyFileStat> = {}) =>
    stat({ isFile: () => false, isDirectory: () => true, mode: 0o40755, ...over });

  /** A fake disk: an open file with the given stat and content, inside a folder with the given stat. */
  const disk = (opts: { file?: Partial<PolicyFileStat>; dir?: Partial<PolicyFileStat>; content?: string; openError?: string } = {}) => {
    const close = vi.fn(async () => {});
    const readFile = vi.fn(async () => opts.content ?? 'autoCheckUpdates = false');
    const io: PolicyFileIo = {
      lstat: vi.fn(async () => dirStat(opts.dir)),
      open: vi.fn(async () => {
        if (opts.openError) throw Object.assign(new Error(opts.openError), { code: opts.openError });
        return { stat: async () => stat(opts.file), readFile, close };
      }),
    };
    return { io, close, readFile };
  };

  it('reports absent when the file does not exist', async () => {
    expect(await createFileSource('/p/policy.conf', disk({ openError: 'ENOENT' }).io).read()).toEqual({ status: 'absent' });
  });

  it('refuses a symbolic link (opened with O_NOFOLLOW)', async () => {
    const result = await createFileSource('/p/policy.conf', disk({ openError: 'ELOOP' }).io).read();
    expect(result).toEqual({ status: 'error', message: 'Ignoring /p/policy.conf: it is a symbolic link.' });
  });

  it('checks the open file, refuses an untrusted one without reading it, and closes it', async () => {
    const d = disk({ file: { uid: 5 } });
    const result = await createFileSource('/p/policy.conf', d.io).read();
    expect(result.status).toBe('error');
    expect(d.readFile).not.toHaveBeenCalled();
    expect(d.close).toHaveBeenCalledTimes(1);
  });

  it('reads and parses a trusted file and closes it', async () => {
    const good = disk({ content: '# comment\nautoCheckUpdates = false\nbogus line\n' });
    const result = await createFileSource('/p/policy.conf', good.io).read();
    expect(result).toEqual({
      status: 'ok',
      raw: { autoCheckUpdates: false },
      warnings: ['Line 3 ignored: expected "name = value".'],
    });
    expect(good.close).toHaveBeenCalledTimes(1);
  });

  it('refuses a policy in a folder an ordinary user can write, since they could delete it', async () => {
    const d = disk({ dir: { uid: 1000 } });
    const result = await createFileSource('/p/policy.conf', d.io).read();
    expect(result).toEqual({ status: 'error', message: 'Ignoring /p/policy.conf: its folder is not owned by root.' });
    expect(d.readFile).not.toHaveBeenCalled();
  });
});

describe('createRegistrySource', () => {
  const KEY_OUTPUT = [
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\sshs3',
    '    AutoCheckUpdates    REG_DWORD    0x0',
    '    X11ServerArgs    REG_SZ    -dpi \xe5',
    '    SmartcardAuthMode    REG_SZ    always-prompt',
    '',
  ].join('\r\n');
  const exit = (code: unknown) => Object.assign(new Error('failed'), { code });

  it('reads the values, and drops non-ASCII text with a warning', async () => {
    const run = vi.fn(async () => KEY_OUTPUT);
    const result = await createRegistrySource({}, run).read();
    expect(result).toEqual({
      status: 'ok',
      raw: { autoCheckUpdates: false, smartcardAuthMode: 'always-prompt' },
      warnings: ['Policy "X11ServerArgs" ignored: registry text values must contain ASCII characters only.'],
    });
    expect(run).toHaveBeenCalledWith(['query', 'HKLM\\SOFTWARE\\Policies\\sshs3', '/reg:64']);
  });

  it('is absent when the key is not listed under its parent', async () => {
    const run = vi.fn().mockRejectedValueOnce(exit(1)).mockResolvedValueOnce('\r\nEnd of search: 0 match(es) found.\r\n');
    expect(await createRegistrySource({}, run).read()).toEqual({ status: 'absent' });
  });

  it('is absent when the parent search finds nothing (exit 1)', async () => {
    const run = vi.fn().mockRejectedValue(exit(1));
    expect(await createRegistrySource({}, run).read()).toEqual({ status: 'absent' });
  });

  it('is an error when the key exists but cannot be read', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(exit(1))
      .mockResolvedValueOnce('\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\sshs3\r\n\r\nEnd of search: 1 match(es) found.\r\n');
    const result = await createRegistrySource({}, run).read();
    expect(result.status).toBe('error');
  });

  it('is an error for any failure other than exit code 1 (missing reg.exe, timeout)', async () => {
    const run = vi.fn().mockRejectedValue(exit('ENOENT'));
    expect((await createRegistrySource({}, run).read()).status).toBe('error');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('loadPolicy', () => {
  it('returns an empty policy when every source is absent', async () => {
    const loaded = await loadPolicy([{ name: 'a', read: async () => ({ status: 'absent' }) }]);
    expect(loaded.policy).toEqual({ settings: {}, features: {} });
    expect(loaded.warnings).toEqual([]);
  });

  it('uses the first source that has a policy and reports dropped keys', async () => {
    const second = vi.fn();
    const loaded = await loadPolicy([
      { name: 'a', read: async () => ({ status: 'ok', raw: { autoCheckUpdates: false, nope: 1 } }) },
      { name: 'b', read: second },
    ]);
    expect(loaded.policy.settings).toEqual({ autoCheckUpdates: false });
    expect(loaded.warnings).toHaveLength(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('includes the warnings a source reports', async () => {
    const loaded = await loadPolicy([{ name: 'a', read: async () => ({ status: 'ok', raw: {}, warnings: ['from source'] }) }]);
    expect(loaded.warnings).toEqual(['from source']);
  });

  it('applies nothing and warns when a source errors', async () => {
    const loaded = await loadPolicy([{ name: 'a', read: async () => ({ status: 'error', message: 'boom' }) }]);
    expect(loaded.policy).toEqual({ settings: {}, features: {} });
    expect(loaded.warnings).toEqual(['Policy could not be read: boom']);
  });
});
