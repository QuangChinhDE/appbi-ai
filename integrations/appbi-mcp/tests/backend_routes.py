"""Read AppBI's route table from backend source, without importing the backend.

Only what the allowlist contract needs: (METHOD, path) for every route under
/api/v1, with path parameters normalised to `*`. Parsing (not importing) keeps
the MCP's test environment free of the backend's pinned dependency set.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
BACKEND_APP = REPO / "backend" / "app"
_HTTP = {"get", "post", "put", "patch", "delete"}


def _const_str(node: ast.AST | None) -> str | None:
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def _kw(call: ast.Call, name: str) -> str | None:
    for kw in call.keywords:
        if kw.arg == name:
            return _const_str(kw.value)
    return None


def _module_routes(path: Path) -> tuple[str, list[tuple[str, str]]]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    prefix = ""
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == "router" for t in node.targets)
            and isinstance(node.value, ast.Call)
            and getattr(node.value.func, "id", None) == "APIRouter"
        ):
            prefix = _kw(node.value, "prefix") or ""
    routes: list[tuple[str, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for dec in node.decorator_list:
            if (
                isinstance(dec, ast.Call)
                and isinstance(dec.func, ast.Attribute)
                and isinstance(dec.func.value, ast.Name)
                and dec.func.value.id == "router"
                and dec.func.attr in _HTTP
            ):
                sub = _const_str(dec.args[0]) if dec.args else _kw(dec, "path")
                if sub is not None:
                    routes.append((dec.func.attr.upper(), sub))
    return prefix, routes


def _include_prefixes() -> dict[str, str]:
    """module name -> include_router(prefix=...) in app/api/__init__.py."""
    tree = ast.parse((BACKEND_APP / "api" / "__init__.py").read_text(encoding="utf-8"))
    out: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "attr", None) == "include_router" and node.args:
            arg = node.args[0]
            if isinstance(arg, ast.Attribute) and isinstance(arg.value, ast.Name):
                out[arg.value.id] = _kw(node, "prefix") or ""
    return out


def normalise(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "*", path)


def backend_routes() -> set[tuple[str, str]]:
    includes = _include_prefixes()
    files = {name: BACKEND_APP / "api" / f"{name}.py" for name in includes}
    files["semantic"] = BACKEND_APP / "routers" / "semantic.py"
    out: set[tuple[str, str]] = set()
    for name, path in files.items():
        if not path.exists():
            continue
        router_prefix, routes = _module_routes(path)
        include_prefix = includes.get(name, "")
        for method, sub in routes:
            out.add((method, normalise(include_prefix + router_prefix + sub)))
    # Defined directly on the app in main.py, under /api/v1.
    out.add(("GET", "/health"))
    return out
