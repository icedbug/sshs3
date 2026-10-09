import { describe, it, expect } from 'vitest';
import { buildPrompt, clipContext, describeEnvironment, parseCommandAnswer } from '../../src/main/ai/aiPrompt';
import { AI_MAX_CONTEXT_CHARS } from '../../src/shared/types/ai';

describe('buildPrompt', () => {
  it('builds a command request with the terminal environment', () => {
    const built = buildPrompt({ task: 'command', prompt: 'list the 5 largest files', environment: { kind: 'ssh' } });
    expect(built.system).toContain('exactly one command');
    expect(built.user).toContain('An SSH session');
    expect(built.user).toContain('Task: list the 5 largest files');
    expect(built.redacted).toBe(false);
  });

  it('includes terminal text and falls back to a default question when explaining', () => {
    const built = buildPrompt({ task: 'explain', prompt: '', context: 'bash: foo: command not found\r\n' });
    expect(built.system).toContain('Explain');
    expect(built.user).toContain('<terminal>\nbash: foo: command not found\n\n</terminal>');
    expect(built.user).toContain('Explain the terminal text above.');
  });

  it('masks secrets before anything is sent and says so', () => {
    const built = buildPrompt({
      task: 'explain',
      prompt: 'why is MYSQL_PASSWORD=hunter2 rejected?', // pragma: allowlist secret
      context: 'export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP\nAuthorization: Bearer abcdefghijklmnop', // pragma: allowlist secret
    });
    expect(built.user).not.toContain('hunter2');
    expect(built.user).not.toContain('AKIAABCDEFGHIJKLMNOP'); // pragma: allowlist secret
    expect(built.user).not.toContain('abcdefghijklmnop');
    expect(built.user).toContain('[redacted]');
    expect(built.redacted).toBe(true);
    expect(built.system).toContain('[redacted]');
  });
});

describe('clipContext', () => {
  it('keeps the end of long output', () => {
    const text = `${'a'.repeat(AI_MAX_CONTEXT_CHARS)}THE ERROR`;
    const clipped = clipContext(text);
    expect(clipped.startsWith('[…earlier output omitted]')).toBe(true);
    expect(clipped.endsWith('THE ERROR')).toBe(true);
    expect(clipContext('short')).toBe('short');
  });
});

describe('describeEnvironment', () => {
  it('names the local platform and shell', () => {
    expect(describeEnvironment({ kind: 'local', platform: 'win32', shell: 'powershell' })).toBe(
      'A local shell on Windows, shell: powershell.'
    );
    expect(describeEnvironment({ kind: 'k8s' })).toContain('Kubernetes');
    expect(describeEnvironment()).toBe('Unknown terminal.');
  });
});

describe('parseCommandAnswer', () => {
  it('takes the first fenced block as the command', () => {
    const parsed = parseCommandAnswer('```bash\ndu -ah /var | sort -rh | head -5\n```\nLists the five largest entries.');
    expect(parsed.command).toBe('du -ah /var | sort -rh | head -5');
    expect(parsed.explanation).toBe('Lists the five largest entries.');
  });

  it('accepts a bare single-line answer', () => {
    expect(parseCommandAnswer('$ ls -la\n')).toEqual({ command: 'ls -la', explanation: '' });
    expect(parseCommandAnswer('`uptime`')).toEqual({ command: 'uptime', explanation: '' });
  });

  it('returns no command for an empty block or prose', () => {
    expect(parseCommandAnswer('```\n```\nThat needs a GUI.').command).toBe('');
    expect(parseCommandAnswer('I cannot do that.\nIt needs a GUI.')).toEqual({
      command: '',
      explanation: 'I cannot do that.\nIt needs a GUI.',
    });
  });
});
