import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertBundleBudget, BUNDLE_BUDGET } from '../scripts/public-projection.mjs';

test('packed CLI starts and offers deploy notes after an offline production-only install', async () => {
 const repo=fileURLToPath(new URL('../',import.meta.url)),root=mkdtempSync(join(tmpdir(),'sw-production-install-'));
 const run=(cmd,args,cwd=repo)=>{const r=spawnSync(cmd,args,{cwd,env:{...process.env,SOMEWHERE_CONFIG_DIR:join(root,'config'),SOMEWHERE_NO_NOTIFICATIONS:'1',NO_COLOR:'1'},encoding:'utf8',maxBuffer:8e6,timeout:120000});assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 try {
  const packed=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',root]));
  assertBundleBudget(packed[0]);
  run('npm',['install','--prefix',root,'--offline','--ignore-scripts','--omit=dev',join(root,packed[0].filename)]);
  assert.ok(!packed[0].files.some(({ path }) => path.startsWith('node_modules/')));
  const paths = packed[0].files.map(({ path }) => path);
  for (const path of ['dist/lib/bundle.js', 'dist/lib/bundle.js.map', 'NOTICE.third-party.txt']) {
    assert.ok(paths.includes(path));
  }
  assert.equal(existsSync(join(root, 'node_modules/typescript')), false);
  const installed = join(root, 'node_modules/@somewhere-cloud/cli');
  const cli = join(installed, 'bin/somewhere.js');
  const manifest = JSON.parse(readFileSync(join(root, 'node_modules/@somewhere-cloud/cli/package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.peerDependencies ?? {}, {});
  assert.equal(run(process.execPath, ['-e', "console.log(typeof require('@somewhere-cloud/cli/script').openAppTest)"], root).trim(), 'function');
  assert.equal(run(process.execPath, ['--input-type=module', '-e', "import {UserSession} from '@somewhere-cloud/cli/testing'; console.log(typeof UserSession)"], root).trim(), 'function');
  const version=JSON.parse(readFileSync(join(repo,'package.json'),'utf8')).version;
  assert.equal(run(process.execPath,[cli,'--version'],root).trim(),version);
  assert.match(run(process.execPath,[cli,'deploy','--help'],root),/-m, --message/);

  // The platform's pinned docs and starter checks also use installed file paths.
  const entry = path => import(pathToFileURL(join(installed, 'dist', path)).href);
  const functions = {
    'commands/init.js': 'registerInit',
    'commands/docs.js': 'parsePublicDocsManifest',
    'lib/declared-data.js': 'prepareDeclaredData',
    'lib/files.js': 'collectFiles',
    'lib/init-feature-template.js': 'createFeatureTemplate',
    'lib/init-features.js': 'resolveInitSelection',
    'lib/source-lint.js': 'lintProject',
    'lib/typecheck.js': 'runTypecheck',
  };
  for (const [path, name] of Object.entries(functions)) assert.equal(typeof (await entry(path))[name], 'function', path);
  assert.ok((await entry('lib/skills-pack.generated.js')).BUNDLED_SKILLS_PACK.files.length);
  const init = readFileSync(join(installed, 'dist/commands/init.js'), 'utf8');
  const data = readFileSync(join(installed, 'dist/lib/declared-data.js'), 'utf8');
  assert.match(init, /const DEFAULT_AUTH_SELECTION = \{ requested: \['auth', 'private-data'\]/);
  assert.match(data, /const SW_ENDPOINT_GLOBAL = `[\s\S]*?`;/);

 } finally {rmSync(root,{recursive:true,force:true});}
});


test('published bundle budget rejects growth in each dimension and external npm files', () => {
  const pack = { ...BUNDLE_BUDGET, files: [{ path: 'dist/lib/bundle.js' }] };
  assert.doesNotThrow(() => assertBundleBudget(pack));
  for (const [field, maximum] of Object.entries(BUNDLE_BUDGET)) {
    assert.throws(() => assertBundleBudget({ ...pack, [field]: maximum + 1 }), new RegExp(field));
  }
  assert.throws(() => assertBundleBudget({ ...pack, files: [{ path: 'node_modules/new-dependency/index.js' }] }), /node_modules/);
});
