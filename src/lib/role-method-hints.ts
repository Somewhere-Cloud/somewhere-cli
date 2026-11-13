import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const ROLE_WRITES = new Set(['setRoles', 'grantRole', 'revokeRole']);

/** A warning for explicit GET-only route exports, not an authorization analysis. */
export function roleMethodHints(projectDir: string): string[] {
  const api = join(projectDir, 'api');
  if (!existsSync(api)) return [];
  const hints: string[] = [];
  function visitDir(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { visitDir(path); continue; }
      if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue;
      const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const exports = new Set<string>();
      let unknown = false;
      for (const statement of file.statements) {
        if (ts.isExportAssignment(statement)) unknown = true;
        if (ts.isExportDeclaration(statement)) {
          if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) unknown = true;
          else for (const spec of statement.exportClause.elements) exports.add(spec.name.text);
        }
        if (ts.canHaveModifiers(statement)) {
          const modifiers = ts.getModifiers(statement);
          if (modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) unknown = true;
          if (!modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
          if (ts.isVariableStatement(statement)) for (const decl of statement.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) exports.add(decl.name.text);
          }
          if (ts.isFunctionDeclaration(statement) && statement.name) exports.add(statement.name.text);
        }
      }
      const methods = [...exports].filter(name => METHODS.has(name));
      if (unknown || methods.length !== 1 || methods[0] !== 'GET') continue;
      let write: string | undefined;
      function walk(node: ts.Node): void {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && ROLE_WRITES.has(node.expression.name.text)
          && node.expression.expression.getText(file) === 'sw.auth.server') write ??= node.expression.name.text;
        ts.forEachChild(node, walk);
      }
      walk(file);
      if (write) hints.push(`hint: ${relative(projectDir, path).replaceAll('\\', '/')}: ${write} is called in a GET-only route; use a POST setup handler once after sign-up/profile completion (cookie GET cannot change roles).`);
    }
  }
  visitDir(api);
  return hints;
}
