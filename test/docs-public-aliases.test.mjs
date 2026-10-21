// tsk_51155c7d: signed out, `somewhere docs <alias>` resolves through the
// public manifest's `aliases` — the same names the signed-in docs tool knows —
// so the starter's `schema-changes` skill name reaches sw.db instead of
// "No documentation topic". An older manifest without `aliases` behaves as
// before, and a real page id always wins over an alias.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPublicDocsPage, parsePublicDocsAliases } from '../dist/commands/docs.js';

const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const pages = [
  { id: 'sw.db', title: 'Database', section: 'primitives', body: 'Declare tables in db/schema.ts and deploy.\n', sections: [] },
  { id: 'changes', title: 'Platform changes', section: 'reference', body: 'Behaviour-change log.\n', sections: [] },
  { id: 'schema', title: 'A page whose id is also a synonym', section: 'reference', body: 'The page itself.\n', sections: [] },
];
const WITH_ALIASES = { version: 1, sections: [], pages, aliases: { 'schema-changes': 'sw.db', 'schema-change': 'sw.db', schema: 'declared-data' } };
const WITHOUT_ALIASES = { version: 1, sections: [], pages };

function run(args, base) {
  return new Promise((resolvePromise) => {
    const home = mkdtempSync(join(tmpdir(), 'sw-docs-alias-home-'));
    const child = spawn(process.execPath, [distIndex, ...args], {
      env: { ...process.env, HOME: home, SOMEWHERE_CONFIG_DIR: join(home, '.somewhere'), SOMEWHERE_DOCS_BASE: base, CI: '1', NO_COLOR: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

async function withManifest(manifest, fn) {
  const server = createServer((req, res) => {
    if (req.url === '/docs-manifest.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(manifest));
      return;
    }
    res.statusCode = 404;
    res.end('missing');
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

test('signed out, `docs schema-changes` opens sw.db through the manifest alias', async () => {
  await withManifest(WITH_ALIASES, async (base) => {
    const human = await run(['docs', 'schema-changes'], base);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /db\/schema\.ts/);
    assert.doesNotMatch(human.stdout + human.stderr, /Behaviour-change log|No documentation topic/);
    const json = JSON.parse((await run(['docs', 'Schema Change', '--json'], base)).stdout);
    assert.equal(json.topic, 'sw.db', 'reported under its canonical id; spaces and case normalise like the docs tool');
  });
});

test('a real page id wins over an alias of the same name', () => {
  assert.equal(findPublicDocsPage(pages, parsePublicDocsAliases(WITH_ALIASES), 'schema')?.id, 'schema');
  assert.equal(findPublicDocsPage(pages, parsePublicDocsAliases(WITH_ALIASES), 'nonsense'), undefined);
  assert.equal(findPublicDocsPage(pages, parsePublicDocsAliases({ aliases: { x: 'missing-page' } }), 'x'), undefined,
    'an alias to a page the manifest does not carry resolves to nothing');
});

test('an older manifest without aliases keeps today\'s not-found answer', async () => {
  assert.deepEqual(parsePublicDocsAliases(WITHOUT_ALIASES), {});
  assert.deepEqual(parsePublicDocsAliases({ aliases: ['not', 'a', 'map'] }), {});
  await withManifest(WITHOUT_ALIASES, async (base) => {
    const r = await run(['docs', 'schema-changes'], base);
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /No documentation topic named "schema-changes"/);
  });
});

test('inherited object names never resolve through aliases', async () => {
  const { findPublicDocsPage, parsePublicDocsAliases } = await import('../dist/commands/docs.js');
  const pages = [{ id: 'sw.db', title: 'sw.db', body: '' }];
  for (const manifest of [{}, { aliases: { 'schema-changes': 'sw.db' } }]) {
    const aliases = parsePublicDocsAliases(manifest);
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      assert.equal(findPublicDocsPage(pages, aliases, name), undefined, name);
    }
  }
  // A plain object passed by a caller is guarded too.
  assert.equal(findPublicDocsPage(pages, {}, 'constructor'), undefined);
});
