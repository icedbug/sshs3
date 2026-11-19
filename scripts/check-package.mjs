import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { extractFile } from '@electron/asar';

const [executable, option] = process.argv.slice(2);
await access(executable);
const resources = path.join(path.dirname(executable), 'resources');
const archive = path.join(resources, 'app.asar');
const expected = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const installed = JSON.parse(extractFile(archive, 'package.json'));
assert.equal(installed.version, expected.version);
assert.equal(installed.main, expected.main);
if (process.env.GITHUB_SHA) assert.equal(installed.gitHead, process.env.GITHUB_SHA, 'Packaged Git revision differs from the workflow revision');
assert.ok(extractFile(archive, installed.main).length);
await access(path.join(resources, 'ai-hub-icon.png'));
const suffix = process.platform === 'win32' ? '.exe' : '';
if (process.platform === 'win32') await access(path.join(resources, 'vcxsrv', 'vcxsrv.exe'));
await access(path.join(resources, 'age', 'age' + suffix));
await access(path.join(resources, 'age', 'age-plugin-yubikey' + suffix));
if (option === '--hermes') {
  const json = async (name) => JSON.parse(await readFile(name, 'utf8'));
  const manifest = await json(path.join(resources, 'hermes', 'manifest.json'));
  const desktop = await json(path.join(resources, 'hermes-desktop', 'source-pin.json'));
  const pin = await json(new URL('./hermes/desktop-source.json', import.meta.url));
  assert.equal(manifest.target, process.platform + '-' + process.arch);
  assert.equal(manifest.commit, pin.commit);
  assert.equal(desktop.commit, pin.commit);
  await access(path.join(resources, 'hermes', manifest.runtime.storePython));
}
// The host's Node can have a different CPU and ABI. Load each binding in the shipped Electron.
const nativeProbe = `
  const fs = require('node:fs');
  const path = require('node:path');
  const archive = process.argv[1];
  const root = fs.existsSync(path.join(archive, 'package.json')) ? archive : archive + '.unpacked';
  const ptyBinding = process.platform === 'win32' ? 'conpty' : 'pty';
  const platform = process.platform + '-' + process.arch;
  if (process.env.SSHS3_EXPECTED_PACKAGE_ARCH && process.arch !== process.env.SSHS3_EXPECTED_PACKAGE_ARCH) throw new Error('Unexpected packaged architecture: ' + platform);
  let ok = true;
  for (const [name, candidates, method] of [
    ['node-pty', ['build/Release', 'build/Debug', 'prebuilds/' + platform].map(dir => dir + '/' + ptyBinding + '.node'), process.platform === 'win32' ? 'startProcess' : 'fork'],
    ['pkcs11js', ['build/Release/pkcs11.node'], 'PKCS11'],
  ]) {
    try {
      const file = candidates.map(file => path.join(root, 'node_modules', name, file)).find(file => fs.existsSync(file));
      if (!file) throw new Error('missing native binary for ' + platform);
      const binding = require(file);
      if (typeof binding[method] !== 'function') throw new Error('missing native export ' + method);
      if (name === 'pkcs11js') new binding.PKCS11();
      console.log(name + ' loaded in Electron ' + process.versions.electron + ' (' + platform + ')');
    } catch (error) {
      console.error(name + ': ' + error.message);
      ok = false;
    }
  }
  process.exitCode = ok ? 0 : 1;
`;
const probe = spawnSync(path.resolve(executable), ['-e', nativeProbe, path.resolve(archive)], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8', windowsHide: true, timeout: 20_000,
});
if (probe.stdout) process.stdout.write(probe.stdout);
if (probe.stderr) process.stderr.write(probe.stderr);
if (probe.error) throw probe.error;
assert.equal(probe.status, 0, 'The packaged native modules must load in Electron');
assert.ok(probe.stdout.includes('node-pty loaded in Electron') && probe.stdout.includes('pkcs11js loaded in Electron'), 'The packaged Electron did not complete the native checks');
console.log('Verified packaged application ' + installed.version);
