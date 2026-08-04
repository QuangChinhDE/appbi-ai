"""Read what the company has written down, inside AppBI.

The pack that makes a brain more than a calculator: the difference between "GMV is
4.2 tỷ" and "GMV is 4.2 tỷ, and GMV here includes shipping". The sources themselves
are attached per step in the brain, each with a description saying when to consult
it; these tools are how the model reaches them.

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
    tools=[
        spec(
            "search_knowledge",
            label_vi="Tìm trong tài liệu",
            label_en="Search documents",
            description_vi="Tìm trong các tài liệu tri thức mà bước này được gắn.",
        ),
        spec(
            "read_document",
            label_vi="Đọc một tài liệu",
            label_en="Read a document",
            description_vi="Đọc trọn một tài liệu đã được gắn cho bước này.",
        ),
        spec(
            "describe_semantic_model",
            label_vi="Đọc mô hình dữ liệu",
            label_en="Describe semantic model",
            description_vi=(
                "Ý nghĩa và công thức các measure/dimension của một bộ dữ liệu."
            ),
        ),
        spec(
            "recall_knowledge",
            label_vi="Nhớ lại điều đã học",
            label_en="Recall knowledge",
            description_vi="Tra những điều đã được duyệt và tích luỹ về doanh nghiệp.",
        ),
    ],
)
