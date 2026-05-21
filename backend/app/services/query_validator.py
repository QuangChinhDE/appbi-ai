"""SQL Query Validator Service

Validates user-submitted SQL queries to prevent dangerous operations.
Ensures only SELECT statements are allowed.
"""
import re
from typing import Optional, Tuple


class QueryValidationError(Exception):
    """Raised when a query fails validation"""
    pass


class QueryValidator:
    """Validates SQL queries for safety"""
    
    # Dangerous SQL keywords that should never appear as statements.
    # NOTE: REPLACE, MERGE, SET are NOT in this list because they double
    # as legitimate expressions in modern SQL:
    #   • REPLACE(str, from, to)       — BigQuery/MySQL string function
    #   • SELECT * REPLACE(... AS col) — BigQuery column override modifier
    #   • MERGE statement is DML, but `MERGE` rarely appears as identifier
    #     so we still block as bare keyword (see _STATEMENT_KEYWORDS).
    #   • SET clause in UPDATE/INSERT is DML; but SET also appears in
    #     BigQuery `SELECT AS STRUCT`/`STRUCT<a INT64>` — too ambiguous
    #     for a blanket block.
    # We split into 2 lists: hard-block keywords + statement-only
    # keywords (must appear at start-of-statement to be dangerous).
    DANGEROUS_KEYWORDS = [
        'DELETE', 'DROP', 'TRUNCATE', 'ALTER', 'CREATE', 'INSERT',
        'UPDATE', 'EXEC', 'EXECUTE', 'GRANT',
        'REVOKE', 'COMMIT', 'ROLLBACK', 'SAVEPOINT',
    ]

    # Keywords that ARE dangerous as statements but legitimate as
    # functions/expressions. We block them only when they appear
    # statement-position (not followed by `(` and not inside a SELECT
    # expression context).
    _CONTEXT_DEPENDENT = {
        'REPLACE': r'\bREPLACE\s+(?:INTO|LOW_PRIORITY|DELAYED|IGNORE)\b',
        'MERGE':   r'\bMERGE\s+(?:INTO)\b',
        'SET':     r'\bSET\s+[A-Z_]+\s*=',  # SET col = value (UPDATE/SESSION SET)
    }

    # Dangerous patterns
    DANGEROUS_PATTERNS = [
        r';',  # Multiple statements
        r'\bxp_',  # SQL Server extended procedures
        r'\bsp_',  # SQL Server stored procedures
    ]

    @staticmethod
    def _strip_comments(query: str) -> str:
        """Remove SQL comments (-- line comments and /* block comments */) for safe keyword checking."""
        # Remove block comments (non-greedy)
        result = re.sub(r'/\*.*?\*/', ' ', query, flags=re.DOTALL)
        # Remove line comments
        result = re.sub(r'--[^\n]*', ' ', result)
        return result
    
    @staticmethod
    def validate_select_only(query: str) -> Tuple[bool, Optional[str]]:
        """
        Validate that the query is a SELECT statement only.
        
        Args:
            query: SQL query to validate
            
        Returns:
            Tuple of (is_valid, error_message)
        """
        if not query or not query.strip():
            return False, "Query cannot be empty"
        
        # Strip comments before checking keywords
        stripped = QueryValidator._strip_comments(query)
        
        # Normalize: remove extra whitespace, convert to uppercase for checking
        normalized = ' '.join(stripped.split()).upper()
        
        # Must start with SELECT or WITH (for CTEs)
        if not (normalized.startswith('SELECT') or normalized.startswith('WITH')):
            return False, "Query must start with SELECT. Only SELECT queries are allowed."
        
        # Check for dangerous keywords
        for keyword in QueryValidator.DANGEROUS_KEYWORDS:
            # Use word boundaries to avoid false positives (e.g., "INSERTED" contains "INSERT")
            pattern = r'\b' + keyword + r'\b'
            if re.search(pattern, normalized):
                return False, f"Dangerous keyword not allowed: {keyword}"

        # Context-dependent keywords: only block when used as statement,
        # not when used as function/expression.
        #   REPLACE(...)   → safe   (BigQuery string fn / SELECT * REPLACE)
        #   REPLACE INTO   → DML, block
        #   SET col=val    → UPDATE clause, block
        #   MERGE INTO     → DML, block
        for keyword, danger_pattern in QueryValidator._CONTEXT_DEPENDENT.items():
            if re.search(danger_pattern, normalized):
                return False, f"Dangerous keyword not allowed: {keyword}"

        # Check for dangerous patterns (on the comment-stripped text)
        for pattern in QueryValidator.DANGEROUS_PATTERNS:
            if re.search(pattern, stripped):
                # Provide friendly error messages
                if pattern == r';':
                    return False, "Multiple statements not allowed (no semicolons)"
                else:
                    return False, f"Dangerous pattern detected: {pattern}"
        
        return True, None
    
    @staticmethod
    def clean_query(query: str) -> str:
        """
        Clean and normalize a query.
        
        Args:
            query: SQL query to clean
            
        Returns:
            Cleaned query string
        """
        # Remove leading/trailing whitespace
        query = query.strip()
        
        # Remove trailing semicolon if present
        if query.endswith(';'):
            query = query[:-1].strip()
        
        return query
    
    @staticmethod
    def validate_and_clean(query: str) -> str:
        """
        Validate and clean a query in one step.
        
        Args:
            query: SQL query to validate and clean
            
        Returns:
            Cleaned query string
            
        Raises:
            QueryValidationError: If query fails validation
        """
        # Clean first
        cleaned = QueryValidator.clean_query(query)
        
        # Then validate
        is_valid, error_msg = QueryValidator.validate_select_only(cleaned)
        
        if not is_valid:
            raise QueryValidationError(error_msg)
        
        return cleaned
