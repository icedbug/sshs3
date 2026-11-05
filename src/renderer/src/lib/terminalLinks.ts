import type { IDisposable, ILink, Terminal } from '@xterm/xterm';
import { isWindowsPath } from './terminalPathPreview';

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}>]+$/;
// Quoted paths: single or double quoted paths containing spaces/characters
const QUOTED_PATH_RE =
  /(?<![\w:/.~-])(['"])([^'"\r\n\t]+)\1(?::\d+(?::\d+)?)?/g;

// Slashed paths: absolute (`/var/log/x`), home-relative (`~/x`), explicit relative (`./x`, `../x`),
// or subpaths (`src/file.ts`, `dir/`), optionally with backslash-escaped spaces, optionally followed by `:line[:col]`.
const SLASH_PATH_RE =
  /(?<![\w:/.~-])((?:~?\/|\.\.?\/|(?:[\w.@+-]|\\ )+\/)(?:(?:[\w.@%+~-]|\\ )+\/)*(?:(?:[\w.@%+~-]|\\ )+)?)(?::\d+(?::\d+)?)?/g;

// Windows absolute paths without spaces (`C:\Users\me\a.txt`, `C:/x/y`, `\\server\share\f`),
// optionally followed by `:line[:col]`. Paths with spaces are only linked when quoted.
const WINDOWS_PATH_RE =
  /(?<![\w:/.~\\-])((?:[A-Za-z]:[\\/]|\\\\[\w.-]+\\)(?:[\w.@%+~$#()-]+[\\/])*[\w.@%+~$#()-]*)(?::\d+(?::\d+)?)?/g;

// Standalone filenames with extensions (e.g. `index.html`, `test.txt`, `windows.png`, `.bashrc`),
// well-known filenames (e.g. `Dockerfile`, `Makefile`, `notes`, `hosts`), or identifiers with `_`.
const STANDALONE_FILE_RE =
  /(?<![\w:/.~@-])(?:\b((?:[A-Za-z0-9_~-]|\\ )+\.[A-Za-z0-9_.-]+)|(\.[A-Za-z0-9_~-]+(?:\.[A-Za-z0-9_~-]+)*)|([A-Za-z0-9_~-]+))(?::\d+(?::\d+)?)?(?![\w:/.~-])/g;

export const KNOWN_FILENAMES = new Set([
  'dockerfile',
  'containerfile',
  'makefile',
  'vagrantfile',
  'procfile',
  'gemfile',
  'rakefile',
  'brewfile',
  'justfile',
  'earthfile',
  'tiltfile',
  'podfile',
  'cartfile',
  'fastfile',
  'jenkinsfile',
  'license',
  'licence',
  'copying',
  'readme',
  'install',
  'notice',
  'authors',
  'changelog',
  'contributing',
  'todo',
  'notes',
  'build',
  'workspace',
  'version',
  'news',
  'porting',
  'thanks',
  'hosts',
  'passwd',
  'shadow',
  'fstab',
  'sudoers',
  'crontab',
  'environment',
  'hostname',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'authorized_keys',
  'known_hosts',
]);

export function isKnownFilename(name: string): boolean {
  return KNOWN_FILENAMES.has(name.toLowerCase());
}

/** Well-known filenames that are also ordinary English words, so they turn up in prose all the time. */
const GENERIC_WORD_FILENAMES = new Set([
  'license',
  'licence',
  'copying',
  'readme',
  'install',
  'notice',
  'authors',
  'changelog',
  'contributing',
  'todo',
  'notes',
  'build',
  'workspace',
  'version',
  'news',
  'porting',
  'thanks',
  'environment',
  'hostname',
]);

/** A well-known filename that is not an ordinary word (`Dockerfile`, `id_rsa`, `fstab`): safe to link unchecked. */
export function isDistinctiveFilename(name: string): boolean {
  const lower = name.toLowerCase();
  return KNOWN_FILENAMES.has(lower) && !GENERIC_WORD_FILENAMES.has(lower);
}

/** Top-level domains that are rarely file extensions; `notes.org` or `logo.ai` stay linkable. */
const HOST_TLDS = 'com|io|net|edu|gov|eu|tv|se|uk|de|fr|nl|us|ru|cn|jp';
/** More TLDs that are only treated as a host when followed by a path (`example.org/guide`). */
const PATH_HOST_TLDS = `${HOST_TLDS}|org|info|dev|app|ai|co|me|cloud|xyz|tech`;
const HOSTNAME_RE = new RegExp(`^(?:[a-z0-9-]+\\.)+(?:${HOST_TLDS})$`, 'i');
const PATH_HOSTNAME_RE = new RegExp(`^(?:[a-z0-9-]+\\.)+(?:${PATH_HOST_TLDS})$`, 'i');

/** Product names that end in `.js` or `.NET`; real files are almost always lowercase. */
const PRODUCT_NAMES = new Set([
  'Node.js',
  'Next.js',
  'Vue.js',
  'Nuxt.js',
  'React.js',
  'Express.js',
  'Three.js',
  'D3.js',
  'Chart.js',
  'Ember.js',
  'Nest.js',
  'Angular.js',
  'Electron.js',
]);

/** `e.g`, `i.e`, `a.k.a`: every part is a single letter. */
const ABBREVIATION_RE = /^(?:[A-Za-z]\.)+[A-Za-z]$/;
/** `1.5x`, `2.5s`, `12.5GB`, `1.2.3-rc1`: a number with a unit or a version suffix, not a filename. */
const NUMBER_WITH_UNIT_RE = /^v?\d+(?:\.\d+)+(?:[-+][\w.]+|[A-Za-z]{1,3})?$/;
/** `3.5MB/s`, `100km/h`, `10req/s`. */
const RATE_RE = /^\d[\d.,]*[A-Za-z]{0,5}\/[A-Za-z]{1,5}$/;

/** Words and tokens that look like a filename but are prose, a hostname, a version or a unit. */
function isProseToken(raw: string): boolean {
  return (
    PRODUCT_NAMES.has(raw) ||
    HOSTNAME_RE.test(raw) ||
    /^www\./i.test(raw) ||
    ABBREVIATION_RE.test(raw) ||
    NUMBER_WITH_UNIT_RE.test(raw)
  );
}

const NON_PATH_WORD_PAIRS = new Set([
  'and/or',
  'either/or',
  'true/false',
  'yes/no',
  'on/off',
  'in/out',
  'read/write',
  'r/w',
  'w/o',
  'w/e',
  'n/a',
  'c/o',
  'i/o',
  'input/output',
  'client/server',
  'pass/fail',
  'success/failure',
  'enable/disable',
  'start/stop',
  'add/remove',
  'create/update',
  'push/pull',
  'open/close',
  'before/after',
  'request/response',
  'he/she',
  's/he',
  'his/her',
  'him/her',
  'km/h',
  'm/s',
  'mb/s',
  'kb/s',
  'gb/s',
]);

const COLUMN_HEADERS_STOP = new Set([
  'user',
  'pid',
  'cpu',
  '%cpu',
  'mem',
  '%mem',
  'vsz',
  'rss',
  'tty',
  'stat',
  'start',
  'time',
  'command',
  'uid',
  'gid',
  'total',
  'size',
  'date',
  'name',
]);

// Matches standard ls -l / ll line prefix
// e.g. -rw-r--r-- 1 user group 1234 Oct 17 15:00 filename
// or   drwxr-xr-x 2 user group 4096 2026-10-17 15:00 dirname
// or   lrwxrwxrwx 1 user group    6 Oct 17 15:00 link -> target
const LS_L_RE =
  /^(\s*[-bcdlps][-rwxstST-]{9}[.+@]?\s+\d+\s+\S+\s+\S+\s+\d+\s+(?:[A-Za-z]{3}\s+[\s\d]\d|\d{1,2}\s+[A-Za-z]{3}|\d{4}-\d{2}-\d{2})\s+(?:[\d:]{4,5}|\d{4})\s+)(.+)$/;

// Matches arguments to common file inspection / editing commands
const FILE_CMD_ARG_RE =
  /(?<=\b(?:cat|nano|vim|vi|view|touch|less|more|head|tail|code|subl|gedit|bat|rm)\s+(?:-[A-Za-z0-9_-]+\s+)*)([A-Za-z0-9_.-]+)(?::\d+(?::\d+)?)?/g;

// Multi-column ls output: tokens separated by 2 or more spaces or tabs
const LS_COLUMNS_RE =
  /(?<=^|\s{2,}|\t)([A-Za-z0-9_.-]{2,})(?=\s{2,}|\t|$)/g;

export interface TextMatch {
  index: number;
  /** The clickable text (URL, or path without a `:line` suffix). */
  text: string;
  /** Length of the highlighted range, including any `:line:col` suffix. */
  length: number;
}

export function findUrls(text: string): { index: number; url: string }[] {
  const out: { index: number; url: string }[] = [];
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    // Keep a closing paren only when the URL has a matching opening one (e.g. wikipedia links)
    while (TRAILING_PUNCT_RE.test(url)) {
      const last = url[url.length - 1];
      if (last === ')' && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
      url = url.slice(0, -1);
    }
    if (/^https?:\/\/[^/?#]+/.test(url)) out.push({ index: m.index ?? 0, url });
  }
  return out;
}

function isValidSlashedPath(raw: string): boolean {
  if (raw.length < 2 || !/[A-Za-z]/.test(raw)) return false;
  if (isWindowsPath(raw)) return true;
  if (raw.startsWith('/') || raw.startsWith('~/') || raw.startsWith('./') || raw.startsWith('../')) {
    return true;
  }
  const firstSegment = raw.split('/')[0];
  if (PATH_HOSTNAME_RE.test(firstSegment) || /^www\./i.test(firstSegment)) return false;
  if (raw.endsWith('/')) return true;
  if (RATE_RE.test(raw)) return false;
  if (/^\d+\/\d+/.test(raw)) return false;
  if (NON_PATH_WORD_PAIRS.has(raw.toLowerCase())) return false;
  const parts = raw.split('/');
  if (parts.length >= 2) {
    for (const p of parts) {
      if (!p || p === '.' || p === '..') continue;
      if (!/^[A-Za-z0-9_.@%+ -]+$/.test(p)) return false;
    }
    return true;
  }
  return false;
}

function isValidStandaloneFile(raw: string): boolean {
  // `Version` or `Notes` at the start of a sentence is prose; `LICENSE` and `notes` are still files.
  if (isKnownFilename(raw)) return !(GENERIC_WORD_FILENAMES.has(raw.toLowerCase()) && /^[A-Z][a-z]+$/.test(raw));
  if (raw.startsWith('.')) {
    return raw.length >= 2 && /[A-Za-z]/.test(raw);
  }
  if (isProseToken(raw)) return false;
  // Reject IP addresses (1.1.1.1) and version numbers (0.96.7, v1.2.3)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(raw)) return false;
  if (/^v?\d+(\.\d+)+$/.test(raw)) return false;
  const dot = raw.lastIndexOf('.');
  if (dot > 0) {
    const ext = raw.slice(dot + 1);
    return ext.length >= 1 && ext.length <= 10 && /^[A-Za-z0-9_-]+$/.test(ext) && /[A-Za-z]/.test(ext);
  }
  // Standalone tokens with underscore (e.g. `my_script`, `test_data`)
  // ALL_CAPS names are environment variables / constants, not files.
  if (raw.includes('_') && /[A-Za-z]/.test(raw) && raw.length >= 3 && !raw.startsWith('-') && !/^[A-Z0-9_]+$/.test(raw)) {
    return true;
  }
  return false;
}

function isValidQuotedPath(raw: string): boolean {
  if (!raw || raw.length < 1 || raw.length > 255) return false;
  if (raw.startsWith('-')) return false; // command flags like '-la'
  if (isValidSlashedPath(raw) || isValidStandaloneFile(raw)) return true;
  return /^[A-Za-z0-9_.~@%+ -]+$/.test(raw) && /[A-Za-z0-9]/.test(raw);
}

function isValidColumnToken(token: string): boolean {
  if (token.length < 2 || token.length > 80) return false;
  if (!/[A-Za-z]/.test(token)) return false;
  if (token.startsWith('-')) return false;
  if (COLUMN_HEADERS_STOP.has(token.toLowerCase())) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(token)) return false;
  if (/^v?\d+(\.\d+)+$/.test(token)) return false;
  return true;
}

export function findPaths(text: string): TextMatch[] {
  const candidates: TextMatch[] = [];

  for (const m of text.matchAll(QUOTED_PATH_RE)) {
    const rawContent = (m[2] || '').trim();
    const unescaped = rawContent.replace(/\\ /g, ' ');
    if (isValidQuotedPath(unescaped)) {
      candidates.push({
        index: m.index ?? 0,
        text: unescaped,
        length: m[0].length,
      });
    }
  }

  for (const m of text.matchAll(SLASH_PATH_RE)) {
    const rawMatch = m[1].replace(/[.,;]+$/, '');
    const unescaped = rawMatch.replace(/\\ /g, ' ');
    if (!isValidSlashedPath(unescaped)) continue;
    const suffix = m[0].length - m[1].length;
    candidates.push({
      index: m.index ?? 0,
      text: unescaped,
      length: rawMatch.length + (rawMatch.length === m[1].length ? suffix : 0),
    });
  }

  for (const m of text.matchAll(WINDOWS_PATH_RE)) {
    const rawMatch = m[1].replace(/[.,;)]+$/, '');
    if (rawMatch.length < 4 || !/[A-Za-z0-9]/.test(rawMatch.slice(3))) continue;
    const suffix = m[0].length - m[1].length;
    candidates.push({
      index: m.index ?? 0,
      text: rawMatch,
      length: rawMatch.length + (rawMatch.length === m[1].length ? suffix : 0),
    });
  }

  // Parse standard ls -l / ll output lines
  const lsMatch = text.match(LS_L_RE);
  if (lsMatch) {
    const prefix = lsMatch[1];
    const fullRest = lsMatch[2];
    const restTrimmed = fullRest.trimEnd();
    const alreadyMatched = candidates.some(
      (c) => c.index >= prefix.length && c.index < prefix.length + fullRest.length
    );
    if (!alreadyMatched) {
      const isDir = /^\s*d/.test(prefix);
      const arrowIdx = restTrimmed.indexOf(' -> ');
      if (arrowIdx > 0) {
        // Symlink: link -> target
        const linkName = restTrimmed.slice(0, arrowIdx).trim();
        const targetName = restTrimmed.slice(arrowIdx + 4).trim();
        if (linkName) {
          candidates.push({
            index: prefix.length,
            text: linkName,
            length: linkName.length,
          });
        }
        if (targetName) {
          const targetStart = prefix.length + arrowIdx + 4;
          candidates.push({
            index: targetStart,
            text: targetName,
            length: targetName.length,
          });
        }
      } else if (restTrimmed) {
        candidates.push({
          index: prefix.length,
          text: isDir ? `${restTrimmed}/` : restTrimmed,
          length: restTrimmed.length,
        });
      }
    }
  }

  for (const m of text.matchAll(STANDALONE_FILE_RE)) {
    const matchedToken = m[1] || m[2] || m[3];
    if (!matchedToken) continue;
    const rawMatch = matchedToken.replace(/[.,;]+$/, '');
    const unescaped = rawMatch.replace(/\\ /g, ' ');
    if (!isValidStandaloneFile(unescaped)) continue;
    const suffix = m[0].length - matchedToken.length;
    candidates.push({
      index: m.index ?? 0,
      text: unescaped,
      length: rawMatch.length + (rawMatch.length === matchedToken.length ? suffix : 0),
    });
  }

  // Parse command line file arguments (e.g. `cat notes`, `vim server`)
  for (const m of text.matchAll(FILE_CMD_ARG_RE)) {
    const token = m[1];
    if (!token) continue;
    if (isValidColumnToken(token)) {
      candidates.push({
        index: m.index ?? 0,
        text: token,
        length: m[0].length,
      });
    }
  }

  // Parse multi-column ls output (tokens separated by 2+ spaces or tabs)
  for (const m of text.matchAll(LS_COLUMNS_RE)) {
    const token = m[1];
    if (!token) continue;
    if (isValidColumnToken(token)) {
      candidates.push({
        index: m.index ?? 0,
        text: token,
        length: token.length,
      });
    }
  }

  candidates.sort((a, b) => a.index - b.index || b.length - a.length);

  const out: TextMatch[] = [];
  let lastEnd = -1;
  for (const c of candidates) {
    if (c.index >= lastEnd) {
      out.push(c);
      lastEnd = c.index + c.length;
    }
  }
  return out;
}

export interface TerminalLinkHandlers {
  openUrl: (url: string) => void;
  /** Provide to make absolute / `~/` file paths Ctrl+clickable. */
  openPath?: (path: string) => void;
  /** Optional hover callback when mouse enters a file path link. */
  hoverPath?: (event: MouseEvent, path: string) => void;
  /** Optional leave callback when mouse leaves a file path link. */
  leavePath?: (event: MouseEvent, path: string) => void;
}

/**
 * Makes plain-text http(s) URLs (and, when `openPath` is given, file paths) in the terminal
 * react to Ctrl+click (Cmd+click on macOS).
 */
export function registerTerminalLinks(term: Terminal, handlers: TerminalLinkHandlers): IDisposable {
  return term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const buf = term.buffer.active;
      let first = bufferLineNumber - 1;
      while (first > 0 && buf.getLine(first)?.isWrapped) first--;
      // Text of the whole wrapped line plus, per character, the terminal cell it sits in.
      // Wide characters (CJK, emoji) take two cells, so string index != cell index.
      let text = '';
      const cellOf: number[] = [];
      let last = first;
      for (let i = first; ; i++) {
        const line = buf.getLine(i);
        if (!line || (i > first && !line.isWrapped)) break;
        for (let x = 0; x < term.cols; x++) {
          const cell = line.getCell(x);
          if (cell && cell.getWidth() === 0) continue;
          const chars = cell?.getChars() || ' ';
          for (let k = 0; k < chars.length; k++) cellOf.push((i - first) * term.cols + x);
          text += chars;
        }
        last = i;
      }

      const matches: (TextMatch & { open: (text: string) => void; isPath?: boolean })[] = findUrls(text).map(({ index, url }) => ({
        index,
        text: url,
        length: url.length,
        open: handlers.openUrl,
      }));
      if (handlers.openPath || handlers.hoverPath) {
        for (const p of findPaths(text)) {
          const insideUrl = matches.some((u) => p.index >= u.index && p.index < u.index + u.length);
          if (!insideUrl) {
            matches.push({
              ...p,
              open: handlers.openPath ?? (() => {}),
              isPath: true,
            });
          }
        }
      }

      const links: ILink[] = [];
      for (const { index, text: linkText, length, open, isPath } of matches) {
        const startCell = cellOf[index];
        const endCell = cellOf[Math.min(index + length - 1, cellOf.length - 1)];
        if (startCell === undefined || endCell === undefined) continue;
        const startRow = first + Math.floor(startCell / term.cols);
        const endRow = first + Math.floor(endCell / term.cols);
        if (bufferLineNumber - 1 < startRow || bufferLineNumber - 1 > endRow || endRow > last) continue;
        links.push({
          range: {
            start: { x: (startCell % term.cols) + 1, y: startRow + 1 },
            end: { x: (endCell % term.cols) + 1, y: endRow + 1 },
          },
          text: linkText,
          activate: (event, activated) => {
            if (event.ctrlKey || event.metaKey) open(activated);
          },
          hover: (event, activated) => {
            if (isPath && handlers.hoverPath) {
              handlers.hoverPath(event, activated);
            }
          },
          leave: (event, activated) => {
            if (isPath && handlers.leavePath) {
              handlers.leavePath(event, activated);
            }
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  });
}
