// tsk_81dd50f0 (friction sweep F1): `somewhere call <tool> --file <path>` reads the
// JSON arguments object from a file, so a large project_patch `edits` array never
// has to fit on a command line. Inline JSON and --file are exclusive; every local
// refusal says the tool was not called and sends nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

test('call --file sends the file\'s arguments object unchanged; bad input is refused locally', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'sw-call-file-'));
  const config = join(scratch, 'config');
  const app = join(scratch, 'app');
  mkdirSync(config);
  mkdirSync(app);
  writeFileSync(join(config, 'config.json'), JSON.stringify({ token: 'smt_call_file_fixture' }));
  const calls = [];
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const rpc = JSON.parse(body);
      let result = {};
      if (rpc.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
      if (rpc.method === 'tools/list') result = { tools: [{ name: 'project_patch', inputSchema: { type: 'object', properties: { project_id: { type: 'string' } } } }] };
      if (rpc.method === 'tools/call') {
        calls.push(rpc.params);
        result = { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { version: 2 } }) }] };
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', ...(rpc.id !== undefined ? { id: rpc.id } : {}), result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_MCP_URL: `${base}/mcp`, SOMEWHERE_API_URL: `${base}/v1`, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' };
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: app, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  try {
    // A large argument object: 150 edits with multi-line, quote- and shell-hostile text.
    const edits = Array.from({ length: 150 }, (_, i) => ({
      path: i % 2 ? 'src/App.tsx' : 'styles.css',
      find: `line ${i} "quoted" $HOME \`tick\`\n  next`,
      replace: `LINE ${i} 'single' é ✓\n`,
      ...(i === 0 ? { expect: 1 } : {}),
    }));
    const args = { project_id: 'fixture-project', base_release_id: 'rel_1', edits };
    const file = join(scratch, 'edits.json');
    writeFileSync(file, JSON.stringify(args, null, 2));

    await t.test('the file contents arrive as the tool arguments, byte for byte', async () => {
      const result = await run(['call', 'project_patch', '--file', file, '--json']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].name, 'project_patch');
      assert.deepEqual(calls[0].arguments, args);
      assert.equal(JSON.parse(result.stdout).data.version, 2);
    });

    const bad = join(scratch, 'bad.json');
    writeFileSync(bad, '{ "edits": [ ');
    const arr = join(scratch, 'array.json');
    writeFileSync(arr, '[1, 2]');
    const cases = [
      { args: ['call', 'project_patch', '{"project_id":"x"}', '--file', file], message: /inline or with --file, not both/ },
      { args: ['call', 'project_patch', '--file', join(scratch, 'missing.json')], message: /Could not read --file .*missing\.json \(ENOENT\)/ },
      { args: ['call', 'project_patch', '--file', bad], message: /bad\.json must be valid JSON/ },
      { args: ['call', 'project_patch', '--file', arr], message: /array\.json must be a JSON object/ },
      { args: ['call', '--list', '--file', file], message: /without a tool name or JSON arguments/ },
    ];
    for (const entry of cases) {
      await t.test(entry.args.slice(1).join(' '), async () => {
        const before = requests;
        const result = await run([...entry.args, '--json']);
        assert.equal(result.status, 1);
        const out = JSON.parse(result.stdout);
        assert.match(out.message, entry.message);
        assert.match(out.message, /The requested tool was not called\./);
        assert.equal(requests, before, 'refused locally, nothing sent');
      });
    }
    assert.equal(calls.length, 1);

    await t.test('help names the option', async () => {
      const result = await run(['call', '--help']);
      assert.match(result.stdout, /--file <path>/);
      assert.match(result.stdout, /somewhere call project_patch --file edits\.json/);
    });
  } finally {
    server.close();
  }
});
