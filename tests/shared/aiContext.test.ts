import { describe, it, expect } from 'vitest';
import { clipContext, prepareContext } from '../../src/shared/aiContext';
import { AI_MAX_CONTEXT_CHARS } from '../../src/shared/types/ai';

describe('prepareContext', () => {
  it('masks the whole text before clipping it', () => {
    const body = Array.from({ length: 600 }, (_, i) => `MIIEvQIBADANBgkqhkiG9w0BAQEFAASC${String(i).padStart(4, '0')}`).join('\n');
    const key = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`; // pragma: allowlist secret
    const result = prepareContext(`${key}\nuser@host:~$ ls\n`);
    expect(result.text).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    expect(result.text).toContain('user@host:~$ ls');
    expect(result.count).toBeGreaterThan(0);
  });

  it('masks a key that runs past the end of the text even though its BEGIN line is outside the window', () => {
    // Without an END line only masking the whole text first catches the body: the last 16000 characters alone hold no marker.
    const body = Array.from({ length: 700 }, (_, i) => `MIIEvQIBADANBgkqhkiG9w0BAQEFAASC${String(i).padStart(4, '0')}`).join('\n');
    const raw = `-----BEGIN PRIVATE KEY-----\n${body}`; // pragma: allowlist secret
    expect(raw.length).toBeGreaterThan(AI_MAX_CONTEXT_CHARS * 1.2);
    const result = prepareContext(raw);
    expect(result.text).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    expect(result.clipped).toBe(false);
    expect(result.count).toBeGreaterThan(0);
  });

  it('counts only the masked values that are still in the clipped text', () => {
    const raw = `password=hunter2hunter2\n${'x'.repeat(AI_MAX_CONTEXT_CHARS)}\npassword=correcthorse1`; // pragma: allowlist secret
    const result = prepareContext(raw);
    expect(result.clipped).toBe(true);
    expect(result.count).toBe(1);
    expect(result.text).not.toContain('hunter2hunter2');
  });

  it('turns CRLF into LF and reports zero masked values for ordinary text', () => {
    expect(prepareContext('a\r\nb\rc')).toEqual({ text: 'a\nb\nc', count: 0, clipped: false });
  });

  it('shows and sends the same text: clipping keeps the end', () => {
    const result = prepareContext(`${'x'.repeat(AI_MAX_CONTEXT_CHARS)}THE ERROR`);
    expect(result.text.startsWith('[…earlier output omitted]')).toBe(true);
    expect(result.text.endsWith('THE ERROR')).toBe(true);
  });
});

describe('clipContext', () => {
  it('leaves short text alone', () => {
    expect(clipContext('short')).toBe('short');
  });
});
