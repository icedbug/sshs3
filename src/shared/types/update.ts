export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'up-to-date'
  | 'error'
  | 'unsupported';

/**
 * dev: unpackaged build. not-installer: a Windows copy that the NSIS installer did not install (MSI, ZIP or
 * portable), which the in-app updater cannot update; new versions come the way the copy did. windows-unsigned: Windows builds are not code-signed yet, so
 * updates are installed manually. disabled: switched off by the administrator
 * (SSHS3_DISABLE_UPDATES=1 or the autoCheckUpdates policy), e.g. on air-gapped machines.
 */
export type UpdateUnsupportedReason = 'dev' | 'not-installer' | 'windows-unsigned' | 'disabled';

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  /** Version offered by the release feed (available/downloading/ready). */
  version?: string;
  /** Download progress, 0-100 (downloading). */
  progress?: number;
  /** Short, single-line error message (error). */
  error?: string;
  /** Why in-app updating is unavailable (unsupported). */
  unsupportedReason?: UpdateUnsupportedReason;
}
