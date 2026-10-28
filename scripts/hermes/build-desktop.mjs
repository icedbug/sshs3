import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(workspace, 'build-resources/hermes-desktop/source');
const app = path.join(source, 'apps/desktop');
const index = process.argv.indexOf('--dependencies');
if (index >= 0 && (!process.argv[index + 1] || process.argv[index + 1].startsWith('--'))) throw new Error('Missing --dependencies directory.');
const dependencies = index < 0 ? source : path.resolve(process.argv[index + 1]);
const externalDependencies = dependencies !== source;
const targetArchIndex = process.argv.indexOf('--arch');
const targetArch = targetArchIndex < 0 ? process.arch : process.argv[targetArchIndex + 1];
if (!['x64', 'arm64'].includes(targetArch)) throw new Error('Desktop target architecture must be x64 or arm64.');
const pinPath = path.join(source, '../source-pin.json');
const legacyPinPath = path.join(source, '../manifest.json');
// PM reserves a parent manifest.json for its assembled agent payload. A frontend
// source pin must not masquerade as that payload and redirect lazy tool installs.
if (!fs.existsSync(pinPath)) fs.renameSync(legacyPinPath, pinPath);
else if (fs.existsSync(legacyPinPath)) fs.unlinkSync(legacyPinPath);
const manifest = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
if (externalDependencies) {
  execFileSync('git', ['-C', dependencies, 'cat-file', '-e', `${manifest.commit}^{commit}`]);
  if (!fs.readFileSync(path.join(dependencies, 'package-lock.json')).equals(fs.readFileSync(path.join(source, 'package-lock.json')))) throw new Error('Frontend dependency checkout must use the pinned Hermes lock.');
}
const modules = path.join(source, 'node_modules');
if (externalDependencies && fs.existsSync(modules) && !fs.lstatSync(modules).isSymbolicLink()) {
  // Only our minimal staged runtime dependency directory is replaced, never an external tree.
  const resolved = fs.realpathSync(modules);
  if (!resolved.startsWith(source + path.sep)) throw new Error('Unexpected dependency directory outside staged source');
  fs.rmSync(modules, { recursive: true });
} else if (fs.existsSync(modules) && fs.lstatSync(modules).isSymbolicLink()) fs.unlinkSync(modules);
if (externalDependencies) fs.symlinkSync(path.join(dependencies, 'node_modules'), modules, process.platform === 'win32' ? 'junction' : 'dir');
else {
  const { prepareNodeDependencies } = await import(pathToFileURL(path.join(source, 'scripts/build/node-deps.mjs')).href);
  prepareNodeDependencies({ source, workspaces: ['apps/desktop'], reuse: true, env: {
    ...process.env, npm_config_cache: path.join(workspace, '.npm-cache/hermes-desktop-npm'),
  } });
}
fs.mkdirSync(path.join(app, 'node_modules'), { recursive: true });
const yaml = path.join(workspace, '.npm-cache/hermes-desktop-build-deps/node_modules/yaml');
if (fs.existsSync(yaml)) fs.cpSync(yaml, path.join(app, 'node_modules/yaml'), { recursive: true });
for (const entry of fs.readdirSync(path.join(dependencies, 'apps/desktop/node_modules'))) {
  if (entry.startsWith('.') || entry === 'electron') continue;
  if (!externalDependencies) continue;
  fs.cpSync(path.join(dependencies, 'apps/desktop/node_modules', entry), path.join(app, 'node_modules', entry), { recursive: true, dereference: true });
}

function replaceOnce(file, before, after) {
  const original = fs.readFileSync(file, 'utf8');
  if (original.includes(after)) return;
  if (original.split(before).length !== 2) throw new Error(`Pinned Hermes adapter anchor changed: ${path.relative(source, file)}`);
  fs.writeFileSync(file, original.replace(before, after));
}
replaceOnce(path.join(app, 'electron/main.ts'), 'const APP_ROOT = app.getAppPath()', "const APP_ROOT = path.resolve(import.meta.dirname, '..')");
const mainWindowSource = path.join(app, 'electron/main.ts');
const oldWindowHandoff = "process.emit('sshs3:hermes:main-window' as never, mainWindow)";
const newWindowHandoff = "process.emit('sshs3:hermes:main-window' as never, mainWindow, chatWindowWebPreferences(PRELOAD_PATH))";
if (fs.readFileSync(mainWindowSource, 'utf8').includes(oldWindowHandoff)) replaceOnce(mainWindowSource, oldWindowHandoff, newWindowHandoff);
else replaceOnce(mainWindowSource, 'const createdMainWindow = mainWindow', `const createdMainWindow = mainWindow\n  ${newWindowHandoff}`);
replaceOnce(path.join(app, 'electron/main.ts'), 'function registerDeepLinkProtocol() {', "function registerDeepLinkProtocol() {\n  // The hosted app must not replace the user's standalone Hermes URL handler.\n  if (process.env.SSHS3_NATIVE_HERMES === '1') return");
replaceOnce(path.join(app, 'electron/main.ts'), "app.setAppUserModelId(IDENTITY_APP_NAME ? PRODUCT_IDENTITY.appId : 'com.nousresearch.hermes')", "app.setAppUserModelId(process.env.SSHS3_NATIVE_HERMES === '1' ? 'com.sshs3.aihub' : IDENTITY_APP_NAME ? PRODUCT_IDENTITY.appId : 'com.nousresearch.hermes')");
replaceOnce(path.join(app, 'electron/main.ts'), "const APP_NAME: string = IDENTITY_APP_NAME || process.env.HERMES_DESKTOP_APP_NAME || 'Hermes'", "const APP_NAME: string = process.env.SSHS3_NATIVE_HERMES === '1' ? 'sshs3 AI Hub' : IDENTITY_APP_NAME || process.env.HERMES_DESKTOP_APP_NAME || 'Hermes'");
replaceOnce(path.join(app, 'electron/main.ts'), 'async function ensureRuntime(\n  backend: ResolvedHermesBackend,\n  assertStillOwned: () => void\n): Promise<ResolvedHermesBackend> {', "async function ensureRuntime(\n  backend: ResolvedHermesBackend,\n  assertStillOwned: () => void\n): Promise<ResolvedHermesBackend> {\n  if (process.env.SSHS3_NATIVE_HERMES === '1' && backend.bootstrap) {\n    throw new Error('The sshs3 Hermes runtime is unavailable. Reinstall sshs3 AI Hub to restore the pinned runtime.')\n  }");
const preload = path.join(app, 'electron/preload.ts');
const preloadSource = fs.readFileSync(preload, 'utf8').split('\n// App-specific capability; native Hermes capabilities remain untouched.')[0];
fs.writeFileSync(preload, preloadSource + '\n' + fs.readFileSync(path.join(workspace, 'integrations/hermes-desktop/preload-extension.cjs'), 'utf8'));
fs.copyFileSync(path.join(workspace, 'integrations/hermes-desktop/renderer-extension.tsx'), path.join(app, 'src/sshs3-extension.tsx'));
fs.copyFileSync(path.join(workspace, 'integrations/hermes-desktop/presentation.ts'), path.join(app, 'src/sshs3-presentation.ts'));
fs.copyFileSync(path.join(workspace, 'integrations/hermes-desktop/terminal-controls.tsx'), path.join(app, 'src/sshs3-terminal-controls.tsx'));
fs.mkdirSync(path.join(app, 'src/sshs3-shared'), { recursive: true });
for (const type of ['nativeHermes', 'aiHub', 'ai']) fs.copyFileSync(path.join(workspace, 'src/shared/types', type + '.ts'), path.join(app, 'src/sshs3-shared', type + '.ts'));
fs.cpSync(path.join(workspace, 'integrations/hermes-desktop/sshs3_terminal'), path.join(source, 'plugins/sshs3_terminal'), { recursive: true });
const controller = path.join(app, 'src/app/contrib/controller.tsx');
replaceOnce(controller, "import { SidebarProvider } from '@/components/ui/sidebar'", "import { SidebarProvider } from '@/components/ui/sidebar'\nimport { Sshs3TerminalControls } from '@/sshs3-terminal-controls'");
replaceOnce(controller, '<LayoutTreeRoot titlebar />', '<LayoutTreeRoot titlebar />\n          <Sshs3TerminalControls />');
const onboarding = path.join(app, 'src/components/onboarding/index.tsx');
replaceOnce(onboarding, "'fixed inset-0 z-(--z-onboarding) flex", "'fixed inset-0 z-(--z-onboarding) sshs3-full-surface flex");
replaceOnce(path.join(app, 'electron/terminal-ipc.ts'), 'const env = { ...process.env }', 'const env = { ...process.env }\n    delete env.SSHS3_NATIVE_TOOL_KEY\n    delete env.SSHS3_NATIVE_TOOL_URL');
const treeRenderer = path.join(app, 'src/components/pane-shell/tree/renderer/index.tsx');
replaceOnce(treeRenderer, "import { useStore } from '@nanostores/react'", "import { useStore } from '@nanostores/react'\nimport { $sshs3Compact, sshs3PresentationTree } from '@/sshs3-presentation'");
replaceOnce(treeRenderer, 'const tree = useStore($layoutTree)', 'const tree = sshs3PresentationTree(useStore($layoutTree), useStore($sshs3Compact))');
const renderer = path.join(app, 'src/main.tsx');
if (!fs.readFileSync(renderer, 'utf8').includes('./sshs3-extension')) fs.appendFileSync(renderer, "\nimport './sshs3-extension';\n");

try {
  process.chdir(app);
  const { build } = await import(pathToFileURL(path.join(dependencies, 'node_modules/vite/dist/node/index.js')).href);
  if (!process.argv.includes('--main-only')) await build({ root: app, configFile: path.join(app, 'vite.config.ts') });
  const { bundleElectronMain } = await import(pathToFileURL(path.join(app, 'scripts/bundle-electron-main.mjs')).href);
  const stamp = {
    schemaVersion: 1, commit: manifest.commit, commitDate: null, branch: null,
    builtAt: new Date().toISOString(), dirty: true, source: 'local',
    distribution: 'sshs3', updateMechanism: 'external',
    baseVersion: manifest.desktopVersion, displayVersion: `${manifest.desktopVersion} (sshs3)`,
    distance: null, payload: 'bootstrap', tag: null,
  };
  const stampPath = path.join(app, 'build/install-stamp.json');
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  fs.writeFileSync(stampPath, JSON.stringify(stamp, null, 2) + '\n');
  // This is a host-owned source launch contract, not Hermes' agent-payload
  // layout. External ownership disables native update/uninstall handoffs.
  fs.writeFileSync(path.join(source, 'install-stamp.json'), JSON.stringify(stamp, null, 2) + '\n');
  await bundleElectronMain({ source, out: path.join(app, 'dist'), stamp: stampPath });
  const { buildHudModifierMonitor } = await import(pathToFileURL(path.join(app, 'scripts/build-hud-modifier-monitor.mjs')).href);
  const { buildCommandScreenshotMonitor } = await import(pathToFileURL(path.join(app, 'scripts/build-command-screenshot-monitor.mjs')).href);
  buildHudModifierMonitor({ source, distDir: path.join(app, 'dist'), platform: process.platform, arch: targetArch });
  buildCommandScreenshotMonitor({ source, distDir: path.join(app, 'dist'), platform: process.platform });
} finally {
  // Do not ship a dependency junction into the user's existing installation.
  if (fs.existsSync(modules) && fs.lstatSync(modules).isSymbolicLink()) fs.unlinkSync(modules);
}
const runtimeModules = path.join(app, 'build/sshs3-runtime-modules');
if (fs.existsSync(runtimeModules)) {
  const resolved = fs.realpathSync(runtimeModules);
  if (resolved !== runtimeModules || !resolved.startsWith(app + path.sep)) throw new Error('Unexpected native dependency staging path.');
  fs.rmSync(runtimeModules, { recursive: true });
}
fs.mkdirSync(runtimeModules, { recursive: true });
fs.cpSync(path.join(workspace, 'node_modules/node-pty'), path.join(runtimeModules, 'node-pty'), { recursive: true, dereference: true });
// get-windows is optional upstream. Preserve it when a real installed module
// is available, including its bindings/helpers; do not ship a placeholder.
const getWindows = [path.join(dependencies, 'apps/desktop/node_modules/get-windows'), path.join(dependencies, 'node_modules/get-windows')].find(candidate => fs.existsSync(path.join(candidate, 'package.json')));
if (getWindows) {
  const { stageGetWindowsInto } = await import(pathToFileURL(path.join(app, 'scripts/stage-native-deps.mjs')).href);
  stageGetWindowsInto(getWindows, path.join(runtimeModules, 'get-windows'), {
    platform: process.platform, arch: targetArch,
    install: () => { throw new Error('The selected dependency checkout has no window-enumeration binding; prepare dependencies in the staged workspace.'); },
  });
} else {
  console.warn('get-windows was not installed upstream; native window enumeration remains unavailable.');
}
if (fs.existsSync(modules)) {
  const resolved = fs.realpathSync(modules);
  if (resolved !== modules || !resolved.startsWith(source + path.sep)) throw new Error('Refusing to replace external frontend dependencies.');
  fs.rmSync(modules, { recursive: true });
}
fs.renameSync(runtimeModules, modules);
console.log(`Built original Hermes Desktop ${manifest.desktopVersion} (${manifest.commit.slice(0, 7)}).`);
