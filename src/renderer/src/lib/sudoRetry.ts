/**
 * Decides whether a failed terminal command is worth offering to re-run with `sudo`.
 *
 * Works from the command text and its (prompt-stripped) output, so it needs no exit code; the
 * exit code from OSC 133 is only used as extra confirmation when the shell provides it.
 */

export interface SudoRetryInput {
  /** The command line as typed, without the prompt. */
  command: string | null;
  /** Output of that same command, without the trailing prompt. */
  output: string | null;
  /** Exit code when the shell reports one (OSC 133 `D`). */
  exitCode?: number;
  /** The session is already root. */
  atRootPrompt: boolean;
}

export interface SudoRetrySuggestion {
  sudoCommand: string;
}

/** Output longer than this is a log or a listing, not a one-line error. */
const MAX_OUTPUT_LINES = 20;
/** The error must be near the end of the output; a program that merely mentions it earlier is not failing. */
const ERROR_TAIL_LINES = 3;

/**
 * `Permission denied (publickey,...)` is an SSH authentication failure, not a local permission problem. Only a
 * list of authentication method names counts: Rust tools end with `Permission denied (os error 13)`, which is.
 */
const SSH_AUTH_DENIED_RE = /Permission denied \([a-z-]+(?:,[a-z-]+)*\)/i;

// eslint-disable-next-line no-control-regex
const UNSAFE_COMMAND_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;

/**
 * Specific enough to trust without an exit code. `Operation not permitted` also comes from firewalls and
 * sandboxes (`ping: sendto: ...`), where sudo does not help, so it only counts next to a path or a quoted name.
 */
const DENIED_PATTERNS: RegExp[] = [
  /: Permission denied\.?(?:\s*\(os error \d+\))?\s*$/i,
  // apt/dpkg print the errno inside parentheses: `... RemoveCaches (13: Permission denied)`.
  /\(13: Permission denied\)\s*$/i,
  /Unable to lock (?:the )?(?:administration )?directory/i,
  // useradd and friends: `cannot lock /etc/passwd; try again later.` (a bare `cannot lock /x` is contention).
  /\bcannot lock \/etc\/\S+; try again later/i,
  /\btry with sudo\b/i,
  // systemctl: `Failed to enable unit: Access denied`. Other tools' `Access denied` is theirs, not the OS's.
  /\bFailed to .*: Access denied\.?\s*$/i,
  /(?:\/|['‘’"][^'‘’"]+['‘’"]).*Operation not permitted/i,
  /\bAre you root\b/i,
  /Could not open lock file/i,
  /Interactive authentication required/i,
  /can'?t create transaction lock/i,
  // The same message from libc in other locales (`cat: /x: Åtkomst nekas`).
  /: (?:Åtkomst nekas|Behörighet saknas|Keine Berechtigung|Zugriff verweigert|Permission non accordée|Permiso denegado|Permesso negato|Permissão negada)\s*$/i,
];

/**
 * Package managers that say so in words: dnf ("requires superuser privileges"), zypper ("Root privileges are
 * required"), yum ("You need to be root"), pacman ("unless you are root"). A line that forbids or waves away
 * root (`do not run as root`, `no need to be root`) says the opposite and is skipped.
 */
const DENIED_WORDING_PATTERNS: RegExp[] = [
  /\b(?:super-?user|root|administrator|elevated)\s+(?:privileges?|rights|access|permissions?)\b/i,
  /\b(?:must|needs?\s+to) be (?:run as )?(?:the )?(?:root|super-?user)\b/i,
  /\brequires? root\b/i,
  /\bunless you are root\b/i,
];
const NEGATED_WORDING_RE =
  /\b(?:do not|don'?t|never|should not|shouldn'?t|not recommended|no need|not need|not required)\b/i;

/**
 * Looser wording that is a permission problem wherever it stands in the last lines. Only trusted when the
 * shell reported a failing exit code, which a line that merely mentions the words does not come with.
 * A read-only or corrupt rpm database prints the same `cannot open Packages` as a missing permission.
 */
const DENIED_WITH_FAILURE_PATTERNS: RegExp[] = [/\bpermission denied\b/i, /cannot open Packages (?:database|index)/i];

/** Another process holds the lock (apt: `Could not get lock ... It is held by process N`): not a permission problem. */
const LOCK_CONTENTION_RE = /\bheld by process\b|Could not get lock|Resource temporarily unavailable/i;

/** Exit codes a permission problem ends in: general error, `EACCES` as a code, `EX_NOPERM`, not executable. */
const PERMISSION_EXIT_CODES = new Set([1, 13, 77, 126]);

/** `sudo` cannot run these: they are shell builtins, or they act on the shell's own state. */
const SHELL_BUILTINS = new Set([
  'cd', 'source', '.', 'export', 'alias', 'unalias', 'set', 'unset', 'ulimit', 'umask', 'exec', 'eval',
  'builtin', 'command', 'type', 'hash', 'read', 'history', 'exit', 'logout', 'fg', 'bg', 'jobs', 'pushd',
  'popd', 'dirs', 'local', 'declare', 'typeset', 'readonly', 'shopt', 'trap', 'wait', 'let', 'test', '[',
]);

/** Privilege handling and remote tools: their permission errors are not fixed by a local `sudo`. */
const PRIVILEGE_AND_REMOTE = ['sudo', 'doas', 'su', 'ssh', 'scp', 'sftp', 'rsync', 'mosh', 'git'];

/** Package tools that would leave root-owned files in the user's home when run through `sudo`. */
const USER_SCOPED_TOOLS = ['npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip3', 'cargo', 'gem', 'bundle', 'composer', 'brew'];

const EXCLUDED_COMMANDS = new Set([...SHELL_BUILTINS, ...PRIVILEGE_AND_REMOTE, ...USER_SCOPED_TOOLS]);

/** Redirects that do not open a file for writing or reading, so `sudo` is unaffected by them. */
const HARMLESS_REDIRECTS_RE = /(?:\d*|&)>>?\s*\/dev\/(?:null|stderr|stdout)\b|\d*>&\d+|&>>?\s*\/dev\/null\b/g;

/** Commands that only run another command (`time npm i`), so the real command is the next word. */
const WRAPPER_COMMANDS = new Set(['env', 'time', 'nohup', 'nice', 'ionice', 'stdbuf', 'command']);
/** `NAME=value` in front of a command. `sudo` refuses most of these (env_reset), so no offer is made. */
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Options of `env` and friends that take the next word as their argument (`env -u FOO cmd`). */
const OPTIONS_WITH_ARGUMENT = new Set(['-u', '-C', '--unset', '--chdir']);

const basename = (word: string): string => word.replace(/^.*\//, '');

/**
 * The name of the command that actually runs, looking through `time`, `nohup` and the like, and whether a
 * `NAME=value` assignment was stepped over on the way (`env FOO=1 cmd`).
 */
function commandName(command: string): { name: string; assignment: boolean } {
  const words = command.trim().split(/\s+/);
  let i = 0;
  let assignment = false;
  while (i < words.length - 1 && WRAPPER_COMMANDS.has(basename(words[i]))) {
    i++;
    // Options, their arguments and numbers (`nice -n 5`, `env -u FOO -i`) are skipped up to the next word.
    while (i < words.length - 1) {
      const word = words[i];
      if (ENV_ASSIGNMENT_RE.test(word)) {
        assignment = true;
        i++;
      } else if (OPTIONS_WITH_ARGUMENT.has(word)) {
        i += 2;
      } else if (word.startsWith('-') || /^\d+$/.test(word)) {
        i++;
      } else {
        break;
      }
    }
  }
  return { name: basename(words[i] ?? ''), assignment };
}

export function outputIndicatesPermissionDenied(output: string, exitCode?: number): boolean {
  const lines = output.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0 || lines.length > MAX_OUTPUT_LINES) return false;
  if (lines.some((line) => LOCK_CONTENTION_RE.test(line))) return false;
  const failedWithPermissionCode = exitCode !== undefined && PERMISSION_EXIT_CODES.has(exitCode);
  return lines
    .slice(-ERROR_TAIL_LINES)
    .some(
      (line) =>
        !SSH_AUTH_DENIED_RE.test(line) &&
        (DENIED_PATTERNS.some((re) => re.test(line)) ||
          (!NEGATED_WORDING_RE.test(line) && DENIED_WORDING_PATTERNS.some((re) => re.test(line))) ||
          (failedWithPermissionCode && DENIED_WITH_FAILURE_PATTERNS.some((re) => re.test(line))))
    );
}

/** True when `sudo <command>` would only elevate part of the line, or not the part that failed. */
function isCompoundOrRedirected(command: string): boolean {
  if (/;|&&|\|\|/.test(command)) return true;
  // The shell opens redirect targets before sudo runs, so a prefix would not help.
  return /[<>]/.test(command.replace(HARMLESS_REDIRECTS_RE, ''));
}

export function buildSudoCommand(command: string): string {
  return `sudo ${command.trim()}`;
}

/** The command text is a single line of plain printable text. */
function isPlainCommandText(cmd: string): boolean {
  // The command is read back from the screen, which remote output can influence. Anything that is not
  // a single line of plain printable text (newlines, control or escape characters, bidi overrides and
  // zero-width characters that make the shown text differ from what runs) is never offered.
  return !UNSAFE_COMMAND_CHARS_RE.test(cmd);
}

/** `sudo <cmd>` would run the whole command and elevate what failed (not a builtin, wrapper, redirect, ...). */
function canElevate(cmd: string): boolean {
  if (ENV_ASSIGNMENT_RE.test(cmd)) return false;
  const { name, assignment } = commandName(cmd);
  if (assignment || ENV_ASSIGNMENT_RE.test(name) || EXCLUDED_COMMANDS.has(name)) return false;
  return !isCompoundOrRedirected(cmd);
}

export function detectSudoRetry(input: SudoRetryInput): SudoRetrySuggestion | null {
  const { command, output, exitCode, atRootPrompt } = input;
  if (atRootPrompt) return null;
  if (exitCode === 0) return null;
  const cmd = command?.trim();
  if (!cmd || !output) return null;
  if (!isPlainCommandText(cmd) || !canElevate(cmd)) return null;
  if (!outputIndicatesPermissionDenied(output, exitCode)) return null;
  return { sudoCommand: buildSudoCommand(cmd) };
}

/**
 * What to type for the manual "re-run with sudo" action, which needs no error detection.
 * - `command`: the last command is known and fine to elevate, so the exact `sudo <command>` is typed.
 * - `history`: it is not known, or its text is not plain; `sudo !!` is typed instead, which bash and zsh
 *   expand from their own history, so nothing read from the screen can change what runs.
 * - `refused`: the last command cannot be run through sudo (`cd`, `ssh`, a redirect, ...).
 */
export function manualSudoInput(
  command: string | null
): { kind: 'command' | 'history'; text: string } | { kind: 'refused' } {
  const cmd = command?.trim();
  if (!cmd || !isPlainCommandText(cmd)) return { kind: 'history', text: 'sudo !!' };
  if (!canElevate(cmd)) return { kind: 'refused' };
  return { kind: 'command', text: buildSudoCommand(cmd) };
}

/** True when the prompt shows root: a trailing `#`, or `root@host`. */
export function isRootPromptLine(line: string): boolean {
  return /#\s*$/.test(line.trimEnd()) || /(?:^|[\s[(])root@[\w.-]+/.test(line);
}
