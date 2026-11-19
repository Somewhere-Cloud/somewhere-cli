import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('packed CLI starts and offers deploy notes after an offline production-only install',()=>{
 const repo=fileURLToPath(new URL('../',import.meta.url)),root=mkdtempSync(join(tmpdir(),'sw-production-install-'));
 const run=(cmd,args,cwd=repo)=>{const r=spawnSync(cmd,args,{cwd,env:{...process.env,SOMEWHERE_CONFIG_DIR:join(root,'config'),SOMEWHERE_NO_NOTIFICATIONS:'1',NO_COLOR:'1'},encoding:'utf8',maxBuffer:8e6,timeout:120000});assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 try {
  const packed=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',root]));
  run('npm',['install','--prefix',root,'--offline','--ignore-scripts','--omit=dev',join(root,packed[0].filename)]);
  assert.ok(!packed[0].files.some(({ path }) => path.startsWith('node_modules/typescript/')));
  assert.equal(existsSync(join(root, 'node_modules/typescript')), false);
  const cli=join(root,'node_modules/@somewhere-cloud/cli/bin/somewhere.js');
  const version=JSON.parse(readFileSync(join(repo,'package.json'),'utf8')).version;
  assert.equal(run(process.execPath,[cli,'--version'],root).trim(),version);
  assert.match(run(process.execPath,[cli,'deploy','--help'],root),/-m, --message/);
 } finally {rmSync(root,{recursive:true,force:true});}
});
