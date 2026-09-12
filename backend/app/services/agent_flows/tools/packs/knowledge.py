"""Read what the company has written down, inside AppBI.

The pack that makes a brain more than a calculator: the difference between "GMV is
4.2 tỷ" and "GMV is 4.2 tỷ, and GMV here includes shipping". The sources themselves
are attached per step in the brain, each with a description saying when to consult
it; these tools are how the model reaches them.

`describe_semantic_model` used to live here and now sits in `read`, where it is
the third question an author asks about a report rather than the fourth thing in a
documents pack. It describes the report's own structure, not something a person
wrote down.

SETTLED: A MEASUREMENT CAN NOW ASK WHY
--------------------------------------
This section used to record an open question. "Revenue is 8% below plan" is a
fact; whether it is a problem depends on things written down somewhere — the
plan's assumptions, a known outage, a seasonality note in the handbook. The
comparison tools and the knowledge tools were granted separately and never met,
and nothing told a comparison result that a relevant document existed.

`explain_measurement` is the join. It takes a target check's own output — the
measure, the status, the shortfall — and returns what the business wrote about
that metric: its definition, how it is calculated, which cases are excluded.

The retrieval question the deferral named — when is a document RELEVANT to a
figure — is answered by the metric record rather than by a heuristic. A chart
column called `on_time_rate` retrieves nothing from a corpus that says "tỷ lệ giao
đúng hẹn", and the governed KPI is where the business already wrote down that
those are the same thing. Its `home_doc_id` is a DECLARATION, so those passages
come back marked `metric_home` and a reader can tell a declared definition from a
similarity match.

The cost question is answered by not paying it until asked: the target result says
an explanation is available and this tool fetches it.

`remember_fact` is absent. Writing back into the knowledge base required a human to
approve anything an anonymous viewer taught; that approval screen has been deleted,
and a queue nobody can clear is worse than no queue. Recall stays — reading what
was already approved was never the risky half.
"""
from __future__ import annotations

from app.services.agent_flows.tools.packs._source import spec
from app.services.agent_flows.tools.registry import ToolPack

PACK = ToolPack(
    key="knowledge",
    label_vi="Tri thức nội bộ",
    label_en="Internal knowledge",
    purpose_vi="Tra định nghĩa, quy tắc, tài liệu doanh nghiệp đã gắn cho bước này.",
    tools=[
        spec(
            "explain_measurement",
            label_vi="Giải thích con số",
            label_en="Explain a measurement",
            description_vi="Tra tài liệu để biết một chỉ số vừa đo được định "
                           "nghĩa thế nào, tính ra sao và loại trừ trường hợp nào.",
            result_kind="documents",
            payload="medium",
            returns={
                "asked": "câu hỏi đã tra, dựng từ chính con số vừa đo",
                "reason": "vì sao phải tra — con số nào, hụt bao nhiêu",
                "results": "đoạn tài liệu, kèm reached_by: metric_home | semantic",
                "answerability": "ANSWERABLE | NOT_ENOUGH_EVIDENCE | CONTRADICTORY",
                "citations": "nguồn để dẫn, mở lại được đúng phiên bản",
            },
            answers_vi=("Vì sao chỉ số này không đạt mục tiêu?",
                        "Chỉ số này loại trừ trường hợp nào?"),
        ),
        spec(
            "search_knowledge",
            label_vi="Tìm trong tài liệu",
            label_en="Search documents",
            description_vi="Tìm trong tài liệu, định nghĩa chỉ số và thuật ngữ "
                           "công ty gắn với báo cáo này.",
            result_kind="documents",
            # MEASURED 83..562 tokens. Over `small` at the top end, and the extra
            # is `updated_at`/`version` per hit — which is the field that decides
            # whether a document should still be trusted, so it earns its place.
            payload="medium",
            returns={
                "results": "mỗi kết quả: id, tiêu đề, trích đoạn, điểm khớp, "
                           "NGÀY cập nhật và phiên bản",
                # Named in the contract because the model is told to weigh hits by
                # it: a definition tied to this report's data is not the same
                # claim as one that merely shares a word with the question.
                "reached_by": "vì sao kết quả này liên quan tới báo cáo: gắn tay, "
                              "qua measure, qua chỉ số, hay chỉ khớp từ ngữ",
                "citations": "nguồn để dẫn lại trong câu trả lời",
                "coverage": "tìm trong mấy tài liệu",
            },
            answers_vi=("Doanh thu ở đây định nghĩa thế nào?",
                        "Công ty mình định nghĩa GMV ra sao?"),
        ),
        spec(
            "read_document",
            label_vi="Đọc một tài liệu",
            label_en="Read a document",
            description_vi="Đọc trọn một tài liệu đã được gắn cho bước này.",
            result_kind="documents",
            payload="large",
            returns={
                "title": "tên tài liệu",
                "content": "nội dung",
                "coverage": "đọc được bao nhiêu phần nếu tài liệu dài",
            },
            answers_vi=("Cho tôi nội dung tài liệu quy tắc tính",),
        ),
        spec(
            "recall_knowledge",
            label_vi="Nhớ lại điều đã học",
            label_en="Recall knowledge",
            description_vi="Tra những điều đã được duyệt và tích luỹ về doanh nghiệp.",
            result_kind="documents",
            returns={
                "facts": "mỗi mục: nội dung, ai duyệt, khi nào",
                "citations": "nguồn",
            },
            answers_vi=("Trước đây đã kết luận gì về nhóm khách này?",),
        ),
    ],
)
