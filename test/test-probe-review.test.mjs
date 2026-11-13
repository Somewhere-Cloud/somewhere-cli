import {test,mock} from 'node:test';import assert from 'node:assert/strict';
import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';import {EventEmitter} from 'node:events';
import {testAddressOrder} from '../dist/lib/test-connectivity.js';import {describeError} from '../dist/lib/test-diagnostics.js';
test('short probes are advisory, including both failures',async()=>{
 for(const [v6,v4,expected] of [[false,false,false],[false,true,true],[true,true,false],[true,false,false]]){
  const fn=mock.method(net,'connect',({family})=>{const socket=new EventEmitter();socket.destroy=()=>{};queueMicrotask(()=>socket.emit((family===6?v6:v4)?'connect':'error',new Error('probe failed')));return socket;});syncBuiltinESMExports();
  try{assert.equal(await testAddressOrder('https://example.com'),expected);}finally{fn.mock.restore();syncBuiltinESMExports();}
 }
});
test('failure text keeps the assertion and location but not credentials',()=>{const text=describeError({message:'\u001b[31mexpect(received).toBe(expected)\nExpected: 403\nReceived: 404 smt_abcdef123456 https://app.example/reset/tok?token=tok',location:{file:process.cwd()+'/tests/a.spec.ts',line:7}});assert.match(text,/^tests\/a\.spec\.ts:7: expect\(received\)\.toBe\(expected\)\nExpected: 403\nReceived: 404 /);assert.ok(!text.includes('smt_abcdef'));assert.ok(!text.includes('tok'));});
