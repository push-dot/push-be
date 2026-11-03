// Finds every SQL statement the Workers pass to a call, without running anything.
// An argument that folds to constant strings (literals, consts, imports, + , templates of
// constants, a ? b : c, .replace on constants) is printed as statements (JSON lines).
// An argument that only partly folds is a dynamic site; it is printed to --sites as
// {file, line, fragment} so check-coverage can demand a captured statement for it.
// Usage: node extract-ts.mjs <tsconfig>... > static.jsonl  (env SITES=<file> for sites)
import { appendFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import ts from "typescript";

const SQL = /^\s*(WITH|SELECT|INSERT|UPDATE|DELETE)\b[\s\S]*\b(FROM|INTO|SET|VALUES|AS|RETURNING)\b/i;
const MAX = 32;

const programs = process.argv.slice(2).map((path) => {
  const parsed = ts.getParsedCommandLineOfConfigFile(path, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  return ts.createProgram(parsed.fileNames, parsed.options);
});

const statements = new Set();
const sites = [];

for (const program of programs) {
  const checker = program.getTypeChecker();
  const resolve = (node) => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.valueDeclaration;
  };
  const fold = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return null;
    seen = new Set(seen).add(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
      || ts.isNonNullExpression(node)) return fold(node.expression, seen);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = fold(node.left, seen);
      const right = left && fold(node.right, seen);
      if (!left || !right) return null;
      const out = left.flatMap((a) => right.map((b) => a + b));
      return out.length > MAX ? null : out;
    }
    if (ts.isTemplateExpression(node)) {
      let out = [node.head.text];
      for (const span of node.templateSpans) {
        const value = fold(span.expression, seen);
        if (!value) return null;
        out = out.flatMap((a) => value.map((b) => a + b + span.literal.text));
        if (out.length > MAX) return null;
      }
      return out;
    }
    if (ts.isConditionalExpression(node)) {
      const a = fold(node.whenTrue, seen);
      const b = a && fold(node.whenFalse, seen);
      return a && b ? [...a, ...b] : null;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "replace" && node.arguments.length === 2) {
      const base = fold(node.expression.expression, seen);
      const from = fold(node.arguments[0], seen);
      const to = fold(node.arguments[1], seen);
      if (!base || !from || !to || from.length !== 1 || to.length !== 1) return null;
      return base.map((s) => s.replace(from[0], to[0]));
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const decl = resolve(node);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer
        && ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) return fold(decl.initializer, seen);
      if (decl && ts.isPropertyAssignment(decl)) return fold(decl.initializer, seen);
      return null;
    }
    return null;
  };
  // String pieces of a partly constant expression, following consts into their initializers.
  const literals = (node, out = [], seen = new Set()) => {
    if (seen.has(node)) return out;
    seen.add(node);
    const value = fold(node);
    if (value) {
      out.push(...value);
      return out;
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const decl = resolve(node);
      const init = decl && (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) ? decl.initializer : null;
      if (init) return literals(init, out, seen);
    }
    // A nested call is its own site (visited separately); its SQL is not this argument's.
    node.forEachChild((child) => {
      if (!ts.isCallExpression(child)) literals(child, out, seen);
    });
    return out;
  };
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || file.fileName.includes("/node_modules/") || !file.fileName.includes("/src/")) continue;
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        for (const arg of node.arguments) {
          const value = fold(arg);
          if (value) {
            for (const s of value) if (SQL.test(s)) statements.add(s);
            continue;
          }
          const parts = literals(arg).filter((s) => /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b/.test(s));
          if (parts.length === 0) continue;
          const { line } = file.getLineAndCharacterOfPosition(arg.getStart());
          const fragment = parts.sort((a, b) => b.length - a.length)[0];
          sites.push({ file: relative(dirname(dirname(dirname(file.fileName))), file.fileName), line: line + 1, fragment });
        }
      }
      node.forEachChild(visit);
    };
    visit(file);
  }
}

// Inventory: every SQL-looking string piece in the source (see extract-py.py).
const INVENTORY = /\b(SELECT\b[\s\S]*\bFROM|INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|ON CONFLICT|RETURNING|WHERE\s+\w+(\.\w+)?\s*(=|<|>|IS|IN|LIKE|ILIKE))\b/;
const fragments = [];
for (const program of programs) {
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || file.fileName.includes("/node_modules/") || !file.fileName.includes("/src/")) continue;
    const visit = (node) => {
      const pieces = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? [node.text]
        : ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((s) => s.literal.text)] : [];
      for (const text of pieces) {
        if (!INVENTORY.test(text)) continue;
        const { line } = file.getLineAndCharacterOfPosition(node.getStart());
        fragments.push({ file: relative(dirname(dirname(dirname(file.fileName))), file.fileName), line: line + 1, fragment: text });
      }
      node.forEachChild(visit);
    };
    visit(file);
  }
}

for (const s of [...statements].sort()) process.stdout.write(JSON.stringify(s) + "\n");
if (process.env.FRAGMENTS) for (const f of fragments) appendFileSync(process.env.FRAGMENTS, JSON.stringify(f) + "\n");
if (process.env.SITES) for (const s of sites) appendFileSync(process.env.SITES, JSON.stringify(s) + "\n");
process.stderr.write(`extract-ts: ${statements.size} constant statements, ${sites.length} dynamic sites, ${fragments.length} SQL fragments\n`);
