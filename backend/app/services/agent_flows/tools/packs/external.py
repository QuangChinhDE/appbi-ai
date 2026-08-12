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

`browse_ai_answer` was added at the operator's request after a review argued
against it. The reasoning for it is real — a search engine has already paid
for the synthesis, and a well-specified question makes that synthesis useful.
The objections were not dropped, they were built in: the surface it opens is
configured rather than assumed (whose terms may be automated is the
operator's decision, not this file's), a vague question is refused before it
runs, and every result is labelled a third-party claim with no method and no
date. It is off unless an endpoint is set AND Playwright is installed.

Kept small on purpose: nearly everything a brain needs is already in the app, and a
second escape hatch appearing here should have to be a deliberate decision.
"""
from __future__ import annotations

from app.services.agent_flows.tools.packs import browse_ai, research
from app.services.agent_flows.tools.packs._source import local, spec
from app.services.agent_flows.tools.registry import ToolPack

PACK = ToolPack(
    key="external",
    label_vi="Tra cứu ngoài hệ thống",
    label_en="Outside lookup",
    purpose_vi="Ra ngoài AppBI. Chỉ chạy khi link bật tìm kiếm web. Không bao giờ được cache.",
    requires_setting="web_search_enabled",
    tools=[
        local(
            "research_web",
            research.tool_research_web,
            research.RESEARCH_WEB_DEF,
            label_vi="Tra cứu web có dẫn chứng",
            label_en="Research the web",
            description_vi=(
                "Chạy nhiều truy vấn cùng lúc, gộp và xếp hạng theo mức đồng "
                "thuận, mở các trang tốt nhất rồi trả về ĐOẠN TRÍCH kèm nguồn. "
                "Làm trọn vòng tìm-và-đọc trong MỘT lần gọi, thay vì "
                "web_search rồi fetch_url nhiều lượt."
            ),
            result_kind="documents",
            returns={
                "sources": "mỗi nguồn: URL, tiêu đề, ngày, đoạn trích, đọc được thật hay chỉ snippet",
                "trust_note": "vì sao đây là tuyên bố bên ngoài, cách dẫn [web:N]",
                "coverage": "mở bao nhiêu trên tổng số tìm được",
            },
            cost_class="external",
            payload="medium",
            reaches_outside=True,
            deterministic=False,
            answers_vi=("Ngành này thế giới đang ở mức nào?",
                        "Benchmark tỉ lệ giao đúng hẹn TMĐT là bao nhiêu?"),
        ),
        local(
            "browse_ai_answer",
            browse_ai.tool_browse_ai_answer,
            browse_ai.BROWSE_AI_ANSWER_DEF,
            label_vi="Hỏi AI của công cụ tìm kiếm",
            label_en="Ask a web answer surface",
            description_vi=(
                "Mở trình duyệt ẩn, hỏi một câu THẬT CHI TIẾT và đọc đoạn tóm tắt "
                "AI mà trang đó viết, kèm link nó dẫn. Câu hỏi mơ hồ bị từ chối. "
                "Kết quả là TUYÊN BỐ của bên thứ ba — phải dẫn nguồn, không bao "
                "giờ đặt cạnh số của báo cáo như thể so sánh được."
            ),
            result_kind="documents",
            returns={
                "summary": "đoạn tóm tắt do AI của trang viết",
                "citations": "các link trang đó dẫn — đáng tin hơn đoạn tóm tắt",
                "trust_note": "vì sao đây không phải số đo",
                "coverage": "cắt bao nhiêu nếu tóm tắt dài",
            },
            cost_class="external",
            payload="medium",
            reaches_outside=True,
            deterministic=False,
            self_sufficient=False,
            answers_vi=("Ngành SaaS B2B Việt Nam tăng trưởng bao nhiêu %/năm 2024?",
                        "Biên lợi nhuận gộp trung bình ngành TMĐT Brazil?"),
        ),
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
            # 670–697 tokens measured for five results with 600-char snippets.
            payload="medium",
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
                "report": "số của báo cáo, TÍNH THẾ NÀO và trên bao nhiêu dòng",
                "external": "số tham chiếu và nguồn",
                "instruction": "lưu ý khi so — nguồn ngoài có thể khác cách tính",
            },
            cost_class="external",
            # Measured, not estimated: 724–727 tokens across three live calls,
            # because the payload carries five search results with snippets. It
            # was declared `small` (<= 500) and the registry logged the breach on
            # every single call — a declaration nobody had checked against the
            # thing it describes.
            payload="medium",
            reaches_outside=True,
            deterministic=False,
            answers_vi=("Tỉ lệ này so với thị trường thế nào?",),
        ),
    ],
)
