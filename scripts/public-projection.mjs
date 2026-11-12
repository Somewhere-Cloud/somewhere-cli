import ts from 'typescript';

// Source comments are omitted; comments inside generated code strings are
// transformed as string content so their template boundaries remain intact.
export function publicProjection(text, filename = 'vendor.ts') {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const result = ts.transform(source, [context => {
    const visit = node => {
      if ((ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) && node.text.includes('\n') && !ts.isTaggedTemplateExpression(node.parent)) {
        const cleaned = node.text.replace(/^[\t ]*\/\/[^\n]*$/gm, '');
        if (cleaned === node.text) return node;
        return ts.isStringLiteral(node)
          ? ts.factory.createStringLiteral(cleaned)
          : ts.factory.createNoSubstitutionTemplateLiteral(cleaned);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return node => ts.visitNode(node, visit);
  }]);
  try {
    return publicText(ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed }).printFile(result.transformed[0]));
  } finally { result.dispose(); }
}

export function publicText(text) {
  return text
    .replace(/\s*\((?:tsk_|pfb_)[a-f0-9]+\)/g, '')
    .replace(/(?:tsk_|pfb_)[a-f0-9]{6,}/g, '');
}
