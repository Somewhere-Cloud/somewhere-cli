import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

/**
 * A project records the CLI version it was built with, the way an npm project
 * records any dependency (tsk_a4641877). Getting a newer CLI is then a
 * deliberate `somewhere upgrade`, not whatever `npx …@latest` fetched today.
 *
 * Where the pin lives, read in this order (the first one found is the pin):
 *   package.json   devDependencies (or dependencies) "@somewhere-cloud/cli"
 *                  — what `somewhere init` writes into a new starter
 *   .somewhere.json "cli_version" — for a linked folder whose package.json
 *                  does not declare the CLI (or that has none): written by
 *                  init --bare/link and by the first deploy, never into a
 *                  package.json the CLI did not write (a devDependency added
 *                  behind a lockfile would break the owner's `npm ci`).
 */

export const CLI_PACKAGE_NAME = '@somewhere-cloud/cli';
export const PIN_FILE_KEY = 'cli_version';

export type PinSource = 'package.json' | '.somewhere.json';

export interface ProjectPin {
  /** Exactly as written: an exact version, or a range someone chose. */
  spec: string;
  source: PinSource;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function packageJsonSpec(pkg: Record<string, unknown> | null): string | null {
  for (const section of ['devDependencies', 'dependencies']) {
    const deps = pkg?.[section];
    if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
      const spec = (deps as Record<string, unknown>)[CLI_PACKAGE_NAME];
      if (typeof spec === 'string' && spec.trim()) return spec.trim();
    }
  }
  return null;
}

/** Every place this folder records a CLI version, in precedence order. */
export function readProjectPins(dir: string): ProjectPin[] {
  const pins: ProjectPin[] = [];
  const fromPackage = packageJsonSpec(readJson(join(dir, 'package.json')));
  if (fromPackage) pins.push({ spec: fromPackage, source: 'package.json' });
  const recorded = readJson(join(dir, '.somewhere.json'))?.[PIN_FILE_KEY];
  if (typeof recorded === 'string' && recorded.trim()) pins.push({ spec: recorded.trim(), source: '.somewhere.json' });
  return pins;
}

/** The pin that governs this folder, or null when it records none (or one that
 *  is not a version or range, such as a tag or a file: path). */
export function readProjectPin(dir: string): ProjectPin | null {
  const pin = readProjectPins(dir)[0];
  return pin && semver.validRange(pin.spec) ? pin : null;
}

export function pinSatisfied(pin: ProjectPin, version: string): boolean {
  return semver.valid(version) !== null && semver.satisfies(version, pin.spec, { includePrerelease: true });
}

/** The CLI installed in this folder's node_modules, when it satisfies the pin
 *  and is not the one already running: the command is handed to it. */
export function installedPinnedCli(dir: string, pin: ProjectPin, running: string): { version: string; bin: string } | null {
  const root = join(dir, 'node_modules', ...CLI_PACKAGE_NAME.split('/'));
  const pkg = readJson(join(root, 'package.json'));
  const version = typeof pkg?.version === 'string' ? pkg.version : null;
  if (!version || version === running || !pinSatisfied(pin, version)) return null;
  const binField = pkg?.bin;
  const rel = typeof binField === 'string'
    ? binField
    : binField && typeof binField === 'object' ? (binField as Record<string, unknown>).somewhere : null;
  if (typeof rel !== 'string') return null;
  const bin = join(root, rel);
  return existsSync(bin) ? { version, bin } : null;
}

/** The one line a folder pinned to another CLI version prints, on stderr. */
export function pinNotice(pin: ProjectPin, running: string, delegatedTo: string | null): string {
  const head = `This project is pinned to somewhere CLI ${pin.spec} (${pin.source})`;
  const newer = semver.valid(running) !== null && semver.gtr(running, pin.spec, { includePrerelease: true });
  const move = `Run \`somewhere upgrade\` to move the project to ${running}.`;
  if (delegatedTo) {
    return `${head}; running its installed ${delegatedTo} instead of ${running}.${newer ? ` ${move}` : ''}`;
  }
  if (newer) return `${head}; you are running ${running}. ${move}`;
  const exact = semver.valid(pin.spec) ? pin.spec : semver.minVersion(pin.spec)?.version ?? pin.spec;
  return `${head}; you are running ${running}, which is older. `
    + (pin.source === 'package.json' ? 'Run `npm install` here, or use ' : 'Use ')
    + `\`npx -y ${CLI_PACKAGE_NAME}@${exact} <command>\`.`;
}

/** Commands that never follow a pin: they create, inspect or move it. */
const PIN_EXEMPT = new Set(['upgrade', 'update', 'init', '--version', '-V']);

/** Set on a command handed to the project's installed CLI, so it runs as is. */
export const PINNED_CHILD_ENV = 'SOMEWHERE_PINNED_CLI';

export interface PinDecision {
  notice: string | null;
  /** The installed pinned CLI's entrypoint to hand this command to. */
  delegate: string | null;
}

export function decidePin(dir: string, running: string, argv: string[], env: NodeJS.ProcessEnv): PinDecision {
  const none = { notice: null, delegate: null };
  if (env[PINNED_CHILD_ENV] === '1' || PIN_EXEMPT.has(argv[2] ?? '')) return none;
  const pin = readProjectPin(dir);
  if (!pin || pinSatisfied(pin, running)) return none;
  const installed = installedPinnedCli(dir, pin, running);
  return { notice: pinNotice(pin, running, installed?.version ?? null), delegate: installed?.bin ?? null };
}

/** Write `version` into every place this folder records a pin. */
export function writeProjectPins(dir: string, pins: ProjectPin[], version: string): PinSource[] {
  const written: PinSource[] = [];
  for (const pin of pins) {
    const path = join(dir, pin.source);
    const raw = readFileSync(path, 'utf8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    if (pin.source === 'package.json') {
      for (const section of ['devDependencies', 'dependencies']) {
        const deps = json[section] as Record<string, unknown> | undefined;
        if (deps && typeof deps === 'object' && typeof deps[CLI_PACKAGE_NAME] === 'string') deps[CLI_PACKAGE_NAME] = version;
      }
    } else {
      json[PIN_FILE_KEY] = version;
    }
    const indent = /^\{\s*\n(\s+)/.exec(raw)?.[1] ?? '  ';
    writeFileSync(path, JSON.stringify(json, null, indent) + '\n');
    written.push(pin.source);
  }
  return written;
}

/** Record this CLI in a linked folder that records no version yet: the first
 *  deploy pins the project. Only .somewhere.json is written. */
export function recordPinIfMissing(dir: string, version: string): boolean {
  if (!semver.valid(version) || readProjectPins(dir).length) return false;
  const path = join(dir, '.somewhere.json');
  const config = readJson(path);
  if (!config) return false;
  config[PIN_FILE_KEY] = version;
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  return true;
}

export interface ChangelogEntry {
  version: string;
  body: string;
}

/** This CLI's own CHANGELOG.md, shipped in the package. */
export function readBundledChangelog(): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'CHANGELOG.md'), 'utf8');
}

/** The `## x.y.z` sections above `from` up to and including `to`, newest first. */
export function changelogBetween(markdown: string, from: string, to: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const parts = markdown.split(/^## /m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf('\n');
    const version = (newline === -1 ? part : part.slice(0, newline)).trim();
    if (!semver.valid(version)) continue;
    if (semver.gt(version, from) && semver.lte(version, to)) {
      entries.push({ version, body: (newline === -1 ? '' : part.slice(newline + 1)).trim() });
    }
  }
  return entries;
}
