import { describe, it, expect } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { CommandOutputTracker, endsAtPrompt, stripPrompt, stripPromptLoose } from './terminalOutput';

interface FakeLine {
  text: string;
  wrapped?: boolean;
}

/** Minimal xterm stand-in: a flat list of buffer lines and a cursor on the last one. */
function fakeTerm(lines: FakeLine[], opts: { type?: 'normal' | 'alternate'; cols?: number } = {}) {
  /** Row for the next markers; by default a marker lands on the last row, like the cursor row at Enter. */
  let markerRow: number | undefined;
  const buffer = {
    type: opts.type ?? 'normal',
    baseY: 0,
    get cursorY() {
      return lines.length - 1;
    },
    getLine: (i: number) =>
      lines[i] && { isWrapped: Boolean(lines[i].wrapped), translateToString: () => lines[i].text },
  };
  let osc: ((data: string) => boolean) | undefined;
  const term = {
    cols: opts.cols,
    buffer: { active: buffer },
    registerMarker: () => ({ line: markerRow ?? lines.length - 1, isDisposed: false, dispose() {} }),
    parser: {
      registerOscHandler: (_id: number, cb: (data: string) => boolean) => {
        osc = cb;
        return { dispose() {} };
      },
    },
  };
  return {
    term: term as unknown as Terminal,
    lines,
    osc: (data: string) => osc?.(data),
    markAt: (row: number | undefined) => {
      markerRow = row;
    },
  };
}

describe('CommandOutputTracker', () => {
  it('returns the output between the last command line and the current prompt', () => {
    const { term, lines } = fakeTerm([{ text: '$ ls' }]);
    const t = new CommandOutputTracker(term);
    t.recordEnter();
    lines.push({ text: 'a.txt' }, { text: 'b.txt' }, { text: '' }, { text: '$ ' });
    expect(t.lastOutput()).toBe('a.txt\nb.txt');
  });

  it('skips commands without output and rejoins wrapped lines', () => {
    const { term, lines } = fakeTerm([{ text: '$ echo long' }]);
    const t = new CommandOutputTracker(term);
    t.recordEnter();
    lines.push({ text: 'aaaa' }, { text: 'bbbb', wrapped: true }, { text: '$ ' });
    t.recordEnter(); // Enter on an empty prompt
    lines.push({ text: '$ ' });
    expect(t.lastOutput()).toBe('aaaabbbb');
  });

  it('uses OSC 133 marks when the shell sends them, ignoring multi-line prompt headers', () => {
    const f = fakeTerm([{ text: '┌ user@host' }, { text: '└> ls' }]);
    const t = new CommandOutputTracker(f.term);
    t.recordEnter();
    f.lines.push({ text: '' }); // the cursor moves to a fresh row before the output starts
    f.osc('C');
    f.lines[f.lines.length - 1].text = 'a.txt';
    f.lines.push({ text: 'b.txt' }, { text: '' });
    f.osc('D;0');
    f.lines.pop(); // the prompt reuses the row the cursor was on
    f.lines.push({ text: '┌ user@host' }, { text: '└> ' });
    expect(t.lastOutput()).toBe('a.txt\nb.txt');
  });

  it('returns null with no commands or in the alternate screen', () => {
    expect(new CommandOutputTracker(fakeTerm([{ text: '$ ' }]).term).lastOutput()).toBeNull();
    const alt = fakeTerm([{ text: 'x' }], { type: 'alternate' });
    const t = new CommandOutputTracker(alt.term);
    t.recordEnter();
    expect(t.lastOutput()).toBeNull();
  });

  it('extracts command and output metadata with getCleanOutput and lastCommand', () => {
    const f = fakeTerm([{ text: 'alun@host:~$ cat /etc/os-release' }]);
    const t = new CommandOutputTracker(f.term);
    t.recordEnter();
    f.lines.push({ text: 'NAME="Fedora Linux"' }, { text: 'VERSION="40"' }, { text: 'alun@host:~$ ' });

    expect(t.lastCommand()).toBe('cat /etc/os-release');
    const clean = t.getCleanOutput();
    expect(clean).toEqual({
      text: 'NAME="Fedora Linux"\nVERSION="40"',
      lineCount: 2,
      charCount: 32,
    });
  });

  it('tracks commands using OSC 133;B and OSC 133;C', () => {
    const f = fakeTerm([{ text: 'user@box:~$ ' }]);
    const t = new CommandOutputTracker(f.term);
    f.osc('B');
    f.lines[0].text = 'user@box:~$ uptime';
    f.osc('C');
    f.lines.push({ text: 'up 14 days' }, { text: '' });
    f.osc('D;0');
    f.lines.pop();
    f.lines.push({ text: 'user@box:~$ ' });

    expect(t.lastCommand()).toBe('uptime');
    expect(t.lastOutput()).toBe('up 14 days');
  });

  describe('lastCommandResult', () => {
    it('pairs the newest command with its own output', () => {
      const f = fakeTerm([{ text: '$ cat /etc/shadow' }]);
      const t = new CommandOutputTracker(f.term);
      t.recordEnter();
      f.lines.push({ text: 'cat: /etc/shadow: Permission denied' }, { text: '$ ' });
      expect(t.lastCommandResult()).toEqual({ command: 'cat /etc/shadow', output: 'cat: /etc/shadow: Permission denied' });
    });

    it('returns null when the newest command printed nothing, instead of an older error', () => {
      const f = fakeTerm([{ text: '$ cat /etc/shadow' }]);
      const t = new CommandOutputTracker(f.term);
      t.recordEnter();
      f.lines.push({ text: 'cat: /etc/shadow: Permission denied' }, { text: '$ cd /tmp' });
      t.recordEnter();
      f.lines.push({ text: '$ ' });
      expect(t.lastCommandResult()).toBeNull();
    });

    it('joins a command that wraps over several rows', () => {
      const f = fakeTerm([{ text: '$ rm /var/log/some/very/long' }, { text: '/path/to/file', wrapped: true }]);
      const t = new CommandOutputTracker(f.term);
      t.recordEnter();
      f.lines.push({ text: 'rm: cannot remove x: Permission denied' }, { text: '$ ' });
      expect(t.lastCommandResult()?.command).toBe('rm /var/log/some/very/long/path/to/file');
      expect(t.lastCommand()).toBe('rm /var/log/some/very/long/path/to/file');
    });

    it('uses OSC 133 regions and reports the exit code of that same command', () => {
      const f = fakeTerm([{ text: 'user@box:~$ ' }]);
      const t = new CommandOutputTracker(f.term);
      f.osc('B');
      f.lines[0].text = 'user@box:~$ cat /x';
      f.osc('C');
      f.lines.push({ text: 'cat: /x: Permission denied' }, { text: '' });
      f.osc('D;1');
      f.lines.pop();
      f.lines.push({ text: 'user@box:~$ ' });
      expect(t.lastCommandResult()).toEqual({
        command: 'cat /x',
        output: 'cat: /x: Permission denied',
        exitCode: 1,
      });
    });

    it('is null for a closed OSC command without output', () => {
      const f = fakeTerm([{ text: 'user@box:~$ ' }]);
      const t = new CommandOutputTracker(f.term);
      f.osc('B');
      f.lines[0].text = 'user@box:~$ false';
      f.osc('C');
      f.osc('D;1');
      f.lines.push({ text: 'user@box:~$ ' });
      expect(t.lastCommandResult()).toBeNull();
    });

    it('is null in the alternate screen', () => {
      const f = fakeTerm([{ text: '$ vim x' }], { type: 'alternate' });
      expect(new CommandOutputTracker(f.term).lastCommandResult()).toBeNull();
    });
  });

  describe('a command that wraps over several rows', () => {
    const wrapped = () => [
      { text: '$ sed -i x `ls -ld *|grep root |awk {print $9}|grep' },
      { text: ' test`', wrapped: true },
    ];

    it('is read in full when the cursor was on the first row at Enter', () => {
      const f = fakeTerm(wrapped());
      const t = new CommandOutputTracker(f.term);
      f.markAt(0); // Enter pressed with the cursor up in the command, e.g. after editing it
      t.recordEnter();
      f.markAt(undefined);
      f.lines.push({ text: "sed: can't read test.txt: Permission denied" }, { text: '$ ' });

      expect(t.lastCommand()).toBe('sed -i x `ls -ld *|grep root |awk {print $9}|grep test`');
      expect(t.lastCommandResult()).toEqual({
        command: 'sed -i x `ls -ld *|grep root |awk {print $9}|grep test`',
        // The tail of the command line is not part of the output.
        output: "sed: can't read test.txt: Permission denied",
      });
      expect(t.lastOutput()).toBe("sed: can't read test.txt: Permission denied");
    });

    it('is read in full when the cursor was on the last row at Enter', () => {
      const f = fakeTerm(wrapped());
      const t = new CommandOutputTracker(f.term);
      t.recordEnter();
      f.lines.push({ text: "sed: can't read test.txt: Permission denied" }, { text: '$ ' });
      expect(t.lastCommandResult()?.command).toBe('sed -i x `ls -ld *|grep root |awk {print $9}|grep test`');
    });
  });

  describe('a command line the shell breaks at the right edge itself', () => {
    // Rows are not flagged as wrapped, but the first one is filled to the edge (cols 20).
    const full = '$ sed -i x |grep a b';
    const rows = () => [{ text: full }, { text: ' test`' }];

    it('is read in full from the last row, or from the first', () => {
      for (const markerRow of [0, 1]) {
        const f = fakeTerm(rows(), { cols: 20 });
        const t = new CommandOutputTracker(f.term);
        f.markAt(markerRow);
        t.recordEnter();
        f.markAt(undefined);
        f.lines.push({ text: 'sed: x: Permission denied' }, { text: '$ ' });
        expect(t.lastCommandResult()).toEqual({
          command: 'sed -i x |grep a b test`',
          output: 'sed: x: Permission denied',
        });
      }
    });

    it('does not take the next row for a continuation when the row above is not full', () => {
      const f = fakeTerm([{ text: '$ ls /etc' }, { text: 'ls: cannot access: Permission denied' }], { cols: 40 });
      const t = new CommandOutputTracker(f.term);
      f.markAt(0);
      t.recordEnter();
      f.markAt(undefined);
      f.lines.push({ text: '$ ' });
      expect(t.lastCommandResult()).toEqual({ command: 'ls /etc', output: 'ls: cannot access: Permission denied' });
    });

    it('never treats a row that starts with a prompt as a continuation', () => {
      const f = fakeTerm([{ text: full }, { text: '$ echo hi' }], { cols: 20 });
      const t = new CommandOutputTracker(f.term);
      f.markAt(1);
      t.recordEnter();
      f.markAt(undefined);
      f.lines.push({ text: 'hi' }, { text: '$ ' });
      expect(t.lastCommand()).toBe('echo hi');
    });
  });

  describe('OSC 133 as bash with the VTE script sends it (C on the row after the command)', () => {
    /** Prompt row, command typed, newline, `C` on the first output row, output, `D` on the next prompt row. */
    function run(opts: { command: string; output: string[]; sendB?: boolean; cols?: number }) {
      const f = fakeTerm([{ text: '$ ' }], { cols: opts.cols });
      const t = new CommandOutputTracker(f.term);
      f.osc('A');
      if (opts.sendB !== false) f.osc('B');
      f.lines[0].text = `$ ${opts.command}`;
      t.recordEnter();
      f.lines.push({ text: '' });
      f.osc('C');
      f.lines[f.lines.length - 1].text = opts.output[0];
      for (const line of opts.output.slice(1)) f.lines.push({ text: line });
      f.lines.push({ text: '' });
      f.osc('D;1');
      f.lines[f.lines.length - 1].text = '$ ';
      return { t, f };
    }

    it('reads the command without the first output row, and the exit code', () => {
      const { t } = run({ command: 'cat /x', output: ['cat: /x: Permission denied'] });
      expect(t.lastCommandResult()).toEqual({
        command: 'cat /x',
        output: 'cat: /x: Permission denied',
        exitCode: 1,
      });
      expect(t.lastCommand()).toBe('cat /x');
    });

    it('keeps several output rows out of the command', () => {
      const { t } = run({ command: 'ls /root', output: ['ls: cannot open directory: Permission denied', 'second'] });
      expect(t.lastCommandResult()?.command).toBe('ls /root');
      expect(t.lastCommandResult()?.output).toBe('ls: cannot open directory: Permission denied\nsecond');
    });

    it('still reads the command from a shell that marks C on the command row itself', () => {
      const f = fakeTerm([{ text: '$ ' }]);
      const t = new CommandOutputTracker(f.term);
      f.osc('B');
      f.lines[0].text = '$ cat /x';
      f.osc('C');
      f.lines.push({ text: 'cat: /x: Permission denied' }, { text: '' });
      f.osc('D;1');
      f.lines[f.lines.length - 1].text = '$ ';
      expect(t.lastCommandResult()?.command).toBe('cat /x');
    });

    it('falls back to the row where Enter was pressed when the shell sends no B mark', () => {
      const { t } = run({ command: 'cat /x', output: ['cat: /x: Permission denied'], sendB: false });
      expect(t.lastCommandResult()).toEqual({ command: 'cat /x', output: 'cat: /x: Permission denied' });
    });
  });

  describe('prompts the patterns do not know', () => {
    it.each([
      ['bash-5.3$ ', 'raw bash'],
      ['alun@fedora ~ % ', 'zsh default'],
      ['alun@fedora ~> ', 'fish default'],
      ['(venv) bash-5.3$ ', 'bash with a virtualenv'],
    ])('reads the command after %j (%s)', (prompt) => {
      const f = fakeTerm([{ text: `${prompt}cat /x` }]);
      const t = new CommandOutputTracker(f.term);
      t.recordEnter();
      f.lines.push({ text: 'cat: /x: Permission denied' }, { text: prompt });
      expect(t.lastCommandResult()).toEqual({ command: 'cat /x', output: 'cat: /x: Permission denied' });
    });

    it('does not take a full-width row of output above an unknown prompt for part of the command', () => {
      const f = fakeTerm([{ text: 'x'.repeat(20) }, { text: 'bash-5.3$ ls /root' }], { cols: 20 });
      const t = new CommandOutputTracker(f.term);
      f.markAt(1);
      t.recordEnter();
      f.markAt(undefined);
      f.lines.push({ text: 'ls: cannot open directory: Permission denied' }, { text: 'bash-5.3$ ' });
      expect(t.lastCommandResult()?.command).toBe('ls /root');
    });

    it('stripPromptLoose leaves a line without a prompt alone, and stripPrompt stays strict', () => {
      expect(stripPromptLoose('Password: secret')).toBe('Password: secret');
      expect(stripPromptLoose('bash-5.3$ ls -la')).toBe('ls -la');
      expect(stripPromptLoose('$ ls')).toBe('ls');
      expect(stripPrompt('bash-5.3$ ls')).toBe('bash-5.3$ ls');
    });

    it('endsAtPrompt needs a terminator and a space right before the cursor and nothing after it', () => {
      expect(endsAtPrompt('bash-5.3$ ', '')).toBe(true);
      expect(endsAtPrompt('alun@fedora ~ % ', '   ')).toBe(true);
      expect(endsAtPrompt('Enter value: ', '')).toBe(false);
      expect(endsAtPrompt('bash-5.3$ ls', '')).toBe(false);
      expect(endsAtPrompt('bash-5.3$ ', 'ls')).toBe(false);
      // A right-hand prompt after a gap is part of the prompt, text right after the cursor is not.
      expect(endsAtPrompt('alun@fedora ~> ', '        21:04:07')).toBe(true);
      expect(endsAtPrompt('alun@fedora ~> ', ' 21:04')).toBe(false);
    });
  });

  describe('a shell that sends OSC 133 marks replaced by one that does not', () => {
    /** One command marked the way bash with the VTE script or fish marks it, then the shell without marks. */
    function setup() {
      const f = fakeTerm([{ text: '$ ' }]);
      const t = new CommandOutputTracker(f.term);
      f.osc('A');
      f.osc('B');
      f.lines[0].text = '$ ls /etc';
      t.recordEnter();
      f.lines.push({ text: '' });
      f.osc('C');
      f.lines[f.lines.length - 1].text = 'old output from the marked shell';
      f.lines.push({ text: '' });
      f.osc('D;0');
      f.lines[f.lines.length - 1].text = '$ ';
      return { f, t };
    }

    it('reads the command typed after the switch, not the old marked one', () => {
      const { f, t } = setup();
      f.lines[f.lines.length - 1].text = '$ cat /x';
      t.recordEnter();
      f.lines.push({ text: 'cat: /x: Permission denied' }, { text: '$ ' });

      expect(t.lastCommandResult()).toEqual({ command: 'cat /x', output: 'cat: /x: Permission denied' });
      expect(t.lastCommand()).toBe('cat /x');
      expect(t.lastOutput()).toBe('cat: /x: Permission denied');
      expect(t.debugSnapshot().mode).toBe('enter-marker');
    });

    it('still uses the marks for a command the marked shell ran after the Enter', () => {
      const { f, t } = setup();
      f.osc('B');
      f.lines[f.lines.length - 1].text = '$ cat /x';
      t.recordEnter();
      f.lines.push({ text: '' });
      f.osc('C');
      f.lines[f.lines.length - 1].text = 'cat: /x: Permission denied';
      f.lines.push({ text: '' });
      f.osc('D;1');
      f.lines[f.lines.length - 1].text = '$ ';

      expect(t.lastCommandResult()).toEqual({
        command: 'cat /x',
        output: 'cat: /x: Permission denied',
        exitCode: 1,
      });
      expect(t.debugSnapshot().mode).toBe('osc');
    });

    it('gives nothing for an Enter on an empty prompt, instead of the old command', () => {
      const { f, t } = setup();
      t.recordEnter();
      f.lines.push({ text: '$ ' });
      expect(t.lastCommandResult()).toBeNull();
    });
  });

  describe('lastCommandResult edge cases', () => {
    it('is null while the newest OSC command is still running, instead of an older result', () => {
      const f = fakeTerm([{ text: 'user@box:~$ ' }]);
      const t = new CommandOutputTracker(f.term);
      f.osc('B');
      f.lines[0].text = 'user@box:~$ cat /x';
      f.osc('C');
      f.lines.push({ text: 'cat: /x: Permission denied' }, { text: '' });
      f.osc('D;1');
      f.lines.pop();
      f.lines.push({ text: 'user@box:~$ ssh other' });
      f.osc('B');
      f.osc('C');
      f.lines.push({ text: 'me@other:~$ ' });
      expect(t.lastCommandResult()).toBeNull();
    });

    it('is null when Enter was an answer typed into a program, not a command at a prompt', () => {
      const f = fakeTerm([{ text: 'Continue? [Y/n] y' }]);
      const t = new CommandOutputTracker(f.term);
      t.recordEnter();
      f.lines.push({ text: 'E: Could not open lock file x: Permission denied' }, { text: '$ ' });
      expect(t.lastCommandResult()).toBeNull();
    });

    it('still finds a wrapped command whose echo had not rendered when Enter was pressed', () => {
      const f = fakeTerm([{ text: '$ ' }]);
      const t = new CommandOutputTracker(f.term);
      t.recordEnter(); // the echo arrives after the keystroke
      f.lines[0].text = '$ cat /etc/shadow';
      f.lines.push({ text: 'cat: /etc/shadow: Permission denied' }, { text: '$ ' });
      expect(t.lastCommandResult()?.command).toBe('cat /etc/shadow');
    });
  });

  it('strips diverse prompt prefixes correctly without mutilating commands', () => {
    expect(stripPrompt('$ ls -la')).toBe('ls -la');
    expect(stripPrompt('user@host:~$ ping 1.1.1.1')).toBe('ping 1.1.1.1');
    expect(stripPrompt('[root@srv /etc]# dnf update')).toBe('dnf update');
    expect(stripPrompt('➜ git:(main) git status')).toBe('git status');
    expect(stripPrompt('❯ cargo build')).toBe('cargo build');
    expect(stripPrompt('echo $HOME')).toBe('echo $HOME');
  });

  it('identifies full prompt lines and strips trailing prompt lines from output', async () => {
    const { isPromptLine, stripTrailingPrompt } = await import('./terminalOutput');
    expect(isPromptLine('alun@host:~$')).toBe(true);
    expect(isPromptLine('alun@host:~$ ')).toBe(true);
    expect(isPromptLine('[user@host dir]#')).toBe(true);
    expect(isPromptLine('$')).toBe(true);
    expect(isPromptLine('❯')).toBe(true);
    expect(isPromptLine('echo $HOME')).toBe(false);
    expect(isPromptLine('total 16')).toBe(false);

    const rawOutput = 'total 16\n-rw-r--r-- 1 alun alun 100 Oct 17 15:00 test.txt\nalun@host:~$';
    expect(stripTrailingPrompt(rawOutput)).toBe('total 16\n-rw-r--r-- 1 alun alun 100 Oct 17 15:00 test.txt');

    // Multi-line starship / box-drawing prompts (Unicode and ASCII dash variants)
    expect(isPromptLine('╭─ alun@fedora in ~ [2026-10-17 15:51]')).toBe(true);
    expect(isPromptLine('╭- alun@fedora in ~ [2026-10-17 15:51]')).toBe(true);
    expect(isPromptLine('╰─$ ')).toBe(true);
    expect(isPromptLine('╰-$ ')).toBe(true);
    expect(isPromptLine('╰─❯')).toBe(true);
    expect(stripPrompt('╰─$ ls -la')).toBe('ls -la');
    expect(stripPrompt('╰-$ ls -la')).toBe('ls -la');

    const multiLinePromptOutput =
      'output line 1\noutput line 2\n╭─ alun@fedora in ~ [2026-10-17 15:51]\n╰─$ ';
    expect(stripTrailingPrompt(multiLinePromptOutput)).toBe('output line 1\noutput line 2');

    const asciiPromptOutput =
      'output line 1\noutput line 2\n╭- alun@fedora in ~ [2026-10-17 15:51]\n╰-$ ';
    expect(stripTrailingPrompt(asciiPromptOutput)).toBe('output line 1\noutput line 2');
  });

  it('extracts CWD from diverse prompt formats', async () => {
    const { extractCwdFromPrompt } = await import('./terminalOutput');
    expect(extractCwdFromPrompt('╭─ alun@fedora in ~ [2026-10-17 15:51]', '/home/alun')).toBe('/home/alun');
    expect(extractCwdFromPrompt('╭─ alun@fedora in /etc [2026-10-17 15:51]', '/home/alun')).toBe('/etc');
    expect(extractCwdFromPrompt('╭─ alun@fedora in ~/projects [2026-10-17 15:51]', '/home/alun')).toBe('/home/alun/projects');
    expect(extractCwdFromPrompt('alun@host:/var/log$ ', '/home/alun')).toBe('/var/log');
    expect(extractCwdFromPrompt('[root@box /etc/nginx]# ', '/home/alun')).toBe('/etc/nginx');
    expect(extractCwdFromPrompt('\u001b[01;32malun@fedora\u001b[00m:\u001b[01;34m/var/www\u001b[00m$ ', '/home/alun')).toBe('/var/www');
    expect(extractCwdFromPrompt('user@macbook /usr/local/bin % ', '/home/alun')).toBe('/usr/local/bin');
    expect(extractCwdFromPrompt('user@host:~/sshs3 (feat/smart-terminal-editor) $ ', '/home/alun')).toBe('/home/user/sshs3');
    expect(extractCwdFromPrompt('alun@remote: /var/log', '/home/alun')).toBe('/var/log');
    expect(extractCwdFromPrompt('root@box:~# ', '/home/alun')).toBe('/root');
    expect(extractCwdFromPrompt('ubuntu@remote:~$ ', '/home/alun')).toBe('/home/ubuntu');
    expect(extractCwdFromPrompt('total 16', '/home/alun')).toBe(null);
    expect(extractCwdFromPrompt('built in 1s', '/home/alun')).toBe(null);
    expect(extractCwdFromPrompt('done in 1', '/home/alun')).toBe(null);
    expect(extractCwdFromPrompt('finished in 12ms', '/home/alun')).toBe(null);
    expect(extractCwdFromPrompt('1/avanza.png', '/home/alun')).toBe(null);
  });

  it('copies clean output to clipboard via copyCleanOutputToClipboard helper', async () => {
    const { copyCleanOutputToClipboard } = await import('./terminalOutput');
    const f = fakeTerm([{ text: '$ echo test' }]);
    const t = new CommandOutputTracker(f.term);
    t.recordEnter();
    f.lines.push({ text: 'output line 1' }, { text: '$ ' });

    let written = '';
    const orig = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (s: string) => { written = s; } },
      configurable: true,
    });

    const res = await copyCleanOutputToClipboard(t);
    expect(res?.text).toBe('output line 1');
    expect(written).toBe('output line 1');

    Object.defineProperty(navigator, 'clipboard', {
      value: orig,
      configurable: true,
    });
  });
});

describe('Windows prompts in clean output', () => {
  it('strips PowerShell and cmd prompts', async () => {
    const { stripPrompt, stripTrailingPrompt } = await import('./terminalOutput');
    expect(stripPrompt('PS C:\\Users\\alun> Get-ChildItem')).toBe('Get-ChildItem');
    expect(stripPrompt('C:\\Users\\alun>dir')).toBe('dir');
    expect(stripTrailingPrompt('line one\nline two\nPS C:\\Users\\alun>')).toBe('line one\nline two');
  });
});

describe('extractCwdFromPrompt on Windows shells', () => {
  it('reads PowerShell and cmd prompts, including paths with spaces and a typed command', async () => {
    const { extractCwdFromPrompt } = await import('./terminalOutput');
    expect(extractCwdFromPrompt('PS C:\\Users\\alun\\sshs3> ')).toBe('C:\\Users\\alun\\sshs3');
    expect(extractCwdFromPrompt('PS C:\\Users\\alun\\sshs3> cat README.md')).toBe('C:\\Users\\alun\\sshs3');
    expect(extractCwdFromPrompt('C:\\Program Files\\App>')).toBe('C:\\Program Files\\App');
    expect(extractCwdFromPrompt('PS C:\\>')).toBe('C:\\');
  });
});

describe('OSC 133 from a shell that only sends C (bash with the VTE script via PS0)', () => {
  /** `C` lands on the row after the command; the next prompt row holds the next command when Enter is pressed. */
  function firstCommand() {
    const f = fakeTerm([{ text: '$ cat /x' }]);
    const t = new CommandOutputTracker(f.term);
    t.recordEnter();
    f.lines.push({ text: '' });
    f.osc('C');
    f.lines[1].text = 'cat: /x: Permission denied';
    f.lines.push({ text: '$ ' });
    return { f, t };
  }

  it('keeps the newest command unfinished until the caller says the shell is at a prompt', () => {
    const { t } = firstCommand();
    expect(t.lastCommandResult()).toBeNull();
    expect(t.lastCommandResult({ atPrompt: true })).toEqual({
      command: 'cat /x',
      output: 'cat: /x: Permission denied',
    });
  });

  it('reads each command and its own output once a second C has shown the shell only sends C', () => {
    const { f, t } = firstCommand();
    f.lines[2].text = '$ cat /y';
    t.recordEnter();
    f.lines.push({ text: '' });
    f.osc('C');
    f.lines[3].text = 'cat: /y: Permission denied';
    f.lines.push({ text: '$ ' });
    expect(t.lastCommandResult()).toEqual({ command: 'cat /y', output: 'cat: /y: Permission denied' });
    expect(t.lastOutput()).toBe('cat: /y: Permission denied');
  });

  it('does not take the next command row as output of the previous one', () => {
    const { f, t } = firstCommand();
    f.lines[2].text = '$ ls';
    t.recordEnter();
    f.lines.push({ text: '' });
    f.osc('C');
    // Nothing was printed by `ls`; the previous command's output must not be attributed to it.
    f.lines.push({ text: '$ ' });
    expect(t.lastCommandResult()).toBeNull();
  });

  it('treats a repeated C on the same row as the same command', () => {
    const { f, t } = firstCommand();
    f.markAt(1); // the same row the first C was marked on
    f.osc('C');
    expect(t.lastCommandResult()).toBeNull();
  });
});
