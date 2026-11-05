/**
 * Single-quotes a string for safe interpolation into a POSIX shell command line,
 * escaping any embedded single quotes and removing null bytes to prevent argument truncation.
 * Shared by every service that builds a remote command from user-controlled input
 * (paths, search patterns, globs) so the escaping logic lives in exactly one place.
 */
export function quoteShellArg(value: string): string {
  const sanitized = value.replace(/\0/g, '');
  return `'${sanitized.replace(/'/g, "'\\''")}'`;
}

/**
 * Quotes a path for use as a file operand of a remote command. A relative path is anchored with `./`
 * so it can never be read as something else: a leading `-` is an option (GNU `sed -e1e…` runs shell
 * commands), and `find` also takes a leading `!`, `(`, `)` or `,` for part of its expression. Preferred
 * over `--` because not every tool (e.g. `find`) accepts it.
 */
export function quotePathOperand(value: string): string {
  return quoteShellArg(anchorPath(value));
}

/**
 * The form of a path that `quotePathOperand` passes on: absolute, or relative and starting `./` / `../`
 * (`.` and `..` themselves are fine too). Idempotent. A caller that needs to recognise the path in the
 * command's output (a `find` root is printed as the prefix of every result) has to use this same form.
 */
export function anchorPath(value: string): string {
  const clean = value.replace(/\0/g, '');
  return /^(?:\/|\.\/|\.\.\/)/.test(clean) || clean === '.' || clean === '..' ? clean : `./${clean}`;
}
