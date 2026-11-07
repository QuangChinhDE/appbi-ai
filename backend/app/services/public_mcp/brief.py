"""The brief a viewer's Claude starts with on a public link: the same business context the
AppBI AI Bot answers from, rendered once as plain text for Claude's system prompt.

Built ONLY from `describe` — what the link already discloses to this viewer (the
publisher guide and instructions only when the publisher shares them with Claude;
locked filters only when disclosed; hidden filters as a count). One foundation, two
engines: the publisher configures the AI Bot once, both read it.
"""
from __future__ import annotations

from typing import Any, Dict, List

MAX_CHARS = 12_000


def _fields(items: List[dict]) -> str:
    return ", ".join(str(x.get("label") or x.get("field")) + (f" ({x['aggregation']})" if x.get("aggregation") else "")
                     for x in items or [] if isinstance(x, dict)) or "-"


def _guide(g: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    if g.get("instructions"):
        out += ["## Publisher instructions (follow them)", str(g["instructions"])]
    ctx = g.get("context") or {}
    bits = [f"{k}: {ctx[k]}" for k in ("purpose", "audience", "unit", "period_note") if ctx.get(k)]
    if bits:
        out += ["## About this report", *bits]
    if g.get("definitions"):
        out.append("## Definitions (use these meanings and formulas)")
        out += [f"- {d.get('name')}: {d.get('formula')}" + (f" — {d['note']}" if d.get("note") else "")
                for d in g["definitions"] if isinstance(d, dict)]
    if g.get("glossary"):
        out.append("## Glossary (viewer term -> report field)")
        out += [f"- {x.get('term')} -> {x.get('ref')}" for x in g["glossary"] if isinstance(x, dict)]
    if g.get("targets"):
        out.append("## Targets")
        out += [f"- {x.get('label') or x.get('ref')}: {x.get('value')} {x.get('unit') or ''} {x.get('period') or ''}".rstrip()
                for x in g["targets"] if isinstance(x, dict)]
    if g.get("cause_sources"):
        out.append("## Where reasons are explained (cite only these charts for causes)")
        out += [f"- chart {x.get('chart_id')}: {x.get('note') or ''}" for x in g["cause_sources"] if isinstance(x, dict)]
    if g.get("facts"):
        out.append("## Facts from the publisher (not in any chart)")
        out += [f"- {x.get('title')}: {x.get('content')}" for x in g["facts"] if isinstance(x, dict)]
    if g.get("out_of_scope"):
        out.append("## Out of scope (politely decline)")
        out += [f"- {x.get('topic')}" + (f": {x['reason']}" if x.get("reason") else "") for x in g["out_of_scope"] if isinstance(x, dict)]
    st = g.get("style") or {}
    if st:
        out.append(f"## Answer style: length={st.get('length', 'normal')}, tone={st.get('tone', 'neutral')}, language={st.get('language', 'auto')}")
    return out


def render(d: Dict[str, Any]) -> str:
    lines = [f"# Report: {d.get('name')} ({d.get('kind')})"]
    if d.get("pages"):
        lines.append("## Pages")
        lines += [f"- {p.get('name')} (page_id {p.get('page_id')}): charts {p.get('chart_ids')}" for p in d["pages"]]
    if d.get("sections"):
        lines.append("## Sections")
        lines += [f"- {s.get('name')} ({s.get('section_id')}): {', '.join(s.get('bindings') or [])}" for s in d["sections"]]
    lines.append("## Charts")
    for c in d.get("charts") or []:
        ref = c.get("chart_id", c.get("binding"))
        lines.append(f"- [{ref}] {c.get('title')} ({c.get('type') or c.get('kind') or ''}): "
                     f"measures {_fields(c.get('measures'))}; dimensions {_fields(c.get('dimensions'))}"
                     + (f". {c['description']}" if c.get("description") else ""))
    lines.append("## Filters")
    if "viewer_filters_allowed" in d:
        lines.append(f"- viewer may change filters: {'yes' if d.get('viewer_filters_allowed') else 'no'}")
    if d.get("viewer_filters"):
        lines.append(f"- filters the viewer may change: {d['viewer_filters']}")
    if d.get("locked_filters"):
        lines.append(f"- fixed by the publisher (cannot change): {d['locked_filters']}")
    if d.get("other_fixed_filters"):
        lines.append(f"- {d['other_fixed_filters']} other fixed filter(s) apply that are not disclosed: never guess them")
    if d.get("publisher_guide"):
        lines += _guide(d["publisher_guide"])
    text = "\n".join(str(x) for x in lines)
    return text if len(text) <= MAX_CHARS else text[:MAX_CHARS] + "\n… (truncated: call get_report_context for the rest)"
