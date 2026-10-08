# Agent Flow specialized agents — spec

## Behaviour

- **Node Library.** "Specialized agents" tiles sit beside AI Agent. One click adds
  an Agent step with that role's default tools, instructions and name.
- **Inspector.** A Role card shows purpose, what the step takes, what it hands on,
  when a deterministic node is better, and the tool limit. The Tool Picker shows
  only the role's allowed tools, and Skills are hidden. Switching role drops grants
  the new role does not allow and lists them. Answer Writer shows "no tools".
- **"Reads results from".** Pick earlier steps. The default is the step before.
  A chip turns red if the step it names no longer runs earlier.
- **Canvas.** A role badge, and a `← step, step` chip when `reads_from` is set.
- **Run Trace.** Each Agent step shows a `Handed:` line: mode, included, reduced,
  omitted and missing.

## Roles (backend `app/services/agent_flows/roles.py`)

| Role | Default tools | Allowed adds | Needs |
|---|---|---|---|
| report_reader | search_business_assets, resolve_chart_candidates, list_charts, inspect_filters, describe_time_coverage, get_chart_glossary, get_chart_summary | describe_semantic_model, get_chart_data | — |
| knowledge_reader | search_knowledge, read_document, explain_measurement | recall_knowledge, get_chart_glossary, describe_semantic_model | ≥1 knowledge attachment |
| metric_analyst | resolve_chart_candidates, list_charts, describe_time_coverage, total_measure, rank_values, share_of, aggregate_chart_data, compute, compare_periods, compare_segments | compare_to_target, segment_compare, get_chart_summary, get_chart_data, inspect_filters, get_chart_glossary, search_business_assets, explain_measurement | — |
| diagnostic_analyst | resolve_chart_candidates, list_charts, describe_time_coverage, compare_periods, explain_change, detect_anomaly, compare_segments, describe_distribution, compute | smart_drilldown, correlate_charts, segment_compare, total_measure, rank_values, share_of, aggregate_chart_data, analyze_trend, detect_seasonality, get_chart_summary, inspect_filters, search_business_assets | — |
| answer_writer | — | — | — |

No role holds external tools (`reaches_outside`) or Skills; those stay with the
custom agent. Every role whose default tools need a `chart_id` can also look one up.

## Data

No schema change. Two optional fields go on the Agent node in the flow body JSON:
`role: str = ""` and `reads_from: list[str] = []`.

## API

| Method | Path | Change |
|---|---|---|
| GET | /agent-flows/tools | adds `roles: [...]` (display only) |
| PUT | /agent-flows/brains | 422 when a grant is outside its role or the role is unknown |
| POST | /agent-flows/brains/{k}/{v}/publish | 409 (not acknowledgeable) for role, role-dependency and `reads_from` problems |

## Permissions

Unchanged. A role only narrows. Resource scope (`run_scope`, chart allowlists,
knowledge scope) applies to every step as before, whatever its role.

## Edge cases

- **Retired role:** the step loads, runs with no tools, and the inspector says so.
- **Deleted input step:** the chip turns red, and publish is refused by name.
- **Loop:** `reads_from` reads the latest iteration's result.
- **Coordinator lanes:** a later step can name a lane's inner step. Lanes stay
  isolated from each other.

## Non-goals

Per-role model defaults, per-role budgets, role versioning, Evidence Reviewer.
