import test from 'node:test';
import assert from 'node:assert/strict';

// expectRefused must not report a refusal for someone who was allowed. An empty list, a null get
// and a 404 look exactly like an empty table, a missing row or a missing route, so they count only
// with a positive control: { allowed } for whom the same request succeeds. Malformed requests and
// stale contracts never count. Offline: stand-in request clients answer like the platform.
const { expectRefused, _fixtureClientForTests } = await import('../dist/lib/playwright-fixtures.js');

const res = (status, body) => ({ status: () => status, json: async () => body });
/** A client whose answers come from `rows` (table -> id -> row) as one person sees them. */
function person({ rows = {}, endpoint = () => res(404, { error: 'NOT_FOUND' }), writes = 'allow' } = {}) {
  const answer = ({ table, operation, id, values }) => {
    if (!(table in rows)) return res(403, { error: 'DATA_ACCESS_DENIED' });
    const visible = rows[table];
    if (operation === 'list') return res(200, { data: Object.values(visible) });
    if (operation === 'get') return res(200, { data: visible[id] ? { ...visible[id] } : null });
    if (operation === 'update' || operation === 'delete') {
      if (!(id in visible)) return res(404, { error: 'DATA_NOT_FOUND', message: 'Record not found.' });
      if (writes !== 'allow') return res(403, { error: 'DATA_ACCESS_DENIED' });
      if (operation === 'delete') delete visible[id]; else Object.assign(visible[id], values);
      return res(200, { data: visible[id] ?? { id } });
    }
    return res(403, { error: 'DATA_ACCESS_DENIED' });
  };
  const client = {
    post: async (path, options) => path === '/__sw/data' ? answer(options.data) : endpoint(path, options),
    fetch: async (path, options) => endpoint(path, options),
  };
  return _fixtureClientForTests(client, 'digest');
}
const refused = (...args) => expectRefused(...args);

// ---- Astra's false positives: each passed as a refusal on 0.38.83 -----------------------------
test('an allowed list of an empty table is not a refusal', async () => {
  const staff = person({ rows: { notes: {} } });
  await assert.rejects(refused(staff, 'notes', { operation: 'list' }), /proves nothing on its own/);
  await assert.rejects(refused(staff, 'notes', { operation: 'list' }, { allowed: staff }), /allowed person got nothing/);
});
test('an allowed list filtered to nothing is not a refusal', async () => {
  const staff = person({ rows: { notes: {} } });
  await assert.rejects(refused(staff, 'notes', { operation: 'list', where: { title: 'none' } }), /proves nothing on its own/);
});
test('an allowed get of a missing id is not a refusal', async () => {
  const staff = person({ rows: { notes: { n1: { id: 'n1' } } } });
  await assert.rejects(refused(staff, 'notes', { operation: 'get', id: 'missing' }), /proves nothing on its own/);
  await assert.rejects(refused(staff, 'notes', { operation: 'get', id: 'missing' }, { allowed: staff }), /allowed person got nothing/);
});
test('an update or delete of a missing id is not a refusal', async () => {
  const staff = person({ rows: { notes: {} } });
  await assert.rejects(refused(staff, 'notes', { operation: 'update', id: 'gone', values: { title: 'x' } }), /a 404 looks the same/);
  await assert.rejects(refused(staff, 'notes', { operation: 'delete', id: 'gone' }), /a 404 looks the same/);
  await assert.rejects(refused(staff, 'notes', { operation: 'delete', id: 'gone' }, { allowed: staff }), /does not exist for the allowed person/);
});
test('a misspelled endpoint (404 for everyone) is not a refusal', async () => {
  const anyone = person({ rows: {} });
  await assert.rejects(refused(anyone, 'POST /api/asign', { ticketId: 't1' }), /a 404 looks the same/);
  await assert.rejects(refused(anyone, 'POST /api/asign', { ticketId: 't1' }, { allowed: anyone }), /allowed person got HTTP 404/);
});

// ---- malformed requests and stale contracts never count, and say which they were -----------------
test('a malformed request or a stale contract fails and names which', async () => {
  const bad = _fixtureClientForTests({ post: async () => res(400, { error: 'DATA_INPUT_INVALID', message: 'values contains unsupported field nope.' }) }, 'd');
  await assert.rejects(refused(bad, 'notes', { operation: 'update', id: 'n1', values: { nope: 1 } }), /a malformed request \(400 DATA_INPUT_INVALID: values contains unsupported field nope\.\)/);
  const stale = _fixtureClientForTests({ post: async () => res(409, { error: 'DATA_CONTRACT_MISMATCH', message: 'The app data contract changed.' }) }, 'd');
  await assert.rejects(refused(stale, 'notes', { operation: 'get', id: 'n1' }), /a stale data contract \(409 DATA_CONTRACT_MISMATCH/);
});

// ---- real refusals pass ---------------------------------------------------------------------------
test('a hidden row, list and write are refused when the allowed person proves the row exists', async () => {
  const note = { id: 'n1', body: 'internal' };
  const staff = person({ rows: { notes: { n1: { ...note } } } });
  const customer = person({ rows: { notes: {} } });
  await refused(customer, 'notes', { operation: 'get', id: 'n1' }, { allowed: staff });
  await refused(customer, 'notes', { operation: 'list' }, { allowed: staff });
  await refused(customer, 'notes', { operation: 'update', id: 'n1', values: { body: 'x' } }, { allowed: staff });
  await refused(customer, 'notes', { operation: 'delete', id: 'n1' }, { allowed: staff });
});
test('401 and 403 count without a control; an endpoint 403 too', async () => {
  const customer = person({ endpoint: () => res(403, { error: 'STAFF_ONLY' }) });
  await refused(customer, 'audit', { operation: 'list' });
  await refused(customer, 'POST /api/assign', { ticketId: 't1' });
});
test('an endpoint 404 counts when the allowed person succeeds at the same call', async () => {
  const customer = person({ endpoint: () => res(404, { error: 'NOT_FOUND' }) });
  const staff = person({ endpoint: () => res(200, { ok: true }) });
  await refused(customer, 'POST /api/tickets/t1/close', {}, { allowed: staff });
});
test('a write that changed the row is not a refusal even if it answered 403', async () => {
  const shared = { n1: { id: 'n1', body: 'before' } };
  const staff = person({ rows: { notes: shared } });
  const sneaky = _fixtureClientForTests({ post: async (_p, o) => { shared.n1.body = 'after'; void o; return res(403, { error: 'DATA_ACCESS_DENIED' }); } }, 'd');
  await assert.rejects(refused(sneaky, 'notes', { operation: 'update', id: 'n1', values: { body: 'after' } }, { allowed: staff }), /changed for the allowed person/);
});
test('reading rows is not a refusal', async () => {
  const staff = person({ rows: { notes: { n1: { id: 'n1' } } } });
  await assert.rejects(refused(staff, 'notes', { operation: 'list' }), /this person read 1 row/);
  await assert.rejects(refused(staff, 'notes', { operation: 'get', id: 'n1' }), /this person read the row/);
});
