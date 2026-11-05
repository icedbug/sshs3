import { describe, it, expect } from 'vitest';
import { findPaths, findUrls } from '../../src/renderer/src/lib/terminalLinks';

describe('terminalLinks - Windows paths', () => {
  it('links an absolute Windows path as one match, not as a bare filename', () => {
    const text = 'Error in C:\\Users\\alun\\sshs3\\src\\main.ts:42:7 (see log)';
    const m = findPaths(text);
    expect(m).toHaveLength(1);
    expect(m[0].text).toBe('C:\\Users\\alun\\sshs3\\src\\main.ts');
    expect(m[0].length).toBe('C:\\Users\\alun\\sshs3\\src\\main.ts:42:7'.length);
  });

  it('links forward-slash drive paths and quoted paths with spaces', () => {
    expect(findPaths('open C:/Users/alun/a.md now')[0].text).toBe('C:/Users/alun/a.md');
    expect(findPaths('"C:\\Program Files\\App\\x.txt"')[0].text).toBe('C:\\Program Files\\App\\x.txt');
  });
});

describe('terminalLinks - findPaths', () => {
  it('does not treat ALL_CAPS names as files', () => {
    expect(findPaths('export MY_VAR_NAME=1')).toHaveLength(0);
    expect(findPaths('see my_script for details').map((m) => m.text)).toContain('my_script');
  });

  it('finds standalone filenames with extensions in ls -l style output', () => {
    const text = '-rw-r--r-- 1 alun alun 1234 Oct 17 15:00 index.html';
    const matches = findPaths(text);
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toBe('index.html');
  });

  it('finds multiple files on different or same lines', () => {
    const text = 'Files: todo.html, test.txt, windows.png and styles.css.';
    const matches = findPaths(text);
    const names = matches.map((m) => m.text);
    expect(names).toEqual(['todo.html', 'test.txt', 'windows.png', 'styles.css']);
  });

  it('finds absolute and home paths', () => {
    const text = 'cat /etc/nginx/nginx.conf or ~/todo.html';
    const matches = findPaths(text);
    expect(matches.map((m) => m.text)).toEqual(['/etc/nginx/nginx.conf', '~/todo.html']);
  });

  it('finds relative paths with slashes and directory paths', () => {
    const text = './build.sh ../parent/config.json src/components/App.tsx src/lib/';
    const matches = findPaths(text);
    expect(matches.map((m) => m.text)).toEqual([
      './build.sh',
      '../parent/config.json',
      'src/components/App.tsx',
      'src/lib/',
    ]);
  });

  it('matches dotfiles and well-known extensionless files', () => {
    const text = '.bashrc .gitignore Dockerfile Makefile';
    const matches = findPaths(text);
    expect(matches.map((m) => m.text)).toEqual([
      '.bashrc',
      '.gitignore',
      'Dockerfile',
      'Makefile',
    ]);
  });

  it('ignores IP addresses, version numbers, permissions and word pairs', () => {
    const text = 'total 16 -rw-r--r-- 192.168.1.1 v1.2.3 0.96.7 and/or 1/2';
    const matches = findPaths(text);
    expect(matches).toHaveLength(0);
  });

  it('preserves line and col suffixes in match length', () => {
    const text = 'Error in src/index.ts:42:15';
    const matches = findPaths(text);
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toBe('src/index.ts');
  });

  it('matches single-quoted and double-quoted filenames with spaces (e.g. GNU ls output)', () => {
    const text = "-rw-r--r-- 1 alun alun 0 Oct 17 17:28 'windows 11.png' \"My Project Plan.pdf\"";
    const matches = findPaths(text);
    expect(matches).toHaveLength(2);
    expect(matches[0].text).toBe('windows 11.png');
    expect(matches[0].length).toBe("'windows 11.png'".length);
    expect(matches[1].text).toBe('My Project Plan.pdf');
    expect(matches[1].length).toBe('"My Project Plan.pdf"'.length);
  });

  it('matches quoted absolute paths and paths with line numbers', () => {
    const text = "See '/home/alun/My Documents/report.txt':12:4";
    const matches = findPaths(text);
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toBe('/home/alun/My Documents/report.txt');
    expect(matches[0].length).toBe("'/home/alun/My Documents/report.txt':12:4".length);
  });

  it('matches backslash-escaped paths with spaces', () => {
    const text = 'cat /var/log/my\\ service\\ error.log and windows\\ 11.png';
    const matches = findPaths(text);
    expect(matches).toHaveLength(2);
    expect(matches[0].text).toBe('/var/log/my service error.log');
    expect(matches[1].text).toBe('windows 11.png');
  });

  it('matches files without extension in ls -l output', () => {
    const text = '-rw-r--r-- 1 alun alun 500 Oct 17 15:00 notes';
    const matches = findPaths(text);
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toBe('notes');

    const execText = '-rwxr-xr-x 1 root root 2048 2026-10-17 15:00 deploy';
    const execMatches = findPaths(execText);
    expect(execMatches).toHaveLength(1);
    expect(execMatches[0].text).toBe('deploy');

    const linkText = 'lrwxrwxrwx 1 alun alun 6 Oct 17 15:00 run -> deploy';
    const linkMatches = findPaths(linkText);
    expect(linkMatches).toHaveLength(2);
    expect(linkMatches.map((m) => m.text)).toEqual(['run', 'deploy']);

    const dirText = 'drwxr-xr-x 2 alun alun 4096 Oct 17 15:00 docs';
    const dirMatches = findPaths(dirText);
    expect(dirMatches).toHaveLength(1);
    expect(dirMatches[0].text).toBe('docs/');
  });

  it('matches files without extension in two-part relative paths', () => {
    const text = 'Check src/notes and docs/guide and bin/server';
    const matches = findPaths(text);
    expect(matches.map((m) => m.text)).toEqual(['src/notes', 'docs/guide', 'bin/server']);
  });

  it('matches quoted files without extension', () => {
    const text = "Open 'notes' or \"deploy\" or 'my script'";
    const matches = findPaths(text);
    expect(matches.map((m) => m.text)).toEqual(['notes', 'deploy', 'my script']);
  });

  it('matches common file inspection command arguments without extension', () => {
    const text = 'cat notes && nano mytest && head -n 20 custom_script';
    const matches = findPaths(text);
    expect(matches.map((m) => m.text)).toEqual(['notes', 'mytest', 'custom_script']);
  });

  it('matches files without extension in multi-column ls output', () => {
    const text = 'notes   mytest   server';
    const matches = findPaths(text);
    expect(matches.map((m) => m.text)).toEqual(['notes', 'mytest', 'server']);
  });
});

describe('terminalLinks - findUrls', () => {
  it('finds URLs correctly', () => {
    const text = 'Visit https://github.com/alun-hub/sshs3 for details.';
    const matches = findUrls(text);
    expect(matches).toHaveLength(1);
    expect(matches[0].url).toBe('https://github.com/alun-hub/sshs3');
  });
});
