import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { ensurePrivateDir, writePrivateFile } from './test-identities.js';

// What each test last did on the live release, so a focused rerun after a test-only fix keeps the
// results that still hold. A kept result is identified by release, spec-file hash and test hash.
// Everything is dropped, and said so, when the release changes (a deploy: app, schema or auth),
// when a shared test file changes (anything under tests/ that is not a spec, or the test packages),
// and per test when that test's own code or its spec's shared code changes. No dependency graph.

const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

export interface LedgerEntry { id: string; file: string; line: number; title: string; project: string; status: string; specHash: string; testHash: string; at: string }
export interface Ledger { version: 1; projectId: string; release: string; shared: Record<string, string>; tests: Record<string, LedgerEntry> }
export interface Kept extends LedgerEntry { release: string }
export interface LedgerOutcome {
  /** Results from earlier runs on this release that still hold (tests not in this run). */
  kept: Kept[];
  /** Why earlier results stopped counting, if they did. */
  dropped: string[];
  /** Every test the ledger knows on this release, after this run. */
  all: LedgerEntry[];
  /** Spec files holding tests whose kept results were dropped because they changed. */
  changedFiles: string[];
}

export const ledgerPath = (root: string): string => join(root, '.somewhere', 'tests', 'ledger.json');
export const keyOf = (project: string, file: string, title: string): string => `${project}␟${file}␟${title}`;

export function readLedger(root: string): Ledger | null {
  const path = ledgerPath(root);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Ledger;
  return parsed.version === 1 ? parsed : null;
}

/** Hashes of the files every spec may share: non-spec files under tests/ and the test packages' versions. */
export function sharedState(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(path); }
      else if (!entry.name.endsWith('.spec.ts')) out[relative(root, path)] = sha(readFileSync(path, 'utf8'));
    }
  };
  walk(join(root, 'tests'));
  for (const pkg of ['@playwright/test', '@somewhere-cloud/cli']) {
    const manifest = join(root, 'node_modules', pkg, 'package.json');
    out[`package ${pkg}`] = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version ?? 'unknown' : 'absent';
  }
  return out;
}

export function changedShared(before: Record<string, string>, now: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(now)])].filter(name => before[name] !== now[name]).sort();
}

// ------------------------------------------------------------------ spec scanning
//
// A test's hash covers its own test(...) call and everything in its spec file that is not a test
// call (imports, helpers, hooks, describe wrappers). A file that cannot be scanned with confidence
// hashes as a whole, so any change to it drops every kept result of that file.

interface Scanned { calls: { title: string | null; start: number; end: number }[] }

/** Skip a string, template, comment or regex literal starting at i; return the index after it, or -1. */
function skipLiteral(text: string, i: number, prevSignificant: string): number {
  const c = text[i];
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < text.length; j++) { if (text[j] === '\\') j++; else if (text[j] === c) return j + 1; else if (text[j] === '\n') return -1; }
    return -1;
  }
  if (c === '`') {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\\') j++;
      else if (text[j] === '`') return j + 1;
      else if (text[j] === '$' && text[j + 1] === '{') { const end = matchClose(text, j + 1); if (end < 0) return -1; j = end; }
    }
    return -1;
  }
  if (c === '/' && text[i + 1] === '/') { const end = text.indexOf('\n', i); return end < 0 ? text.length : end; }
  if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); return end < 0 ? -1 : end + 2; }
  if (c === '/' && (prevSignificant === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prevSignificant))) {
    let inClass = false;
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\\') j++;
      else if (text[j] === '[') inClass = true;
      else if (text[j] === ']') inClass = false;
      else if (text[j] === '/' && !inClass) return j + 1;
      else if (text[j] === '\n') return -1;
    }
    return -1;
  }
  return i;
}

/** Index of the bracket closing the one at `open`, skipping literals and comments; -1 if unbalanced. */
function matchClose(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack = [pairs[text[open]]];
  let prev = text[open];
  for (let i = open + 1; i < text.length; i++) {
    const after = skipLiteral(text, i, prev);
    if (after < 0) return -1;
    if (after !== i) { i = after - 1; prev = 'a'; continue; }
    const c = text[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === ']' || c === '}') { if (stack.pop() !== c) return -1; if (!stack.length) return i; }
    if (!/\s/.test(c)) prev = c;
  }
  return -1;
}

function literalTitle(text: string, at: number): string | null {
  const quote = text[at];
  const end = skipLiteral(text, at, '(');
  if (end < 0) return null;
  const body = text.slice(at + 1, end - 1);
  if (quote === '`' && body.includes('${')) return null;
  return body.replace(/\\(.)/g, '$1');
}

export function scanSpec(text: string): Scanned | null {
  const calls: Scanned['calls'] = [];
  const head = /test(?:\.(?:only|skip|fixme|fail|slow))?\s*\(\s*(['"`])/y;
  let prev = '';
  for (let i = 0; i < text.length; i++) {
    const after = skipLiteral(text, i, prev);
    if (after < 0) return null;
    if (after !== i) { i = after - 1; prev = 'a'; continue; }
    if (text[i] === 't' && !/[\w$.]/.test(text[i - 1] ?? '')) {
      head.lastIndex = i;
      const found = head.exec(text);
      if (found) {
        const open = text.indexOf('(', i);
        const close = matchClose(text, open);
        if (close < 0) return null;
        calls.push({ title: literalTitle(text, found.index + found[0].length - 1), start: i, end: close + 1 });
        i = close;
        prev = ')';
        continue;
      }
    }
    if (!/\s/.test(text[i])) prev = text[i];
  }
  return { calls };
}

/** The spec file's hash, and the hash of the named test in it (null when the test is not in the file). */
export function hashesOf(root: string, file: string, title: string): { specHash: string; testHash: string } | null {
  const path = join(root, file);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const specHash = sha(text);
  const scanned = scanSpec(text);
  if (!scanned) return { specHash, testHash: specHash };
  const own = scanned.calls.filter(call => call.title === title);
  if (!own.length) return scanned.calls.some(call => call.title === null) ? { specHash, testHash: specHash } : null;
  if (own.length > 1 || scanned.calls.some(call => call.title === null)) return { specHash, testHash: specHash };
  let shared = '';
  let at = 0;
  for (const call of scanned.calls) { shared += text.slice(at, call.start); at = call.end; }
  shared += text.slice(at);
  return { specHash, testHash: sha(shared + '\u0000' + text.slice(own[0].start, own[0].end)) };
}

export interface RanTest { id: string; file: string; line: number; titlePath: string[]; project: string; status: string }

/** Record this run and work out what earlier results still hold. A run whose release changed while
 *  it ran records nothing. */
export function recordRun(root: string, input: { projectId: string; release: string | null; ran: RanTest[] }): LedgerOutcome {
  const previous = readLedger(root);
  const shared = sharedState(root);
  const dropped: string[] = [];
  let tests: Record<string, LedgerEntry> = {};
  if (previous && previous.projectId === input.projectId) {
    if (!input.release) dropped.push('the release could not be confirmed for this run');
    else if (previous.release !== input.release) dropped.push(`the release changed (${previous.release} → ${input.release}): a deploy changed the app, schema or auth`);
    else {
      const changed = changedShared(previous.shared, shared);
      if (changed.length) dropped.push(`shared test files changed: ${changed.join(', ')}`);
      else tests = { ...previous.tests };
    }
  }
  const now = new Date().toISOString();
  const ranKeys = new Set<string>();
  for (const test of input.ran) {
    const title = test.titlePath.join(' › ');
    const key = keyOf(test.project, test.file, title);
    ranKeys.add(key);
    const hashes = hashesOf(root, test.file, test.titlePath[test.titlePath.length - 1]);
    tests[key] = { id: test.id, file: test.file, line: test.line, title, project: test.project, status: test.status, specHash: hashes?.specHash ?? 'unknown', testHash: hashes?.testHash ?? 'unknown', at: now };
  }
  const kept: Kept[] = [];
  const changedTests: string[] = [];
  const changedFiles = new Set<string>();
  for (const [key, entry] of Object.entries(tests)) {
    if (ranKeys.has(key)) continue;
    const hashes = hashesOf(root, entry.file, entry.title.split(' › ').pop()!);
    if (!hashes || hashes.testHash !== entry.testHash) { changedTests.push(`${entry.file} › ${entry.title}`); if (hashes) changedFiles.add(entry.file); delete tests[key]; continue; }
    kept.push({ ...entry, release: input.release! });
  }
  if (changedTests.length) dropped.push(`changed or removed since they ran, so not kept: ${changedTests.join('; ')}`);
  if (input.release) ensurePrivateDir(dirname(ledgerPath(root)));
  if (input.release) writePrivateFile(ledgerPath(root), JSON.stringify({ version: 1, projectId: input.projectId, release: input.release, shared, tests } satisfies Ledger) + '\n');
  return { kept, dropped, all: Object.values(tests), changedFiles: [...changedFiles].sort() };
}

/** The earlier failures on this release that a focused rerun should run, or why there are none. */
export function failedOnRelease(root: string, projectId: string, release: string): { ids: string[]; entries: LedgerEntry[] } | { stale: string } {
  const ledger = readLedger(root);
  if (!ledger || ledger.projectId !== projectId) return { stale: 'no earlier run of this project is recorded' };
  if (ledger.release !== release) return { stale: `the release changed since the last run (${ledger.release} → ${release}): a deploy changed the app, schema or auth` };
  const changed = changedShared(ledger.shared, sharedState(root));
  if (changed.length) return { stale: `shared test files changed since the last run: ${changed.join(', ')}` };
  const entries = Object.values(ledger.tests).filter(entry => entry.status !== 'passed' && entry.status !== 'skipped');
  return { ids: entries.map(entry => entry.id), entries };
}
