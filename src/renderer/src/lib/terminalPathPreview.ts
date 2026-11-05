/**
 * Pure helper functions for terminal file path detection, classification,
 * and preview metadata formatting.
 */

import { IS_WINDOWS } from './platform';
import {
  MARKDOWN_EXTENSIONS,
  RASTER_IMAGE_EXTENSIONS,
  SVG_EXTENSIONS,
} from './fileExtensions';

export type FileTypeCategory =
  | 'image'
  | 'code'
  | 'config'
  | 'markdown'
  | 'archive'
  | 'document'
  | 'directory'
  | 'unknown';

const EXTENSION_CATEGORIES: Record<string, FileTypeCategory> = {
  ...Object.fromEntries([...RASTER_IMAGE_EXTENSIONS, ...SVG_EXTENSIONS].map((ext) => [ext, 'image' as const])),
  ...Object.fromEntries([...MARKDOWN_EXTENSIONS].map((ext) => [ext, 'markdown' as const])),

  // Code
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  cjs: 'code',
  py: 'code',
  rs: 'code',
  go: 'code',
  c: 'code',
  cpp: 'code',
  h: 'code',
  hpp: 'code',
  java: 'code',
  kt: 'code',
  sh: 'code',
  bash: 'code',
  zsh: 'code',
  fish: 'code',
  rb: 'code',
  php: 'code',
  lua: 'code',
  sql: 'code',
  html: 'code',
  css: 'code',
  scss: 'code',

  // Config & Data
  json: 'config',
  json5: 'config',
  yaml: 'config',
  yml: 'config',
  toml: 'config',
  ini: 'config',
  conf: 'config',
  cfg: 'config',
  env: 'config',
  xml: 'config',
  plist: 'config',
  properties: 'config',
  dockerfile: 'config',

  // Archives
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  zip: 'archive',
  bz2: 'archive',
  xz: 'archive',
  '7z': 'archive',

  // Documents & Logs
  txt: 'document',
  log: 'document',
  csv: 'document',
  tsv: 'document',
  pdf: 'document',
};

const EXTENSION_LABELS: Record<string, string> = {
  png: 'PNG Image',
  jpg: 'JPEG Image',
  jpeg: 'JPEG Image',
  svg: 'SVG Vector',
  webp: 'WebP Image',
  gif: 'GIF Animation',
  ts: 'TypeScript',
  tsx: 'React TypeScript',
  js: 'JavaScript',
  jsx: 'React JavaScript',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  sh: 'Shell Script',
  bash: 'Bash Script',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  conf: 'Configuration',
  env: 'Environment Config',
  dockerfile: 'Dockerfile',
  md: 'Markdown',
  sql: 'SQL',
  txt: 'Text Document',
  log: 'Log File',
  pdf: 'PDF Document',
};

const KNOWN_EXACT_NAMES: Record<string, { category: FileTypeCategory; label: string }> = {
  dockerfile: { category: 'config', label: 'Dockerfile' },
  containerfile: { category: 'config', label: 'Containerfile' },
  makefile: { category: 'code', label: 'Makefile' },
  vagrantfile: { category: 'config', label: 'Vagrantfile' },
  procfile: { category: 'config', label: 'Procfile' },
  gemfile: { category: 'code', label: 'Gemfile' },
  rakefile: { category: 'code', label: 'Rakefile' },
  license: { category: 'document', label: 'License' },
  licence: { category: 'document', label: 'License' },
  copying: { category: 'document', label: 'License' },
  readme: { category: 'markdown', label: 'Readme' },
  todo: { category: 'document', label: 'Todo' },
  notes: { category: 'document', label: 'Notes' },
  changelog: { category: 'document', label: 'Changelog' },
  hosts: { category: 'document', label: 'Hosts File' },
  passwd: { category: 'config', label: 'Passwd Config' },
  id_rsa: { category: 'config', label: 'SSH Private Key' },
  id_ed25519: { category: 'config', label: 'SSH Private Key' },
};

/**
 * Extracts lowercase file extension from a path without leading dot.
 */
export function getFileExtension(filePath: string): string {
  const clean = filePath.split(/[?#]/)[0];
  const lastSegment = clean.split(/[\\/]/).pop() || '';
  if (lastSegment.toLowerCase() === 'dockerfile') return 'dockerfile';
  if (lastSegment.startsWith('.') && !lastSegment.slice(1).includes('.')) {
    // e.g. .env, .gitignore, .bashrc
    return lastSegment.slice(1).toLowerCase();
  }
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return lastSegment.slice(dotIndex + 1).toLowerCase();
}

/**
 * Classifies a file path into a category (code, image, config, directory, etc.)
 * Files without an extension are assumed to be text files ('document').
 */
export function detectFileType(filePath: string): FileTypeCategory {
  if (filePath.endsWith('/') || filePath.endsWith('\\')) return 'directory';
  const clean = filePath.split(/[?#]/)[0];
  const lastSegment = (clean.split(/[\\/]/).pop() || '').toLowerCase();
  if (KNOWN_EXACT_NAMES[lastSegment]) {
    return KNOWN_EXACT_NAMES[lastSegment].category;
  }
  const ext = getFileExtension(filePath);
  if (!ext) {
    // Files without an extension are assumed to be text files
    return 'document';
  }
  return EXTENSION_CATEGORIES[ext] ?? 'unknown';
}

/**
 * Returns a human-friendly label for the file type (e.g. "TypeScript", "YAML", "Text File").
 */
export function getLanguageLabel(filePath: string): string {
  if (filePath.endsWith('/') || filePath.endsWith('\\')) return 'Directory';
  const clean = filePath.split(/[?#]/)[0];
  const lastSegment = (clean.split(/[\\/]/).pop() || '').toLowerCase();
  if (KNOWN_EXACT_NAMES[lastSegment]) {
    return KNOWN_EXACT_NAMES[lastSegment].label;
  }
  const ext = getFileExtension(filePath);
  if (EXTENSION_LABELS[ext]) return EXTENSION_LABELS[ext];
  if (ext) return ext.toUpperCase();
  return 'Text File';
}

/** `C:\dir`, `C:/dir` or a UNC path (`\\server\share`). */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p);
}

/**
 * A UNC path (`\\server\share`, `\\?\…`, `\\.\…`): touching one on Windows opens an SMB connection and sends
 * the user's NetNTLMv2 credentials to that server. Terminal output is untrusted, so such a path must never be
 * looked up just because the pointer rests on it. Windows also accepts forward and mixed separators
 * (`//server/share`, `\/server`), but on any other system `//usr/bin` is an ordinary path, so those forms
 * only count where the renderer runs on Windows.
 */
export function isUncPath(p: string, windows: boolean = IS_WINDOWS): boolean {
  const trimmed = p.trim();
  if (trimmed.startsWith('\\\\')) return true;
  return windows && /^[\\/]{2}/.test(trimmed);
}

/** A UNC path that leaves this machine. WSL's own `\\wsl.localhost\` / `\\wsl$\` shares are local and stay usable. */
export function isNetworkUncPath(p: string, windows: boolean = IS_WINDOWS): boolean {
  return isUncPath(p, windows) && !/^[\\/]{2}wsl(?:\.localhost|\$)[\\/]/i.test(p.trim());
}

export interface PathDetails {
  raw: string;
  basename: string;
  parentDir: string;
  fullPath: string;
  isDir: boolean;
  extension: string;
  category: FileTypeCategory;
  label: string;
}

/**
 * Parses path details, resolving ~ to userHome and relative paths to currentCwd || userHome,
 * computing basename and parentDir.
 */
export function resolvePathDetails(
  rawPath: string,
  userHome = '/home/user',
  currentCwd?: string
): PathDetails {
  let cleaned = rawPath.trim();
  if (
    (cleaned.startsWith("'") && cleaned.endsWith("'") && cleaned.length >= 2) ||
    (cleaned.startsWith('"') && cleaned.endsWith('"') && cleaned.length >= 2)
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  cleaned = cleaned.replace(/\\ /g, ' ');

  const isDir = cleaned.endsWith('/') || cleaned.endsWith('\\');
  const normalized = cleaned.replace(/[\\/]+$/, '');

  // A Windows base (drive letter or UNC) is joined with backslashes so the result stays a valid
  // native path instead of a `C:\Users\alun/README.md` mix.
  const joinUnder = (base: string, rel: string): string => {
    const windows = isWindowsPath(base);
    const sep = windows ? '\\' : '/';
    const trimmedBase = base.replace(/[\\/]+$/, '');
    const trimmedRel = windows ? rel.replace(/\//g, '\\') : rel;
    return `${trimmedBase}${sep}${trimmedRel}`;
  };

  let fullPath: string;
  if (normalized === '~') {
    fullPath = userHome;
  } else if (/^~[\\/]/.test(normalized)) {
    fullPath = joinUnder(userHome, normalized.slice(2));
  } else if (normalized.startsWith('/') || isWindowsPath(normalized)) {
    fullPath = normalized;
  } else {
    const effectiveCwd =
      currentCwd && (currentCwd.startsWith('/') || currentCwd.startsWith('~') || isWindowsPath(currentCwd))
        ? currentCwd
        : userHome;
    const resolvedBase =
      effectiveCwd === '~'
        ? userHome
        : /^~[\\/]/.test(effectiveCwd)
          ? joinUnder(userHome, effectiveCwd.slice(2))
          : effectiveCwd;
    fullPath = joinUnder(resolvedBase, normalized.replace(/^\.[\\/]/, ''));
  }

  const lastSlash = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
  const basename = lastSlash >= 0 ? fullPath.slice(lastSlash + 1) : fullPath;
  const parentDir = lastSlash > 0 ? fullPath.slice(0, lastSlash) : '/';

  const category = isDir ? 'directory' : detectFileType(fullPath);
  const label = isDir ? 'Directory' : getLanguageLabel(fullPath);
  const extension = isDir ? '' : getFileExtension(fullPath);

  return {
    raw: rawPath,
    basename: basename || '/',
    parentDir,
    fullPath: isDir ? `${fullPath}${isWindowsPath(fullPath) ? '\\' : '/'}` : fullPath,
    isDir,
    extension,
    category,
    label,
  };
}

/**
 * Truncates multi-line text to a preview snippet of maximum lines and line width.
 */
export function truncateSnippet(text: string, maxLines = 15, maxCharsPerLine = 120): string {
  if (!text) return '';
  const lines = text.split('\n').slice(0, maxLines);
  const truncated = lines.map((line) =>
    line.length > maxCharsPerLine ? `${line.slice(0, maxCharsPerLine)}…` : line
  );
  return truncated.join('\n');
}

const SENSITIVE_NAMES = new Set([
  'shadow',
  'gshadow',
  'authorized_keys',
  '.netrc',
  '.pgpass',
  '.npmrc',
  'credentials',
  'secrets',
  '.git-credentials',
  '.htpasswd',
  '.bash_history',
  '.zsh_history',
  'kubeconfig',
]);
const SENSITIVE_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx', 'kdbx', 'env', 'ppk', 'jks', 'keystore', 'gpg', 'asc', 'tfstate', 'tfvars']);

/** Files whose content must not be rendered in a hover snippet (private keys, credentials, .env files). */
export function isSensitiveFilePath(filePath: string): boolean {
  const name = (filePath.split(/[\\/]/).pop() || '').toLowerCase();
  if (!name) return false;
  if (SENSITIVE_NAMES.has(name)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(_sk)?(?!.*\.pub$)/.test(name)) return true;
  if (/^(shadow|gshadow|credentials)[-.~]/.test(name)) return true;
  if (name.startsWith('.env') && !name.endsWith('.example') && !name.endsWith('.sample')) return true;
  return SENSITIVE_EXTENSIONS.has(getFileExtension(name));
}
