import test from 'node:test';
import assert from 'node:assert/strict';
import { publicProjection } from '../scripts/public-projection.mjs';

test('projection removes comments and generated tracking markers without changing exports', async () => {
  const marker = ['tsk', '0123456789abcdef'].join('_');
  const text = `// Owner and source discussion\nexport const value = 7;\nexport const declaration = \`// Note (${marker})\ninterface Example {}\`;\n`;
  const result = publicProjection(text);
  assert.doesNotMatch(result, /Owner|0123456789abcdef/);
  assert.equal(publicProjection(result), result);
  const module = await import('data:text/javascript;base64,' + Buffer.from(result).toString('base64'));
  assert.equal(module.value, 7);
  assert.match(module.declaration, /interface Example/);
});
