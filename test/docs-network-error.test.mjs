import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `somewhere docs` with the docs host unreachable names the host and the
// reason, never a bare "fetch failed" (pfb_a2e65d951e62).
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

test('an unreachable docs host is named with its reason', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const result = spawnSync(process.execPath, [cli, 'docs'], { encoding: 'utf8', env: {
    ...process.env, SOMEWHERE_DOCS_BASE: `http://127.0.0.1:${port}`, SOMEWHERE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'sw-docs-net-')),
    SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
  } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`Could not reach http://127\\.0\\.0\\.1:${port} \\(ECONNREFUSED\\) — check your connection`));
  assert.doesNotMatch(result.stderr, /^✗ fetch failed$/m);
});
