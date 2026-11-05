import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { POLICY_DEFINITIONS } from '../../src/shared/types/policy';
import { parsePolicyConf, parsePolicyObject } from '../../src/main/policy/policyParse';

const root = path.join(__dirname, '../..');
const guide = fs.readFileSync(path.join(root, 'docs/user-guide/enterprise-deployment.md'), 'utf-8');
const example = fs.readFileSync(path.join(root, 'packaging/policy.conf.example'), 'utf-8');

/** Rows of the "Available Policies" table in the guide: name, type, the backticked allowed values. */
function guideRows(): Map<string, { type: string; values: string[] }> {
  const section = guide.split(/^## 2\. /m)[1]?.split(/^## 3\. /m)[0] ?? '';
  const rows = new Map<string, { type: string; values: string[] }>();
  for (const line of section.split(/\r?\n/)) {
    const cells = line.split('|').map((cell) => cell.trim());
    const name = /^`([A-Za-z0-9]+)`$/.exec(cells[1] ?? '')?.[1];
    if (!name) continue;
    rows.set(name, { type: cells[2], values: [...cells[3].matchAll(/`([^`]+)`/g)].map((m) => m[1]) });
  }
  return rows;
}

describe('policy documentation', () => {
  it('lists exactly the policies of POLICY_DEFINITIONS in the guide', () => {
    expect([...guideRows().keys()].sort()).toEqual(POLICY_DEFINITIONS.map((def) => def.id).sort());
  });

  it('states the right type and allowed values for each policy in the guide', () => {
    const rows = guideRows();
    for (const def of POLICY_DEFINITIONS) {
      const row = rows.get(def.id)!;
      expect(row.type, def.id).toBe(def.type === 'boolean' ? 'boolean' : 'text');
      if (def.type === 'boolean') expect(row.values, def.id).toEqual(['true', 'false']);
      if (def.type === 'enum') expect(row.values, def.id).toEqual([...def.values]);
    }
  });

  it('has an example line for every policy in policy.conf.example, and every example value is valid', () => {
    const ids: string[] = POLICY_DEFINITIONS.map((def) => def.id);
    const enabled = example
      .split(/\r?\n/)
      .map((line) => {
        const match = /^#\s*([A-Za-z0-9]+)\s*=\s*(.*)$/.exec(line);
        return match && ids.includes(match[1]) ? `${match[1]} = ${match[2]}` : null;
      })
      .filter((line): line is string => line !== null);

    const { raw, warnings } = parsePolicyConf(enabled.join('\n'));
    const parsed = parsePolicyObject(raw);
    expect([...warnings, ...parsed.warnings]).toEqual([]);
    expect(enabled.map((line) => line.split(' = ')[0]).sort()).toEqual([...ids].sort());
  });

  it('keeps the example file inert: parsed as shipped, it sets nothing', () => {
    const { raw, warnings } = parsePolicyConf(example);
    expect(Object.keys(raw)).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
