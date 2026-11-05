import { describe, expect, it } from 'vitest';
import { findPaths } from './terminalLinks';

/**
 * Text that looks like paths or filenames but is just prose. It is what a chat-style session (an AI coding
 * assistant, a changelog, a man page) prints, and none of it should become a hover link.
 */
const PROSE_LINES = [
  'Use Node.js and Next.js with Vue.js for the front end.',
  'See example.com or visit docs.example.org/guide for details.',
  'Open www.example.se and mail.example.se, or try github.com/owner/repo.',
  'Contact support@example.com or admin@mail.example.se.',
  'This works, e.g. for tests, i.e. when mocking, a.k.a. stubbing.',
  'Throughput is 3.5MB/s, 100km/h and 10req/s, latency 1.5x lower, took 2.5s.',
  'Version 1.2.3-rc1 and v2.0.1 and 12.5GB of 100GB used.',
  'Choose client/server, input/output or pass/fail, then enable/disable it.',
  'Both he/she and his/her are ambiguous; and/or too, 10/19 as a date.',
  'The ASP.NET and Socket.io stacks.',
  'Pi is about 3.14 and the ratio is 2.5.',
];

/** Real paths and filenames that must keep working. */
const PATH_LINES: [string, string][] = [
  ['cat /var/log/syslog', '/var/log/syslog'],
  ['open src/app/main.ts', 'src/app/main.ts'],
  ['edit package.json', 'package.json'],
  ['vim ~/.bashrc', '~/.bashrc'],
  ['see ./scripts/deploy.sh:12', './scripts/deploy.sh'],
  ['tail 2024.01.csv', '2024.01.csv'],
  ['read README.md', 'README.md'],
  ['edit docker-compose.yml', 'docker-compose.yml'],
  ['load .env.local', '.env.local'],
  ['open notes.org', 'notes.org'],
  ['cp logo.ai /tmp/', 'logo.ai'],
];

describe('findPaths on prose', () => {
  it.each(PROSE_LINES)('does not link anything in: %s', (line) => {
    expect(findPaths(line).map((p) => p.text)).toEqual([]);
  });
});

describe('findPaths on real paths', () => {
  it.each(PATH_LINES)('still links %s', (line, expected) => {
    expect(findPaths(line).map((p) => p.text)).toContain(expected);
  });
});
