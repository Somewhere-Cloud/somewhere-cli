import { Command } from 'commander';
import chokidar from 'chokidar';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ora from '../lib/spinner.js';
import { DEPLOY_CHECK_TYPESCRIPT_VERSION, runDeployCheck, type DeployCheckResult } from '../lib/deploy-check.js';
import { IGNORE } from '../lib/files.js';
import { AGENT_HOSTS, isAgentHost, runAgentHook } from '../lib/agent-hooks.js';
import { bold, dim, error, info, printJson, red, success, teal, warn } from '../lib/output.js';
import { ensureDeclaredTypePackages, runTypecheck, type TypecheckResult } from '../lib/typecheck.js';

export const MISSING_TSCONFIG_GUIDANCE =
  'No tsconfig.json here to typecheck against. Add a local tsconfig.json for a new app, or run `somewhere pull` for an existing deployed app.';

export function registerTypecheck(program: Command) {
  program
    .command('typecheck [dir]')
    .description(
      'Check a source project with `tsc --noEmit`. ' +
        'Reports TypeScript errors with file:line before deploy. ' +
        'Requires a local tsconfig.json; add one for a new app, or run `somewhere pull` for an existing deployed app. ' +
        'With --deploy, runs the deploy\'s advisory reference check instead (the files a deploy uploads, its generated types, ' +
        `options and TypeScript ${DEPLOY_CHECK_TYPESCRIPT_VERSION}) against the packages installed here; no tsconfig.json needed. ` +
        'It reports a narrower set than the default project check, which stays the stricter of the two.',
    )
    .option('--json', 'Print the raw typecheck result as JSON')
    .option('--deploy', "Run the deploy's reference check: the undefined-name and type findings a deploy reports. Fetches TypeScript " + DEPLOY_CHECK_TYPESCRIPT_VERSION + " through npx unless the project has exactly that version")
    .option('--hook <host>', `With --deploy: run as an agent after-edit hook (${AGENT_HOSTS.join(', ')}), reading the host's event on stdin. Installed by \`somewhere hooks install\``)
    .option('--watch', 'Keep running and re-check after each save while this command is open. It is not installed into your editor or agent; start it yourself. Never deploys or touches live data')
    .action(async (dirArg: string | undefined, opts) => {
      const dir = resolve(process.cwd(), dirArg ?? '.');

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

      if (opts.deploy) {
        const check = async () => {
          const result = await runDeployCheck(dir);
          if (opts.json) printJson(result);
          else reportDeployCheck(result);
          return result;
        };
        if (opts.watch) return watchAndRun(dir, check);
        const result = await check();
        process.exit(result.ok ? 0 : 1);
      }

      if (!existsSync(join(dir, 'tsconfig.json'))) {
        if (opts.json) {
          printJson({
            ok: false,
            errors: [],
            via: 'bundled',
            raw: '',
            spawnError: MISSING_TSCONFIG_GUIDANCE,
          });
          process.exit(1);
        }
        error(MISSING_TSCONFIG_GUIDANCE);
        process.exit(1);
      }

      if (opts.watch) {
        return watchAndRun(dir, async () => {
          const result = await runTypecheck(dir);
          if (opts.json) printJson(result);
          else reportTypecheck(result);
          return result;
        });
      }

      const spinner = opts.json ? null : ora('Typechecking (tsc --noEmit)...').start();
      // Type packages this project declares but has not installed yet are a
      // missing tree, not a code error. Resolve them so the FIRST check is a
      // real verdict; runTypecheck is then told not to repeat the step.
      if (spinner) spinner.text = 'Checking declared type packages...';
      const resolved = ensureDeclaredTypePackages(dir);
      if (spinner) spinner.text = 'Typechecking (tsc --noEmit)...';
      const result = await runTypecheck(dir, { installTypePackages: false });
      spinner?.stop();
      if (!opts.json && resolved.installed) {
        info(dim(`Resolved declared type packages: ${resolved.missing.join(', ')}`));
      }

      if (opts.json) {
        printJson(result);
        process.exit(result.ok ? 0 : 1);
      }
      reportTypecheck(result);
      process.exit(result.ok ? 0 : 1);
    });
}

/** Print the local TypeScript check verdict. */
export function reportTypecheck(result: TypecheckResult): void {
  if (result.spawnError) {
    error(`Could not run the typechecker: ${result.spawnError}`);
    info(dim('Install TypeScript (`npm i -D typescript`) or ensure `npx` is on PATH.'));
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
    `${bold(String(n))} type error${n === 1 ? '' : 's'} ${dim(`(via ${result.via} tsc)`)} — deploys are not blocked by type errors; fix at your own pace.`,
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
export function reportDeployCheck(result: DeployCheckResult): void {
  if (result.error) {
    error(`Could not run the deploy check (TypeScript ${result.typescript}): ${result.error}`);
    return;
  }
  if (result.ok) {
    success(`Deploy check clean ${dim(`(${result.checkedFiles} file${result.checkedFiles === 1 ? '' : 's'}, TypeScript ${result.typescript})`)}.`);
    return;
  }
  const references = result.findings.filter((f) => f.kind === 'reference').length;
  const n = result.findings.length;
  error(
    `${bold(String(n))} deploy finding${n === 1 ? '' : 's'} ${dim(`(TypeScript ${result.typescript})`)} — ` +
      `a deploy reports these as warnings${references ? `; ${references} undefined name${references === 1 ? '' : 's'} will fail at runtime` : ''}.`,
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
      error(`Check failed: ${failure instanceof Error ? failure.message : String(failure)}`);
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
  // Ctrl-C exits through process.exit so a check in flight removes its files.
  process.once('SIGINT', () => process.exit(130));
  info(dim(`Watching ${dir} — checks re-run after each save while this command runs. Ctrl-C to stop.`));
}
