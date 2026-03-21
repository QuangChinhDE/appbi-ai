"""
Async HTTP client that calls the BI Backend read-only API.
AI service never issues POST/PUT/DELETE — only GET and targeted preview POSTs.
"""
import httpx
from typing import Any, Dict, List, Optional

from app.config import settings


class BIClient:
    """Thin async wrapper around the BI API."""

    def __init__(self):
        self._base = settings.bi_api_url.rstrip("/")
        self._http = httpx.AsyncClient(timeout=30.0)

    def _auth_headers(self, token: str) -> dict:
        if token:
            return {"Authorization": f"Bearer {token}"}
        return {}

    # ── Charts ─────────────────────────────────────────────────────────────────

    async def list_charts(self, limit: int = 100, token: str = "") -> List[Dict[str, Any]]:
        r = await self._http.get(f"{self._base}/charts/", params={"limit": limit}, headers=self._auth_headers(token))
        r.raise_for_status()
        return r.json()

    async def get_chart(self, chart_id: int, token: str = "") -> Dict[str, Any]:
        r = await self._http.get(f"{self._base}/charts/{chart_id}", headers=self._auth_headers(token))
        r.raise_for_status()
        return r.json()

    async def get_chart_data(self, chart_id: int, token: str = "") -> Dict[str, Any]:
        """Returns {chart: {...}, data: [...]}"""
        r = await self._http.get(f"{self._base}/charts/{chart_id}/data", headers=self._auth_headers(token))
        r.raise_for_status()
        return r.json()

    async def get_chart_metadata(self, chart_id: int, token: str = "") -> Optional[Dict[str, Any]]:
        """Returns chart semantic metadata (domain/intent/metrics/tags) or None."""
        try:
            r = await self._http.get(f"{self._base}/charts/{chart_id}/metadata", headers=self._auth_headers(token))
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.json()
        except Exception:
            return None

    # ── Dashboards ─────────────────────────────────────────────────────────────

    async def list_dashboards(self, token: str = "") -> List[Dict[str, Any]]:
        r = await self._http.get(f"{self._base}/dashboards/", headers=self._auth_headers(token))
        r.raise_for_status()
        return r.json()

    async def get_dashboard(self, dashboard_id: int, token: str = "") -> Dict[str, Any]:
        r = await self._http.get(f"{self._base}/dashboards/{dashboard_id}", headers=self._auth_headers(token))
        r.raise_for_status()
        return r.json()

    # ── Workspaces ─────────────────────────────────────────────────────────────

    async def list_workspaces(self, token: str = "") -> List[Dict[str, Any]]:
        r = await self._http.get(f"{self._base}/dataset-workspaces/", headers=self._auth_headers(token))
        r.raise_for_status()
        return r.json()

    async def get_workspace(self, workspace_id: int, token: str = "") -> Dict[str, Any]:
        """Returns workspace with its tables (including columns)."""
        r = await self._http.get(f"{self._base}/dataset-workspaces/{workspace_id}", headers=self._auth_headers(token))
        r.raise_for_status()
        return r.json()

    async def preview_workspace_table(
        self,
        workspace_id: int,
        table_id: int,
        limit: int = 50,
        token: str = "",
    ) -> Dict[str, Any]:
        r = await self._http.post(
            f"{self._base}/dataset-workspaces/{workspace_id}/tables/{table_id}/preview",
            json={"limit": limit},
            headers=self._auth_headers(token),
        )
        r.raise_for_status()
        return r.json()

    async def execute_table_query(
        self,
        workspace_id: int,
        table_id: int,
        dimensions: Optional[List[str]] = None,
        measures: Optional[List[Dict[str, str]]] = None,
        filters: Optional[List[Dict[str, str]]] = None,
        order_by: Optional[List[Dict[str, str]]] = None,
        limit: int = 100,
        token: str = "",
    ) -> Dict[str, Any]:
        """Run an aggregated query on a workspace table (GROUP BY + aggregations)."""
        body: Dict[str, Any] = {"limit": limit}
        if dimensions:
            body["dimensions"] = dimensions
        if measures:
            body["measures"] = measures
        if filters:
            body["filters"] = filters
        if order_by:
            body["order_by"] = order_by
        r = await self._http.post(
            f"{self._base}/dataset-workspaces/{workspace_id}/tables/{table_id}/execute",
            json=body,
            headers=self._auth_headers(token),
        )
        r.raise_for_status()
        return r.json()

    # ── Datasets ───────────────────────────────────────────────────────────────

    async def list_datasets(self, token: str = "") -> List[Dict[str, Any]]:
        r = await self._http.get(f"{self._base}/datasets/", headers=self._auth_headers(token))
        r.raise_for_status()
        return r.json()

    async def list_datasources(self, token: str = "") -> List[Dict[str, Any]]:
        r = await self._http.get(f"{self._base}/datasources/", headers=self._auth_headers(token))
        r.raise_for_status()
        return r.json()

    async def list_datasource_tables(self, datasource_id: int, token: str = "") -> List[Dict[str, Any]]:
        """List raw tables/sheets available in a datasource."""
        r = await self._http.get(
            f"{self._base}/dataset-workspaces/datasources/{datasource_id}/tables",
            headers=self._auth_headers(token),
        )
        r.raise_for_status()
        return r.json()

    async def execute_datasource_sql(
        self,
        datasource_id: int,
        sql: str,
        limit: int = 200,
        token: str = "",
    ) -> Dict[str, Any]:
        """Execute a SELECT SQL against a datasource. Returns {columns, data, row_count}."""
        r = await self._http.post(
            f"{self._base}/datasources/query",
            json={"data_source_id": datasource_id, "sql_query": sql, "limit": limit},
            headers=self._auth_headers(token),
        )
        r.raise_for_status()
        return r.json()

    async def execute_dataset(
        self,
        dataset_id: int,
        limit: int = 200,
        token: str = "",
    ) -> Dict[str, Any]:
        """Execute a dataset (routes through DuckDB if Parquet-backed)."""
        r = await self._http.post(
            f"{self._base}/datasets/{dataset_id}/execute",
            json={"limit": limit, "apply_transformations": True},
            headers=self._auth_headers(token),
        )
        r.raise_for_status()
        return r.json()

    async def close(self):
        await self._http.aclose()


# Module-level singleton — reused across requests
bi_client = BIClient()
