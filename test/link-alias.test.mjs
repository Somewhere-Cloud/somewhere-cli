import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `somewhere link` is documented as an alias for `init --link`: it must accept the same
// --project/--json options and give the same answer (it failed with "unknown option '--project'").
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repoRoot, 'dist', 'index.js');

function run(args, cwd, home) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), SOMEWHERE_API_KEY: '', SOMEWHERE_TOKEN: '', CI: '1' };
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', input: '' });
  return { status: r.status, out: (r.stdout + r.stderr).replace(/\s+/g, ' ').trim() };
}

test('link takes --project and --json and answers exactly as init --link', () => {
  const base = mkdtempSync(join(tmpdir(), 'sw-link-alias-'));
  try {
    const home = join(base, 'home');
    const app = join(base, 'app');
    for (const dir of [home, app]) spawnSync('mkdir', ['-p', dir]);
    writeFileSync(join(app, 'package.json'), '{"name":"existing-app"}\n');
    for (const flags of [['--project', 'some-project', '--json'], ['--project', 'some-project']]) {
      const viaLink = run(['link', ...flags], app, home);
      const viaInit = run(['init', '--link', ...flags], app, home);
      assert.doesNotMatch(viaLink.out, /unknown option/i, `link ${flags.join(' ')}: ${viaLink.out}`);
      assert.deepEqual(viaLink, viaInit, `link ${flags.join(' ')} answers as init --link`);
    }
    // Without --project in a non-interactive shell, both name the flag instead of prompting.
    const bare = run(['link'], app, home);
    assert.deepEqual(bare, run(['init', '--link'], app, home));
    assert.match(bare.out, /--project <ref>/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
