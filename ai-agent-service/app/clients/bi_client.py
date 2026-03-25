"""Async BI API client for AI Agent service."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx

from app.config import settings


class BIClient:
    def __init__(self):
        self._base = settings.bi_api_url.rstrip("/")
        self._http = httpx.AsyncClient(timeout=60.0)

    def _auth_headers(self, token: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {token}"} if token else {}

    async def get_my_permissions(self, token: str) -> Dict[str, Any]:
        response = await self._http.get(
            f"{self._base}/permissions/me",
            headers=self._auth_headers(token),
        )
        response.raise_for_status()
        return response.json()

    async def get_workspace(self, workspace_id: int, token: str) -> Dict[str, Any]:
        response = await self._http.get(
            f"{self._base}/dataset-workspaces/{workspace_id}",
            headers=self._auth_headers(token),
        )
        response.raise_for_status()
        return response.json()

    async def preview_workspace_table(
        self,
        workspace_id: int,
        table_id: int,
        limit: int = 40,
        token: str = "",
    ) -> Dict[str, Any]:
        response = await self._http.post(
            f"{self._base}/dataset-workspaces/{workspace_id}/tables/{table_id}/preview",
            json={"limit": limit},
            headers=self._auth_headers(token),
        )
        response.raise_for_status()
        return response.json()

    async def get_table_description(
        self,
        workspace_id: int,
        table_id: int,
        token: str,
    ) -> Dict[str, Any]:
        response = await self._http.get(
            f"{self._base}/dataset-workspaces/{workspace_id}/tables/{table_id}/description",
            headers=self._auth_headers(token),
        )
        response.raise_for_status()
        return response.json()

    async def create_chart(
        self,
        *,
        name: str,
        description: Optional[str],
        workspace_table_id: int,
        chart_type: str,
        config: Dict[str, Any],
        token: str,
    ) -> Dict[str, Any]:
        response = await self._http.post(
            f"{self._base}/charts/",
            json={
                "name": name,
                "description": description,
                "workspace_table_id": workspace_table_id,
                "chart_type": chart_type.upper(),
                "config": config,
            },
            headers=self._auth_headers(token),
        )
        response.raise_for_status()
        return response.json()

    async def get_chart_data(self, chart_id: int, token: str) -> Dict[str, Any]:
        response = await self._http.get(
            f"{self._base}/charts/{chart_id}/data",
            headers=self._auth_headers(token),
        )
        response.raise_for_status()
        return response.json()

    async def create_dashboard(
        self,
        *,
        name: str,
        description: Optional[str],
        token: str,
    ) -> Dict[str, Any]:
        response = await self._http.post(
            f"{self._base}/dashboards/",
            json={"name": name, "description": description or "", "charts": []},
            headers=self._auth_headers(token),
        )
        response.raise_for_status()
        return response.json()

    async def update_dashboard(
        self,
        dashboard_id: int,
        *,
        name: Optional[str],
        description: Optional[str],
        token: str,
    ) -> Dict[str, Any]:
        response = await self._http.put(
            f"{self._base}/dashboards/{dashboard_id}",
            json={"name": name, "description": description},
            headers=self._auth_headers(token),
        )
        response.raise_for_status()
        return response.json()

    async def add_chart_to_dashboard(
        self,
        dashboard_id: int,
        chart_id: int,
        layout: Dict[str, Any],
        token: str,
    ) -> Dict[str, Any]:
        response = await self._http.post(
            f"{self._base}/dashboards/{dashboard_id}/charts",
            json={"chart_id": chart_id, "layout": layout, "parameters": {}},
            headers=self._auth_headers(token),
        )
        response.raise_for_status()
        return response.json()

    async def remove_chart_from_dashboard(
        self,
        dashboard_id: int,
        chart_id: int,
        token: str,
    ) -> Dict[str, Any]:
        response = await self._http.delete(
            f"{self._base}/dashboards/{dashboard_id}/charts/{chart_id}",
            headers=self._auth_headers(token),
        )
        response.raise_for_status()
        return response.json()

    async def update_dashboard_layout(
        self,
        dashboard_id: int,
        chart_layouts: List[Dict[str, Any]],
        token: str,
    ) -> Dict[str, Any]:
        response = await self._http.put(
            f"{self._base}/dashboards/{dashboard_id}/layout",
            json={"chart_layouts": chart_layouts},
            headers=self._auth_headers(token),
        )
        response.raise_for_status()
        return response.json()

    async def get_dashboard(self, dashboard_id: int, token: str) -> Dict[str, Any]:
        response = await self._http.get(
            f"{self._base}/dashboards/{dashboard_id}",
            headers=self._auth_headers(token),
        )
        response.raise_for_status()
        return response.json()

    async def update_agent_report_run(
        self,
        *,
        spec_id: int,
        run_id: int,
        payload: Dict[str, Any],
        token: str,
    ) -> Dict[str, Any]:
        response = await self._http.patch(
            f"{self._base}/agent-report-specs/{spec_id}/runs/{run_id}",
            json=payload,
            headers=self._auth_headers(token),
        )
        response.raise_for_status()
        return response.json()

    async def close(self):
        await self._http.aclose()


bi_client = BIClient()
