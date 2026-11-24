// Deploy the exact release tarball with disposable credentials. Only safe
// status fields are printed: full deploy JSON contains the private claim link.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const [packageSpec, ...flags] = process.argv.slice(2);
if (!packageSpec) throw new Error('Pass the packed CLI tarball or exact npm package version.');
const root = mkdtempSync(join(tmpdir(), 'somewhere-live-starter-'));
const buildProof = flags.includes('--browser');
const nameSeed = randomBytes(3).toString('hex');
const registry = 'https://registry.npmjs.org/';
const candidateTarball = packageSpec.endsWith('.tgz') ? resolve(packageSpec) : null;
const npmShim = join(root, 'starter-bin');
if (candidateTarball) {
  mkdirSync(npmShim);
  // A generated starter pins the CLI version it imports. Before publication,
  // install that exact local artifact without changing the starter manifest.
  writeFileSync(join(npmShim, 'npm'),
    '#!/bin/sh\nPATH="$STARTER_NPM_PATH" exec npm "$@" --no-save "$STARTER_CLI_TARBALL"\n',
    { mode: 0o700 });
}

function run(label, command, args, cwd, env) {
  console.log(label);
  const start = performance.now();
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 240_000);
    const progress = setInterval(() => console.log(label + ' still running after ' + Math.round((performance.now() - start) / 1000) + 's'), 10_000);
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', () => reject(new Error(label + ' could not start')));
    child.once('close', code => {
      clearTimeout(timeout);
      clearInterval(progress);
      const ms = Math.round(performance.now() - start);
      const lines = stdout.trim().split('\n');
      let result;
      try { result = JSON.parse(stdout); } catch {
        try { result = JSON.parse(lines.slice(1).join('\n')); } catch { /* Non-JSON commands. */ }
      }
      if (code !== 0) {
        const typed = typeof result?.error === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(result.error) ? ' [' + result.error + ']' : '';
        const request = typeof result?.request_id === 'string' && /^[a-f0-9]{8,64}$/i.test(result.request_id) ? ' request ' + result.request_id : '';
        reject(new Error(label + (timedOut ? ' reached its time limit' : ' exited ' + code) + typed + request + ' after ' + ms + ' ms'));
        return;
      }
      resolveResult({ ms, result, stdout, stderr });
    });
  });
}

function testEnv(template) {
  const home = join(root, template + '-home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: root, TMP: root, TEMP: root,
    SOMEWHERE_CONFIG_DIR: join(home, '.somewhere'), npm_config_cache: join(home, 'npm-cache'),
    npm_config_registry: registry, SOMEWHERE_NO_NOTIFICATIONS: '1', SOMEWHERE_NO_UPDATE_CHECK: '1',
    SOMEWHERE_NO_BROWSER: '1', CI: '1', NO_COLOR: '1',
  };
}

async function checkHttp(template, url) {
  const page = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  assert.ok(page.ok && /text\/html/i.test(page.headers.get('content-type') ?? ''), template + ' did not return a live HTML page');
  const html = await page.text();
  if (template === 'bare') assert.match(html, /Bare release fixture/, 'bare did not serve its fixture page');
  else assert.match(html, /<script\b/, template + ' did not serve its compiled entry point');
  if (template === 'minimal') {
    const auth = await fetch(new URL('/api/auth/me', url), { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    assert.ok(auth.status === 401 || auth.ok, 'minimal did not serve its signed-out auth endpoint');
    assert.match(auth.headers.get('content-type') ?? '', /json/, 'minimal auth endpoint did not return JSON');
  }
}

let browser;
try {
  const install = join(root, 'install');
  mkdirSync(install);
  await run('Install exact CLI package', 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
    candidateTarball ?? packageSpec], install, testEnv('install'));
  const cli = join(install, 'node_modules', '@somewhere-cloud', 'cli', 'bin', 'somewhere.js');
  const { stdout } = await run('Read installed version', process.execPath, [cli, '--version'], install, testEnv('install'));
  console.log('Testing installed CLI ' + stdout.trim());
  if (buildProof) {
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch({ channel: 'chrome' });
  }
  const minimalEnv = testEnv('minimal');
  for (const template of ['default', 'minimal', 'bare']) {
    const cwd = join(root, template + '-fixture');
    const env = template === 'default' ? testEnv('default') : minimalEnv;
    mkdirSync(cwd);
    const name = 'swtest-cli-' + template.slice(0, 3) + '-' + nameSeed;
    // Bare only links a project. Use the temporary credential the minimal
    // deploy just minted, and supply a static page for the deploy.
    const initEnv = candidateTarball ? {
      ...env, PATH: npmShim + delimiter + env.PATH,
      STARTER_NPM_PATH: env.PATH, STARTER_CLI_TARBALL: candidateTarball,
    } : env;
    const init = await run(template + ' init', process.execPath, [cli, 'init', '--name', name, '--json',
      ...(template === 'default' ? [] : ['--template', template])], cwd, initEnv);
    if (template === 'bare') {
      assert.ok(!existsSync(join(cwd, 'node_modules')) && !existsSync(join(cwd, 'package.json')), 'bare must leave the folder free of dependencies and starter source');
      writeFileSync(join(cwd, 'index.html'), '<!doctype html><title>Bare release fixture</title><h1>Bare release fixture</h1>');
    } else {
      assert.ok(init.result?.local && !init.result?.linked && init.result?.name === name, template + ' init did not run signed out');
      assert.ok(!existsSync(join(env.SOMEWHERE_CONFIG_DIR, 'config.json')), 'init created a login');
    }
    const deploy = await run(template + ' first deploy', process.execPath, [cli, 'deploy', '--json'], cwd, env);
    const url = new URL(deploy.result?.url);
    assert.ok(url.protocol === 'https:' && url.hostname.startsWith(name + '-') &&
      (url.hostname.endsWith('.somewhere.site') || url.hostname.endsWith('.somewhere.cloud')), 'deploy returned an unexpected fixture URL');
    assert.ok(deploy.result?.release_id && Date.parse(deploy.result?.expires_at) > Date.now(), 'deploy did not confirm a live temporary release and expiry');
    const bytes = [join(cwd,'node_modules','typescript'),join(cwd,'node_modules','react')].map(existsSync);
    await checkHttp(template, url);
    if (browser) {
      const page = await browser.newPage();
      try {
        await page.goto(url.href, { waitUntil: 'domcontentloaded' });
        if (template === 'default') await page.locator('[data-sw-auth="sign-in"]').waitFor({ state: 'visible', timeout: 30_000 });
        else if (template === 'minimal') await page.getByRole('heading', { name: 'Start with a working full-stack app.' }).waitFor({ state: 'visible', timeout: 30_000 });
        else await page.getByRole('heading', { name: 'Bare release fixture' }).waitFor({ state: 'visible', timeout: 30_000 });
      } finally { await page.close(); }
    }
    console.log(JSON.stringify({template, initMs:init.ms, deployMs:deploy.ms, live:true, browser:buildProof, localTypeScript:bytes[0], localReact:bytes[1]}));
  }
} catch (error) {
  // Browser and invalid URL errors may carry full response strings. Only
  // errors deliberately constructed by this script or the stage timings above
  // are needed to debug the release.
  console.error(error instanceof assert.AssertionError ? error.message
    : /^(?:Install exact CLI package|Read installed version|(?:default|minimal|bare) (?:init|first deploy)) /.test(error?.message ?? '') ? error.message
    : 'The live starter check could not confirm the published page.');
  process.exitCode = 1;
} finally {
  await browser?.close();
  rmSync(root, { recursive: true, force: true });
}
