import fs from 'node:fs';
import path from 'node:path';
import { app as electronApp } from 'electron';

export type AgeBinaryName = 'age' | 'age-keygen' | 'age-plugin-yubikey';

function binaryFileName(name: AgeBinaryName): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function platformDir(): 'win' | 'linux' {
  return process.platform === 'win32' ? 'win' : 'linux';
}

/**
 * Resolves the `age` / `age-plugin-yubikey` binary to invoke, in priority order:
 *
 * 1. The packaged build's bundled copy — electron-builder's `extraResources` (the `age` entry
 *    in electron-builder.json), same `process.resourcesPath` lookup XServerManager already uses
 *    for its bundled VcXsrv.
 * 2. The CI-fetched copy checked out for a local build (`build-resources/age/<platform>/`),
 *    so a dev build sees the same binary a packaged release would, without re-downloading it.
 * 3. The command found on the OS PATH (the bare name where that isn't possible) — lets a developer who already has
 *    `age`/`age-plugin-yubikey` installed (e.g. via a package manager) work on
 *    TeamVaultCryptoService without waiting on the CI-only download step.
 */
export function resolveAgeBinary(name: AgeBinaryName): string {
  const fileName = binaryFileName(name);

  try {
    const bundled = path.join(process.resourcesPath || '', 'age', fileName);
    if (fs.existsSync(bundled)) return bundled;
  } catch {
    // Not running in a packaged context — fall through.
  }

  try {
    const devPath = path.join(electronApp.getAppPath(), 'build-resources', 'age', platformDir(), fileName);
    if (fs.existsSync(devPath)) return devPath;
  } catch {
    // No app path available (e.g. outside Electron) — fall through.
  }

  // node-pty's ConPTY spawn needs a full path on Windows — it won't resolve a bare "age" through
  // PATH/PATHEXT the way execFile does — so look the .exe up on PATH ourselves.
  if (process.platform === 'win32') {
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH');
    for (const dir of (pathKey ? process.env[pathKey] ?? '' : '').split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, fileName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return name;
}
