import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Command } from 'commander';

// Execute the source command registration; replace only transport. No credentials or network.
const src = new URL('../src/', import.meta.url).href;
const calls=[];
globalThis.__tasksCall = async (name,args) => { calls.push({name,args}); return globalThis.__tasksResponse; };
const hooks=registerHooks({
  resolve(specifier,context,next) {
    if (specifier.startsWith(src)) return {url:specifier,shortCircuit:true};
    if (context.parentURL?.startsWith(src) && specifier.startsWith('.') && specifier.endsWith('.js')) return {url:new URL(specifier,context.parentURL).href,shortCircuit:true};
    return next(specifier,context);
  },
  load(url,context,next) {
    if (url===src+'lib/platform-tools.js') return {format:'module',source:'export const callPlatformTool=(...args)=>globalThis.__tasksCall(...args);',shortCircuit:true};
    const sourcePath=url.startsWith(src) && url.endsWith('.js') ? fileURLToPath(url).replace(/\.js$/,'.ts') : null;
    if (sourcePath && existsSync(sourcePath)) return {format:'module',source:ts.transpileModule(readFileSync(sourcePath,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText,shortCircuit:true};
    return next(url,context);
  },
});
const { registerTasks }=await import(src+'commands/tasks.js');
async function run(args,response) {
  globalThis.__tasksResponse=response;
  const lines=[], old=console.log; console.log=(...parts)=>lines.push(parts.join(' '));
  try { const program=new Command(); registerTasks(program); await program.parseAsync(['node','sw',...args]); }
  finally { console.log=old; }
  return lines.join('\n');
}
test('task commands preserve explicit pagination and every retrieval option',async()=>{
  const output=await run(['tasks','list','--project','project','--type','decision','--query','vision','--assignee','founder','--label','needs-you','--cursor','opaque','--limit','3'],
    {ok:true,data:[{id:'tsk_1',title:'One',status:'open',priority:'high',updated_at:1,omitted:{description:{json_chars:9000}}}],page:{total:30,count:1,has_more:true,next_cursor:'next',order:'created_at DESC, id DESC',consistency:'ordered membership'}});
  assert.deepEqual(calls.at(-1),{name:'tasks_list',args:{project_id:'project',type:'decision',assignee:'founder',label:'needs-you',q:'vision',limit:3,cursor:'opaque'}});
  assert.match(output,/Showing 1 of 30/); assert.match(output,/--cursor 'next'/); assert.match(output,/Some fields are partial/);
  assert.match(output,/created_at DESC, id DESC/);
  await run(['tasks','get','tsk_1','--project','project','--view','history','--kind','activity','--cursor','history-next','--limit','5'],{ok:true,data:{page:{next_cursor:'later'}}});
  assert.deepEqual(calls.at(-1),{name:'tasks_get',args:{project_id:'project',task_id:'tsk_1',view:'history',kind:'activity',cursor:'history-next',limit:5}});
  await run(['tasks','get','tsk_1','--project','project','--view','field','--kind','comments','--event-id','tcm_1','--field','body','--cursor','field-next'],{ok:true,data:{content:'chunk'}});
  assert.deepEqual(calls.at(-1),{name:'tasks_get',args:{project_id:'project',task_id:'tsk_1',view:'field',kind:'comments',field:'body',event_id:'tcm_1',cursor:'field-next'}});
  const json=await run(['tasks','list','--project','project','--json'],{ok:true,data:[],page:{next_cursor:'visible'}});
  assert.equal(JSON.parse(json).page.next_cursor,'visible');
  await run(['tasks','get','tsk_1','--project','project','--view','full'],{ok:true,data:{comments:['all']}});
  assert.equal(calls.at(-1).args.view,'full');
  assert.equal(calls.length,5,'one tool call per command; no automatic page draining');
});
test('delete, restore and deleted call the task tools with the reason and project',async()=>{
  let output=await run(['tasks','delete','tsk_1','--project','project','--reason','Duplicate'],{ok:true,data:{id:'tsk_1',deleted:true,purge_at:0}});
  assert.deepEqual(calls.at(-1),{name:'tasks_delete',args:{project_id:'project',task_id:'tsk_1',reason:'Duplicate'}});
  assert.match(output,/tsk_1  deleted/); assert.match(output,/somewhere tasks restore tsk_1/);
  output=await run(['tasks','restore','tsk_1','--project','project'],{ok:true,data:{id:'tsk_1',restored:true,not_restored:[{kind:'link:blocks',task_id:'tsk_2',reason:'That task no longer exists.'}]}});
  assert.deepEqual(calls.at(-1),{name:'tasks_restore',args:{project_id:'project',task_id:'tsk_1'}});
  assert.match(output,/Not restored: link:blocks tsk_2/);
  output=await run(['tasks','deleted','--project','project'],{ok:true,data:[{id:'tsk_1',title:'Dup',reason:'Duplicate',purge_at:0}]});
  assert.deepEqual(calls.at(-1),{name:'tasks_restore',args:{project_id:'project'}});
  assert.match(output,/tsk_1/);
});
test.after(()=>{hooks.deregister();delete globalThis.__tasksCall;delete globalThis.__tasksResponse;});

test('waiting for you: the list is the platform’s, an answer is one call, and an ask carries who is waited on', async () => {
  const item = { id: 'tsk_9', project_id: 'proj-1', project_name: 'Bakery', title: 'Create the sign-in app', steps: '1. Open the page.\n2. Press New.', step_list: ['Open the page.', 'Press New.'], sentences: [], why: 'Only the owner can.', kind: 'human', asked_by: { name: 'build-agent', via: { kind: 'terminal', name: 'studio' } }, asked_at: new Date(Date.now() - 7200e3).toISOString() };
  const answered = [{ id: 'tsk_a1', project_id: 'proj-1', project_name: 'Bakery', title: 'Approve the charge', answer: 'done', note: 'Paid.', answered_by: { answer: 'done', via: { kind: 'connector', name: 'Claude' }, at: new Date(Date.now() - 3600e3).toISOString(), you: true } },
    { id: 'tsk_a2', project_id: 'proj-1', project_name: 'Bakery', title: 'Upload a logo', answer: 'cannot', note: null, answered_by: { answer: 'cannot', via: { kind: 'dashboard', name: null }, at: null, you: true } }];
  let output = await run(['tasks', 'waiting'], { ok: true, data: { items: [item], answered, total: 1, more: true, next_cursor: '1', projects_checked: 25, projects_total: 60 } });
  for (const words of ['Answered:', 'tsk_a1', 'Marked done by connector Claude', 'Paid.', 'Marked "can\'t do this" by you, in the dashboard', 'Checked 25 of 60 apps. Show the rest:']) assert.ok(output.includes(words), words + '\n' + output);
  assert.deepEqual(calls.at(-1), { name: 'tasks_list', args: { waiting: 'me' } });
  for (const words of ['tsk_9', 'Create the sign-in app', 'build-agent via studio', 'Bakery', '1. Open the page.', '2. Press New.', 'Why: Only the owner can.', 'tasks answer tsk_9 -p proj-1 --done', 'tasks waiting --cursor 1']) assert.ok(output.includes(words), words + '\n' + output);
  output = await run(['tasks', 'waiting', '--project', 'proj-1', '--cursor', '2'], { ok: true, data: { items: [], total: 0, more: false, next_cursor: null } });
  assert.deepEqual(calls.at(-1), { name: 'tasks_list', args: { waiting: 'me', project_id: 'proj-1', cursor: '2' } });
  assert.match(output, /Nothing is waiting for you\./);
  await run(['tasks', 'answer', 'tsk_9', '--project', 'proj-1', '--done', '--note', 'It is called Bakery sign-in.'], { ok: true, data: { id: 'tsk_9', title: 'Create the sign-in app', status: 'open' } });
  assert.deepEqual(calls.at(-1), { name: 'tasks_update', args: { project_id: 'proj-1', task_id: 'tsk_9', answer: 'done', note: 'It is called Bakery sign-in.' } });
  await run(['tasks', 'answer', 'tsk_9', '--project', 'proj-1', '--cannot'], { ok: true, data: { id: 'tsk_9' } });
  assert.deepEqual(calls.at(-1).args, { project_id: 'proj-1', task_id: 'tsk_9', answer: 'cannot' });
  const before = calls.length; const exit = process.exitCode; const oldError = console.error; console.error = () => {};
  try { await run(['tasks', 'answer', 'tsk_9', '--project', 'proj-1'], {}); await run(['tasks', 'answer', 'tsk_9', '--project', 'proj-1', '--done', '--cannot'], {}); } finally { console.error = oldError; process.exitCode = exit; }
  assert.equal(calls.length, before, 'an answer that says neither or both is not sent');
  await run(['tasks', 'create', 'Add the bank details', '--project', 'proj-1', '--waiting-on', 'human', '--status-note', '1. Open Stripe.\n2. Add the account.', '--author', 'build-agent'], { ok: true, data: { id: 'tsk_10' } });
  assert.deepEqual(calls.at(-1), { name: 'tasks_create', args: { project_id: 'proj-1', title: 'Add the bank details', waiting_on: 'human', status_note: '1. Open Stripe.\n2. Add the account.', author: 'build-agent' } });
  await run(['tasks', 'update', 'tsk_10', '--project', 'proj-1', '--waiting-on', 'product_decision', '--author', 'build-agent'], { ok: true, data: { id: 'tsk_10' } });
  assert.deepEqual(calls.at(-1), { name: 'tasks_update', args: { project_id: 'proj-1', task_id: 'tsk_10', waiting_on: 'product_decision', author: 'build-agent' } });
});
