/**
 * The deploy's reference check, run locally: the files a deploy uploads, the
 * declarations the compiler generates for them, its compiler options and
 * TypeScript version, and its filtering and classification. All of that is
 * vendored from the platform (runtime/declared-data.cjs), not restated here.
 *
 * Where it can still differ from a deploy:
 * - Installed packages. The deploy installs from the project's lockfile (only
 *   declared @types without one); a local run reads whatever node_modules holds.
 * - Image type packages. The deploy's compiler also loads type packages from
 *   its own image (pfb_70d0a195e9d9); a local run does not, so a global those
 *   packages declare is visible on deploy only.
 * Measured on four real apps against the deploy's own check roots, findings
 * were identical; that is evidence for those apps, not a guarantee for all.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { collectFiles } from './files.js';

export interface DeployCheckFinding {
  /** 'reference': an undefined name; 'type': an advisory shape mistake. */
  kind: 'reference' | 'type';
  code: string;
  file: string;
  line: number;
  column: number;
  message: string;
}

export interface DeployCheckResult {
  /** true = the deploy's reference check would report nothing. */
  ok: boolean;
  findings: DeployCheckFinding[];
  /** The TypeScript version that ran (always the deploy's). */
  typescript: string;
  checkedFiles: number;
  /** Set when the check could not run; findings are then not a verdict. */
  error?: string;
}

interface CheckerContract {
  TYPESCRIPT_VERSION: string;
  isReferenceSource(path: string): boolean;
  localCheckCompilerOptions(projectCompilerOptions: unknown): Record<string, unknown>;
  isIgnoredDiagnostic(code: string): boolean;
  classifyDiagnostic(code: string): 'reference' | 'type' | null;
}
interface ReferenceCheckVendor {
  checkerContract: CheckerContract;
  referenceCheckDeclarations(graphFiles: Record<string, string>): Record<string, string>;
  isRuntimeEndpointGlobal(
    diag: { file?: string; line?: number; column?: number; message: string },
    functions: Record<string, string> | undefined,
  ): boolean;
}

const require = createRequire(import.meta.url);
const vendor = require('../../runtime/declared-data.cjs') as ReferenceCheckVendor;
const contract = vendor.checkerContract;

/** The deploy's TypeScript version. */
export const DEPLOY_CHECK_TYPESCRIPT_VERSION = contract.TYPESCRIPT_VERSION;

interface TscInvocation { command: string; args: string[] }

/** The project's own TypeScript when it is exactly the deploy's version,
 *  otherwise that version through npx. Never a different version. */
export function deployCheckTsc(projectDir: string, platform: NodeJS.Platform = process.platform): TscInvocation {
  try {
    const manifest = join(projectDir, 'node_modules', 'typescript', 'package.json');
    if ((JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version === DEPLOY_CHECK_TYPESCRIPT_VERSION) {
      return { command: process.execPath, args: [join(projectDir, 'node_modules', 'typescript', 'bin', 'tsc')] };
    }
  } catch { /* not installed, or another version */ }
  return {
    command: platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['-y', '-p', `typescript@${DEPLOY_CHECK_TYPESCRIPT_VERSION}`, 'tsc'],
  };
}

/**
 * tsconfig.json text → its compilerOptions, read as the deploy reads it:
 * comments and trailing commas allowed, `extends` not followed, anything
 * unreadable treated as no options.
 */
export function projectCompilerOptions(tsconfigText: string | undefined): unknown {
  if (tsconfigText === undefined) return {};
  let out = '';
  for (let i = 0; i < tsconfigText.length; i++) {
    const ch = tsconfigText[i];
    if (ch === '"') {
      const start = i;
      for (i++; i < tsconfigText.length && tsconfigText[i] !== '"'; i++) if (tsconfigText[i] === '\\') i++;
      out += tsconfigText.slice(start, i + 1);
    } else if (ch === '/' && tsconfigText[i + 1] === '/') {
      while (i < tsconfigText.length && tsconfigText[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && tsconfigText[i + 1] === '*') {
      const end = tsconfigText.indexOf('*/', i + 2);
      i = end < 0 ? tsconfigText.length : end + 1;
    } else out += ch;
  }
  try {
    const parsed = JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as { compilerOptions?: unknown };
    return parsed && typeof parsed === 'object' ? parsed.compilerOptions ?? {} : {};
  } catch {
    return {};
  }
}

const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;

/** tsc --pretty false output → the findings the deploy reports. */
export function deployFindings(
  output: string,
  projectDir: string,
  functions: Record<string, string>,
): DeployCheckFinding[] {
  const root = realpathSync(projectDir);
  const findings: DeployCheckFinding[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = DIAGNOSTIC.exec(line.trim());
    if (!match) continue;
    const [, rawFile, lineText, columnText, code, message] = match;
    if (contract.isIgnoredDiagnostic(code)) continue;
    const kind = contract.classifyDiagnostic(code);
    if (!kind) continue;
    const absolute = isAbsolute(rawFile) ? rawFile : resolve(root, rawFile);
    const file = relative(root, existsSync(absolute) ? realpathSync(absolute) : absolute).split('\\').join('/');
    const finding = { kind, code, file, line: Number(lineText), column: Number(columnText), message };
    if (vendor.isRuntimeEndpointGlobal(finding, functions)) continue;
    findings.push(finding);
  }
  return findings;
}

/** Temporary files of checks still running, removed if the process exits first. */
const pendingCleanups = new Set<() => void>();
process.once('exit', () => { for (const cleanup of pendingCleanups) cleanup(); });

/** Run the deploy's reference check over `projectDir`. Writes only a
 *  uniquely named dot-prefixed config and directory in the project root
 *  (outside the deploy's file set), removed when the check ends. */
export function runDeployCheck(projectDir: string): Promise<DeployCheckResult> {
  const typescript = DEPLOY_CHECK_TYPESCRIPT_VERSION;
  const collected = collectFiles(projectDir);
  const graph: Record<string, string> = {};
  for (const [path, text] of Object.entries({ ...collected.files, ...collected.functions })) {
    if (contract.isReferenceSource(path)) graph[path] = text;
  }
  const checked = Object.keys(graph);
  if (checked.length === 0) return Promise.resolve({ ok: true, findings: [], typescript, checkedFiles: 0 });

  const tsconfigPath = join(projectDir, 'tsconfig.json');
  const own = projectCompilerOptions(existsSync(tsconfigPath) ? readFileSync(tsconfigPath, 'utf8') : undefined);
  // The config sits in the project root so `paths`/`baseUrl` resolve from
  // where the deploy's do, and the generated declarations sit under it so any
  // resolution from them walks the same node_modules ancestry as the deploy's
  // check root. Dot-prefixed: never uploaded, never watched.
  const id = randomUUID();
  const config = join(projectDir, `.__somewhere_deploy_check_${id}.json`);
  const declarationsDir = join(projectDir, `.__somewhere_deploy_check_${id}`);
  const cleanup = () => {
    rmSync(config, { force: true });
    rmSync(declarationsDir, { recursive: true, force: true });
    pendingCleanups.delete(cleanup);
  };
  pendingCleanups.add(cleanup);
  mkdirSync(declarationsDir);
  const declarations = Object.entries(vendor.referenceCheckDeclarations(graph)).map(([name, text]) => {
    writeFileSync(join(declarationsDir, name), text);
    return relative(projectDir, join(declarationsDir, name));
  });
  writeFileSync(config, JSON.stringify({
    compilerOptions: contract.localCheckCompilerOptions(own),
    files: [...checked, ...declarations],
  }));

  const { command, args } = deployCheckTsc(projectDir);
  return new Promise((resolveResult) => {
    let out = '';
    let child;
    try {
      child = spawn(command, [...args, '--project', config, '--pretty', 'false'], {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: /\.(cmd|bat)$/i.test(command),
      });
    } catch (error) {
      cleanup();
      resolveResult({ ok: false, findings: [], typescript, checkedFiles: checked.length, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', (error: Error) => {
      cleanup();
      resolveResult({ ok: false, findings: [], typescript, checkedFiles: checked.length, error: error.message });
    });
    child.on('close', (code: number | null) => {
      cleanup();
      const findings = deployFindings(out, projectDir, collected.functions);
      // tsc exits non-zero on any diagnostic. Non-zero with no parseable
      // diagnostic at all is a failure to run, never a clean verdict.
      if (code !== 0 && !out.split(/\r?\n/).some((line) => DIAGNOSTIC.test(line.trim()))) {
        resolveResult({ ok: false, findings, typescript, checkedFiles: checked.length, error: out.trim() || `tsc exited ${code}` });
        return;
      }
      resolveResult({ ok: findings.length === 0, findings, typescript, checkedFiles: checked.length });
    });
  });
}

