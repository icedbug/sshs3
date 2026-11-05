import { spawn } from 'node:child_process';
import { createLogger } from '../log';

const log = createLogger('relaunch');

/**
 * How long the helper waits for the app to exit before it gives up and does not relaunch. It is started
 * before the package manager runs (which blocks the app until it is done), and `dnf` or `apt` can take
 * minutes on a slow mirror or with new dependencies, so a minute was too short. A failed or cancelled
 * install stops the helper (see `LinuxRelaunchHandle`), so a long wait does not relaunch the app by surprise.
 */
const DEFAULT_MAX_WAIT_SECONDS = 600;

export interface LinuxRelaunchOptions {
  pid?: number;
  execPath?: string;
  appImagePath?: string;
  desktopName?: string;
  args?: string[];
  maxWaitSeconds?: number;
}

/**
 * Builds a standalone shell script that waits for the exiting sshs3 instance to
 * terminate, releases the single-instance lock cleanly, restores the SELinux label
 * on AppImages if needed, and relaunches the app through the desktop environment
 * (gtk-launch / gio launch / systemd-run) rather than a direct fork/exec.
 *
 * This ensures the relaunched process receives a fresh systemd cgroup scope
 * under app.slice, an active logind/PAM session, and proper SELinux domain transition,
 * preventing 'sudo' and PAM failures in the integrated local terminal.
 */
function quoteShell(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

export function buildLinuxRelaunchScript(options: LinuxRelaunchOptions = {}): string {
  const pid = typeof options.pid === 'number' && Number.isInteger(options.pid) ? options.pid : process.pid;
  const execPath = options.execPath ?? process.execPath;
  const appImagePath = options.appImagePath ?? (process.env.APPIMAGE || '');
  const desktopName = options.desktopName ?? 'sshs3.desktop';
  const maxWaitSeconds =
    typeof options.maxWaitSeconds === 'number' && options.maxWaitSeconds > 0
      ? options.maxWaitSeconds
      : DEFAULT_MAX_WAIT_SECONDS;
  const maxWaitTicks = Math.max(10, Math.floor(maxWaitSeconds * 10));
  const args = options.args ?? process.argv.slice(1);
  const argsQuoted = args.map(quoteShell).join(' ');
  // A shell builtin decided here, never `[ -z "<args>" ]`: double quotes would expand `$(...)` inside an argument.
  const noArgsCheck = args.length === 0 ? 'true' : 'false';

  const appImagePathQuoted = quoteShell(appImagePath);
  const execPathQuoted = quoteShell(execPath);
  const desktopNameQuoted = quoteShell(desktopName);
  const desktopFileQuoted = quoteShell(`/usr/share/applications/${desktopName}`);

  const execAppImage = [appImagePathQuoted, argsQuoted].filter(Boolean).join(' ');
  const execPackage = [execPathQuoted, argsQuoted].filter(Boolean).join(' ');
  const isAppImage = Boolean(appImagePath);
  const targetCmd = isAppImage ? execAppImage : execPackage;

  return `
OLD_PID=${pid}
WAITED=0
while kill -0 "$OLD_PID" 2>/dev/null; do
  sleep 0.1
  WAITED=$((WAITED + 1))
  if [ "$WAITED" -ge ${maxWaitTicks} ]; then
    exit 0
  fi
done

SYSTEMD_ENV_ARGS=""
for var in DISPLAY WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE DBUS_SESSION_BUS_ADDRESS SSH_AUTH_SOCK; do
  if [ -n "$(eval "echo \\$$var")" ]; then
    SYSTEMD_ENV_ARGS="$SYSTEMD_ENV_ARGS --setenv=$var"
  fi
done

${
  isAppImage
    ? `unset APPDIR OWD APPIMAGE_SILENT_INSTALL
if command -v restorecon >/dev/null 2>&1; then
  restorecon -F ${appImagePathQuoted} 2>/dev/null || true
fi`
    : ''
}

if command -v systemd-run >/dev/null 2>&1 && systemd-run --user --slice=app.slice true 2>/dev/null; then
  exec systemd-run --user --slice=app.slice --description="sshs3" $SYSTEMD_ENV_ARGS ${targetCmd}
${
  !isAppImage
    ? `elif ${noArgsCheck} && command -v gtk-launch >/dev/null 2>&1 && [ -f ${desktopFileQuoted} ]; then
  exec gtk-launch ${desktopNameQuoted}
elif ${noArgsCheck} && command -v gio >/dev/null 2>&1 && [ -f ${desktopFileQuoted} ]; then
  exec gio launch ${desktopFileQuoted}`
    : ''
}
else
  for fd in $(ls /proc/self/fd 2>/dev/null); do
    case "$fd" in ""|*[!0-9]*) continue ;; esac
    if [ "$fd" -gt 2 ]; then eval "exec $fd>&-" 2>/dev/null; fi
  done
  exec ${targetCmd}
fi
`.trim();
}

/** The helper that is waiting to relaunch the app; `cancel()` stops it before it has done so. */
export interface LinuxRelaunchHandle {
  cancel(): void;
}

/**
 * Launches the background helper process that monitors parent termination and
 * starts a clean, top-level instance once this process exits. Returns a handle to
 * stop it again, because the install it belongs to can still fail or be cancelled
 * (a dismissed polkit prompt): the helper would otherwise relaunch the app whenever
 * the user quits it within the wait window (10 minutes by default).
 */
export function startLinuxRelaunch(options: LinuxRelaunchOptions = {}): LinuxRelaunchHandle | null {
  if (process.platform !== 'linux') return null;
  try {
    const script = buildLinuxRelaunchScript(options);
    log.info('scheduling Linux relaunch helper');
    const child = spawn('/bin/sh', ['-c', script], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
      },
    });
    child.unref();
    return {
      cancel: () => {
        try {
          // A no-op once the helper has exited, so it cannot signal an unrelated process.
          child.kill('SIGTERM');
          log.info('cancelled the Linux relaunch helper');
        } catch (err) {
          log.error('failed to cancel the Linux relaunch helper', err);
        }
      },
    };
  } catch (err) {
    log.error('failed to schedule Linux relaunch helper', err);
    return null;
  }
}

export function scheduleLinuxRelaunch(options: LinuxRelaunchOptions = {}): boolean {
  return startLinuxRelaunch(options) !== null;
}
