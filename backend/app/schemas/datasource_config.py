"""
Type-safe configuration models for different data source types.
"""
from pydantic import BaseModel, Field, field_validator
from typing import Optional


class PostgreSQLConfig(BaseModel):
    """PostgreSQL connection configuration."""
    host: str = Field(..., description="Database host")
    port: int = Field(5432, ge=1, le=65535, description="Database port")
    database: str = Field(..., description="Database name")
    username: str = Field(..., description="Database username")
    password: str = Field(..., description="Database password")
    
    @field_validator('host')
    @classmethod
    def validate_host(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("Host cannot be empty")
        return v.strip()
    
    @field_validator('database', 'username')
    @classmethod
    def validate_non_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("Field cannot be empty")
        return v.strip()


class MySQLConfig(BaseModel):
    """MySQL connection configuration."""
    host: str = Field(..., description="Database host")
    port: int = Field(3306, ge=1, le=65535, description="Database port")
    database: str = Field(..., description="Database name")
    username: str = Field(..., description="Database username")
    password: str = Field(..., description="Database password")
    
    @field_validator('host')
    @classmethod
    def validate_host(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("Host cannot be empty")
        return v.strip()
    
    @field_validator('database', 'username')
    @classmethod
    def validate_non_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("Field cannot be empty")
        return v.strip()


class BigQueryConfig(BaseModel):
    """BigQuery connection configuration."""
    project_id: str = Field(..., description="GCP project ID")
    credentials_json: str = Field(..., description="Service account JSON as string")
    default_dataset: Optional[str] = Field(None, description="Default dataset name")
    
    @field_validator('project_id')
    @classmethod
    def validate_project_id(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("Project ID cannot be empty")
        return v.strip()
    
    @field_validator('credentials_json')
    @classmethod
    def validate_credentials(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("Credentials JSON cannot be empty")
        # Basic validation that it looks like JSON
        v = v.strip()
        if not (v.startswith('{') and v.endswith('}')):
            raise ValueError("Credentials must be valid JSON object")
        return v


def validate_datasource_config(ds_type: str, config: dict) -> dict:
    """
    Validate data source configuration based on type.
    
    Args:
        ds_type: Data source type (postgresql, mysql, bigquery)
        config: Configuration dictionary
        
    Returns:
        Validated configuration dictionary
        
    Raises:
        ValueError: If configuration is invalid
    """
    ds_type_lower = ds_type.lower()
    
    try:
        if ds_type_lower == 'postgresql':
            validated = PostgreSQLConfig(**config)
        elif ds_type_lower == 'mysql':
            validated = MySQLConfig(**config)
        elif ds_type_lower == 'bigquery':
            validated = BigQueryConfig(**config)
        else:
            raise ValueError(f"Unsupported data source type: {ds_type}")
        
        return validated.model_dump()
    except Exception as e:
        raise ValueError(f"Invalid configuration for {ds_type}: {str(e)}")
