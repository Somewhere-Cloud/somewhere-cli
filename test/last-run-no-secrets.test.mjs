import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// last-run.json keeps the registered command path, the names of the options
// given, the exit code and the time; never operand or option values, request
// bodies or command output (pfb_04b5a285eed0). Sentinels match no secret
// pattern on purpose: nothing is kept because nothing free-form is recorded.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const RESPONSE_SECRET = 'rsp7-plainvalue-QW93';
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: { echoed: RESPONSE_SECRET, rows: [{ value: RESPONSE_SECRET }], columns: ['value'] } }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());

function run(args) {
  const base = mkdtempSync(join(tmpdir(), 'sw-last-run-'));
  const config = join(base, 'config'), app = join(base, 'app');
  mkdirSync(config); mkdirSync(app);
  writeFileSync(join(config, 'config.json'), JSON.stringify({ token: 'smt_fixture', user: { email: 'dev@example.test', username: 'dev' } }));
  writeFileSync(join(app, '.somewhere.json'), JSON.stringify({ project_id: 'proj_fixture', name: 'Fixture', subdomain: 'fixture' }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_API_URL: `${url}/v1`, SOMEWHERE_MCP_URL: `${url}/mcp`,
      SOMEWHERE_RUNNER_URL: url, SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => stdout += v); child.stderr.on('data', (v) => stderr += v);
    child.on('close', (status) => {
      const path = join(config, 'last-run.json');
      resolve({ status, stdout, stderr, raw: readFileSync(path, 'utf8'), record: JSON.parse(readFileSync(path, 'utf8')), mode: statSync(path).mode & 0o777 });
    });
  });
}

for (const [label, args, secret, expected] of [
  ['env set positional value', ['env', 'set', 'DB_PASSWORD', 'env7-plainvalue-ZK41', '--project', 'proj_fixture'], 'env7-plainvalue-ZK41', { command: 'env set', options: ['--project'] }],
  ['db query SQL', ['db', 'query', "UPDATE users SET pw = 'sql7-plainvalue-MM20' WHERE id = 1", '--project', 'proj_fixture'], 'sql7-plainvalue-MM20', { command: 'db query', options: ['--project'] }],
  ['call JSON arguments', ['call', 'env_set', '{"key":"K","value":"call7-plainvalue-PX55"}'], 'call7-plainvalue-PX55', { command: 'call', options: [] }],
  ['api request body', ['api', 'POST', '/env', '-d', '{"value":"api7-plainvalue-TT03"}'], 'api7-plainvalue-TT03', { command: 'api', options: ['--data'] }],
  ['api inline option value', ['api', 'POST', '/env', '--data={"value":"api8-plainvalue-TT04"}'], 'api8-plainvalue-TT04', { command: 'api', options: ['--data'] }],
]) {
  test(`${label}: last-run.json keeps the command and option names, never the value or output`, async () => {
    const result = await run(args);
    assert.equal(result.mode, 0o600);
    assert.doesNotMatch(result.raw, new RegExp(secret));
    assert.doesNotMatch(result.raw, new RegExp(RESPONSE_SECRET));
    assert.deepEqual(Object.keys(result.record).sort(), ['cli_version', 'command', 'exit_code', 'options', 'timestamp']);
    assert.equal(result.record.command, expected.command);
    assert.deepEqual(result.record.options, expected.options);
    assert.equal(result.record.exit_code, result.status);
  });
}

test('a response printed by the command is not recorded, while the command still shows', async () => {
  const result = await run(['api', 'GET', '/projects']);
  assert.match(result.stdout, new RegExp(RESPONSE_SECRET), 'the command printed the response');
  assert.doesNotMatch(result.raw, new RegExp(RESPONSE_SECRET));
  assert.equal(result.record.command, 'api');
  assert.equal(result.record.exit_code, 0);
});

test('env set with a positional value points to --stdin; --stdin gets no note', async () => {
  const positional = await run(['env', 'set', 'DB_PASSWORD', 'env9-plainvalue-QQ11', '--project', 'proj_fixture']);
  assert.match(positional.stderr, /can be seen in your shell history and the process list.*somewhere env set DB_PASSWORD --stdin/);
  const json = await run(['env', 'set', 'DB_PASSWORD', 'env9-plainvalue-QQ12', '--project', 'proj_fixture', '--json']);
  // env set --json reports the note inside its JSON result instead of on stderr.
  assert.doesNotMatch(json.stderr, /shell history/);
  assert.match(JSON.parse(json.stdout).input_note, /somewhere env set DB_PASSWORD --stdin/);
});

test('a usage error records no command and no options', async () => {
  const result = await run(['no-such-command', 'arg7-plainvalue-UU55']);
  assert.equal(result.record.command, '');
  assert.deepEqual(result.record.options, []);
  assert.doesNotMatch(result.raw, /arg7-plainvalue-UU55|no-such-command/);
});
