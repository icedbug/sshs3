import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { POLICY_DEFINITIONS, policyRegistryName } from '../../src/shared/types/policy';
import { registryPolicyKey } from '../../src/main/policy/policySources';

const dir = path.join(__dirname, '../../packaging/windows/policy');
const admx = fs.readFileSync(path.join(dir, 'sshs3.admx'), 'utf-8');
const adml = fs.readFileSync(path.join(dir, 'en-US', 'sshs3.adml'), 'utf-8');

/** Every value written by the ADMX, with the enum choices it allows. */
function admxValues(): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const policy of admx.split('<policy ').slice(1)) {
    const policyLevel = /valueName="([^"]+)"/.exec(policy.split('>')[0]);
    if (policyLevel) values.set(policyLevel[1], []);
    for (const element of policy.split(/<(?:enum|text) /).slice(1)) {
      const name = /valueName="([^"]+)"/.exec(element)![1];
      values.set(name, [...element.split('</enum>')[0].matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]));
    }
  }
  return values;
}

describe('Windows policy templates', () => {
  it('write exactly the registry values POLICY_DEFINITIONS reads', () => {
    expect([...admxValues().keys()].sort()).toEqual(
      POLICY_DEFINITIONS.map((def) => policyRegistryName(def.id)).sort()
    );
  });

  it('offer exactly the enum values the parser accepts', () => {
    const values = admxValues();
    for (const def of POLICY_DEFINITIONS) {
      if (def.type === 'enum') expect(values.get(policyRegistryName(def.id))).toEqual([...def.values]);
    }
  });

  it('use the registry key the app reads', () => {
    const keys = new Set([...admx.matchAll(/ key="([^"]+)"/g)].map((m) => m[1]));
    expect([...keys]).toEqual([registryPolicyKey().replace(/^HKLM\\/, '')]);
  });

  it('have an ADML string for every string the ADMX references', () => {
    const defined = new Set([...adml.matchAll(/<string id="([^"]+)"/g)].map((m) => m[1]));
    const referenced = [...admx.matchAll(/\$\(string\.([^)]+)\)/g)].map((m) => m[1]);
    expect(referenced.filter((id) => !defined.has(id))).toEqual([]);
  });
});
