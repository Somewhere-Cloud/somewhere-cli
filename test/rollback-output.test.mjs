import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRollbackSuccess } from '../dist/commands/rollback.js';

test('rollback success includes the restored-file count when the API returns it', () => {
  const line = formatRollbackSuccess({ version: 4, files_restored: 3 });

  assert.equal(line, 'Rolled back to v4 (3 files restored)');
  assert.doesNotMatch(line, /null|undefined/);
});

test('rollback success omits the restored-file parenthetical when the API omits the count', () => {
  const line = formatRollbackSuccess({ version: 4 });

  assert.equal(line, 'Rolled back to v4');
  assert.doesNotMatch(line, /null|undefined/);
});

// The database_notice the JSON output and MCP carry reaches the human output too (0.38.15).
import { formatRollbackNotes } from '../dist/commands/rollback.js';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const NOTICE = 'Database unchanged: the tables and columns added since version 3 ("orders"."note") stay, with their data, and version 3 ignores them.';

test('rollback notes print the database notice as its own Version notes line', () => {
  assert.deepEqual(formatRollbackNotes({ message: 'Rolled back to your previous version.', database_notice: NOTICE }), [
    'Version notes: Rolled back to your previous version.',
    `Version notes: ${NOTICE}`,
  ]);
  assert.deepEqual(formatRollbackNotes({ message: `Rolled back to your previous version. ${NOTICE}`, database_notice: NOTICE }),
    [`Version notes: Rolled back to your previous version. ${NOTICE}`], 'never printed twice');
  assert.deepEqual(formatRollbackNotes({ message: null, database_notice: NOTICE }), [`Version notes: ${NOTICE}`]);
  assert.deepEqual(formatRollbackNotes({ message: 'Rolled back.', database_notice: null }), ['Version notes: Rolled back.']);
});

test('somewhere rollback (human output) prints the database_notice line', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-rollback-notice-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'sw-rollback-notice-'));
  mkdirSync(join(HOME, '.somewhere'), { recursive: true });
  writeFileSync(join(HOME, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_rollback_notice', user: { email: 'dev@example.com', username: 'dev' } }) + '\n');
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.method === 'POST' && req.url === '/v1/promote/rollback'
        ? { ok: true, data: { restored_at: '2026-11-04T00:00:00.000Z', version: 3, files_restored: null, message: 'Rolled back to your previous version.', database_notice: NOTICE } }
        : { ok: true, data: { notices: [] } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
    const out = await new Promise((resolvePromise) => {
      const child = spawn(process.execPath, [distIndex, 'rollback', '--project', 'p-notice', '--yes'], {
        cwd, env: { ...process.env, HOME, USERPROFILE: HOME, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1', SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1` },
      });
      let text = '';
      child.stdout.on('data', (c) => (text += c));
      child.stderr.on('data', (c) => (text += c));
      child.on('close', (status) => resolvePromise({ status, text }));
    });
    assert.equal(out.status, 0, out.text);
    assert.match(out.text, /Rolled back to v3/);
    assert.ok(out.text.includes(`Version notes: ${NOTICE}`), out.text);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
