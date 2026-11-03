"""Finds every SQL statement services/ai passes to a call, without running anything.

Same contract as extract-ts.mjs. A call argument that folds to constant strings is
printed as statements (JSON lines). Folding covers literals, + concatenation,
f-strings of constants, a if c else b, module constants, imported constants and
single-assignment locals. An argument that only partly folds is a dynamic site,
appended to $SITES as {file, line, fragment}.

Usage: python3 extract-py.py services/ai/src > static.jsonl
"""

from __future__ import annotations

import ast
import json
import os
import re
import sys
from pathlib import Path

SQL = re.compile(r"^\s*(WITH|SELECT|INSERT|UPDATE|DELETE)\b[\s\S]*\b(FROM|INTO|SET|VALUES|AS|RETURNING)\b", re.I)
# A fragment counts as SQL only with a clause after the verb, so "DELETE" alone (an HTTP
# method) is not a site.
WORDS = re.compile(r"\b(SELECT|INSERT|UPDATE|DELETE)\b[\s\S]*\b(FROM|INTO|SET|WHERE)\b|\b(FROM|WHERE|JOIN)\s+\w")
MAX = 32

root = Path(sys.argv[1])
modules: dict[str, ast.Module] = {}
for path in root.rglob("*.py"):
    name = ".".join(path.relative_to(root).with_suffix("").parts)
    modules[name.removesuffix(".__init__")] = ast.parse(path.read_text(encoding="utf-8"), str(path))


def module_constants(name: str) -> dict[str, ast.expr]:
    tree = modules.get(name)
    if tree is None:
        return {}
    out: dict[str, ast.expr] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            out[node.targets[0].id] = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
            out[node.target.id] = node.value
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            for alias in node.names:
                out.setdefault(alias.asname or alias.name, ast.Constant(value=("__import__", node.module, alias.name)))
    return out


def locals_of(func: ast.AST | None) -> dict[str, ast.expr]:
    if func is None:
        return {}
    counts: dict[str, int] = {}
    values: dict[str, ast.expr] = {}
    for node in ast.walk(func):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    counts[target.id] = counts.get(target.id, 0) + 1
                    values[target.id] = node.value
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign)) and isinstance(node.target, ast.Name):
            counts[node.target.id] = counts.get(node.target.id, 0) + 2
    return {name: values[name] for name, n in counts.items() if n == 1 and name in values}


parents: dict[int, ast.AST] = {}
owner: dict[int, str] = {}
for mod_name, tree in modules.items():
    for parent in ast.walk(tree):
        owner[id(parent)] = mod_name
        for child in ast.iter_child_nodes(parent):
            parents[id(child)] = parent


def enclosing(node: ast.AST):
    node = parents.get(id(node))
    while node is not None and not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        node = parents.get(id(node))
    return node


# Every call by callee name, so a parameter can be folded from the constants callers pass.
calls_to: dict[str, list[ast.Call]] = {}
for tree in modules.values():
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", None)
            if name:
                calls_to.setdefault(name, []).append(node)


def param_values(func, name: str, seen: frozenset) -> list[str] | None:
    params = [a.arg for a in [*func.args.posonlyargs, *func.args.args]]
    if name not in params:
        return None
    index = params.index(name) - (1 if params and params[0] in ("self", "cls") else 0)
    sites = calls_to.get(func.name, [])
    if not sites:
        return None
    out: list[str] = []
    for call in sites:
        arg = next((k.value for k in call.keywords if k.arg == name), None)
        if arg is None and 0 <= index < len(call.args):
            arg = call.args[index]
        value = fold(arg, owner[id(call)], enclosing(call), seen) if arg is not None else None
        if not value:
            return None
        out.extend(v for v in value if v not in out)
    return out if len(out) <= MAX else None


# Loop variables of a comprehension being folded, e.g. f"{c} = ..." for c in ("a", "b").
BOUND: dict[str, str] = {}


def items(node, mod: str, func, seen: frozenset) -> list[str] | None:
    """Constant strings of a list/tuple, or of a one-loop comprehension over one."""
    if isinstance(node, (ast.List, ast.Tuple)):
        parts = [fold(e, mod, func, seen) for e in node.elts]
        return [p[0] for p in parts] if all(p and len(p) == 1 for p in parts) else None
    if isinstance(node, (ast.GeneratorExp, ast.ListComp)) and len(node.generators) == 1:
        gen = node.generators[0]
        if gen.ifs or gen.is_async or not isinstance(gen.target, ast.Name):
            return None
        values = items(gen.iter, mod, func, seen)
        if values is None:
            return None
        out = []
        for value in values:
            BOUND[gen.target.id] = value
            try:
                part = fold(node.elt, mod, func, seen)
            finally:
                BOUND.pop(gen.target.id, None)
            if not part or len(part) != 1:
                return None
            out.append(part[0])
        return out
    return None


def fold(node, mod: str, func, seen: frozenset = frozenset()) -> list[str] | None:
    if node is None or id(node) in seen:
        return None
    seen = seen | {id(node)}
    if isinstance(node, ast.Constant):
        if isinstance(node.value, str):
            return [node.value]
        if isinstance(node.value, tuple) and node.value[:1] == ("__import__",):
            _, source, attr = node.value
            target = module_constants(source).get(attr)
            return fold(target, source, None, seen) if target is not None else None
        return None
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = fold(node.left, mod, func, seen)
        right = fold(node.right, mod, func, seen) if left else None
        if not left or not right:
            return None
        out = [a + b for a in left for b in right]
        return out if len(out) <= MAX else None
    if isinstance(node, ast.JoinedStr):
        out = [""]
        for part in node.values:
            if isinstance(part, ast.Constant):
                out = [a + str(part.value) for a in out]
                continue
            if not isinstance(part, ast.FormattedValue) or part.format_spec is not None or part.conversion != -1:
                return None
            value = fold(part.value, mod, func, seen)
            if not value:
                return None
            out = [a + b for a in out for b in value]
            if len(out) > MAX:
                return None
        return out
    if isinstance(node, ast.IfExp):
        a = fold(node.body, mod, func, seen)
        b = fold(node.orelse, mod, func, seen) if a else None
        return a + b if a and b else None
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and not node.keywords:
        base = fold(node.func.value, mod, func, seen)
        if not base:
            return None
        if node.func.attr == "replace" and len(node.args) in (2, 3):
            old_s, new_s = (fold(a, mod, func, seen) for a in node.args[:2])
            count = node.args[2].value if len(node.args) == 3 and isinstance(node.args[2], ast.Constant) else -1
            if old_s and new_s and len(old_s) == len(new_s) == 1 and isinstance(count, int):
                return [b.replace(old_s[0], new_s[0], count) for b in base]
            return None
        if node.func.attr == "join" and len(base) == 1 and len(node.args) == 1:
            parts = items(node.args[0], mod, func, seen)
            return [base[0].join(parts)] if parts is not None else None
        return None
    if isinstance(node, ast.Name):
        if node.id in BOUND:
            return [BOUND[node.id]]
        local = locals_of(func)
        if node.id in local:
            return fold(local[node.id], mod, func, seen)
        if func is not None:
            value = param_values(func, node.id, seen)
            if value is not None:
                return value
        target = module_constants(mod).get(node.id)
        return fold(target, mod, None, seen) if target is not None else None
    return None


def literals(node: ast.AST, mod: str, func, out: list[str], seen: set) -> list[str]:
    if id(node) in seen:
        return out
    seen.add(id(node))
    if isinstance(node, ast.expr):
        value = fold(node, mod, func)
        if value:
            out.extend(value)
            return out
        if isinstance(node, ast.Name):
            target = locals_of(func).get(node.id) or module_constants(mod).get(node.id)
            if target is not None:
                return literals(target, mod, func, out, seen)
    for child in ast.iter_child_nodes(node):
        # A nested call is its own site (visited separately); its SQL is not this argument's.
        if not isinstance(child, ast.Call):
            literals(child, mod, func, out, seen)
    return out


statements: set[str] = set()
sites: list[dict] = []
for mod, tree in modules.items():
    path = str((root / Path(*mod.split("."))).with_suffix(".py"))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = enclosing(node)
        for arg in [*node.args, *(k.value for k in node.keywords)]:
            value = fold(arg, mod, func)
            if value:
                statements.update(s for s in value if SQL.search(s))
                continue
            parts = [s for s in literals(arg, mod, func, [], set()) if WORDS.search(s)]
            if parts:
                fragment = max(parts, key=len)
                sites.append({"file": os.path.relpath(path, root.parent), "line": node.lineno, "fragment": fragment})

# A DB call whose SQL does not fold (Conds.query, sql += ...) is a dynamic site too. Its
# fragment is what the SQL must start with, so a test has to send it. A wrapper that
# only forwards its own `sql` parameter is skipped: its callers' arguments are checked.
DB_METHODS = {"fetch", "fetchrow", "fetchval", "execute", "executemany"}
for mod, tree in modules.items():
    path = str((root / Path(*mod.split("."))).with_suffix(".py"))
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr in DB_METHODS and node.args):
            continue
        func = enclosing(node)
        arg = node.args[0]
        if fold(arg, mod, func) is not None:
            continue
        if isinstance(arg, ast.Name) and func is not None \
                and arg.id in [a.arg for a in [*func.args.posonlyargs, *func.args.args]]:
            continue
        # The migration runner executes db/migrations/*.sql files, not application SQL.
        if func is not None and "migration" in func.name:
            continue
        fragment = ""
        for inner in ast.walk(func) if func is not None else []:
            if isinstance(inner, ast.Call) and isinstance(inner.func, ast.Attribute) \
                    and inner.func.attr == "query" and len(inner.args) >= 2:
                cols, table = fold(inner.args[0], mod, func), fold(inner.args[1], mod, func)
                if cols and table:
                    fragment = f"SELECT {cols[0]} FROM {table[0]} WHERE"
            elif isinstance(inner, ast.Assign) and isinstance(arg, ast.Name) and not fragment \
                    and any(isinstance(t, ast.Name) and t.id == arg.id for t in inner.targets):
                first = fold(inner.value, mod, func)
                if first:
                    fragment = first[0]
        sites.append({"file": os.path.relpath(path, root.parent), "line": node.lineno,
                      "fragment": fragment or f"<unfoldable {ast.unparse(arg)}>"})

# Inventory: every SQL-looking string piece in the source. coverage.mjs demands that each
# one appears in some checked statement, so SQL built in ways the folder cannot follow
# (returned from a helper, grown with +=) still has to be reached by a test.
INVENTORY = re.compile(r"\b(SELECT\b[\s\S]*\bFROM|INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|ON CONFLICT|RETURNING|WHERE\s+\w+(\.\w+)?\s*(=|<|>|IS|IN|LIKE|ILIKE))\b")
fragments: list[dict] = []
for mod, tree in modules.items():
    path = str((root / Path(*mod.split("."))).with_suffix(".py"))
    docstrings = {id(n.body[0].value) for n in ast.walk(tree)
                  if isinstance(n, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                  and n.body and isinstance(n.body[0], ast.Expr) and isinstance(n.body[0].value, ast.Constant)}
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings \
                and INVENTORY.search(node.value):
            fragments.append({"file": os.path.relpath(path, root.parent), "line": node.lineno, "fragment": node.value})

for statement in sorted(statements):
    print(json.dumps(statement, ensure_ascii=False))
if os.environ.get("SITES"):
    with open(os.environ["SITES"], "a", encoding="utf-8") as fh:
        for site in sites:
            fh.write(json.dumps(site, ensure_ascii=False) + "\n")
if os.environ.get("FRAGMENTS"):
    with open(os.environ["FRAGMENTS"], "a", encoding="utf-8") as fh:
        for fragment in fragments:
            fh.write(json.dumps(fragment, ensure_ascii=False) + "\n")
print(f"extract-py: {len(statements)} constant statements, {len(sites)} dynamic sites, "
      f"{len(fragments)} SQL fragments", file=sys.stderr)
