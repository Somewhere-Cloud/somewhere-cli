import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const REMOVED_ROLE_METHODS: Record<string, string> = { grantRole: 'add', revokeRole: 'remove' };

/** Removed role-method names, and setRoles in explicit GET-only routes; not an authorization analysis. */
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
      const rel = relative(projectDir, path).replaceAll('\\', '/');
      let write: string | undefined;
      const removed = new Set<string>();
      function walk(node: ts.Node): void {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && node.expression.expression.getText(file) === 'sw.auth.server') {
          const name = node.expression.name.text;
          if (name === 'setRoles') write ??= name;
          if (name in REMOVED_ROLE_METHODS) removed.add(name);
        }
        ts.forEachChild(node, walk);
      }
      walk(file);
      for (const name of removed) hints.push(`hint: ${rel}: sw.auth.server.${name} was removed; call sw.auth.server.setRoles(userId, { ${REMOVED_ROLE_METHODS[name]}: [role] }).`);
      const methods = [...exports].filter(name => METHODS.has(name));
      if (unknown || methods.length !== 1 || methods[0] !== 'GET') continue;
      if (write) hints.push(`hint: ${rel}: ${write} is called in a GET-only route; use a POST setup handler once after sign-up/profile completion (cookie GET cannot change roles).`);
    }
  }
  visitDir(api);
  return hints;
}
