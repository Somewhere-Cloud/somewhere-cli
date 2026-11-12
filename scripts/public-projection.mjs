import ts from 'typescript';

// Remove source comments rather than trying to maintain a list of private names.
// Generated declarations embedded in strings also carry tracking identifiers.
export function publicProjection(text, filename = 'vendor.ts') {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  return publicText(ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })
    .printFile(source));
}

export function publicText(text) {
  return text
    .replace(/\s*\((?:tsk_|pfb_)[a-f0-9]+\)/g, '')
    .replace(/(?:tsk_|pfb_)[a-f0-9]{6,}/g, '');
}
