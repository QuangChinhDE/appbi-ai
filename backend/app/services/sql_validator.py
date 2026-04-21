"""
SQL query validation utilities.
"""
import re
from app.core.logging import get_logger

logger = get_logger(__name__)


def validate_select_only(sql_query: str) -> None:
    """
    Validate that a SQL query is SELECT-only for safety.
    
    Raises ValueError if:
    - Query contains dangerous keywords (INSERT, UPDATE, DELETE, DROP, etc.)
    - Query contains multiple statements (semicolon followed by more SQL)
    - Query is empty or whitespace-only
    
    Args:
        sql_query: The SQL query to validate
        
    Raises:
        ValueError: If query violates safety rules
        
    Examples:
        # Allowed:
        validate_select_only("SELECT * FROM users")
        validate_select_only("SELECT id, name FROM products WHERE price > 100")
        validate_select_only("select * from orders; -- comment")
        
        # Blocked:
        validate_select_only("DELETE FROM users")  # dangerous keyword
        validate_select_only("SELECT * FROM users; DROP TABLE users")  # multiple statements
        validate_select_only("")  # empty query
    """
    if not sql_query or not sql_query.strip():
        raise ValueError("SQL query cannot be empty")
    
    # Normalize: remove comments and extra whitespace
    normalized = _normalize_sql(sql_query)

    # Strip string literals and quoted identifiers before keyword scanning
    # so that words like CALL / MERGE / REPLACE appearing inside 'text',
    # "ident" or `ident` don't trigger false positives.
    # NOTE: REPLACE is intentionally NOT in the blocklist because it is a
    # legitimate BigQuery string function and SELECT * REPLACE(...) modifier.
    scannable = _strip_literals_and_quoted_idents(normalized)

    # Check for dangerous keywords (case-insensitive).
    # Only true DML/DDL/procedural statement keywords belong here.
    dangerous_keywords = [
        'INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE',
        'ALTER', 'CREATE', 'MERGE', 'EXEC',
        'EXECUTE', 'CALL', 'GRANT', 'REVOKE'
    ]

    scannable_upper = scannable.upper()
    for keyword in dangerous_keywords:
        # Use word boundaries to avoid false positives (e.g., "SELECT_INSERT" column name)
        pattern = r'\b' + keyword + r'\b'
        if re.search(pattern, scannable_upper):
            raise ValueError(
                f"Only SELECT queries are allowed. Query contains forbidden keyword: {keyword}"
            )
    
    # Check for multiple statements (semicolon followed by non-whitespace/non-comment)
    # Allow trailing semicolon and comments after it
    if _has_multiple_statements(scannable):
        raise ValueError(
            "Only single SELECT queries are allowed. Multiple statements detected."
        )
    
    # Verify it starts with SELECT or WITH (CTE).
    # Compiled transformations produce "WITH base AS (...) SELECT ..." queries.
    stripped_upper = normalized.upper().strip()
    if not (stripped_upper.startswith('SELECT') or stripped_upper.startswith('WITH')):
        raise ValueError(
            "Query must start with SELECT. Only SELECT queries are allowed."
        )
    
    logger.debug(f"SQL validation passed for query: {sql_query[:100]}...")


def _normalize_sql(sql_query: str) -> str:
    """
    Normalize SQL by removing line comments and reducing whitespace.
    Preserves the structure for validation.
    """
    # Remove single-line comments (-- comment)
    sql_query = re.sub(r'--[^\n]*', '', sql_query)
    
    # Remove multi-line comments (/* comment */)
    sql_query = re.sub(r'/\*.*?\*/', '', sql_query, flags=re.DOTALL)
    
    return sql_query


def _strip_literals_and_quoted_idents(sql_query: str) -> str:
    """
    Remove the contents of string literals and quoted identifiers so that
    SQL keywords appearing inside them do not trigger the forbidden-keyword
    check.

    Handles:
      - Single-quoted strings: 'text' (with '' escape)
      - Double-quoted strings/identifiers: "text" (with "" escape)
      - Backtick-quoted identifiers (BigQuery/MySQL): `ident`
      - Triple-quoted BigQuery strings: '''...''' and \"\"\"...\"\"\"
      - Raw/byte string prefixes: r'...', b'...', rb'...' (prefix left intact,
        body stripped)

    The replacement keeps the quote characters but empties the content so the
    query structure (length, semicolon positions, etc.) is still
    approximately preserved for downstream checks.
    """
    # Order matters: handle triple-quoted before single/double to avoid
    # partial matches.
    patterns = [
        (r"'''.*?'''", "''''''"),
        (r'""".*?"""', '""""""'),
        (r"'(?:''|[^'])*'", "''"),
        (r'"(?:""|[^"])*"', '""'),
        (r"`[^`]*`", "``"),
    ]
    for pat, repl in patterns:
        sql_query = re.sub(pat, repl, sql_query, flags=re.DOTALL)
    return sql_query


def _has_multiple_statements(sql_query: str) -> bool:
    """
    Check if SQL contains multiple statements.
    Allows trailing semicolon but rejects semicolon followed by more SQL.
    """
    # Find all semicolons
    parts = sql_query.split(';')
    
    # If only one part, no semicolon present
    if len(parts) <= 1:
        return False
    
    # Check if anything after the first semicolon is non-whitespace
    for part in parts[1:]:
        if part.strip():  # Non-empty after semicolon
            return True
    
    return False
