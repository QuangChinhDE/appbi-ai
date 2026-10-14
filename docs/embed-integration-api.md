# AppBI — Embed Integration API

Get a **short-lived, rotating embed URL** for an AppBI report, scoped to a set of
**server-locked filters**, from your **backend**, and put it in an `<iframe>` in
your own application.

This is an **integration capability**. It is called machine-to-machine with a
**Personal Access Token (PAT)**; a logged-in browser session cannot call it.

> The PAT must live **only on your server**. Never send it to a browser.

Related surfaces (not covered here): a **public link** (`/d/<token>`) and a
**stable embed** (`/embed/<token>`) are created by a report editor in AppBI's
*Share → Public links* dialog. They do not rotate and have no per-link origin
allowlist. See the capability matrix in
`docs/features/dashboard-public-final-closure/spec.md`.

---

## 1. Concepts

| Term | Meaning |
|------|---------|
| **PAT** | `appbi_pat_<id>.<secret>`, created in AppBI *Settings → Tokens*. Must carry the `dashboards` scope at **edit** or **full**. |
| **Resolve endpoint** | `POST /api/v1/integrations/embed/resolve` — returns an embed URL. |
| **Grant / embed URL** | `https://<host>/embed/emb_<256 hex>` — a capability URL. Valid **≤ 1 hour**. Only the SHA-256 of the token is stored by AppBI. |
| **Locked filters** | The `filters` you send are enforced **server-side**. The viewer cannot remove, widen or see around them. |
| **Allowed origins** | Sites allowed to frame the URL. Enforced by the browser (`Content-Security-Policy: frame-ancestors`). |

```
Your backend (user opens a report screen)          AppBI
  │ POST /api/v1/integrations/embed/resolve
  │ Authorization: Bearer <PAT>
  │ { dashboard_id, filters | full_report, allowed_origins?, header?, ttl_seconds? }
  ├──────────────────────────────────────────────►│ PAT only · dashboards scope ≥ edit
  │                                                │ owner of the PAT can EDIT the dashboard
  │                                                │ validate + lock filters → managed link
  │ { embed_url, embed_path, expires_at, … }       │ mint emb_ grant (bound to this PAT)
  │◄──────────────────────────────────────────────┤
  │ <iframe src="{embed_url}">                     │
  │ (before expires_at → call again)               │ same filters → same link, new grant
```

---

## 2. Authentication and permission

```
Authorization: Bearer appbi_pat_<id>.<secret>
```

A call succeeds only when **all** of these hold:

1. The credential is a **PAT**. A browser session cookie or session JWT is refused
   with `403` even for an administrator: minting an unauthenticated URL is a publish
   action, not something a page open in a browser should do on the user's behalf.
2. The PAT is live (not revoked, not expired).
3. The PAT's scope includes **`dashboards: "edit"`** or **`"full"`**. A token scoped
   `dashboards: "view"` cannot mint, even for dashboards its owner owns.
4. The PAT's owner can **edit** the dashboard: they own it, it is shared with them at
   **edit**, or they are a dashboards module administrator. This is the same bar as
   creating a public link in the UI; a view-only share is not enough.

`full_report: true` passes through exactly the same checks.

**Revocation.** Every grant records the PAT that minted it. **Revoking or deleting the
PAT ends every URL it issued at once**, whether or not each URL's hour has run out.
There is no per-grant revoke endpoint; rotate the PAT if a URL leaked.

---

## 3. `POST /api/v1/integrations/embed/resolve`

### Request body

| Field | Type | Notes |
|---|---|---|
| `dashboard_id` | int | Required. |
| `filters` | list | Locked filters, each `{field?, semanticField?, datasetId?, operator, value}` with a non-empty value. **Field identity** (§3.1): send `semanticField` + `datasetId` to name one field exactly; a bare `field` is accepted only when exactly one filterable field of the dashboard has that name. Unknown, ambiguous or mismatched identities and unappliable operator/value pairs are `400`. |
| `full_report` | bool | Must be `true` to embed **without** filters. No filters and no `full_report` is `400`, so a forgotten scope cannot leak the whole dataset. |
| `allowed_origins` | list[str] | Sites allowed to frame the URL (see §4). **Remembered on the PAT** and applied to every later mint. Omitted or `[]` keeps what the PAT already declared; it never clears it. |
| `header` | str ≤ 200 | Title the embedded report shows. |
| `ttl_seconds` | int | Requested lifetime. **Capped at 3600.** Larger values are accepted and silently capped (the schema accepts up to 86400 for backward compatibility). |

### Response `200`

| Field | Meaning |
|---|---|
| `embed_url` | Absolute URL (uses `PUBLIC_BASE_URL` when configured). |
| `embed_path` | `/embed/emb_…` — prepend your AppBI public URL if `embed_url` is wrong behind a proxy. |
| `expires_at` | UTC time the URL stops working. |
| `filter_hash` | Identity of the locked filter set (same filters → same managed link). |
| `header` | The title that will be shown (after trimming). |
| `allowed_origins` | The restriction in force for this URL (`[]` = any site may frame it). |

### Errors

| Status | Meaning |
|---|---|
| `401` | Missing, malformed, revoked or expired PAT. |
| `403` | Not a PAT (browser session), PAT scope below `dashboards: edit`, or the PAT's owner cannot edit the dashboard. |
| `404` | Dashboard not found. |
| `400` | Unknown field, **ambiguous bare field** (several fields share the name — send `semanticField` + `datasetId`), `datasetId` that is not the named field's dataset, `field` that contradicts `semanticField`, unappliable operator/value, empty value, no filters without `full_report`, or an invalid `allowed_origins` entry. |
| `422` | Body validation (e.g. `header` > 200 chars). |
| `429` | Rate limit — keyed per PAT (`EMBED_RESOLVE_RATE_LIMIT`). |

### 3.1 Filter identity — never a guess

A dashboard can expose two different fields with the same bare name (say
`orders.region` and `customers.region`). The resolver picks exactly one field or
refuses:

| You send | Result |
|---|---|
| `semanticField` (optionally + `datasetId`) | that exact field; a `datasetId` that is not its dataset → `400` |
| a qualified name in `field` (e.g. `"orders.region"`) | same as `semanticField` |
| a bare `field` that one filterable field has | that field |
| a bare `field` that several fields have | `400` — ambiguous; send `semanticField` + `datasetId` |
| a name no filterable field has | `400` |

The stored lock is the resolved identity — `datasetId` + `semanticField` + the
bare column `field`, the same shape a lock made in the Public Links dialog has —
and `filter_hash` is computed from it. So spelling, case and value order do not
matter (equivalent filters → same managed link), and two different fields that
share a bare name are two different scopes.

### 3.2 Data contract — one runtime

An `emb_` grant resolves to its managed link, and from there **every** data path
(chart data, batch, slicer values, structure) is the ordinary public runtime: the
published report, the link's locked filters merged by the same rules as any public
link (`docs/filter-semantics.md` §3), the same chart engine. There is no separate
query path. For the same published report, locked filters, page, parameters and
viewer interaction, an `emb_` returns the same business result as a public link
locked to the same filters; the Builder's own query with those filters agrees.

What differs is only integration policy: short-lived grant, PAT binding (revoke the
PAT → every grant it minted ends), origin allowlist, embed-only surface, the
`header`, and no report export / AI.

Inside the lock: parameters and what-if switchers, cross-filter and date drill
work and never leave the scope; page filters intersect with the lock (neither
replaces the other); a viewer cannot remove or widen it; the locked field has no
viewer control (its dropdown offers nothing) and other dropdowns offer only values
inside the lock.

### 3.3 What an embed inherits — the published dashboard, not a Public Link

The request names a **dashboard**, not a Public Link, and the managed link it
creates starts with an empty appearance. So an embed shows what belongs to the
published dashboard itself (layout, theme, pages, parameters, tile settings) and
does **not** inherit the link-specific settings (headline, appearance, link
filters, password) of any Public Link someone made in the dialog. Embedding "a
copy of Public Link X" would be a new capability, not part of this API.

---

## 4. Allowed origins (who may frame the URL)

Each entry is an **origin**: scheme + host + optional port, no path.

| Rule | Matches | Does not match |
|---|---|---|
| `https://app.base.vn` | `https://app.base.vn`, `https://app.base.vn:443` | `http://app.base.vn`, `https://app.base.vn:8443`, `https://x.app.base.vn` |
| `https://*.base.vn` | `https://a.base.vn`, `https://a.b.base.vn` | `https://base.vn` (the parent itself), `https://evil-base.vn`, `https://base.vn.evil.com` |
| `http://localhost:3000` | exactly that | `http://localhost:3001` |

- Only `http` and `https`. A bare `*` is rejected: "embeddable anywhere" is expressed
  by declaring **no** allowlist. At most 20 entries.
- Matching is decided by **one** server-side matcher (`embed_link_service.origin_allowed`)
  and enforced by the browser through `frame-ancestors`, which uses the same rules.

### What the embed page does on every load (`/embed/emb_…`)

The frontend asks the backend for the grant's policy, an explicit **state**:

| State | Page behaviour |
|---|---|
| `restricted` | `Content-Security-Policy: frame-ancestors <your origins>`. If the browser says the page was opened **outside a frame** (`Sec-Fetch-Dest: document`) → `403` refusal page. If the `Referer` origin is not allowed → `403`. With no `Referer` (a host using `referrerpolicy="no-referrer"`), the page is served and the browser's `frame-ancestors` decides. |
| `unrestricted` | Served; only the deployment floor (below) applies. |
| `invalid` | Unknown, expired, revoked, or its PAT revoked/expired, or its link disabled → `410` page "expired or revoked". **Never** treated as unrestricted. |
| *policy unavailable* | Backend error, timeout or malformed answer. AppBI uses the last **known-good** policy for that grant if it has one from the last hour; otherwise `503` — **fail closed**. |

- An `emb_` URL works **only on `/embed/`**. Opening it as `/d/emb_…` is refused (`404`).
- **Deployment floor.** When AppBI's operator sets `EMBED_FRAME_ANCESTORS`
  (space-separated origins), every `/d` and `/embed` page also carries
  `frame-ancestors 'self' <floor>` as a **separate** CSP header. Browsers enforce
  every CSP they receive, so a grant's allowlist can narrow the floor, never widen it.

**What the allowlist protects.** Re-hosting the report on another site, and opening a
live URL in a browser tab. It does **not** stop someone who holds a live URL from
calling AppBI's JSON API directly — that is what the ≤ 1h lifetime, the PAT binding
and the server-locked filters are for.

---

## 5. Embedding and refresh

```html
<iframe src="{{embed_url}}"
        style="width:100%;height:800px;border:0"
        referrerpolicy="strict-origin-when-cross-origin"></iframe>
```

- **Refresh strategy:** mint a new URL per viewer session, and again before
  `expires_at` (e.g. when the host page is opened or every ~50 minutes). The same
  `filters` map to the same managed link, so minting is cheap.
- **Auto-height:** the embed page posts `{ type: "appbi:resize", height }` to its parent
  window whenever its content height changes.
- **What the viewer can do:** page tabs, the report's own slicers and filters (inside
  your locked filters), cross-filter / cross-highlight, date drill, parameter switchers,
  per-chart CSV (when the report's link settings allow it). The same report numbers as
  the AppBI Builder and the public page.
- **What the embed does not offer:** report export (PDF / PowerPoint) — a product
  decision: inside your application the host owns downloads and chrome. The export
  endpoints refuse an `emb_` token. The AI assistant is not shown in embeds.

### Redirect flow ("click → view report")

If you would rather open the report in a new tab than an iframe, do **not** use an
`emb_` URL — it is refused outside a frame when origins are declared. Create a public
link in AppBI instead (optionally password-protected and with an expiry).

---

## 6. Reference client

`docs/embed_quickstart.py` (Python standard library only):

```bash
export APPBI_BASE_URL="https://<your-appbi-host>"
export APPBI_TOKEN="appbi_pat_xxx.yyy"     # PAT with dashboards: edit
export APPBI_DASHBOARD_ID=63               # a dashboard the PAT's owner can edit
python docs/embed_quickstart.py
```

curl:

```bash
curl -sS -X POST "$APPBI_BASE_URL/api/v1/integrations/embed/resolve" \
  -H "Authorization: Bearer $APPBI_TOKEN" -H "Content-Type: application/json" \
  -d '{"dashboard_id": 63, "full_report": true, "allowed_origins": ["https://app.example.com"]}'
```

---

## 7. Security model (summary)

| Concern | Contract |
|---|---|
| Who can mint | PAT only; scope `dashboards ≥ edit`; PAT owner can edit the dashboard. |
| URL lifetime | ≤ 1 hour; ends early when its PAT is revoked/expired or its managed link is disabled. |
| Data scope | Locked filters enforced server-side on every data path (single chart, batch, distinct values, AI). |
| Framing | Per-grant allowlist, explicit policy states, fail closed; deployment floor always applies. |
| Surface | `emb_` only on `/embed/`; no report export. |
| Tokens at rest | Grant token stored as SHA-256; application logs reference tokens by a short hash, never the raw value. |
| Rate limits | Resolve: per PAT. Public page endpoints: per viewer IP as seen by AppBI's proxy (forwarded headers are honoured only from trusted proxies — `TRUSTED_PROXY_CIDRS`, `TRUSTED_PROXY_HOPS`). |
