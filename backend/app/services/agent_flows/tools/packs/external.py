"""The only pack that leaves AppBI.

Withheld unless the deployment turns web research on. The tools stay REGISTERED
either way, so a stored brain that was granted one still reads correctly and still
says what it wanted — it simply cannot call it. The previous module enforced this by
keeping a second schema list and remembering to concatenate it once per turn;
making it a property of the pack removes the chance to forget.

Kept small on purpose: nearly everything a brain needs is already in the app, and a
second escape hatch appearing here should have to be a deliberate decision.
"""
from __future__ import annotations

from app.services.agent_flows.tools.packs._source import spec
from app.services.agent_flows.tools.registry import ToolPack

PACK = ToolPack(
    key="external",
    label_vi="Tra cứu ngoài hệ thống",
    label_en="Outside lookup",
    requires_setting="web_search_enabled",
    tools=[
        spec(
            "web_search",
            label_vi="Tìm trên web",
            label_en="Web search",
            description_vi="Tra thông tin thị trường/ngành ngoài báo cáo.",
            cost_class="external",
            reaches_outside=True,
        ),
        spec(
            "fetch_url",
            label_vi="Đọc một trang web",
            label_en="Fetch a URL",
            description_vi="Đọc nội dung một đường dẫn cụ thể.",
            cost_class="external",
            reaches_outside=True,
        ),
        spec(
            "benchmark_compare",
            label_vi="Đối chiếu benchmark ngoài",
            label_en="Benchmark compare",
            description_vi=(
                "So một con số của báo cáo với benchmark tìm được bên ngoài."
            ),
            cost_class="external",
            reaches_outside=True,
        ),
    ],
)
