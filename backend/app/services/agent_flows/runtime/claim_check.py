# -*- coding: utf-8 -*-
"""Does each figure in the answer MEAN what the question asks about?

Reads the claim ledger (`claim_scope`) and the question's TARGET, resolved by the
runtime's existing resolvers — never by the prose of the answer:

    measure   strong governed matches of the question (`search_business_assets`,
              the resolver's own threshold), widened through the governed
              vocabulary to the fields they are bound to
    dimension the dimension gate's resolution (`requested_dimension`), time excluded
    member    a word of the question that IS a member label the run read

A figure is judged by the evidence that could support it (same value; a percentage
only by a proportion a tool or `compute` produced):

    supported    at least one supporting figure does not contradict the target
    misattributed every supporting figure contradicts it — another breakdown the
                 question does not name, another measure it does not name, or
                 another member of the breakdown asked about
    unsupported  nothing supports it (a percentage no proportion produces; a
                 figure the model derived itself)

A figure that merely has no overlap with the target (a total stated beside a
refusal) is supported. Nothing here decides what the prose attributes a number
to; the check only ever fires on a POSITIVE contradiction or a missing source.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Any

_TOL = 0.005


def _fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s or ""))
    return "".join(c for c in s if not unicodedata.combining(c)).lower().replace("đ", "d")


def _squash(s: str) -> str:
    return "".join(c for c in _fold(s) if c.isalnum())


def _close(a: float, b: float) -> bool:
    """Equal within tolerance, by MAGNITUDE: "giảm 5,23%" states -5.23 with the
    direction in words (found in the browser on a correct month-on-month)."""
    scale = max(abs(a), abs(b))
    return a == b or bool(scale and abs(abs(a) - abs(b)) / scale <= _TOL)


def _is_time(dim: str | None) -> bool:
    if not dim:
        return False
    if dim == "__time__":
        return True
    from app.services.time_semantics import looks_like_time_name

    return looks_like_time_name(dim)


#: ctx id -> the words of the measures the question named (see `_confirmed`).
_MEASURE_WORDS: dict[int, set[str]] = {}


def _question_measures(ctx: Any, question: str) -> set[str]:
    """Field keys of the measures the question names STRONGLY — the resolver's own
    threshold (two shared terms, or every term of a short question) over the
    governed search, widened through the governed vocabulary."""
    from app.services.agent_flows.tools.dimension_gate import field_key

    measures: set[str] = set()
    try:
        from app.services.agent_flows.tools.packs.discover import (
            _score, _terms_of, _vocabulary, tool_search_business_assets,
        )

        # The search itself, not through the registry: this is the runtime
        # reading the question, not a tool call the step made — it must not count
        # against the step's tool ceiling or appear in its log (found by the
        # golden batch-ceiling test).
        found = tool_search_business_assets(ctx, {"query": question})
        data = found.get("data") if isinstance(found, dict) and isinstance(found.get("data"), dict) else {}
        terms = _terms_of(question)
        for asset in data.get("results") or []:
            if not isinstance(asset, dict) or asset.get("type") not in ("metric", "field"):
                continue
            if str(asset.get("field_kind") or "").lower() == "dimension":
                continue
            ident = asset.get("id") or asset.get("name") or ""
            hay = " ".join(str(asset.get(k) or "") for k in ("id", "name", "detail"))
            strength = _score(hay, terms)
            # THE NAME MUST BE ASKED FOR. A word found only in a definition
            # ("phần trăm", "chiếm") made "Nó chiếm bao nhiêu phần trăm?" ask for
            # the on-time rate, and correct revenue figures were withheld.
            named = _score(" ".join(str(asset.get(k) or "") for k in ("id", "name")), terms)
            # A DEFINITION CAN NAME IT TOO, when it matches strongly: "doanh thu sản
            # phẩm trung bình mỗi đơn" is AOV's definition, not its name (acceptance
            # run 4183 withheld a correct 137.75); four shared terms, never the three
            # generic ones of "Nó chiếm bao nhiêu phần trăm?".
            if ident and (named or strength >= 4) and (strength >= 2 or (strength and strength == len(terms))):
                # The IDENTIFIER stays itself in `_vocabulary`; the NAME is what the
                # governed vocabulary translates into the fields the metric is bound
                # to. Without it "Giá trị đơn trung bình" never became `aov`, and a
                # correct AOV was withheld as another measure (live, df54303b).
                aliases = set(_vocabulary(ctx, str(ident), "measure") or [ident])
                if asset.get("name"):
                    aliases |= set(_vocabulary(ctx, str(asset["name"]), "measure") or [])
                for alias in aliases:
                    measures.add(field_key(str(alias)))
                _MEASURE_WORDS.setdefault(id(ctx), set()).update(
                    _terms_of(" ".join(str(asset.get(k) or "") for k in ("id", "name"))))
    except Exception:                                           # noqa: BLE001
        measures = set()
    return measures


def target_of(state: Any, ctx: Any) -> dict:
    """The question's measure keys, breakdown and member — cached on the state."""
    from app.services.agent_flows.tools.dimension_gate import field_key, requested_dimension

    question = str(getattr(ctx, "question", "") or "")
    # The question's measures cost a search: resolved once per run. Its member is
    # re-read each time — a member label read after the first check must count.
    cache = getattr(state, "_claim_measures", None)
    if cache is None or cache[0] != question:
        cache = (question, _question_measures(ctx, question))
        try:
            state._claim_measures = cache
        except Exception:                                       # noqa: BLE001
            pass
    measures = cache[1]
    try:
        dim = requested_dimension(ctx)
    except Exception:                                           # noqa: BLE001
        dim = None
    dim_key = field_key(dim) if dim and not _is_time(dim) else None
    words = {_squash(w) for w in question.replace("/", " ").split() if _squash(w)}
    member = None
    # EVERY member the question names: "Ratio của South và North?" asks for
    # both — keeping only the first withheld North's correct figure as "another
    # member's" (found on the Pair #5 golden journey, public AI).
    # A longer name consumes its own text first, so "Northeast" never also
    # counts as a question about "North" (which would let North's figure pass).
    seen: list[str] = []
    for e in getattr(state, "claim_ledger", None) or []:
        m = e.get("member")
        if not m or (dim_key and e.get("dimension") != dim_key):
            continue
        sm = _squash(m)
        if sm and sm not in seen:
            seen.append(sm)
    rest = _squash(question)
    hits: set[str] = set()
    for sm in sorted(seen, key=len, reverse=True):
        if len(sm) <= 3:
            if sm in words:
                hits.add(sm)
        elif sm in rest:
            hits.add(sm)
            rest = rest.replace(sm, "\x00")
    members = [sm for sm in seen if sm in hits]
    member = members[0] if members else None
    # THE INTENT CONTRACT, when the runtime resolved one (runtime/intent.py): its
    # measures and breakdown were chosen from the report's own vocabulary against
    # the question, so they replace the re-derived ones.
    intent = getattr(state, "intent", None) or {}
    if intent.get("source") == "model":
        if intent.get("measures"):
            measures = set(intent["measures"])
        if intent.get("dimension") and not _is_time(intent["dimension"]):
            dim_key = intent["dimension"]
    return {"measures": {m for m in measures if m}, "dimension": dim_key, "member": member,
            "members": set(members)}


def _confirmed(ctx: Any, dim: str | None) -> bool:
    """Did the question name this breakdown with words that are NOT the words of
    a measure it names? "Bang SP chiếm … doanh thu" names state by "bang"; "Tỷ lệ
    khách hàng quay lại" reaches customer_state only through "khách", a word of
    the measure — that is not a question about states."""
    if not dim:
        return False
    from app.services.agent_flows.tools.dimension_gate import (
        _chart_dimension_vocabulary, _dimension_terms, field_key, title_hits,
    )

    wanted, raw = _dimension_terms(ctx, str(getattr(ctx, "question", "") or ""))
    measure_words = _MEASURE_WORDS.get(id(ctx), set())
    hits: set[str] = set()
    for ref, field_words, title_words in _chart_dimension_vocabulary(ctx):
        if field_key(ref) == dim:
            hits |= (wanted & field_words) | set(title_hits(ctx, raw, title_words))
    from app.services.agent_flows.tools.packs.discover import _terms_of

    folded = {t for h in hits for t in _terms_of(h)} or hits
    return bool(folded - measure_words)


def _title_words_of(ctx: Any, dim: str) -> set[str]:
    """Every folded word of the titles of charts grouped by `dim`, parentheses
    included — "(khách)" and "(người bán)" are what tell two state charts apart."""
    import re

    from app.services.agent_flows.tools.dimension_gate import field_key

    out: set[str] = set()
    for meta in (getattr(ctx, "chart_meta", None) or {}).values():
        dims = [d.get("field") if isinstance(d, dict) else d
                for d in (((meta or {}).get("fields") or {}).get("dimensions") or [])]
        if any(field_key(str(d)) == dim for d in dims if d):
            out |= set(re.findall(r"[^\W\d_]+", _fold(str((meta or {}).get("name") or ""))))
    return out


def _names_dimension(ctx: Any, dim: str, requested: str | None = None) -> bool:
    import re

    from app.services.agent_flows.tools.dimension_gate import (
        _chart_dimension_vocabulary, _dimension_terms, field_key, title_hits,
    )

    # TWO BREAKDOWNS WITH ONE CUE WORD. "bang" names both the customer-state and
    # the seller-state chart, so a seller-state figure passed as the answer to a
    # customer-state question (live run 4907). When another breakdown was asked,
    # only a word that DISTINGUISHES this one's titles from it counts.
    if requested and requested != dim:
        distinct = _title_words_of(ctx, dim) - _title_words_of(ctx, requested)
        if distinct:
            # The question's words MINUS its measure words (the gate's own split):
            # "doanh thu" is in a category title and not in a state title, and in
            # the question because it is the measure — it names no breakdown.
            not_measure, _raw = _dimension_terms(ctx, str(getattr(ctx, "question", "") or ""))
            asked = {w for w in not_measure} & set(re.findall(r"[^\W\d_]+", _fold(
                str(getattr(ctx, "question", "") or ""))))
            return bool(distinct & asked)

    wanted, raw = _dimension_terms(ctx, str(getattr(ctx, "question", "") or ""))
    for ref, field_words, title_words in _chart_dimension_vocabulary(ctx):
        if field_key(ref) == dim and (wanted & field_words or title_hits(ctx, raw, title_words)):
            return True
    return False


_UP = ("tang", "increase", "increas", "rose", "grew", "growth", "cao hon", "higher")
_DOWN = ("giam", "sut", "decrease", "decreas", "declin", "drop", "fell", "thap hon", "lower")


def _sentence_of(text: str, value: float) -> str:
    """The sentence of `text` in which `value` is written (folded), or ""."""
    import re

    from app.services.dashboard_ai_bot.verifier import extract_answer_claims

    for sent in re.split(r"(?<=[.!?;])\s+|\n+", text or ""):
        if any(_close(value, v) for v, _ in extract_answer_claims(sent)):
            return _fold(sent)
    return ""


def _direction_said(text: str, value: float) -> str | None:
    """"up" / "down" when the sentence carrying the figure says exactly one."""
    sent = _sentence_of(text, value)
    up, down = any(w in sent for w in _UP), any(w in sent for w in _DOWN)
    return "up" if up and not down else "down" if down and not up else None


_WHOLE_WORDS = ("toan bo", "toan ky", "ca giai doan", "tat ca cac thang", "toan thoi gian",
                "overall", "all-time", "all time", "whole report", "in total", "trung binh toan")


def _periods(text: str) -> set[tuple]:
    from app.services.time_semantics import named_periods

    return named_periods(text)


def _wrong_period(support: list[dict], asked: set[tuple], sentence: str, question: str = "") -> bool:
    """The question names a period; is every reading of this figure some OTHER scope?

    Two shapes, both measured in acceptance: an all-time KPI given as one month's
    figure ("giao đúng hẹn tháng 3/2018 là 91,89%" — the all-time rate), and one
    total given for two quarters. A figure the sentence frames as the overall
    total is left alone; a change between periods (compare_periods) is left alone.
    """
    import re

    from app.services.time_semantics import comparison_baseline

    grains = {p[0] for p in asked}
    changes = [e for e in support if e.get("dimension") == "__time__" and not e.get("member")]
    if changes and len(asked) == 1:
        # One named period in a comparison: the change must be against the
        # baseline the question means ("cùng kỳ năm trước" is not last month).
        base = comparison_baseline(question, next(iter(asked)))
        if base:
            asked = {*asked, base}
    if changes:
        # A change between periods: right when it is between the periods asked.
        for e in changes:
            between: set[tuple] = set()
            for label in e.get("periods") or []:
                between |= _periods(str(label).replace("Q", " q")) or _periods("nam " + str(label))
            same = {p for p in asked if p[0] in {b[0] for b in between}}
            if not between or not same:
                return False
            if same <= between:
                # THE LATER PERIOD IS THE CURRENT ONE. Acceptance run 4176: asked
                # "quý 4/2017 so với quý 3/2017", the model called compare_periods
                # with the periods swapped; the tool honestly reported -29.85% from
                # Q4 to Q3 and it was published — the true change is +42.56%.
                labels = [(_periods(str(x).replace("Q", " q")) or _periods("nam " + str(x)))
                          for x in (e.get("periods") or [])[:2]]
                if len(labels) == 2 and all(len(x) == 1 for x in labels):
                    (current,), (baseline,) = labels
                    if current[0] == baseline[0] and current < baseline:
                        return True
                return False
        return True
    whole = [e for e in support if not e.get("dimension") and not e.get("member")]
    if len(whole) == len(support):
        # WORD-BOUNDED: "chung" inside "nhìn chung"/"kiểm chứng" let an all-time
        # figure pass as a quarter's (adversarial review).
        return not any(re.search(rf"(?<!\w){re.escape(w)}(?!\w)", sentence) for w in _WHOLE_WORDS)
    timed = [e for e in support if _is_time(e.get("dimension")) and e.get("member")]
    if len(timed) != len(support):
        return False
    labels = [_periods(str(e["member"]).replace("Q", " q")) or _periods("nam " + str(e["member"]))
              for e in timed]
    # A FINER ROW LIES INSIDE A COARSER ASKED PERIOD. Holdout run 5653: asked "trong
    # năm 2017", the lowest month of the whole series (a 2016 month) was published —
    # a month is not the grain of a year, so the row was never compared at all.
    if not all(labels) or not all(any(_nests(p, a) for p in lab for a in asked) or
                                  {p[0] for p in lab} & grains for lab in labels):
        return False
    return not any(lab & asked or any(_inside(p, a) for p in lab for a in asked)
                   for lab in labels)


_GRAIN_RANK = {"m": 0, "q": 1, "y": 2}


def _nests(p: tuple, a: tuple) -> bool:
    """`p` is of a finer grain than the asked period `a`, so it can lie inside it."""
    return _GRAIN_RANK.get(p[0], 9) < _GRAIN_RANK.get(a[0], -1)


def _inside(p: tuple, a: tuple) -> bool:
    """The finer period `p` lies inside the asked period `a`."""
    if not _nests(p, a) or p[1] != a[1]:
        return False
    if a[0] == "y":
        return True
    return p[0] == "m" and (p[2] - 1) // 3 + 1 == a[2]


#: Words that end the member phrase after a breakdown's cue word.
_PHRASE_STOP = {"la", "co", "chiem", "thi", "bao", "nao", "dat", "duoc", "trong", "so", "voi",
                "the", "is", "has", "have", "had", "was", "what", "how", "in", "of", "for",
                "tang", "giam", "nhieu", "nhat", "cao", "thap", "bang", "danh", "muc"}


def _asked_member_by_cue(ctx: Any, t: dict, question: str) -> list[str] | None:
    """The member the question names, as WRITTEN: the words after the requested
    breakdown's own cue word in the report's chart titles ("bang Minas Gerais",
    "danh mục đồ giường và phòng tắm (bed bath table)"). Returned as squashed
    candidates — the phrase, and any parenthesised alias — or None."""
    import re

    dim = t.get("dimension")
    if not dim or _is_time(dim):
        return None
    try:
        from app.services.agent_flows.tools.dimension_gate import chart_dimension_words, field_key

        cues: set[str] = set()
        others: set[str] = set()
        for rows in chart_dimension_words(ctx).values():
            for ref, _fw, title_words in rows:
                (cues if field_key(ref) == dim else others).update(_fold(w) for w in title_words)
        # A CUE NAMES THIS BREAKDOWN: "bang" is in state titles only; "đơn", "số",
        # "theo" are in every breakdown's titles ("Số đơn theo bang"), and "hủy đơn
        # của bang SP" read "của" as the asked member (found by the regression suite).
        cues -= others
        # NOR DOES A MEASURE'S WORD: the title of a single-value tile ("Số đơn hàng",
        # "Tổng doanh thu") names a measure, never a breakdown — "số" made "Số đơn của
        # bang Minas Gerais" ask about the state "đơn của" (found by the regression
        # for live 3bf8e3f3 g8_refuse_then_orders).
        for meta in (getattr(ctx, "chart_meta", None) or {}).values():
            if not (((meta or {}).get("fields") or {}).get("dimensions")):
                cues -= set(re.findall(r"[^\W_]+", _fold(str((meta or {}).get("name") or ""))))
    except Exception:                                           # noqa: BLE001
        return None
    words = re.findall(r"\(|\)|[^\W_]+", _fold(question))
    for i, w in enumerate(words):
        if w not in cues:
            continue
        phrase, depth = [], 0
        for x in words[i + 1:]:
            if x == "(":
                depth += 1
            elif x == ")":
                depth -= 1
            elif depth == 0 and (x in _PHRASE_STOP or x in cues):
                break
            phrase.append(x)
        text = " ".join(phrase)
        outside = _squash(re.sub(r"\([^)]*\)", " ", text.replace(" ( ", " (").replace(" ) ", ") ")))
        inside = [_squash(m) for m in re.findall(r"\(([^)]*)\)", text.replace(" ( ", " (").replace(" ) ", ") "))]
        cands = [c for c in (outside, *inside) if len(c) >= 2]
        words_out = re.sub(r"\([^)]*\)", " ", text.replace(" ( ", " (").replace(" ) ", ") ")).split()
        if cands and _initials(words_out):
            cands.append(_initials(words_out))
        if cands:
            return cands
    return None


_TIME_WORDS = {"thang", "nam", "quy", "ngay", "tuan", "month", "months", "year", "years",
               "quarter", "day", "days", "week", "weeks", "q"}


def _report_vocabulary(ctx: Any) -> set[str]:
    """Words the report itself uses — chart titles, field names and labels. A
    proper noun in the question that is one of these ("Olist", "GMV", "AOV")
    names the report or a measure, never a member being asked about."""
    words: set[str] = set()
    for meta in (getattr(ctx, "chart_meta", None) or {}).values():
        words |= {_squash(w) for w in str((meta or {}).get("name") or "").split()}
        for group in ((meta or {}).get("fields") or {}).values():
            for f in group or []:
                if isinstance(f, dict):
                    for k in ("field", "label", "name"):
                        words |= {_squash(w) for w in str(f.get(k) or "").replace(".", " ").replace("_", " ").split()}
    words |= set(_MEASURE_WORDS.get(id(ctx), set()))
    return {w for w in words if w}


def _asked_member(ctx: Any, t: dict, question: str) -> list[str] | None:
    """The member the question names — after the breakdown's cue word, or else as
    a proper noun / code ("São Paulo", "SP") or a numeric qualifier ("5 sao")
    that is not the report's own vocabulary. Live, df54303b: "São Paulo có bao
    nhiêu đơn hàng?" has no cue word, and the delivered count and the report
    total were both published as São Paulo's; total reviews as 5-star reviews."""
    import re

    intent = t.get("intent") or {}
    if intent.get("source") == "model" and intent.get("members"):
        cands: list[str] = []
        codes: list[str] = []
        for m in intent["members"]:
            said = str(m.get("said") or "")
            cands.append(_squash(said))
            if m.get("code"):
                codes.append(_squash(m["code"]))
            ini = _initials(said.split())
            if ini:
                cands.append(ini)
        # A CODE RESOLVED AGAINST THE REPORT'S OWN VALUES IS NEVER NOISE, whatever its
        # length: review score "5" was dropped by the two-character floor meant for
        # spoken words, and the correct 57,328 five-star reviews were withheld as
        # another member's (live 3ac706e6 run 7208).
        cands = list(dict.fromkeys([c for c in codes if c] + [c for c in cands if len(c) >= 2]))
        if cands:
            return cands
    found = _asked_member_by_cue(ctx, t, question)
    if found:
        return found
    vocab = _report_vocabulary(ctx)
    cands: list[str] = []
    tokens = re.findall(r"[^\W\d_][^\W_]*|\d+", question or "")
    phrase: list[str] = []
    for i, tok in enumerate(tokens + [""]):
        proper = bool(tok) and i > 0 and (tok[:1].isupper() or (tok.isupper() and len(tok) >= 2))
        if proper and _squash(tok) not in vocab:
            phrase.append(tok)
            continue
        if phrase:
            cands.append(_squash(" ".join(phrase)))
            if _initials(phrase):
                cands.append(_initials(phrase))
            phrase = []
    for m in re.finditer(r"(?<![\d.,/])(\d{1,3})\s+([^\W\d_]+)", _fold(question)):
        # Only a qualifier the REPORT uses ("5 sao" in "Tỷ lệ 5 sao (%)"): "Top 3
        # danh mục" is a ranking, not a member.
        q = m.group(1) + _squash(m.group(2))
        if m.group(2) not in _TIME_WORDS and any(q in _squash(str((meta or {}).get("name") or ""))
                                               for meta in (getattr(ctx, "chart_meta", None) or {}).values()):
            cands.append(q)
    cands = [c for c in dict.fromkeys(cands) if len(c) >= 2]
    return cands or None


def _names(sentence: str, label: str) -> bool:
    """Does `sentence` name `label` (a member as the data writes it)?"""
    import re

    s = _squash(label)
    if not s:
        return False
    if len(s) <= 3:
        return bool(re.search(rf"(?<![^\W_]){re.escape(_fold(label))}(?![^\W_])", _fold(sentence)))
    return s in _squash(sentence)


_FRAMED_WHOLE = ("toan bao cao", "toan bo", "ca bao cao", "tat ca cac", "toan ky", "toan thoi gian",
                 "overall", "whole report", "in total", "report total", "across all", "all states",
                 "all categories", "chung toan")


def _given_to_other_than_asked(sentence: str, asked: list[str] | None) -> bool:
    """True when the sentence plainly states a TOTAL: it frames the figure as the
    whole report, or the question named a member and this sentence does not."""
    import re

    folded = _fold(sentence)
    if any(re.search(rf"(?<![^\W_]){re.escape(w)}(?![^\W_])", folded) for w in _FRAMED_WHOLE):
        return True
    if asked and not any((_names(sentence, c) if len(c) <= 3 else c in _squash(sentence)) for c in asked):
        return True
    return False


def _same_root(measure: str | None, asked: set[str]) -> bool:
    """`order_count` and `delivered_orders` count the same thing; `order_count`
    and `total_revenue` do not. Compared on key words, plural stripped."""
    def roots(k: str) -> set[str]:
        return {w[:-1] if w.endswith("s") and len(w) > 3 else w
                for w in str(k or "").lower().replace(".", "_").split("_") if len(w) > 2}
    mine = roots(measure or "") - {"count", "total", "sum", "avg", "dataset", "table"}
    return any(mine & roots(a) for a in asked or ())


def _given_a_meaning(sentence: str, question: str, asked: list[str] | None) -> bool:
    """Does the sentence tie its figure to a period, or the member, the question
    asked about? Then "read somewhere" is not enough — see `check`."""
    if not sentence:
        return False
    # ANY explicit period: a follow-up ("Còn tháng trước đó thì sao?") names none,
    # yet "GMV tháng 10/2017 là 56808.84" still gives the figure a period
    # (live, df54303b, runs 4756/4765).
    if _periods(sentence):
        return True
    return bool(asked) and any((_names(sentence, c) if len(c) <= 3 else c in _squash(sentence))
                               for c in asked)


def _words_in_clause(text: str, value: float, words: set[str]) -> bool:
    """Does the CLAUSE carrying `value` (split on . ; , too) contain all `words`?"""
    import re

    from app.services.dashboard_ai_bot.verifier import extract_answer_claims

    for clause in re.split(r"(?<=[.!?;,])\s+|\n+", text or ""):
        if any(_close(value, v) for v, _ in extract_answer_claims(clause)):
            return words <= set(re.findall(r"[^\W\d_]{2,}", _fold(clause)))
    return False


def _qualifier_numbers(asked: list[str] | None, text: str, question: str = "") -> set[float]:
    """Numbers that are PART of the asked qualifier as the answer writes it
    ("5 sao" when the question asked about "5 sao") — labels, never figures.
    Live 4961/4986: the 5 of "lượt đánh giá 5 sao" was withheld as a figure. Live
    3ac706e6 run 7247: asked about SP's 5-star rate, the "5" of "5 sao" was withheld
    — the qualifier was the QUESTION's words, not the asked member's; a small number
    followed by the same word in the question and the answer is a label."""
    import re

    out: set[float] = set()
    folded = _fold(text)
    for n, word in re.findall(r"(?<![\d.,])(\d{1,2})\s+([^\W\d_]{2,})", _fold(question or "")):
        if re.search(rf"(?<![\d.,]){n}\s*{re.escape(word)}(?![^\W_])", folded):
            out.add(float(n))
    for c in asked or []:
        m = re.fullmatch(r"(\d{1,3})([a-z]+)", c or "")
        if m and re.search(rf"(?<![\d.,]){m.group(1)}\s*{m.group(2)}(?![^\W_])", folded):
            out.add(float(m.group(1)))
    return out


def _with_header(text: str, value: float, sentence: str) -> str:
    """The sentence of `value`, plus the line introducing it when it is a list item."""
    def is_item(line: str) -> bool:
        x = line.lstrip()
        return x[:1] in ("-", "•", "*", "+") or (x[:1].isdigit() and x[1:3].lstrip()[:1] in (".", ")"))

    core = (sentence or "").strip(" .")
    if not core:
        return sentence
    lines = (text or "").split(chr(10))
    for i, line in enumerate(lines):
        if core in _fold(line) and is_item(line):
            for prev in reversed(lines[:i]):
                if prev.strip() and not is_item(prev):
                    return _fold(prev) + " " + sentence
            break
    return sentence


def _initials(words: list[str]) -> str | None:
    """"Minas Gerais" -> "mg": the code a multi-word name is usually stored as.
    Only for two or three words, so a long phrase never acts as a code."""
    ws = [_squash(w) for w in words if _squash(w)]
    return "".join(w[0] for w in ws) if 2 <= len(ws) <= 3 else None


def _misattributed(support: list[dict], asked: list[str] | None, sentence: str) -> str | None:
    """THE SENTENCE SAYS WHOSE FIGURE IT IS. Acceptance, published: SP's revenue
    as Minas Gerais's (run 4245), health_beauty's as bed_bath_table's (4200), the
    whole-report total as SP's (4465, 4507). The question named the member in its
    own words, so the question's target never matched a data label — the check
    must read the SENTENCE that carries the figure."""
    if not asked or not sentence:
        return None
    if not any((_names(sentence, c) if len(c) <= 3 else c in _squash(sentence)) for c in asked):
        return None                      # the sentence does not give it to the asked member
    members = [e for e in support if e.get("member") and not _is_time(e.get("dimension"))]
    if members:
        named = [e for e in members if _names(sentence, e["member"]) or _squash(e["member"]) in asked]
        if not named:
            return "other_member"
        # "Minas Gerais (SP)": the sentence names BOTH the asked member and the
        # figure's member, relabelling one as the other (live runs 4901, 4943).
        # The question's own code (the initials of "Minas Gerais" → MG) differs
        # from the code-like member the figure belongs to.
        codes = {c for c in asked if len(c) <= 3}
        if codes and all(len(_squash(e["member"])) <= 3 and _squash(e["member"]) not in codes
                         for e in named):
            return "other_member"
        return None
    if all(not e.get("dimension") and not e.get("member") for e in support):
        return "whole_as_member"
    return None


#: Phrases that, right BEFORE a figure, make it the denominator population, not a
#: member's value: "SP có 41,746 trên tổng 99,441 đơn". Bare "tổng" is NOT one —
#: "Tổng doanh thu của SP là 13,591,643.70" is the whole-as-member error itself.
_OUT_OF = ("tren tong", "trong tong so", "tren tong so", "tren toan bo", "out of", "of the total",
           "of total", "of all")


#: Words that ask for — or answer with — ONE member by rank.
#: Vietnamese marks the superlative with "nhất" AFTER the noun ("nhiều đơn hàng nhất"),
#: so the token itself is the cue, not a fixed phrase.
_RANK_WORDS = ("nhat", "dan dau", "dung dau", "highest", "lowest", "most", "least", "largest",
               "smallest", "leading", "best", "worst", "top")
#: Words that make a figure an AVERAGE or a per-unit value.
_PER_UNIT_WORDS = ("trung binh", "binh quan", "moi don", "moi don hang", "moi khach", "moi lan",
                   "tren moi", "average", "avg", "mean", "per order", "per customer", "per unit",
                   "per item", "on average")


def _has_words(text: str, words) -> bool:
    import re

    folded = _fold(text or "")
    return any(re.search(rf"(?<![^\W_]){re.escape(w)}(?![^\W_])", folded) for w in words)


def _clause_of(text: str, value: float) -> str:
    """The clause (split on . ; , and line breaks) that carries `value`."""
    import re

    from app.services.dashboard_ai_bot.verifier import extract_answer_claims

    for clause in re.split(r"(?<=[.!?;,])\s+|\n+", text or ""):
        if any(_close(value, v) for v, _ in extract_answer_claims(clause)):
            return clause
    return ""


def _is_average_measure(key: str | None) -> bool:
    k = f"_{str(key or '').lower()}_"
    return any(f"_{w}_" in k for w in ("avg", "average", "mean", "aov", "per", "rate", "pct", "ratio",
                                        "score", "share"))


_EQUAL_WORDS = ("bang nhau", "nhu nhau", "giong nhau", "deu co gia tri", "deu la", "equal",
                "the same", "identical", "equals")


def _measures_named(ctx: Any, clause: str, keys: set[str]) -> set[str]:
    """Which of the ledger's measures the clause names: a key word of 3+ letters
    ("gmv") or a two-syllable pair from that measure's own chart titles."""
    import re

    from app.services.agent_flows.runtime import intent as I

    words = set(re.findall(r"[0-9a-z]+", _fold(clause).replace("_", " ")))
    pairs = I._terms(clause, singles=False)
    names = (I.vocabulary(ctx).get("measure_names") or {}) if ctx is not None else {}
    out = set()
    for k in keys:
        toks = {t for t in str(k).lower().split("_") if len(t) >= 3 and t not in I._GENERIC}
        titled = I._terms(" | ".join(names.get(k, [])), singles=False)
        if (toks and toks <= words) or (pairs & titled):
            out.add(k)
    return out


def _false_equality(ctx: Any, clause: str, ledger: list[dict]) -> str | None:
    """The measure a clause wrongly calls equal to another, or None."""
    if not clause or not _has_words(clause, _EQUAL_WORDS):
        return None
    whole: dict[str, float] = {}
    for e in ledger:
        if e.get("measure") and not e.get("dimension") and not e.get("member") and not e.get("count"):
            whole.setdefault(e["measure"], float(e["value"]))
    named = sorted(_measures_named(ctx, clause, set(whole)))
    if len(named) < 2:
        return None
    vals = [whole[m] for m in named]
    if max(vals) - min(vals) > 0.005 * max(abs(v) for v in vals):
        return named[0]
    return None


#: Words that say a period may not be complete (folded).
_EDGE_CAVEAT_WORDS = ("chua day du", "khong day du", "chua hoan chinh", "chua tron", "khong tron",
                      "mot phan", "chua ket thuc", "bat thuong", "thieu du lieu", "co the chua",
                      "incomplete", "partial", "not complete", "unusually low", "may not be complete")


def _framed_as_population(sentence: str, value: float) -> bool:
    import re

    from app.services.dashboard_ai_bot.verifier import extract_answer_claims

    for m in re.finditer(r"\d[\d.,]*\d|\d", sentence or ""):
        if any(_close(value, v) for v, _ in extract_answer_claims(m.group(0))):
            before = _fold(sentence[max(0, m.start() - 24):m.start()])
            return any(re.search(rf"(?<![^\W_]){re.escape(w)}(?![^\W_])", before) for w in _OUT_OF)
    return False


_MAX_OPERANDS = 6


def _resolve_derived(pending, claims, flagged, in_evidence, text, changes=(), ledger=(),
                     labels=()) -> list[dict]:
    """Flags for figures only arithmetic could support.

    LINEAGE, NOT NUMERIC MATCH. An operand is a figure the answer states, a tool
    read, that was not itself flagged — AND that the claim ledger DESCRIBES as a
    measure's figure (not a row/group count, not a label). And the operation must be
    one those two meanings allow: a share is a member's value over its whole, a
    change is one measure across two periods or members, a quotient divides two
    measures of one scope. Live at a2d2e68b: "13,591,643.70 / 72 đơn" (72 was the
    CATEGORY count) and "1/99224" (the 1 of "1 sao") were both arithmetically exact.
    """
    bad = [float(f["value"]) for f in flagged]
    operands = []
    for v, p in claims:
        if p or not v or v in labels or not in_evidence(v) or any(_close(v, b) for b in bad):
            continue
        meanings = [e for e in ledger if _close(v, float(e["value"]))
                    and e.get("measure") and not e.get("count")]
        if meanings:
            operands.append((v, meanings))
    if len(operands) > _MAX_OPERANDS:
        operands = []
    rates = [v for v, p in claims if p and 0 < v < 100 and not any(_close(v, b) for b in bad)
             and not any(pp and _close(v, pv) for pv, pp in pending)]   # only SUPPORTED rates
    out = []
    for value, pct in pending:
        # THE COMPLEMENT OF A STATED RATE: late 8.11% = 100% − on-time 91.89%
        # (acceptance runs 4072, 4309 withheld it).
        if pct and any(abs(value - (100 - r)) <= 0.05 for r in rates if not _close(r, value)):
            continue
        # A CHANGE THE TOOLS COMPUTED IS THE CHANGE. Browser, link 39: compare_periods
        # gave -5.23%, the answer listed July then August and said "tăng 5,52%" —
        # (Jul - Aug) / Aug, the wrong baseline — and arithmetic accepted it.
        if pct and changes:
            out.append({"value": value, "pct": pct, "why": "unsupported"})
            continue
        ok = _derived(value, operands, text) if pct else _derived_plain(value, operands)
        if not ok and pct and _sum_of_shares(value, claims, ledger, bad):
            ok = True
        if not ok:
            out.append({"value": value, "pct": pct, "why": "unsupported"})
    return out


def _sum_of_shares(value: float, claims, ledger, bad) -> bool:
    """A percentage that is the SUM of 2-4 stated shares of ONE whole — the same
    measure and breakdown, distinct members (live 85fc3626 g3_top3_share: the top
    three categories' 9.26 + 8.87 + 7.63 = 25.76% was withheld; shares of one whole
    add, other ratios do not)."""
    from itertools import combinations

    shares = []
    for v, p in claims:
        if not p or not v or any(_close(v, b) for b in bad):
            continue
        for e in ledger:
            if e.get("ratio") and e.get("member") and _close(v, float(e["value"])):
                shares.append((v, e.get("measure"), e.get("dimension"), e.get("member")))
                break
    for k in (2, 3, 4):
        for combo in combinations(shares, k):
            if len({(m, d) for _, m, d, _ in combo}) != 1 or len({x for *_, x in combo}) != k:
                continue
            if abs(sum(v for v, *_ in combo) - value) <= 0.05:
                return True
    return False


def _same_scope(a: dict, b: dict) -> bool:
    return (a.get("member"), a.get("dimension")) == (b.get("member"), b.get("dimension"))


def _share_ok(part: dict, whole: dict) -> bool:
    """A member's value over the whole it belongs to, in one measure."""
    return (part.get("measure") == whole.get("measure") and not part.get("ratio")
            and not whole.get("ratio") and bool(part.get("member")) and not whole.get("member")
            and whole.get("dimension") in (None, part.get("dimension")))


def _change_ok(a: dict, b: dict) -> bool:
    """One measure across two periods, or two members of one breakdown."""
    return (a.get("measure") == b.get("measure") and a.get("dimension") == b.get("dimension")
            and bool(a.get("member")) and bool(b.get("member")) and a.get("member") != b.get("member"))


def _sum_ok(a: dict, b: dict) -> bool:
    """Two figures of one scope (GMV − revenue), or two members of one measure."""
    if a.get("ratio") or b.get("ratio"):
        return False
    return _same_scope(a, b) or (a.get("measure") == b.get("measure")
                                 and a.get("dimension") == b.get("dimension"))


def _quotient_ok(a: dict, b: dict) -> bool:
    """Two measures of one scope (revenue per order), or one measure of two members."""
    if b.get("ratio"):
        return False
    return (_same_scope(a, b) and a.get("measure") != b.get("measure")) or _change_ok(a, b)


def _pairs(operands):
    for i, (a, ma) in enumerate(operands):
        for j, (b, mb) in enumerate(operands):
            if i != j:
                yield a, ma, b, mb


def _derived(value: float, operands: list, text: str = "") -> bool:
    """Is this percentage the change or the share between two DESCRIBED figures?
    Checked by arithmetic, to 0.05 points, and by meaning — a correct
    "(1,107,301.89 - 863,547.10) / 863,547.10 = 28.23%" between two months stands."""
    said = _direction_said(text, value) if text else None
    for a, ma, b, mb in _pairs(operands):
        if not b:
            continue
        change = (a - b) / b * 100
        # THE DIRECTION OF A WORKED-OUT CHANGE IS CHECKED TOO (review: "giảm
        # 28,23%" for a rise passed on magnitude alone). The two orderings
        # give different magnitudes, so the matching one fixes the sign.
        if abs(abs(value) - abs(change)) <= 0.05 and not (said and (change < 0) != (said == "down")) \
                and any(_change_ok(x, y) for x in ma for y in mb):
            return True
        if abs(abs(value) - a / b * 100) <= 0.05 and any(_share_ok(x, y) for x in ma for y in mb):
            return True
    return False


def _derived_plain(value: float, operands: list) -> bool:
    """A plain figure that IS the sum, difference or quotient of two DESCRIBED
    figures whose meanings allow that operation — GMV minus revenue, revenue per
    order: correct and not invented (acceptance); revenue per CATEGORY COUNT is not."""
    for a, ma, b, mb in _pairs(operands):
        for x, allowed in ((a + b, _sum_ok), (a - b, _sum_ok), (a / b if b else None, _quotient_ok)):
            if x is not None and abs(abs(value) - abs(x)) <= max(0.011, 1e-6 * abs(x)) \
                    and any(allowed(p, q) for p in ma for q in mb):
                return True
    return False


def _names_measure(ctx: Any, measure: str) -> bool:
    from app.services.agent_flows.tools.packs.discover import _score, _terms_of

    terms = _terms_of(str(getattr(ctx, "question", "") or ""))
    s = _score(measure.replace("_", " "), terms)
    return s >= 2 or bool(s and s == len(_terms_of(measure.replace("_", " "))))


def _contradiction(e: dict, t: dict, ctx: Any) -> str | None:
    if e.get("invalid_lineage"):
        return "invalid_lineage"         # a formula over an input that is not a measure's figure
    dim = e.get("dimension")
    if dim and not _is_time(dim) and t["dimension"] and dim != t["dimension"] \
            and not _names_dimension(ctx, dim, t["dimension"]):
        return "other_dimension"
    meas = e.get("measure")
    if meas and t["measures"] and meas not in t["measures"] and not _names_measure(ctx, meas):
        return "other_measure"
    if t["member"] and e.get("member") and (not t["dimension"] or dim == t["dimension"]) \
            and _squash(e["member"]) not in (t.get("members") or {t["member"]}):
        return "other_member"
    return None


def check(state: Any, ctx: Any, text: str) -> dict:
    """{target, flagged: [{value, pct, why, of}]} for one answer text."""
    from app.services.dashboard_ai_bot.verifier import (
        DEFAULT_TOLERANCE, _claim_alternates, _matches, extract_answer_claims,
    )

    ledger = getattr(state, "claim_ledger", None) or []
    evidence = list(getattr(state, "evidence", None) or [])
    alternates = _claim_alternates(text)

    def in_evidence(v: float) -> bool:
        """The figure verifier's own test: this number WAS read (any reading)."""
        return bool(evidence) and (_matches(v, evidence, DEFAULT_TOLERANCE) or any(
            _matches(a, evidence, DEFAULT_TOLERANCE) for a in alternates.get(v, ())))
    if ctx is None:
        return {}
    if not ledger:
        # NOTHING WAS READ, YET A FIGURE WAS STATED. Found in acceptance: the only
        # data call was refused and "tỷ lệ giao đúng hẹn tháng 9/2016 là 89,48%"
        # was published — the early return left it unchecked. A figure no evidence,
        # arithmetic or earlier answer supports is withheld. A cited document may
        # carry figures this ledger does not describe, so a cited answer is left
        # to the figure verifier.
        if getattr(state, "citations", None):
            return {}
        claims = extract_answer_claims(text)
        pending = [(v, p) for v, p in claims
                   if not in_evidence(v) and (p or abs(v) >= 1000 or v != int(v))]
        flagged = _resolve_derived(pending, claims, [], in_evidence, text, ledger=ledger)
        return {"target": {}, "flagged": flagged} if flagged else {}
    t = target_of(state, ctx)
    flagged: list[dict] = []
    # WAS THE BREAKDOWN DELIVERED FOR THE MEASURE ASKED? Orders by state do not
    # deliver revenue by state (found by review: measure-blind "delivered").
    wants_member = bool(t["dimension"] and t["measures"] and _confirmed(ctx, t["dimension"]))
    delivered = any(e.get("dimension") == t["dimension"] and
                    (e.get("measure") in t["measures"] or not e.get("measure"))
                    for e in ledger) if wants_member else True
    claims = extract_answer_claims(text)
    # A figure only arithmetic could support is decided AFTER the loop, against
    # operands that were not themselves flagged (review: a share of two withheld
    # all-time totals was published).
    pending: list[tuple[float, bool]] = []
    question = str(getattr(ctx, "question", "") or "")
    intent = getattr(state, "intent", None) or {}
    asked_member = _asked_member(ctx, {**t, "intent": intent}, question)
    # The quantity the question asks for when the report does not measure it —
    # only as the MODEL-resolved contract says so, and only its distinctive words
    # (never the report's own vocabulary: "tỷ lệ" is in it, "chuyển đổi" is not).
    absent_words: set[str] = set()
    if intent.get("source") == "model" and intent.get("absent") and not intent.get("measures"):
        vocab = _report_vocabulary(ctx)
        absent_words = {w for w in re.findall(r"[^\W\d_]{2,}", _fold(intent["absent"]))
                        if _squash(w) not in vocab}
    intent_periods = {tuple(p) for p in (intent.get("periods") or [])} \
        if intent.get("source") == "model" else set()
    labels = _qualifier_numbers(asked_member, text, question)
    # A BREAKDOWN ASKED, NONE DELIVERED. Live a2d2e68b: "điểm đánh giá trung bình
    # theo từng tháng là 4.0864" (the all-time average) and "tổng doanh thu của người
    # bán theo bang là 13,591,643.7" (the report total) — one whole figure given as
    # the breakdown the question asked for. Read from the resolved intent: time
    # breakdowns count here too (target_of leaves them to the period rules).
    asked_breakdown = intent.get("dimension") if (
        intent.get("source") == "model" and intent.get("dimension")
        and not intent.get("members") and not asked_member and not intent_periods) else None
    breakdown_delivered = bool(asked_breakdown) and any(
        e.get("member") and (e.get("dimension") == asked_breakdown
                             or (_is_time(asked_breakdown) and _is_time(e.get("dimension"))))
        for e in ledger)
    for value, pct in claims:
        if not pct and value in labels:
            continue                     # the "5" of "5 sao" is a label, not a figure
        if pct:
            support = [e for e in ledger if e.get("ratio") and
                       (_close(value, float(e["value"])) or _close(value, float(e["value"]) * 100))]
        else:
            support = [e for e in ledger if _close(value, float(e["value"]))]
        if not support:
            # NOT DESCRIBED IS NOT INVENTED. The claim ledger describes the tools
            # it has adapters for; the evidence ledger holds everything read. A
            # plain figure the evidence holds is supported (its meaning unknown,
            # so never contradicted). Only a percentage no proportion produced,
            # or a figure nothing read at all, is unsupported.
            if pct:
                if not any(_close(value, float(e["value"])) for e in ledger if e.get("ratio")):
                    pending.append((value, pct))
            elif not in_evidence(value) and (abs(value) >= 1000 or value != int(value)):
                pending.append((value, pct))
            elif _given_a_meaning(_sentence_of(text, value), question, asked_member):
                # A MEANING-UNKNOWN FIGURE CANNOT BE GIVEN A MEANING. Acceptance:
                # "GMV tháng 12/2017 là 19.62" (run 4216) and "GMV tháng 10/2017 là
                # 56808.84" (4368) — each number was read SOMEWHERE, but no described
                # figure of that period (or member) supports it.
                pending.append((value, pct))
            continue
        if pct:
            # Direction belongs to a CHANGE between periods, not to a level: a rate
            # of 78.64% in a sentence saying "giảm" is not a wrong direction.
            signed = [e for e in support if e.get("ratio") and "periods" in e and float(e["value"]) != 0]
            said = _direction_said(text, value)
            if signed and said and all((float(e["value"]) < 0) != (said == "down") for e in signed):
                flagged.append({"value": value, "pct": pct, "why": "wrong_direction",
                                "of": {"measure": signed[0].get("measure"), "dimension": None, "member": None}})
                continue
        # A follow-up names no period; its sentence may ("GMV tháng 10/2017 là
        # 56808.84" — another month's row, live runs 4849/4874).
        # Only for a figure that IS one period's row: whole totals and changes keep
        # the question's own periods (the sentence's dates would misjudge them).
        # THE ASKED PERIOD IS NOT IN THE DATA: no measure figure answers it, however
        # it is framed — the all-period total offered "for reference" is the
        # workaround the publication boundary refuses (live 3bf8e3f3 P0 g5).
        if intent.get("periods_outside_data") and support and any(
                e.get("measure") and not e.get("count") for e in support):
            flagged.append({"value": value, "pct": pct, "why": "period_absent",
                            "of": {"measure": support[0].get("measure"), "dimension": None, "member": None}})
            continue
        asked_periods = _periods(question) or intent_periods
        if not asked_periods and support and all(
                _is_time(e.get("dimension")) and e.get("member") for e in support):
            asked_periods = _periods(_sentence_of(text, value))
        if asked_periods and _wrong_period(support, asked_periods, _sentence_of(text, value), question):
            flagged.append({"value": value, "pct": pct, "why": "wrong_period",
                            "of": {"measure": support[0].get("measure"), "dimension": None,
                                   "member": support[0].get("member")}})
            continue
        # A list item inherits the line that introduces it: "São Paulo có … đơn,
        # bao gồm:" then "- Đã giao: 96,478" gives the item to São Paulo (live 5072).
        sentence = _with_header(text, value, _sentence_of(text, value))
        # A MEMBER THE QUESTION NAMES IS WHAT IT ASKS ABOUT: "đơn ở trạng thái đã
        # giao (delivered)" is answered by order_count for member `delivered`,
        # whatever the resolver called the measure (acceptance: 96,478 withheld in
        # 5 runs as `other_measure`).
        # Only when that member's measure shares a ROOT with the asked one — SP's
        # ORDERS share is still not its REVENUE share (test_an_orders_share_called_
        # a_revenue_share_is_flagged).
        reasons = [None if (r == "other_measure" and e.get("member") and _names(question, e["member"])
                            and _same_root(e.get("measure"), t["measures"]))
                   else r for e, r in ((e, _contradiction(e, t, ctx)) for e in support)]
        if all(reasons):
            e = support[0]
            flagged.append({"value": value, "pct": pct, "why": reasons[0],
                            "of": {k: e.get(k) for k in ("measure", "dimension", "member")}})
            continue
        if absent_words and _words_in_clause(text, value, absent_words):
            # Asked for a quantity the report does not measure; this figure's
            # clause gives it that name (live 4164/4879/4928/5051: the on-time
            # rate published as the website conversion rate).
            e = support[0]
            flagged.append({"value": value, "pct": pct, "why": "measure_absent",
                            "of": {k: e.get(k) for k in ("measure", "dimension", "member")}})
            continue
        if asked_breakdown and not breakdown_delivered and not _given_to_other_than_asked(sentence, None)                 and all(not e.get("dimension") and not e.get("member") for e in support):
            flagged.append({"value": value, "pct": pct, "why": "whole_as_breakdown",
                            "of": {"measure": support[0].get("measure"), "dimension": None,
                                   "member": None}})
            continue
        # TWO MEASURES CALLED EQUAL THAT THE EVIDENCE SAYS ARE NOT. Live 85fc3626
        # g3_gmv_minus_rev: "GMV và doanh thu sản phẩm đều có giá trị bằng nhau là
        # 13,591,643.70" — the revenue figure also claimed as GMV (15,843,553.24 read).
        eq = _false_equality(ctx, _clause_of(text, value), ledger)
        if eq:
            flagged.append({"value": value, "pct": pct, "why": "other_measure",
                            "of": {"measure": eq, "dimension": None, "member": None}})
            continue
        # A CHANGE OVER A PERIOD THE TOOL SAYS MAY BE INCOMPLETE is stated with that
        # caveat. Live 3bf8e3f3 (P0 g6, run 8117): "GMV tháng gần nhất 2018-09 giảm
        # 99,98%" over a month of 16 orders, none delivered — the tool's own note
        # was dropped. The observed value may be said; the change needs the caveat.
        if all(e.get("edge") for e in support) and not _has_words(text, _EDGE_CAVEAT_WORDS):
            e = support[0]
            flagged.append({"value": value, "pct": pct, "why": "edge_unqualified",
                            "of": {"measure": e.get("measure"), "dimension": None, "member": e.get("edge")}})
            continue
        whole_only = all(not e.get("dimension") and not e.get("member") for e in support)
        # A RANK ANSWER CARRIES A MEMBER'S FIGURE. Live a2d2e68b/a7354461 (link 39):
        # "Bang có doanh thu cao nhất là bang tương ứng với tổng doanh thu là
        # 13,591,643.7" — the report total as the top state's value. Whether or not
        # the breakdown was read, a whole-report figure cannot be the answer to
        # "which member is highest" in the sentence that says so.
        if whole_only and _has_words(question, _RANK_WORDS) and _has_words(sentence, _RANK_WORDS) \
                and not _framed_as_population(sentence, value) \
                and not _given_to_other_than_asked(_clause_of(text, value), None):
            flagged.append({"value": value, "pct": pct, "why": "whole_as_member",
                            "of": {"measure": support[0].get("measure"), "dimension": None, "member": None}})
            continue
        # A SUM IS NOT AN AVERAGE. Live a7354461 g3_rev_per_order: "Doanh thu … trung
        # bình mỗi đơn là 13,591,643.70" — the total revenue given as the per-order
        # average. The clause frames the figure per unit; its only support is a summed
        # measure (not an average/rate measure, not a derived quotient).
        clause = _clause_of(text, value)
        if not pct and clause and _has_words(clause, _PER_UNIT_WORDS) and all(
                not _is_average_measure(e.get("measure")) and not e.get("derived") and not e.get("ratio")
                and not e.get("stat") for e in support):
            flagged.append({"value": value, "pct": pct, "why": "aggregation_mismatch",
                            "of": {k: support[0].get(k) for k in ("measure", "dimension", "member")}})
            continue
        attributed = _misattributed(support, asked_member, sentence)
        if attributed == "whole_as_member" and _framed_as_population(sentence, value):
            attributed = None            # "… trên tổng 99,441 đơn": the population, not SP's
        if attributed:
            e = next((x for x in support if x.get("member")), support[0])
            flagged.append({"value": value, "pct": pct, "why": attributed,
                            "of": {k: e.get(k) for k in ("measure", "dimension", "member")}})
            continue
        if not delivered and not _given_to_other_than_asked(sentence, asked_member) and all(
                not e.get("dimension") and (not e.get("measure") or e.get("measure") in t["measures"])
                for e, r in zip(support, reasons) if not r):
            # The only support is a WHOLE-REPORT figure of the measure asked, and
            # the report never gave that measure by the breakdown asked: stated
            # as a member's figure it is wrong, stated as the total it is true.
            # A sentence that frames it as the whole report, or that does not
            # give it to the asked member, states the total — and may (brief:
            # "có thể nhắc số tổng nếu ghi rõ nó thuộc toàn báo cáo").
            flagged.append({"value": value, "pct": pct, "why": "whole_as_member",
                            "of": {"measure": next(iter(sorted(t["measures"])), None),
                                   "dimension": None, "member": None}})
    flagged += _resolve_derived(pending, claims, flagged, in_evidence, text,
                                [e for e in ledger if "periods" in e and e.get("ratio")],
                                ledger=ledger, labels=labels)
    return {"target": {**t, "measures": sorted(t["measures"])}, "flagged": flagged}


def _fmt(v: float, pct: bool) -> str:
    s = f"{v:,.2f}".rstrip("0").rstrip(".") if v != int(v) else f"{int(v):,}"
    return s + ("%" if pct else "")


def _what(of: dict | None) -> str:
    of = of or {}
    parts = [p for p in (of.get("member"), (of.get("dimension") or "").replace("_", " "),
                         (of.get("measure") or "").replace("_", " ")) if p and p != "__time__"]
    return " / ".join(parts) or "một đối tượng khác"


_WHY = {
    "other_dimension": "là số của {what} — một chiều khác với chiều câu hỏi hỏi",
    "other_measure": "đo {what} — không phải đại lượng câu hỏi hỏi",
    "other_member": "là số của {what} — không phải đối tượng câu hỏi hỏi",
    "unsupported": "không công cụ nào trong lượt này tạo ra con số này",
    "whole_as_member": ("là số của TOÀN BỘ báo cáo — báo cáo không có số liệu này theo chiều "
                        "được hỏi; nếu giữ, phải nói rõ đó là tổng toàn bộ"),
    "wrong_direction": "câu nói chiều ngược với dấu của con số đã tính (tăng ↔ giảm)",
    "period_absent": ("được đưa ra cho một kỳ mà dữ liệu KHÔNG có (kỳ được hỏi nằm ngoài phạm vi "
                      "thời gian của báo cáo) — nói rõ là không có số cho kỳ đó, không thay bằng "
                      "số của kỳ khác hay tổng toàn kỳ"),
    "edge_unqualified": ("là mức thay đổi so với một kỳ mà công cụ cho biết có thể CHƯA ĐẦY ĐỦ — "
                         "nói rõ điều đó bên cạnh con số, hoặc so sánh hai kỳ trọn vẹn trước đó "
                         "(compare_periods mode=mom)"),
    "aggregation_mismatch": ("là một TỔNG, nhưng câu trả lời gọi nó là trung bình/mỗi đơn vị — lấy "
                             "đúng số đo trung bình (biểu đồ AOV/trung bình) hoặc tính bằng compute "
                             "từ tổng và số lượng cùng phạm vi"),
    "whole_as_breakdown": ("là một số của TOÀN BỘ báo cáo, không phải số theo chiều được hỏi — "
                           "tìm biểu đồ có số đo này theo đúng chiều đó; nếu không có thì nói rõ "
                           "báo cáo không có số theo chiều này"),
    "invalid_lineage": ("được tính từ một đầu vào không phải số của đại lượng nào (số dòng, số nhóm, "
                        "hoặc số chưa được mô tả) — tính lại từ đúng số đo bằng compute với tham "
                        "chiếu, hoặc bỏ con số này"),
    "measure_absent": ("gọi con số bằng một đại lượng mà báo cáo không đo — đừng gán số của đại "
                       "lượng khác cho nó; nói rõ báo cáo không có số này"),
    "wrong_period": ("là số của một kỳ khác (hoặc của toàn bộ thời gian), không phải của kỳ được "
                     "hỏi — tìm biểu đồ có số đo này THEO KỲ (list_charts / resolve_chart_candidates) "
                     "và đọc đúng kỳ được hỏi; chỉ khi không có biểu đồ nào như vậy mới nói là không có"),
}


def borrowed_members(state: Any, text: str) -> list[str]:
    """Members of the asked breakdown the draft names while the run holds that
    breakdown ONLY for other measures (an open measure gap from the intent).
    Live 3bf8e3f3 (P0 g2, link 39): "Bang nào có doanh thu cao nhất?" with no
    revenue-by-state chart in scope was answered "SP" — read from orders by state.
    Structured facts: the gap and the ledger's members; the text is only searched
    for those members' own labels."""
    gap = getattr(state, "dimension_gap", None) or {}
    if not gap.get("measures") or gap.get("satisfied"):
        return []
    from app.services.agent_flows.tools.dimension_gate import field_key

    dim = field_key(str(gap.get("requested") or ""))
    wanted = set(gap.get("measures") or [])
    seen: list[str] = []
    for e in getattr(state, "claim_ledger", None) or []:
        m = e.get("member")
        if m and field_key(str(e.get("dimension") or "")) == dim and e.get("measure") not in wanted \
                and m not in seen and _names(text, m):
            seen.append(m)
    return seen[:5]


def borrowed_member_message(gap: dict, members: list[str]) -> str:
    return (
        "Kiểm tra trước khi trả lời: trong phạm vi báo cáo này KHÔNG có biểu đồ nào có "
        f"{', '.join(gap.get('measures') or [])} theo {gap.get('requested')}. "
        f"{', '.join(members)} chỉ xuất hiện trong thứ hạng của MỘT SỐ ĐO KHÁC, nên không phải "
        "câu trả lời cho điều được hỏi. Nói thẳng là báo cáo này không trả lời được theo chiều "
        "đó; có thể nêu số đo khác nếu gọi rõ tên nó. Trả lời bằng ngôn ngữ của câu hỏi."
    )


def review_message(flagged: list[dict], target: dict) -> str:
    """What the runtime sends back with a draft whose figures do not stand."""
    lines = [f"- {_fmt(f['value'], f.get('pct'))}: " + _WHY.get(f["why"], f["why"]).format(what=_what(f.get("of")))
             for f in flagged[:8]]
    return (
        "Kiểm tra số liệu trước khi trả lời — những con số sau trong bản nháp không có "
        "nguồn phù hợp với câu hỏi:\n" + "\n".join(lines) + "\n"
        "Nếu còn lượt, hãy lấy đúng số bằng công cụ (compare_periods cho thay đổi giữa hai kỳ, "
        "share_of cho tỷ trọng, compute với tham chiếu {ref, path} cho số suy ra) — không tự "
        "tính. Nếu báo cáo không có dữ liệu phù hợp, bỏ các số đó và nói thẳng là không có. "
        "Giữ nguyên các số khác đã đúng. Trả lời bằng ngôn ngữ của câu hỏi."
    )


def reader_note(flagged: list[dict], locale: str = "vi") -> str:
    """The line a READER sees under an answer whose figures could not be backed.

    NEVER A NUMBER. A figure withheld from its sentence is not relabelled and put
    back ("⚠️ Số của toàn bộ báo cáo: 13,591,643.7" — product decision after the
    security re-test at a2d2e68b): a report total may appear only as an independent,
    verified claim of the answer itself.
    """
    lines: list[str] = []
    if not flagged:
        return ""
    if str(locale or "").lower().startswith("en"):
        lines.append("⚠️ Withheld: the data this answer read does not produce these figures "
                     "for what was asked, so they are not shown.")
    else:
        lines.append("⚠️ Đã ẩn số chưa kiểm chứng: dữ liệu mà câu trả lời đã đọc không cho ra các "
                     "con số này cho đúng điều được hỏi, nên chúng không được hiển thị.")
    return "\n".join(lines)


def with_reader_note(text: str, note: str) -> str:
    """The answer with `note` placed in the body - before any [FOLLOWUP] line."""
    if not note:
        return text
    nl = chr(10)
    lines = text.rstrip().split(nl)
    at = next((i for i, l in enumerate(lines) if l.strip().startswith("[FOLLOWUP]")), len(lines))
    body, rest = nl.join(lines[:at]).rstrip(), lines[at:]
    return nl.join([body, "", note, *([""] + rest if rest else [])])


PLACEHOLDER = {"vi": "[đã ẩn: chưa kiểm chứng]", "en": "[withheld: not verified]"}
#: Written like "phần trăm"/"percent" instead of "%": the check reads it as a
#: percentage, so redaction must too (review: 91,89 phần trăm stayed visible).
_PCT_AFTER = __import__("re").compile(r"\s*(?:phần\s*trăm|phan\s*tram|percent)", __import__("re").I)
#: Spans that are labels, not figures: [chart:3], 3/2018, 2018-03, 2017-Q4, Q4.
_PROTECTED = __import__("re").compile(
    r"\[[^\]]*\]|(?<!\d)\d{1,2}/(?:19|20)\d{2}(?!\d)|(?<!\d)(?:19|20)\d{2}-(?:\d{1,2}|Q[1-4])(?!\d)"
    r"|(?<!\w)Q[1-4](?!\w)", __import__("re").I)


def redact(text: str, flagged: list[dict], locale: str = "vi") -> str:
    """The public answer with every flagged figure WITHHELD — the digits are
    replaced, never re-worded. A figure with the wrong meaning is not published
    beside a warning; the original draft stays in the run's audit trace."""
    import re

    from app.services.dashboard_ai_bot.verifier import _NUMBER_RE, _SCALE_WORDS, parse_number

    if not flagged:
        return text
    mark = PLACEHOLDER["en" if str(locale or "").lower().startswith("en") else "vi"]
    values = [(float(f["value"]), bool(f.get("pct"))) for f in flagged]
    protected = [(m.start(), m.end()) for m in _PROTECTED.finditer(text or "")]
    out, last = [], 0
    for m in _NUMBER_RE.finditer(text or ""):
        v = parse_number(m.group("num"))
        if v is None:
            continue
        scale = (m.group("scale") or "").strip().lower()
        if scale:
            v *= _SCALE_WORDS.get(scale, 1.0)
        if any(a <= m.start() < b or a < m.end() <= b for a, b in protected):
            continue                      # a period label or a [chart:3] reference
        is_pct = bool(m.group("pct")) or bool(_PCT_AFTER.match(text, m.end()))
        if any(abs(abs(v) - abs(fv)) <= 1e-9 * max(1.0, abs(fv)) and (is_pct or not fp)
               for fv, fp in values):
            out.append(text[last:m.start()])
            out.append(mark)
            last = m.end()
    out.append(text[last:])
    return re.sub(r"\s+(?=[.,;:])", "", "".join(out))



# ── TYPED OUTPUT GOES THROUGH THE SAME BOUNDARY ───────────────────────────────
#
# Pilot review (2026-09-29): an answering step with `output_format: json` built
# metric/table blocks and never reached `check()` — it lived in the chat branch
# only — so a metric value, a delta or a table cell carried any figure the model
# wrote straight to the reader. The blocks are rendered into ONE document that
# keeps each number's context (a metric is "label: value", a table row is its
# header line plus "column: value" pairs), checked with the same `check()`, and a
# flagged value is withheld in its typed position.

def _num_of(v: Any) -> float | None:
    try:
        return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    except Exception:                                           # noqa: BLE001
        return None


def _fmt_for_check(v: float, pct: bool) -> str:
    s = f"{v:.6f}".rstrip("0").rstrip(".")
    return s + ("%" if pct else "")


def _blocks_document(blocks: list[dict]) -> str:
    lines: list[str] = []
    for b in blocks:
        kind = b.get("type")
        if kind == "text":
            lines.append(str(b.get("markdown") or ""))
        elif kind == "callout":
            lines.append(str(b.get("text") or ""))
        elif kind == "metric":
            label = str(b.get("label") or "")
            v = _num_of(b.get("value"))
            if v is not None:
                lines.append(f"{label}: {_fmt_for_check(v, b.get('format') == 'percent')}.")
            d = b.get("delta") or {}
            dv = _num_of(d.get("value")) if isinstance(d, dict) else None
            if dv is not None:
                word = {"up": "tăng", "down": "giảm"}.get(str(d.get("direction") or ""), "thay đổi")
                lines.append(f"{label} {word} {_fmt_for_check(abs(dv), d.get('format', 'percent') == 'percent')}.")
        elif kind == "table":
            cols = [c for c in (b.get("columns") or []) if isinstance(c, dict)]
            head = ", ".join(str(c.get("label") or c.get("key") or "") for c in cols)
            lines.append(f"Bảng {head}:")
            for row in b.get("rows") or []:
                if not isinstance(row, dict):
                    continue
                cells = []
                for c in cols:
                    k = c.get("key")
                    v = row.get(k)
                    n = _num_of(v)
                    cells.append(f"{c.get('label') or k}: "
                                 f"{_fmt_for_check(n, c.get('format') == 'percent') if n is not None else v}")
                lines.append("- " + ", ".join(cells))
        elif kind == "followups":
            lines.extend(str(x) for x in (b.get("items") or []))
    return "\n".join(x for x in lines if x)


def _is_flagged(v: float, pct: bool, flagged: list[dict]) -> bool:
    return any(abs(abs(v) - abs(float(f["value"]))) <= 1e-6 * max(1.0, abs(v))
               and (pct or not f.get("pct")) for f in flagged)


def check_blocks(state: Any, ctx: Any, blocks: list[dict], locale: str = "vi") -> tuple[list[dict], dict]:
    """(blocks as published, the check's verdict with the draft) for typed output."""
    import copy

    doc = _blocks_document(blocks)
    final = check(state, ctx, doc) if doc else {}
    flagged = (final or {}).get("flagged") or []
    if not flagged:
        return blocks, final
    mark = PLACEHOLDER["en" if str(locale or "").lower().startswith("en") else "vi"]
    out = copy.deepcopy(blocks)
    for b in out:
        kind = b.get("type")
        if kind == "text":
            b["markdown"] = redact(str(b.get("markdown") or ""), flagged, locale)
        elif kind == "callout":
            b["text"] = redact(str(b.get("text") or ""), flagged, locale)
        elif kind == "followups":
            b["items"] = [redact(str(x), flagged, locale) for x in (b.get("items") or [])]
        elif kind == "metric":
            v = _num_of(b.get("value"))
            if v is not None and _is_flagged(v, b.get("format") == "percent", flagged):
                b["value"] = mark
                b["format"] = "text"
            d = b.get("delta") or {}
            dv = _num_of(d.get("value")) if isinstance(d, dict) else None
            if dv is not None and _is_flagged(dv, d.get("format", "percent") == "percent", flagged):
                b["delta"] = None
        elif kind == "table":
            pct_cols = {c.get("key") for c in (b.get("columns") or []) if isinstance(c, dict)
                        and c.get("format") == "percent"}
            for row in b.get("rows") or []:
                if isinstance(row, dict):
                    for k, v in list(row.items()):
                        n = _num_of(v)
                        if n is not None and _is_flagged(n, k in pct_cols, flagged):
                            row[k] = mark
    note = reader_note(flagged, locale)
    if note:
        out.append({"type": "callout", "level": "warning", "text": note})
    final = {**final, "draft": {"blocks": blocks}}
    return out, final
