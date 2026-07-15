"""Goal-driven exploration engine — "Phân tích toàn diện".

Phase 16 (InsightBench rework). Implements the AgentPoirot loop from
"InsightBench: Evaluating Business Analytics Agents Through Multi-Step
Insight Generation" (ICLR 2025) on top of our existing chart-tool layer:

    QG  ─ generate k root questions from (SMART goal, chart schema),
          forced-diverse across the insight ladder
    AQ  ─ answer each question with a bounded mini tool-loop (the same
          19 tools the Thinking chat uses) and extract ONE typed Insight
          {type, statement, evidence, justification, confidence, action}
    FQ+QS ─ from the insights so far, propose follow-ups (diverse rungs)
          and SELECT the single best one to answer next (depth)
    SUM ─ summarize all insights into a ranked report + action items

Differences from the paper's reference implementation (deliberate):
  - No Python code-gen: our "execution layer" is the chart-tool set, so
    answers stay inside the dashboard's semantic + filter contract.
  - IE is fused into AQ (the answer must end with one INSIGHT_JSON line)
    and QS is fused into FQ (propose then <pick>) — halves LLM calls.
  - Depth/breadth are capped hard: this runs behind one SSE request.

Events yielded (consumed by /ai/agent/explore): exploration_step,
status, insight, text (summary stream), cost, error, done.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import AsyncGenerator

from app.services.dashboard_ai_bot.cost import CostMeter
from app.services.dashboard_ai_bot.events import AgentEvent
from app.services.dashboard_ai_bot.thinking.agent import (
    _status_text,
    _streamer_for,
)
from app.services.dashboard_ai_bot.thinking.briefing import Briefing
from app.services.dashboard_ai_bot.thinking.tools import (
    TOOL_DEFINITIONS,
    ToolContext,
    execute_tool,
)

logger = logging.getLogger(__name__)

# Hard caps — the whole exploration runs behind ONE SSE request.
MAX_BREADTH = 4          # root questions
MAX_DEPTH = 2            # follow-up levels per root
MAX_TOOL_CALLS_PER_QUESTION = 4
DEFAULT_BREADTH = 3
DEFAULT_DEPTH = 1

_LADDER = ("desc", "diag", "pred", "presc")


# ── Prompts (adapted from InsightBench Prompts 1/3/5/6/7) ────────────────────

QG_SYSTEM_PROMPT = """\
You are the manager of a data-analyst team exploring a BI dashboard to reach
a business goal. You write the questions; your analysts answer them with
chart-reading tools.

Rules:
* Produce at most {k} questions, each answerable from the charts listed in
  the user message (reference their chart ids).
* Diverse across the insight ladder — at least one `desc` (what happened)
  and one `diag` (why / which segment drives it). Add one `pred`
  (projection) ONLY if a time dimension is visible in the schema.
* One part per question — a single `?`.
* Questions must serve the goal, phrased in the goal's language
  (Vietnamese if the goal is Vietnamese).
* Format — one per line, nothing else:
  <question type="desc|diag|pred" charts="id,id">câu hỏi?</question>
"""

AQ_SYSTEM_PROMPT = """\
You are a senior Data Analyst answering ONE exploration question on a BI
dashboard, as part of a larger goal.

GOAL: {goal}

Use the tools to READ the data (at most {max_tool_calls} tool calls — plan
tightly). Charts carry a `fields` block: use those on-screen measure/dimension
LABELS in your answer, never raw SQL columns.

Then reply with:
1. A 1-3 sentence answer in the question's language, every number cited
   `[chart:N]`.
2. THE FINAL LINE must be exactly one JSON object on one line:
INSIGHT_JSON: {{"type": "desc|diag|pred|presc", "statement": "...", "evidence": [chart ids], "justification": "...", "confidence": "HIGH|MED|LOW", "action": null}}

INSIGHT_JSON rules:
* statement — ONE specific sentence WITH the key number(s) and real entity
  names from the data (InsightBench: "resolution time rose from 113h in
  Jan-2023 to 3150h in Jun-2024" beats "resolution time is increasing").
* type — the rung your EVIDENCE supports: desc = read off the data;
  diag = you ran a split/compare/correlate and can name the driver;
  pred = you ran forecast/trend tooling; presc = a concrete action.
* justification — one sentence: which numbers prove the statement.
* action — null unless the finding implies one concrete step naming a real
  segment/entity from the data.
* No numbers that did not come from tool results.
"""

FQ_SYSTEM_PROMPT = """\
You are the manager of a data-analyst team. Your team answered some
questions already (insights below). Decide what to explore NEXT to reach
the goal.

Rules:
* Propose at most {n} follow-up questions — do NOT repeat an answered
  question; prefer climbing the ladder (a desc finding → ask the diag
  question that explains it; a diag finding → what to do / what happens
  next). Diverse types.
* Each: <question type="desc|diag|pred|presc" charts="id,id">...?</question>
* THEN pick the single question that most advances the goal:
  <pick>0-based index</pick>
"""

SUMMARY_SYSTEM_PROMPT = """\
You are a senior Data Analyst writing the FINAL report of a goal-driven
dashboard exploration. Input: the goal + the typed insights your team
extracted (each already verified against chart data).

Write in the goal's language (Vietnamese if the goal is Vietnamese):

TL;DR: <1 câu — phát hiện quan trọng nhất với số liệu, [chart:N], [HIGH|MED|LOW]>

Phát hiện chính:
- <[DESC|DIAG|PRED] statement với số liệu, [chart:N], [HIGH|MED|LOW]>
  (rank by decision-relevance, 3-5 bullets, merge duplicates)

▸ Đề xuất hành động:
- <[PRESC] hành động cụ thể nêu tên phân khúc/đối tượng thật, bám vào
  phát hiện đã cite ở trên> (1-3 dòng; bỏ mục này nếu không có action nào
  đủ căn cứ — KHÔNG bịa lời khuyên chung chung)

[FOLLOWUP] <câu hỏi đào sâu tiếp 1>?
[FOLLOWUP] <câu hỏi đào sâu tiếp 2>?

Rules: numbers ONLY from the insights given; keep `[chart:N]`, `[HIGH]`,
`[MED]`, `[LOW]`, `[DESC]`, `[DIAG]`, `[PRED]`, `[PRESC]` tokens verbatim;
no meta-commentary about the exploration process.
"""


# ── Parsing helpers ──────────────────────────────────────────────────────────

_QUESTION_RE = re.compile(
    r"<question\s+type=\"(desc|diag|pred|presc)\"(?:\s+charts=\"([^\"]*)\")?\s*>\s*(.+?)\s*</question>",
    re.IGNORECASE | re.DOTALL,
)
_PICK_RE = re.compile(r"<pick>\s*(\d+)\s*</pick>", re.IGNORECASE)
_INSIGHT_RE = re.compile(r"INSIGHT_JSON:?\s*(\{.*\})\s*$", re.DOTALL | re.MULTILINE)


def _parse_questions(text: str, allowed_chart_ids: set[int]) -> list[dict]:
    out: list[dict] = []
    for m in _QUESTION_RE.finditer(text or ""):
        qtype = m.group(1).lower()
        charts: list[int] = []
        for tok in (m.group(2) or "").split(","):
            tok = tok.strip()
            if tok.isdigit() and int(tok) in allowed_chart_ids:
                charts.append(int(tok))
        question = re.sub(r"\s+", " ", m.group(3)).strip()
        if question:
            out.append({"type": qtype, "charts": charts, "question": question})
    return out


def _parse_pick(text: str, n: int) -> int | None:
    m = _PICK_RE.search(text or "")
    if not m:
        return None
    idx = int(m.group(1))
    return idx if 0 <= idx < n else None


def _parse_insight(text: str, allowed_chart_ids: set[int]) -> dict | None:
    """Extract + sanitize the INSIGHT_JSON line. None when unusable."""
    m = _INSIGHT_RE.search(text or "")
    if not m:
        return None
    raw = m.group(1).strip()
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        # Model sometimes trails prose after the closing brace — retry on the
        # shortest balanced prefix.
        depth = 0
        for i, ch in enumerate(raw):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(raw[: i + 1])
                        break
                    except json.JSONDecodeError:
                        return None
        else:
            return None
    if not isinstance(obj, dict):
        return None
    itype = str(obj.get("type") or "desc").lower()
    if itype not in _LADDER:
        itype = "desc"
    statement = str(obj.get("statement") or "").strip()
    if not statement:
        return None
    evidence = [
        int(x) for x in (obj.get("evidence") or [])
        if isinstance(x, (int, float, str)) and str(x).isdigit() and int(x) in allowed_chart_ids
    ]
    confidence = str(obj.get("confidence") or "MED").upper()
    if confidence not in ("HIGH", "MED", "LOW"):
        confidence = "MED"
    action = obj.get("action")
    action = str(action).strip() if isinstance(action, str) and action.strip() else None
    return {
        "type": itype,
        "statement": statement[:600],
        "evidence": evidence[:6],
        "justification": str(obj.get("justification") or "").strip()[:500],
        "confidence": confidence,
        "action": (action[:300] if action else None),
    }


def _strip_insight_line(text: str) -> str:
    return _INSIGHT_RE.sub("", text or "").strip()


# ── Context blocks ───────────────────────────────────────────────────────────

def _schema_block(ctx: ToolContext, *, max_charts: int = 40) -> str:
    """Compact chart-schema vocabulary for question generation.

    The InsightBench schema-profile analog: name/type + on-screen measure
    (with aggregation) and dimension labels per chart, plus the page flow.
    Pure metadata — no warehouse queries.
    """
    lines: list[str] = []
    for cid in sorted(ctx.allowed_chart_ids)[:max_charts]:
        meta = ctx.chart_meta.get(cid) or {}
        fields = meta.get("fields") or {}
        measures = ", ".join(
            f"{m.get('label')}({m.get('agg') or '?'})"
            for m in (fields.get("measures") or []) if isinstance(m, dict)
        ) or "-"
        dims = ", ".join(
            str(d.get("label"))
            for d in (fields.get("dimensions") or []) if isinstance(d, dict)
        ) or "-"
        lines.append(
            f"[chart:{cid}] \"{meta.get('name')}\" ({meta.get('chart_type')}) "
            f"— measures: {measures}; dims: {dims}"
        )
    if ctx.pages:
        flow = " → ".join(str(p.get("name")) for p in ctx.pages if p.get("name"))
        if flow:
            lines.append(f"Page flow: {flow}")
    return "\n".join(lines)


def _insights_block(insights: list[dict]) -> str:
    lines = []
    for i, ins in enumerate(insights):
        ev = ", ".join(f"chart:{c}" for c in ins.get("evidence") or [])
        lines.append(
            f"{i + 1}. [{ins['type'].upper()}][{ins['confidence']}] {ins['statement']}"
            + (f" (evidence: {ev})" if ev else "")
            + (f" | action: {ins['action']}" if ins.get("action") else "")
        )
    return "\n".join(lines) or "(chưa có insight nào)"


# ── LLM call helpers ─────────────────────────────────────────────────────────

async def _single_shot(
    streamer, *, api_key: str, system_prompt: str, user_prompt: str,
    model: str | None, meter: CostMeter,
) -> tuple[str, str | None]:
    """One tool-less LLM call → (full text, error)."""
    parts: list[str] = []
    error: str | None = None
    try:
        async for ev in streamer(
            api_key=api_key,
            system_prompt=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
            tools=None,
            model=model,
        ):
            if ev.type == "text":
                parts.append(ev.text)
            elif ev.type == "usage":
                meter.add_usage(ev.extra or {})
            elif ev.type == "error":
                error = ev.text
                break
    except Exception as exc:  # transport
        logger.exception("explorer single-shot raised")
        error = f"Provider transport error: {type(exc).__name__}"
    return "".join(parts).strip(), error


async def _answer_question(
    streamer, *, ctx: ToolContext, api_key: str, model: str | None,
    goal: str, question: dict, meter: CostMeter,
    max_tool_calls: int,
) -> AsyncGenerator[AgentEvent, None]:
    """Mini tool-loop for ONE question. Yields status events; finishes with an
    internal `_answer` event carrying (answer_text, insight|None)."""
    # Explorer runs its own plan — never offer the chat's reading-plan pseudo
    # tool, and skip external/web tools (exploration is report-grounded).
    tools = [d for d in TOOL_DEFINITIONS if d.get("name") != "emit_reading_plan"]
    system = AQ_SYSTEM_PROMPT.format(goal=goal, max_tool_calls=max_tool_calls)
    hint = ""
    if question.get("charts"):
        hint = " (gợi ý chart: " + ", ".join(f"[chart:{c}]" for c in question["charts"]) + ")"
    running: list[dict] = [{"role": "user", "content": question["question"] + hint}]

    calls_made = 0
    answer_text = ""
    while True:
        round_text: list[str] = []
        round_calls: list[AgentEvent] = []
        error: str | None = None
        try:
            async for ev in streamer(
                api_key=api_key,
                system_prompt=system,
                messages=running,
                tools=tools,
                model=model,
            ):
                if ev.type == "text":
                    round_text.append(ev.text)
                elif ev.type == "tool_call":
                    round_calls.append(ev)
                elif ev.type == "usage":
                    meter.add_usage(ev.extra or {})
                elif ev.type == "error":
                    error = ev.text
                    break
        except Exception as exc:
            logger.exception("explorer answer stream raised")
            error = f"Provider transport error: {type(exc).__name__}"

        if error:
            yield AgentEvent(type="_answer", extra={"answer": "", "insight": None, "error": error})
            return

        text = "".join(round_text).strip()
        if not round_calls:
            answer_text = text
            break

        asst: dict = {"role": "assistant"}
        if text:
            asst["content"] = text
        asst["tool_calls"] = [
            {"id": tc.tool_call_id, "name": tc.tool_name, "args": tc.tool_args}
            for tc in round_calls
        ]
        running.append(asst)

        for tc in round_calls:
            if calls_made >= max_tool_calls:
                result = {
                    "ok": False,
                    "error": (
                        "internal: tool budget for this question is used up — "
                        "answer now with the data already gathered and emit "
                        "INSIGHT_JSON. Do not mention this message."
                    ),
                }
            else:
                yield AgentEvent(
                    type="status",
                    text=_status_text(tc.tool_name, tc.tool_args),
                    tool_name=tc.tool_name,
                    tool_args=tc.tool_args,
                )
                result = await asyncio.to_thread(execute_tool, ctx, tc.tool_name, tc.tool_args)
                calls_made += 1
            running.append({
                "role": "tool",
                "tool_call_id": tc.tool_call_id,
                "result": result,
            })

    insight = _parse_insight(answer_text, ctx.allowed_chart_ids)
    yield AgentEvent(type="_answer", extra={
        "answer": _strip_insight_line(answer_text),
        "insight": insight,
        "error": None,
    })


# ── Engine ───────────────────────────────────────────────────────────────────

async def run_exploration_stream(
    *,
    ctx: ToolContext,
    api_key: str,
    provider: str,
    model: str | None = None,
    briefing: Briefing | None = None,
    report_context_note: str = "",
    breadth: int = DEFAULT_BREADTH,
    depth: int = DEFAULT_DEPTH,
) -> AsyncGenerator[AgentEvent, None]:
    """Run one full exploration. Yields AgentEvent (see module docstring)."""
    started = time.monotonic()
    streamer, supports_tools = _streamer_for(provider)
    if streamer is None or not supports_tools:
        yield AgentEvent(
            type="error",
            text=(
                "Chế độ Phân tích toàn diện cần provider hỗ trợ tool-calling "
                "(Anthropic hoặc OpenAI)."
            ),
        )
        yield AgentEvent(type="done")
        return

    breadth = max(1, min(int(breadth or DEFAULT_BREADTH), MAX_BREADTH))
    depth = max(0, min(int(depth or DEFAULT_DEPTH), MAX_DEPTH))
    meter = CostMeter(model=(model or "").strip() or provider)

    goal = ""
    if briefing is not None and briefing.smart_goal.strip():
        goal = briefing.smart_goal.strip()
    if not goal:
        goal = (
            f"Tìm các insight quan trọng nhất của báo cáo "
            f"\"{ctx.dashboard.name or 'Dashboard'}\" — mô tả điều gì đang xảy ra, "
            f"vì sao, và cần hành động gì."
        )
    if report_context_note.strip():
        goal += f"\n(Bối cảnh báo cáo: {report_context_note.strip()[:500]})"

    schema = _schema_block(ctx)

    # ── Stage 1: root questions ────────────────────────────────────────────
    yield AgentEvent(type="exploration_step", extra={
        "stage": "questions", "status": "running",
    })
    qg_user = f"<goal>{goal}</goal>\n<schema>\n{schema}\n</schema>"
    qg_text, qg_err = await _single_shot(
        streamer, api_key=api_key,
        system_prompt=QG_SYSTEM_PROMPT.format(k=breadth),
        user_prompt=qg_user, model=model, meter=meter,
    )
    if qg_err:
        yield AgentEvent(type="error", text=qg_err)
        yield AgentEvent(type="done")
        return
    questions = _parse_questions(qg_text, ctx.allowed_chart_ids)[:breadth]
    if not questions:
        yield AgentEvent(type="error", text="Không sinh được câu hỏi khám phá từ schema báo cáo.")
        yield AgentEvent(type="done")
        return
    yield AgentEvent(type="exploration_step", extra={
        "stage": "questions", "status": "done",
        "questions": [
            {"question": q["question"], "type": q["type"], "charts": q["charts"]}
            for q in questions
        ],
    })
    yield AgentEvent(type="cost", extra={"cost": meter.to_dict()})

    # ── Stage 2: answer roots (+ follow-up depth) ──────────────────────────
    insights: list[dict] = []
    answered: list[dict] = []  # {question, answer}

    queue: list[tuple[dict, int]] = [(q, 0) for q in questions]  # (question, level)
    q_index = 0
    q_total = len(queue) + (len(questions) * depth)
    while queue:
        q, level = queue.pop(0)
        q_index += 1
        yield AgentEvent(type="exploration_step", extra={
            "stage": "answer", "status": "running",
            "index": q_index, "total": q_total,
            "question": q["question"], "qtype": q["type"], "level": level,
        })
        answer_payload: dict = {}
        async for ev in _answer_question(
            streamer, ctx=ctx, api_key=api_key, model=model,
            goal=goal, question=q, meter=meter,
            max_tool_calls=MAX_TOOL_CALLS_PER_QUESTION,
        ):
            if ev.type == "_answer":
                answer_payload = ev.extra or {}
            else:
                yield ev
        yield AgentEvent(type="cost", extra={"cost": meter.to_dict()})

        if answer_payload.get("error"):
            # One failed question must not sink the exploration — log & move on.
            logger.warning("explorer question failed: %s", answer_payload["error"])
            yield AgentEvent(type="exploration_step", extra={
                "stage": "answer", "status": "done",
                "index": q_index, "total": q_total,
                "question": q["question"], "qtype": q["type"], "level": level,
                "failed": True,
            })
            continue

        answered.append({"question": q["question"], "answer": answer_payload.get("answer") or ""})
        insight = answer_payload.get("insight")
        if insight:
            insights.append(insight)
            yield AgentEvent(type="insight", extra={"insight": insight})
        yield AgentEvent(type="exploration_step", extra={
            "stage": "answer", "status": "done",
            "index": q_index, "total": q_total,
            "question": q["question"], "qtype": q["type"], "level": level,
        })

        # Follow-up (FQ+QS fused) — only from root level, bounded by depth.
        if level < depth and insights:
            fq_user = (
                f"<goal>{goal}</goal>\n<schema>\n{schema}\n</schema>\n"
                f"<insights>\n{_insights_block(insights)}\n</insights>\n"
                f"<answered>\n"
                + "\n".join(f"- {a['question']}" for a in answered)
                + "\n</answered>"
            )
            fq_text, fq_err = await _single_shot(
                streamer, api_key=api_key,
                system_prompt=FQ_SYSTEM_PROMPT.format(n=3),
                user_prompt=fq_user, model=model, meter=meter,
            )
            if not fq_err:
                candidates = _parse_questions(fq_text, ctx.allowed_chart_ids)[:3]
                if candidates:
                    pick = _parse_pick(fq_text, len(candidates))
                    chosen = candidates[pick if pick is not None else 0]
                    # Skip near-duplicates of already-answered questions.
                    seen = {a["question"].lower() for a in answered}
                    if chosen["question"].lower() not in seen:
                        queue.append((chosen, level + 1))
            yield AgentEvent(type="cost", extra={"cost": meter.to_dict()})

        # Wall-clock guard: leave room for the summary stage.
        if time.monotonic() - started > 270:
            logger.warning("explorer wall-clock guard fired; skipping remaining questions")
            break

    if not insights:
        yield AgentEvent(type="error", text="Không trích xuất được insight nào từ dữ liệu báo cáo.")
        yield AgentEvent(type="done")
        return

    # ── Stage 3: summary ───────────────────────────────────────────────────
    yield AgentEvent(type="exploration_step", extra={"stage": "summary", "status": "running"})
    sum_user = (
        f"<goal>{goal}</goal>\n<insights>\n{_insights_block(insights)}\n</insights>"
    )
    error: str | None = None
    try:
        async for ev in streamer(
            api_key=api_key,
            system_prompt=SUMMARY_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": sum_user}],
            tools=None,
            model=model,
        ):
            if ev.type == "text":
                yield ev
            elif ev.type == "usage":
                meter.add_usage(ev.extra or {})
            elif ev.type == "error":
                error = ev.text
                break
    except Exception as exc:
        logger.exception("explorer summary stream raised")
        error = f"Provider transport error: {type(exc).__name__}"
    if error:
        yield AgentEvent(type="error", text=error)
    yield AgentEvent(type="exploration_step", extra={"stage": "summary", "status": "done"})
    yield AgentEvent(type="cost", extra={"cost": meter.to_dict()})
    yield AgentEvent(type="done")
