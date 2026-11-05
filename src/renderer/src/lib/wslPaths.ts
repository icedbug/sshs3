/**
 * Path translation for WSL terminals. The shell reports Linux paths (`/mnt/c/Users/me/a.md`,
 * `/home/me/a.md`) but files are read by the Windows side of the app, which needs
 * `C:\Users\me\a.md` or `\\wsl.localhost\<distro>\home\me\a.md`.
 */

/** A path the shell reported -> the path the Windows process must open. Unknown shapes are returned unchanged. */
export function wslToWindowsPath(p: string, distro?: string): string {
  const mnt = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(p);
  if (mnt) {
    const rest = (mnt[2] ?? '').replace(/\//g, '\\');
    return `${mnt[1].toUpperCase()}:\\${rest}`;
  }
  if (p.startsWith('/') && distro) {
    return `\\\\wsl.localhost\\${distro}${p.replace(/\//g, '\\')}`;
  }
  return p;
}

/** A Windows path (drive or `\\wsl.localhost` / `\\wsl$` share) -> the path the WSL shell understands. Others are unchanged. */
export function windowsToWslPath(p: string): string {
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(p);
  if (drive) {
    const rest = drive[2].replace(/\\/g, '/');
    return rest ? `/mnt/${drive[1].toLowerCase()}/${rest}` : `/mnt/${drive[1].toLowerCase()}`;
  }
  const unc = /^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+(.*)$/i.exec(p);
  if (unc) return unc[1].replace(/\\/g, '/') || '/';
  return p;
}
