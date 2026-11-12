import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
    writeFileSync(join(dir, 'db/schema.ts'), schema[1]);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, skipLibCheck: true }, include: ['*.ts'] }));
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
