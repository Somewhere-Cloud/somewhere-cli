#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_PATTERNS } from './credential-patterns.generated.mjs';

// Do not print source, matches, exception messages or subprocess output here.
const fingerprint = value => createHash('sha256').update(value).digest('hex').slice(0, 8);
const ASSIGNMENT = /\b(?:[A-Za-z_$][\w$]*[_$])?(?:password|passwd|pwd|secret|api_?key|access_?token|refresh_?token|auth_?token|signing_?secret|private_?key)['"]?\s*[:=]\s*(['"`])([^\r\n'"`]{8,})\1/gi;
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY))\s*=\s*([^\r\n]+)/gm;
const BEARER = /\bBearer[ \t]+([A-Za-z0-9_.-]{12,})/g;
export function scanText(path, source) {
  const hits = [];
  const add = (index, kind, material) => hits.push({ path, line: source.slice(0, index).split('\n').length, kind, fingerprint: fingerprint(material) });
  for (const rule of SECRET_PATTERNS) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const match of source.matchAll(pattern)) add(match.index, rule.kind, match[0]);
  }
  for (const match of source.matchAll(ASSIGNMENT)) {
    const value = match[2];
    // Expressions, interpolations, type unions and HTML attributes are not literal credentials.
    if (/[\s<>]|\$\{|\\[nrt]|^[|&:]/.test(value)) continue;
    add(match.index, 'credential-literal', value);
  }
  for (const match of source.matchAll(BEARER)) add(match.index, 'bearer-token', match[1]);
  if (/(?:^|\/)\.env(?:[./-]|$)/.test(path)) {
    for (const match of source.matchAll(ENV_ASSIGNMENT)) {
      const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
      if (value && !value.includes('${')) add(match.index, 'environment-credential', value);
    }
  }
  return hits.filter((hit, index) => hits.findIndex(other => other.path === hit.path && other.line === hit.line && other.kind === hit.kind && other.fingerprint === hit.fingerprint) === index);
}
export function scanRepository(root) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64e6 }).split('\0').filter(Boolean);
  const hits = [];
  for (const path of new Set(files)) {
    if (!existsSync(resolve(root, path))) continue;
    const bytes = readFileSync(resolve(root, path));
    if (bytes.includes(0)) continue;
    hits.push(...scanText(path, bytes.toString('utf8')));
  }
  return hits;
}
export function checkCredentials(root) {
  const allow = JSON.parse(readFileSync(resolve(root, 'scripts/credential-allowlist.json'), 'utf8'));
  if (!Array.isArray(allow) || allow.some(entry => !entry.path || !/^[a-f0-9]{8}$/.test(entry.fingerprint) || !entry.reason)) throw new Error('invalid allowlist');
  const findings = scanRepository(root).filter(hit => !allow.some(entry => entry.path === hit.path && entry.fingerprint === hit.fingerprint && entry.kind === hit.kind));
  for (const hit of findings) console.error(`${hit.path}:${hit.line}:${hit.kind}`);
  return findings.length === 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = checkCredentials(resolve(import.meta.dirname, '..')) ? 0 : 1; }
  catch { console.error('credential check failed: scanner or allowlist unavailable'); process.exitCode = 1; }
}
