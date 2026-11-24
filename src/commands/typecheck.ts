import { cliInvocation } from '../lib/cli-invocation.js';
import { roleMethodHints } from '../lib/role-method-hints.js';
import { Command, Option } from 'commander';
import chokidar from 'chokidar';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ora from '../lib/spinner.js';
import { DEPLOY_CHECK_TYPESCRIPT_VERSION, announceDeployCheckFetch, deployCheckTsc, runDeployCheck, type DeployCheckResult } from '../lib/deploy-check.js';
import { IGNORE } from '../lib/files.js';
import { AGENT_HOSTS, isAgentHost, runAgentHook } from '../lib/agent-hooks.js';
import { bold, dim, error, info, printJson, red, success, teal, warn } from '../lib/output.js';
import { announceNpxTypeScriptFetch, missingProjectDependencies, missingTypecheckDependenciesMessage, runTypecheck, typecheckCompilerSource, type TypecheckResult } from '../lib/typecheck.js';
import { lintProject } from '../lib/source-lint.js';
import { printLintFindings } from './lint.js';
import { TYPECHECK_TYPESCRIPT_VERSION } from '../lib/typecheck-version.js';

export const MISSING_TSCONFIG_GUIDANCE =
  `No tsconfig.json here to typecheck against. Add a local tsconfig.json for a new app, or run \`${cliInvocation()} pull\` for an existing deployed app.`;

export function registerTypecheck(program: Command) {
  program
    .command('typecheck [dir]')
    .description(
      `Check the deployable source with the platform's TypeScript ${DEPLOY_CHECK_TYPESCRIPT_VERSION}, generated types and checker settings. ` +
        'Reports file and line for deploy-check type findings and exits 1 when there are findings. ' +
        'Install the project dependencies first. The CLI fetches the pinned TypeScript with npx if needed. ' +
        'Use --project to check the full project with its own tsconfig.json and compiler.',
    )
    .option('--json', 'Print typecheck and platform source findings as JSON')
    .option('--deploy', 'Run the deploy reference check and return its findings')
    .addOption(new Option('--project', 'Run the full project TypeScript check using tsconfig.json').conflicts('deploy'))
    .option('--hook <host>', `With --deploy: run as an agent after-edit hook (${AGENT_HOSTS.join(', ')}), reading the host's event on stdin. Installed by \`${cliInvocation()} hooks install\``)
    .option('--watch', 'Keep running and re-check after each save while this command is open. It is not installed into your editor or agent; start it yourself. Never deploys or touches live data')
    .action(async (dirArg: string | undefined, opts) => {
      const dir = resolve(process.cwd(), dirArg ?? '.');
      for (const hint of roleMethodHints(dir)) console.error(hint);

      if (opts.hook !== undefined) {
        if (!opts.deploy || !isAgentHost(opts.hook)) {
          error(`--hook needs --deploy and one of: ${AGENT_HOSTS.join(', ')}.`);
          process.exit(1);
        }
        const stdin = await new Promise<string>((done) => {
          let text = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (chunk) => (text += chunk));
          process.stdin.on('end', () => done(text));
          process.stdin.on('error', () => done(text));
        });
        const outcome = await runAgentHook(opts.hook, stdin, { check: runDeployCheck });
        if (outcome.stdout) process.stdout.write(outcome.stdout);
        if (outcome.stderr) process.stderr.write(outcome.stderr);
        process.exit(outcome.exitCode);
      }

      let deployFetchAnnounced = false;
      const announceDeployFetch = () => {
        if (deployFetchAnnounced) return;
        deployFetchAnnounced = true;
        announceDeployCheckFetch(dir);
      };

      if (opts.deploy) {
        const check = async () => {
          const result = await runDeployCheck(dir, announceDeployFetch);
          if (opts.json) printJson(result);
          else reportDeployCheck(result);
          return result;
        };
        if (opts.watch) return watchAndRun(dir, check);
        const result = await check();
        process.exit(result.ok ? 0 : 1);
      }

      if (opts.project && !existsSync(join(dir, 'tsconfig.json'))) {
        if (opts.json) {
          printJson({
            ok: false,
            errors: [],
            via: typecheckCompilerSource(dir),
            raw: '',
            spawnError: MISSING_TSCONFIG_GUIDANCE,
          });
          process.exit(1);
        }
        error(MISSING_TSCONFIG_GUIDANCE);
        process.exit(1);
      }

      // Read-only: a project whose dependencies are missing is
      // not checked (tsc would report the missing tree as code errors), and the
      // command never installs them itself.
      const deployVia = deployCheckTsc(dir).command === process.execPath ? 'project' : 'npx';
      const via = opts.project ? typecheckCompilerSource(dir) : deployVia;
      const notInstalled = (): TypecheckResult | null => {
        const missing = missingProjectDependencies(dir);
        return missing.length
          ? { ok: false, errors: [], via, raw: '', spawnError: missingTypecheckDependenciesMessage() }
          : null;
      };
      // Fetching TypeScript with npx is a network step: say so (on stderr)
      // right before a check that will fetch it.
      let announced = false;
      const announceFetch = () => {
        if (announced || via !== 'npx') return;
        announced = true;
        announceNpxTypeScriptFetch(TYPECHECK_TYPESCRIPT_VERSION);
      };

      const check = async () => {
        const refused = notInstalled();
        if (!refused && opts.project) announceFetch();
        const spinner = opts.json || refused || opts.watch ? null : ora('Typechecking (tsc --noEmit)...').start();
        const deployResult = refused || opts.project ? undefined : await runDeployCheck(dir, announceDeployFetch);
        const result = deployResult ? {
          ok: deployResult.ok,
          errors: deployResult.findings,
          via,
          raw: deployResult.error ?? '',
          spawnError: deployResult.error,
          typescript: deployResult.typescript,
        } : refused ?? await runTypecheck(dir);
        spinner?.stop();
        const sourceLint = await lintProject(dir).catch((failure: unknown) => ({
          ok: false as const,
          error: failure instanceof Error ? failure.message : String(failure),
        }));
        if (opts.json) printJson({ ...result, sourceLint });
        else {
          if (deployResult) reportDeployCheck(deployResult, 'Typecheck');
          else reportTypecheck(result);
          if ('error' in sourceLint) warn(`Source lint failed: ${sourceLint.error}`);
          else printLintFindings(sourceLint);
        }
        return result;
      };
      if (opts.watch) return watchAndRun(dir, check);
      const result = await check();
      process.exit(result.ok ? 0 : 1);
    });
}

/** Print the local TypeScript check verdict. */
export function reportTypecheck(result: TypecheckResult): void {
  // An unknown platform contract is said once, never presented as a match.
  if (result.contract?.status === 'unknown') {
    const version = result.contract.cli?.version;
    info(dim(`Using bundled platform rules${version === undefined ? '' : ` (contract ${version})`}. Deploy checks against the platform.`));
  }
  if (result.spawnError) {
    // A refusal (missing type packages) or a stopped run says what happened in
    // its own words; the install hint is only for a compiler that could not start.
    const couldNotStart = /ENOENT|EACCES|not found/i.test(result.spawnError);
    error(couldNotStart ? `Could not run the typechecker: ${result.spawnError}` : result.spawnError);
    if (couldNotStart) info(dim('Install TypeScript (`npm i -D typescript`) or ensure `npx` is on PATH.'));
    return;
  }

  if (result.ok) {
    success(`Typecheck clean ${dim(`(via ${result.via} tsc)`)}.`);
    return;
  }

  if (result.errors.length === 0) {
    // tsc failed but we couldn't parse structured diagnostics — show raw.
    error('Typecheck failed.');
    if (result.raw.trim()) console.error(result.raw.trim());
    return;
  }

  const undefinedSymbols = result.errors.filter((e) => e.code === 'TS2304');
  const n = result.errors.length;
  error(
    `${bold(String(n))} type error${n === 1 ? '' : 's'} ${dim(`(via ${result.via} tsc)`)} — exit 1. \`${cliInvocation()} deploy\` stops before upload.`,
  );
  if (undefinedSymbols.length) {
    warn(
      `${undefinedSymbols.length} undefined symbol${undefinedSymbols.length === 1 ? '' : 's'} (likely a dropped import) — exactly the bug that 500s production.`,
    );
  }
  console.log('');
  for (const e of result.errors) {
    const loc = `${teal(e.file)}:${e.line}:${e.column}`;
    const tag = e.code === 'TS2304' ? red(e.code) : dim(e.code);
    console.log(`  ${loc} ${tag} ${e.message}`);
  }
  console.log('');
}

/** Print the deploy reference check's verdict. */
export function reportDeployCheck(result: DeployCheckResult, label = 'Deploy check'): void {
  if (result.error) {
    error(`Could not run the deploy check (TypeScript ${result.typescript}): ${result.error}`);
    return;
  }
  if (result.ok) {
    success(`${label} clean ${dim(`(${result.checkedFiles} file${result.checkedFiles === 1 ? '' : 's'}, TypeScript ${result.typescript})`)}.`);
    return;
  }
  const references = result.findings.filter((f) => f.kind === 'reference').length;
  const n = result.findings.length;
  error(
    `${bold(String(n))} deploy finding${n === 1 ? '' : 's'} ${dim(`(TypeScript ${result.typescript})`)} — ` +
      `fix these before running \`${cliInvocation()} deploy-check\`${references ? `. Found ${references} undefined name${references === 1 ? '' : 's'}` : ''}.`,
  );
  console.log('');
  for (const f of result.findings) {
    const tag = f.kind === 'reference' ? red(f.code) : dim(f.code);
    console.log(`  ${teal(f.file)}:${f.line}:${f.column} ${tag} ${f.message}`);
  }
  console.log('');
}

const WATCH_DEBOUNCE_MS = 300;

/**
 * Run `check` once file watching is ready, then after each burst of saved edits.
 * One run at a time: edits during a run trigger exactly one more run afterwards.
 */
function watchAndRun(dir: string, check: () => Promise<unknown>): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  const run = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      await check();
    } catch (failure) {
      // One failed check (a save mid-rename, an unreadable file) is reported;
      // the watcher keeps going and the next save checks again.
      error(`Check failed: ${failure instanceof Error ? failure.message : String(failure)}`, failure);
    } finally {
      running = false;
    }
    if (again) { again = false; void run(); }
  };
  chokidar.watch(dir, {
    ignoreInitial: true,
    ignored: (path: string) => {
      const rel = relative(dir, path);
      if (!rel || rel.startsWith('..')) return false;
      // Dot paths hold the checks' own temporary files; __somewhere_* are the
      // editor declarations plain typecheck regenerates. Neither is an edit.
      return rel.split(/[\\/]/).some((seg) => IGNORE.has(seg) || seg.startsWith('.') || seg.startsWith('__somewhere_'));
    },
  }).on('all', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), WATCH_DEBOUNCE_MS);
  }).on('ready', () => void run());
  // Ctrl-C with no check running exits here. A check in flight is stopped by
  // its own runner first (its tree, then its temporary files), which exits 130.
  process.once('SIGINT', () => { if (!running) process.exit(130); });
  info(dim(`Watching ${dir} — checks re-run after each save while this command runs. Ctrl-C to stop.`));
}
