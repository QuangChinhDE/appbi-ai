# AI Agent — Known Issues (for AI Team Review)

> Discovered during full-system testing (2026-03-23).
> These issues are in the `ai-service/` layer. Backend and frontend are unaffected.

---

## Issue 1 — Count queries always return 0 rows

**Severity**: High
**File**: `ai-service/app/clients/bi_client.py` — `execute_table_query()`

**Symptom**: When the AI is asked to count records (e.g. "how many rows are in this table?"), the tool returns 0 rows despite data being present.

**Root cause**: `bi_client.py` sends measure aggregations using the field name `"agg"`:
```python
{"field": "key", "agg": "count"}
```

But the backend's execute endpoint (`POST /dataset-workspaces/{ws}/tables/{tbl}/execute`) requires the field to be named `"function"`:
```python
{"field": "key", "function": "count"}
```

The backend returns HTTP 422 validation error, and `execute_table_query()` silently returns `{"rows": []}`.

**Fix**: In `bi_client.py`, rename the `agg` key to `function` when building the measures list.

---

## Issue 2 — Chat session and message IDs are None

**Severity**: Medium
**File**: `ai-service/` — session persistence layer

**Symptom**: `GET /chat/sessions` returns items with `"id": null`. `GET /chat/sessions/{session_id}` returns messages with `"id": null`. The feedback endpoint (`POST /chat/feedback`) requires a valid `message_id` UUID, so feedback cannot be submitted.

**Root cause**: Session and message objects are not persisted with stable IDs. The IDs appear to be generated in-memory but not saved/returned correctly by the session storage layer.

**Fix**: Ensure session and message records are written to persistent storage with their generated UUIDs before the response is returned. The `id` fields must be non-null for the feedback flow to work end-to-end.

---

## Tested and working ✅

For reference, the following AI Agent features were confirmed working correctly:

- WebSocket connection (`GET /chat/ws?token=<jwt>`)
- HTTP SSE stream (`POST /chat/stream`)
- `list_workspaces` tool
- `list_workspace_tables` tool
- `get_table_schema` tool
- `get_sample_data` tool
- `query_table` tool (works for `sum`/`avg`/`min`/`max` — broken for `count`, see Issue 1)
- `search_charts` tool
- `get_chart_data` tool
- `create_chart` tool — successfully creates and saves charts to the backend
- `analyze_field` tool
- Multi-turn context within a session
- Graceful handling of invalid workspace/table references
