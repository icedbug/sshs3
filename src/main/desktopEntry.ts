import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app } from 'electron';
import './ai/desktop/nativeWindow';
import { nativeTools } from './ai/desktop/nativeTools';

// A detached GUI may outlive its launching shell. Closed stdio must not recurse through
// exception loggers or freeze the main process.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

// Launch unified sshs3 window directly (Path A). Legacy dual-WebContentsView native Hermes
// mode is only activated if explicitly requested via SSHS3_FORCE_NATIVE_HERMES=1.
if (process.env.SSHS3_FORCE_NATIVE_HERMES === '1') {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const desktop = app.isPackaged
    ? path.join(process.resourcesPath, 'hermes-desktop')
    : path.resolve(root, '../build-resources/hermes-desktop');
  const main = path.join(desktop, 'source/apps/desktop/dist/electron-main.mjs');
  if (!fs.existsSync(main)) throw new Error('Hermes Desktop has not been built. Run hermes:desktop:build first.');
  const userData = process.env.SSHS3_USER_DATA_DIR || (process.env.PORTABLE_EXECUTABLE_DIR
    ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data')
    : path.join(app.getPath('appData'), 'sshs3'));
  fs.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  process.env.SSHS3_NATIVE_HERMES = '1';
  process.env.HERMES_DESKTOP_USER_DATA_DIR = userData;
  process.env.HERMES_DESKTOP_ISOLATED_BACKEND = '1';
  process.env.HERMES_HOME = path.join(userData, 'hermes-native');
  process.env.HERMES_DESKTOP_HERMES_ROOT = path.join(desktop, 'source');
  const manifest = JSON.parse(fs.readFileSync(path.join(desktop, 'source-pin.json'), 'utf8')) as { commit?: string };
  if (manifest.commit !== 'f925b01791fe052e7d55dc975750c0bd985aff91') throw new Error('Hermes Desktop version does not match the host adapter.');
  const runtime = app.isPackaged ? path.join(process.resourcesPath, 'hermes')
    : path.resolve(root, '../build-resources/hermes-native-runtime');
  const runtimeManifest = JSON.parse(fs.readFileSync(path.join(runtime, 'manifest.json'), 'utf8')) as { python?: string; commit?: string; repo?: string };
  if (runtimeManifest.commit !== manifest.commit) throw new Error('Hermes engine and desktop versions do not match.');
  if (!runtimeManifest.python) throw new Error('The bundled Hermes Python interpreter is missing from its manifest.');
  const python = path.resolve(runtime, runtimeManifest.python);
  if (!python.startsWith(runtime + path.sep) || !fs.existsSync(python)) throw new Error('The bundled Hermes Python interpreter is unavailable.');
  process.env.HERMES_DESKTOP_PYTHON = python;
  if (runtimeManifest.repo) {
    const engine = path.resolve(runtime, runtimeManifest.repo);
    if (!engine.startsWith(runtime + path.sep) || !fs.existsSync(path.join(engine, 'hermes_cli/main.py'))) throw new Error('The bundled Hermes source is unavailable.');
    process.env.HERMES_DESKTOP_HERMES_ROOT = engine;
  }
  Object.assign(process.env, await nativeTools.start());
  await import(/* @vite-ignore */ pathToFileURL(main).href);
}
await import('./index');
