#!/usr/bin/env node
/**
 * Builds the portable Hermes Agent runtime that sshs3 ships in its installers
 * (electron-builder copies build-resources/hermes/ to <resources>/hermes/).
 *
 *   node scripts/hermes/build-runtime.mjs [--out build-resources/hermes]
 *
 * Needs `git` and `uv` (https://docs.astral.sh/uv/) on PATH. Everything that ends up in the
 * installer is pinned: the Hermes release (tag AND commit, checked after checkout), the Python
 * minor version, and every Python package by hash from Hermes' own uv.lock (--require-hashes).
 * Bump HERMES_TAG and HERMES_COMMIT together, deliberately, after reviewing the release.
 *
 * Output layout:
 *   python/<cpython-…>/          relocatable CPython (python-build-standalone) with Hermes' dependencies
 *   hermes-agent/                Hermes' source, installed into that Python in place (editable)
 *   manifest.json                { tag, commit, python: "<relative path to the interpreter>" }
 *   LICENSE.hermes.txt           Hermes' MIT license, shipped alongside it as the license requires
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERMES_REPO = 'https://github.com/NousResearch/hermes-agent';
const HERMES_TAG = 'v2026.9.24';
const HERMES_COMMIT = 'f97608f178d1ffeca59860195ab7da295f7c8e5f'; // pragma: allowlist secret
/** Hermes' pyproject.toml requires >=3.11,<3.14, and its uv.lock carries wheels up to cp313. */
const PYTHON_VERSION = '3.13';
/**
 * Optional dependency groups from Hermes' pyproject.toml:
 * - anthropic: the native Anthropic model provider.
 * - sms: only adds aiohttp, which the gateway's OpenAI-compatible API server needs.
 * Browser automation, computer use, voice and the messaging platforms are left out on purpose.
 */
const HERMES_EXTRAS = ['anthropic', 'sms'];
/** Top-level parts of the Hermes repository that the API server never loads. */
const EXCLUDED_SOURCE = new Set(['.git', '.github', 'tests', 'tests-js', 'website', 'evals', 'apps', 'ui-tui', 'docker', 'nix']);

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = path.resolve(outIndex >= 0 ? args[outIndex + 1] : 'build-resources/hermes');

function run(cmd, cmdArgs, options = {}) {
  console.log(`hermes-runtime: ${cmd} ${cmdArgs.join(' ')}`);
  return execFileSync(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf-8', ...options });
}

function findInterpreter(pythonDir) {
  const wanted = process.platform === 'win32' ? 'python.exe' : `python${PYTHON_VERSION}`;
  for (const entry of fs.readdirSync(pythonDir)) {
    // uv also adds a `cpython-3.13-…` symlink to the patch release; drop it so the installer holds one copy.
    if (fs.lstatSync(path.join(pythonDir, entry)).isSymbolicLink()) {
      fs.unlinkSync(path.join(pythonDir, entry));
      continue;
    }
    if (!entry.startsWith(`cpython-${PYTHON_VERSION}`)) continue;
    const candidate =
      process.platform === 'win32' ? path.join(pythonDir, entry, wanted) : path.join(pythonDir, entry, 'bin', wanted);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`No CPython ${PYTHON_VERSION} interpreter found under ${pythonDir}`);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-hermes-'));
try {
  const src = path.join(work, 'src');
  run('git', ['clone', '--quiet', '--depth', '1', '--branch', HERMES_TAG, HERMES_REPO, src]);
  const head = run('git', ['-C', src, 'rev-parse', 'HEAD']).trim();
  if (head !== HERMES_COMMIT) {
    throw new Error(`Hermes tag ${HERMES_TAG} points at ${head}, expected ${HERMES_COMMIT}. Refusing to build.`);
  }

  const requirements = path.join(work, 'requirements.txt');
  run(
    'uv',
    ['export', '--frozen', '--no-dev', '--no-emit-project', ...HERMES_EXTRAS.flatMap((e) => ['--extra', e]), '-o', requirements],
    { cwd: src }
  );

  fs.rmSync(outDir, { recursive: true, force: true });
  const pythonDir = path.join(outDir, 'python');
  fs.mkdirSync(pythonDir, { recursive: true });
  run('uv', ['python', 'install', PYTHON_VERSION, '--install-dir', pythonDir, '--no-bin']);
  const python = findInterpreter(pythonDir);

  const pipBase = ['pip', 'install', '--python', python, '--break-system-packages', '--no-cache'];
  // Wheels only: nothing is compiled on the build machine, so every platform gets the files the lock hashes.
  run('uv', [...pipBase, '--require-hashes', '--only-binary', ':all:', '-r', requirements]);

  // Hermes refuses to be built as a wheel and supports editable installs instead, so its source
  // ships next to the interpreter (without tests, docs and the desktop/TUI front ends) and is
  // installed in place. The editable install points at it with an absolute path; that path is
  // rewritten relative to site-packages so the runtime still works once the installer moves it.
  const hermesDir = path.join(outDir, 'hermes-agent');
  fs.cpSync(src, hermesDir, {
    recursive: true,
    filter: (from) => !EXCLUDED_SOURCE.has(path.relative(src, from).split(path.sep)[0]),
  });
  run('uv', [...pipBase, '--no-deps', '--config-settings', 'editable_mode=compat', '-e', hermesDir]);
  const sitePackages = run(python, ['-I', '-c', "import sysconfig; print(sysconfig.get_paths()['purelib'])"]).trim();
  let pointers = 0;
  for (const entry of fs.readdirSync(sitePackages)) {
    if (!entry.endsWith('.pth')) continue;
    const file = path.join(sitePackages, entry);
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    if (!lines.some((line) => path.resolve(line.trim()) === hermesDir)) continue;
    const relative = path.relative(sitePackages, hermesDir);
    fs.writeFileSync(file, `${lines.map((line) => (path.resolve(line.trim()) === hermesDir ? relative : line)).join('\n')}`);
    pointers++;
  }
  if (pointers !== 1) throw new Error(`Expected one .pth pointing at the Hermes source, found ${pointers}.`);
  if (fs.readdirSync(sitePackages).some((entry) => entry.startsWith('__editable__') && entry.endsWith('finder.py'))) {
    throw new Error('The editable install used an import finder with absolute paths; the runtime would not be relocatable.');
  }

  // Smoke check, isolated (-I) as sshs3 starts it: the modules it runs must import, Hermes' own
  // version must resolve, and the source must come from the bundled tree.
  const where = run(python, [
    '-I',
    '-c',
    'import importlib.metadata, hermes_cli.main, gateway.platforms.api_server, aiohttp, anthropic; ' +
      "print(importlib.metadata.version('hermes-agent')); print(hermes_cli.main.__file__)",
  ]);
  if (!path.resolve(where.trim().split(/\r?\n/).pop() ?? '').startsWith(hermesDir + path.sep)) {
    throw new Error(`Hermes imported from an unexpected place:\n${where}`);
  }

  fs.copyFileSync(path.join(src, 'LICENSE'), path.join(outDir, 'LICENSE.hermes.txt'));
  const manifest = {
    tag: HERMES_TAG,
    commit: HERMES_COMMIT,
    python: path.relative(outDir, python).split(path.sep).join('/'),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`hermes-runtime: done, ${JSON.stringify(manifest)}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
