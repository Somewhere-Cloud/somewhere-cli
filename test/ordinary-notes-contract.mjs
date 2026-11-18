import assert from 'node:assert/strict';

export async function assertOrdinaryNotesContract(client) {
  // This digest describes the schema's wire contract, independent of the
  // compiler's formatting and the generated runtime implementation.
  assert.equal(client.contract_digest, 'f94004dfa2945b48b99475ea839686f362682d04251cfcf24d7436a4310c6dc7');
  assert.equal(client.manifest.contract_digest, client.contract_digest);
  assert.equal(client.manifest.insert_receipt, undefined);
  const [notes] = client.manifest.tables;
  assert.equal(client.manifest.tables.length, 1);
  assert.equal(notes.name, 'notes');
  assert.equal(notes.owner, 'user_id');
  assert.deepEqual(notes.client, {
    identity: 'authenticated', read: ['id', 'title'], publicRead: false,
    create: ['title'], update: null, delete: false,
  });

  const { data, DataError } = await import('data:text/javascript;base64,' + Buffer.from(client.runtime).toString('base64'));
  const fetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, method: init.method, credentials: init.credentials, body: JSON.parse(init.body) });
      return Response.json({ data: [], has_more: false });
    };
    await assert.rejects(data.notes.list({ limit: 101 }), (error) =>
      error instanceof DataError && error.code === 'DATA_INPUT_INVALID');
    assert.deepEqual(calls, []);
    await data.notes.list({ limit: 100, after: 2 });
    await data.notes.create({ title: 'Fixture' });
    assert.deepEqual(calls, [
      {
        url: '/__sw/data', method: 'POST', credentials: 'same-origin',
        body: { table: 'notes', operation: 'list', contract: client.contract_digest, limit: 100, after: 2 },
      },
      {
        url: '/__sw/data', method: 'POST', credentials: 'same-origin',
        body: { table: 'notes', operation: 'create', contract: client.contract_digest, values: { title: 'Fixture' } },
      },
    ]);
    assert.equal(data.notes.update, undefined);
    assert.equal(data.notes.delete, undefined);
  } finally {
    globalThis.fetch = fetch;
  }
}
