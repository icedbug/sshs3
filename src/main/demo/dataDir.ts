import path from 'node:path';
import { demoWorkspaceDir } from './demoMode';

/**
 * Where a desktop process keeps its data. Decided here, from what the process was started with, and
 * applied by the entry files (index.ts, desktopEntry.ts) before anything reads the data folder: the
 * single-instance lock, the log file, every store and the renderer's Chromium profile all live in it.
 *
 * Nothing here touches Electron or the disk, so the decision can be tested as it is.
 */

export interface UserDataDirInput {
  /** Whether this process runs in demo mode (demo/demoMode.ts). */
  demoMode: boolean;
  /** Electron's data folder as it stands when the process starts (`app.getPath('userData')`). */
  defaultDir: string;
  platform: NodeJS.Platform;
  /** `PORTABLE_EXECUTABLE_DIR`: set by electron-builder for a portable executable. */
  portableDir?: string;
  /** The running executable (`process.execPath`). */
  execPath: string;
  /** Started against the Vite dev server (`VITE_DEV_SERVER_URL`): the executable is Electron's own then. */
  devServer: boolean;
  /** Whether a folder exists (`fs.existsSync`). */
  exists: (dir: string) => boolean;
}

export interface UserDataDir {
  /** The data folder of this process. */
  dir: string;
  /** Whether it is a demo's: made before use, and with the logs kept inside it. */
  demo: boolean;
  /**
   * Where a demo's logs go. macOS keeps an app's logs outside its data folder (~/Library/Logs/sshs3),
   * and a demo keeps everything of its own together.
   */
  logsDir?: string;
}

/**
 * The data folder of the regular desktop window's process.
 *
 * A portable executable keeps its data beside itself (`<exe folder>/data`), and so does a Windows build
 * that has a `data` folder next to the executable (the portable ZIP): the data travels with the program
 * and does not collide with an installed sshs3. Otherwise it is Electron's default.
 *
 * Demo mode keeps everything in `demo-workspace` inside that folder, whichever it is. A demo instance
 * so never reads or writes the real profile, and it has a data folder of its own, which is what the
 * single-instance lock goes by: a demo and a normal instance run side by side.
 */
export function resolveUserDataDir(input: UserDataDirInput): UserDataDir {
  let dir = input.defaultDir;
  if (input.portableDir) {
    dir = path.join(input.portableDir, 'data');
  } else if (input.platform === 'win32' && !input.devServer) {
    const beside = path.join(path.dirname(input.execPath), 'data');
    if (input.exists(beside)) dir = beside;
  }
  if (!input.demoMode) return { dir, demo: false };
  // Not a second level when the native Hermes entry already pointed the data folder at the demo's.
  const demoDir = demoWorkspaceDir(dir);
  return { dir: demoDir, demo: true, logsDir: path.join(demoDir, 'logs') };
}

export interface NativeHermesDataDirsInput {
  demoMode: boolean;
  /** Electron's per-user application data folder (`app.getPath('appData')`). */
  appData: string;
  /** `SSHS3_USER_DATA_DIR`: a data folder somebody chose. */
  userDataOverride?: string;
  /** `PORTABLE_EXECUTABLE_DIR`. */
  portableDir?: string;
}

/**
 * The data folder of the native Hermes window's process (desktopEntry.ts), and where Hermes keeps its
 * own data inside it. In demo mode both are inside the demo's folder, so Hermes' data stays out of the
 * real profile too. index.ts applies `resolveUserDataDir` after it, which leaves this folder as it is.
 */
export function nativeHermesDataDirs(input: NativeHermesDataDirsInput): { userData: string; hermesHome: string } {
  const profileDir = input.userDataOverride || (input.portableDir ? path.join(input.portableDir, 'data') : path.join(input.appData, 'sshs3'));
  const userData = input.demoMode ? demoWorkspaceDir(profileDir) : profileDir;
  return { userData, hermesHome: path.join(userData, 'hermes-native') };
}
