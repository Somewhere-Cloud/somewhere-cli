import {test,mock} from 'node:test';import assert from 'node:assert/strict';
import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';import {EventEmitter} from 'node:events';
import {testAddressOrder} from '../dist/lib/test-connectivity.js';import {safeError} from '../dist/lib/test-diagnostics.js';
test('short probes are advisory, including both failures',async()=>{
 for(const [v6,v4,expected] of [[false,false,false],[false,true,true],[true,true,false],[true,false,false]]){
  const fn=mock.method(net,'connect',({family})=>{const socket=new EventEmitter();socket.destroy=()=>{};queueMicrotask(()=>socket.emit((family===6?v6:v4)?'connect':'error',new Error('probe failed')));return socket;});syncBuiltinESMExports();
  try{assert.equal(await testAddressOrder('https://example.com'),expected);}finally{fn.mock.restore();syncBuiltinESMExports();}
 }
});
test('safe categories survive fixture then reporter classification',()=>{for(const input of ['expect(value).toBe(other) secret','Cannot find module secret','SyntaxError: secret','test.only secret','Timeout secret']){const label=safeError(input);assert.equal(safeError(label),label);assert.ok(!label.includes('secret'));}});
