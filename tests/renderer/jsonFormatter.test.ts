import { describe, it, expect } from 'vitest';
import { formatJson } from '../../src/renderer/src/lib/jsonFormatter';

describe('formatJson', () => {
  it('formats unformatted valid JSON with 2-space indentation', () => {
    const raw = '{"a":1,"b":[2,3],"c":{"d":"val"}}';
    const res = formatJson(raw);
    expect(res.success).toBe(true);
    expect(res.formatted).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ],\n  "c": {\n    "d": "val"\n  }\n}');
  });

  it('handles empty input gracefully', () => {
    const res = formatJson('   ');
    expect(res.success).toBe(true);
    expect(res.formatted).toBe('   ');
  });

  it('returns failure with error message on malformed JSON', () => {
    const res = formatJson('{ a: 123 }');
    expect(res.success).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.formatted).toBeUndefined();
  });
});
