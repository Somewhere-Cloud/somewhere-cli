import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function tokens(text, filename) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw new Error('Cannot project invalid source');
  const result = [];
  const visit = node => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(source);
    if (children.length) children.forEach(visit);
    else if (node.kind !== ts.SyntaxKind.EndOfFileToken) result.push({ kind: node.kind, start: node.getStart(source), end: node.end });
  };
  visit(source);
  return result;
}

// Token spans come from the parser, including regex and template rescanning.
// Only trivia between those spans can contain comments; literal bytes are copied.
export function publicProjection(text, filename = 'vendor.ts') {
  const spans = tokens(text, filename);
  let output = '', end = 0;
  for (const token of [...spans, { start: text.length, end: text.length }]) {
    const trivia = text.slice(end, token.start);
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, trivia);
    let gap = '', position = 0;
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
      const start = scanner.getTokenPos(), finish = scanner.getTextPos();
      gap += trivia.slice(position, start);
      gap += kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia
        ? trivia.slice(start, finish).replace(/[^\r\n]/g, ' ')
        : trivia.slice(start, finish);
      position = finish;
    }
    output += (gap + trivia.slice(position)).replace(/[ \t]+(?=\r?\n)/g, '') + text.slice(token.start, token.end);
    end = token.end;
  }
  return output;
}

export function executableTokens(text, filename = 'vendor.ts') {
  return tokens(text, filename).map(token => [token.kind, text.slice(token.start, token.end)]);
}

export function assertBehaviorParity(original, projected, filename = 'vendor.ts') {
  if (JSON.stringify(executableTokens(original, filename)) !== JSON.stringify(executableTokens(projected, filename))) {
    throw new Error(filename + ': executable token mismatch (including literal contents)');
  }
}

export function assertPublicArtifact(text, filename) {
  if (/\b(?:tsk|pfb)_[a-f0-9]{6,32}\b/.test(text)) {
    throw new Error(filename + ': internal task or feedback reference in public artifact; fix its source');
  }
}

// Bounds the bundled runtime, source map, and public declarations.
export const BUNDLE_BUDGET = { entryCount: 50, size: 2_500_000, unpackedSize: 11_000_000 };

export function assertBundleBudget(pack) {
  for (const [field, maximum] of Object.entries(BUNDLE_BUDGET)) {
    const actual = pack[field];
    if (!Number.isSafeInteger(actual) || actual <= 0 || actual > maximum) {
      throw new Error(`npm artifact ${field} is ${actual}; limit is ${maximum}. Inspect the packed file list.`);
    }
  }
  if (pack.files.some(({ path }) => path.startsWith('node_modules/'))) {
    throw new Error('npm artifact contains a node_modules directory');
  }
}

// npm owns the shipped-file list: declarations, JSON, docs and templates are
// checked alongside executable bundles, with no extension-based exclusions.
export function assertPublicPackage(root) {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Cannot enumerate public package files');
  const [{ files }] = JSON.parse(result.stdout);
  for (const { path } of files) {
    assertPublicArtifact(path, path);
    assertPublicArtifact(readFileSync(join(root, path)).toString('utf8'), path);
  }
  return { files_scanned: files.length };
}
