import fs from 'node:fs';
import path from 'node:path';

/** The uninstaller the NSIS installer writes next to the app (`Uninstall ${productFilename}.exe`). */
const NSIS_UNINSTALLER = 'Uninstall sshs3.exe';

/**
 * Whether this Windows copy of sshs3 was put there by the NSIS installer, the only kind electron-updater can update:
 * it downloads and runs that installer. An MSI install (IT deploys new versions), an unpacked ZIP and the portable exe
 * have no NSIS uninstaller beside the executable, and running the NSIS installer over them would leave a second,
 * separate copy. The portable exe runs from a temporary folder, so it is told apart by its own environment variable.
 * Not Windows: not applicable, so true.
 */
export function isNsisInstall(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  exists: (file: string) => boolean = fs.existsSync
): boolean {
  if (platform !== 'win32') return true;
  if (env.PORTABLE_EXECUTABLE_DIR) return false;
  return exists(path.win32.join(path.win32.dirname(execPath), NSIS_UNINSTALLER));
}
