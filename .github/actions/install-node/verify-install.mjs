import assert from 'node:assert/strict';
import { accessSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
  const moduleDir = 'node_modules/' + name;
  const installed = JSON.parse(readFileSync(path.join(moduleDir, 'package.json'), 'utf8'));
  assert.equal(installed.version, lock.packages[moduleDir].version, name);
}
for (const bin of ['tsc', 'vitest', 'vite', 'electron-builder']) {
  accessSync(path.join('node_modules', '.bin', bin + (process.platform === 'win32' ? '.cmd' : '')));
}
const require = createRequire(path.resolve('package.json'));
// Electron 45 extracts its executable on first import. Finish before parallel test workers start.
accessSync(require('electron'));
const onWindows = process.platform === 'win32';
const { module: pty } = require('node-pty/lib/utils').loadNativeModule(onWindows ? 'conpty' : 'pty');
assert.equal(typeof pty[onWindows ? 'startProcess' : 'fork'], 'function');
assert.equal(typeof require('pkcs11js').PKCS11, 'function');
