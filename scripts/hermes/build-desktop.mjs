import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../build-resources/hermes-desktop/source', import.meta.url));
const modules = path.join(source, 'node_modules');
const runtimeModules = path.join(source, 'apps/desktop/build/sshs3-runtime-modules');
const worker = fileURLToPath(new URL('./prepare-desktop.mjs', import.meta.url));

function requireStagedDirectory(directory) {
  if (path.relative(directory, fs.realpathSync(directory)) !== '' || !fs.statSync(directory).isDirectory()) {
    throw new Error(`Unexpected Hermes staging directory: ${directory}`);
  }
}

requireStagedDirectory(source);
try {
  // Windows keeps bundler and other native DLLs mapped until their Node process exits.
  execFileSync(process.execPath, [worker, ...process.argv.slice(2)], { stdio: 'inherit' });
} finally {
  // External build dependencies are linked temporarily. Remove only the junction itself.
  if (fs.lstatSync(modules, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(modules);
}

requireStagedDirectory(runtimeModules);
if (fs.existsSync(modules)) {
  requireStagedDirectory(modules);
  fs.rmSync(modules, { recursive: true, maxRetries: 5, retryDelay: 150 });
}
fs.renameSync(runtimeModules, modules);
const pin = JSON.parse(fs.readFileSync(path.join(source, '../source-pin.json'), 'utf8'));
console.log(`Built original Hermes Desktop ${pin.desktopVersion} (${pin.commit.slice(0, 7)}).`);
