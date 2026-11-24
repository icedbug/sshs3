import os from 'node:os';
import { accountChildEnv } from '../web/tenantBoundary';

/**
 * Config overrides that stop a repository's own `.git/config` from running code
 * (core.fsmonitor, hooks, pager) when we invoke git in a directory we do not trust.
 */
export function safeGitConfigArgs(hooksPath: string = os.devNull): string[] {
  return ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${hooksPath}`, '-c', 'core.pager=cat'];
}

/** Environment for git child processes: no prompts, no system config, no optional locks, restricted transports. */
export function safeGitEnv(): NodeJS.ProcessEnv {
  return {
    ...accountChildEnv(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ALLOW_PROTOCOL: 'https:http:ssh:git',
  };
}

/** Single-quotes a value for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** True if the value contains NUL or line breaks, which must never reach a shell command. */
export function hasControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- intentional: reject NUL/CR/LF in paths
  return /[\u0000\r\n]/.test(value);
}
