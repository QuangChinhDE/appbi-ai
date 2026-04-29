"""Transformation Compiler Service.

Compiles transformation steps into SQL operations.
Transformations are applied in order to shape data without modifying the source schema.
"""
from typing import Any, Dict, List, Optional, Tuple
import re

from app.services.type_override_service import build_safe_cast_sql


def _quote_identifier(name: str, dialect: str) -> str:
    if dialect in ("bigquery", "mysql"):
        return f"`{name}`"
    return f'"{name}"'


def _indent_sql(sql: str, spaces: int = 2) -> str:
    prefix = " " * spaces
    return "\n".join(f"{prefix}{line}" if line else line for line in sql.splitlines())


def _split_top_level_args(args_sql: str) -> List[str]:
    parts: List[str] = []
    buf: List[str] = []
    depth = 0
    in_single = False
    in_double = False
    i = 0
    while i < len(args_sql):
        ch = args_sql[i]
        if ch == "'" and not in_double:
            in_single = not in_single
            buf.append(ch)
        elif ch == '"' and not in_single:
            in_double = not in_double
            buf.append(ch)
        elif not in_single and not in_double:
            if ch == "(":
                depth += 1
                buf.append(ch)
            elif ch == ")":
                depth = max(depth - 1, 0)
                buf.append(ch)
            elif ch == "," and depth == 0:
                parts.append("".join(buf).strip())
                buf = []
            else:
                buf.append(ch)
        else:
            buf.append(ch)
        i += 1
    if buf:
        parts.append("".join(buf).strip())
    return parts


def _replace_function_calls(expr: str, fn_name: str, replacer) -> str:
    pattern = re.compile(rf"\b{fn_name}\s*\(", flags=re.IGNORECASE)
    cursor = 0
    out: List[str] = []
    while True:
        match = pattern.search(expr, cursor)
        if not match:
            out.append(expr[cursor:])
            break
        out.append(expr[cursor:match.start()])
        open_idx = expr.find("(", match.start())
        depth = 0
        in_single = False
        in_double = False
        close_idx = None
        idx = open_idx
        while idx < len(expr):
            ch = expr[idx]
            if ch == "'" and not in_double:
                in_single = not in_single
            elif ch == '"' and not in_single:
                in_double = not in_double
            elif not in_single and not in_double:
                if ch == "(":
                    depth += 1
                elif ch == ")":
                    depth -= 1
                    if depth == 0:
                        close_idx = idx
                        break
            idx += 1
        if close_idx is None:
            out.append(expr[match.start():])
            break
        args_sql = expr[open_idx + 1:close_idx]
        args = _split_top_level_args(args_sql)
        out.append(replacer(args))
        cursor = close_idx + 1
    return "".join(out)


def _rewrite_safe_numeric_helpers(expr: str, dialect: str) -> str:
    helper_targets = {
        "SAFE_INT": "integer",
        "SAFE_FLOAT": "float",
        "SAFE_NUMBER": "float",
    }
    rewritten = expr
    for fn_name, target_type in helper_targets.items():
        rewritten = _replace_function_calls(
            rewritten,
            fn_name,
            lambda args, target=target_type: _compile_safe_numeric_helper(args, target, dialect),
        )
    return rewritten


_SQL_EXPR_CONTROL_KEYWORDS = {
    "AND",
    "OR",
    "NOT",
    "NULL",
    "TRUE",
    "FALSE",
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "END",
    "AS",
    "IS",
    "IN",
    "LIKE",
    "BETWEEN",
    "ESCAPE",
}

_SQL_CAST_TARGET_TYPES = {
    "INT",
    "INTEGER",
    "BIGINT",
    "SMALLINT",
    "TINYINT",
    "UBIGINT",
    "USMALLINT",
    "UTINYINT",
    "FLOAT",
    "DOUBLE",
    "REAL",
    "DECIMAL",
    "NUMERIC",
    "VARCHAR",
    "CHAR",
    "TEXT",
    "STRING",
    "BOOLEAN",
    "BOOL",
    "DATE",
    "TIME",
    "TIMESTAMP",
    "DATETIME",
}


def _quote_bare_identifiers(expr: str, dialect: str) -> str:
    """Quote bare field references while preserving functions and SQL control keywords."""
    result: List[str] = []
    index = 0
    length = len(expr)

    while index < length:
        current = expr[index]

        if current == "'":
            end = index + 1
            while end < length:
                if expr[end] == "'" and end + 1 < length and expr[end + 1] == "'":
                    end += 2
                elif expr[end] == "'":
                    end += 1
                    break
                else:
                    end += 1
            result.append(expr[index:end])
            index = end
            continue

        if current in {'"', '`'}:
            quote_char = current
            end = index + 1
            while end < length:
                if expr[end] == quote_char and end + 1 < length and expr[end + 1] == quote_char:
                    end += 2
                elif expr[end] == quote_char:
                    end += 1
                    break
                else:
                    end += 1
            result.append(expr[index:end])
            index = end
            continue

        if current.isalpha() or current == "_":
            end = index + 1
            while end < length and (expr[end].isalnum() or expr[end] == "_"):
                end += 1

            token = expr[index:end]
            upper_token = token.upper()

            next_index = end
            while next_index < length and expr[next_index].isspace():
                next_index += 1

            previous_index = index - 1
            while previous_index >= 0 and expr[previous_index].isspace():
                previous_index -= 1
            previous_char = expr[previous_index] if previous_index >= 0 else ""

            if (
                token.startswith("__CF_COLREF_")
                or upper_token in _SQL_EXPR_CONTROL_KEYWORDS
                or (next_index < length and expr[next_index] == "(")
                or previous_char == "."
            ):
                result.append(token)
            else:
                result.append(_quote_identifier(token, dialect))

            index = end
            continue

        result.append(current)
        index += 1

    return "".join(result)


def _restore_cast_type_names(expr: str) -> str:
    """Undo identifier quoting for CAST target types after bare-field rewriting."""

    def _replace(match: "re.Match[str]") -> str:
        token = match.group(2)
        if token.upper() in _SQL_CAST_TARGET_TYPES:
            return f"AS {token}"
        return match.group(0)

    return re.sub(r"\bAS\s+([`\"])([A-Za-z_][A-Za-z0-9_]*)\1", _replace, expr, flags=re.IGNORECASE)


def _compile_safe_numeric_helper(args: List[str], target_type: str, dialect: str) -> str:
    if not args:
        raise ValueError("SAFE numeric helper requires at least one argument")
    source_expr = args[0]
    default_sql = args[1] if len(args) > 1 and args[1] else ("0" if target_type == "integer" else "0.0")
    cast_sql = build_safe_cast_sql(source_expr, target_type, dialect)
    return f"COALESCE({cast_sql}, {default_sql})"


def _compile_if_expression(args: List[str]) -> str:
    if len(args) != 3:
        raise ValueError("IF requires exactly three arguments")
    condition, true_value, false_value = args
    return f"CASE WHEN {condition} THEN {true_value} ELSE {false_value} END"


class TransformationCompiler:
    """Compiles transformations into SQL queries."""

    @staticmethod
    def compile_transformations(
        base_query: str,
        transformations: List[Dict[str, Any]],
        dialect: str = "bigquery",
        available_columns: Optional[List[str]] = None,
    ) -> Tuple[str, List[str]]:
        """
        Compile transformations into a SQL query.

        Args:
            base_query: Base SELECT query (e.g. "SELECT * FROM table" or subquery)
            transformations: List of transformation steps
            dialect: SQL dialect (bigquery, postgres, mysql, duckdb)
            available_columns: Optional ordered list of source columns before transforms

        Returns:
            Tuple of (compiled_query, column_list)
        """
        active_steps = [
            t for t in (transformations or [])
            if t.get("enabled", True) and t.get("type") != "js_formula"
        ]
        if not active_steps:
            return base_query, list(available_columns or [])

        ctes: List[str] = [f"base AS (\n{_indent_sql(base_query)}\n)"]
        current_cte = "base"
        current_columns = list(available_columns) if available_columns else None
        result_columns = list(current_columns or [])
        step_num = 0

        for transformation in active_steps:
            t_type = transformation.get("type")
            params = transformation.get("params", {}) or {}
            step_sql: Optional[str] = None

            if t_type == "select_columns":
                requested_columns = [
                    str(col) for col in (params.get("columns") or []) if str(col).strip()
                ]
                if not requested_columns:
                    continue
                select_parts = [_quote_identifier(col, dialect) for col in requested_columns]
                step_sql = (
                    "SELECT\n  "
                    + ",\n  ".join(select_parts)
                    + f"\nFROM {current_cte}"
                )
                current_columns = requested_columns

            elif t_type == "rename_columns":
                mapping = {
                    str(src): str(dst)
                    for src, dst in (params.get("mapping") or {}).items()
                    if str(src).strip() and str(dst).strip()
                }
                if not mapping:
                    continue

                if current_columns:
                    select_parts = []
                    for col in current_columns:
                        quoted_col = _quote_identifier(col, dialect)
                        new_name = mapping.get(col, col)
                        if new_name == col:
                            select_parts.append(quoted_col)
                        else:
                            select_parts.append(
                                f"{quoted_col} AS {_quote_identifier(new_name, dialect)}"
                            )
                    current_columns = [mapping.get(col, col) for col in current_columns]
                else:
                    select_parts = ["*"]
                    for old_name, new_name in mapping.items():
                        select_parts.append(
                            f"{_quote_identifier(old_name, dialect)} AS {_quote_identifier(new_name, dialect)}"
                        )
                step_sql = (
                    "SELECT\n  "
                    + ",\n  ".join(select_parts)
                    + f"\nFROM {current_cte}"
                )

            elif t_type == "add_column":
                new_field = str(params.get("newField") or "").strip()
                expression = str(params.get("expression") or "").strip()
                if not new_field or not expression:
                    continue

                sql_expr = TransformationCompiler._compile_expression(expression, dialect)
                base_projection = (
                    ",\n  ".join(_quote_identifier(col, dialect) for col in current_columns)
                    if current_columns else "*"
                )
                step_sql = (
                    "SELECT\n  "
                    + base_projection
                    + ",\n  "
                    + f"({sql_expr}) AS {_quote_identifier(new_field, dialect)}"
                    + f"\nFROM {current_cte}"
                )
                if current_columns is not None:
                    current_columns = [*current_columns, new_field]

            if not step_sql:
                continue

            step_num += 1
            current_cte = f"step_{step_num}"
            ctes.append(f"{current_cte} AS (\n{_indent_sql(step_sql)}\n)")
            if current_columns:
                result_columns = list(current_columns)

        compiled_query = "WITH " + ",\n".join(ctes) + f"\nSELECT * FROM {current_cte}"
        return compiled_query, result_columns

    @staticmethod
    def resolve_column_reference(
        ref: str,
        available_columns: Optional[List[Dict[str, Any]]] = None,
    ) -> str:
        """Translate a `[ref]` column reference into the canonical engine identifier.

        `available_columns` is a list of column metadata dicts as returned by
        DataSourceConnectionService.infer_column_types — each carrying `name`,
        `display_name`, `safe_name`. Lookup order:
        1. Exact match against `name` (back-compat for datasets that were created
           with raw Vietnamese identifiers and are still queried that way).
        2. Case-insensitive match against `safe_name`.
        3. Case-insensitive match against `display_name`.
        4. Match where `safe_name` equals `normalize_identifier(ref)` (this is what
           lets users type `[Doanh Thu]` and have it land on `[doanh_thu]`).

        If nothing matches we leave the input untouched so existing single-table flows
        with no metadata keep working.
        """
        cleaned = (ref or "").strip()
        if not cleaned or not available_columns:
            return cleaned

        for entry in available_columns:
            if not isinstance(entry, dict):
                continue
            if str(entry.get("name") or "") == cleaned:
                return cleaned

        cleaned_lower = cleaned.lower()
        for entry in available_columns:
            if not isinstance(entry, dict):
                continue
            safe = str(entry.get("safe_name") or "")
            if safe and safe.lower() == cleaned_lower:
                return safe

        for entry in available_columns:
            if not isinstance(entry, dict):
                continue
            display = str(entry.get("display_name") or "")
            if display and display.lower() == cleaned_lower:
                target_safe = str(entry.get("safe_name") or "")
                target_name = str(entry.get("name") or "")
                return target_safe or target_name or cleaned

        try:
            from app.services.identifier_utils import normalize_identifier
            normalized = normalize_identifier(cleaned)
        except Exception:
            normalized = None

        if normalized:
            for entry in available_columns:
                if not isinstance(entry, dict):
                    continue
                safe = str(entry.get("safe_name") or "")
                if safe and safe.lower() == normalized.lower():
                    return safe

        return cleaned

    @staticmethod
    def _compile_expression(
        expression: str,
        dialect: str,
        available_columns: Optional[List[Dict[str, Any]]] = None,
    ) -> str:
        """
        Compile a formula expression to SQL.

        Supports:
        - Math: +, -, *, /
        - Functions: IF, ROUND, COALESCE
        - Safe numeric helpers: SAFE_INT(expr[, default]), SAFE_FLOAT(expr[, default]), SAFE_NUMBER(expr[, default])
        - Comparisons: =, !=, >, >=, <, <=
        - Field references (bare ``col`` or Excel-style ``[col name]``)

        When `available_columns` is provided, each `[ref]` is translated through
        `resolve_column_reference` so users can type Vietnamese display names
        (``[Doanh Thu]``) and still produce SQL bound to the canonical safe identifier
        (``"doanh_thu"``).
        """
        expr = expression.strip()

        # Extract Excel-style column references ([col]) into numbered placeholders
        # BEFORE the string-literal rewrite so the later `"` → `'` pass cannot
        # collide with quoted identifiers we add back at the end.
        col_refs: List[str] = []

        def _collect_col_ref(match: "re.Match[str]") -> str:
            col_refs.append(match.group(1).strip())
            return f"__CF_COLREF_{len(col_refs) - 1}__"

        expr = re.sub(r"\[([^\[\]]+)\]", _collect_col_ref, expr)

        # Convert spreadsheet-style string literals ("value") into SQL literals ('value').
        expr = re.sub(
            r'"([^"\\]*(?:\\.[^"\\]*)*)"',
            lambda match: "'" + match.group(1).replace("'", "''") + "'",
            expr,
        )

        previous = None
        while previous != expr:
            previous = expr
            expr = _replace_function_calls(expr, "IF", _compile_if_expression)
        expr = _rewrite_safe_numeric_helpers(expr, dialect)
        expr = expr.replace("!=", "<>")
        expr = _quote_bare_identifiers(expr, dialect)
        expr = _restore_cast_type_names(expr)

        # Restore extracted column references as properly quoted identifiers so
        # columns with spaces or unusual casing survive DuckDB/BigQuery parsing.
        for idx, col_name in enumerate(col_refs):
            resolved = TransformationCompiler.resolve_column_reference(col_name, available_columns)
            expr = expr.replace(
                f"__CF_COLREF_{idx}__",
                _quote_identifier(resolved, dialect),
            )
        return expr

    @staticmethod
    def validate_expression(expression: str) -> Tuple[bool, Optional[str]]:
        """
        Validate a formula expression.

        Args:
            expression: Formula to validate

        Returns:
            Tuple of (is_valid, error_message)
        """
        if not expression or not expression.strip():
            return False, "Expression cannot be empty"

        dangerous = [
            "SELECT", "FROM", "WHERE", "JOIN", "UNION",
            "INSERT", "UPDATE", "DELETE", "DROP", "ALTER",
            "CREATE", "TRUNCATE", "EXEC", "EXECUTE",
        ]

        upper_expr = expression.upper()
        for keyword in dangerous:
            if re.search(r"\b" + keyword + r"\b", upper_expr):
                return False, f"Dangerous keyword not allowed: {keyword}"

        if expression.count("(") != expression.count(")"):
            return False, "Unmatched parentheses"

        if ";" in expression:
            return False, "Semicolons not allowed"

        # Whitelist allowed function calls to prevent dangerous DuckDB builtins
        _ALLOWED_FUNCTIONS = {
            "ROUND", "COALESCE", "IF", "ABS", "CEIL", "FLOOR",
            "NULLIF", "CAST", "GREATEST", "LEAST",
            "SAFE_INT", "SAFE_FLOAT", "SAFE_NUMBER",
        }
        func_calls = re.findall(r"\b([A-Za-z_]\w*)\s*\(", expression)
        for func_name in func_calls:
            if func_name.upper() not in _ALLOWED_FUNCTIONS:
                return False, f"Function not allowed in expression: {func_name}"

        return True, None
