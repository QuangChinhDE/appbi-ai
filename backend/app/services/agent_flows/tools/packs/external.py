"""The only pack that leaves AppBI.

Withheld unless the deployment turns web research on. The tools stay REGISTERED
either way, so a stored brain that was granted one still reads correctly and still
says what it wanted — it simply cannot call it. The previous module enforced this by
keeping a second schema list and remembering to concatenate it once per turn;
making it a property of the pack removes the chance to forget.

Nothing here is cacheable, and that is enforced at declaration rather than left to
each tool: the registry refuses a spec that is both `reaches_outside` and
`cacheable`. A cached web result is a stale fact wearing a fresh timestamp, and
the whole reason to go outside is that the outside changes.

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
    purpose_vi="Ra ngoài AppBI. Chỉ chạy khi link bật tìm kiếm web. Không bao giờ được cache.",
    requires_setting="web_search_enabled",
    tools=[
        spec(
            "web_search",
            label_vi="Tìm trên web",
            label_en="Web search",
            description_vi="Tra thông tin thị trường/ngành ngoài báo cáo.",
            result_kind="documents",
            returns={
                "results": "mỗi kết quả: tiêu đề, đường dẫn, trích đoạn",
                "answer": "tóm tắt của nhà cung cấp, nếu có",
                "provider": "ai trả kết quả này",
            },
            cost_class="external",
            reaches_outside=True,
            deterministic=False,
            answers_vi=("Ngành này trung bình bao nhiêu?",),
        ),
        spec(
            "fetch_url",
            label_vi="Đọc một trang web",
            label_en="Fetch a URL",
            description_vi="Đọc nội dung một đường dẫn cụ thể.",
            result_kind="documents",
            returns={
                "url": "địa chỉ đã đọc",
                "content": "nội dung dạng chữ",
                "coverage": "đọc được bao nhiêu nếu trang dài",
            },
            cost_class="external",
            payload="large",
            reaches_outside=True,
            deterministic=False,
            answers_vi=("Đọc giúp tôi trang này",),
        ),
        spec(
            "benchmark_compare",
            label_vi="Đối chiếu benchmark ngoài",
            label_en="Benchmark compare",
            description_vi=(
                "So một con số của báo cáo với benchmark tìm được bên ngoài."
            ),
            result_kind="comparison",
            returns={
                "report": "số của báo cáo và lấy từ biểu đồ nào",
                "external": "số tham chiếu và nguồn",
                "instruction": "lưu ý khi so — nguồn ngoài có thể khác cách tính",
            },
            cost_class="external",
            reaches_outside=True,
            deterministic=False,
            answers_vi=("Tỉ lệ này so với thị trường thế nào?",),
        ),
    ],
)
