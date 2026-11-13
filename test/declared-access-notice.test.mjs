import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { declaredAccessNotice } from '../dist/lib/declared-data.js';

const header = "import { schema, table, id, text, owner, serverOnly } from 'somewhere/db';\n";
const files = source => ({ 'db/schema.ts': header + source });
const source = "export default schema({ state: table({ id: id(), value: text() }, { scope: serverOnly() }) });";
const message = 'Access is entirely hand-written in this app; declare ordinary app data instead: somewhere docs declared-data --section declare-a-table-and-use-it';

test('notice uses complete parsed declarations, including constants and spreads', () => {
  assert.equal(declaredAccessNotice(files(source)), message);
  assert.equal(declaredAccessNotice(files("const fields = { value: text() }; const tables = { state: table({ id: id(), ...fields }, { scope: serverOnly() }) }; export default schema({ ...tables });")), message);
  assert.equal(declaredAccessNotice({}), undefined);
  assert.equal(declaredAccessNotice(files('export default schema({});')), undefined);
  assert.equal(declaredAccessNotice(files('export default schema({ broken: helper() });')), undefined);
  assert.equal(declaredAccessNotice(files("export default schema({ notes: table({ id: id(), value: text({ default: 'serverOnly()' }) }, { scope: owner() }) });")), undefined);
  assert.equal(declaredAccessNotice(files("export default schema({ state: table({ id: id() }, { scope: serverOnly() }), notes: table({ id: id() }, { scope: owner() }) });")), undefined);
  assert.equal(declaredAccessNotice(files("export default schema({ state: table({ id: id() }, { scope: serverOnly(), client: {} }) });")), undefined);
});

for (const args of [['deploy-check'], ['deploy', '--dry-run']]) {
  for (const json of [false, true]) {
    test(`${args.join(' ')} prints the advisory once${json ? ' with JSON preserved' : ''}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'access-notice-'));
      try {
        mkdirSync(join(dir, 'db'));
        mkdirSync(join(dir, 'api'));
        symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
        writeFileSync(join(dir, 'db/schema.ts'), header + source);
        writeFileSync(join(dir, 'api/ping.ts'), "export default sw.endpoint({ auth: 'required', handler: async () => ({ ok: true }) });\n");
        writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, skipLibCheck: true, noEmit: true }, include: ['api', '*.ts'] }));
        const result = spawnSync(process.execPath, [resolve('dist/index.js'), ...args, ...(json ? ['--json'] : [])], {
          cwd: dir, env: { ...process.env, SOMEWHERE_CONFIG_DIR: join(dir, 'config'), SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1' }, encoding: 'utf8', timeout: 30000,
        });
        assert.equal(result.status, args[0] === 'deploy' ? 1 : 0, result.stdout + result.stderr);
        if (args[0] === 'deploy') assert.match(result.stdout + result.stderr, /dry run compares this folder/i);
        assert.equal((result.stdout + result.stderr).split(message).length - 1, 1);
        if (json) {
          assert.doesNotThrow(() => JSON.parse(result.stdout));
          assert.ok(result.stderr.includes(message));
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
}
