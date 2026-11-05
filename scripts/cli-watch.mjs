#!/usr/bin/env node
// Watches upstream repos for the external CLI binaries we shell out to (ssh, age, ykman)
// and files a GitHub issue when a new tag/release appears, so we can check our flag and
// output-parsing assumptions before Linux/Windows distros package the new version.
//
// Run manually: node scripts/cli-watch.mjs
// Run in CI: .github/workflows/cli-watch.yml (weekly schedule)

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASELINE_PATH = fileURLToPath(new URL('../.github/cli-watch/baseline.json', import.meta.url));

const TARGETS = [
  {
    key: 'openssh',
    name: 'OpenSSH (ssh client)',
    repo: 'openssh/openssh-portable',
    mode: 'tags',
    // Portable releases are tagged e.g. V_10_6_P1 (no GitHub "releases" are published).
    tagPattern: /^V_(\d+)_(\d+)(?:_P(\d+))?$/,
    sortKey: (tag, m) => [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)],
    dependents: [
      'src/main/storage/sftp/OpenSshSftpProcess.ts — spawns `ssh -s sftp`, parses host-key/auth prompts from stderr (parseHostKeyPrompt)',
      'src/main/ssh/SSHPtyManager.ts — interactive ssh PTY sessions, ControlPath/BatchMode flags',
      'src/main/ssh/KeyInstallService.ts — ssh-based key install subprocess',
    ],
  },
  {
    key: 'age',
    name: 'age (encryption)',
    repo: 'FiloSottile/age',
    mode: 'release',
    dependents: [
      'src/main/services/AgePtyPinRelay.ts — spawns age, FIFO-based secret relay',
      'src/main/services/TeamVaultCryptoService.ts — age encrypt/decrypt flags and output parsing',
      'src/main/services/AgeBinaryResolver.ts — binary resolution/version assumptions',
    ],
  },
  {
    key: 'ykman',
    name: 'ykman (YubiKey Manager CLI)',
    repo: 'Yubico/yubikey-manager',
    mode: 'release',
    dependents: ['src/main/smartcard/YkmanFido.ts — `ykman fido credentials ...` subcommands/flags'],
  },
];

async function ghApi(path) {
  const res = await fetch(`https://api.github.com/repos/${path}`, {
    headers: {
      'User-Agent': 'sshs3-cli-watch',
      Accept: 'application/vnd.github+json',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function latestTagFor(target) {
  if (target.mode === 'release') {
    const release = await ghApi(`${target.repo}/releases/latest`);
    return { tag: release.tag_name, url: release.html_url };
  }
  // mode === 'tags': GitHub's tag order isn't guaranteed to be version-sorted, so pick
  // the highest version ourselves out of the most recent page.
  const tags = await ghApi(`${target.repo}/tags?per_page=50`);
  let best = null;
  for (const t of tags) {
    const m = target.tagPattern.exec(t.name);
    if (!m) continue;
    const key = target.sortKey(t.name, m);
    if (!best || compareVersionKeys(key, best.key) > 0) {
      best = { tag: t.name, key, url: `https://github.com/${target.repo}/releases/tag/${t.name}` };
    }
  }
  if (!best) throw new Error(`No tag matching ${target.tagPattern} found for ${target.repo}`);
  return { tag: best.tag, url: best.url };
}

function compareVersionKeys(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function readBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
}

function writeBaseline(baseline) {
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
}

function issueAlreadyFiled(target, tag) {
  try {
    const out = execFileSync(
      'gh',
      ['issue', 'list', '--label', 'cli-watch', '--state', 'all', '--search', `"${target.name}" "${tag}"`, '--json', 'number'],
      { encoding: 'utf-8' }
    );
    return JSON.parse(out).length > 0;
  } catch (err) {
    // `gh` not available/authenticated (e.g. local dry run) — don't block on dedupe.
    console.warn(`Could not check existing issues for ${target.key}: ${err.message}`);
    return false;
  }
}

function fileIssue(target, oldTag, newTag, releaseUrl) {
  const title = `[cli-watch] ${target.name}: ${oldTag} -> ${newTag}`;
  const body = [
    `Upstream released a new version of **${target.name}** (\`${target.repo}\`): \`${oldTag}\` -> \`${newTag}\`.`,
    '',
    `Release/tag: ${releaseUrl}`,
    '',
    'This was caught by scheduled release-watching, before Linux/Windows distros package it. ' +
      'Check whether anything we depend on changed (flags, output/prompt text format, exit codes) in:',
    '',
    ...target.dependents.map((d) => `- [ ] ${d}`),
    '',
    '_Filed automatically by `scripts/cli-watch.mjs` — see `docs/security-audit-plan.md` for why this exists._',
  ].join('\n');

  execFileSync('gh', ['issue', 'create', '--title', title, '--body', body, '--label', 'cli-watch'], {
    stdio: 'inherit',
  });
}

async function main() {
  const baseline = readBaseline();
  let changed = false;

  for (const target of TARGETS) {
    let latest;
    try {
      latest = await latestTagFor(target);
    } catch (err) {
      console.error(`Failed to check ${target.key}: ${err.message}`);
      continue;
    }

    const previousTag = baseline[target.key]?.tag;
    if (latest.tag === previousTag) {
      console.log(`${target.key}: no change (${latest.tag})`);
      continue;
    }

    console.log(`${target.key}: ${previousTag ?? '(none)'} -> ${latest.tag}`);
    if (previousTag && !issueAlreadyFiled(target, latest.tag)) {
      fileIssue(target, previousTag, latest.tag, latest.url);
    }

    baseline[target.key] = { tag: latest.tag, checkedAt: new Date().toISOString() };
    changed = true;
  }

  if (changed) {
    writeBaseline(baseline);
    console.log('Baseline updated.');
  } else {
    console.log('No changes.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
