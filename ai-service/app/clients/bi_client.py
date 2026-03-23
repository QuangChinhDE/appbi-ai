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

    async def search_similar_charts(
        self, query: str, limit: int = 10, token: str = ""
    ) -> List[Dict[str, Any]]:
        """Vector similarity search. Returns list of {id, name, chart_type, similarity}."""
        try:
            r = await self._http.get(
                f"{self._base}/charts/search",
                params={"q": query, "limit": limit},
                headers=self._auth_headers(token),
            )
            if r.status_code in (404, 422, 500):
                return []
            r.raise_for_status()
            return r.json()
        except Exception:
            return []

    async def search_similar_tables(
        self, query: str, limit: int = 5, token: str = ""
    ) -> List[Dict[str, Any]]:
        """Vector similarity search over workspace tables. Returns list of {id, workspace_id, display_name, columns, similarity}."""
        try:
            r = await self._http.get(
                f"{self._base}/dataset-workspaces/tables/search",
                params={"q": query, "limit": limit},
                headers=self._auth_headers(token),
            )
            if r.status_code in (404, 422, 500):
                return []
            r.raise_for_status()
            return r.json()
        except Exception:
            return []

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

    # ── AI chart / dashboard creation ──────────────────────────────────────────

    async def ai_chart_preview(
        self,
        workspace_table_id: int,
        chart_type: str,
        config: Dict[str, Any],
        name: str = "AI Chart",
        description: Optional[str] = None,
        save: bool = False,
        token: str = "",
    ) -> Dict[str, Any]:
        """Execute AI chart config and optionally save. Returns {data, chart_type, config, chart_id?, saved}."""
        r = await self._http.post(
            f"{self._base}/charts/ai-preview",
            json={
                "workspace_table_id": workspace_table_id,
                "chart_type": chart_type,
                "config": config,
                "name": name,
                "description": description,
                "save": save,
            },
            headers=self._auth_headers(token),
        )
        r.raise_for_status()
        return r.json()

    async def create_chart(
        self,
        name: str,
        workspace_table_id: int,
        chart_type: str,
        config: Dict[str, Any],
        description: Optional[str] = None,
        token: str = "",
    ) -> Dict[str, Any]:
        """Create a saved chart. Returns ChartResponse."""
        r = await self._http.post(
            f"{self._base}/charts/",
            json={
                "name": name,
                "workspace_table_id": workspace_table_id,
                "chart_type": chart_type.upper(),
                "config": config,
                "description": description,
            },
            headers=self._auth_headers(token),
        )
        r.raise_for_status()
        return r.json()

    async def create_dashboard(
        self,
        name: str,
        description: Optional[str] = None,
        token: str = "",
    ) -> Dict[str, Any]:
        """Create a new dashboard. Returns DashboardResponse."""
        r = await self._http.post(
            f"{self._base}/dashboards/",
            json={"name": name, "description": description or ""},
            headers=self._auth_headers(token),
        )
        r.raise_for_status()
        return r.json()

    async def add_chart_to_dashboard(
        self,
        dashboard_id: int,
        chart_id: int,
        layout: Optional[Dict[str, Any]] = None,
        token: str = "",
    ) -> Dict[str, Any]:
        """Add chart to dashboard. Returns updated DashboardResponse."""
        r = await self._http.post(
            f"{self._base}/dashboards/{dashboard_id}/charts",
            json={"chart_id": chart_id, "layout": layout or {}},
            headers=self._auth_headers(token),
        )
        r.raise_for_status()
        return r.json()

    async def update_dashboard_layout(
        self,
        dashboard_id: int,
        layouts: List[Dict[str, Any]],
        token: str = "",
    ) -> Dict[str, Any]:
        """Update dashboard chart layout grid. Returns DashboardResponse."""
        r = await self._http.put(
            f"{self._base}/dashboards/{dashboard_id}/layout",
            json={"layouts": layouts},
            headers=self._auth_headers(token),
        )
        r.raise_for_status()
        return r.json()

    async def close(self):
        await self._http.aclose()

    # ── Chat session persistence ───────────────────────────────────────────────

    async def upsert_chat_session(
        self, session_id: str, title: str, owner_user_id: str, token: str = ""
    ) -> None:
        """Create or update a chat session record in the backend DB."""
        try:
            await self._http.post(
                f"{self._base}/chat-sessions",
                json={"session_id": session_id, "title": title, "owner_user_id": owner_user_id},
                headers=self._auth_headers(token),
            )
        except Exception:
            pass  # persistence is best-effort — never break the chat flow

    async def load_chat_session(self, session_id: str, token: str = "") -> Optional[Dict[str, Any]]:
        """Load a persisted session from backend DB. Returns None if not found/accessible."""
        try:
            r = await self._http.get(
                f"{self._base}/chat-sessions/{session_id}",
                headers=self._auth_headers(token),
            )
            if r.status_code in (403, 404):
                return None
            r.raise_for_status()
            return r.json()
        except Exception:
            return None

    async def list_chat_sessions(self, token: str = "") -> List[Dict[str, Any]]:
        """List persisted sessions for the authenticated user."""
        try:
            r = await self._http.get(
                f"{self._base}/chat-sessions",
                headers=self._auth_headers(token),
            )
            r.raise_for_status()
            return r.json()
        except Exception:
            return []

    async def delete_chat_session(self, session_id: str, token: str = "") -> None:
        """Delete a persisted session from the backend DB."""
        try:
            await self._http.delete(
                f"{self._base}/chat-sessions/{session_id}",
                headers=self._auth_headers(token),
            )
        except Exception:
            pass

    async def append_chat_messages(
        self, session_id: str, messages: List[Dict[str, Any]], token: str = ""
    ) -> None:
        """Persist a batch of new messages to the backend DB (best-effort)."""
        if not messages:
            return
        try:
            await self._http.post(
                f"{self._base}/chat-sessions/{session_id}/messages",
                json={"messages": messages},
                headers=self._auth_headers(token),
            )
        except Exception:
            pass

    async def update_chat_feedback(
        self,
        session_id: str,
        message_id: str,
        rating: str,
        comment: Optional[str],
        token: str = "",
    ) -> None:
        """Persist thumbs up/down feedback to backend DB."""
        try:
            await self._http.put(
                f"{self._base}/chat-sessions/{session_id}/messages/{message_id}/feedback",
                json={"rating": rating, "comment": comment},
                headers=self._auth_headers(token),
            )
        except Exception:
            pass

bi_client = BIClient()
