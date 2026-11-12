// Pre-launch, no legacy anything (founder, 2026-11-04, ; ): what the CLI
// writes into a new app (the init starter, its AGENTS.md and the skills pack), what npm shows
// (README, LICENSE) and every command's --help never name somewhere.tech or the @somewhere-tech
// scope, and never call anything legacy, renamed, moved, deprecated or retired. Copy states what
// the CLI does now. The only .tech strings allowed are the three permanent platform routes.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALLOWED_TECH = ['proxy.somewhere.tech', 'api.somewhere.tech/v1/email/preferences', 'sessions.somewhere.tech/releases/'];
const LEGACY_WORDING = /\blegacy\b|\bformerly\b|\bformer (?:domain|name|brand|package)\b|\bnow redirects\b|\b(?:moved|renamed) to somewhere\b|\bwas published as\b/i;

export function legacyBrandProblems(file, text) {
  const out = [];
  text.split('\n').forEach((line, index) => {
    const where = `${file}:${index + 1}`;
    let rest = line;
    for (const allowed of ALLOWED_TECH) rest = rest.split(allowed).join('');
    if (/somewhere\.tech/i.test(rest)) out.push(`${where} names somewhere.tech`);
    if (/@somewhere-tech\//.test(rest)) out.push(`${where} names the @somewhere-tech scope`);
    if (LEGACY_WORDING.test(rest)) out.push(`${where} uses legacy or rename wording`);
  });
  return out;
}

function customerFacingFiles() {
  const lib = join(ROOT, 'src/lib');
  const starter = readdirSync(lib).filter((name) => /^init-.*\.ts$/.test(name)).map((name) => join('src/lib', name));
  return [...starter, 'src/lib/skills-pack.generated.ts', 'README.md', 'LICENSE'];
}

test('starter, skills pack, README and LICENSE carry no .tech, old scope or legacy wording', () => {
  const files = customerFacingFiles();
  assert.ok(files.length >= 8, 'the scanned set includes the starter sources');
  const problems = files.flatMap((rel) => legacyBrandProblems(rel, readFileSync(join(ROOT, rel), 'utf8')));
  assert.deepEqual(problems, []);
});

test('planted old-brand and legacy text fails; the three routes pass', () => {
  assert.equal(legacyBrandProblems('f', 'MIT © somewhere.tech').length, 1);
  assert.equal(legacyBrandProblems('f', 'npm i -g @somewhere-tech/cli').length, 1);
  assert.equal(legacyBrandProblems('f', 'This package was published as `@somewhere-tech/cli` through 0.37.85').length, 2);
  assert.equal(legacyBrandProblems('f', '/* Legacy alert from feedback.tsx */').length, 1);
  assert.equal(legacyBrandProblems('f', 'Somewhere moved to somewhere.cloud.').length, 1);
  assert.equal(legacyBrandProblems('f', 'CNAME to proxy.somewhere.tech').length, 0);
  assert.equal(legacyBrandProblems('f', 'https://api.somewhere.tech/v1/email/preferences?token=x').length, 0);
  assert.equal(legacyBrandProblems('f', 'https://sessions.somewhere.tech/releases/latest.json').length, 0);
  assert.equal(legacyBrandProblems('f', 'somewhere login --legacy').length, 1);
  assert.equal(legacyBrandProblems('f', 'npm i -g @somewhere-cloud/cli').length, 0);
});

// Help is history-free too: a flag or command describes what it does today, never that it was
// renamed, moved, deprecated or retired. Walks every registered command, hidden ones included.
const HELP_HISTORY = /\bdeprecated\b|\bretired\b|\bretirement\b|\bolder CLI\b|\bold CLI\b|\bhas moved\b|\bwas renamed\b/i;

async function allHelp() {
  const index = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');
  const program = new Command().name('somewhere');
  for (const [, names, path] of index.matchAll(/^import \{ ([^}]*register[^}]*) \} from '\.\/(commands\/[^']+)';$/gm)) {
    const mod = await import(join(ROOT, 'dist', path));
    for (const name of names.split(',').map((n) => n.trim())) mod[name](program);
  }
  const out = [];
  const walk = (cmd, path) => {
    let text = '';
    cmd.configureOutput({ writeOut: (chunk) => { text += chunk; }, writeErr: (chunk) => { text += chunk; } });
    cmd.outputHelp();
    out.push({ path, text });
    for (const sub of cmd.commands) walk(sub, `${path} ${sub.name()}`);
  };
  walk(program, 'somewhere');
  return out;
}

test('every command\'s --help, hidden commands included, carries no legacy or history wording', async () => {
  const helps = await allHelp();
  assert.ok(helps.length > 100, `walked ${helps.length} commands`);
  assert.ok(helps.some(({ path }) => path === 'somewhere db apply-schema'), 'hidden commands are walked');
  const problems = helps.flatMap(({ path, text }) => [
    ...legacyBrandProblems(path, text),
    ...text.split('\n').filter((line) => HELP_HISTORY.test(line)).map((line) => `${path}: ${line.trim()}`),
  ]);
  assert.deepEqual(problems, []);
});
