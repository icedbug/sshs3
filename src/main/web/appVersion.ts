import fs from 'node:fs';
import path from 'node:path';

/**
 * The version of sshs3 that is running, for the web server (the desktop app asks Electron). The web
 * build writes it into the bundle (scripts/build-web.mjs). Without that (a run from source, a test) it
 * is read from the package.json the code belongs to: the one beside or above this file, or the one in
 * the folder the server was started from.
 */

declare const __SSHS3_VERSION__: string | undefined;

let cached: string | undefined;

function fromPackageJson(start: string): string | undefined {
  let dir = start;
  for (let depth = 0; depth < 6; depth++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
      if (pkg.name === 'sshs3' && typeof pkg.version === 'string' && pkg.version) return pkg.version;
    } catch {
      // No package.json here, or not ours: look one folder up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function packageVersion(): string {
  if (cached) return cached;
  const built = typeof __SSHS3_VERSION__ === 'string' ? __SSHS3_VERSION__ : undefined;
  cached = built || fromPackageJson(import.meta.dirname ?? process.cwd()) || fromPackageJson(process.cwd()) || '0.0.0';
  return cached;
}
