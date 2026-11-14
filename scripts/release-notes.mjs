#!/usr/bin/env node
// Writes the CHANGELOG.md entry for a release and keeps the file newest first.
//
//   node scripts/release-notes.mjs <version>
//
// The release script runs this when it sets the package version, so every published
// version has an entry. An entry that already exists for <version> is kept as written.
// A new entry is made from the titles of the pull requests merged since the previous
// version, plus one line for each platform rule set this release brings up to date.
// Every run rewrites the file as "# Changelog" followed by every version, newest first.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = /^\d+\.\d+\.\d+$/;

export function compareVersions(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Every `## x.y.z` section, wherever it sits in the file. */
export function parseChangelog(markdown) {
  const sections = new Map();
  let current = null;
  for (const line of markdown.split('\n')) {
    const heading = /^## (\S+)\s*$/.exec(line);
    if (heading && VERSION.test(heading[1])) {
      current = heading[1];
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (/^# /.test(line)) { current = null; continue; }
    if (current) sections.get(current).push(line);
  }
  return new Map([...sections].map(([v, lines]) => [v, lines.join('\n').trim()]));
}

export function renderChangelog(sections) {
  const versions = [...sections.keys()].sort((a, b) => compareVersions(b, a));
  return '# Changelog\n\n' + versions.map((v) => `## ${v}\n\n${sections.get(v)}\n`).join('\n');
}

/** A merged pull request title as a plain line for someone using the CLI, or null
 *  when it is a release or platform-sync commit (those are described by file below). */
export function plainTitle(subject) {
  if (/^(Release \d|release\(cli\)|chore\(release\)|Refresh (CLI|platform) vendors|Republish )/i.test(subject)) return null;
  let text = subject
    .replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '')
    .replace(/\s*\(#\d+\)/g, '')
    .replace(/\(?\b(tsk|pfb)_[0-9a-f]+\b\)?,?/gi, '')
    .replace(/;?\s*release \d+\.\d+\.\d+\b/gi, '')
    .replace(/\(\s*[,\s]*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[;,\s]+$/, '');
  if (!text) return null;
  if (!/^somewhere\b/.test(text)) text = text[0].toUpperCase() + text.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Platform rule sets the CLI carries, by the files that hold them. */
const SYNCED = [
  [/^runtime\/declared-data\.cjs$/, 'somewhere typecheck checks db/schema.ts with the platform\'s current rules.'],
  [/^runtime\/source-lint\.cjs$|^runtime\/SOURCE-LINT-VENDOR\.json$/, 'Lint checks match the platform\'s current rules.'],
  [/^src\/lib\/vendor\/(deploy-paths\.ts|DEPLOY-PATHS-VENDOR\.json)$/, 'somewhere deploy chooses the files to publish with the platform\'s current rules.'],
  [/^src\/lib\/vendor\/(repro-guidance\.ts|REPRO-GUIDANCE-VENDOR\.json)$/, 'Error guidance matches the platform\'s current messages.'],
  [/^runtime\/browser-probes\.mjs$/, 'somewhere browser and somewhere verify use the platform\'s current page checks.'],
  [/^src\/lib\/skills-pack\.generated\.ts$/, 'The agent skills somewhere init writes match the platform\'s current pack.'],
];

export function entryLines(subjects, changedFiles) {
  const lines = [];
  for (const subject of subjects) {
    const line = plainTitle(subject);
    if (line && !lines.includes(line)) lines.push(line);
  }
  for (const [pattern, line] of SYNCED) {
    if (changedFiles.some((file) => pattern.test(file)) && !lines.includes(line)) lines.push(line);
  }
  if (!lines.length) lines.push('Maintenance release: commands work as in the previous version.');
  return lines.map((line) => `- ${line}`).join('\n');
}

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/** The commit that set the previous release's version; its later commits are this release. */
function previousRelease(version) {
  // Newest first: skip commits already at `version`, then walk back through the run of commits
  // at the previous version; the oldest of that run is the commit that set it.
  let base = null, previous = null;
  for (const sha of git('log', '--first-parent', '--format=%H', '--', 'package.json').split('\n').filter(Boolean)) {
    const v = JSON.parse(git('show', `${sha}:package.json`)).version;
    if (v === version) continue;
    if (previous === null) previous = v;
    if (v !== previous) break;
    base = sha;
  }
  return base;
}

function main() {
  const version = process.argv[2];
  if (!VERSION.test(version ?? '')) throw new Error('usage: node scripts/release-notes.mjs <x.y.z>');
  const path = join(root, 'CHANGELOG.md');
  const sections = parseChangelog(readFileSync(path, 'utf8'));
  if (!sections.has(version)) {
    const base = previousRelease(version);
    const subjects = base ? git('log', '--first-parent', '--format=%s', `${base}..HEAD`).split('\n').filter(Boolean) : [];
    const changed = base ? git('diff', '--name-only', base).split('\n').filter(Boolean) : [];
    sections.set(version, entryLines(subjects, changed));
    console.log(`CHANGELOG.md: wrote ${version}`);
  } else {
    console.log(`CHANGELOG.md: ${version} already has an entry`);
  }
  writeFileSync(path, renderChangelog(sections));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
