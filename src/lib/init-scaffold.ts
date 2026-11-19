import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { isAppSurfaceRootFile } from './publish-surface.js';

export const PROJECT_LINK_README = '`.somewhere.json` records which Somewhere project this folder deploys to and is safe to commit.';

export interface InitScaffoldFile {
  path: string;
  content: string;
}

export interface InitScaffoldResult {
  created: string[];
}

export function starterNameSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-|-$/g, '');
}

/** Only use names recorded by init. Arbitrary packages keep the folder fallback. */
export function readStarterProjectName(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as {
      somewhere?: { project_name?: unknown };
    } | null;
    const name = pkg?.somewhere?.project_name;
    return typeof name === 'string' ? name.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

const INIT_METADATA = new Set([
  '.DS_Store',
  '.git',
  '.mcp.json',
  '.somewhere.json',
]);

/**
 * Rule-9 boundary for `somewhere init`: a new/empty directory receives the
 * starter, while a directory containing application source keeps the original
 * link-only behavior. Metadata the init command owns and other hidden files
 * (a `.t_start` timestamp, `.env`, `.nvmrc`) are not source, so the starter is
 * written beside them; a hidden file the starter also writes (`.gitignore`) is
 * refused by the writer's overwrite check, never replaced. Hidden folders still
 * count as source.
 */
export function canWriteInitScaffold(dir: string): boolean {
  if (!existsSync(dir)) return true;
  return readdirSync(dir, { withFileTypes: true })
    .every((entry) => INIT_METADATA.has(entry.name) || (entry.name.startsWith('.') && entry.isFile()));
}

/**
 * The non-metadata entries of `dir`, split into app source and everything
 * else. Source is a non-dot folder or a root file the deploy publish surface
 * already counts as app (publish-surface.ts); a stray file, notes, LICENSE or
 * a tool folder such as .claude is not, so init does not treat it as an app
 * to link.
 */
export function initSourceEntries(dir: string): { source: string[]; other: string[] } {
  const source: string[] = [];
  const other: string[] = [];
  if (!existsSync(dir)) return { source, other };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (INIT_METADATA.has(entry.name)) continue;
    const isSource = entry.isDirectory() ? !entry.name.startsWith('.') : isAppSurfaceRootFile(entry.name);
    (isSource ? source : other).push(entry.name);
  }
  return { source: source.sort(), other: other.sort() };
}

/**
 * Write a complete template only after every path passes confinement and
 * overwrite checks. No partial scaffold is written on a preflight failure.
 */
export function writeInitScaffold(
  dir: string,
  files: readonly InitScaffoldFile[],
): InitScaffoldResult {
  const targets = preflightInitScaffold(dir, files);
  for (const [target, file] of targets) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, { encoding: 'utf8', flag: 'wx' });
  }

  return { created: [...targets.values()].map(({ path }) => path) };
}

/**
 * The confinement and overwrite checks alone, with nothing written, so a
 * caller can refuse a plan before any remote mutation.
 */
export function preflightInitScaffold(
  dir: string,
  files: readonly InitScaffoldFile[],
): Map<string, InitScaffoldFile> {
  const root = resolve(dir);
  const targets = new Map<string, InitScaffoldFile>();

  for (const file of files) {
    const normalizedPath = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalizedPath || normalizedPath.endsWith('/')) {
      throw new Error(`Invalid scaffold file path: ${file.path}`);
    }

    const target = resolve(root, normalizedPath);
    const rel = relative(root, target);
    if (rel.startsWith('..') || rel === '') {
      throw new Error(`Scaffold file escapes the project directory: ${file.path}`);
    }
    if (targets.has(target)) {
      throw new Error(`Duplicate scaffold file path: ${normalizedPath}`);
    }
    if (existsSync(target)) {
      const kind = lstatSync(target).isDirectory() ? 'directory' : 'file';
      throw new Error(`Refusing to overwrite existing ${kind}: ${normalizedPath}`);
    }
    targets.set(target, { path: normalizedPath, content: file.content });
  }
  return targets;
}

/**
 * `init --bare` keeps the agent workflow guide without the starter: each
 * top-level guide file is created only when absent (O_EXCL), so an existing
 * AGENTS.md or CLAUDE.md is never replaced.
 */
export function writeMissingGuideFiles(
  dir: string,
  files: readonly InitScaffoldFile[],
): { created: string[]; kept: string[] } {
  const created: string[] = [];
  const kept: string[] = [];
  for (const file of files) {
    if (file.path.includes('/') || file.path.includes('\\')) {
      throw new Error(`Guide files are top-level only: ${file.path}`);
    }
    try {
      writeFileSync(resolve(dir, file.path), file.content, { encoding: 'utf8', flag: 'wx' });
      created.push(file.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      kept.push(file.path);
    }
  }
  return { created, kept };
}
