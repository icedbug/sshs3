import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pin = JSON.parse(fs.readFileSync(new URL('./desktop-source.json', import.meta.url), 'utf8'));
const sourceIndex = process.argv.indexOf('--source');
let source = sourceIndex < 0 ? null : path.resolve(process.argv[sourceIndex + 1]);
const output = path.join(workspace, 'build-resources/hermes-desktop');
const tree = path.join(output, 'source');
const archive = path.join(output, 'source.tar');
fs.mkdirSync(output, { recursive: true });

if (!source) {
  source = path.join(workspace, '.npm-cache/hermes-desktop-checkout', pin.commit);
  fs.mkdirSync(source, { recursive: true });
  if (!fs.existsSync(path.join(source, '.git'))) execFileSync('git', ['init', '--quiet', source]);
  execFileSync('git', ['-C', source, 'fetch', '--quiet', '--depth=1', pin.repository, pin.commit], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: 'inherit',
  });
  execFileSync('git', ['-C', source, 'checkout', '--quiet', '--detach', pin.commit]);
}
execFileSync('git', ['-C', source, 'cat-file', '-e', `${pin.commit}^{commit}`]);
const links = execFileSync('git', ['-C', source, 'ls-tree', '-r', pin.commit], { encoding: 'utf8', maxBuffer: 16_000_000 })
  .split('\n').filter(line => line.startsWith('120000 ')).map(line => line.split('\t')[1]);
execFileSync('git', ['-C', source, 'archive', '--format=tar', '--prefix=hermes-source/', '-o', archive, pin.commit]);
const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8', maxBuffer: 16_000_000 }).trim().split('\n');
for (const entry of entries) {
  const relative = entry.replace(/^hermes-source\//, '');
  const target = path.resolve(tree, relative);
  if (path.isAbsolute(relative) || (target !== tree && !target.startsWith(tree + path.sep))) {
    throw new Error('Hermes archive contains a path outside its source directory.');
  }
}
fs.mkdirSync(tree, { recursive: true });
// Do not materialize fixture symlinks or follow their targets during staging.
const excludes = links.flatMap(link => ['--exclude', `hermes-source/${link}`]);
execFileSync('tar', ['-xf', archive, '-C', tree, '--strip-components', '1', ...excludes]);
fs.copyFileSync(path.join(tree, 'LICENSE'), path.join(output, 'LICENSE'));
fs.writeFileSync(path.join(output, 'source-pin.json'), JSON.stringify(pin, null, 2) + '\n');
const legacyPin = path.join(output, 'manifest.json');
if (fs.existsSync(legacyPin)) fs.unlinkSync(legacyPin);
console.log(`Staged pinned Hermes Desktop source (${entries.length} archive entries).`);
