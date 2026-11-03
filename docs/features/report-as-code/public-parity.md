# Public & AI Bot parity — Build Manual ↔ AI Vibe Report

Baseline: the Build Manual public dashboard. "Same" = the same component / service / contract.
A capability a report does not have is **not shown** in the UI (never displayed as working).

| Capability | Build Manual | AI Vibe Report | How |
|---|---|---|---|
| Many named public links | ✅ | ✅ same | `PublicLinksManager` + adapter (`reportLinkTarget`) |
| Password, 2h session, revoked on security change | ✅ | ✅ same | `services/public_link_session` (shared); a session never crosses kinds |
| Expiry (410), on/off, delete | ✅ | ✅ same | `report_artifact_public_links` mirrors the dashboard columns |
| Locked / hidden filters, server-side | ✅ | ✅ | `public_links.scope` over the PUBLISHED revision's declared filters |
| "Limit" allow-list (interactive within a set) | ✅ | ❌ hidden | not implemented for reports; refused by the server |
| Filter source | dashboard slicers/filters | ✅ published revision | modal rows = `published_filters` |
| Appearance: title, logo | ✅ | ✅ | slim header on `/d/r`, `/embed/r` |
| Appearance: allow viewer filters | ✅ | ✅ enforced server-side | `viewer_filters_allowed` |
| Appearance: locked-filter banner | ✅ | ✅ | `show_filter_banner` |
| Appearance: page tabs, CSV export, PDF/PPT export, snapshot TTL | ✅ | ❌ hidden | no report equivalent (single page, no tiles, no snapshot) |
| Live preview (published only, no draft) | ✅ | ✅ same contract | signed 15-min `rpv_` token, never stored, never opens the bot |
| Link + embed URLs | ✅ | ✅ | `/d/r/<token>`, `/embed/r/<token>` |
| Access statistics | ✅ | ✅ same | `access_count`, `last_accessed_at` |
| Who manages links | edit | full (publish) | report links are a publish action |
| **AI Bot for viewers** | ✅ | ✅ same Answer Core | `public_turn` (parameterised by turn table), `public_bot.build_context` |
| — scope | published tiles | published bindings | `ToolContext.adopt_scope` — no fake dashboard |
| — locks / hidden locks | ✅ | ✅ | locks in `public_filters`; hidden marked `_disclose: False` |
| — model may not loosen a lock | ✅ | ✅ | `exposed_fields` = viewer-settable filters only |
| — publisher key/model, budget | ✅ | ✅ same rules | `_apply_ai_credential`; own ledger namespace (negative link id) |
| — publisher guide | ✅ | ✅ | catalog built exactly as a turn builds it |
| — Agent Flow add-on | ✅ | ❌ hidden | a flow binding is a dashboard-link binding today |
| — page context / "show chart" chips | ✅ | ❌ | a report is one page; chips need report-side chart focus |

**Studio AI ≠ viewer AI Bot.** Studio AI writes report code for an author (generation/edit,
region-scoped CSS enforced server-side, no JS for a region). The AI Bot answers a viewer from
what the link publishes, through the Answer Core, never writing code.
