"""
Transform Compiler Service
Compiles transformation steps into SQL (Power Query-style)
"""
from typing import List, Dict, Any
import re


class TransformCompiler:
    """Compiles transformation steps into SQL CTEs"""
    
    # Dialect-specific quote character for identifiers
    QUOTE_CHARS = {
        'postgresql': '"',
        'mysql': '`',
        'bigquery': '`'
    }
    
    # Type mapping for CAST operations
    TYPE_MAPPING = {
        'postgresql': {
            'STRING': 'TEXT',
            'INT': 'INTEGER',
            'FLOAT': 'DOUBLE PRECISION',
            'DATE': 'DATE',
            'DATETIME': 'TIMESTAMP'
        },
        'mysql': {
            'STRING': 'CHAR',
            'INT': 'SIGNED',
            'FLOAT': 'DECIMAL',
            'DATE': 'DATE',
            'DATETIME': 'DATETIME'
        },
        'bigquery': {
            'STRING': 'STRING',
            'INT': 'INT64',
            'FLOAT': 'FLOAT64',
            'DATE': 'DATE',
            'DATETIME': 'DATETIME'
        }
    }
    
    def __init__(self, datasource_type: str):
        """
        Args:
            datasource_type: Type of datasource (postgresql, mysql, bigquery)
        """
        self.datasource_type = datasource_type.lower()
        self.quote_char = self.QUOTE_CHARS.get(self.datasource_type, '"')
        self.type_map = self.TYPE_MAPPING.get(self.datasource_type, self.TYPE_MAPPING['postgresql'])
    
    def quote_identifier(self, identifier: str) -> str:
        """Quote an identifier (column/table name) based on dialect"""
        # Remove existing quotes
        identifier = identifier.strip('"\'`')
        return f"{self.quote_char}{identifier}{self.quote_char}"
    
    def compile_transformations(self, base_sql: str, transformations: List[Dict[str, Any]]) -> str:
        """
        Compile transformations into a SQL query with CTEs
        
        Args:
            base_sql: Base SQL query from dataset
            transformations: List of transformation steps
            
        Returns:
            Final SQL query with all transformations applied
        """
        if not transformations:
            return base_sql
        
        # Filter enabled steps only
        enabled_steps = [t for t in transformations if t.get('enabled', True)]
        if not enabled_steps:
            return base_sql
        
        # Start with base CTE
        ctes = [f"base AS (\n  {base_sql}\n)"]
        prev_cte = "base"
        
        # Compile each step into a CTE
        for idx, step in enumerate(enabled_steps):
            step_type = step.get('type')
            params = step.get('params', {})
            cte_name = f"t{idx + 1}"
            
            try:
                if step_type == 'select_columns':
                    cte_sql = self._compile_select_columns(prev_cte, params)
                elif step_type == 'rename_columns':
                    cte_sql = self._compile_rename_columns(prev_cte, params)
                elif step_type == 'filter_rows':
                    cte_sql = self._compile_filter_rows(prev_cte, params)
                elif step_type == 'add_column':
                    cte_sql = self._compile_add_column(prev_cte, params)
                elif step_type == 'cast_column':
                    cte_sql = self._compile_cast_column(prev_cte, params)
                elif step_type == 'replace_value':
                    cte_sql = self._compile_replace_value(prev_cte, params)
                elif step_type == 'sort':
                    cte_sql = self._compile_sort(prev_cte, params)
                elif step_type == 'limit':
                    cte_sql = self._compile_limit(prev_cte, params)
                else:
                    # Unknown step type, skip
                    continue
                
                ctes.append(f"{cte_name} AS (\n  {cte_sql}\n)")
                prev_cte = cte_name
                
            except Exception as e:
                # If step compilation fails, skip it
                print(f"Warning: Failed to compile step {step_type}: {str(e)}")
                continue
        
        # Build final query
        final_sql = "WITH " + ",\n".join(ctes) + f"\nSELECT * FROM {prev_cte}"
        return final_sql
    
    def _compile_select_columns(self, prev_cte: str, params: Dict) -> str:
        """SELECT specific columns"""
        columns = params.get('columns', [])
        if not columns:
            return f"SELECT * FROM {prev_cte}"
        
        quoted_cols = [self.quote_identifier(col) for col in columns]
        return f"SELECT {', '.join(quoted_cols)} FROM {prev_cte}"
    
    def _compile_rename_columns(self, prev_cte: str, params: Dict) -> str:
        """RENAME columns (SELECT with aliases)"""
        mapping = params.get('mapping', {})
        if not mapping:
            return f"SELECT * FROM {prev_cte}"
        
        # Get all columns, rename specified ones
        select_parts = []
        for old_name, new_name in mapping.items():
            quoted_old = self.quote_identifier(old_name)
            quoted_new = self.quote_identifier(new_name)
            select_parts.append(f"{quoted_old} AS {quoted_new}")
        
        # Note: This assumes we only rename specified columns
        # A full implementation would need to query column list first
        # For simplicity, we'll use * EXCEPT pattern or explicit column list
        
        if select_parts:
            # Simple approach: Just rename the specified columns
            # Assumes these are the only columns user wants
            return f"SELECT {', '.join(select_parts)} FROM {prev_cte}"
        
        return f"SELECT * FROM {prev_cte}"
    
    def _compile_filter_rows(self, prev_cte: str, params: Dict) -> str:
        """FILTER rows with WHERE clause"""
        conditions = params.get('conditions', [])
        logic = params.get('logic', 'AND')
        
        if not conditions:
            return f"SELECT * FROM {prev_cte}"
        
        where_clauses = []
        for cond in conditions:
            field = self.quote_identifier(cond.get('field', ''))
            op = cond.get('op', 'eq')
            value = cond.get('value', '')
            
            # Build condition based on operator
            if op == 'eq':
                where_clauses.append(f"{field} = {self._format_value(value)}")
            elif op == 'neq':
                where_clauses.append(f"{field} != {self._format_value(value)}")
            elif op == 'gt':
                where_clauses.append(f"{field} > {self._format_value(value)}")
            elif op == 'gte':
                where_clauses.append(f"{field} >= {self._format_value(value)}")
            elif op == 'lt':
                where_clauses.append(f"{field} < {self._format_value(value)}")
            elif op == 'lte':
                where_clauses.append(f"{field} <= {self._format_value(value)}")
            elif op == 'in':
                # value should be a list
                if isinstance(value, list):
                    values_str = ', '.join([self._format_value(v) for v in value])
                    where_clauses.append(f"{field} IN ({values_str})")
            elif op == 'contains':
                where_clauses.append(f"{field} LIKE {self._format_value(f'%{value}%')}")
        
        if not where_clauses:
            return f"SELECT * FROM {prev_cte}"
        
        connector = f" {logic} "
        where_clause = connector.join(where_clauses)
        return f"SELECT * FROM {prev_cte} WHERE {where_clause}"
    
    def _compile_add_column(self, prev_cte: str, params: Dict) -> str:
        """ADD computed column"""
        new_field = params.get('newField', '')
        expression = params.get('expression', '')
        
        if not new_field or not expression:
            return f"SELECT * FROM {prev_cte}"
        
        # Validate expression doesn't contain dangerous keywords
        if self._is_dangerous_sql(expression):
            raise ValueError(f"Expression contains forbidden SQL keywords")
        
        quoted_field = self.quote_identifier(new_field)
        return f"SELECT *, ({expression}) AS {quoted_field} FROM {prev_cte}"
    
    def _compile_cast_column(self, prev_cte: str, params: Dict) -> str:
        """CAST column to different type"""
        field = params.get('field', '')
        to_type = params.get('to', 'STRING')
        
        if not field:
            return f"SELECT * FROM {prev_cte}"
        
        quoted_field = self.quote_identifier(field)
        target_type = self.type_map.get(to_type, to_type)
        
        # For simplicity, just cast the field
        # Full implementation would preserve other columns
        return f"SELECT *, CAST({quoted_field} AS {target_type}) AS {quoted_field} FROM {prev_cte}"
    
    def _compile_replace_value(self, prev_cte: str, params: Dict) -> str:
        """REPLACE value in a column"""
        field = params.get('field', '')
        from_value = params.get('from', '')
        to_value = params.get('to', '')
        
        if not field:
            return f"SELECT * FROM {prev_cte}"
        
        quoted_field = self.quote_identifier(field)
        from_str = self._format_value(from_value)
        to_str = self._format_value(to_value)
        
        # Use CASE WHEN for replacement
        replacement = f"CASE WHEN {quoted_field} = {from_str} THEN {to_str} ELSE {quoted_field} END AS {quoted_field}"
        return f"SELECT *, {replacement} FROM {prev_cte}"
    
    def _compile_sort(self, prev_cte: str, params: Dict) -> str:
        """SORT by columns"""
        sort_by = params.get('by', [])
        
        if not sort_by:
            return f"SELECT * FROM {prev_cte}"
        
        order_parts = []
        for sort_item in sort_by:
            field = self.quote_identifier(sort_item.get('field', ''))
            direction = sort_item.get('direction', 'asc').upper()
            order_parts.append(f"{field} {direction}")
        
        order_clause = ', '.join(order_parts)
        return f"SELECT * FROM {prev_cte} ORDER BY {order_clause}"
    
    def _compile_limit(self, prev_cte: str, params: Dict) -> str:
        """LIMIT result rows"""
        limit = params.get('limit', 1000)
        return f"SELECT * FROM {prev_cte} LIMIT {limit}"
    
    def _format_value(self, value: Any) -> str:
        """Format a value for SQL (add quotes for strings, etc.)"""
        if value is None:
            return 'NULL'
        if isinstance(value, bool):
            return 'TRUE' if value else 'FALSE'
        if isinstance(value, (int, float)):
            return str(value)
        # String - escape single quotes
        escaped = str(value).replace("'", "''")
        return f"'{escaped}'"
    
    def _is_dangerous_sql(self, sql: str) -> bool:
        """Check if SQL contains dangerous keywords"""
        dangerous_keywords = [
            'DROP', 'DELETE', 'TRUNCATE', 'INSERT', 'UPDATE',
            'CREATE', 'ALTER', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE'
        ]
        sql_upper = sql.upper()
        return any(keyword in sql_upper for keyword in dangerous_keywords)


def compile_transformed_sql(base_sql: str, transformations: List[Dict[str, Any]], datasource_type: str) -> str:
    """
    Convenience function to compile transformations
    
    Args:
        base_sql: Base SQL query
        transformations: List of transformation steps
        datasource_type: Type of datasource (postgresql, mysql, bigquery)
        
    Returns:
        Final SQL query with transformations applied
    """
    compiler = TransformCompiler(datasource_type)
    return compiler.compile_transformations(base_sql, transformations)
