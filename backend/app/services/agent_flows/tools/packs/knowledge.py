"""Read what the company has written down, inside AppBI.

The pack that makes a brain more than a calculator: the difference between "GMV is
4.2 tỷ" and "GMV is 4.2 tỷ, and GMV here includes shipping". The sources themselves
are attached per step in the brain, each with a description saying when to consult
it; these tools are how the model reaches them.

`describe_semantic_model` used to live here and now sits in `read`, where it is
the third question an author asks about a report rather than the fourth thing in a
documents pack. It describes the report's own structure, not something a person
wrote down.

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
            "search_knowledge",
            label_vi="Tìm trong tài liệu",
            label_en="Search documents",
            description_vi="Tìm trong các tài liệu tri thức mà bước này được gắn.",
            result_kind="documents",
            returns={
                "matches": "mỗi kết quả: tài liệu, đoạn trích, mức khớp",
                "citations": "nguồn để dẫn lại trong câu trả lời",
                "coverage": "tìm trong mấy tài liệu",
            },
            answers_vi=("Doanh thu ở đây định nghĩa thế nào?",),
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
