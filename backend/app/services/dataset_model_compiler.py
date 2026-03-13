"""
Dataset Model Compiler Service
Compiles multi-table dataset models into final SQL queries.
"""
from typing import List, Dict, Any, Optional, Tuple
from sqlalchemy.orm import Session

from app.models import DatasetModel, DatasetModelTable, DatasetRelationship, DatasetCalculatedColumn, DataSource, TableRole
# Alias for clarity
DatasetTable = DatasetModelTable
from app.services.transform_compiler_v2 import TransformCompilerV2
from app.services.datasource_service import DataSourceConnectionService


class DatasetModelCompilerService:
    """
    Compiles dataset models into executable SQL.
    Handles per-table transformations, joins, and calculated columns.
    """
    
    def __init__(self, db: Session):
        self.db = db
        self.transform_compiler = TransformCompilerV2()
        self.connection_service = DataSourceConnectionService(db)
    
    def validate_cross_source_joins(
        self,
        dataset_model: DatasetModel
    ) -> Tuple[bool, Optional[str]]:
        """
        Validate that all tables use compatible data sources.
        V1: All tables must use same database engine type.
        
        Returns:
            (is_valid, error_message)
        """
        if not dataset_model.tables:
            return False, "Dataset model has no tables"
        
        # Get all unique datasource types
        datasource_types = set()
        for table in dataset_model.tables:
            datasource = self.db.query(DataSource).filter(DataSource.id == table.data_source_id).first()
            if datasource:
                datasource_types.add(datasource.type.value)
        
        if len(datasource_types) > 1:
            return False, (
                f"Cross-source joins not supported in v1. "
                f"All tables must use the same database engine. "
                f"Found: {', '.join(datasource_types)}. "
                f"Please materialize dimensions into same warehouse."
            )
        
        return True, None
    
    def compile_table_sql(
        self,
        table: DatasetTable,
        datasource_type: str
    ) -> str:
        """
        Compile individual table SQL with transformations applied.
        
        Args:
            table: DatasetTable instance
            datasource_type: Database type (postgresql, mysql, bigquery)
            
        Returns:
            Compiled SQL as subquery
        """
        if not table.transformations:
            # No transformations, return base SQL wrapped in parentheses
            return f"({table.base_sql})"
        
        # Compile with transformations
        compiled_sql = self.transform_compiler.compile_pipeline_sql(
            base_sql=table.base_sql,
            transformations=table.transformations,
            dialect=datasource_type
        )
        
        return f"({compiled_sql})"
    
    def get_table_alias(self, table: DatasetTable, index: int) -> str:
        """Get alias for a table (f for fact, d1/d2/... for dimensions)"""
        if table.role == TableRole.FACT:
            return "f"
        else:
            return f"d{index}"
    
    def build_join_clause(
        self,
        relationship: DatasetRelationship,
        left_alias: str,
        right_alias: str
    ) -> str:
        """
        Build JOIN clause from relationship.
        
        Args:
            relationship: DatasetRelationship instance
            left_alias: Alias for left table
            right_alias: Alias for right table
            
        Returns:
            JOIN clause string (e.g., "LEFT JOIN ... ON ...")
        """
        join_type_str = relationship.join_type.value.upper()
        
        # Build ON conditions
        on_conditions = []
        for condition in relationship.on:
            left_field = condition["leftField"]
            right_field = condition["rightField"]
            on_conditions.append(f"{left_alias}.{left_field} = {right_alias}.{right_field}")
        
        on_clause = " AND ".join(on_conditions)
        
        return f"{join_type_str} JOIN {right_alias} ON {on_clause}"
    
    def get_dim_column_select(
        self,
        table: DatasetTable,
        alias: str,
        datasource_type: str
    ) -> List[str]:
        """
        Get column select list for dimension table with prefixing.
        
        Args:
            table: DatasetTable instance
            alias: Table alias
            datasource_type: Database type
            
        Returns:
            List of column expressions with aliases (e.g., ["d1.col AS d1__col"])
        """
        if not table.columns:
            # If no cached columns, select all with wildcard (will be prefixed)
            return [f"{alias}.*"]
        
        # Select each column with prefix
        column_selects = []
        for col in table.columns:
            col_name = col["name"]
            prefixed_name = f"{alias}__{col_name}"
            column_selects.append(f"{alias}.{col_name} AS {prefixed_name}")
        
        return column_selects
    
    def validate_calculated_column_expression(self, expression: str) -> Tuple[bool, Optional[str]]:
        """
        Basic validation for calculated column expressions.
        
        Args:
            expression: SQL expression to validate
            
        Returns:
            (is_valid, error_message)
        """
        # Check for forbidden characters/keywords
        forbidden = [';', '--', '/*', '*/', 'DROP', 'DELETE', 'INSERT', 'UPDATE', 'CREATE', 'ALTER', 'EXEC']
        expression_upper = expression.upper()
        
        for forbidden_item in forbidden:
            if forbidden_item in expression_upper:
                return False, f"Forbidden keyword or character: {forbidden_item}"
        
        return True, None
    
    def compile_final_sql(
        self,
        dataset_model: DatasetModel,
        datasource_type: str,
        limit: Optional[int] = None,
        stop_at: str = "final"
    ) -> str:
        """
        Compile final SQL for dataset model.
        
        Args:
            dataset_model: DatasetModel instance with loaded relationships
            datasource_type: Database type
            limit: Optional row limit
            stop_at: Stop compilation at stage: "table", "join", or "final"
            
        Returns:
            Compiled SQL query
        """
        if not dataset_model.tables:
            raise ValueError("Dataset model has no tables")
        
        # Find fact table
        fact_table = None
        dim_tables = []
        for table in dataset_model.tables:
            if table.role == TableRole.FACT:
                fact_table = table
            else:
                dim_tables.append(table)
        
        if not fact_table:
            raise ValueError("Dataset model must have exactly one FACT table")
        
        # Stage 1: Compile individual table SQLs
        cte_clauses = []
        table_aliases = {}
        
        # Compile fact table
        fact_alias = "f"
        fact_sql = self.compile_table_sql(fact_table, datasource_type)
        cte_clauses.append(f"fact AS {fact_sql}")
        table_aliases[fact_table.id] = fact_alias
        
        # Compile dimension tables
        for idx, dim_table in enumerate(dim_tables, start=1):
            dim_alias = f"d{idx}"
            dim_sql = self.compile_table_sql(dim_table, datasource_type)
            cte_clauses.append(f"dim{idx} AS {dim_sql}")
            table_aliases[dim_table.id] = dim_alias
        
        if stop_at == "table":
            # Return just the CTEs for table preview
            with_clause = "WITH\n" + ",\n".join(cte_clauses)
            return f"{with_clause}\nSELECT * FROM fact" + (f" LIMIT {limit}" if limit else "")
        
        # Stage 2: Build joined query
        # Start with fact table columns
        fact_columns = ["f.*"]
        
        # Add dimension columns with prefixing
        dim_column_selects = []
        for idx, dim_table in enumerate(dim_tables, start=1):
            dim_alias = f"d{idx}"
            dim_cols = self.get_dim_column_select(dim_table, dim_alias, datasource_type)
            dim_column_selects.extend(dim_cols)
        
        # Build FROM and JOIN clauses
        from_clause = "FROM fact f"
        join_clauses = []
        
        for relationship in dataset_model.relationships:
            left_alias = table_aliases.get(relationship.left_table_id)
            right_alias = table_aliases.get(relationship.right_table_id)
            
            if not left_alias or not right_alias:
                continue
            
            join_clause = self.build_join_clause(relationship, left_alias, right_alias)
            join_clauses.append(join_clause)
        
        # Build joined CTE
        joined_select = "SELECT\n  " + ",\n  ".join(fact_columns + dim_column_selects)
        joined_from = f"\n{from_clause}"
        joined_joins = "\n".join(join_clauses) if join_clauses else ""
        
        joined_cte = f"joined AS (\n{joined_select}{joined_from}\n{joined_joins}\n)"
        cte_clauses.append(joined_cte)
        
        if stop_at == "join":
            # Return joined result without calculated columns
            with_clause = "WITH\n" + ",\n".join(cte_clauses)
            return f"{with_clause}\nSELECT * FROM joined" + (f" LIMIT {limit}" if limit else "")
        
        # Stage 3: Add calculated columns
        final_columns = ["joined.*"]
        
        for calc_col in dataset_model.calculated_columns:
            if not calc_col.enabled:
                continue
            
            # Validate expression
            is_valid, error = self.validate_calculated_column_expression(calc_col.expression)
            if not is_valid:
                raise ValueError(f"Invalid calculated column '{calc_col.name}': {error}")
            
            final_columns.append(f"({calc_col.expression}) AS {calc_col.name}")
        
        # Build final query
        with_clause = "WITH\n" + ",\n".join(cte_clauses)
        final_select = "SELECT\n  " + ",\n  ".join(final_columns)
        final_from = "\nFROM joined"
        
        final_sql = f"{with_clause}\n{final_select}{final_from}"
        
        if limit:
            final_sql += f"\nLIMIT {limit}"
        
        return final_sql
    
    async def preview_table(
        self,
        table: DatasetTable,
        limit: int = 200
    ) -> Dict[str, Any]:
        """
        Preview individual table with transformations.
        
        Args:
            table: DatasetTable instance
            limit: Row limit
            
        Returns:
            Dict with columns, rows, compiled_sql
        """
        datasource = self.db.query(DataSource).filter(DataSource.id == table.data_source_id).first()
        if not datasource:
            raise ValueError(f"DataSource {table.data_source_id} not found")
        
        compiled_sql = self.compile_table_sql(table, datasource.type.value)
        limited_sql = f"SELECT * FROM {compiled_sql} AS t LIMIT {limit}"
        
        # Execute query
        result = await self.connection_service.execute_query(datasource, limited_sql)
        
        return {
            "columns": result["columns"],
            "rows": result["rows"],
            "total_rows": len(result["rows"]),
            "compiled_sql": limited_sql
        }
