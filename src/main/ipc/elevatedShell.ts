/** Shells that may be started elevated (WSL is left out: Windows admin does not mean root in a distro). */
const ELEVATED_SHELLS = new Map<string, string>([
  ['cmd', 'cmd.exe'],
  ['powershell', 'powershell.exe'],
  ['pwsh', 'pwsh.exe'],
]);

/** Exit code the elevation script uses when the user declined the UAC prompt. */
export const UAC_DECLINED_EXIT_CODE = 2;

/** The executable for a whitelisted shell name, or null for anything else (inherited keys included). */
export function elevatedShellExecutable(shellType: unknown): string | null {
  return typeof shellType === 'string' ? (ELEVATED_SHELLS.get(shellType) ?? null) : null;
}

/**
 * PowerShell command that starts `exe` elevated. Declining UAC fails with Win32 error 1223 (ERROR_CANCELLED), whose
 * message is localized, so the script turns it into a fixed exit code instead.
 */
export function elevatedStartCommand(exe: string): string {
  return (
    `try { Start-Process -FilePath '${exe}' -WorkingDirectory $env:USERPROFILE -Verb RunAs -ErrorAction Stop } ` +
    `catch { if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.InnerException.NativeErrorCode -eq 1223) ` +
    `{ exit ${UAC_DECLINED_EXIT_CODE} }; throw }`
  );
}

/** True when the failed `powershell.exe` run means the user declined the UAC prompt. */
export function isUacDeclined(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === UAC_DECLINED_EXIT_CODE;
}
