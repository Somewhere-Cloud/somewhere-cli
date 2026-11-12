import ts from 'typescript';

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
    output += gap + trivia.slice(position) + text.slice(token.start, token.end);
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
