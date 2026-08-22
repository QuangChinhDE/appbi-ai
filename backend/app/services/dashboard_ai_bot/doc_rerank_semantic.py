"""A cross-encoder reranker that runs on this machine.

WHY A CROSS-ENCODER AT ALL
--------------------------
Retrieval scores a question and a passage SEPARATELY and compares the two
vectors. That is what makes it fast enough to search a corpus, and it is also its
ceiling: the passage was embedded before anyone asked the question, so nothing in
its vector knows which part of it the question is about. A cross-encoder reads
the pair together and scores the match directly. It cannot search — 100k
passages would be 100k forward passes — but over the twelve candidates retrieval
already found, it is the one component that can tell "mentions the SLA" from
"states the SLA".

WHY LOCAL, AND WHY THIS MODEL
-----------------------------
A cloud reranker means every question, and the passages retrieved for it, leave
the deployment — a new egress path covering content the per-document
`external_processing` policy was written to control, on the read side where there
is no policy to consult. So it runs here.

`mmarco-mMiniLMv2-L12-H384-v1` is a 12-layer, 384-hidden multilingual model
trained on mMARCO, which includes Vietnamese. The int8 ONNX export is 119MB and
needs neither torch nor sentencepiece — `onnxruntime` plus the `tokenizers`
library reads `tokenizer.json` directly. That matters: a reranker that adds a
gigabyte of PyTorch to the image is a reranker nobody deploys.

WHY IT IS ALLOWED TO LOSE
-------------------------
This is the fourth thing in this pipeline that was supposed to be an improvement,
and two of the previous three made ranking WORSE until they were measured and
re-weighted. So the honest shape is: it scores, the eval harness compares it
against the lexical reranker on the same 34 questions, and whichever wins is the
one that runs. There is no flag and no A/B — one path, chosen by measurement.

WHAT THE MEASUREMENT SAID (34 cases, eval/experiment_cross_encoder.py)
---------------------------------------------------------------------
The score is used as a GATE, not as a ranking. Five arms were compared:

  arm        agent hit@1   agent MRR   phrase_hit   p95
  current       0.742        0.860       0.933      455ms
  ce_only       0.613        0.674       0.767     1577ms   ← catastrophic
  ce_w05        0.806        0.895       0.900     1453ms
  ce_w015       0.774        0.879       0.933     1632ms
  ce_gate       0.839        0.906       0.933     1646ms   ← ships

`ce_only` collapsing recall@6 to 0.742 is the whole story: this model emits about
+8 for a match and −8 for a miss, so its own ordering is nearly binary. It knows
WHETHER a passage is relevant far better than the retriever does, and knows
almost nothing about which of two relevant passages is the better one — and that
second judgement is what decides whether the sentence holding the answer makes
the window. So the sign is used and the magnitude is not: a positive logit lifts
a candidate into the relevant band, and the existing cosine × lexical score, which
has a real gradient, orders it there.

This also degrades gracefully by construction. If every candidate scores positive
(or every one negative) the gate adds the same constant to all of them and the
ranking is exactly today's. It only intervenes where it can discriminate.

THE LIMIT: UNACCENTED VIETNAMESE
-------------------------------
A Vietnamese reader types "muc tieu giao dung hen" as often as "mục tiêu giao
đúng hẹn" — it is why `text_fold` exists and why every lexical path here folds.
This model does not fold. Measured on the same 34 questions with the diacritics
stripped from each one (eval/experiment_unaccented_queries.py):

  arm                accented                 unaccented
  gate off           0.742 / 0.860            0.742 / 0.860
  gate sign          0.806 / 0.898            0.742 / 0.860   ← identical to off
  gate margin 4      0.774 / 0.879            0.742 / 0.848   ← worse than off

On an unaccented query every candidate scores negative — the RELATIVE order
survives, the absolute sign does not — so the gate adds the same zero to
everything and the ranking is untouched. It is inert, not harmful: recall@3
(0.968) and phrase_hit (0.933) are unchanged, because the folding hybrid
underneath is what actually answers those queries.

A margin gate was the obvious fix for that and it was measured rather than
assumed: it LOSES on accented queries (recall@3 0.968 → 0.935) and loses on
unaccented ones too, because when every score is bad, "within 4 of the best" just
promotes the least-bad wrong answer. So the sign gate ships and this paragraph is
the record of why the relative one does not.
"""
from __future__ import annotations

import logging
import os
import threading
import time

logger = logging.getLogger(__name__)

#: Where the baked model lives. A missing model is not an error — the lexical
#: reranker is a complete implementation, not a fallback stub — but it IS logged
#: once, because "the semantic reranker silently never ran" is exactly the class
#: of failure this module's docstring is about.
MODEL_DIR = os.environ.get(
    "DOC_RERANK_MODEL_DIR", "/app/.data/models/reranker"
)

#: Truncation for the pair. The question is short; the passage is what gets cut.
#: 320 tokens covers a child chunk plus its heading path, which is what was
#: embedded — scoring more text than was retrievable would rank on words the
#: retriever could not have matched.
MAX_TOKENS = 320

#: Candidates to score. Retrieval returns k=12 and the assembler budgets from
#: those, so scoring sixteen paid for four passages nobody would ever see.
MAX_CANDIDATES = 12

#: Per-question wall-clock ceiling. A reranker that makes a question feel slow
#: gets switched off by whoever is on call, so it bounds itself: candidates
#: scored so far are used, the rest keep their fused rank, and the truncation is
#: reported rather than hidden.
TIME_BUDGET_MS = 900

_session = None
_tokenizer = None
_lock = threading.Lock()
_unavailable_logged = False


def available() -> bool:
    """Is the model present AND loadable? Cheap after the first call."""
    return _load() is not None


def warm() -> bool:
    """Build the ONNX session now, so the first real question does not pay for it.

    The first inference costs ~1.9s against ~700ms warm, because that is when the
    119MB session is constructed. Paying it at startup rather than in whoever asks
    the first question of the day is free — the process is going to load it anyway
    — and it turns a mysterious one-off slow answer into a startup log line.
    """
    if _load() is None:
        return False
    score_pairs("khoi dong", [{"heading_path": "", "content": "warm-up"}])
    logger.info("doc_rerank_semantic: warmed")
    return True


def _load():
    """The ONNX session and tokenizer, loaded once per process.

    Guarded by a lock because uvicorn runs several workers and a first request
    arriving on two threads would otherwise build two 119MB sessions.
    """
    global _session, _tokenizer, _unavailable_logged
    if _session is not None:
        return _session, _tokenizer
    with _lock:
        if _session is not None:
            return _session, _tokenizer
        model_path = os.path.join(MODEL_DIR, "model_int8.onnx")
        tokenizer_path = os.path.join(MODEL_DIR, "tokenizer.json")
        if not (os.path.exists(model_path) and os.path.exists(tokenizer_path)):
            if not _unavailable_logged:
                logger.info(
                    "doc_rerank_semantic: no model at %s — lexical reranking only",
                    MODEL_DIR,
                )
                _unavailable_logged = True
            return None
        try:
            import onnxruntime as ort
            from tokenizers import Tokenizer

            options = ort.SessionOptions()
            # One thread per session, several sessions per host: the API serves
            # concurrent requests, and letting each inference fan out over every
            # core makes two simultaneous questions slower than four sequential
            # ones.
            options.intra_op_num_threads = 2
            options.inter_op_num_threads = 1
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            session = ort.InferenceSession(
                model_path, sess_options=options, providers=["CPUExecutionProvider"]
            )
            tokenizer = Tokenizer.from_file(tokenizer_path)
            tokenizer.enable_truncation(max_length=MAX_TOKENS)
            tokenizer.enable_padding()
            _session, _tokenizer = session, tokenizer
            logger.info("doc_rerank_semantic: loaded %s", model_path)
            return _session, _tokenizer
        except Exception:  # noqa: BLE001
            if not _unavailable_logged:
                logger.warning(
                    "doc_rerank_semantic: model present but failed to load; "
                    "lexical reranking only", exc_info=True,
                )
                _unavailable_logged = True
            return None


def _passage(row: dict) -> str:
    """The text the model reads for one candidate.

    The heading path is included because it is part of what was EMBEDDED — the
    reranker scoring a different string from the one retrieval matched was a real
    bug in the lexical version, where the chunk whose heading answered the
    question scored zero.
    """
    parts = [
        str(row.get("heading_path") or ""),
        str(row.get("content") or ""),
    ]
    return "\n".join(p for p in parts if p).strip()


def score_pairs(question: str, rows: list[dict]) -> list[float] | None:
    """A relevance LOGIT per row — or None for that row when it was not scored —
    or None for the whole list when the model is unavailable.

    Unbounded and signed: positive means relevant, negative means not, and the
    magnitude carries the gradation a caller needs to order two passages that are
    both relevant. Callers combining it with cosine must scale it themselves —
    see doc_rerank, where the weight was swept rather than guessed.

    None and "all zeros" are deliberately different: the caller has to be able to
    tell "the model did not run" from "the model found nothing relevant", because
    the first is a deployment problem and the second is an answer.
    """
    loaded = _load()
    if loaded is None or not rows:
        return None
    session, tokenizer = loaded

    question = (question or "").strip()
    if not question:
        return None

    started = time.monotonic()
    # NONE, not zero. A candidate the model never looked at — beyond
    # MAX_CANDIDATES, or after the time budget ran out — must not look like one it
    # judged. Zero was chosen first, on the reasoning that it is the decision
    # boundary and therefore the honest "unknown"; it is not. Zero is a NUMBER, so
    # `max()` over a set of real negative logits and a few unscored sentinels
    # returns the sentinel, and `ce_relevant: False` on an unscored row asserts a
    # verdict that was never reached. Both were live: an answerability measurement
    # read 0.0 as "the best this question could do" for 40 of 48 cases.
    scores: list[float | None] = [None] * len(rows)
    budget = TIME_BUDGET_MS / 1000.0

    # Batched by SIMILAR LENGTH. Padding is per-batch, so mixing a two-line
    # passage with a full section made the short one cost as much as the long one;
    # grouping by length cut p95 without changing a single score. The original
    # order is restored through `order` below — a reranker that returned scores
    # against the wrong rows would be worse than no reranker.
    order = sorted(
        range(min(len(rows), MAX_CANDIDATES)),
        key=lambda i: len(_passage(rows[i])),
    )
    batch_size = 6
    for start in range(0, len(order), batch_size):
        if time.monotonic() - started > budget:
            logger.info(
                "doc_rerank_semantic: time budget reached after %d/%d candidates",
                start, len(order),
            )
            break
        indices = order[start:start + batch_size]
        chunk = [rows[i] for i in indices]
        try:
            encoded = tokenizer.encode_batch(
                [(question, _passage(row)) for row in chunk]
            )
            import numpy as np

            feed = {
                "input_ids": np.array([e.ids for e in encoded], dtype=np.int64),
                "attention_mask": np.array([e.attention_mask for e in encoded], dtype=np.int64),
            }
            names = {i.name for i in session.get_inputs()}
            if "token_type_ids" in names:
                feed["token_type_ids"] = np.array(
                    [e.type_ids for e in encoded], dtype=np.int64
                )
            feed = {k: v for k, v in feed.items() if k in names}
            logits = session.run(None, feed)[0]
            for offset, value in enumerate(logits):
                target = indices[offset]
                # THE RAW LOGIT, NOT A SIGMOID.
                #
                # Squashing was the first thing tried and it cost the measurement:
                # this model emits roughly +8 for a match and −8 for a miss, so
                # after a sigmoid every relevant passage scores 0.9998 and every
                # irrelevant one 0.0005. That is a nearly binary signal — it picks
                # the right DOCUMENT well and then cannot order the passages
                # WITHIN it, which is precisely the choice that decides whether the
                # sentence holding the answer is in the window. Measured: hit@1
                # rose 0.742→0.839 while phrase_hit fell 0.963→0.889, and the two
                # blend arms scored identically because a saturated score cannot be
                # reordered by anything. The raw logit keeps the gradation.
                scores[target] = (
                    float(value[0]) if getattr(value, "__len__", None) else float(value)
                )
        except Exception:  # noqa: BLE001
            logger.warning("doc_rerank_semantic: scoring batch failed", exc_info=True)
            return None

    return scores
