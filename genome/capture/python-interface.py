"""Static Python package interface. Read only the mapped files on stdin; never import the project."""
import ast
import json
import pathlib
import sys


def public_reference(root, paths):
    modules, files, exports, decls, aliases = {}, {}, {}, {}, {}
    for path in paths:
        p = pathlib.PurePosixPath(path)
        if p.suffix != '.py' or any(x.startswith('.') or x == '__pycache__' for x in p.parts):
            continue
        try:
            raw = (root / p).read_bytes()
            if len(raw) > 512 * 1024:
                continue
            tree = ast.parse(raw)
        except (OSError, SyntaxError, ValueError, RecursionError):
            continue
        files[path] = tree
    for path, tree in files.items():
        p = pathlib.PurePosixPath(path)
        parts = [] if p.stem == '__init__' else [p.stem]
        folder = p.parent
        while str(folder / '__init__.py') in files:
            parts.insert(0, folder.name)
            folder = folder.parent
        if not parts or (len(parts) == 1 and p.stem != '__init__'):
            continue
        mod = '.'.join(parts)
        modules[mod] = path
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == '__all__' for t in node.targets) and isinstance(node.value, (ast.List, ast.Tuple)):
                exports[mod] = [x.value for x in node.value.elts if isinstance(x, ast.Constant) and isinstance(x.value, str)]
            if isinstance(node, ast.ImportFrom):
                package = mod if p.stem == '__init__' else mod.rpartition('.')[0]
                prefix = (package.split('.')[:len(package.split('.')) - node.level + 1] if node.level else []) + ([node.module] if node.module else [])
                for a in node.names:
                    aliases[mod + '.' + (a.asname or a.name)] = '.'.join([*prefix, a.name])
            if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                decls[mod + '.' + node.name] = node
    package_api = {mod + '.' + name for mod, names in exports.items() for name in names}
    # Public uses in the original's own tests are evidence too. test_*.py may itself be an installed API module.
    for path, tree in files.items():
        dirs = pathlib.PurePosixPath(path).parts[:-1]
        if not (any(x in {'tests', 'ext_tests', 'test'} for x in dirs) or (path not in modules.values() and pathlib.PurePosixPath(path).name.startswith('test_'))):
            continue
        imports = {}
        for n in ast.walk(tree):
            if isinstance(n, ast.ImportFrom) and n.module in modules:
                for a in n.names:
                    qualified = n.module + '.' + a.name
                    if a.name != '*' and not a.name.startswith('_'):
                        imports[a.asname or a.name] = qualified
                        package_api.add(qualified)
            if isinstance(n, ast.Import):
                for a in n.names:
                    if a.name in modules:
                        imports[a.asname or a.name.split('.')[0]] = a.name if a.asname else a.name.split('.')[0]
        for n in ast.walk(tree):
            if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id in imports and not n.attr.startswith('_'):
                name = imports[n.value.id] + '.' + n.attr
                if name in decls or name in modules or name in aliases:
                    package_api.add(name)
    # Exception types in an explicitly exported module are public, including ones looked up dynamically.
    for name, node in decls.items():
        if isinstance(node, ast.ClassDef) and name.rpartition('.')[0] in package_api and any(ast.unparse(b).endswith(('Exception', 'Error')) for b in node.bases):
            package_api.add(name)
    # Record shapes reached via the public signatures matter to callers just as much as their function names.
    pending = list(package_api)
    while pending:
        name = pending.pop()
        target = aliases.get(name, name)
        node = decls.get(target)
        annotations = ([node.returns] if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) else [n.annotation for n in node.body if isinstance(n, ast.AnnAssign)] if isinstance(node, ast.ClassDef) else [])
        for a in annotations:
            for token in ast.walk(a) if a else []:
                if not isinstance(token, (ast.Name, ast.Attribute)):
                    continue
                first, _, rest = ast.unparse(token).partition('.')
                local = target.rpartition('.')[0] + '.' + first
                typ = aliases.get(local, local) + ('.' + rest if rest else '')
                if typ not in package_api and isinstance(decls.get(typ), ast.ClassDef):
                    package_api.add(typ); pending.append(typ)
    rows = []
    for name in sorted(package_api):
        target, seen = name, set()
        while target in aliases and target not in seen:
            seen.add(target); target = aliases[target]
        node = decls.get(target)
        if isinstance(node, ast.ClassDef):
            bases = ', '.join(ast.unparse(b) for b in node.bases)
            declaration = 'class ' + name + ('(' + bases + ')' if bases else '')
            fields = [n.target.id + ': ' + ast.unparse(n.annotation) for n in node.body if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and not n.target.id.startswith('_')]
            if fields:
                declaration += ' - fields: ' + ', '.join(fields)
            rows.append(declaration)
            for method in node.body:
                if isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)) and not method.name.startswith('_'):
                    prop = any(isinstance(d, ast.Name) and d.id == 'property' for d in method.decorator_list)
                    rows.append(f'{name}.{method.name}' + (' (property)' if prop else '(' + ast.unparse(method.args) + ')') + (' -> ' + ast.unparse(method.returns) if method.returns else ''))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            rows.append(f'{name}({ast.unparse(node.args)})' + (' -> ' + ast.unparse(node.returns) if node.returns else ''))
        else:
            rows.append(name)
    return '\n'.join('- `' + row + '`' for row in rows)


if __name__ == '__main__':
    sys.stdout.write(public_reference(pathlib.Path.cwd(), json.load(sys.stdin)))
