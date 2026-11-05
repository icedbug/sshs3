interface Endpoint {
  host: string;
  port?: number;
  username: string;
}

/**
 * The control socket of a terminal's SSH master, if an SFTP connection to the same endpoint may
 * share it (one authentication, e.g. one FIDO2 touch). The renderer only names the terminal
 * session; the socket path always comes from the session itself.
 */
export function resolveTerminalControlPath(
  session: { config: Endpoint; controlPath?: string } | undefined,
  sftp: Endpoint,
  platform: string,
  exists: (path: string) => boolean
): string | undefined {
  if (!session?.controlPath || platform === 'win32') return undefined;
  const same =
    session.config.host === sftp.host &&
    (session.config.port ?? 22) === (sftp.port ?? 22) &&
    session.config.username === sftp.username;
  if (!same || !exists(session.controlPath)) return undefined;
  return session.controlPath;
}
