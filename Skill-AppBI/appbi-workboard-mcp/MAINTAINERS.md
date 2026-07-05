# Maintaining & upgrading the AppBI Workboard MCP

This is the guide for the person who **clones this MCP, drives it with an AI to
build AppBI Workboards, hits an error, and needs to fix/upgrade the MCP on their
own machine.** README.md covers *using* it — this covers *debugging it* and
*extending it safely*.

> TL;DR mental model: **the AppBI backend is the single source of truth.** The
> MCP is (1) a set of thin tools that call backend endpoints and (2) a big
> *design guide + pre-check validator* that teaches the AI what to emit. Most
> "the MCP can't build feature X" problems are a **docs gap in the design
> guide**, not missing code — because `apply` sends your `layout_json` straight
> to the backend, which already understands every current feature.

---

## 1. Architecture in one screen

```
AI (your client)                    this MCP                         AppBI backend
──────────────────      ─────────────────────────────      ──────────────────────────
reads get_workboard_    ┌─ design guide (_SCREEN_SCHEMA_    POST/PATCH /workboards/
  design_guide()  ─────▶│    REFERENCE + screen_rules)      → Pydantic LayoutJson  ← REAL GATE
authors a "bundle"      │                                    (extra="forbid": unknown
validate_workboard_ ───▶├─ _validate_bundle()  (PRE-CHECK    key => 422)
  bundle(bundle)        │    only: column/table/webhook/     → persists, publishes,
apply_workboard_   ────▶│    lookup/doc reference checks)    upserts users, links ws
  bundle(...,            │                                    → audit + runtime
  user_confirmed) ──────┴─ _request() ─ Bearer PAT ─────────▶  smoke test
```

Key files (see README "Files" table for the full list):

| Concern | File | What lives here |
|---|---|---|
| HTTP + auth + errors + tool registration | `appbi_wb_core.py` | `_request`, `BackendError`, `_backend_error_envelope`, `@tool`, profiles, `.env` load |
| **Workboard bundle: guide + validate + apply** | `appbi_wb_build.py` | `_SCREEN_SCHEMA_REFERENCE`, `get_workboard_design_guide`, `_validate_screen_columns`/`_validate_bundle`, `_workboard_create/update_body`, `apply_workboard_bundle` |
| Stage 3 helpers | `appbi_wb_authoring.py` | `test_screen_js`, `audit_workboard`, export, public links |
| Source / Dataset / Model | `appbi_wb_source.py` / `_dataset.py` / `_model.py` | Stages 0–2 |
| Users / Webhooks / Workspace | `appbi_wb_users.py` / `_webhooks.py` / `_workspace.py` | delivery + `run_workboard_runtime_smoke_test` |
| Entry point | `appbi_workboard_mcp.py` | imports every module so their `@tool`s register |

**The golden rule:** never re-implement backend validation in the MCP. The MCP's
`_validate_bundle` is a *convenience pre-check* to give the AI fast, specific
feedback; the backend Pydantic schema is what actually decides. `validate`'s own
return says so: `"backend_gate": "apply still passes layout through backend
Pydantic schemas and audit."`

---

## 2. How errors reach you (three layers)

When a build fails, first identify **which layer** rejected it — the fix location
depends entirely on this.

### Layer A — MCP pre-check (`validate_workboard_bundle`)
Returns `{ ok: false, errors: [...], warnings: [...], summary, ... }`. These are
**reference** problems the MCP can see without the backend: a screen `table_id`
not in the dataset, a `columns`/`editable_columns` name that isn't a real column,
a lookup pointing at an unattached table, a doc `sync_trigger` webhook id with no
matching `bundle.webhooks` entry, an RLS `filter_column` that doesn't exist.
→ Fix the **bundle**, or (if the check is wrong for a *new* valid shape) fix the
**validator** (§4 Case B).

### Layer B — backend gate (`apply_workboard_bundle` → `/workboards/`)
Any tool that calls the backend wraps failures into a **structured envelope**
(`appbi_wb_core.py::_backend_error_envelope`):

```json
{
  "status": "backend_error",
  "method": "POST", "path": "/workboards/",
  "status_code": 422,
  "detail": "... Pydantic error naming the exact field path ...",
  "claude_should": "Fix request payload or permissions before retrying."
}
```

Read `status_code` + `detail`:

| status_code | Meaning | Where the fix goes |
|---|---|---|
| **422** | Payload violates a backend Pydantic schema. `detail` names the **exact path** (e.g. `screens.2.gallery_config → extra_forbidden`, or `...form.fields.4.widget → literal_error`). | Usually the **bundle** is wrong; if the backend genuinely supports the field but the AI never emitted it, it's a **design-guide gap** (§4 Case A). `extra_forbidden` = you sent a key the backend doesn't define **or** put it at the wrong level. |
| **403** | PAT missing a scope, or publish/share blocked by owner-PIN. | Fix `.env` PAT scopes, or set a non-default `workboard.owner_pin`. |
| **404** | id doesn't exist (dataset/table/dashboard). | Re-inspect ids with `inspect_dataset_for_workboard` / `list_dataset_tables`. |
| **409** | Conflict (e.g. slug taken, optimistic lock). | Change slug / re-fetch and retry. |
| **500** | Backend bug or unhandled case. `claude_should` = "inspect AppBI logs". | Reproduce with curl (§3), read backend logs; this is a backend fix, not an MCP fix. |

### Layer C — runtime (after apply)
The bundle applied but the app misbehaves. Verify with:
- `audit_workboard(workboard_id)` — broken references, dangling screens.
- `run_workboard_runtime_smoke_test(...)` — logs in as an app user and renders
  each screen, surfacing render-time errors (bad RLS column, empty screen, etc.).

---

## 3. The debugging loop (do this when a build fails)

1. **Reproduce cheaply.** Re-run just `validate_workboard_bundle(bundle)`. If it
   returns errors, you never needed the backend — fix those first.
2. **Read the envelope.** If `apply` returned `status: "backend_error"`, the
   `detail` **is** the answer — Pydantic names the offending `screens.N.field`.
   Map that path back to the bundle.
3. **Confirm against the live contract.** Call `get_workboard_design_guide()` and
   check the field under `screen_schema_reference`. If the field you sent is not
   there, either you invented it (fix the bundle) or the backend added it and the
   guide is stale (§4 Case A).
4. **Reproduce against the backend directly** when `detail` is vague or it's a
   500. Use the same PAT the MCP uses:
   ```bash
   # health / identity
   curl -s -H "Authorization: Bearer $APPBI_PAT" $APPBI_BASE_URL/api/v1/auth/me
   # replay the exact create the MCP does
   curl -s -X POST -H "Authorization: Bearer $APPBI_PAT" \
        -H "Content-Type: application/json" \
        -d @bundle_workboard_body.json \
        $APPBI_BASE_URL/api/v1/workboards/
   ```
   (`_workboard_create_body(bundle)` / `_workboard_update_body(bundle)` in
   `appbi_wb_build.py` show the exact JSON shape sent.)
5. **Turn up logging.** Set `APPBI_MCP_LOG_LEVEL=DEBUG` in `.env` and restart the
   MCP; every tool logs the backend method/path/status on failure to stderr.
6. **If you have the backend source**, the schema is the truth:
   `backend/app/modules/workboards/schemas.py` — `LayoutJson`, `Screen`,
   `FormField`, `TableScreenSpec`, `BrandingConfig`, `TableColumnMeta`, etc.
   (all `model_config = ConfigDict(extra="forbid")`). If you don't have it, the
   422 `detail` path + the design guide are enough.

### Common failures → cause → fix

| Symptom | Cause | Fix |
|---|---|---|
| `422 ... extra_forbidden` on a screen field | Field not defined at that level in the backend schema (or wrong nesting, e.g. `gallery_config` put at screen root instead of inside `table`). | Move/remove the key; if backend supports it, add it to the guide (§4A). |
| `422 ... widget → literal_error` | Widget string not in the backend `FormField.widget` enum. | Use a listed widget; if backend added a new one, extend the guide's widget list (§4A). |
| `validate` error: "table_id must point to the selected dataset" | Used a **source** table id, not an **attached dataset table** id. | Use ids from `inspect_dataset_for_workboard` / `list_dataset_tables`. |
| `validate` error: column not found | Column name typo, or `columns_cache` empty because the table was never profiled. | Run `get_table_profile` on the table, then use exact column names. |
| 500 on a table screen render (smoke test): `column "miniapp_user" does not exist` | An RLS rule / `rls_default` filters by `miniapp_user` but the bound table has no such column. | Set that screen's `rls_default` to `{unrestricted: true, ...}` or add the column. |
| Publish/share silently skipped | `workboard.owner_pin` unset or an owner app_user still on default PIN `123456`. | Set a non-default `owner_pin`; give owner users a non-default pin. |
| Workspace link fails | `workboard.slug` missing (menus key by slug). | Always set `slug` when delivering via a workspace. |
| Screen created but not in the portal nav | Screen id absent from `layout_json.mini_app_nav.items` (explicit list wins over `show_in_nav`). | Add the screen id to `mini_app_nav.items`. |
| Google Sheets table not found | `source_table_name` included the spreadsheet id. | Use the **tab name only** (`"DM_SanPham"`). |

---

## 4. Upgrading the MCP for a new/changed Workboard feature

When the AppBI runtime gains a capability (a new widget, a new table option, a
theming field…), decide which of these three cases you're in.

### Case A — backend already supports it; the AI just doesn't emit it *(most common)*
Because `apply` passes `layout_json` through untouched, a documented feature
works end-to-end the moment the guide describes it. **You only edit
`appbi_wb_build.py`:**

1. Add the field to the right block of **`_SCREEN_SCHEMA_REFERENCE`**
   (`form_field`, `table_spec`, `layout_top_level.branding`, `column_metadata`,
   etc.) — name it, give allowed values, one-line semantics.
2. Add a one-line entry to **`screen_rules`** (inside `get_workboard_design_guide`)
   telling the AI *when* to use it.
3. If it helps, extend the **`starter_bundle`** with a concrete example.
4. Nothing else. Do **not** add it to `_validate_*` unless it carries a
   *reference* (a column/table/webhook id) that should be checked (see Case B).

Example (already in this file): adding `rating`/`slider`/`currency`… widgets was
purely widget-list + `rich_field_config` + a `screen_rules` line; typed table
cells were a `column_metadata.input_type` note + a rule.

### Case B — the MCP pre-check falsely rejects a valid new shape
`_validate_screen_columns` / `_validate_bundle` in `appbi_wb_build.py` cross-check
references. If a new construct introduces columns the AI can legitimately use
(e.g. a new derived-column kind), the validator may flag them as "not a real
column". Fix by teaching the validator they exist:
- Derived/virtual names go into the `derived` set (see how `computed_columns`,
  `lookup_columns`, `rollup_columns` names are collected around
  `_validate_screen_columns`).
- Add reference checks for a new construct only if it points at a table/column/
  webhook (mirror the `lookup_columns` / `rollup_columns` / `format_rules`
  blocks). Keep checks **additive and lenient** — a false *reject* blocks a valid
  build, which is worse than a missed pre-check (the backend still gates).

### Case C — a genuinely new backend endpoint / capability
Add a tool. The pattern (see any tool in the stage modules):
```python
from appbi_wb_core import tool, _request, _requires_confirmation, Context

@tool("build")                      # profile gate: discover|source|dataset|model|build|deliver
async def do_something(arg: int, user_confirmed: bool = False,
                       ctx: Context | None = None) -> dict:
    """One-line description the AI reads."""
    plan = {...}
    if not user_confirmed:          # mutating tools MUST preview first
        return _requires_confirmation("do_something", plan)
    return await _request("POST", f"/workboards/{arg}/something", json_body={...})
```
Rules: read-only tools tag `discover`; mutating tools require `user_confirmed` and
return `_requires_confirmation(...)` until approved; always go through `_request`
(never a bare `httpx` call) so backend errors become the structured envelope; then
add the tool's file to `appbi_workboard_mcp.py` imports if it's a new module.

### Keeping the guide in sync with the backend
The design guide is hand-maintained, so it can drift. To catch drift:
- Diff the guide's widget list / field names against the backend enums in
  `backend/app/modules/workboards/schemas.py` (if you have it).
- Or, empirically: author a bundle that uses the feature, `apply` it; a `422
  extra_forbidden`/`literal_error` means the backend does **not** support it yet
  (don't document it); a clean apply + working smoke test means it's real
  (document it). **Never document a field the backend rejects** — it just makes
  the AI produce invalid bundles.

---

## 5. Test your MCP change before shipping

1. **Parse**: `python -c "import ast; ast.parse(open('appbi_wb_build.py',encoding='utf-8').read())"`.
2. **Boot**: restart the MCP; `health_check` must return `status: ok` (proves
   `.env` + PAT + connectivity).
3. **Guide**: call `get_workboard_design_guide()` and eyeball your new
   entry/rule renders.
4. **Round-trip**: author a tiny bundle that exercises the change →
   `validate_workboard_bundle` (expect `ok: true`) → `apply_workboard_bundle(...,
   user_confirmed=true)` against a **local/test AppBI** → `audit_workboard` →
   `run_workboard_runtime_smoke_test`. Green across all four = the feature builds
   end-to-end.
5. If you touch shared plumbing (`appbi_wb_core.py`), re-run `health_check` and at
   least one tool per profile.

---

## 6. Conventions & gotchas (learned the hard way)

- **Backend is the gate; the MCP is docs + thin calls.** Prefer fixing the guide
  over adding MCP-side validation.
- **Don't delete a tool/field just because the AI misused it** — verify the
  backend endpoint/field is truly gone first (a live call), or you break a real
  capability.
- **`extra="forbid"` everywhere on the backend** means every key you document
  must exist at exactly the right nesting level. Wrong level = `extra_forbidden`.
- **Line endings**: keep files LF. On Windows, `git` may warn "LF will be replaced
  by CRLF" — that's fine; commit with the repo's `.gitattributes` normalisation.
- **This MCP ships on the `master` branch** (runtime code ships on `demo`). When
  you push an MCP change, target `master`.
- **Profiles**: a tool won't appear if `APPBI_MCP_PROFILE` excludes its tag. If a
  tool "doesn't exist", check the profile before assuming a bug (`all` = default).
- **Never persist secrets in the guide/examples**: PATs live only in `.env`;
  OCR/API tokens are BYOK and encrypted server-side.

---

## 7. Where to look first, by task

| I want to… | Open |
|---|---|
| Change what the AI is told it can build | `appbi_wb_build.py` → `_SCREEN_SCHEMA_REFERENCE` + `get_workboard_design_guide.screen_rules` |
| Fix a false "column not found" pre-check | `appbi_wb_build.py` → `_validate_screen_columns` / `_validate_bundle` |
| Change what `apply` sends to the backend | `appbi_wb_build.py` → `_workboard_create_body` / `_workboard_update_body` / `apply_workboard_bundle` |
| Add/adjust HTTP, auth, error envelope, profiles | `appbi_wb_core.py` |
| Add a Stage 0–2 (source/dataset/model) tool | the matching `appbi_wb_source/_dataset/_model.py` |
| Debug a live failure | `health_check` → `validate_workboard_bundle` → read `backend_error.detail` → `audit_workboard` → `run_workboard_runtime_smoke_test`; `APPBI_MCP_LOG_LEVEL=DEBUG` for wire logs |
