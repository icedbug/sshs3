import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const launcher = fileURLToPath(new URL('../../scripts/hermes/build-desktop.mjs', import.meta.url));
const require = createRequire(import.meta.url);
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function createBuild(worker: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-hermes-build-'));
  temporary.push(root);
  const scripts = path.join(root, 'scripts/hermes');
  const source = path.join(root, 'build-resources/hermes-desktop/source');
  const runtime = path.join(source, 'apps/desktop/build/sshs3-runtime-modules');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });
  fs.copyFileSync(launcher, path.join(scripts, 'build-desktop.mjs'));
  fs.writeFileSync(path.join(scripts, 'prepare-desktop.mjs'), worker);
  fs.writeFileSync(path.join(source, '../source-pin.json'), JSON.stringify({ desktopVersion: 'test', commit: 'abcdef0' }));
  return {
    root, runtime, modules: path.join(source, 'node_modules'),
    run: (...args: string[]) => execFileSync(process.execPath, [path.join(scripts, 'build-desktop.mjs'), ...args], { stdio: 'pipe' }),
  };
}

it('releases a loaded native build dependency before replacing it with the runtime modules', () => {
  const build = createBuild(`
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const binding = createRequire(import.meta.url)(process.argv[2]);
    assert.equal(typeof binding[process.platform === 'win32' ? 'startProcess' : 'fork'], 'function');
  `);
  const name = process.platform === 'win32' ? 'conpty' : 'pty';
  const utils = require.resolve('node-pty/lib/utils');
  const { dir } = require(utils).loadNativeModule(name);
  const originalBinding = path.resolve(path.dirname(utils), dir, name + '.node');
  fs.mkdirSync(build.modules);
  const stagedBinding = path.join(build.modules, 'build-tool.node');
  fs.copyFileSync(originalBinding, stagedBinding);
  fs.mkdirSync(path.join(build.runtime, 'node-pty'));

  build.run(stagedBinding);

  expect(fs.readdirSync(build.modules)).toEqual(['node-pty']);
  expect(fs.existsSync(build.runtime)).toBe(false);
});

it('unlinks external dependencies on a failed build and leaves their contents intact', () => {
  const build = createBuild('process.exitCode = 3;');
  const external = path.join(build.root, 'external');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'marker'), 'preserved');
  fs.symlinkSync(external, build.modules, process.platform === 'win32' ? 'junction' : 'dir');

  expect(() => build.run()).toThrow();

  expect(fs.existsSync(build.modules)).toBe(false);
  expect(fs.readFileSync(path.join(external, 'marker'), 'utf8')).toBe('preserved');
  expect(fs.existsSync(build.runtime)).toBe(true);
});
