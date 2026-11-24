// : bare `somewhere docs` prints the topic index (not the
// 18k-line manual), `somewhere docs search <term>` finds sections, and
// : docs warn when they describe a newer CLI than the one running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { renderDocsIndex, parsePublicDocsGroups } from '../dist/commands/docs.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const installed = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

const AUTH_BODY = 'Sign-in overview.\n\n## Magic links\n\nSend a magic link with sw.auth.sendMagicLink(email).\n\n### Expiry\n\nA magic link expires after 15 minutes.\n\n## Passwords\n\nPassword sign-in.\n';
const at = (text) => AUTH_BODY.indexOf(text);
const MANIFEST = {
  version: 1,
  sections: [
    { id: 'primitives', title: 'Primitives', pages: ['sw.auth', 'cron'] },
  ],
  pages: [
    {
      id: 'sw.auth', title: 'Auth — sign-in for your users', section: 'primitives', body: AUTH_BODY,
      sections: [
        { id: 'magic-links', heading: '## Magic links', start: at('## Magic links'), end: at('## Passwords') },
        { id: 'expiry', heading: '### Expiry', start: at('### Expiry'), end: at('## Passwords') },
        { id: 'passwords', heading: '## Passwords', start: at('## Passwords'), end: AUTH_BODY.length },
      ],
    },
    { id: 'cron', title: 'Cron — scheduled triggers', section: 'primitives', body: 'Schedules run in UTC.\n' },
    { id: 'search', title: 'Search — full-text search', section: 'primitives', body: 'Index documents with sw.search.\n' },
  ],
};
const SEARCH_RESULTS = {
  'magic link': [
    { topic: 'sw.auth', title: MANIFEST.pages[0].title, section: 'expiry', heading: 'Expiry',
      content: 'A magic link expires after 15 minutes.', complete: true },
    { topic: 'sw.auth', title: MANIFEST.pages[0].title, section: 'magic-links', heading: 'Magic links',
      content: 'Send a magic link with sw.auth.sendMagicLink(email).', complete: true },
  ],
  UTC: [{ topic: 'cron', title: MANIFEST.pages[1].title, section: null, heading: null,
    content: 'Schedules run in UTC.', complete: true }],
};

function run(args, env = {}) {
  return new Promise((resolvePromise) => {
    const home = mkdtempSync(join(tmpdir(), 'sw-docs-index-home-'));
    const child = spawn(process.execPath, [distIndex, ...args], {
      env: { ...process.env, HOME: home, SOMEWHERE_CONFIG_DIR: join(home, '.somewhere'), CI: '1', NO_COLOR: '1', SOMEWHERE_NO_NOTIFICATIONS: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

async function withServer(fn) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/docs-manifest.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(MANIFEST));
      return;
    }
    if (url.pathname === '/docs-search.json') {
      const topic = url.searchParams.get('topic');
      const results = (SEARCH_RESULTS[url.searchParams.get('q')] ?? []).filter(match => !topic || match.topic === topic);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ results, total: results.length }));
      return;
    }
    res.statusCode = 404;
    res.end('missing');
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

test('bare docs prints the grouped topic index and how to open, never the manual', async () => {
  await withServer(async (base, requests) => {
    const result = await run(['docs'], { SOMEWHERE_DOCS_BASE: base });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(requests, ['/docs-manifest.json'], 'the full manual (/docs.txt) is not fetched');
    assert.match(result.stdout.slice(0, 1100), /Run somewhere init --name my-app.*AGENTS\.md/);
    assert.match(result.stdout.slice(0, 1100), /Own rows \| owner\(\)/);
    assert.match(result.stdout.slice(0, 1100), /Team: owner invites members.*group\(\).*sw\.groups/);
    assert.match(result.stdout.slice(0, 1100), /Owner\/staff record.*parent\(\)/);
    assert.match(result.stdout, /Primitives\n {2}sw\.auth\s+Auth — sign-in for your users/);
    assert.match(result.stdout, /Open a section: {3}somewhere docs <topic> --section <id>/);
    assert.match(result.stdout, /Search all docs: {2}somewhere docs --search "<words>"/);
    assert.match(result.stdout, /Full manual: +somewhere docs --full/);
  });
});

test('docs search returns topic, section id, snippet and the command that opens it', async () => {
  await withServer(async (base, requests) => {
    const result = await run(['docs', 'search', 'magic', 'link', '--json'], { SOMEWHERE_DOCS_BASE: base });
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.query, 'magic link');
    assert.ok(body.count >= 2);
    assert.deepEqual(body.results.map(({ topic, section }) => `${topic}#${section}`).sort(), ['sw.auth#expiry', 'sw.auth#magic-links']);
    const expiry = body.results.find((r) => r.section === 'expiry');
    assert.match(expiry.snippet, /expires after 15 minutes/);
    assert.equal(expiry.open, 'somewhere docs sw.auth --section expiry');

    const text = await run(['docs', 'search', 'UTC'], { SOMEWHERE_DOCS_BASE: base });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^cron {2}Cron — scheduled triggers\n\nSchedules run in UTC\.\n\nsomewhere docs cron --full/m);

    const none = await run(['docs', 'search', 'zebra'], { SOMEWHERE_DOCS_BASE: base });
    assert.equal(none.status, 0);
    assert.match(none.stdout, /No docs sections match "zebra"/);
    const blank = await run(['docs', '--search', '   '], { SOMEWHERE_DOCS_BASE: base });
    assert.equal(blank.status, 1);
    assert.match(blank.stderr, /Enter search words/);
    assert.deepEqual(requests, ['/docs-search.json?q=magic+link', '/docs-search.json?q=UTC', '/docs-search.json?q=zebra']);
  });
});

test('`docs search` with no term still opens the search topic; trailing terms search within a topic', async () => {
  await withServer(async (base, requests) => {
    const topic = await run(['docs', 'search'], { SOMEWHERE_DOCS_BASE: base });
    assert.equal(topic.status, 0, topic.stderr);
    assert.match(topic.stdout, /Index documents with sw\.search/);
    const stray = await run(['docs', 'sw.auth', 'extra'], { SOMEWHERE_DOCS_BASE: base });
    assert.equal(stray.status, 0);
    assert.match(stray.stdout, /No docs sections in sw\.auth match "extra"/);
    const scoped = await run(['docs', 'sw.auth', 'magic', 'link', '--json'], { SOMEWHERE_DOCS_BASE: base });
    assert.equal(scoped.status, 0, scoped.stderr);
    const body = JSON.parse(scoped.stdout);
    assert.equal(body.topic, 'sw.auth');
    assert.deepEqual(body.results.map(result => result.topic), ['sw.auth', 'sw.auth']);
    assert.deepEqual(requests, ['/docs-manifest.json', '/docs-search.json?q=extra&topic=sw.auth', '/docs-search.json?q=magic+link&topic=sw.auth']);
  });
});

test('docs warn when they describe a newer minor CLI, and stay quiet for a patch gap', async () => {
  const [major, minor, patch] = installed.split('.').map(Number);
  await withServer(async (base) => {
    for (const [latest, warns] of [[`${major}.${minor + 1}.0`, true], [`${major}.${minor}.${patch + 1}`, false]]) {
      const home = mkdtempSync(join(tmpdir(), 'sw-docs-version-home-'));
      mkdirSync(join(home, '.somewhere'), { recursive: true });
      writeFileSync(join(home, '.somewhere', 'update-check.json'), JSON.stringify({ checkedAt: Date.now(), latest }));
      const result = await run(['docs', '--list'], {
        SOMEWHERE_DOCS_BASE: base, HOME: home, SOMEWHERE_CONFIG_DIR: join(home, '.somewhere'), SOMEWHERE_NO_NOTIFICATIONS: '', CI: '',
      });
      assert.equal(result.status, 0, result.stderr);
      if (warns) {
        assert.match(result.stderr, new RegExp(`These docs describe somewhere CLI ${latest.replace(/\./g, '\\.')}; this CLI is ${installed.replace(/\./g, '\\.')}`));
        assert.match(result.stderr, /npm i -g @somewhere-cloud\/cli@latest/);
      } else {
        assert.doesNotMatch(result.stderr, /These docs describe/);
      }
    }
  });
});

test('ungrouped manifests still list every topic', () => {
  const pages = MANIFEST.pages;
  const index = renderDocsIndex(pages, parsePublicDocsGroups({}));
  assert.match(index, /Topics\n {2}sw\.auth/);
  assert.match(index, / {2}search +Search — full-text search/);
});

test('root and init help lead new apps to the generated contract', async () => {
  const root = await run(['--help']);
  assert.equal(root.status, 0, root.stderr);
  assert.match(root.stdout, /Run somewhere init first/);
  assert.match(root.stdout.replace(/\s+/g, ' '), /AGENTS\.md.*call shapes and access patterns.*docs are for exceptions/);

  const init = await run(['init', '--help']);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /Write a starter app with a generated AGENTS\.md guide/);
  assert.match(init.stdout, /Ask before destructive or paid actions unless the user already authorized them/);
  assert.match(init.stdout, /run `somewhere init` in an empty directory/);
  assert.match(init.stdout.replace(/\s+/g, ' '), /Init installs React, the SDK and editor types\. The platform builds your source when you deploy\./);
  assert.match(init.stdout, /existing AGENTS\.md\/CLAUDE\.md are never replaced/);
});
