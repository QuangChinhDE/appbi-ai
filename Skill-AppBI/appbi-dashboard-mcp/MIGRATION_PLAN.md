# AppBI Orchestrator MCP — Migration Plan

Folder này thay thế `appbi-import-source-mcp`. Triết lý: **Claude là LLM duy nhất**. MCP chỉ feed dữ liệu thô và ghi kết quả vào AppBI sau khi user confirm. Backend AppBI **không** được gọi LLM nội bộ trong bất kỳ endpoint nào MCP này dùng.

Folder cũ vẫn giữ nguyên cho luồng HTML import (skill `excel-to-appbi-dashboard`). MCP mới không hỗ trợ HTML import.

## 1. Outcome cuối cùng

Người dùng kết nối 1 datasource → trong cùng 1 phiên Claude Code, Claude tự đi qua 5 stage và xuất ra 1 dashboard hoàn chỉnh, public link sẵn sàng share. Mọi bước sinh nội dung (description, model design, chart suggestion) do Claude làm; mọi bước ghi vào AppBI đều có preview-then-confirm.

## 2. Flow 5 stage

```
Stage 1 — Source
  Tools: list_data_sources, list_source_tables, get_table_profile
  Claude tự: phân loại fact/dim, đoán domain, đoán FK candidates
  Output: bản tóm tắt source trình user

Stage 2 — Dataset
  Tools: create_dataset, add_table_to_dataset, update_table_description,
         update_column_description, set_dataset_dictionary
  Claude tự: viết description bảng + cột, đề xuất common_questions,
             đoán role (fact/dim/bridge)
  Output: dataset đã có description đầy đủ, lưu vào AppBI

Stage 3 — Semantic Model
  Tools: preview_join, create_semantic_view, create_semantic_explore,
         create_semantic_model, list_calc_field_functions
  Claude tự: thiết kế dimensions, measures, joins, calculated fields
  Output: semantic model + explore lưu vào AppBI, có preview join data

Stage 4 — Charts
  Tools: execute_semantic_query, create_chart, update_chart, list_charts
  Claude tự: chọn chart type, config, title, description theo data shape
  Output: bộ chart lưu vào AppBI

Stage 5 — Dashboard
  Tools: create_dashboard, add_charts_to_dashboard (bulk), set_dashboard_layout,
         add_dashboard_filter, create_public_link
  Claude tự: bố cục layout, đặt filter, tiêu đề trang
  Output: dashboard + public link
```

## 3. Pattern preview-then-confirm (bắt buộc)

Mọi tool ghi đều có flow:

```python
@mcp.tool()
async def create_X(..., user_confirmed: bool = False, ctx=None):
    if not user_confirmed:
        return _requires_confirmation("create_X", {
            "what_will_change": {...},   # diff người dùng có thể đọc
            "scope": "...",               # phạm vi tác động
            "reversible": True/False,     # có rollback được không
        })
    return await _request("POST", "/...", json_body=...)
```

Claude **luôn** trình bản preview cho user → user gõ "ok / xác nhận" → Claude gọi lại với `user_confirmed=True`.

Tools ghi cần áp dụng pattern này:
- `create_dataset`, `add_table_to_dataset`, `update_table_description`, `update_column_description`
- `create_semantic_view`, `create_semantic_explore`, `create_semantic_model`
- `create_chart`, `update_chart`
- `create_dashboard`, `add_charts_to_dashboard`, `set_dashboard_layout`, `create_public_link`
- Mọi `delete_*`

Tools đọc thuần (`list_*`, `get_*`, `preview_*`, `execute_semantic_query`) **không** cần confirm.

## 4. Bỏ hoàn toàn (so với MCP cũ)

| Tool cũ | Lý do bỏ |
|---|---|
| `regenerate_table_description`, `preview_table_description` | Gọi LLM nội bộ AppBI → Claude tự viết |
| `regenerate_chart_description` | LLM nội bộ → Claude tự viết |
| `ai_suggest_quality_rule` | LLM nội bộ → Claude tự viết |
| `ai_chart_preview` | LLM nội bộ → Claude tự đề xuất config |
| Mọi tool HTML import (`prepare_html_preview`, `validate_html_metadata`, `commit_html_build_batch`, `dry_run_import_html_build`...) | Triết lý mới không qua HTML trung gian |
| AI Chat / AI Agent / Workboards / Anomaly | Đã bỏ ở MCP cũ, giữ nguyên |

## 5. Tool surface MCP mới — target ~60-70 tool

Tổ chức module:

```
appbi_orchestrator_mcp.py        # entry point
appbi_core.py                    # FastMCP instance, _request, _requires_confirmation, env
appbi_source.py                  # Stage 1 (~8 tools)
appbi_dataset.py                 # Stage 2 (~14 tools)
appbi_semantic.py                # Stage 3 (~14 tools)
appbi_chart.py                   # Stage 4 (~10 tools)
appbi_dashboard.py               # Stage 5 (~14 tools)
appbi_quality.py                 # Optional, không có ai_suggest (~6 tools)
appbi_sharing.py                 # Cross-resource share (~4 tools)
```

Chi tiết từng tool sẽ liệt kê trong `TOOL_SURFACE.md` (viết ở bước tiếp theo).

## 6. Endpoint backend cần thêm (theo ưu tiên)

P0 (làm trước khi có tool tương ứng trong MCP):

- `POST /datasets/{id}/tables/{tid}/profile` — gộp schema + sample rows + column stats trong 1 call. **Không** đụng LLM. Tận dụng logic preview + column summary đã có.

P1 (làm sau khi MCP MVP chạy được):

- `POST /datasets/{id}/tables/{tid}/join-preview` — body `{target_table_id, join_on}`, trả 20 sample rows của join. Để Claude/user verify trước khi tạo semantic explore.
- `POST /dashboards/{id}/charts/bulk` — bulk add charts vào dashboard 1 call. Nếu defer thì MCP gọi loop từng cái.

P2 (defer, có thì tốt):

- `POST /semantic/relationship-candidates` — backend đề xuất FK candidates dựa schema + value overlap. Trong khi chờ, Claude tự đoán dựa `get_table_profile`.

## 7. Auth & permission

MCP gọi backend qua PAT. Endpoint mới ở backend phải tuân thủ pattern hiện có:

```python
def endpoint(...,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("datasets", "edit")),
):
    require_view_access(db, current_user, dataset_obj, "datasets")
    ...
```

Reference: `backend/app/api/charts.py:484-507`, `backend/app/core/dependencies.py:246-419`.

PAT scopes cần: `data_sources=edit`, `datasets=edit`, `dashboards=edit` (giống MCP cũ).

## 8. Hạ tầng tái sử dụng từ MCP cũ

Copy nguyên xi từ `appbi_mcp_core.py`:
- Env loading + `APPBI_API_BASE_URL`, `APPBI_PAT`
- `_request(method, path, json_body=, params=, expect_json=)` — httpx async wrapper
- `_requires_confirmation(action, details)` — preview-then-confirm helper
- Logger setup
- Health check tool

Bỏ:
- Toàn bộ logic HTML/Excel parsing (`profile_workbook`, `validate_html`, ~400 dòng)
- Multi-page batch flow (`commit_html_build_batch`, `_auto_fix_single_analysis`, ~300 dòng)

Mục tiêu: `appbi_core.py` mới ~600 dòng (so với 1629 dòng cũ).

## 9. Skill prompt

Tạo `Skill-AppBI/appbi-source-to-report/SKILL.md` (folder riêng, độc lập với MCP folder). Nội dung:
- Hướng dẫn Claude flow 5 stage
- Bắt buộc preview-then-confirm
- Cấm gọi tool LLM nội bộ AppBI (cũ) nếu user lỡ kích hoạt cả 2 MCP
- Template trình bày output cho mỗi stage

## 10. Thứ tự triển khai

1. **Audit MCP cũ + khảo sát backend** → DONE
2. **Viết MIGRATION_PLAN.md + TOOL_SURFACE.md** → đang làm
3. **Scaffold folder**: `appbi_orchestrator_mcp.py`, `appbi_core.py`, các stub module → user review
4. **Thêm endpoint P0 vào backend**: `/datasets/{id}/tables/{tid}/profile` → user review
5. **Implement Stage 1 + Stage 2 tools** → test end-to-end với 1 datasource thật
6. **Implement Stage 3** → test tạo được semantic model
7. **Implement Stage 4 + 5** → test ra dashboard hoàn chỉnh
8. **Viết SKILL.md + setup scripts (run-mcp.ps1, .env.example)** → handoff

Mỗi mốc 3-7 sẽ pause để user review trước khi đi tiếp.

## 11. Quyết định chốt từ user

- Tên folder: `appbi-orchestrator-mcp` ✓
- Outcome: dashboard hoàn chỉnh, MCP chủ động dẫn dắt ✓
- Được phép sửa `backend/app/api/`, tuân thủ permission pattern ✓
- Bỏ HTML import trong MCP mới ✓
- Skill folder riêng ✓
