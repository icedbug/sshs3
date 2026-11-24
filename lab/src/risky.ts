import path from 'node:path';

/**
 * Whether a plain command changes a server: a service, a setting, a file outside the scratch folders, a
 * package, a process, the firewall, the mounts or the data. The product runs a plain command without
 * asking anyone, so doing such a thing as a plain command, rather than as a change card with its check
 * and its way back, is the agent's choice. Looking, however it is written, is not risky.
 *
 * The command is read the way a shell reads it, well enough for this: quotes, `;`, `&&`, `||`, pipes,
 * redirections, here-documents, `$(…)`, and the commands that run other commands (sudo, env, timeout,
 * xargs, `sh -c`, `find -exec`). Each simple command is then judged by its program and its words.
 */
export function riskyCommand(command: string): boolean {
  return parse(command).some(riskySimple);
}

interface Simple {
  words: string[];
  /** Where its output goes (`>` and `>>`, also with a file descriptor). */
  writesTo: string[];
  /** A here-document's text, which the program reads. */
  stdinText?: string;
  /** Its input comes from a pipe. */
  piped: boolean;
}

/** Places a command may write to without changing the server. */
const SAFE_PATH = /^(?:\/dev\/|\/tmp\/|\/var\/tmp\/|\/proc\/self\/|&\d$|&-$)|^\/dev\/null$|^\/tmp$/;
const safePath = (p: string): boolean => SAFE_PATH.test(p) || /^\/dev\/(?:null|stdout|stderr|tty)$/.test(p);

function parse(text: string): Simple[] {
  const out: Simple[] = [];
  let words: string[] = [];
  let writesTo: string[] = [];
  let word = '';
  let inWord = false;
  let piped = false;
  let nextPiped = false;
  const heredocs: Array<{ tag: string; strip: boolean; owner: Simple | undefined }> = [];
  let redirect: '' | 'out' | 'in' | 'heredoc' = '';
  let heredocStrip = false;

  const endWord = (): void => {
    if (!inWord) return;
    if (redirect === 'out') writesTo.push(word);
    else if (redirect === 'heredoc') heredocs.push({ tag: word, strip: heredocStrip, owner: undefined });
    else if (redirect !== 'in') words.push(word);
    redirect = '';
    word = '';
    inWord = false;
  };
  const endSimple = (pipeNext = false): void => {
    endWord();
    if (words.length || writesTo.length) {
      const simple: Simple = { words, writesTo, piped };
      out.push(simple);
      for (const h of heredocs) if (!h.owner) h.owner = simple;
    }
    words = [];
    writesTo = [];
    piped = pipeNext || nextPiped;
    nextPiped = false;
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\\' && i + 1 < text.length) {
      if (text[i + 1] === '\n') {
        i += 2;
        continue;
      }
      word += text[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end < 0 ? text.length : end;
      word += text.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          s += text[j + 1];
          j += 2;
          continue;
        }
        if (text[j] === '$' && text[j + 1] === '(') {
          const end = matchParen(text, j + 1);
          out.push(...parse(text.slice(j + 2, end)));
          s += text.slice(j, end + 1);
          j = end + 1;
          continue;
        }
        s += text[j];
        j++;
      }
      word += s;
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      const end = matchParen(text, i + 1);
      out.push(...parse(text.slice(i + 2, end)));
      word += text.slice(i, end + 1);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      const stop = end < 0 ? text.length : end;
      out.push(...parse(text.slice(i + 1, stop)));
      inWord = true;
      word += '`…`';
      i = stop + 1;
      continue;
    }
    if (c === '\n') {
      endSimple();
      i++;
      // The here-documents this line opened: their text, up to each closing line.
      for (const h of heredocs.splice(0)) {
        const lines: string[] = [];
        while (i < text.length) {
          const nl = text.indexOf('\n', i);
          const line = text.slice(i, nl < 0 ? text.length : nl);
          i = nl < 0 ? text.length : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line).trim() === h.tag) break;
          lines.push(line);
        }
        if (h.owner) h.owner.stdinText = lines.join('\n');
      }
      continue;
    }
    // A group's braces stand alone ({ a; b; }); `{}` and `a{b,c}` are words.
    const braceAlone = (c === '{' || c === '}') && !inWord && /^(?:\s|;|$)/.test(text.slice(i + 1, i + 2));
    if (c === ';' || c === '(' || c === ')' || braceAlone) {
      endSimple();
      i++;
      continue;
    }
    if (c === '&') {
      if (text[i + 1] === '&') {
        endSimple();
        i += 2;
        continue;
      }
      if (text[i + 1] === '>') {
        endWord();
        redirect = 'out';
        i += text[i + 2] === '>' ? 3 : 2;
        continue;
      }
      endSimple();
      i++;
      continue;
    }
    if (c === '|') {
      if (text[i + 1] === '|') {
        endSimple();
        i += 2;
        continue;
      }
      endSimple(true);
      i += text[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === '>' || c === '<') {
      // A file descriptor written right before it (2>/dev/null) belongs to the redirection.
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      } else endWord();
      if (c === '>') {
        let j = i + 1;
        if (text[j] === '>' || text[j] === '|') j++;
        if (text[j] === '&') {
          // >&2, >&-: to another descriptor.
          j++;
          while (j < text.length && /[\d-]/.test(text[j]!)) j++;
          i = j;
          continue;
        }
        redirect = 'out';
        i = j;
        continue;
      }
      if (text[i + 1] === '<' && text[i + 2] === '<') {
        // A here-string: its text is the input.
        redirect = 'in';
        i += 3;
        continue;
      }
      if (text[i + 1] === '<') {
        heredocStrip = text[i + 2] === '-';
        redirect = 'heredoc';
        i += heredocStrip ? 3 : 2;
        continue;
      }
      redirect = 'in';
      i += text[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    if (c === '#' && !inWord) {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endSimple();
  return out;
}

function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === '(') depth++;
    else if (text[j] === ')' && --depth === 0) return j;
  }
  return text.length;
}

/** Options of the commands that run another command, and which of them take a value. */
const WRAPPERS: Record<string, { valued: RegExp }> = {
  sudo: { valued: /^-[ugCDhprtU]$/ },
  doas: { valued: /^-[uC]$/ },
  env: { valued: /^-[uSC]$/ },
  timeout: { valued: /^-[ks]$/ },
  nice: { valued: /^-n$/ },
  ionice: { valued: /^-[cnp]$/ },
  nohup: { valued: /^$/ },
  stdbuf: { valued: /^-[ioe]$/ },
  time: { valued: /^$/ },
  command: { valued: /^$/ },
  exec: { valued: /^$/ },
  setsid: { valued: /^$/ },
  runuser: { valued: /^-[ugl]$/ },
  chroot: { valued: /^$/ },
  xargs: { valued: /^-[dEeILlnPs]$/ },
  watch: { valued: /^-[nd]$/ },
};

/** The command under its wrappers (sudo -n -u postgres psql … → psql …), and its program's name. */
function unwrap(words: string[]): string[] {
  let w = words;
  for (;;) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) w = w.slice(1);
    const program = w[0] ? path.basename(w[0]) : '';
    const wrapper = WRAPPERS[program];
    if (!wrapper) return w;
    let j = 1;
    // timeout's duration, chroot's folder, ionice's and nice's numbers come before the command.
    while (j < w.length) {
      const a = w[j]!;
      if (a === '--') {
        j++;
        break;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a) && program === 'env') {
        j++;
        continue;
      }
      if (!a.startsWith('-')) break;
      j += wrapper.valued.test(a) ? 2 : 1;
    }
    if (program === 'timeout' && j < w.length && /^\d/.test(w[j]!)) j++;
    if (program === 'chroot' && j < w.length) j++;
    w = w.slice(j);
  }
}

const positional = (args: string[], valued: RegExp = /^$/): string[] => {
  const found: string[] = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j]!;
    if (a === '--') return [...found, ...args.slice(j + 1)];
    if (a.startsWith('-') && a !== '-') {
      if (valued.test(a)) j++;
      continue;
    }
    found.push(a);
  }
  return found;
};

const SYSTEMCTL_CHANGES = new Set([
  'start', 'stop', 'restart', 'reload', 'try-restart', 'reload-or-restart', 'try-reload-or-restart', 'condrestart', 'force-reload',
  'enable', 'disable', 'reenable', 'preset', 'preset-all', 'mask', 'unmask', 'link', 'revert', 'kill', 'clean', 'freeze', 'thaw',
  'daemon-reload', 'daemon-reexec', 'isolate', 'set-property', 'edit', 'set-default', 'reboot', 'poweroff', 'halt', 'kexec',
  'emergency', 'rescue', 'default', 'suspend', 'hibernate', 'import-environment', 'set-environment', 'unset-environment',
]);
const SERVICE_CHANGES = new Set(['start', 'stop', 'restart', 'reload', 'force-reload', 'try-restart', 'condrestart']);
const PACKAGE_CHANGES = new Set(['install', 'reinstall', 'remove', 'purge', 'upgrade', 'full-upgrade', 'dist-upgrade', 'autoremove', 'autopurge', 'build-dep', 'uninstall', 'markauto', 'hold', 'unhold']);
const NFT_CHANGES = new Set(['add', 'create', 'insert', 'replace', 'delete', 'destroy', 'flush', 'reset', 'rename', 'import']);
const IP_CHANGES = new Set(['add', 'del', 'delete', 'change', 'replace', 'flush', 'set', 'append', 'prepend', 'save', 'restore']);
const PG_CTL_CHANGES = new Set(['start', 'stop', 'restart', 'reload', 'promote', 'kill', 'init', 'initdb', 'logrotate']);
const RCLONE_CHANGES = new Set(['delete', 'deletefile', 'purge', 'move', 'moveto', 'sync', 'bisync', 'copy', 'copyto', 'copyurl', 'mkdir', 'rmdir', 'rmdirs', 'touch', 'settier', 'cleanup', 'dedupe', 'rcat', 'link']);
const REDIS_CHANGES = new Set([
  'flushall', 'flushdb', 'del', 'unlink', 'set', 'setex', 'psetex', 'setnx', 'mset', 'msetnx', 'getset', 'getdel', 'append', 'incr', 'incrby', 'decr', 'decrby',
  'hset', 'hmset', 'hdel', 'lpush', 'rpush', 'lpop', 'rpop', 'lset', 'ltrim', 'sadd', 'srem', 'spop', 'zadd', 'zrem', 'expire', 'pexpire', 'expireat', 'persist',
  'rename', 'renamenx', 'move', 'copy', 'restore', 'migrate', 'swapdb', 'shutdown', 'save', 'bgsave', 'bgrewriteaof', 'replicaof', 'slaveof', 'failover', 'debug', 'module', 'script', 'function',
]);
/** SQL that writes or changes the database, its settings or its connections. */
const WRITE_SQL = /\b(?:drop|delete|update|insert|alter|truncate|create|grant|revoke|reindex|cluster|comment\s+on|refresh\s+materialized|lock|vacuum\s+full|checkpoint)\b|\bpg_(?:terminate_backend|cancel_backend|reload_conf|switch_wal|promote|rotate_logfile|create_restore_point|drop_replication_slot|create_physical_replication_slot|wal_replay_(?:pause|resume))\b|\bcopy\s+\w+(?:\s*\([^)]*\))?\s+from\b|\bset\s+(?:session\s+|local\s+)?\w+\s*(?:=|\bto\b)|\bselect\s+setval\b|\bset_config\s*\(/i;
/** Code that writes, deletes, runs or signals. */
const WRITE_CODE = /\bopen\s*\([^)]*,\s*['"][wax+]|\.write_(?:text|bytes)\s*\(|\bos\.(?:remove|unlink|rename|replace|chmod|chown|kill|system|rmdir|makedirs|mkdir|truncate|symlink|link)\b|\bshutil\.|\bsubprocess\.|\bunlink\s*\(|\bwriteFile|\bsystem\s*\(/;

function sqlOf(args: string[], stdin?: string): { sql: string; fromFile: boolean } {
  let sql = stdin ?? '';
  let fromFile = false;
  for (let j = 0; j < args.length; j++) {
    const a = args[j]!;
    const m = /^(?:-c|--command|-e|--execute)(?:=(.*))?$/.exec(a);
    if (m) {
      sql += `\n${m[1] ?? args[j + 1] ?? ''}`;
      if (m[1] === undefined) j++;
      continue;
    }
    if (/^-[A-Za-z]*c$/.test(a) && a.length > 2 && !a.startsWith('--')) {
      // Short flags run together with -c last (-Atc "…").
      sql += `\n${args[j + 1] ?? ''}`;
      j++;
      continue;
    }
    if (/^(?:-f|--file)(?:=.*)?$/.test(a)) fromFile = true;
  }
  return { sql, fromFile };
}

function riskySimple(simple: Simple): boolean {
  if (simple.writesTo.some((target) => !safePath(target))) return true;
  const words = unwrap(simple.words);
  if (!words.length) return false;
  const program = path.basename(words[0]!);
  const args = words.slice(1);
  const pos = positional(args);
  const has = (re: RegExp): boolean => args.some((a) => re.test(a));
  const unsafeArgs = (list: string[]): boolean => list.some((a) => !safePath(a));

  switch (program) {
    case 'sh':
    case 'bash':
    case 'dash':
    case 'zsh': {
      const c = args.findIndex((a) => /^-[a-z]*c$/.test(a));
      if (c >= 0) return riskyCommand(args[c + 1] ?? '');
      if (simple.stdinText !== undefined) return riskyCommand(simple.stdinText);
      // A script from a pipe or a file: what it does cannot be seen here.
      return simple.piped || pos.length > 0;
    }
    case 'python':
    case 'python3':
    case 'perl':
    case 'ruby':
    case 'node': {
      const e = args.findIndex((a) => a === '-c' || a === '-e');
      const code = e >= 0 ? (args[e + 1] ?? '') : (simple.stdinText ?? '');
      if (program === 'perl' && has(/^-[a-z]*i/)) return true;
      return WRITE_CODE.test(code);
    }
    case 'systemctl': {
      const sub = positional(args, /^-(?:[ptsnoHM]|-property|-type|-signal|-lines|-output|-host|-machine|-state|-root|-kill-whom|-job-mode)$/)[0];
      return sub !== undefined && SYSTEMCTL_CHANGES.has(sub);
    }
    case 'service':
      return SERVICE_CHANGES.has(pos[1] ?? '');
    case 'nginx':
    case 'apache2ctl':
    case 'apachectl':
      return has(/^-s$/) || ['restart', 'graceful', 'stop', 'start'].includes(pos[0] ?? '');
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'shred':
    case 'touch':
    case 'mkdir':
      return unsafeArgs(pos);
    case 'truncate':
      return unsafeArgs(positional(args, /^-[sr]$/));
    case 'fallocate':
      return unsafeArgs(positional(args, /^-[lo]$/));
    case 'mv':
    case 'cp':
    case 'install':
    case 'ln':
    case 'rsync':
    case 'scp': {
      if (program === 'install' && has(/^-d$/)) return unsafeArgs(positional(args, /^-[mogtS]$/));
      const list = positional(args, /^-[mogtS]$/);
      const dest = has(/^-t$/) ? args[args.indexOf('-t') + 1] : list.at(-1);
      return dest !== undefined && !safePath(dest);
    }
    case 'tee':
      return unsafeArgs(pos);
    case 'dd':
      return args.some((a) => a.startsWith('of=') && !safePath(a.slice(3)));
    case 'sed':
      return has(/^(?:-[a-zA-Z]*i|--in-place)/);
    case 'kill': {
      if (has(/^-(?:0|s0|SIG0|l|L)$/) || (args.includes('-s') && args[args.indexOf('-s') + 1] === '0')) return false;
      return pos.length > 0 || has(/^-\d+$/);
    }
    case 'pkill':
    case 'killall':
    case 'skill':
      return !has(/^-(?:l|-list)$/);
    case 'renice':
    case 'chrt':
      return pos.length > 0;
    case 'taskset':
      return has(/^-[a-z]*p/);
    case 'apt':
    case 'apt-get':
    case 'aptitude':
    case 'snap':
    case 'pip':
    case 'pip3':
    case 'npm':
    case 'gem':
    case 'yum':
    case 'dnf':
      return pos.some((a) => PACKAGE_CHANGES.has(a));
    case 'dpkg':
      return has(/^(?:-[irPaV]|--install|--remove|--purge|--configure|--unpack|--set-selections|--clear-selections)$/);
    case 'apt-mark':
      return pos[0] !== 'showhold' && pos[0] !== 'showmanual' && pos[0] !== 'showauto';
    case 'chmod':
    case 'chown':
    case 'chgrp':
    case 'setfacl':
    case 'chattr':
    case 'useradd':
    case 'userdel':
    case 'usermod':
    case 'adduser':
    case 'deluser':
    case 'groupadd':
    case 'groupdel':
    case 'groupmod':
    case 'gpasswd':
    case 'passwd':
    case 'chpasswd':
    case 'chsh':
    case 'chage':
    case 'visudo':
    case 'update-ca-certificates':
    case 'update-alternatives':
    case 'a2ensite':
    case 'a2dissite':
    case 'a2enmod':
    case 'reboot':
    case 'shutdown':
    case 'halt':
    case 'poweroff':
    case 'init':
    case 'telinit':
    case 'umount':
    case 'swapoff':
    case 'swapon':
    case 'mkswap':
    case 'iptables-restore':
    case 'ip6tables-restore':
    case 'nft-restore':
    case 'pg_restore':
    case 'pg_basebackup':
    case 'pg_archivecleanup':
    case 'pg_resetwal':
    case 'createdb':
    case 'dropdb':
    case 'createuser':
    case 'dropuser':
    case 'vacuumdb':
    case 'reindexdb':
    case 'clusterdb':
    case 'certbot':
    case 'vi':
    case 'vim':
    case 'nano':
    case 'ed':
      return !(program === 'umount' && !pos.length && !has(/^-a$/));
    case 'crontab':
      return !(has(/^-l$/) && !has(/^-[re]$/));
    case 'nft':
      return has(/^(?:-f|--file)$/) || NFT_CHANGES.has(positional(args, /^-[I]$/)[0] ?? '');
    case 'iptables':
    case 'ip6tables':
    case 'iptables-nft':
    case 'iptables-legacy':
    case 'ebtables':
    case 'arptables':
      return has(/^(?:-[ADIRFZNXPE]|--(?:append|delete|insert|replace|flush|zero|new-chain|delete-chain|policy|rename-chain))$/);
    case 'ufw':
      return !['status', 'show', 'app'].includes(pos[0] ?? 'status');
    case 'firewall-cmd':
      return has(/^--(?:add|remove|reload|set|change|zone=.*--add|permanent|new|delete)/);
    case 'ip': {
      const [object, action] = positional(args, /^-[n]$/);
      return object !== undefined && action !== undefined && IP_CHANGES.has(action);
    }
    case 'route':
      return pos[0] === 'add' || pos[0] === 'del';
    case 'sysctl':
      return has(/^(?:-w|--write|-p|--load|--system)$/) || pos.some((a) => a.includes('='));
    case 'mount':
      return pos.length > 0 || has(/^-a$/);
    case 'losetup':
      return pos.length > 0 || has(/^(?:-d|-D|-f)$/);
    case 'psql':
    case 'mysql':
    case 'mariadb':
    case 'sqlite3': {
      const { sql, fromFile } = sqlOf(args, simple.stdinText);
      return fromFile || WRITE_SQL.test(sql);
    }
    case 'pg_ctl':
    case 'pg_ctlcluster':
      return pos.some((a) => PG_CTL_CHANGES.has(a));
    case 'pg_dump':
    case 'pg_dumpall': {
      const f = args.findIndex((a) => a === '-f' || a === '--file');
      return f >= 0 && !safePath(args[f + 1] ?? '');
    }
    case 'redis-cli': {
      const cmd = positional(args, /^-(?:[hpanuseri]|-user|-pass|-sni|-cacert|-cert|-key|-tls-ciphers)$/)[0];
      if (!cmd) return false;
      const lower = cmd.toLowerCase();
      if (lower === 'config') return ['set', 'rewrite', 'resetstat'].includes((positional(args, /^-(?:[hpanuseri]|-user|-pass)$/)[1] ?? '').toLowerCase());
      if (lower === 'client') return (positional(args, /^-(?:[hpanuseri]|-user|-pass)$/)[1] ?? '').toLowerCase() === 'kill';
      if (lower === 'acl') return ['setuser', 'deluser', 'load', 'save'].includes((positional(args, /^-(?:[hpanuseri]|-user|-pass)$/)[1] ?? '').toLowerCase());
      return REDIS_CHANGES.has(lower);
    }
    case 'rclone':
      return RCLONE_CHANGES.has(positional(args, /^--(?:config|transfers|checkers|log-file|log-level|include|exclude|filter|max-age|min-age)$/)[0] ?? '');
    case 'aws':
      return (pos[0] === 's3' && ['rm', 'mv', 'cp', 'sync', 'rb', 'mb'].includes(pos[1] ?? '')) || (pos[0] === 's3api' && /^(?:delete|put|create|copy|restore|abort|complete|upload)-/.test(pos[1] ?? ''));
    case 'find': {
      // What find works on: the paths before its first test (none: the current folder).
      const starts: string[] = [];
      for (const a of args) {
        if (a.startsWith('-') || a === '(' || a === '!') break;
        starts.push(a);
      }
      const found = starts.length ? starts : ['.'];
      if (has(/^-delete$/)) return unsafeArgs(found);
      const e = args.findIndex((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a));
      if (e < 0) return false;
      const end = args.findIndex((a, j) => j > e && (a === ';' || a === '+' || a === '\\;'));
      // The command it runs, on what it found.
      const inner = args.slice(e + 1, end < 0 ? undefined : end).flatMap((a) => (a === '{}' ? found : [a]));
      return riskySimple({ words: inner, writesTo: [], piped: false });
    }
    case 'curl':
    case 'wget': {
      const o = args.findIndex((a) => /^(?:-o|--output|-O|--output-document)$/.test(a));
      if (o >= 0 && args[o] !== '-O' && !safePath(args[o + 1] ?? '') && args[o + 1] !== '-') return true;
      return has(/^(?:-X|--request)$/) ? /^(?:POST|PUT|DELETE|PATCH)$/i.test(args[args.findIndex((a) => a === '-X' || a === '--request') + 1] ?? '') : has(/^(?:-d|--data.*|-F|--form|-T|--upload-file)$/);
    }
    case 'openssl': {
      const outs = args.flatMap((a, j) => (/^-(?:out|keyout)$/.test(a) ? [args[j + 1] ?? ''] : []));
      return unsafeArgs(outs);
    }
    case 'tar':
      return /^-?[a-zA-Z]*x/.test(args[0] ?? '') || has(/^--extract$/);
    case 'logrotate':
      return has(/^(?:-f|--force)$/);
    case 'journalctl':
      return has(/^--(?:vacuum-\w+|rotate|flush|relinquish-var|setup-keys)/);
    case 'hostnamectl':
    case 'timedatectl':
    case 'localectl':
      return /^set-/.test(pos[0] ?? '');
    case 'date':
      return has(/^(?:-s|--set)/);
    default:
      return false;
  }
}
