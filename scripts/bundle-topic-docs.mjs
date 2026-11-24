import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { assertPublicArtifact } from './public-projection.mjs';

const snapshotFile = new URL('../docs/topics.generated.json', import.meta.url);
const output = new URL('../dist/docs/', import.meta.url);

// Refresh from the generated public platform manifest at an exact source revision.
// Check in the generated snapshot so the CLI build works without platform access.
const [platformRoot, ref = 'HEAD'] = process.argv.slice(2);
if (platformRoot) {
  const git = (...args) => execFileSync('git', ['-C', platformRoot, ...args], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).trim();
  const commit = git('rev-parse', '--verify', ref + '^{commit}');
  const source = git('show', commit + ':web/src/docs-manifest.ts');
  const literal = /^export const DOCS_MANIFEST_JSON = (.+);$/m.exec(source)?.[1];
  if (!literal) throw new Error('Platform docs manifest is missing its public JSON export.');
  const { pages } = JSON.parse(JSON.parse(literal));
  const snapshot = { source_commit: commit, pages: pages.map(({ id, title, body }) => ({ id, title, body })) };
  const json = JSON.stringify(snapshot, null, 2) + '\n';
  assertPublicArtifact(json, 'docs/topics.generated.json');
  writeFileSync(snapshotFile, json);
}

const { pages } = JSON.parse(readFileSync(snapshotFile, 'utf8'));
mkdirSync(output, { recursive: true });
for (const { id, title, body } of pages) {
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(id)) throw new Error('Invalid topic ID: ' + id);
  const markdown = '# ' + title + '\n\n' + body.trimEnd() + '\n';
  assertPublicArtifact(markdown, id + '.md');
  writeFileSync(new URL(id + '.md', output), markdown);
}
