"""Fetch the local cross-encoder reranker used by Knowledge Hub retrieval.

    docker exec appbi-ai-backend-1 python /app/scripts/fetch_reranker_model.py

WHY THIS IS A SCRIPT AND NOT PART OF THE IMAGE
---------------------------------------------
The model is 119MB. Baking it into the image makes every deployment of every
unrelated change carry it, and downloading it at container start makes a cold
start depend on huggingface.co being reachable — a service that has nothing to do
with whether this application can serve a dashboard.

So it lives in the `appbi_data` volume alongside the rest of the deployment's
state, and the code treats its absence exactly the way it treats a missing
tesseract binary: logged once, degrade to the lexical reranker, carry on. That is
a real degradation and it is a visible one, which is the only acceptable kind.

WHAT IT IS
----------
`cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` — a 12-layer multilingual
cross-encoder trained on mMARCO, which includes Vietnamese. The int8 ONNX export
plus `tokenizer.json` is everything needed; `onnxruntime` and `tokenizers` are in
requirements.txt and neither pulls in torch.

WHAT IT BUYS, MEASURED
----------------------
On the 34-case eval corpus (10 published documents), used as a relevance GATE:

  * dashboard scope: no change to any case
  * widest agent scope: hit@1 0.742 → 0.806, MRR 0.860 → 0.898 — two questions
    moved from rank 2 and rank 3 to rank 1, and nothing regressed
  * phrase_hit, recall@6 and absence_hit unchanged
  * p95 retrieval 439ms → 1256ms

Read that honestly: on a ten-document corpus it promotes two already-retrieved
passages. Its case gets stronger as the corpus grows and as passages become
lexically similar but semantically different, which is the situation a real
enterprise knowledge base arrives at and this one has not yet. Re-run
`eval/experiment_cross_encoder.py` after the corpus grows before assuming the
number above still describes it.
"""
from __future__ import annotations

import os
import shutil
import sys

REPO = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1"
TARGET = os.environ.get("DOC_RERANK_MODEL_DIR", "/app/.data/models/reranker")

#: Remote path → local name. The int8 export is chosen over fp32 (470MB) because
#: the score is used only for its SIGN — see doc_rerank._apply_relevance_gate —
#: and quantisation noise cannot flip a ±8 logit.
FILES = [
    ("onnx/model_qint8_avx512.onnx", "model_int8.onnx"),
    ("tokenizer.json", "tokenizer.json"),
    ("config.json", "config.json"),
]


def main() -> int:
    os.makedirs(TARGET, exist_ok=True)
    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        print("huggingface_hub is not installed. It ships with `tokenizers`; "
              "run `pip install -r requirements.txt` first.", file=sys.stderr)
        return 2

    for remote, local in FILES:
        destination = os.path.join(TARGET, local)
        if os.path.exists(destination) and os.path.getsize(destination) > 0:
            print("%-20s already present (%.1f MB)"
                  % (local, os.path.getsize(destination) / 1e6))
            continue
        try:
            cached = hf_hub_download(repo_id=REPO, filename=remote)
        except Exception as exc:  # noqa: BLE001
            print("could not fetch %s: %s" % (remote, exc), file=sys.stderr)
            return 1
        shutil.copy(cached, destination)
        print("%-20s %.1f MB" % (local, os.path.getsize(destination) / 1e6))

    sys.path.insert(0, "/app")
    from app.services.dashboard_ai_bot import doc_rerank_semantic

    doc_rerank_semantic.MODEL_DIR = TARGET
    if not doc_rerank_semantic.available():
        print("files are in place but the model did not load — see the log above",
              file=sys.stderr)
        return 1
    scores = doc_rerank_semantic.score_pairs(
        "tỷ lệ giao đúng hẹn mục tiêu bao nhiêu",
        [{"heading_path": "Vận hành > SLA",
          "content": "Mục tiêu tỷ lệ đơn giao đúng hẹn là từ 92% trở lên."},
         {"heading_path": "Marketing > Kênh",
          "content": "Chi phí thu hút khách hàng phân bổ theo kênh quảng cáo."}],
    )
    if not scores or scores[0] <= scores[1]:
        print("loaded, but scored a smoke-test pair wrong: %s" % scores, file=sys.stderr)
        return 1
    print("\nready — relevant %.2f vs irrelevant %.2f" % (scores[0], scores[1]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
