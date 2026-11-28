// Vendored from the platform worker deploy-protected-files.ts.
export const IGNORE_FILE_NAME = '.somewhereignore';

const PROTECTED_NAMES = new Set([
  'CLAUDE.md', 'AGENTS.md', 'AGENT.md',

  'README.md',
  '.env', '.envrc', '.npmrc',
  '.somewhere.json', '.mcp.json', '.somewhereignore',
  '.gitignore', '.gitattributes', '.gitmodules',
  '.DS_Store', 'Thumbs.db',
]);
const PROTECTED_DIR_PREFIXES = [
  '.git/', '.claude/', '.cursor/', '.vscode/', '.idea/', '.wrangler/', 'node_modules/',
];
const PROTECTED_BASENAMES = new Set(['.DS_Store', '.env', 'CLAUDE.md', 'AGENTS.md']);

function normalize(path: string): string {
  return path.replace(/^\/+/, '');
}

export function isProtectedDeployPath(path: string): boolean {
  const p = normalize(path);
  if (PROTECTED_NAMES.has(p)) return true;
  if (p.startsWith('.env.')) return true;
  if (PROTECTED_DIR_PREFIXES.some((prefix) => p.startsWith(prefix) || p.includes(`/${prefix}`))) return true;
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (PROTECTED_BASENAMES.has(base)) return true;
  if (base.startsWith('.env.')) return true;
  return false;
}

function reincludePatterns(files: Record<string, string>): Set<string> {
  const out = new Set<string>();
  {
    const content = files[IGNORE_FILE_NAME];
    if (typeof content !== 'string') return out;
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('!') && line.length > 1) out.add(normalize(line.slice(1).trim()));
    }
  }
  return out;
}

export interface ProtectedDeployResult {
  files: Record<string, string>;
  binaryFiles: Record<string, string> | undefined;
  excluded: string[];
  reincluded: string[];
}

export function protectDeployFiles(
  files: Record<string, string>,
  binaryFiles: Record<string, string> | undefined,
): ProtectedDeployResult {
  const reinclude = reincludePatterns(files);
  const excluded: string[] = [];
  const reincluded: string[] = [];
  const keep = (path: string): boolean => {
    const p = normalize(path);
    if (!isProtectedDeployPath(p)) return true;
    if (reinclude.has(p)) { reincluded.push(p); return true; }
    excluded.push(p);
    return false;
  };
  const outFiles: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    if (keep(path)) outFiles[path] = content;
  }
  let outBinary: Record<string, string> | undefined = binaryFiles;
  if (binaryFiles) {
    outBinary = {};
    for (const [path, content] of Object.entries(binaryFiles)) {
      if (keep(path)) outBinary[path] = content;
    }
  }
  excluded.sort();
  reincluded.sort();
  return { files: outFiles, binaryFiles: outBinary, excluded, reincluded };
}

export function protectedFilesWarning(excluded: string[], reincluded: string[]): string | null {
  if (excluded.length === 0 && reincluded.length === 0) return null;
  const parts: string[] = [];
  if (excluded.length > 0) {
    parts.push(
      `Protected developer files were excluded from this deploy and will not be uploaded or served: ${excluded.join(', ')}. ` +
      `To intentionally ship one, add a "!<path>" line to a ${IGNORE_FILE_NAME} file in your project root.`,
    );
  }
  if (reincluded.length > 0) {
    parts.push(`Intentionally included via ${IGNORE_FILE_NAME} "!" rules: ${reincluded.join(', ')}.`);
  }
  return parts.join(' ');
}
