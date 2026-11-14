import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

// Class: a subcommand that defines an option its parent also defines never
// receives it from Commander: the parent takes it (`preview link --json`
// printed human text). Every such subcommand must read optsWithGlobals().
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every subcommand shadowed by a parent option reads optsWithGlobals', async () => {
  const program = new Command();
  const dir = join(repoRoot, 'dist', 'commands');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const mod = await import(join(dir, file));
    for (const [name, register] of Object.entries(mod)) {
      if (name.startsWith('register') && typeof register === 'function') {
        try { register(program); } catch { /* a register that needs more context is not a subcommand host */ }
      }
    }
  }
  const shadowed = [];
  const walk = (cmd, path) => {
    for (const sub of cmd.commands) {
      const parentLongs = new Set(cmd.options.map((o) => o.long));
      const shared = sub.options.map((o) => o.long).filter((l) => parentLongs.has(l));
      if (cmd !== program && shared.length) shadowed.push(`${path} ${sub.name()}`);
      walk(sub, `${path} ${sub.name()}`);
    }
  };
  walk(program, '');
  assert.deepEqual(shadowed.sort(), [
    ' ai keys list', ' ai keys remove', ' ai keys set', ' preview close', ' preview link', ' preview list',
  ], 'a newly shadowed subcommand must read optsWithGlobals; add it here once it does');
  const dev = readFileSync(join(repoRoot, 'src', 'commands', 'dev.ts'), 'utf8');
  for (const sub of ['list', 'close', 'link']) {
    const at = dev.indexOf(`.command('${sub}`);
    assert.ok(at > 0 && dev.indexOf('cmd.optsWithGlobals()', at) > at && dev.indexOf('cmd.optsWithGlobals()', at) < dev.indexOf('.command(', at + 10) + (dev.indexOf('.command(', at + 10) < 0 ? Infinity : 0),
      `preview ${sub} reads optsWithGlobals`);
  }
  const ai = readFileSync(join(repoRoot, 'src', 'commands', 'ai.ts'), 'utf8');
  assert.match(ai, /cmd\.optsWithGlobals<KeyOptions>\(\)/);
});
