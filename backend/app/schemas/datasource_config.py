"""
Type-safe configuration models for different data source types.
"""
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class PostgreSQLConfig(BaseModel):
    """PostgreSQL connection configuration."""

    host: str = Field(..., description="Database host")
    port: int = Field(5432, ge=1, le=65535, description="Database port")
    database: str = Field(..., description="Database name")
    username: str = Field(..., description="Database username")
    password: str = Field(..., description="Database password")
    schema_name: Optional[str] = Field(None, description="Default schema (default: public)")

    @field_validator("host")
    @classmethod
    def validate_host(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("Host cannot be empty")
        return value.strip()

    @field_validator("database", "username")
    @classmethod
    def validate_non_empty(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("Field cannot be empty")
        return value.strip()


class MySQLConfig(BaseModel):
    """MySQL connection configuration."""

    host: str = Field(..., description="Database host")
    port: int = Field(3306, ge=1, le=65535, description="Database port")
    database: str = Field(..., description="Database name")
    username: str = Field(..., description="Database username")
    password: str = Field(..., description="Database password")

    @field_validator("host")
    @classmethod
    def validate_host(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("Host cannot be empty")
        return value.strip()

    @field_validator("database", "username")
    @classmethod
    def validate_non_empty(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("Field cannot be empty")
        return value.strip()


class BigQueryConfig(BaseModel):
    """BigQuery connection configuration."""

    project_id: str = Field(..., description="GCP project ID")
    auth_mode: Literal["service_account", "google_oauth"] = "service_account"
    credentials_json: Optional[str] = Field(
        None,
        description="Service account JSON; omit to use platform credential",
    )
    default_dataset: Optional[str] = Field(None, description="Default dataset name")
    google_oauth_user_id: Optional[str] = Field(
        None,
        description="Internal AppBI user id for Google OAuth-backed datasource",
    )
    google_oauth_email: Optional[str] = Field(
        None,
        description="Connected Google account email",
    )
    # --- Near-realtime snapshot materialization (Dashboard perf #5) ---
    # Opt-in. When enabled, each heavy dataset table is materialized into a flat
    # snapshot table in `materialization_dataset`; charts read the flat snapshot.
    # All optional/default-off so existing datasources are unaffected.
    materialization_enabled: bool = Field(
        False,
        description="Materialize dataset tables into flat BQ snapshots for fast dashboards",
    )
    materialization_dataset: Optional[str] = Field(
        None,
        description="BQ dataset that holds snapshot tables (default: appbi_snapshots)",
    )
    materialization_write_credentials_json: Optional[str] = Field(
        None,
        description="Optional separate SA JSON with write on the snapshot dataset; omit to reuse the read credential",
    )
    materialization_default_ttl_minutes: Optional[int] = Field(
        None,
        ge=0,
        description="Default snapshot freshness TTL in minutes (builder + public link fallback)",
    )

    @field_validator("project_id")
    @classmethod
    def validate_project_id(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("Project ID cannot be empty")
        return value.strip()

    @field_validator("credentials_json")
    @classmethod
    def validate_credentials(cls, value: Optional[str]) -> Optional[str]:
        if not value or not value.strip():
            return None
        value = value.strip()
        if not (value.startswith("{") and value.endswith("}")):
            raise ValueError("Credentials must be valid JSON object")
        return value


class GoogleSheetsConfig(BaseModel):
    """Google Sheets connection configuration.

    Extra fields (for example the `sheets` snapshot cache) are preserved so that
    snapshotted sheet data survives the Pydantic validation round-trip.
    """

    model_config = ConfigDict(extra="allow")

    auth_mode: Literal["service_account", "google_oauth"] = "service_account"
    credentials_json: Optional[str] = Field(
        None,
        description="Service account JSON; omit to use platform credential",
    )
    spreadsheet_id: str = Field(..., description="Google Sheets spreadsheet ID")
    sheet_name: Optional[str] = Field(
        None,
        description="Sheet name (optional, uses first sheet if not provided)",
    )
    google_oauth_user_id: Optional[str] = Field(
        None,
        description="Internal AppBI user id for Google OAuth-backed datasource",
    )
    google_oauth_email: Optional[str] = Field(
        None,
        description="Connected Google account email",
    )

    @field_validator("credentials_json")
    @classmethod
    def validate_credentials(cls, value: Optional[str]) -> Optional[str]:
        if not value or not value.strip():
            return None
        value = value.strip()
        if not (value.startswith("{") and value.endswith("}")):
            raise ValueError("Credentials must be valid JSON object")
        return value

    @field_validator("spreadsheet_id")
    @classmethod
    def validate_spreadsheet_id(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("Spreadsheet ID cannot be empty")
        return value.strip()


class ManualConfig(BaseModel):
    """Manual table configuration.

    Accepts both formats and preserves all fields:
      New:    {"sheets": {"SheetName": {"columns": [...], "rows": [...]}, ...}}
      Legacy: {"columns": [...], "rows": [...]}
    """

    model_config = ConfigDict(extra="allow")

    columns: list = Field(default_factory=list)
    rows: list = Field(default_factory=list)


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
        if ds_type_lower == "postgresql":
            validated = PostgreSQLConfig(**config)
        elif ds_type_lower == "mysql":
            validated = MySQLConfig(**config)
        elif ds_type_lower == "bigquery":
            validated = BigQueryConfig(**config)
        elif ds_type_lower == "google_sheets":
            validated = GoogleSheetsConfig(**config)
        elif ds_type_lower == "manual":
            validated = ManualConfig(**config)
        else:
            raise ValueError(f"Unsupported data source type: {ds_type}")

        return validated.model_dump()
    except Exception as exc:
        raise ValueError(f"Invalid configuration for {ds_type}: {str(exc)}")
