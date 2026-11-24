import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliInvocation } from './cli-invocation.js';

const FOLDER = '.somewhere';
const DOCS = 'docs';
const STAMP = '.stamp.json';

export function localDocsVersion(root = process.cwd()): string | undefined {
  const path = join(root, FOLDER, DOCS, STAMP);
  if (!existsSync(path)) return undefined;
  const stamp = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
  return typeof stamp.version === 'string' ? stamp.version : undefined;
}

function ensureGitIgnore(root: string): void {
  const path = join(root, '.gitignore');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (text.split(/\r?\n/).some((line) => line === '.somewhere/' || line === '/.somewhere/')) return;
  appendFileSync(path, `${text && !text.endsWith('\n') ? '\n' : ''}/.somewhere/\n`);
}

export function saveLocalDocs(version: string, files: ReadonlyMap<string, string>, root = process.cwd()): string {
  const state = join(root, FOLDER);
  const target = join(state, DOCS);
  if (existsSync(state) && !lstatSync(state).isDirectory()) throw new Error(`${state} must be a directory.`);
  if (existsSync(target) && (!lstatSync(target).isDirectory() || !localDocsVersion(root))) {
    throw new Error(`Move the existing folder at ${target} before pulling docs.`);
  }
  ensureGitIgnore(root);
  mkdirSync(state, { recursive: true });
  const staging = mkdtempSync(join(state, 'docs-pull-'));
  const next = join(staging, 'next');
  const previous = join(staging, 'previous');
  let installed = false;
  try {
    mkdirSync(next);
    for (const [name, content] of files) writeFileSync(join(next, name), content, { flag: 'wx' });
    const pulledAt = new Date().toISOString();
    writeFileSync(join(next, STAMP), JSON.stringify({ version, pulledAt }) + '\n');
    writeFileSync(join(next, 'README.md'), `# Somewhere docs\n\nPulled platform docs version ${version} on ${pulledAt}. Run \`${cliInvocation()} docs\` to check whether this copy is older than the current docs and \`${cliInvocation()} docs pull\` to refresh it.\n`, { flag: 'wx' });
    if (existsSync(target)) renameSync(target, previous);
    renameSync(next, target);
    installed = true;
    return target;
  } finally {
    if (!installed && existsSync(previous) && !existsSync(target)) renameSync(previous, target);
    // Keep the previous copy if an interrupted swap left a different copy at the target.
    if (installed || !existsSync(previous)) rmSync(staging, { recursive: true, force: true });
  }
}
