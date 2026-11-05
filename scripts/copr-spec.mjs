#!/usr/bin/env node
//
// Pure helpers for scripts/copr-build.sh: validate a release tag and render the COPR spec for a
// release. Kept apart from the shell script so the string handling is testable.
//
//   node scripts/copr-spec.mjs valid-tag <tag>
//   node scripts/copr-spec.mjs render --spec <file> --version <x.y.z> --sha256 <hex> --release <n> --out <file>
//
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PACKAGER_RE = /^[^<>\r\n]+ <[^<>\r\n]+>$/;

/** True for a release tag of the form vX.Y.Z (three numeric segments, as deploy.sh creates). */
export function isValidTag(tag) {
  return typeof tag === 'string' && /^v\d+\.\d+\.\d+$/.test(tag);
}

/** RPM %changelog date, e.g. "Fri Oct 23 2026" (UTC). */
export function rpmChangelogDate(date) {
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${DAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${day} ${date.getUTCFullYear()}`;
}

// A checkout with autocrlf (the Windows CI runner) gives the spec CRLF line endings; rpmbuild runs on Linux
// and wants LF, so both entry points normalise first.
const toLf = (text) => text.replace(/\r\n/g, '\n');

/** "Name <email>" from the newest %changelog entry, or null when there is none. */
export function latestChangelogPackager(specText) {
  const m = /^\* \w{3} \w{3} \d{2} \d{4} (.+? <[^<>\r\n]+>) - \S+$/m.exec(toLf(specText));
  return m ? m[1] : null;
}

function replaceExactlyOne(text, re, replacement, label) {
  const matches = text.match(new RegExp(re.source, `${re.flags.replace('g', '')}g`)) ?? [];
  if (matches.length !== 1) {
    throw new Error(`spec: expected exactly one "${label}" line, found ${matches.length}`);
  }
  return text.replace(re, () => replacement);
}

/**
 * The spec for one release: sets Version, Release and source_sha256 and adds a %changelog entry.
 * Throws if an input is malformed or a line to rewrite is missing or duplicated, so a spec that
 * has drifted from the expected layout is never built.
 */
export function renderSpec(specText, { version, sha256, release, date, packager }) {
  if (!VERSION_RE.test(version)) throw new Error(`invalid version: ${version}`);
  if (!SHA256_RE.test(sha256)) throw new Error('invalid sha256 (expected 64 lowercase hex characters)');
  if (!Number.isInteger(release) || release < 1) throw new Error(`invalid release: ${release}`);
  if (!PACKAGER_RE.test(packager)) throw new Error(`invalid packager: ${packager}`);

  let out = replaceExactlyOne(toLf(specText), /^Version:.*$/m, `Version:        ${version}`, 'Version:');
  out = replaceExactlyOne(out, /^Release:.*$/m, `Release:        ${release}%{?dist}`, 'Release:');
  out = replaceExactlyOne(out, /^%global source_sha256 .*$/m, `%global source_sha256 ${sha256}`, '%global source_sha256');

  const bullets = [`- Update to ${version}`];
  if (release > 1) bullets.push(`- Rebuild (release ${release})`);
  const entry = `* ${rpmChangelogDate(date)} ${packager} - ${version}-${release}\n${bullets.join('\n')}\n\n`;
  return replaceExactlyOne(out, /^%changelog\n/m, `%changelog\n${entry}`, '%changelog');
}

function option(args, name) {
  const i = args.indexOf(name);
  if (i < 0 || i === args.length - 1) throw new Error(`missing ${name}`);
  return args[i + 1];
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === 'valid-tag') {
    process.exit(isValidTag(args[0]) ? 0 : 1);
  }
  if (command === 'render') {
    const specText = readFileSync(option(args, '--spec'), 'utf8');
    const packager = latestChangelogPackager(specText);
    if (!packager) throw new Error('spec: no %changelog entry to take the packager from');
    const rendered = renderSpec(specText, {
      version: option(args, '--version'),
      sha256: option(args, '--sha256'),
      release: Number(option(args, '--release')),
      date: new Date(),
      packager,
    });
    writeFileSync(option(args, '--out'), rendered);
    return;
  }
  throw new Error('usage: copr-spec.mjs valid-tag <tag> | render --spec <file> --version <v> --sha256 <hex> --release <n> --out <file>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
