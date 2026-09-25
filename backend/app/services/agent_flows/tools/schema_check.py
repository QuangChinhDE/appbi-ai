"""Does a payload fit the `output_schema` its tool declared?

A declared schema is a promise to a TYPED CONSUMER — a ToolNode wiring
`{{calc.result}}` into the next step, a Skill returning a number to its parent —
that a key exists and has a type. A promise nobody checks at the boundary where
it is relied on is a comment. This is the check, deliberately small: the subset
of JSON Schema `output_schema` uses (type, properties, required, items, enum),
no dependency, no network, safe on every call.

`None` for a key that is not `required` is not a violation: an optional value
that is absent on this result is still the declared shape.
"""
from __future__ import annotations

from typing import Any

_TYPES = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
}
#: A list is checked this far; a schema check is not a scan of a table.
_MAX_ITEMS = 200


def problems(value: Any, schema: dict, where: str = "data") -> list[str]:
    """Every way `value` departs from `schema`, named by where (empty = fits)."""
    out: list[str] = []
    kind = schema.get("type")
    if kind and kind in _TYPES and not _TYPES[kind](value):
        return [f"{where}: phải là {kind}, nhận {type(value).__name__}"]
    if "enum" in schema and value not in schema["enum"]:
        out.append(f"{where}: {value!r} không thuộc {schema['enum']}")
    if kind == "object":
        for key in schema.get("required") or []:
            if value.get(key) is None:
                out.append(f"{where}.{key}: bắt buộc nhưng không có")
        for key, sub in (schema.get("properties") or {}).items():
            if value.get(key) is not None and isinstance(sub, dict):
                out += problems(value[key], sub, f"{where}.{key}")
    if kind == "array" and isinstance(schema.get("items"), dict):
        for i, item in enumerate(value[:_MAX_ITEMS]):
            out += problems(item, schema["items"], f"{where}[{i}]")
    return out
