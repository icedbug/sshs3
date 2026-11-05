/** Single-quotes `path` for a POSIX shell. */
export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * The line that changes a remote shell's directory to `path`. A leading `~` or `~/` is left outside the
 * quotes so the shell still expands it (a quoted `~` is a directory called "~"), the rest is quoted.
 */
export function cdCommand(path: string): string {
  if (path === '~') return 'cd ~';
  if (path.startsWith('~/')) return `cd ~/${shellQuote(path.slice(2))}`;
  return `cd ${shellQuote(path)}`;
}
