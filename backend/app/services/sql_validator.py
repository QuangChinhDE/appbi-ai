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
    
    # Check for dangerous keywords (case-insensitive)
    dangerous_keywords = [
        'INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE', 
        'ALTER', 'CREATE', 'REPLACE', 'MERGE', 'EXEC',
        'EXECUTE', 'CALL'
    ]
    
    normalized_upper = normalized.upper()
    for keyword in dangerous_keywords:
        # Use word boundaries to avoid false positives (e.g., "SELECT_INSERT" column name)
        pattern = r'\b' + keyword + r'\b'
        if re.search(pattern, normalized_upper):
            raise ValueError(
                f"Only SELECT queries are allowed. Query contains forbidden keyword: {keyword}"
            )
    
    # Check for multiple statements (semicolon followed by non-whitespace/non-comment)
    # Allow trailing semicolon and comments after it
    if _has_multiple_statements(normalized):
        raise ValueError(
            "Only single SELECT queries are allowed. Multiple statements detected."
        )
    
    # Verify it starts with SELECT (after removing whitespace)
    if not normalized_upper.strip().startswith('SELECT'):
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
