import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Founder report (waitlist 2338, snag 2): creating a project from the CLI was
// only findable by digging through `somewhere project --help`. The commands an
// agent reads first now name the one command that creates and links one.
const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const help = (...args) => {
  const configDir = mkdtempSync(join(tmpdir(), 'sw-help-'));
  const r = spawnSync(process.execPath, [distIndex, ...args, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, SOMEWHERE_CONFIG_DIR: configDir, SOMEWHERE_API_URL: 'http://127.0.0.1:9', CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
  });
  return r.stdout + r.stderr;
};

test('deploy --help says how to create a project, and that --project targets an existing one', () => {
  const out = help('deploy');
  assert.match(out, /No project yet\?/);
  assert.match(out, /somewhere init --bare --name <name>/);
  assert.match(out, /Existing project to deploy to/);
  assert.match(out, /somewhere link --project <ref>/);
});

test('projects --help names the create command', () => {
  assert.match(help('projects'), /somewhere init --bare --name <name>/);
});
