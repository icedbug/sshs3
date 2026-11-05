import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ConfigureGitSigningRequest, ConfigureGitSigningResult, GitSigningConfig } from '../../shared/types/git';

const execFileAsync = promisify(execFile);

function resolveGitBinary(): string {
  return process.platform === 'win32' ? 'git.exe' : 'git';
}

/** Converts Windows backslashes to forward slashes for Git config compatibility. */
export function normalizeGitConfigPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/** `key::` marks a literal public key in `user.signingkey`; it is not part of the key. */
const LITERAL_KEY_PREFIX = /^key::\s*/;
// `<type> <base64 blob> [comment]`: a file called `ecdsa-work.pub` is a path, not a key.
const PUBLIC_KEY_LINE = /^(?:ssh-|ecdsa-|sk-)\S*\s+[A-Za-z0-9+/]+={0,2}(?:\s|$)/;

/**
 * The public key line inside a `user.signingkey` value, or null when the value is something else
 * (a path to a key file). Accepts the value with or without the `key::` prefix.
 */
export function literalSigningKey(value: string): string | null {
  const key = value.trim().replace(LITERAL_KEY_PREFIX, '');
  return PUBLIC_KEY_LINE.test(key) ? key : null;
}

/**
 * What to store in `user.signingkey` for a literal public key. Git recognises a literal key only when
 * it starts with `ssh-` or `key::`; an `ecdsa-sha2-…` or `sk-ssh-…` (security key) line without the prefix
 * is read as a file name and `git commit -S` fails with "Couldn't load public key".
 */
export function signingKeyConfigValue(literalKey: string): string {
  return literalKey.startsWith('ssh-') ? literalKey : `key::${literalKey}`;
}

export class GitConfigService {
  /** Reads global Git signing configuration. */
  public static async getSigningConfig(): Promise<GitSigningConfig> {
    const gitBin = resolveGitBinary();
    try {
      const getVal = async (key: string): Promise<string | undefined> => {
        try {
          const { stdout } = await execFileAsync(gitBin, ['config', '--global', '--get', key], {
            timeout: 5000,
          });
          return stdout.trim() || undefined;
        } catch {
          return undefined;
        }
      };

      const [format, signingKey, gpgsign, allowedSignersFile, email] = await Promise.all([
        getVal('gpg.format'),
        getVal('user.signingkey'),
        getVal('commit.gpgsign'),
        getVal('gpg.ssh.allowedSignersFile'),
        getVal('user.email'),
      ]);

      const enabled = format === 'ssh' && gpgsign === 'true' && !!signingKey;
      return {
        enabled,
        format,
        // Without the `key::` marker, so that it can be compared with the listed public keys.
        signingKey: signingKey?.replace(LITERAL_KEY_PREFIX, ''),
        allowedSignersFile,
        email,
      };
    } catch {
      return { enabled: false };
    }
  }

  /**
   * Configures Git to use SSH signing with the given key and updates `allowed_signers`.
   */
  public static async configureSigning(request: ConfigureGitSigningRequest): Promise<ConfigureGitSigningResult> {
    const gitBin = resolveGitBinary();
    const signingKey = request.signingKey?.trim();
    if (!signingKey) {
      return { success: false, error: 'A signing key is required' };
    }

    try {
      // 1. Get user email if not provided
      let email = request.email?.trim();
      if (!email) {
        try {
          const { stdout } = await execFileAsync(gitBin, ['config', '--global', '--get', 'user.email'], {
            timeout: 5000,
          });
          email = stdout.trim();
        } catch {
          // No email configured
        }
      }

      // 2. Setup allowed_signers file in ~/.ssh/allowed_signers
      const sshDir = path.join(os.homedir(), '.ssh');
      await fs.mkdir(sshDir, { recursive: true });
      const allowedSignersPath = path.join(sshDir, 'allowed_signers');

      let allowedSignersUpdated = false;
      const literalKey = literalSigningKey(signingKey);
      if (email && literalKey) {
        const parts = literalKey.split(/\s+/);
        const keyData = parts.slice(0, 2).join(' '); // "<type> <base64>"
        const entryLine = `${email} namespaces="git" ${keyData}`;

        let existingContent = '';
        try {
          existingContent = await fs.readFile(allowedSignersPath, 'utf-8');
        } catch {
          // File does not exist yet
        }

        const lines = existingContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (!lines.includes(entryLine)) {
          // Filter out previous entries for this email and key if updating
          const updatedLines = [...lines, entryLine];
          await fs.writeFile(allowedSignersPath, updatedLines.join('\n') + '\n', {
            mode: 0o644,
          });
          allowedSignersUpdated = true;
        }
      }

      // 3. Configure Git global settings
      const normalizedPath = normalizeGitConfigPath(allowedSignersPath);
      await execFileAsync(gitBin, ['config', '--global', 'gpg.format', 'ssh'], { timeout: 5000 });
      const configValue = literalKey ? signingKeyConfigValue(literalKey) : signingKey;
      await execFileAsync(gitBin, ['config', '--global', 'user.signingkey', configValue], { timeout: 5000 });
      await execFileAsync(gitBin, ['config', '--global', 'commit.gpgsign', 'true'], { timeout: 5000 });
      await execFileAsync(gitBin, ['config', '--global', 'gpg.ssh.allowedSignersFile', normalizedPath], { timeout: 5000 });

      return {
        success: true,
        allowedSignersUpdated,
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to configure Git signing: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Toggles Git commit.gpgsign on or off globally.
   */
  public static async setSigningEnabled(enabled: boolean): Promise<ConfigureGitSigningResult> {
    const gitBin = resolveGitBinary();
    try {
      await execFileAsync(gitBin, ['config', '--global', 'commit.gpgsign', enabled ? 'true' : 'false'], {
        timeout: 5000,
      });
      if (enabled) {
        await execFileAsync(gitBin, ['config', '--global', 'gpg.format', 'ssh'], { timeout: 5000 });
      }
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: `Failed to update commit.gpgsign: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
