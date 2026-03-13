"""Transformation Compiler Service

Compiles transformation steps into SQL operations.
Transformations are applied in order to shape data without modifying the source schema.
"""
from typing import List, Dict, Any, Optional, Tuple
import re


class TransformationCompiler:
    """Compiles transformations into SQL queries"""
    
    @staticmethod
    def compile_transformations(
        base_query: str,
        transformations: List[Dict[str, Any]],
        dialect: str = "bigquery"
    ) -> Tuple[str, List[str]]:
        """
        Compile transformations into a SQL query.
        
        Args:
            base_query: Base SELECT query (e.g., "SELECT * FROM table" or subquery)
            transformations: List of transformation steps
            dialect: SQL dialect (bigquery, postgres, etc.)
            
        Returns:
            Tuple of (compiled_query, column_list)
        """
        if not transformations:
            return base_query, []
        
        # Wrap base query as CTE
        query = f"WITH base AS (\n  {base_query}\n)\n"
        current_cte = "base"
        step_num = 0
        
        # Track columns through transformations
        selected_columns: Optional[List[str]] = None
        added_columns: Dict[str, str] = {}  # name -> expression
        renamed_columns: Dict[str, str] = {}  # old -> new
        
        for transformation in transformations:
            if not transformation.get("enabled", True):
                continue
                
            t_type = transformation.get("type")
            params = transformation.get("params", {})
            
            if t_type == "select_columns":
                # Filter columns
                selected_columns = params.get("columns", [])
                
            elif t_type == "add_column":
                # Add computed column
                new_field = params.get("newField")
                expression = params.get("expression")
                if new_field and expression:
                    # Compile expression to SQL
                    sql_expr = TransformationCompiler._compile_expression(expression, dialect)
                    added_columns[new_field] = sql_expr
                    
            elif t_type == "rename_columns":
                # Rename columns
                mapping = params.get("mapping", {})
                renamed_columns.update(mapping)
        
        # Build final SELECT
        final_columns = []
        
        # If select_columns specified, use that list
        if selected_columns:
            for col in selected_columns:
                # Check if it's a renamed column
                display_name = renamed_columns.get(col, col)
                if col != display_name:
                    final_columns.append(f"{col} AS {display_name}")
                else:
                    final_columns.append(col)
        else:
            # Select all original columns
            final_columns.append("*")
        
        # Add computed columns
        for col_name, expression in added_columns.items():
            display_name = renamed_columns.get(col_name, col_name)
            if col_name != display_name:
                final_columns.append(f"({expression}) AS {display_name}")
            else:
                final_columns.append(f"({expression}) AS {col_name}")
        
        # Build final query
        columns_sql = ",\n  ".join(final_columns)
        query += f"SELECT\n  {columns_sql}\nFROM {current_cte}"
        
        # Return query and column list for metadata
        result_columns = []
        if selected_columns:
            result_columns.extend([renamed_columns.get(c, c) for c in selected_columns])
        result_columns.extend([renamed_columns.get(c, c) for c in added_columns.keys()])
        
        return query, result_columns
    
    @staticmethod
    def _compile_expression(expression: str, dialect: str) -> str:
        """
        Compile a formula expression to SQL.
        
        Supports:
        - Math: +, -, *, /
        - Functions: IF, ROUND, COALESCE
        - Comparisons: =, !=, >, >=, <, <=
        - Field references
        
        Args:
            expression: Formula expression
            dialect: SQL dialect
            
        Returns:
            SQL expression
        """
        # For v1, we'll do simple translation
        # Replace IF() with CASE WHEN for most SQL dialects
        
        expr = expression.strip()
        
        # Handle IF(condition, true_value, false_value)
        if_pattern = r'IF\s*\(\s*(.+?)\s*,\s*(.+?)\s*,\s*(.+?)\s*\)'
        
        def replace_if(match):
            condition = match.group(1)
            true_val = match.group(2)
            false_val = match.group(3)
            return f"CASE WHEN {condition} THEN {true_val} ELSE {false_val} END"
        
        expr = re.sub(if_pattern, replace_if, expr, flags=re.IGNORECASE)
        
        # ROUND is standard in most SQL dialects
        # COALESCE is standard
        
        # Replace != with <> for SQL
        expr = expr.replace('!=', '<>')
        
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
        
        # Check for dangerous keywords
        dangerous = [
            'SELECT', 'FROM', 'WHERE', 'JOIN', 'UNION',
            'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER',
            'CREATE', 'TRUNCATE', 'EXEC', 'EXECUTE'
        ]
        
        upper_expr = expression.upper()
        for keyword in dangerous:
            if re.search(r'\b' + keyword + r'\b', upper_expr):
                return False, f"Dangerous keyword not allowed: {keyword}"
        
        # Check for valid parentheses
        if expression.count('(') != expression.count(')'):
            return False, "Unmatched parentheses"
        
        # Check for semicolons
        if ';' in expression:
            return False, "Semicolons not allowed"
        
        return True, None
