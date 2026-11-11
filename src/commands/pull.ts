import { Command } from 'commander';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import ora from '../lib/spinner.js';
import { ApiClient, CliApiError, LONG_CALL_TIMEOUT_MS } from '../lib/client.js';
import {
  getToken,
  loadProjectConfigEntry,
  saveProjectConfig,
  saveProjectDeployState,
  saveSourceBase,
  type ProjectConfigEntry,
} from '../lib/config.js';
import { IGNORE, collectFiles, isFunctionPath } from '../lib/files.js';
import { loadBaseFiles, saveBaseFiles, sha256, type BaseFiles } from '../lib/base-files.js';
import { dim, error, info, printJson, success, teal, warn } from '../lib/output.js';
import {
  SCAFFOLD_PACKAGE_FILENAME,
  SCAFFOLD_TSCONFIG_FILENAME,
  SCAFFOLD_GITIGNORE_FILENAME,
  buildScaffoldGitignore,
  buildScaffoldPackageJson,
  buildScaffoldTsconfig,
  extractDeps,
} from '../lib/scaffold.js';
import { unlinkedFolderHint } from '../lib/link-hint.js';

interface SourceResponse {
  project_id: string;
  env: 'dev' | 'prod';
  version: number;
  active_release_id?: string;
  source_release_id?: string;
  base_release_id?: string | null;
  static_files: Record<string, string>;
  binary_files: Record<string, string>;
  functions: Record<string, string>;
  counts: { static_files: number; binary_files: number; functions: number };
}

export function registerPull(program: Command) {
  program
    .command('pull [project]')
    .description(
      'Download a project\'s deployed source files to the current directory. ' +
        'Scaffolds a tsconfig.json + package.json (only if absent) so `somewhere typecheck` ' +
        'can catch undefined symbols locally before you deploy. ' +
        'In a linked folder, plain pull is the safe update when live is newer: files you have not edited move to the live version, ' +
        'your local edits and local-only files (AGENTS.md, notes, tests) are kept, and it stops without writing anything if a file changed both here and live.',
    )
    .option('--env <env>', 'Environment to pull from (dev or prod)', 'prod')
    .option('--out <dir>', 'Output directory', '.')
    .option('--force', 'Also replace files you edited here with live, and delete published files you edited that live no longer has. Never deletes a file a deploy would not upload (AGENTS.md, CLAUDE.md, README.md, tests, dotfiles, .somewhereignore matches)')
    .option('--json', 'Print the raw source response as JSON')
    .action(async (projectArg: string | undefined, opts) => {
      const token = getToken();
      const client = new ApiClient(token);
      const linkedProjectEntry = loadProjectConfigEntry();

      const envSlot = String(opts.env).toLowerCase();
      if (envSlot !== 'dev' && envSlot !== 'prod') {
        error('--env must be "dev" or "prod"');
        process.exit(1);
      }

      let projectId = projectArg;
      if (!projectId) {
        if (!linkedProjectEntry) {
          error('No project specified and no .somewhere.json found. Pass a project ID.' + unlinkedFolderHint());
          process.exit(1);
        }
        projectId = linkedProjectEntry.config.project_id;
      }

      const outDir = resolve(process.cwd(), String(opts.out));
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

      const spinner = opts.json ? null : ora(`Fetching ${envSlot} source...`).start();
      let body: SourceResponse;
      try {
        body = await client.call<SourceResponse>(
          'GET',
          '/deploy/source',
          undefined,
          { project_id: projectId, env: envSlot },
          { timeoutMs: LONG_CALL_TIMEOUT_MS },
        );
      } catch (err) {
        spinner?.fail('Pull failed');
        if (err instanceof CliApiError) {
          error(
            `${err.message} ${dim(err.statusCode ? `[${err.code}, HTTP ${err.statusCode}]` : `[${err.code}]`)}`,
            err,
          );
        } else {
          error(err instanceof Error ? err.message : String(err), err);
        }
        process.exit(1);
      }
      spinner?.stop();

      const deployStateEntry: ProjectConfigEntry | null = loadProjectConfigEntry(outDir);
      const configStat = lstatSync(join(outDir, '.somewhere.json'), { throwIfNoEntry: false });
      if (configStat && (configStat.isSymbolicLink() || !configStat.isFile() || !deployStateEntry)) {
        error('Cannot read the destination .somewhere.json. Pull into a fresh folder or repair the link first.');
        process.exit(1);
      }
      if (deployStateEntry && deployStateEntry.config.project_id !== body.project_id) {
        error('The output folder is linked to a different project. Pull into a fresh folder.');
        process.exit(1);
      }

      // The published files as this folder last had them (its recorded base).
      const base = deployStateEntry
        ? loadBaseFiles(outDir, body.project_id, deployStateEntry.config.source_base?.release_id ?? undefined)
        : null;
      const overwrite = new Set<string>();
      const keptEdits: string[] = [];
      const conflicts: string[] = [];
      // Preflight the entire export before touching local source or its base.
      const source = new Map<string, Buffer>();
      const addSource = (path: string, content: Buffer | string) => {
        const normalized = normalizeRelPath(path);
        if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '.' || part === '..') || normalized.includes(':') || normalized.split('/').some(part => part.startsWith('.') && part !== '.well-known')) {
          throw new Error(`Unsafe exported source path: ${path}`);
        }
        if (source.has(normalized)) throw new Error(`Conflicting exported source path: ${normalized}`);
        source.set(normalized, Buffer.isBuffer(content) ? content : Buffer.from(content));
      };
      try {
        for (const [path, content] of Object.entries(body.static_files)) addSource(path, content);
        for (const [path, content] of Object.entries(body.binary_files)) addSource(path, Buffer.from(content, 'base64'));
        for (const [path, content] of Object.entries(body.functions)) addSource(functionSourcePath(path), content);
        for (const [path, contents] of source) {
          const parts = path.split('/');
          for (let i = 1; i <= parts.length; i++) {
            if (i < parts.length && source.has(parts.slice(0, i).join('/'))) {
              throw new Error(`Conflicting exported source path: ${path}`);
            }
            const target = join(outDir, ...parts.slice(0, i));
            const stat = lstatSync(target, { throwIfNoEntry: false });
            if (!stat) continue;
            if (stat.isSymbolicLink() || (i < parts.length ? !stat.isDirectory() : !stat.isFile())) {
              throw new Error(`Pull would conflict with local path ${path}. Pull into a fresh folder.`);
            }
          }
          const target = join(outDir, path);
          if (!existsSync(target)) continue;
          const local = readFileSync(target);
          if (local.equals(contents)) continue;
          if (opts.force) { overwrite.add(path); continue; }
          const was = base?.files[path];
          if (was !== undefined && was === sha256(local)) overwrite.add(path); // unedited here: bring it to live
          else if (was !== undefined && was === sha256(contents)) keptEdits.push(path); // edited here only: keep it
          else conflicts.push(path);
        }
        if (conflicts.length > 0) {
          const list = conflicts.slice(0, 10).join(', ') + (conflicts.length > 10 ? `, and ${conflicts.length - 10} more` : '');
          throw new Error(base
            ? `Pull stopped: changed both in this folder and on live: ${list}. Nothing was written. Move your edits aside and pull again, or run \`somewhere pull --force\` to replace them with live.`
            : `Pull stopped: these local files differ from live and this folder has no record of the version it came from, so local edits cannot be told apart: ${list}. Nothing was written. Pull into a fresh folder, or run \`somewhere pull --force\` to replace them with live.`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      const written: string[] = [];

      const writeOne = (relPath: string, contents: Buffer | string) => {
        const target = join(outDir, relPath);
        if (existsSync(target) && !overwrite.has(relPath)) {
          return;
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents);
        written.push(relPath);
      };

      for (const [path, contents] of source) writeOne(path, contents);

      const removed = reconcileRemovedFiles(outDir, new Set(source.keys()), Boolean(opts.force), base);
      if (!deployStateEntry && removed.skipped.length === 0) {
        saveProjectConfig(outDir, { project_id: body.project_id, name: body.project_id, subdomain: '' });
      }
      const linkedOutput = loadProjectConfigEntry(outDir);
      if (
        removed.skipped.length === 0 &&
        linkedOutput?.config.project_id === body.project_id &&
        body.source_release_id &&
        (typeof body.base_release_id === 'string' || body.base_release_id === null)
      ) {
        saveSourceBase(linkedOutput.dir, body.project_id, body.base_release_id);
      } else if (
        removed.skipped.length === 0 &&
        linkedOutput?.config.project_id === body.project_id &&
        !body.source_release_id &&
        Number.isInteger(body.version) &&
        body.version >= 1
      ) {
        saveProjectDeployState(linkedOutput.dir, body.project_id, body.version, body.active_release_id);
      } else if (
        removed.skipped.length === 0 &&
        linkedOutput?.config.project_id === body.project_id &&
        !body.source_release_id &&
        !body.active_release_id &&
        body.counts.static_files + body.counts.binary_files + body.counts.functions === 0
      ) {
        // An empty project with no published version: this folder starts from genesis.
        saveSourceBase(linkedOutput.dir, body.project_id, null);
      }

      // Record live's files as this folder's new base, for the next pull.
      const savedBase = loadProjectConfigEntry(outDir);
      if (savedBase?.config.project_id === body.project_id && savedBase.config.source_base && removed.skipped.length === 0) {
        saveBaseFiles(outDir, {
          project_id: body.project_id,
          release_id: savedBase.config.source_base.release_id,
          files: Object.fromEntries([...source].map(([path, contents]) => [path, sha256(contents)])),
        });
      }

      const total = body.counts.static_files + body.counts.binary_files + body.counts.functions;
      if (keptEdits.length > 0 && !opts.json) {
        info(dim(`Kept your local edits (unchanged on live): ${keptEdits.slice(0, 10).join(', ')}${keptEdits.length > 10 ? `, and ${keptEdits.length - 10} more` : ''}.`));
      }
      if (total === 0 && !opts.json) {
        warn(`No files in ${envSlot} for this project.`);
      }
      if (!opts.json) {
        success(`Pulled ${written.length} file${written.length === 1 ? '' : 's'} from ${teal(envSlot)} (v${body.version}) to ${teal(outDir)}`);
      }
      if (removed.removed.length > 0 && !opts.json) {
        info(dim(`Removed ${removed.removed.length} file${removed.removed.length === 1 ? '' : 's'} deleted remotely.`));
      }
      if (removed.skipped.length > 0 && !opts.json) {
        warn(`Skipped removing ${removed.skipped.length} file${removed.skipped.length === 1 ? '' : 's'} deleted remotely (use --force to remove):`);
        for (const p of removed.skipped.slice(0, 10)) info(dim(`  ${p}`));
        if (removed.skipped.length > 10) info(dim(`  ...and ${removed.skipped.length - 10} more`));
      }

      // Scaffold the files a local typecheck needs (tsconfig + package.json)
      // so `somewhere typecheck` / `tsc --noEmit` can catch a dropped import
      // BEFORE deploy, plus a .gitignore for the declarations typecheck
      // generates. Written only when absent — never clobbers a project's
      // own config, even with --force (that flag is for source files, not
      // local tooling we're adding on top).
      const scaffolded = scaffoldTypecheckFiles(outDir, body.static_files);
      if (opts.json) {
        printJson(body);
        return;
      }
      if (scaffolded.length) {
        info(dim(`Added ${scaffolded.join(' + ')} for local typechecking.`));
        info(`Run ${teal('somewhere typecheck')} before deploy to catch undefined symbols.`);
      }
    });
}

/**
 * Write tsconfig.json + package.json into a pulled tree if they're not already
 * there. Returns the filenames actually written. Deps for the scaffolded
 * package.json come from the project's own package.json when it shipped one.
 */
function scaffoldTypecheckFiles(
  outDir: string,
  staticFiles: Record<string, string>,
): string[] {
  const added: string[] = [];

  const tsconfigPath = join(outDir, SCAFFOLD_TSCONFIG_FILENAME);
  if (!existsSync(tsconfigPath)) {
    writeFileSync(tsconfigPath, buildScaffoldTsconfig());
    added.push(SCAFFOLD_TSCONFIG_FILENAME);
  }

  const packagePath = join(outDir, SCAFFOLD_PACKAGE_FILENAME);
  if (!existsSync(packagePath)) {
    const deps = extractDeps(staticFiles['package.json']);
    writeFileSync(
      packagePath,
      buildScaffoldPackageJson(basename(outDir), deps),
    );
    added.push(SCAFFOLD_PACKAGE_FILENAME);
  }

  // The collector excludes .gitignore; keep an existing local one as is.
  const gitignorePath = join(outDir, SCAFFOLD_GITIGNORE_FILENAME);
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, buildScaffoldGitignore());
    added.push(SCAFFOLD_GITIGNORE_FILENAME);
  }

  return added;
}

// Current exports already carry their canonical api/ and _lib/ paths. Only
// legacy bare function keys need the collector's functions/ compatibility root.
function functionSourcePath(path: string): string {
  const normalized = normalizeRelPath(path);
  return isFunctionPath(normalized) ? normalized : `functions/${normalized}`;
}

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function reconcileRemovedFiles(
  outDir: string,
  expected: Set<string>,
  force: boolean,
  base: BaseFiles | null = null,
): { removed: string[]; skipped: string[] } {
  const removed: string[] = [];
  const skipped: string[] = [];
  // Only a file the publish rules would upload can have been deleted
  // remotely. Local-only files (agent instructions, notes, tests) are never
  // touched, with or without --force.
  const publishable = new Set(collectFiles(outDir, { readBinary: false }).published);

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.well-known')) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relPath = normalizeRelPath(relative(outDir, fullPath));
      if (expected.has(relPath) || !publishable.has(relPath)) continue;
      const was = base?.files[relPath];
      // Not in this folder's base: a file added here, never published. Kept.
      if (base && was === undefined) continue;
      // Unedited here and deleted on live: remove it like any other live change.
      const unedited = was !== undefined && was === sha256(readFileSync(fullPath));
      if (!force && !unedited) {
        skipped.push(relPath);
        continue;
      }
      try {
        rmSync(fullPath);
        removed.push(relPath);
      } catch {
        skipped.push(relPath);
      }
    }
  };

  walk(outDir);
  return { removed, skipped };
}
