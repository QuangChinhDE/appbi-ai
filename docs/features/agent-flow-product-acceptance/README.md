# Agent Flow — real product acceptance (Chat + Public Report)

Method: drive the real UI as a reader → observe → find the root cause → fix the right layer → re-verify live.
Rig: isolated backend `appbi-afspec-backend` on a private network, own DB; Next dev server; OpenAI key (credential 1), model `gpt-6-luna`.
Spend: **$0.20 of the $3.00 cap** (56 recorded runs; $0.005 manual allowance for one cancelled turn the product does not record).

## Findings fixed in this branch

| # | Surface | What the reader saw | Root cause | Fix (layer) |
|---|---|---|---|---|
| 1 | Chat | Shared but not delegated reader got "ARR chưa tra được" | `run_scope` withholds data by design, silently | `reader_access` on `/chat/brains`, `sources_withheld` notice + prompt note (direct_chat, dispatch) |
| 2 | Chat/Public | Correct month-on-month change hidden "[đã ẩn]" | order-dependent `_wrong_period`; baseline month not counted as asked | claim_check |
| 3 | Public | "tháng 8" resolved to 2023 → refused | model chose a year the question never said | `intent.anchor_years` |
| 4 | Public | "So với tháng trước" compared Jul vs Jun | relative follow-up not anchored on the month just discussed | `intent.anchor_relative_followup` |
| 5 | Both | Suggested questions about another report (Olist GMV) | static suggestions | grounded in reachable chart names |
| 6 | Both | `[ FOLLOWUP]` raw; "HIGH" unlocalised | marker spacing; untranslated badge | handler canonicalises; i18n badge |
| 7 | Public | "Phân tích toàn diện" ran on links whose assistant is refused — on the server key, outside every Flow budget; read charts the assignment excluded | Explore endpoint skipped the link policy | `dispatch.explore_gate` (same reader policy + chart ceiling as chat), refusal before any key |
| 8 | Public | "Tự động → Nhanh → Sâu" chip changed nothing | chat runs the flow; mode only labelled telemetry | chip removed |
| 9 | Public | Anonymous viewer told "chọn một Agent Flow…" | author instructions in viewer messages | viewer-facing block messages |
| 10 | Public | Viewer's slicer value shown as "Gói = [đã ẩn]" | filter value parsed as a figure | disclosed filter values beside their name are labels |
| 11 | Public | Withheld figure explained as "sai đại lượng, sai kỳ, … hoặc tự tính" | one generic sentence for every reason | reason-specific reader text (balance summed over periods, wrong period, …) |
| 12 | Public | AI advised removing a 🔒 filter; said "no filter applies" under a 🚫 one | prompt saw locked filters without the lock, hidden ones as "(none)" | `_filters_told_to_ai` marks locks, counts hidden ones without naming them |
| 13 | Chat | "1 con số không khớp" on a cited document answer with no figures | "[Nguồn: tài liệu 26]" verified as a figure | bracketed labels excluded from figure verification |
| 14 | Author | Flow picker offered Chat/Skill flows the server refuses (409) after 3 steps | FE did not mirror the server rule | picker lists report flows (+ the one already assigned) |
| 15 | Author | "Token OpenAI lấy từ cấu hình máy chủ" | untrue for chat (flow steps use their own keys) | copy states who supplies the key per operation |

Locked by `backend/tests/test_product_acceptance.py` and the live browser spec `e2e/tests/agent-flow-product-acceptance.spec.ts` (retries 0, graded against fixture values; skipped — never faked — without the PA_* fixture env).

## Journeys

| ID | Result | Evidence |
|---|---|---|
| C01 discover/use | PASS after fixes 1, 5 (+ PR #16 gate) | chat list + answer 72 |
| C02 multi-turn | PASS: 72 → −792 (−91,7 %) → enterprise 5.000 / 76,92 % → honest "incomplete month" diagnosis | B8 |
| C03 knowledge | PASS: no access → notice, no content; with access → definition matches doc 26, cited | B8 |
| C04 multi-specialist | PASS on content (864 + GMV definition); presentation cluttered (figure repeated in 3 blocks, step chatter) | B8 |
| C05 unsupported | PASS: out-of-range revenue/forecast refused with data range, no invention | B8 |
| C06 lifecycle | PASS: share revoke / unpublish remove the assistant; restored | $0 |
| P01 non-technical viewer | PASS (welcome, no key/model screen) | |
| P02 numeric | PASS | B4–B6, spec |
| P03 filters | PASS: slicer 60→43; 🔒 103 announced and kept; 🚫 104 → 43, value never named | B7, spec |
| P04 multi-turn | PASS after fixes 2–4 | B5–B6, spec |
| P05 restricted link | PASS: segment chart outside allowlist never read; lock not lifted on request | B7, spec |
| P06 model/key UX | PASS after fixes 8, 15 | spec |
| P07 rendering/feedback | rating persists across reload; cancel leaves a blank turn with no "stopped" note and no recorded run (open) | B8 |
| P08 Explore | Classified: NOT Agent Flow — Dashboard AI exploration engine on viewer → link → server key, logged as `mode=explore`, no USD cap. Now gated like chat (fix 7). On a served link it still spends the server key: product decision needed | $0 |
| P09 publish/version | PASS: draft not served (run on v2); after publish both links on v3 | B7 |

## Open (not fixed here)

- Explore on a served link runs on the server/link key, outside Flow budget and Runs — route it through the flow, cap it, or remove it from public (decision).
- Chat welcome shows "Reads 3 attached sources" when the reader can read none (PR #16 UI; `reader_access` is available; sent to that session).
- Cancelled turn: no "stopped" state, no run, spend unrecorded. Flow turns emit no `cost` event (USD not counted in telemetry).
- Multi-specialist answer repeats the figure across blocks; raw `chart:N` chips until PR #16's fix lands.
- A public slicer label shows the author "click to rename" affordance to viewers; Knowledge chunks of docs 25/26 miss letters ("chỉ  ố").
