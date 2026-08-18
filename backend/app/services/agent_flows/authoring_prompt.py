"""A brief an author can hand to ChatGPT/Claude, so it writes a flow this system runs.

THE IDEA, AND WHY IT IS NOT "AI BUILDS THE FLOW"
-----------------------------------------------
Describing what you want is easy; expressing it as nodes, keys, edges and a data
contract is not, and that gap is why a builder with twelve node types still feels
empty. The operator's proposal closes it from the other side: this system emits a
precise SPEC, the author takes it to whichever assistant they already talk to,
explains their need in their own words there, and pastes the result back.

The value is in who does which part. The outside model does the part it is good
at — turning prose into a shape — while this system keeps the part that must not
be guessed: what the shapes ARE. Nothing here calls a model, nothing here costs a
token, and no key is needed for it to work.

GENERATED, NEVER WRITTEN BY HAND
--------------------------------
Every node type, tool and model in this brief is read from the live registries at
request time. That rule is not stylistic. The previous module kept a
hand-maintained node list in the frontend and it drifted into offering types the
executor could not run — a palette entry that publishes a flow which then does
nothing. A hand-written brief would drift the same way, except worse: the drift
would be laundered through a competent outside model that produces confident,
well-formed JSON naming a node type this deployment has never had.

So when a node type is added, removed or renamed, this brief changes with it on
the next request, or it is wrong — and there is no third state.

WHAT IT DELIBERATELY DOES NOT ASK FOR
-------------------------------------
Document ids, dataset ids, chart ids. An outside model cannot know them and would
invent them, and an invented id is the one error that survives validation looking
like data. The brief tells it to leave those empty and say so in `todo`, which is
exactly the operator's intent: generate the skeleton, then the author attaches
what each step should read.
"""
from __future__ import annotations

import json
from typing import Any

#: Fields the outside model must never fill in. Ids in this system are database
#: keys; a model asked for one produces a plausible integer, and a plausible
#: integer is indistinguishable from a real one until a viewer reads the wrong
#: document.
_AUTHOR_SUPPLIED = ("knowledge", "datasets", "metrics", "chart_ids")


def _nodes_section(web_enabled: bool) -> str:
    from app.services.agent_flows.runtime.nodes import catalogue

    lines = []
    for n in catalogue(web_enabled=web_enabled):
        flags = []
        if n["costs_llm"]:
            flags.append("costs an LLM call")
        if n["reaches_outside"]:
            flags.append("leaves the deployment; off unless the link enables it")
        tail = f"  [{'; '.join(flags)}]" if flags else ""
        lines.append(
            f'  - "{n["type"]}" — {n["label_en"] or n["label_vi"]}: '
            f'{n["description_vi"]}{tail}'
        )
    return "\n".join(lines)


def _tools_section(web_enabled: bool) -> str:
    from app.services.agent_flows.tools.registry import catalogue

    lines = []
    for pack in catalogue(web_enabled=web_enabled):
        tools = pack.get("tools") or []
        if not tools:
            continue
        lines.append(f'  {pack.get("key")} — {pack.get("label_vi") or ""}')
        for t in tools:
            answers = t.get("answers_vi") or []
            hint = f'  e.g. {answers[0]}' if answers else ""
            lines.append(f'    · {t["name"]}: {t.get("description_vi") or ""}{hint}')
    return "\n".join(lines)


def _models_section() -> str:
    from app.services.agent_flows.models_catalogue import INHERIT, MODELS

    out = [f'  - "{INHERIT}" (recommended) — use whatever the link is configured with']
    for prov, models in MODELS.items():
        names = ", ".join(m["model"] for m in models)
        out.append(f'  - provider "{prov}" with model one of: {names}')
    return "\n".join(out)


def _example_flow() -> str:
    """A small, REAL flow — one that this system would accept as written.

    Concrete rather than abstract because a schema plus an example is the pair a
    model copies correctly; a schema alone gets guessed at.
    """
    return json.dumps(
        {
            "name": "Trợ lý doanh thu",
            "description": "Trả lời câu hỏi về doanh thu trên báo cáo đang mở.",
            "answer_node": "tra_loi",
            "nodes": [
                {
                    "key": "doc_bao_cao",
                    "type": "report_read",
                    "name": "Đọc báo cáo",
                    "output_var": "bao_cao",
                },
                {
                    "key": "tra_cuu",
                    "type": "knowledge",
                    "name": "Tra định nghĩa chỉ số",
                    "output_var": "dinh_nghia",
                    "knowledge": [],
                },
                {
                    "key": "tra_loi",
                    "type": "agent",
                    "name": "Trả lời người xem",
                    "provider": "inherit",
                    "prompt": (
                        "Trả lời câu hỏi bằng đúng ngôn ngữ người dùng dùng. "
                        "Chỉ dùng số có trong dữ liệu đã đọc. Nêu rõ biểu đồ nguồn."
                    ),
                    "tools": [
                        {"tool": "get_chart_data"},
                        {"tool": "total_measure"},
                        {"tool": "compare_periods", "note": "chỉ khi hỏi so với kỳ trước"},
                    ],
                },
            ],
            "todo": [
                "tra_cuu: chọn tài liệu Knowledge cho bước này trong builder",
            ],
        },
        ensure_ascii=False,
        indent=2,
    )


def build_authoring_prompt(*, web_enabled: bool = True) -> dict[str, Any]:
    """The brief, plus the facts a UI needs to explain it.

    Returned as a dict rather than a bare string so the screen can show counts
    ("12 node types, 33 tools") without parsing prose back out of the text.
    """
    from app.services.agent_flows.runtime.nodes import catalogue as node_cat
    from app.services.agent_flows.tools.registry import catalogue as tool_cat

    nodes = node_cat(web_enabled=web_enabled)
    packs = tool_cat(web_enabled=web_enabled)
    tool_count = sum(len(p.get("tools") or []) for p in packs)

    prompt = f"""\
You are helping me design an "Agent Flow" for a BI product called AppBI. I will
describe, in my own words, what I want an AI assistant to do on one of my
reports. Your job is to turn that into ONE JSON object in the exact format below.

Ask me questions first if my description is missing something you need. When you
are ready, output the JSON in a single fenced ```json block and nothing else
after it.

═══ WHAT A FLOW IS ═══
A flow runs every time a viewer asks the report's chat a question.

It is an ORDERED LIST of steps, NOT a graph. `nodes` runs top to bottom, and the
order in that list IS the order of execution. There is no `next` field, no edges
and no ids pointing between steps — if you emit one it is silently DISCARDED and
the flow runs in list order anyway, which is the one mistake here that produces
no error and the wrong behaviour.

Branching is expressed by NESTING, not by pointing:
  - "if" has `paths`, each with its own `body` (a nested list of steps). Paths
    merge back at the step after the "if".
  - "switch" has `cases`, each with a `body`, plus `fallback`.
  - "loop" has `over` (the list to walk), `item_var`, and a `body` run per item.

Steps pass results to each other by NAME, not by wiring: a step with
`output_var: "bao_cao"` can be read by any later step's prompt as {{{{bao_cao}}}}.

Exactly one step is the one whose text the viewer reads — name its `key` in
`answer_node`.

═══ THE ONLY STEP TYPES THAT EXIST ═══
Use nothing else. A type not on this list will be rejected.
{_nodes_section(web_enabled)}

═══ TOOLS AN "agent" STEP MAY BE GIVEN ═══
Only an `agent` step has tools. Each entry is an OBJECT, not a bare string:
    "tools": [{{"tool": "get_chart_data"}}, {{"tool": "total_measure", "note": "khi hỏi tổng"}}]
`note` is optional and is shown to the model beside the tool name, so you can say
when to reach for it without writing a paragraph in the prompt.

Give each step the few tools its job needs — not the whole list; every tool costs
prompt space and a step holding thirty of them chooses badly.
{_tools_section(web_enabled)}

═══ MODEL ═══
{_models_section()}
Prefer "inherit" unless I ask for a specific model.

═══ RULES YOU MUST FOLLOW ═══
1. `key` for each step: short, lowercase, a-z 0-9 and underscore only, unique.
2. NEVER emit a `next` field. Order comes from the list; branching comes from
   nesting a `body` inside an "if" / "switch" / "loop".
3. `answer_node` must name a step that exists, and it should be an "agent" step.
4. An "agent" step must have a non-empty `prompt`.
4b. A "report_read" or "knowledge" step MUST have an `output_var` — a short
    lowercase name for what it produces (`bao_cao`, `dinh_nghia`). Those steps
    only re-run when their input goes stale, so without somewhere to keep the
    result there is nothing to reuse and the flow is rejected. Later steps can
    refer to it as {{{{bao_cao}}}} inside a prompt.
5. NEVER invent ids. Leave `knowledge`, `datasets`, `metrics` and `chart_ids`
   as empty arrays — I attach the real documents and datasets afterwards in the
   builder, where the picker only offers what I actually have. Instead, for each
   step that needs something attached, add a line to `todo` saying what I must
   attach and why.
6. Write `prompt` text and step `name`s in MY language — the language I used to
   describe the need to you.
7. Keep it small. Three to six steps answers most needs. Add a step only when it
   does something the previous one cannot.
8. Reading the report costs nothing and no LLM call — prefer a "report_read"
   step over telling an agent to figure the report out by itself.

═══ THE FORMAT, WITH A WORKING EXAMPLE ═══
```json
{_example_flow()}
```

═══ NOW ═══
Here is what I want. Ask me anything you need, then give me the JSON:

<<< I write my need here >>>
"""

    return {
        "prompt": prompt,
        "stats": {
            "node_types": len(nodes),
            "tool_packs": len([p for p in packs if p.get("tools")]),
            "tools": tool_count,
        },
        "author_supplied_fields": list(_AUTHOR_SUPPLIED),
    }
