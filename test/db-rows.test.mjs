import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('managed rows command: actual transport, linked project, refusal and clean JSON',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'cli-managed-rows-'));const requests=[];let reply={ok:true,data:{plane:'managed',rows:[{id:1,title:'one'}],columns:['id','title'],total:1,limit:50,offset:0}};
 const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;requests.push({path:req.url,method:req.method,auth:req.headers.authorization,body:JSON.parse(raw)});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(reply));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
 const commandModule=new URL('../dist/commands/db.js',import.meta.url).href;
 async function command(args,linked=true){if(linked)writeFileSync(join(dir,'.somewhere.json'),JSON.stringify({project_id:'linked-project'}));else rmSync(join(dir,'.somewhere.json'),{force:true});
  const script=`import{Command}from ${JSON.stringify(new URL('../node_modules/commander/esm.mjs',import.meta.url).href)};import{registerDb}from ${JSON.stringify(commandModule)};import{saveConfig}from ${JSON.stringify(new URL('../dist/lib/config.js',import.meta.url).href)};saveConfig({token:'smt_offline_fixture',user:{email:'fixture@test.invalid'}});const p=new Command();registerDb(p);await p.parseAsync(['node','somewhere','db','rows','notes',...JSON.parse(process.env.FIXTURE_ARGS)]);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{cwd:dir,env:{...process.env,SOMEWHERE_CONFIG_DIR:join(dir,'config'),SOMEWHERE_API_URL:`http://127.0.0.1:${server.address().port}/v1`,FIXTURE_ARGS:JSON.stringify(args),NO_COLOR:'1'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);const status=await new Promise((r,j)=>{child.on('close',r);child.on('error',j);});return{status,stdout,stderr};
 }
 let r=await command(['--json','--where','title=one','--where','id=1']);assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),reply.data);assert.deepEqual(requests.at(-1),{path:'/v1/db/rows',method:'POST',auth:'Bearer smt_offline_fixture',body:{project_id:'linked-project',plane:'managed',table:'notes',filters:[{column:'title',op:'eq',value:'one'},{column:'id',op:'eq',value:1}],limit:50,offset:0}});
 r=await command(['--project','explicit-project']);assert.equal(r.status,0,r.stderr);assert.equal(requests.at(-1).body.project_id,'explicit-project');assert.match(r.stdout,/production managed data/);
 for(const args of [['--limit','501'],['--limit','1.5'],['--offset','-1'],['--where','broken']]){const before=requests.length;r=await command(args);assert.equal(r.status,1);assert.equal(requests.length,before);}
 const before=requests.length;r=await command([],false);assert.equal(r.status,1);assert.match(r.stderr,/linked directory/);assert.equal(requests.length,before);
 reply={ok:true,data:{rows:[{title:'raw-secret'}],columns:['title'],total:1,limit:50,offset:0}};r=await command(['--json']);assert.equal(r.status,1);assert.match(r.stderr,/did not confirm the managed database plane/);assert.doesNotMatch(r.stdout,/raw-secret/);
 reply={ok:false,error:'PROJECT_NOT_FOUND',message:'fixture project refusal'};r=await command(['--json']);assert.equal(r.status,1);assert.match(r.stderr,/fixture project refusal/);assert.equal(r.stdout,'');
});
