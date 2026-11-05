import { Command } from 'commander';
import semver from 'semver';
import { CLI_VERSION } from '../lib/version.js';
import {
  CLI_PACKAGE_NAME,
  changelogBetween,
  readBundledChangelog,
  readProjectPins,
  recordPinIfMissing,
  writeProjectPins,
  type ChangelogEntry,
} from '../lib/project-pin.js';
import { bold, error, info, printJson, printJsonError, success, teal } from '../lib/output.js';

interface UpgradeOptions {
  json?: boolean;
}

export interface UpgradeResult {
  from: string | null;
  to: string;
  updated: string[];
  changes: ChangelogEntry[];
  next: string[];
}

/** Move this folder's CLI pin to the running CLI and list what changed. */
export function upgradeProject(dir: string, running: string, changelog: () => string = readBundledChangelog): UpgradeResult {
  if (!semver.valid(running)) throw new Error(`This CLI reports version ${running}, which cannot be recorded as a pin.`);
  const pins = readProjectPins(dir);
  if (!pins.length) {
    if (!recordPinIfMissing(dir, running)) {
      throw new Error(
        `This folder records no CLI version and is not a linked project. Add "${CLI_PACKAGE_NAME}": "${running}" to package.json devDependencies, or run \`somewhere init --link\` first.`,
      );
    }
    return { from: null, to: running, updated: ['.somewhere.json'], changes: [], next: [] };
  }
  const current = pins[0].spec;
  const from = semver.valid(current) ?? semver.minVersion(current)?.version ?? null;
  if (!from) throw new Error(`The recorded CLI version "${current}" (${pins[0].source}) is not a version or range; set it to ${running} by hand.`);
  if (semver.lt(running, from)) {
    throw new Error(
      `This CLI (${running}) is older than the project's pin (${current}). Run the newer CLI's upgrade: \`npx -y ${CLI_PACKAGE_NAME}@latest upgrade\`.`,
    );
  }
  const alreadyExact = pins.every((pin) => pin.spec === running);
  const updated = alreadyExact ? [] : writeProjectPins(dir, pins, running);
  const next = updated.includes('package.json') ? ['npm install'] : [];
  return { from, to: running, updated, changes: changelogBetween(changelog(), from, running), next };
}

export function registerUpgrade(program: Command) {
  program
    .command('upgrade')
    .description('Move this project to the CLI you are running: rewrite its recorded CLI version and print the changes in between')
    .option('--json', 'Print the result as JSON')
    .addHelpText(
      'after',
      '\nA project records the CLI version it was built with (package.json devDependency\n'
        + `"${CLI_PACKAGE_NAME}", or "cli_version" in .somewhere.json). Commands run in a\n`
        + 'project pinned to another version print one line saying so, and hand off to the\n'
        + 'pinned version when it is installed in node_modules. To move to the newest release:\n'
        + `  npx -y ${CLI_PACKAGE_NAME}@latest upgrade\n`
        + 'Agent skills are not changed; `somewhere skills update` refreshes them.\n',
    )
    .action((opts: UpgradeOptions) => {
      let result: UpgradeResult;
      try {
        result = upgradeProject(process.cwd(), CLI_VERSION);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (opts.json) printJsonError('UPGRADE_REFUSED', message);
        else error(message);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        printJson(result);
        return;
      }
      if (!result.from) success(`Recorded somewhere CLI ${teal(result.to)} in ${result.updated.join(', ')}.`);
      else if (!result.updated.length) success(`This project is already pinned to ${teal(result.to)}.`);
      else success(`Moved this project from somewhere CLI ${result.from} to ${teal(result.to)} (${result.updated.join(', ')}).`);
      if (result.changes.length) {
        console.log('');
        for (const entry of result.changes) {
          console.log(bold(`## ${entry.version}`));
          console.log(entry.body);
          console.log('');
        }
      }
      if (result.next.includes('npm install')) info(`Run ${teal('npm install')} to install ${result.to} in node_modules and update the lockfile.`);
      info('Agent skills were not changed; `somewhere skills status` compares them with the latest pack.');
    });
}
