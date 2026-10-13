import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareDeclaredData} from '../dist/lib/declared-data.js';
import {runTypecheck} from '../dist/lib/typecheck.js';
const schema=`import { parent } from 'somewhere/db';
export default schema({
 notes: table({id:id(),title:text()}, {scope:owner(),relations:{comments:hasMany('comments','note_id')},client:{read:true,create:['title'],links:{read:true,anonymousCreate:true,children:['comments']}}}),
 comments: table({id:id(),note_id:integer({references:'notes'}),body:text()}, {scope:parent({via:'note_id'}),client:{read:true}})
});`;
function fixture(t){const root=mkdtempSync(join(tmpdir(),'cli-list-limit-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'src'));mkdirSync(join(root,'db'));writeFileSync(join(root,'db/schema.ts'),schema);writeFileSync(join(root,'package.json'),JSON.stringify({name:'private-list-limit-fixture',private:true}));writeFileSync(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,skipLibCheck:false,target:'ES2022',module:'ESNext',moduleResolution:'Bundler'},include:['src']}));return root;}
test('vendored local list types reject invalid literals and mixed unions, retaining dynamic limits and paging',async t=>{
 const root=fixture(t);const paths=['data.notes.list','data.notes.relations.comments.list',"data.linked('lnk_'+'1'.repeat(32)).notes.relations.comments.list","data.creator('crt_'+'1'.repeat(32)).notes.relations.comments.list"];
 const calls=paths.flatMap((expression,index)=>{const args=index?'1, ':'';return [
 `${expression}(${args}{limit:1});${expression}(${args}{limit:25});${expression}(${args}{limit:100,after:2});`,
 `${expression}(${index?'1':''});${expression}(${args}{limit:dynamic});${expression}(${args}{limit:validUnion});${expression}(${args}{limit:100} as const);`,
 ...['0','-1','1.5','101','200','mixedUnion'].map(value=>`// @ts-expect-error invalid literal list size\n${expression}(${args}{limit:${value}});`),
 ];}).join('\n');
 const usage=`import {data} from 'somewhere:data';declare const dynamic:number;declare const validUnion:1|100;declare const mixedUnion:1|200;\n${calls}`;
 writeFileSync(join(root,'src/main.ts'),usage);let result=await runTypecheck(root,{installTypePackages:false});assert.equal(result.ok,true,result.raw);
 writeFileSync(join(root,'src/main.ts'),usage.replace(/^.*@ts-expect-error.*\n/gm,''));result=await runTypecheck(root,{installTypePackages:false});assert.equal(result.ok,false);assert.equal(result.errors.length,24,result.raw);
});
test('vendored browser client rejects invalid dynamic list sizes before fetch and preserves valid pages',async t=>{
 const root=fixture(t);writeFileSync(join(root,'src/main.ts'),'export {};');const generated=prepareDeclaredData(root);assert.ok(generated.client);const original=globalThis.fetch;const requests=[];
 try{globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return Response.json({data:[],next:null,has_more:false});};
 const {data,DataError}=await import('data:text/javascript;base64,'+Buffer.from(generated.client.runtime).toString('base64'));
 const paths=[options=>data.notes.list(options),options=>data.notes.relations.comments.list(1,options),options=>data.linked('lnk_'+'1'.repeat(32)).notes.relations.comments.list(1,options)];
 for(const list of paths){for(const limit of [0,-1,1.5,101,200,NaN,Infinity,'100',null]){const before=requests.length;await assert.rejects(list({limit}),error=>error instanceof DataError&&error.status===400&&error.code==='DATA_INPUT_INVALID');assert.equal(requests.length,before);}
 for(const limit of [1,25,100]){await list({limit,after:2});assert.equal(requests.at(-1).limit,limit);assert.equal(requests.at(-1).after,2);}await list();assert.ok(!('limit' in requests.at(-1)));}
 }finally{globalThis.fetch=original;}
});
