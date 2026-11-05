import { describe, expect, it } from 'vitest';
import {
  buildSudoCommand,
  detectSudoRetry,
  isRootPromptLine,
  manualSudoInput,
  outputIndicatesPermissionDenied,
} from './sudoRetry';

const base = { exitCode: undefined, atRootPrompt: false } as const;

describe('detectSudoRetry', () => {
  it('suggests sudo for a plain permission error', () => {
    expect(
      detectSudoRetry({ ...base, command: 'cat /etc/shadow', output: 'cat: /etc/shadow: Permission denied' })
    ).toEqual({ sudoCommand: 'sudo cat /etc/shadow' });
  });

  it.each([
    'mkdir: cannot create directory ‘/opt/x’: Permission denied',
    'rm: cannot remove ‘/x’: Operation not permitted',
    'E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)',
    'Are you root?',
    'This command must be run as root',
    'Failed to restart nginx.service: Interactive authentication required.',
    'The requested operation requires superuser privileges. Please log in as a user with elevated rights, or use the "--assumeno" or "--downloadonly" options to run the command without modifying the system state.',
    'Error: This command has to be run with superuser privileges (under the root user on most systems).',
    'Root privileges are required for installing or uninstalling packages.',
    'You need to be root to perform this command.',
    'error: you cannot perform this operation unless you are root.',
    "error: can't create transaction lock on /usr/lib/sysimage/rpm/.rpm.lock (Success)",
    // apt update as a normal user: the lock line is above the last three rows.
    [
      'E: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)',
      'E: Unable to lock directory /var/lib/apt/lists/',
      'W: Problem unlinking the file /var/cache/apt/pkgcache.bin - RemoveCaches (13: Permission denied)',
      'W: Problem unlinking the file /var/cache/apt/srcpkgcache.bin - RemoveCaches (13: Permission denied)',
    ].join('\n'),
    'E: Unable to lock the administration directory (/var/lib/dpkg/), are you root?',
    'dpkg: error: requested operation requires superuser privilege',
    'useradd: Permission denied.',
    'useradd: cannot lock /etc/passwd; try again later.',
    'error: access denied (try with sudo)',
    'Failed to enable unit: Access denied',
    'mount: /mnt: must be superuser to use mount.',
    'docker: permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: dial unix /var/run/docker.sock: connect: permission denied.',
  ])('recognises %s', (output) => {
    expect(outputIndicatesPermissionDenied(output)).toBe(true);
  });

  it('offers sudo for a Rust tool error that ends with the errno suffix', () => {
    expect(
      detectSudoRetry({
        ...base,
        command: 'cat /etc/shadow',
        output: "[bat error]: '/etc/shadow': Permission denied (os error 13)",
      })
    ).toEqual({ sudoCommand: 'sudo cat /etc/shadow' });
  });

  it.each([
    'cat: /etc/shadow: Åtkomst nekas',
    'cat: /etc/shadow: Keine Berechtigung',
    'cat: /etc/shadow: Permission non accordée',
    'cat: /etc/shadow: Permiso denegado',
  ])('recognises %s', (output) => {
    expect(outputIndicatesPermissionDenied(output)).toBe(true);
  });

  it('trusts looser wording only together with a failing exit code', () => {
    const line = 'tool: Permission denied while opening /x, giving up';
    expect(outputIndicatesPermissionDenied(line)).toBe(false);
    expect(outputIndicatesPermissionDenied(line, 1)).toBe(true);
    expect(outputIndicatesPermissionDenied(line, 2)).toBe(false);
    expect(outputIndicatesPermissionDenied('user@host: Permission denied (publickey).', 1)).toBe(false);
  });

  it('does not offer sudo for wording that forbids root, lock contention or a read-only rpm database', () => {
    for (const output of [
      'Do not run this with root privileges',
      'Running with root privileges is not recommended',
      'You do not need to be root to run this.',
      'ftp: 550 /dir: Access denied.',
      'ERROR: Access denied',
      'flock: cannot lock /var/lock/job.lock',
      ['E: Could not get lock /var/lib/apt/lists/lock. It is held by process 123 (apt)', 'E: Unable to lock directory /var/lib/apt/lists/'].join('\n'),
      'error: cannot open Packages database in /var/lib/rpm',
    ]) {
      expect(outputIndicatesPermissionDenied(output)).toBe(false);
    }
    expect(outputIndicatesPermissionDenied('error: cannot open Packages database in /var/lib/rpm', 1)).toBe(true);
  });

  it('does not take an application-level "Access denied" for a permission problem', () => {
    expect(outputIndicatesPermissionDenied("ERROR 1045 (28000): Access denied for user 'app'@'localhost'", 1)).toBe(false);
  });

  it('still ignores an ssh authentication failure that lists methods', () => {
    expect(outputIndicatesPermissionDenied('user@host: Permission denied (publickey,password).')).toBe(false);
    expect(outputIndicatesPermissionDenied('user@host: Permission denied (publickey,gssapi-with-mic).')).toBe(false);
  });

  it('ignores ssh authentication failures', () => {
    expect(
      detectSudoRetry({ ...base, command: 'ls', output: 'user@host: Permission denied (publickey,password).' })
    ).toBeNull();
  });

  it.each(['ssh host', 'scp a b:', 'git push', 'sudo cat /x', 'su -', 'doas ls', '/usr/bin/ssh host'])(
    'skips excluded command %s',
    (command) => {
      expect(detectSudoRetry({ ...base, command, output: 'x: Permission denied' })).toBeNull();
    }
  );

  it.each([
    ['a newline', 'cat /x\nrm -rf ~'],
    ['a carriage return', 'cat /x\rrm -rf ~'],
    ['an escape character', 'cat /x\u001b[2K'],
    ['a bidi override', 'cat /x\u202e'],
    ['a zero-width space', 'cat\u200b /x'],
  ])('refuses a command containing %s', (_name, command) => {
    expect(detectSudoRetry({ ...base, command, output: 'cat: /x: Permission denied' })).toBeNull();
  });

  it('skips redirects to and from files because the shell opens them before sudo runs', () => {
    const output = 'bash: /etc/foo: Permission denied';
    expect(detectSudoRetry({ ...base, command: 'echo x > /etc/foo', output })).toBeNull();
    expect(detectSudoRetry({ ...base, command: 'sort < /etc/shadow', output })).toBeNull();
    expect(detectSudoRetry({ ...base, command: 'cat /x 2>> /var/log/y', output })).toBeNull();
  });

  it('still offers sudo when the only redirects are stderr/null redirects', () => {
    const output = 'find: /root: Permission denied';
    expect(detectSudoRetry({ ...base, command: 'find /root -name x 2>/dev/null', output })?.sudoCommand).toBe(
      'sudo find /root -name x 2>/dev/null'
    );
    expect(detectSudoRetry({ ...base, command: 'cat /x 2>&1 | less', output })).not.toBeNull();
    expect(detectSudoRetry({ ...base, command: 'cat /x &>/dev/null', output })).not.toBeNull();
  });

  it.each(['cd /root', 'source ./env', 'export A=1', 'alias ll=ls', 'type foo', 'exec ls'])(
    'skips the shell builtin %s',
    (command) => {
      expect(detectSudoRetry({ ...base, command, output: 'bash: /root: Permission denied' })).toBeNull();
    }
  );

  it.each(['cat /x; cat /y', 'cd /x && ls', 'ls /x || true'])('skips the compound line %s', (command) => {
    expect(detectSudoRetry({ ...base, command, output: 'cat: /x: Permission denied' })).toBeNull();
  });

  it.each(['npm install', 'pip install x', 'yarn add y', 'cargo build'])(
    'skips the user-scoped package tool %s',
    (command) => {
      expect(detectSudoRetry({ ...base, command, output: 'npm: /x: Permission denied' })).toBeNull();
    }
  );

  it.each([
    'NODE_ENV=production npm i -g x',
    'PIP_INDEX=x pip install foo',
    'GIT_SSH_COMMAND=ssh git push',
    'FOO=1 cat /x',
  ])('skips a command with a leading environment assignment: %s', (command) => {
    expect(detectSudoRetry({ ...base, command, output: 'cat: /x: Permission denied' })).toBeNull();
  });

  it.each(['env FOO=1 cat /etc/shadow', 'time FOO=1 cat /etc/shadow', 'nohup A=1 B=2 cat /etc/shadow'])(
    'skips an assignment that follows a wrapper: %s',
    (command) => {
      expect(detectSudoRetry({ ...base, command, output: 'cat: /etc/shadow: Permission denied' })).toBeNull();
    }
  );

  it('reads the real command after an env option that takes an argument', () => {
    const output = 'x: Permission denied';
    expect(detectSudoRetry({ ...base, command: 'env -u FOO npm i', output })).toBeNull();
    expect(detectSudoRetry({ ...base, command: 'env -u FOO cat /etc/shadow', output })?.sudoCommand).toBe(
      'sudo env -u FOO cat /etc/shadow'
    );
  });

  it.each(['time npm install', 'nohup pip install x', 'env cargo build', 'nice -n 5 npm i', '/usr/bin/time ssh host'])(
    'looks through a wrapper to find the real command: %s',
    (command) => {
      expect(detectSudoRetry({ ...base, command, output: 'x: Permission denied' })).toBeNull();
    }
  );

  it('still offers sudo for a wrapped command that is fine to elevate', () => {
    expect(
      detectSudoRetry({ ...base, command: 'time cat /etc/shadow', output: 'cat: /etc/shadow: Permission denied' })
        ?.sudoCommand
    ).toBe('sudo time cat /etc/shadow');
  });

  it('does not treat a firewall or sandbox "Operation not permitted" as a permission problem', () => {
    expect(
      detectSudoRetry({ ...base, command: 'ping 1.1.1.1', output: 'ping: sendto: Operation not permitted' })
    ).toBeNull();
    expect(outputIndicatesPermissionDenied('Error: EACCES: permission denied, open x')).toBe(false);
  });

  it('only counts an error near the end of the output', () => {
    const early = ['a: Permission denied', 'line 2', 'line 3', 'line 4', 'done'].join('\n');
    expect(outputIndicatesPermissionDenied(early)).toBe(false);
    expect(outputIndicatesPermissionDenied(['ok', 'cat: /x: Permission denied'].join('\n'))).toBe(true);
  });

  it('skips when already root, or when the exit code is 0', () => {
    const output = 'cat: /x: Permission denied';
    expect(detectSudoRetry({ command: 'cat /x', output, atRootPrompt: true })).toBeNull();
    expect(detectSudoRetry({ command: 'cat /x', output, exitCode: 0, atRootPrompt: false })).toBeNull();
    expect(detectSudoRetry({ command: 'cat /x', output, exitCode: 1, atRootPrompt: false })).not.toBeNull();
  });

  it('skips long output and missing command or output', () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\nx: Permission denied';
    expect(detectSudoRetry({ ...base, command: 'cat log', output: long })).toBeNull();
    expect(detectSudoRetry({ ...base, command: null, output: 'x: Permission denied' })).toBeNull();
    expect(detectSudoRetry({ ...base, command: 'ls', output: null })).toBeNull();
  });

  it('keeps pipes so the shown command is exactly what runs', () => {
    expect(
      detectSudoRetry({ ...base, command: 'cat /x | head', output: 'cat: /x: Permission denied' })?.sudoCommand
    ).toBe('sudo cat /x | head');
  });
});

describe('buildSudoCommand / isRootPromptLine', () => {
  it('trims the command', () => {
    expect(buildSudoCommand('  ls /root  ')).toBe('sudo ls /root');
  });

  it('detects a root prompt', () => {
    expect(isRootPromptLine('[root@host ~]# ')).toBe(true);
    expect(isRootPromptLine('user@host:~$ ')).toBe(false);
    expect(isRootPromptLine('root@host:~$ ')).toBe(true);
    expect(isRootPromptLine('root@host ~ % ')).toBe(true);
    expect(isRootPromptLine('alun@fedora in ~')).toBe(false);
  });
});

describe('manualSudoInput', () => {
  it('types the exact command when it is known and fine to elevate', () => {
    expect(manualSudoInput('  cat /etc/shadow ')).toEqual({ kind: 'command', text: 'sudo cat /etc/shadow' });
  });

  it('falls back to the shell history when the command is unknown or not plain text', () => {
    expect(manualSudoInput(null)).toEqual({ kind: 'history', text: 'sudo !!' });
    expect(manualSudoInput('')).toEqual({ kind: 'history', text: 'sudo !!' });
    expect(manualSudoInput('echo hi\u202e')).toEqual({ kind: 'history', text: 'sudo !!' });
    expect(manualSudoInput('cat x\u001b[2J')).toEqual({ kind: 'history', text: 'sudo !!' });
  });

  it('refuses commands that sudo cannot elevate', () => {
    expect(manualSudoInput('cd /root')).toEqual({ kind: 'refused' });
    expect(manualSudoInput('ssh host')).toEqual({ kind: 'refused' });
    expect(manualSudoInput('echo a > /etc/x')).toEqual({ kind: 'refused' });
    expect(manualSudoInput('FOO=1 make install')).toEqual({ kind: 'refused' });
  });

  it('refuses a wrapper word that is itself a shell builtin and ends the line, alone or after another wrapper', () => {
    // `command` is both a wrapper (`command ls`) and a builtin, so with nothing after it there is nothing to elevate.
    expect(manualSudoInput('command')).toEqual({ kind: 'refused' });
    expect(manualSudoInput('time command')).toEqual({ kind: 'refused' });
    expect(manualSudoInput('nohup command')).toEqual({ kind: 'refused' });
  });

  it('still elevates a wrapper word that is not a builtin and ends the line', () => {
    expect(manualSudoInput('nohup')).toEqual({ kind: 'command', text: 'sudo nohup' });
  });
});
