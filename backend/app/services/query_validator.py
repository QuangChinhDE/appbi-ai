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
    
    # Dangerous SQL keywords that should never appear
    DANGEROUS_KEYWORDS = [
        'DELETE', 'DROP', 'TRUNCATE', 'ALTER', 'CREATE', 'INSERT',
        'UPDATE', 'REPLACE', 'MERGE', 'EXEC', 'EXECUTE', 'GRANT',
        'REVOKE', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'SET',
    ]
    
    # Dangerous patterns
    DANGEROUS_PATTERNS = [
        r';',  # Multiple statements
        r'--',  # SQL comments
        r'/\*',  # Block comments
        r'\bxp_',  # SQL Server extended procedures
        r'\bsp_',  # SQL Server stored procedures
    ]
    
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
        
        # Normalize: remove extra whitespace, convert to uppercase for checking
        normalized = ' '.join(query.split()).upper()
        
        # Must start with SELECT or WITH (for CTEs)
        if not (normalized.startswith('SELECT') or normalized.startswith('WITH')):
            return False, "Query must start with SELECT. Only SELECT queries are allowed."
        
        # Check for dangerous keywords
        for keyword in QueryValidator.DANGEROUS_KEYWORDS:
            # Use word boundaries to avoid false positives (e.g., "INSERTED" contains "INSERT")
            pattern = r'\b' + keyword + r'\b'
            if re.search(pattern, normalized):
                return False, f"Dangerous keyword not allowed: {keyword}"
        
        # Check for dangerous patterns
        for pattern in QueryValidator.DANGEROUS_PATTERNS:
            if re.search(pattern, query):
                # Provide friendly error messages
                if pattern == r';':
                    return False, "Multiple statements not allowed (no semicolons)"
                elif pattern in [r'--', r'/\*']:
                    return False, "SQL comments not allowed"
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
