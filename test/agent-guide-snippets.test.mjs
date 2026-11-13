import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { INIT_AGENTS_MD } from '../dist/lib/init-agent-guide.js';
import { runTypecheck } from '../dist/lib/typecheck.js';

test('every TypeScript guidance snippet checks against generated starter declarations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guide-snippets-'));
  try {
    mkdirSync(join(dir, 'db'));
    const schema = [...INIT_AGENTS_MD.matchAll(/```ts\n([\s\S]*?)```/g)].find(match => match[1].includes('export default schema('));
    assert.ok(schema);
    for (const shape of ['notes', 'tasks', 'tickets', 'messages', 'staff_notes', 'pages', 'note_shares']) assert.ok(schema[1].includes(shape + ': table('));
    const firstEndpoint = INIT_AGENTS_MD.slice(INIT_AGENTS_MD.indexOf('// api/teams.ts')).split('```')[0];
    assert.match(firstEndpoint, /sw\.groups\.create\(request/);
    assert.match(firstEndpoint, /sw\.groups\.list\(request/);
    writeFileSync(join(dir, 'db/schema.ts'), schema[1]);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, skipLibCheck: true, paths: { '@somewhere-cloud/cli/testing': [join(process.cwd(), 'dist/testing.d.ts')] } }, include: ['*.ts'] }));
    const snippets = [...INIT_AGENTS_MD.matchAll(/```ts\n([\s\S]*?)```/g)];
    assert.ok(snippets.length > 0);
    snippets.forEach((match, index) => writeFileSync(join(dir, `snippet-${index}.ts`), match[1] + '\nexport {};\n'));
    const result = await runTypecheck(dir);
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the schema grammar accepts named declarative constants and their spreads', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const generator = require('../runtime/declared-data.cjs');
  assert.doesNotThrow(() => generator.generateFromFiles({
    'db/schema.ts': `import { schema, table, id, text, owner } from 'somewhere/db';
const fields = { title: text() };
export default schema({ notes: table({ id: id(), ...fields }, { scope: owner(), client: { read: ['id', 'title'] } }) });`,
  }));
});

const platform = process.env.SOMEWHERE_PLATFORM_REPO;
// Each docs example is laid out at the path its first line names, so relative
// imports resolve, and checked as one project against the starter declarations.
for (const [topic, heading, count] of [['sw.groups', '## Team example', 7], ['sw.groups', '## Staff example', 3], ['declared-data', '## Teams', 2]]) {
  test(`${topic} ${heading} checks as a project against generated starter declarations`, { skip: !platform }, async () => {
    const body = readFileSync(join(platform, 'docs/mcp-topics', topic + '.md'), 'utf8');
    const start = body.indexOf('\n' + heading + '\n');
    assert.notEqual(start, -1);
    const section = body.slice(start + heading.length + 2).split(/\n## /)[0];
    const snippets = [...section.matchAll(/```ts\n([\s\S]*?)```/g)].map(match => match[1]);
    assert.equal(snippets.length, count);
    const dir = mkdtempSync(join(tmpdir(), 'teams-doc-snippets-'));
    try {
      for (const code of snippets) {
        const path = code.match(/^\/\/ (\S+\.ts)\n/)?.[1];
        assert.ok(path, 'each example names its file on its first line');
        mkdirSync(join(dir, path, '..'), { recursive: true });
        writeFileSync(join(dir, path), code);
      }
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, skipLibCheck: true, paths: { '@somewhere-cloud/cli/testing': [join(process.cwd(), 'dist/testing.d.ts')] } }, include: ['**/*.ts'] }));
      const result = await runTypecheck(dir);
      assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
test('server paging example checks against starter declarations', { skip: !platform }, async () => {
  const body = readFileSync(join(platform, 'docs/mcp-topics/sw.db.md'), 'utf8');
  const section = body.split('## Server read paging\n')[1].split('\n## ')[0];
  const snippet = section.match(/```ts\n([\s\S]*?)```/)[1];
  const schema = [...INIT_AGENTS_MD.matchAll(/```ts\n([\s\S]*?)```/g)][0][1];
  const dir = mkdtempSync(join(tmpdir(), 'server-paging-snippet-'));
  try {
    mkdirSync(join(dir, 'db'));
    writeFileSync(join(dir, 'db/schema.ts'), schema);
    writeFileSync(join(dir, 'paging.ts'), snippet);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, skipLibCheck: true }, include: ['*.ts'] }));
    const result = await runTypecheck(dir);
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const ledger of ['shares', 'article_shares']) {
  test(`${ledger} example compiles and has no browser write API`, { skip: !platform }, async () => {
    const body = readFileSync(join(platform, 'docs/mcp-topics/declared-data.md'), 'utf8');
    const code = [...body.matchAll(/```ts\n([\s\S]*?)```/g)].map(m => m[1]).find(code => code.includes(`  ${ledger}: table(`));
    assert.ok(code);
    const dir = mkdtempSync(join(tmpdir(), 'grant-ledger-snippet-'));
    try {
      mkdirSync(join(dir, 'db'));
      writeFileSync(join(dir, 'db/schema.ts'), code);
      const readable = ledger === 'shares' ? 'contacts' : 'articles';
      writeFileSync(join(dir, 'probe.ts'), `import { data } from 'somewhere:data';\nvoid data.${readable}.list();\n// @ts-expect-error grant ledgers are not browser writable\nvoid data.${ledger}.create({ grantee_id: 'another-user' });\n`);
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, skipLibCheck: true }, include: ['*.ts'] }));
      const result = await runTypecheck(dir);
      assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
