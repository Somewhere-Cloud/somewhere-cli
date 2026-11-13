import { posix } from 'node:path';

const ROOT_FOLDERS = new Set(['scripts', 'fixtures', 'e2e', 'tooling', 'tools', 'design-v2', 'build', 'out', 'storybook-static', 'artifacts', 'reports']);
const NESTED_FOLDERS = new Set(['__fixtures__', 'test-fixtures', 'test-results', 'playwright-report', 'coverage']);

/** These are defaults, never secret-policy bypasses. An app reference or an
 * explicit include keeps a file; public/assets/src and invented folders remain. */
export function operationalExclusionReason(path: string, optedIn: (path: string, directory: boolean) => boolean): string | null {
  const parts = path.split('/');
  const folder = parts.slice(0, -1).findIndex((name, i) => NESTED_FOLDERS.has(name.toLowerCase()) || (i === 0 && ROOT_FOLDERS.has(name.toLowerCase())));
  const output = /\.(?:log|jsonl)$/i.test(parts.at(-1) ?? '');
  if (folder < 0 && !output) return null;
  if (optedIn(path, false) || parts.slice(0,-1).some((_, i) => optedIn(parts.slice(0,i+1).join('/'), true))) return null;
  const name = folder < 0 ? path : parts.slice(0,folder+1).join('/');
  return `operational file — publish it with \`somewhere deploy --include ${name}\` or a "!${name}${folder < 0 ? '' : '/'}" line in .somewhereignore`;
}

/** Conservative retention: a quoted app path, import, URL or HTML/CSS reference
 * makes an otherwise operational file app input. False retention costs bytes;
 * dropping a real app file would break a deploy. Dynamic paths need --include. */
export function operationalReferenceMatcher(files: ReadonlyArray<readonly [string, string]>): (candidate: string) => boolean {
  const exact = new Set<string>(), prefixes = new Set<string>();
  for (const [file, source] of files) for (const match of source.matchAll(/["'`]([^"'`\r\n]+)["'`]|url\(\s*([^\s)'"`]+)\s*\)|(?:src|href)\s*=\s*([^\s>"'`]+)/g)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').split(/[?#]/)[0];
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const resolved = raw.startsWith('/') ? posix.normalize(raw).slice(1) : posix.normalize(posix.join(posix.dirname(file), raw));
    exact.add(resolved);
    if (raw.endsWith('/')) prefixes.add(resolved.replace(/\/$/, ''));
  }
  const matches = (candidate: string) => exact.has(candidate) || exact.has(candidate.replace(/\.[^/.]+$/, ''))
    || candidate.split('/').slice(0,-1).some((_,i) => prefixes.has(candidate.split('/').slice(0,i+1).join('/')));
  return candidate => matches(candidate) || (candidate.startsWith('public/') && matches(candidate.slice(7)));
}
