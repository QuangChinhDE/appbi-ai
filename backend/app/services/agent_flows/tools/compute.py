"""`compute` — the AI writes the formula; the runtime owns the result.

THE HOLE THIS CLOSES
--------------------
The previous `compute` took `vars` straight from the model — "the numbers MUST
come from prior tool results (the agent is responsible for citing) — we only
enforce arithmetic safety". Its result, echoing those vars, was then harvested
into the run's evidence ledger like any other tool result, so the answer verifier
would certify a figure computed from a number the model typed. The model was the
calculator of record; the runtime only did the arithmetic.

WHY BY REFERENCE, NOT BY VALUE MATCHING
---------------------------------------
Checking that a supplied number "appears somewhere in the evidence" is provenance
by coincidence: with Revenue 2025 = 100 and Target = 100 in one run, a variable
of 100 matches both and proves neither. So a variable names WHICH result it came
from — `{"ref": "e3", "path": "rows[0].revenue"}` — and the runtime reads the
value itself from the result it produced (`RunState.evidence_store`). The model
chooses the reference; it never copies a trusted value.

LITERALS ARE MATHEMATICS, NOT EVIDENCE
--------------------------------------
100, 365, 1e6 in the expression are explicit literals — allowed at any
magnitude, recorded in the lineage, never questioned. What is refused trust is a
BARE NUMBER passed as a variable (the old calling convention): the formula still
runs, the lineage marks that input `referenced: false`, and the result declares
`provenance: "unreferenced"`, which keeps it out of the trusted ledger
(`RunState.record_evidence`). An invented input can be computed with; it can never
be certified.

SAFETY
------
An AST whitelist, never `eval`: numbers, declared variable names, + - * / % **
//, unary +/-, parentheses, and abs/min/max/round. Bounded in size and in `**`,
finite results only.
"""
from __future__ import annotations

import ast
import math
import operator as ops
import re
from typing import Any, Callable

from app.services.agent_flows.tools import result as R

#: Largest expression accepted, in AST nodes. A formula a person would write is a
#: few dozen; this only stops something pathological.
MAX_NODES = 200
#: `**` exponent ceiling: squares and compounding are real, 10**10**10 is not.
MAX_EXPONENT = 12

_BINOPS: dict[type, Callable[[float, float], float]] = {
    ast.Add: ops.add,
    ast.Sub: ops.sub,
    ast.Mult: ops.mul,
    ast.Div: ops.truediv,
    ast.Mod: ops.mod,
    ast.Pow: ops.pow,
    ast.FloorDiv: ops.floordiv,
}
_UNARY: dict[type, Callable[[float], float]] = {ast.UAdd: ops.pos, ast.USub: ops.neg}
_FUNCS: dict[str, Callable[..., float]] = {"abs": abs, "min": min, "max": max, "round": round}


class _Refused(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _err(code: str, message: str) -> dict:
    # NOT retryable: the same arguments give the same answer, so the retry policy
    # may stop an identical repeat. Changing the arguments — the fix every one of
    # these messages names — always runs again.
    return R.err(message, code=code, retryable=False)


# ── references ───────────────────────────────────────────────────────────────
_SEGMENT = re.compile(r"""\s*(?:([^.\[\]]+)|\[\s*(-?\d+)\s*\]|\[\s*["']([^"']*)["']\s*\])""")


def _parse_path(path: str) -> list[Any]:
    """`rows[0].revenue`, `data.value`, `items[2]["Doanh thu"]` → segments."""
    out: list[Any] = []
    pos = 0
    text = (path or "").strip()
    while pos < len(text):
        if text[pos] == ".":
            pos += 1
            continue
        m = _SEGMENT.match(text, pos)
        if not m or m.end() == pos:
            raise _Refused("evidence_path_missing", f"đường dẫn không đọc được: {path!r}")
        name, index, quoted = m.groups()
        if index is not None:
            out.append(int(index))
        elif quoted is not None:
            out.append(quoted)
        else:
            out.append(name.strip())
        pos = m.end()
    return out


def _shape(value: Any) -> str:
    if isinstance(value, dict):
        keys = ", ".join(list(map(str, value))[:8])
        return f"một object có các khoá [{keys}]"
    if isinstance(value, list):
        return f"một danh sách {len(value)} phần tử — chọn một chỉ số, ví dụ [0]"
    return f"giá trị {value!r}"


def _walk(root: Any, segments: list[Any], path: str) -> Any:
    node = root
    for seg in segments:
        if isinstance(seg, int):
            if not isinstance(node, list) or not -len(node) <= seg < len(node):
                raise _Refused(
                    "evidence_path_missing",
                    f"đường dẫn {path!r}: không có phần tử [{seg}] — ở đây là {_shape(node)}",
                )
            node = node[seg]
        else:
            if not isinstance(node, dict) or seg not in node:
                raise _Refused(
                    "evidence_path_missing",
                    f"đường dẫn {path!r}: không có khoá {seg!r} — ở đây là {_shape(node)}",
                )
            node = node[seg]
    return node


def _numeric(value: Any, where: str) -> float:
    if isinstance(value, bool) or value is None:
        raise _Refused("evidence_not_numeric", f"{where} là {value!r}, không phải một con số")
    if isinstance(value, (int, float)):
        f = float(value)
    elif isinstance(value, str):
        try:
            f = float(value.strip())
        except ValueError:
            raise _Refused(
                "evidence_not_numeric",
                f"{where} là chuỗi {value[:40]!r}, không phải một con số",
            ) from None
    else:
        raise _Refused("evidence_not_numeric", f"{where} là {_shape(value)}, không phải một con số")
    if not math.isfinite(f):
        raise _Refused("evidence_not_numeric", f"{where} không phải một số hữu hạn")
    return f


def resolve_reference(store: dict[str, Any], ref: str, path: str) -> tuple[float, dict]:
    """The value a `{ref, path}` names, and where it came from.

    `path` is read against the result object; a path that does not start at the
    envelope (`ok`, `kind`, `data`) is read under `data`, which is where every
    tool's payload lives — so `rows[0].revenue` and `data.rows[0].revenue` name
    the same cell.
    """
    entry = store.get(str(ref or "").strip())
    if not entry:
        known = ", ".join(sorted(store)[-8:]) or "chưa có kết quả nào"
        raise _Refused(
            "evidence_ref_unknown",
            f"không có kết quả nào mang tham chiếu {ref!r} trong lượt này (có: {known})",
        )
    result = entry.get("result") or {}
    segments = _parse_path(path)
    root: Any = result
    if segments and isinstance(result, dict) and segments[0] not in result \
            and isinstance(result.get("data"), (dict, list)):
        root = result["data"]
    value = _walk(root, segments, path) if segments else result.get("data")
    return _numeric(value, f"{ref}:{path or '(gốc)'}"), {
        "tool": entry.get("tool") or "",
        "step": entry.get("source") or "",
    }


# ── the expression ───────────────────────────────────────────────────────────
def _evaluate(expression: str, names: dict[str, float]) -> tuple[float, list[float]]:
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        raise _Refused("compute_invalid", f"biểu thức sai cú pháp: {exc.msg}") from None
    if sum(1 for _ in ast.walk(tree)) > MAX_NODES:
        raise _Refused("compute_invalid", f"biểu thức quá dài (tối đa {MAX_NODES} phần tử)")
    literals: list[float] = []

    def ev(node: ast.AST) -> float:
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant):
            if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
                raise _Refused("compute_invalid", f"hằng số không hợp lệ: {node.value!r}")
            literals.append(float(node.value))
            return float(node.value)
        if isinstance(node, ast.Name):
            if node.id not in names:
                raise _Refused(
                    "compute_invalid",
                    f"biến {node.id!r} chưa được khai báo trong `vars`",
                )
            return names[node.id]
        if isinstance(node, ast.BinOp):
            fn = _BINOPS.get(type(node.op))
            if fn is None:
                raise _Refused("compute_invalid", f"phép toán không được phép: {type(node.op).__name__}")
            left, right = ev(node.left), ev(node.right)
            if isinstance(node.op, ast.Pow) and abs(right) > MAX_EXPONENT:
                raise _Refused("compute_invalid", f"số mũ tối đa là {MAX_EXPONENT}")
            try:
                out = fn(left, right)
            except ZeroDivisionError:
                raise _Refused("compute_invalid", "chia cho 0 — kiểm tra lại mẫu số") from None
            except (OverflowError, ValueError):
                raise _Refused("compute_invalid", "kết quả vượt quá giới hạn biểu diễn") from None
            if isinstance(out, complex) or not math.isfinite(out):
                raise _Refused("compute_invalid", "kết quả không phải một số thực hữu hạn")
            return float(out)
        if isinstance(node, ast.UnaryOp):
            fn = _UNARY.get(type(node.op))
            if fn is None:
                raise _Refused("compute_invalid", f"phép toán không được phép: {type(node.op).__name__}")
            return fn(ev(node.operand))
        if isinstance(node, ast.Call):
            name = node.func.id if isinstance(node.func, ast.Name) else ""
            if name not in _FUNCS or node.keywords:
                raise _Refused(
                    "compute_invalid",
                    "chỉ được dùng các hàm abs, min, max, round (không có tham số tên)",
                )
            args = [ev(a) for a in node.args]
            if not args or (name in ("abs",) and len(args) != 1) \
                    or (name == "round" and len(args) not in (1, 2)):
                raise _Refused("compute_invalid", f"số tham số không hợp lệ cho {name}()")
            if name == "round":
                return float(round(args[0], int(args[1]) if len(args) == 2 else 0))
            return float(_FUNCS[name](*args))
        raise _Refused("compute_invalid", f"biểu thức chứa thành phần không được phép: {type(node).__name__}")

    return ev(tree), literals


def _round(value: float) -> float:
    return float(f"{value:.10g}")


def tool_compute(ctx: Any, args: dict) -> dict:
    expression = args.get("expression")
    raw_vars = args.get("vars")
    if raw_vars is None:
        raw_vars = {}
    if not isinstance(expression, str) or not expression.strip():
        return _err("bad_argument", "cần `expression` là một chuỗi biểu thức")
    if not isinstance(raw_vars, dict):
        return _err("bad_argument", "`vars` phải là object {tên: {ref, path}}")
    store = getattr(ctx, "evidence_store", None) or {}

    names: dict[str, float] = {}
    inputs: list[dict] = []
    try:
        for name, spec in raw_vars.items():
            name = str(name)
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                raise _Refused("bad_argument", f"tên biến {name!r} không hợp lệ")
            if isinstance(spec, dict):
                value, origin = resolve_reference(store, spec.get("ref"), str(spec.get("path") or ""))
                names[name] = value
                inputs.append({
                    "name": name, "value": _round(value), "referenced": True,
                    "ref": str(spec.get("ref")), "path": str(spec.get("path") or ""),
                    **origin,
                })
            else:
                # The old calling convention: a number the model typed. Computed
                # with, recorded as exactly that, and never certified.
                value = _numeric(spec, f"vars[{name!r}]")
                names[name] = value
                inputs.append({"name": name, "value": _round(value), "referenced": False})
        value, literals = _evaluate(expression, names)
    except _Refused as exc:
        return _err(exc.code, str(exc))

    referenced = all(i["referenced"] for i in inputs)
    data: dict[str, Any] = {
        "expression": expression,
        "result": _round(value),
        "inputs": inputs,
        "literals": sorted(set(_round(l) for l in literals)),
        "provenance": "referenced" if referenced else "unreferenced",
    }
    if not referenced:
        loose = [i["name"] for i in inputs if not i["referenced"]]
        data["note"] = (
            "Kết quả này dùng số tự nhập (" + ", ".join(loose) + ") thay vì tham "
            "chiếu tới kết quả công cụ, nên KHÔNG được coi là số liệu đã kiểm chứng. "
            "Dùng {\"ref\": \"eN\", \"path\": \"...\"} để kết quả được xác thực."
        )
    return R.ok(data, kind="value")


DEFINITION = {
    "name": "compute",
    "description": (
        "Evaluate an arithmetic formula over figures you already obtained. You "
        "write the formula; the runtime reads the values and computes. Every "
        "successful tool result carries an `evidence_ref` (e.g. \"e3\"): pass each "
        "variable as {\"ref\": \"e3\", \"path\": \"rows[0].revenue\"} naming the value "
        "inside that result — never copy the number yourself. Plain constants "
        "(100, 12, 365) go directly in the expression. Supports + - * / % ** //, "
        "parentheses, abs, min, max, round. The result carries its own "
        "`evidence_ref`, so it can feed another compute."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "expression": {
                "type": "string",
                "description": "e.g. \"(cur - prev) / prev * 100\"",
            },
            "vars": {
                "type": "object",
                "description": "variable name → {ref, path} into a previous result",
                "additionalProperties": {
                    "type": "object",
                    "properties": {
                        "ref": {"type": "string", "description": "evidence_ref, e.g. \"e3\""},
                        "path": {"type": "string",
                                 "description": "where the number sits in that result, e.g. \"rows[0].revenue\" or \"value\""},
                    },
                    "required": ["ref", "path"],
                },
            },
        },
        "required": ["expression", "vars"],
    },
}

#: The shape `tool_compute` returns under `data`. NOT yet declared on the spec:
#: `test_tool_output_contract` requires a schema to be verified against a real
#: report result first, and that has not been done for this tool.
OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "expression": {"type": "string"},
        "result": {"type": "number"},
        "inputs": {"type": "array", "items": {"type": "object"}},
        "literals": {"type": "array", "items": {"type": "number"}},
        "provenance": {"type": "string", "enum": ["referenced", "unreferenced"]},
        "note": {"type": "string"},
    },
    "required": ["expression", "result", "inputs", "provenance"],
}
