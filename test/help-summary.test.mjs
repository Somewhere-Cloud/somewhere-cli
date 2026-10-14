import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { helpSummary } from '../dist/lib/help-summary.js';

test('summary keeps complete sentences, dotted contracts and URLs', () => {
  assert.equal(helpSummary('Read sw.db and https://somewhere.tech/docs. Full details.'), 'Read sw.db and https://somewhere.tech/docs.');
  assert.equal(helpSummary('First line\nExamples follow'), 'First line');
  assert.equal(helpSummary('Single description'), 'Single description');
  assert.equal(helpSummary(''), '');
});

test('every registered command, alias, argument and full command help survives root summarization', async () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const program = new Command().name('somewhere');
  const imports = [...source.matchAll(/import \{ ([\w, ]+) \} from '\.\/commands\/([^']+)\.js';/g)];
  const registrations = new Map();
  for (const [, names, path] of imports) {
    const module = await import(`../dist/commands/${path}.js`);
    for (const name of names.split(', ')) registrations.set(name, module[name]);
  }
  for (const [, name] of source.matchAll(/^(register\w+)\(program\);/gm)) {
    assert.equal(typeof registrations.get(name), 'function', name);
    registrations.get(name)(program);
  }
  assert.ok(program.commands.length > 40);
  const help = program.createHelp();
  const terms = program.commands.map((command) => help.subcommandTerm(command));
  const details = program.commands.map((command) => command.helpInformation());
  const original = program.helpInformation();
  program.configureHelp({ subcommandDescription: (command) => command.summary() || helpSummary(command.description()) });
  const summarized = program.helpInformation();
  assert.ok(summarized.length < original.length * 0.75, `${original.length} -> ${summarized.length}`);
  for (const [index, command] of program.commands.entries()) {
    assert.ok(summarized.includes(terms[index]), terms[index]);
    assert.equal(command.helpInformation(), details[index], command.name());
  }
  const explicit = new Command('explicit').summary('Chosen summary').description('Long contract. More details.');
  assert.equal(program.createHelp().subcommandDescription(explicit), 'Chosen summary');
});

test('actual root help remains successful with JSON mode and no credentials', () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-help-summary-'));
  const env = { ...process.env, HOME: home, SOMEWHERE_CONFIG_DIR: join(home, '.somewhere'), CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' };
  const run = (args) => spawnSync(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url)), ...args], { encoding: 'utf8', env });
  const plain = run(['--help']);
  const json = run(['--help', '--json']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.stdout, plain.stdout);
  assert.match(plain.stdout, /Run somewhere <command> --help for full command details\./);
  assert.equal(plain.stderr, '');
  assert.equal(json.stderr, '');
});
