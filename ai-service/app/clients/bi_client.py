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

    # ── Charts ─────────────────────────────────────────────────────────────────

    async def list_charts(self, limit: int = 100) -> List[Dict[str, Any]]:
        r = await self._http.get(f"{self._base}/charts/", params={"limit": limit})
        r.raise_for_status()
        return r.json()

    async def get_chart(self, chart_id: int) -> Dict[str, Any]:
        r = await self._http.get(f"{self._base}/charts/{chart_id}")
        r.raise_for_status()
        return r.json()

    async def get_chart_data(self, chart_id: int) -> Dict[str, Any]:
        """Returns {chart: {...}, data: [...]}"""
        r = await self._http.get(f"{self._base}/charts/{chart_id}/data")
        r.raise_for_status()
        return r.json()

    async def get_chart_metadata(self, chart_id: int) -> Optional[Dict[str, Any]]:
        """Returns chart semantic metadata (domain/intent/metrics/tags) or None."""
        try:
            r = await self._http.get(f"{self._base}/charts/{chart_id}/metadata")
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.json()
        except Exception:
            return None

    # ── Dashboards ─────────────────────────────────────────────────────────────

    async def list_dashboards(self) -> List[Dict[str, Any]]:
        r = await self._http.get(f"{self._base}/dashboards/")
        r.raise_for_status()
        return r.json()

    async def get_dashboard(self, dashboard_id: int) -> Dict[str, Any]:
        r = await self._http.get(f"{self._base}/dashboards/{dashboard_id}")
        r.raise_for_status()
        return r.json()

    # ── Workspaces ─────────────────────────────────────────────────────────────

    async def list_workspaces(self) -> List[Dict[str, Any]]:
        r = await self._http.get(f"{self._base}/dataset-workspaces/")
        r.raise_for_status()
        return r.json()

    async def get_workspace(self, workspace_id: int) -> Dict[str, Any]:
        """Returns workspace with its tables (including columns)."""
        r = await self._http.get(f"{self._base}/dataset-workspaces/{workspace_id}")
        r.raise_for_status()
        return r.json()

    async def preview_workspace_table(
        self,
        workspace_id: int,
        table_id: int,
        limit: int = 50,
    ) -> Dict[str, Any]:
        r = await self._http.post(
            f"{self._base}/dataset-workspaces/{workspace_id}/tables/{table_id}/preview",
            json={"limit": limit},
        )
        r.raise_for_status()
        return r.json()

    # ── Datasets ───────────────────────────────────────────────────────────────

    async def list_datasets(self) -> List[Dict[str, Any]]:
        r = await self._http.get(f"{self._base}/datasets/")
        r.raise_for_status()
        return r.json()

    async def close(self):
        await self._http.aclose()


# Module-level singleton — reused across requests
bi_client = BIClient()
