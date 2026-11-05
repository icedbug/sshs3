import { describe, it, expect } from 'vitest';
import { parsePolicyConf, parsePolicyObject, parseRegQueryOutput, registryValuesToRaw } from '../../src/main/policy/policyParse';
import { POLICY_DEFINITIONS, policyRegistryName } from '../../src/shared/types/policy';

describe('parsePolicyObject', () => {
  it('accepts valid settings and features', () => {
    const { policy, warnings } = parsePolicyObject({
      autoCheckUpdates: false,
      smartcardAuthMode: 'always-prompt',
      x11ServerArgs: ':0 -multiwindow',
      gitKeyFetch: false,
    });
    expect(warnings).toEqual([]);
    expect(policy.settings).toEqual({
      autoCheckUpdates: false,
      smartcardAuthMode: 'always-prompt',
      x11ServerArgs: ':0 -multiwindow',
    });
    expect(policy.features).toEqual({ gitKeyFetch: false });
  });

  it('drops unknown keys and wrong types but keeps the rest', () => {
    const { policy, warnings } = parsePolicyObject({
      autoCheckUpdates: 'no',
      smartcardAuthMode: 'forever',
      enableOpenShift: true,
      theme: 'dark',
    });
    expect(policy.settings).toEqual({ enableOpenShift: true });
    expect(warnings).toHaveLength(3);
    expect(warnings.join(' ')).toContain('Unknown policy "theme"');
  });

  it('rejects strings with control characters or over the length limit', () => {
    expect(parsePolicyObject({ x11ServerArgs: 'a\nb' }).policy.settings).toEqual({});
    expect(parsePolicyObject({ x11ServerArgs: 'a'.repeat(1025) }).policy.settings).toEqual({});
  });

  it.each([null, 'text', 5, [1, 2]])('rejects a non-object policy (%j)', (raw) => {
    const { policy, warnings } = parsePolicyObject(raw);
    expect(policy).toEqual({ settings: {}, features: {} });
    expect(warnings).toHaveLength(1);
  });

  it('does not let __proto__ keys reach the policy', () => {
    const { policy } = parsePolicyObject(JSON.parse('{"__proto__":{"autoCheckUpdates":false}}'));
    expect(policy.settings).toEqual({});
    expect(({} as Record<string, unknown>).autoCheckUpdates).toBeUndefined();
  });
});

describe('parsePolicyConf', () => {
  const policyOf = (text: string) => {
    const { raw, warnings } = parsePolicyConf(text);
    const parsed = parsePolicyObject(raw);
    return { settings: parsed.policy.settings, features: parsed.policy.features, warnings: [...warnings, ...parsed.warnings] };
  };

  it('reads name = value lines, comments and blank lines', () => {
    const result = policyOf(
      ['# Policy for all machines', '; another comment', '', 'autoCheckUpdates = false', 'smartcardAuthMode=always-prompt', 'gitKeyFetch = 0'].join('\n')
    );
    expect(result.warnings).toEqual([]);
    expect(result.settings).toEqual({ autoCheckUpdates: false, smartcardAuthMode: 'always-prompt' });
    expect(result.features).toEqual({ gitKeyFetch: false });
  });

  it('accepts registry-style names in any case, CRLF line ends, a BOM and a [sshs3] header', () => {
    const result = policyOf('\uFEFF[sshs3]\r\nAutoCheckUpdates = FALSE\r\nENABLEOPENSHIFT = True\r\n');
    expect(result.warnings).toEqual([]);
    expect(result.settings).toEqual({ autoCheckUpdates: false, enableOpenShift: true });
  });

  it('takes the rest of the line as the value, with # and ; inside it', () => {
    expect(policyOf('x11ServerArgs = :0 -multiwindow # not a comment; really').settings).toEqual({
      x11ServerArgs: ':0 -multiwindow # not a comment; really',
    });
    expect(policyOf('x11ServerArgs = a = b').settings.x11ServerArgs).toBe('a = b');
  });

  it('uses the first of a repeated name and says so', () => {
    const result = policyOf('autoCheckUpdates = false\nautoCheckUpdates = true');
    expect(result.settings).toEqual({ autoCheckUpdates: false });
    expect(result.warnings).toEqual(['Line 2: policy "autoCheckUpdates" is given more than once; the first value is used.']);
  });

  it('warns about lines it cannot use and keeps the rest', () => {
    const result = policyOf(['nonsense', '= value', '[other]', 'unknownPolicy = 1', 'smartcardAuthMode = forever', 'enableOpenShift = yes', 'autoCheckUpdates = false'].join('\n'));
    expect(result.settings).toEqual({ autoCheckUpdates: false });
    expect(result.warnings).toEqual([
      'Line 1 ignored: expected "name = value".',
      'Line 2 ignored: expected "name = value".',
      'Line 3 ignored: only a [sshs3] section is supported.',
      'Unknown policy "unknownPolicy" ignored.',
      'Policy "smartcardAuthMode" ignored: expected one of always-prompt, agent-per-session, agent-global.',
      'Policy "enableOpenShift" ignored: expected true or false.',
    ]);
  });

  it('treats __proto__ and constructor as unknown names', () => {
    const result = policyOf('__proto__ = x\nconstructor = y');
    expect(result.settings).toEqual({});
    expect(result.warnings).toEqual(['Unknown policy "__proto__" ignored.', 'Unknown policy "constructor" ignored.']);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('rejects control characters in text values', () => {
    expect(policyOf('x11ServerArgs = a\u0007b').settings).toEqual({});
  });
});

describe('registry parsing', () => {
  const output = [
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\sshs3',
    '    AutoCheckUpdates    REG_DWORD    0x0',
    '    SmartcardAuthMode    REG_SZ    always-prompt',
    '    X11ServerArgs    REG_SZ    :0 -multiwindow -clipboard',
    '    Other    REG_BINARY    00',
    '',
  ].join('\r\n');

  it('reads DWORD and string values and skips other types', () => {
    expect(parseRegQueryOutput(output)).toEqual({
      AutoCheckUpdates: 0,
      SmartcardAuthMode: 'always-prompt',
      X11ServerArgs: ':0 -multiwindow -clipboard',
    });
  });

  it('maps registry names to ids, DWORD to boolean, and passes unknown names through', () => {
    const raw = registryValuesToRaw({ AutoCheckUpdates: 0, EnableOpenShift: 1, smartcardauthmode: 'agent-global', Bogus: 1 });
    expect(raw).toEqual({ autoCheckUpdates: false, enableOpenShift: true, smartcardAuthMode: 'agent-global', Bogus: 1 });
    const { policy, warnings } = parsePolicyObject(raw);
    expect(policy.settings.autoCheckUpdates).toBe(false);
    expect(warnings).toEqual(['Unknown policy "Bogus" ignored.']);
  });

  it('derives registry names from ids', () => {
    expect(policyRegistryName('autoCheckUpdates')).toBe('AutoCheckUpdates');
    expect(new Set(POLICY_DEFINITIONS.map((d) => policyRegistryName(d.id))).size).toBe(POLICY_DEFINITIONS.length);
  });
});
