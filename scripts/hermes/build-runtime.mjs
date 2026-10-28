#!/usr/bin/env node
/** Build the native GUI's pinned engine with Hermes PM's frozen dependency graph.
 * node scripts/hermes/build-runtime.mjs [--source CHECKOUT_OR_STAGED_SOURCE]
 *   [--python BOOTSTRAP_PYTHON] [--out build-resources/hermes-native-runtime]
 *   [--arch x64|arm64] [--extras all,anthropic,sms,web,messaging,computer-use,voice] [--managed-tools]
 * The previous runtime and the user's installed environment stay intact until
 * the complete, separately built distribution has passed its import checks.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resources = path.join(workspace, 'build-resources');
const pin = JSON.parse(fs.readFileSync(new URL('./desktop-source.json', import.meta.url), 'utf8'));
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return argv[index + 1];
};
const source = path.resolve(option('--source', path.join(resources, 'hermes-desktop/source')));
const out = path.resolve(option('--out', path.join(resources, 'hermes-native-runtime')));
if (!out.startsWith(resources + path.sep) || out === source || source.startsWith(out + path.sep)) {
  throw new Error('Runtime output must be inside build-resources and separate from its source.');
}
const currentRuntime = [path.join(resources, 'hermes'), path.join(resources, 'hermes-native-runtime')]
  .find(candidate => fs.existsSync(path.join(candidate, 'manifest.json'))) || path.join(resources, 'hermes');
const previousManifest = path.join(currentRuntime, 'manifest.json');
const previous = fs.existsSync(previousManifest) ? JSON.parse(fs.readFileSync(previousManifest, 'utf8')) : null;
const bootstrapPython = option('--python', process.env.HERMES_PYTHON || (previous?.python ? path.join(currentRuntime, previous.python) : null));
if (!bootstrapPython) throw new Error('Provide a Python 3.11+ bootstrap interpreter with --python for the first runtime build.');
const interpreter = path.resolve(bootstrapPython);
if (!fs.existsSync(interpreter)) throw new Error('Provide an existing portable CPython interpreter with --python.');
const extras = option('--extras', 'all,anthropic,sms,web,messaging,computer-use,voice').split(',').filter(Boolean);
if (!extras.every(extra => /^[a-z][a-z0-9-]*$/.test(extra))) throw new Error('Invalid runtime extra name.');
const arch = option('--arch', process.arch);
if (!['x64', 'arm64'].includes(arch)) throw new Error('Runtime target architecture must be x64 or arm64.');
const target = `${process.platform}-${arch}`;
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const id = randomUUID();
const staged = path.join(resources, `.hermes-runtime-${id}`);
const state = path.join(workspace, '.npm-cache', `hermes-runtime-${id}`);
const code = path.join(staged, 'hermes-agent');
const excluded = new Set(['.git', '.github', 'node_modules', '.venv', 'venv', 'tests', 'tests-js', 'website', 'evals', 'apps', 'ui-tui', 'docker', 'nix', 'web']);
fs.mkdirSync(staged, { recursive: true });
fs.mkdirSync(state, { recursive: true });
let verified = false;
const renameHeld = async (from, to) => {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 9) throw error;
      await delay(Math.min(3000, 250 * (2 ** attempt)));
    }
  }
};
try {
  if (fs.existsSync(path.join(source, '.git'))) {
    run('git', ['-C', source, 'cat-file', '-e', `${pin.commit}^{commit}`]);
    for (const file of ['pyproject.toml', 'uv.lock', 'pm/lock.json']) {
      const bytes = execFileSync('git', ['-C', source, 'show', `${pin.commit}:${file}`]);
      if (createHash('sha256').update(bytes).digest('hex') !== sha256(path.join(source, file))) {
        throw new Error(`Dependency checkout does not match pinned Hermes: ${file}`);
      }
    }
    const archive = path.join(state, 'source.tar');
    run('git', ['-C', source, 'archive', '--format=tar', '-o', archive, pin.commit]);
    fs.mkdirSync(code, { recursive: true });
    run('tar', ['-xf', archive, '-C', code, ...[...excluded].flatMap(name => ['--exclude', name])]);
  } else {
    const sourcePin = JSON.parse(fs.readFileSync(path.join(source, '../source-pin.json'), 'utf8'));
    if (sourcePin.commit !== pin.commit) throw new Error('The staged source has a different Hermes revision.');
    fs.cpSync(source, code, {
      recursive: true, filter: from => !excluded.has(path.relative(source, from).split(path.sep)[0]),
    });
  }
  const hostPlugin = path.join(workspace, 'integrations/hermes-desktop/sshs3_terminal');
  if (fs.existsSync(hostPlugin)) fs.cpSync(hostPlugin, path.join(code, 'plugins/sshs3_terminal'), { recursive: true });
  const env = {
    ...process.env, HERMES_HOME: path.join(state, 'home'),
    HERMES_RUNTIME_DIR: path.join(state, 'tools'), PYTHONPATH: code,
    PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1',
  };
  run(interpreter, [fileURLToPath(new URL('./pm-build-runtime.py', import.meta.url)),
    '--source', code, '--out', staged, '--target', target,
    '--cache', path.join(workspace, '.npm-cache/hermes-uv-cache'), '--commit', pin.commit,
    '--desktop-version', pin.desktopVersion, '--extras', extras.join(','),
    ...(argv.includes('--managed-tools') ? ['--managed-tools'] : []),
  ], { cwd: code, env });
  fs.copyFileSync(path.join(code, 'LICENSE'), path.join(staged, 'LICENSE.hermes.txt'));
  fs.copyFileSync(new URL('./sshs3_bootstrap.py', import.meta.url), path.join(staged, 'sshs3_bootstrap.py'));
  const manifest = JSON.parse(fs.readFileSync(path.join(staged, 'manifest.json'), 'utf8'));
  const python = path.join(staged, manifest.runtime.storePython);
  Object.assign(manifest, { commit: pin.commit, tag: null, python: path.relative(staged, python).split(path.sep).join('/'),
    lockSha256: sha256(path.join(code, 'uv.lock')), sourceRepository: pin.repository,
    hostExtensions: [...(fs.existsSync(hostPlugin) ? ['sshs3_terminal'] : []), 'sshs3_package_target', 'sshs3_portaudio'] });
  fs.writeFileSync(path.join(staged, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  run(python, ['-I', '-B', '-c', 'import hermes_cli.main, tui_gateway.server, anthropic; print(hermes_cli.main.__file__)'], {
    env: { ...env, PYTHONPATH: '' }, cwd: staged,
  });
  verified = true;
  const backup = path.join(resources, `.hermes-runtime-backup-${id}`);
  if (fs.existsSync(out)) await renameHeld(out, backup);
  try { await renameHeld(staged, out); }
  catch (error) { if (fs.existsSync(backup)) await renameHeld(backup, out); throw error; }
  if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true });
  console.log(`Built Hermes ${pin.commit.slice(0, 7)} from its frozen lock at ${out}.`);
} finally {
  if (fs.existsSync(staged) && !verified) fs.rmSync(staged, { recursive: true });
  else if (fs.existsSync(staged)) console.error(`Verified runtime retained for publication retry: ${staged}`);
}
