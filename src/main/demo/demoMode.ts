import path from 'node:path';

/**
 * Demo mode is a property of the running process, never a setting.
 *
 * It is decided exactly once, when this module is first loaded at process start (desktop: from
 * desktopEntry/index before any store exists; web: when the server starts), from:
 * - the command-line flag `--demo` (`npm run demo`), or
 * - the environment variable `SSHS3_DEMO=1`. `SSHS3_DEMO_WORKSPACE=1` is accepted as an alias.
 *
 * It is not persisted anywhere and never changes while the process runs. Switching modes means a new
 * process: the desktop app relaunches itself with `--demo` added or removed (after the user confirms,
 * see index.ts), and the web server has to be restarted with or without the flag. A demo process keeps
 * all of its state in its own data directory (`demoWorkspaceDir`), so it never reads or writes the
 * real profile.
 */

/** Command-line flag that starts sshs3 in demo mode. */
export const DEMO_FLAG = '--demo';

/** Environment variables that start sshs3 in demo mode when set to `1` (the second is an alias). */
export const DEMO_ENV_VARS = ['SSHS3_DEMO', 'SSHS3_DEMO_WORKSPACE'] as const;

/** Name of the directory, inside the normal data directory, that holds everything of a demo process. */
export const DEMO_WORKSPACE_DIR_NAME = 'demo-workspace';

/**
 * Prefix of every demo fixture's identity (see ai/hub/demoWorkspace.ts): SSH servers `demo-…`,
 * S3 profiles `demo-s3-…`, MCP servers `demo-mcp-…`.
 */
export const DEMO_ID_PREFIX = 'demo-';

/** Whether this command line / environment asks for demo mode. */
export function demoModeRequested(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  return argv.includes(DEMO_FLAG) || DEMO_ENV_VARS.some((name) => env[name] === '1');
}

const launchDemoMode = demoModeRequested(process.argv, process.env);
let testOverride: boolean | undefined;

/** Whether this process runs in demo mode. The single source of truth for the flag. */
export function isDemoMode(): boolean {
  return testOverride ?? launchDemoMode;
}

/**
 * Test-only: replaces the launch-time decision (`undefined` restores it). Throws outside Vitest, so
 * application code can never switch demo mode in a running process.
 */
export function setDemoModeForTesting(enabled: boolean | undefined): void {
  if (!process.env.VITEST) throw new Error('Demo mode is decided at launch and cannot be changed at runtime');
  testOverride = enabled;
}

/**
 * The data directory of a demo process: `demo-workspace` inside `baseDir`. Idempotent, so applying it
 * twice (desktopEntry and index.ts both may) never nests a second level.
 */
export function demoWorkspaceDir(baseDir: string): string {
  return path.basename(baseDir) === DEMO_WORKSPACE_DIR_NAME ? baseDir : path.join(baseDir, DEMO_WORKSPACE_DIR_NAME);
}

/** `args` (a command line without the executable) with `--demo` added or removed. */
export function demoModeRelaunchArgs(args: readonly string[], demoMode: boolean): string[] {
  const kept = args.filter((arg) => arg !== DEMO_FLAG);
  return demoMode ? [...kept, DEMO_FLAG] : kept;
}

/** Storage provider ids wrap the profile id (`sftp-<profileId>`, `s3-<profileId>`). */
const PROVIDER_ID_PREFIXES = ['sftp-', 's3-'] as const;

function isDemoId(id: string | null | undefined): boolean {
  if (typeof id !== 'string') return false;
  return (
    id.startsWith(DEMO_ID_PREFIX) || PROVIDER_ID_PREFIXES.some((prefix) => id.startsWith(`${prefix}${DEMO_ID_PREFIX}`))
  );
}

/** A target identity: a profile/provider/server id, or an object carrying one. */
export type DemoTargetRef =
  | string
  | { readonly id?: string | null; readonly profileId?: string | null }
  | null
  | undefined;

/**
 * Whether a target is one of the demo workspace's fake fixtures, to be served by the demo implementations
 * (virtual terminal, in-memory storage, scripted MCP) instead of a real connection. Decided by explicit
 * identity only (an id starting with `demo-`, also inside a `sftp-`/`s3-` provider id) and only in demo
 * mode. Host names, IP ranges and endpoints never make a target fake. True when any of `refs` matches.
 */
export function isDemoTarget(...refs: DemoTargetRef[]): boolean {
  if (!isDemoMode()) return false;
  return refs.some((ref) =>
    ref === null || ref === undefined || typeof ref === 'string'
      ? isDemoId(ref)
      : isDemoId(ref.id) || isDemoId(ref.profileId)
  );
}
