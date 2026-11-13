import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { ensurePrivateDir, writePrivateFile } from './test-identities.js';

// What each test last did, so a focused rerun after a test-only fix keeps the results that still
// hold. A kept result belongs to one exact set of inputs: the project, API, origin, release,
// platform version, environment-variable listing, the somewhere CLI that ran it, the browser and
// Playwright, and every project file outside node_modules (spec files are tracked per test: its
// spec file and its own test must be unchanged). If any input differs, everything is dropped and the
// run says which. Kept results also expire after KEEP_MS, because an environment value can change
// without any visible version. When in doubt a result is dropped and the test runs again.
// No dependency graph.

const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);
export const KEEP_MS = 30 * 60_000;

export type Inputs = Record<string, string>;
export interface LedgerEntry { id: string; file: string; line: number; title: string; project: string; status: string; specHash: string; testHash: string; at: string; was?: string }
interface FullRun { at: string; keys: string[]; specs: string }
export interface Ledger { version: 2; inputs: Inputs; tests: Record<string, LedgerEntry>; full: FullRun | null }
export interface Kept extends LedgerEntry { release: string }
export interface LedgerOutcome {
  /** Results from earlier runs with the same inputs that still hold (tests not in this run). */
  kept: Kept[];
  /** Why earlier results stopped counting, if they did. */
  dropped: string[];
  /** Every test the ledger knows for these inputs, after this run. */
  all: LedgerEntry[];
  /** Tests that must run before the suite is green: failed, or changed since their result. */
  owed: LedgerEntry[];
  /** Spec files holding tests that changed since their result. */
  changedFiles: string[];
  /** True only when the last full run's tests are all known for these inputs and no spec was added or removed since. */
  complete: boolean;
}

export const ledgerPath = (root: string): string => join(root, '.somewhere', 'tests', 'ledger.json');
export const keyOf = (project: string, file: string, title: string): string => `${project}␟${file}␟${title}`;
const NOT_RUN = new Set(['passed', 'skipped']);
const isOwed = (entry: LedgerEntry): boolean => !NOT_RUN.has(entry.status);

export function readLedger(root: string): Ledger | null {
  const path = ledgerPath(root);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Ledger;
  return parsed.version === 2 ? parsed : null;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.somewhere', 'test-results', 'playwright-report', 'dist', 'build']);
/** One entry per project file outside node_modules and generated folders: `file:<path>` → content
 *  hash (a file over 2 MB hashes its size and modification time). Spec files are tracked per test. */
export function projectFiles(root: string): Inputs {
  const out: Inputs = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.DS_Store') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(path); continue; }
      if (!entry.isFile() || entry.name.endsWith('.spec.ts')) continue;
      const stat = statSync(path);
      out['file:' + relative(root, path)] = stat.size > 2_000_000 ? `size ${stat.size} mtime ${stat.mtimeMs}` : sha(readFileSync(path, 'utf8'));
    }
  };
  walk(root);
  return out;
}

/** The spec files the full suite collects, as one hash: a spec added or removed means the last full run no longer covers the suite. */
export function specSet(root: string): string {
  const specs: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(path); }
      else if (entry.name.endsWith('.spec.ts')) specs.push(relative(root, path));
    }
  };
  walk(join(root, 'tests'));
  return sha(specs.sort().join('\n'));
}

const LABELS: Record<string, string> = {
  project: 'the project', api: 'the API environment', origin: 'the app origin', platform: 'the platform version',
  env: "the project's environment variables", runner: 'the somewhere CLI that runs the tests', browser: 'the browser', playwright: 'Playwright',
};
/** Which inputs differ, in words; files are named. */
export function changedInputs(before: Inputs, now: Inputs): string[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(now)])].filter(name => before[name] !== now[name]).sort();
  const words: string[] = [];
  if (names.includes('release')) words.push(`the release changed (${before.release ?? 'none'} → ${now.release ?? 'none'}): a deploy or rollback changed the app, schema or auth`);
  for (const name of names) if (LABELS[name]) words.push(`${LABELS[name]} changed`);
  const files = names.filter(name => name.startsWith('file:')).map(name => name.slice(5));
  if (files.length) words.push(`project files changed: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ` and ${files.length - 6} more` : ''}`);
  return words;
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

/** Record this run and work out what earlier results still hold. `inputs` is null when this run's
 *  release or inputs could not be confirmed from start to end: then nothing is recorded or kept. */
export function recordRun(root: string, input: { inputs: Inputs | null; ran: RanTest[]; full: boolean; now?: number }): LedgerOutcome {
  const now = input.now ?? Date.now();
  const empty: LedgerOutcome = { kept: [], dropped: [], all: [], owed: [], changedFiles: [], complete: false };
  if (!input.inputs) return { ...empty, dropped: ['this run could not be tied to one release and one set of inputs, so its results are not kept'] };
  const previous = readLedger(root);
  const dropped: string[] = [];
  let tests: Record<string, LedgerEntry> = {};
  let full: FullRun | null = null;
  if (previous) {
    const changed = changedInputs(previous.inputs, input.inputs);
    if (changed.length) dropped.push(...changed);
    else { tests = { ...previous.tests }; full = previous.full; }
  }
  for (const [key, entry] of Object.entries(tests)) {
    if (now - Date.parse(entry.at) > KEEP_MS) { delete tests[key]; dropped.push(`older than ${KEEP_MS / 60_000} minutes: ${entry.file} › ${entry.title}`); }
  }
  if (input.full) { tests = {}; full = null; }
  const at = new Date(now).toISOString();
  const ranKeys = new Set<string>();
  for (const test of input.ran) {
    const title = test.titlePath.join(' › ');
    const key = keyOf(test.project, test.file, title);
    ranKeys.add(key);
    const hashes = hashesOf(root, test.file, test.titlePath[test.titlePath.length - 1]);
    tests[key] = { id: test.id, file: test.file, line: test.line, title, project: test.project, status: test.status, specHash: hashes?.specHash ?? 'unknown', testHash: hashes?.testHash ?? 'unknown', at };
  }
  if (input.full) full = { at, keys: [...ranKeys].sort(), specs: specSet(root) };
  const kept: Kept[] = [];
  const changedFiles = new Set<string>();
  const removed: string[] = [];
  for (const [key, entry] of Object.entries(tests)) {
    if (ranKeys.has(key)) continue;
    const hashes = hashesOf(root, entry.file, entry.title.split(' › ').pop()!);
    if (!hashes) { removed.push(`${entry.file} › ${entry.title}`); delete tests[key]; continue; }
    // Any change to its spec file, not only to the test itself, means the result no longer holds:
    // the test is owed a run (a failure stays owed; it is never forgotten).
    if (hashes.specHash !== entry.specHash || hashes.testHash !== entry.testHash) {
      if (entry.status !== 'needs-run') tests[key] = { ...entry, status: 'needs-run', was: entry.status };
      changedFiles.add(entry.file);
      continue;
    }
    if (entry.status === 'needs-run') { changedFiles.add(entry.file); continue; }
    kept.push({ ...entry, release: input.inputs.release });
  }
  if (removed.length) dropped.push(`no longer in their spec files: ${removed.join('; ')}`);
  if (changedFiles.size) dropped.push(`changed since they ran, so they must run again: ${[...changedFiles].sort().join(', ')}`);
  ensurePrivateDir(dirname(ledgerPath(root)));
  writePrivateFile(ledgerPath(root), JSON.stringify({ version: 2, inputs: input.inputs, tests, full } satisfies Ledger) + '\n');
  const all = Object.values(tests);
  const complete = Boolean(full && full.specs === specSet(root) && full.keys.every(key => tests[key]));
  return { kept, dropped, all, owed: all.filter(isOwed), changedFiles: [...changedFiles].sort(), complete };
}

/** The tests a focused rerun must run (failed, or changed since their result), or why earlier
 *  results no longer count. */
export function owedFor(root: string, inputs: Inputs): { ids: string[]; entries: LedgerEntry[]; complete: boolean } | { stale: string } {
  const ledger = readLedger(root);
  if (!ledger) return { stale: 'no earlier run is recorded here' };
  const changed = changedInputs(ledger.inputs, inputs);
  if (changed.length) return { stale: changed.join('; ') };
  const now = Date.now();
  if (Object.values(ledger.tests).some(entry => now - Date.parse(entry.at) > KEEP_MS)) return { stale: `earlier results are older than ${KEEP_MS / 60_000} minutes` };
  const entries: LedgerEntry[] = [];
  for (const entry of Object.values(ledger.tests)) {
    const hashes = hashesOf(root, entry.file, entry.title.split(' › ').pop()!);
    if (isOwed(entry) || (hashes && (hashes.specHash !== entry.specHash || hashes.testHash !== entry.testHash))) entries.push(entry);
  }
  const complete = Boolean(ledger.full && ledger.full.specs === specSet(root) && ledger.full.keys.every(key => ledger.tests[key]));
  return { ids: entries.map(entry => entry.id), entries, complete };
}
