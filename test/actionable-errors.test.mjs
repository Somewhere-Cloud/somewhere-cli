import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticHints } from '../dist/lib/typecheck.js';
import { formatErrorDetail } from '../dist/commands/errors.js';

test('schema-specific transaction diagnostics show the array fix', () => {
  assert.match(diagnosticHints("Argument of type '() => Promise<void>' is not assignable to parameter of type 'readonly __SomewhereDbIntentFor<\"notes\", \"serverInsert\", \"serverSet\">[]'.").join('\n'), /tx\(\[.*never a callback/);
  assert.deepEqual(diagnosticHints('SCHEMA_DECLARATION_INVALID client.read must include primary key "id"'), []);
});

test('error rows preserve real messages and give actionable code-only platform guidance', () => {
  assert.match(formatErrorDetail('ORIGIN_REQUIRED', 'ORIGIN_REQUIRED'), /Origin header equal to the app URL.*POST\/PATCH\/DELETE/);
  assert.match(formatErrorDetail('RATE_LIMIT_UNAVAILABLE', 'RATE_LIMIT_UNAVAILABLE'), /not admitted.*Retry.*do not remove rateLimit/);
  assert.equal(formatErrorDetail('AUTH_ERROR', 'Email already exists'), 'AUTH_ERROR: Email already exists');
  assert.doesNotMatch(formatErrorDetail('AUTH_ERROR', 'AUTH_ERROR'), /AUTH_ERROR: AUTH_ERROR/);
});
