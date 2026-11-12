import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What this folder's published files looked like at the version it came from
 * (its source_base release): one sha256 per local path, written after a pull
 * or a deploy. `somewhere pull` uses it to tell an unedited file (safe to bring
 * up to live) from a local edit (kept) from a real conflict (both changed).
 * Trusted only for the same project and release id the folder records.
 */
export interface BaseFiles {
  project_id: string;
  release_id: string | null;
  files: Record<string, string>;
}

const BASE_FILES = join('.somewhere', 'base-files.json');

export function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function hashFiles(dir: string, paths: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of paths) out[path] = sha256(readFileSync(join(dir, path)));
  return out;
}

export function saveBaseFiles(dir: string, base: BaseFiles): void {
  mkdirSync(join(dir, '.somewhere'), { recursive: true });
  writeFileSync(join(dir, BASE_FILES), JSON.stringify(base) + '\n');
}

export function clearBaseFiles(dir: string): void {
  rmSync(join(dir, BASE_FILES), { force: true });
}

/** The recorded base for exactly this project and release, else null. */
export function loadBaseFiles(dir: string, projectId: string, releaseId: string | null | undefined): BaseFiles | null {
  const path = join(dir, BASE_FILES);
  if (!existsSync(path) || releaseId === undefined) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as BaseFiles;
    if (parsed.project_id !== projectId || parsed.release_id !== releaseId || !parsed.files || typeof parsed.files !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The last rollback or restore this folder ran, so a later refused deploy can
 * say the live version is this folder's own doing.
 */
export interface LastActivation {
  project_id: string;
  kind: 'rollback' | 'restore';
  release_id: string;
  version: number | null;
  at: string;
}

const LAST_ACTIVATION = join('.somewhere', 'last-activation.json');

export function saveLastActivation(dir: string, activation: LastActivation): void {
  mkdirSync(join(dir, '.somewhere'), { recursive: true });
  writeFileSync(join(dir, LAST_ACTIVATION), JSON.stringify(activation) + '\n');
}

export function loadLastActivation(dir: string): LastActivation | null {
  const path = join(dir, LAST_ACTIVATION);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LastActivation;
  } catch {
    return null;
  }
}
