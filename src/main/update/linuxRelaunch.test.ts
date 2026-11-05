import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildLinuxRelaunchScript, scheduleLinuxRelaunch, startLinuxRelaunch } from './linuxRelaunch';
import { spawn } from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

describe('linuxRelaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildLinuxRelaunchScript', () => {
    it('generates an AppImage relaunch script that restores SELinux and unsets stale mounts', () => {
      const script = buildLinuxRelaunchScript({
        pid: 1234,
        appImagePath: '/home/user/sshs3.AppImage',
        args: [],
        maxWaitSeconds: 30,
      });

      expect(script).toContain('OLD_PID=1234');
      expect(script).toContain('unset APPDIR OWD APPIMAGE_SILENT_INSTALL');
      expect(script).toContain("restorecon -F '/home/user/sshs3.AppImage'");
      expect(script).toContain("systemd-run --user --slice=app.slice --description=\"sshs3\" $SYSTEMD_ENV_ARGS '/home/user/sshs3.AppImage'");
      expect(script).toContain("exec '/home/user/sshs3.AppImage'");
    });

    it('never places an argument inside double quotes, where $(...) and backticks would expand', () => {
      const evil = ['--x=$(touch /tmp/pwned)', '`id`'];
      const script = buildLinuxRelaunchScript({ pid: 1, execPath: '/opt/sshs3/sshs3', appImagePath: '', args: evil });

      for (const line of script.split('\n')) {
        expect(line).not.toMatch(/"[^"]*(\$\(touch|`id`)[^"]*"/);
      }
      expect(script).toContain("'--x=$(touch /tmp/pwned)'");
      expect(script).toContain('elif false && command -v gtk-launch');
    });

    it('offers the desktop-file launchers only when there are no arguments', () => {
      const script = buildLinuxRelaunchScript({ pid: 1, execPath: '/opt/sshs3/sshs3', appImagePath: '', args: [] });
      expect(script).toContain('elif true && command -v gtk-launch');
      expect(script).toContain('elif true && command -v gio');
    });

    it('waits long enough for a slow package install before it gives up: 10 minutes by default', () => {
      // The helper starts before the package manager runs, which can take minutes (metadata, dependencies).
      const script = buildLinuxRelaunchScript({ pid: 1, execPath: '/opt/sshs3/sshs3', args: [] });
      expect(script).toContain('[ "$WAITED" -ge 6000 ]');
    });

    it('keeps a wait the caller chooses, in tenths of a second', () => {
      const script = buildLinuxRelaunchScript({ pid: 1, execPath: '/opt/sshs3/sshs3', args: [], maxWaitSeconds: 30 });
      expect(script).toContain('[ "$WAITED" -ge 300 ]');
    });

    it('generates a package relaunch script that uses desktop launcher and systemd-run', () => {
      const script = buildLinuxRelaunchScript({
        pid: 5678,
        execPath: '/opt/sshs3/sshs3',
        desktopName: 'sshs3.desktop',
        args: [],
      });

      expect(script).toContain('OLD_PID=5678');
      expect(script).toContain("gtk-launch 'sshs3.desktop'");
      expect(script).toContain("gio launch '/usr/share/applications/sshs3.desktop'");
      expect(script).toContain("systemd-run --user --slice=app.slice --description=\"sshs3\" $SYSTEMD_ENV_ARGS '/opt/sshs3/sshs3'");
      expect(script).toContain("exec '/opt/sshs3/sshs3'");
    });

    it('properly quotes arguments in the relaunch script', () => {
      const script = buildLinuxRelaunchScript({
        pid: 100,
        execPath: '/opt/sshs3/sshs3',
        args: ['--test', "arg with 'quotes'"],
      });

      expect(script).toContain("'--test' 'arg with '\\''quotes'\\'''");
    });

    it('safely escapes special characters and quotes in paths to prevent shell command injection', () => {
      const appImageScript = buildLinuxRelaunchScript({
        pid: 100,
        appImagePath: '/home/user/app"$(calc)\';whoami.AppImage',
        args: [],
      });
      expect(appImageScript).not.toContain('"/home/user/app');
      expect(appImageScript).toContain("'/home/user/app\"$(calc)'\\''");

      const packageScript = buildLinuxRelaunchScript({
        pid: 100,
        execPath: '/opt/app"$(id)\';whoami/sshs3',
        desktopName: 'sshs3"$(reboot)\';.desktop',
        args: [],
      });
      expect(packageScript).not.toContain('"/opt/app');
      expect(packageScript).toContain("'/opt/app\"$(id)'\\''");
      expect(packageScript).toContain("'sshs3\"$(reboot)'\\''");
    });
  });

  describe('scheduleLinuxRelaunch', () => {
    it('spawns a detached /bin/sh process when on Linux', () => {
      const unref = vi.fn();
      vi.mocked(spawn).mockReturnValue({ unref } as any);

      const scheduled = scheduleLinuxRelaunch({ pid: 9999, maxWaitSeconds: 10 });
      if (process.platform === 'linux') {
        expect(scheduled).toBe(true);
        expect(spawn).toHaveBeenCalledWith('/bin/sh', ['-c', expect.stringContaining('OLD_PID=9999')], {
          detached: true,
          stdio: 'ignore',
          env: expect.any(Object),
        });
        expect(unref).toHaveBeenCalled();
      } else {
        expect(scheduled).toBe(false);
      }
    });

    it('returns a handle that stops the helper', () => {
      const kill = vi.fn();
      vi.mocked(spawn).mockReturnValue({ unref: vi.fn(), kill } as any);

      const handle = startLinuxRelaunch({ pid: 9999, maxWaitSeconds: 10 });
      if (process.platform === 'linux') {
        expect(handle).not.toBeNull();
        handle!.cancel();
        expect(kill).toHaveBeenCalledWith('SIGTERM');
      } else {
        expect(handle).toBeNull();
      }
    });

    it('does not throw when the helper cannot be signalled', () => {
      vi.mocked(spawn).mockReturnValue({
        unref: vi.fn(),
        kill: vi.fn(() => {
          throw new Error('ESRCH');
        }),
      } as any);
      const handle = startLinuxRelaunch({ pid: 9999 });
      if (process.platform === 'linux') expect(() => handle!.cancel()).not.toThrow();
    });
  });
});
