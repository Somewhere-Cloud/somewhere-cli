import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `somewhere docs start | head -1`: the reader closing stdout early is a local
// closed pipe, not a network failure. The command stops quietly.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const page = Array.from({ length: 20000 }, (_, i) => `line ${i} of a long public docs page`).join('\n') + '\n';
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(page); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());

function run(args, { closeAfterFirstChunk }) {
  const config = mkdtempSync(join(tmpdir(), 'sw-epipe-'));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_DOCS_BASE: `http://127.0.0.1:${server.address().port}`,
      SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => { stdout += v; if (closeAfterFirstChunk) child.stdout.destroy(); });
    child.stderr.on('data', (v) => stderr += v);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('a reader that closes stdout early is not reported as a network failure', async () => {
  const result = await run(['docs', 'start'], { closeAfterFirstChunk: true });
  assert.doesNotMatch(result.stderr, /Could not reach|check your connection|EPIPE/, result.stderr);
  assert.equal(result.status, 0, result.stderr);
});

test('a reader that reads everything gets the whole page', async () => {
  const result = await run(['docs', 'start'], { closeAfterFirstChunk: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, page);
});
