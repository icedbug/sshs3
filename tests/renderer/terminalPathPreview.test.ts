import { describe, it, expect } from 'vitest';
import {
  detectFileType,
  getFileExtension,
  getLanguageLabel,
  isSensitiveFilePath,
  isNetworkUncPath,
  isUncPath,
  resolvePathDetails,
  truncateSnippet,
} from '../../src/renderer/src/lib/terminalPathPreview';

describe('terminalPathPreview', () => {
  it('treats WSL shares as local but every other UNC path as a network share', () => {
    expect(isNetworkUncPath('\\\\attacker\\share\\f', true)).toBe(true);
    expect(isNetworkUncPath('//attacker/share/f', true)).toBe(true);
    expect(isNetworkUncPath('\\\\wsl.localhost.evil.com\\share', true)).toBe(true);
    expect(isNetworkUncPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\a.md', true)).toBe(false);
    expect(isNetworkUncPath('\\\\wsl$\\Ubuntu\\home', true)).toBe(false);
    expect(isNetworkUncPath('C:\\Users\\me', true)).toBe(false);
  });

  it('recognises UNC paths, which must never be stat-ed on hover', () => {
    for (const unc of [
      '\\\\attacker.example.com\\share\\f.txt',
      '//attacker.example.com/share/f.txt',
      '\\\\?\\C:\\x',
      '\\\\.\\pipe\\x',
      '\\/attacker/share',
      '/\\attacker\\share',
      '  \\\\attacker\\share',
    ]) {
      expect(isUncPath(unc, true)).toBe(true);
    }
    for (const local of ['C:\\Users\\me\\a.txt', '/home/me/a.txt', 'src/a.ts']) {
      expect(isUncPath(local, true)).toBe(false);
    }
  });

  it('only counts forward and mixed separators as UNC on Windows; `//usr/bin` is an ordinary path elsewhere', () => {
    expect(isUncPath('//usr/bin', false)).toBe(false);
    expect(isNetworkUncPath('//etc/passwd', false)).toBe(false);
    expect(isUncPath('/\\x', false)).toBe(false);
    // The backslash form can only ever mean a network share, so it is blocked everywhere.
    expect(isUncPath('\\\\attacker\\share', false)).toBe(true);
  });

  it('extracts correct file extensions', () => {
    expect(getFileExtension('/var/log/nginx/access.log')).toBe('log');
    expect(getFileExtension('src/components/Terminal.tsx')).toBe('tsx');
    expect(getFileExtension('.env')).toBe('env');
    expect(getFileExtension('.gitignore')).toBe('gitignore');
    expect(getFileExtension('/app/Dockerfile')).toBe('dockerfile');
    expect(getFileExtension('image.PNG')).toBe('png');
    expect(getFileExtension('no_ext')).toBe('');
  });

  it('detects file categories accurately', () => {
    expect(detectFileType('/images/logo.png')).toBe('image');
    expect(detectFileType('/src/index.ts')).toBe('code');
    expect(detectFileType('/etc/nginx/nginx.conf')).toBe('config');
    expect(detectFileType('/etc/app/config.yaml')).toBe('config');
    expect(detectFileType('README.md')).toBe('markdown');
    expect(detectFileType('bundle.tar.gz')).toBe('archive');
    expect(detectFileType('/var/log/syslog')).toBe('document');
    expect(detectFileType('/etc/hosts')).toBe('document');
    expect(detectFileType('Makefile')).toBe('code');
    expect(detectFileType('Dockerfile')).toBe('config');
    expect(detectFileType('/var/log/')).toBe('directory');
  });

  it('provides friendly language labels', () => {
    expect(getLanguageLabel('app.ts')).toBe('TypeScript');
    expect(getLanguageLabel('config.json')).toBe('JSON');
    expect(getLanguageLabel('vector.svg')).toBe('SVG Vector');
    expect(getLanguageLabel('document.txt')).toBe('Text Document');
    expect(getLanguageLabel('syslog')).toBe('Text File');
    expect(getLanguageLabel('Makefile')).toBe('Makefile');
    expect(getLanguageLabel('Dockerfile')).toBe('Dockerfile');
    expect(getLanguageLabel('folder/')).toBe('Directory');
  });

  it('resolves path details including ~ expansion and parents', () => {
    const details = resolvePathDetails('~/projects/sshs3/package.json', '/home/alun');
    expect(details.basename).toBe('package.json');
    expect(details.fullPath).toBe('/home/alun/projects/sshs3/package.json');
    expect(details.parentDir).toBe('/home/alun/projects/sshs3');
    expect(details.isDir).toBe(false);
    expect(details.category).toBe('config');
    expect(details.label).toBe('JSON');

    const dirDetails = resolvePathDetails('/var/log/', '/home/alun');
    expect(dirDetails.isDir).toBe(true);
    expect(dirDetails.category).toBe('directory');
    expect(dirDetails.basename).toBe('log');

    const relFileDetails = resolvePathDetails('todo.html', '/home/alun');
    expect(relFileDetails.basename).toBe('todo.html');
    expect(relFileDetails.fullPath).toBe('/home/alun/todo.html');
    expect(relFileDetails.parentDir).toBe('/home/alun');
    expect(relFileDetails.category).toBe('code');
    expect(relFileDetails.label).toBe('HTML');

    const cwdDetails = resolvePathDetails('./src/App.tsx', '/home/alun', '/home/alun/sshs3');
    expect(cwdDetails.fullPath).toBe('/home/alun/sshs3/src/App.tsx');
    expect(cwdDetails.basename).toBe('App.tsx');

    const quotedDetails = resolvePathDetails("'windows 11.png'", '/home/alun', '/home/alun/sshs3');
    expect(quotedDetails.fullPath).toBe('/home/alun/sshs3/windows 11.png');
    expect(quotedDetails.basename).toBe('windows 11.png');

    const escapedDetails = resolvePathDetails('my\\ file\\ with\\ spaces.pdf', '/home/alun', '/home/alun/sshs3');
    expect(escapedDetails.fullPath).toBe('/home/alun/sshs3/my file with spaces.pdf');
    expect(escapedDetails.basename).toBe('my file with spaces.pdf');
    expect(escapedDetails.extension).toBe('pdf');

    const invalidCwdDetails = resolvePathDetails('avanza.png', '/home/alun', '1');
    expect(invalidCwdDetails.fullPath).toBe('/home/alun/avanza.png');

    const tildeCwdDetails = resolvePathDetails('avanza.png', '/home/alun', '~');
    expect(tildeCwdDetails.fullPath).toBe('/home/alun/avanza.png');
  });

  it('truncates snippets with line count and width limits', () => {
    const longText = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join('\n');
    const snippet = truncateSnippet(longText, 5);
    expect(snippet.split('\n')).toHaveLength(5);
    expect(snippet).toContain('Line 5');
    expect(snippet).not.toContain('Line 6');

    const longLine = 'a'.repeat(200);
    const lineSnippet = truncateSnippet(longLine, 1, 50);
    expect(lineSnippet).toHaveLength(51); // 50 chars + ellipsis
    expect(lineSnippet.endsWith('…')).toBe(true);
  });

  it('flags files whose content must not be previewed', () => {
    for (const p of ['/home/u/.ssh/id_ed25519', '/etc/shadow', '/srv/.env', '/srv/.env.production', 'cert/server.pem', 'tls.key', '/etc/shadow-', 'k.ppk', 'x.tfstate', '.git-credentials']) {
      expect(isSensitiveFilePath(p)).toBe(true);
    }
    for (const p of ['/home/u/.ssh/id_ed25519.pub', '/srv/.env.example', '/etc/hosts', 'README.md', '/']) {
      expect(isSensitiveFilePath(p)).toBe(false);
    }
  });
});

describe('resolvePathDetails on Windows', () => {
  it('joins a relative file onto a Windows cwd with backslashes', () => {
    const d = resolvePathDetails('README.md', 'C:\\Users\\alun', 'C:\\Users\\alun\\sshs3');
    expect(d.fullPath).toBe('C:\\Users\\alun\\sshs3\\README.md');
    expect(d.basename).toBe('README.md');
    expect(d.parentDir).toBe('C:\\Users\\alun\\sshs3');
  });

  it('falls back to the Windows home without mixing separators', () => {
    expect(resolvePathDetails('./a/b.txt', 'C:\\Users\\alun').fullPath).toBe('C:\\Users\\alun\\a\\b.txt');
  });

  it('keeps absolute Windows paths and resolves ~ against a Windows home', () => {
    expect(resolvePathDetails('D:\\x\\y.md', 'C:\\Users\\alun').fullPath).toBe('D:\\x\\y.md');
    expect(resolvePathDetails('~/notes.md', 'C:\\Users\\alun').fullPath).toBe('C:\\Users\\alun\\notes.md');
  });
});
