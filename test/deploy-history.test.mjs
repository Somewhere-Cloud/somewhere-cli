import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/somewhere.js', import.meta.url));

test('file --version reaches the file command and prints the original bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sw-historical-file-'));
  const config = join(root, 'config');
  mkdirSync(config);
  writeFileSync(join(config, 'config.json'), JSON.stringify({ token: 'fixture', user: { email: 'fixture@example.test' } }));
  const bytes = Buffer.from([0xff, 0x00, 0x80, 0x0a]);
  const paths = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, data: { content: bytes.toString('base64'), encoding: 'base64' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const child = spawn(process.execPath, [cli, 'file', 'image.png', '--version', '2', '--project', 'fixture'], {
      cwd: root,
      env: { ...process.env, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1`,
        CI: '1', NO_COLOR: '1' },
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    const [status] = await once(child, 'close');
    assert.equal(status, 0, Buffer.concat(stderr).toString());
    assert.deepEqual(paths, ['/v1/deploy/file?project_id=fixture&path=image.png&version=2']);
    assert.deepEqual(Buffer.concat(stdout), bytes);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('rollback and restore help explain what happens to the database', () => {
  const root = mkdtempSync(join(tmpdir(), 'sw-rollback-help-'));
  try {
    const help = command => execFileSync(process.execPath, [cli, command, '--help'], {
      encoding: 'utf8', cwd: root,
      env: { ...process.env, SOMEWHERE_CONFIG_DIR: root, CI: '1', NO_COLOR: '1' },
    }).replace(/\s+/g, ' ');
    assert.ok(help('rollback').includes('By default this changes code without restoring data.'));
    assert.ok(help('restore').includes('Restoring by number leaves the database schema and data unchanged.'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
