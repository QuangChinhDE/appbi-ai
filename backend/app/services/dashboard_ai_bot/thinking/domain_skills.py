"""Domain skill packs — chuyên môn theo lĩnh vực để inject vào system prompt.

Mục tiêu: prompt từ user thường thiếu ngữ cảnh domain (KPI quan trọng,
ngưỡng "tốt/xấu" theo ngành, công thức chuẩn, red flag thường gặp).
Module này cung cấp một đoạn know-how ngắn theo từng domain; được
ghép vào prompt khi briefing đã confirm domain.

Quy tắc viết skill (giữ NGẮN — đây là tokens trả phí):
  - 6-12 dòng/domain.
  - Liệt kê: KPI cốt lõi & công thức, ngưỡng red-flag thường gặp,
    glossary thuật ngữ hay nhầm lẫn, góc nhìn đặc thù.
  - KHÔNG dạy lại cách phân tích — agent đã có Phase 1-4 rồi.
  - KHÔNG ghi đè rule citation/format/language của system prompt chính.
  - Mọi ngưỡng đều là "common-sense default", agent vẫn phải bám số
    thực trong dashboard; nếu domain knowledge mâu thuẫn dữ liệu, BÁM
    DỮ LIỆU.

Các domain key phải khớp với ``_DOMAIN_KEYWORDS`` trong ``briefing.py``.
Domain ``generic`` không có skill (fallback rỗng).
"""
from __future__ import annotations

# Map domain key → đoạn know-how. Giữ tiếng Việt vì user và dashboard
# chủ yếu dùng VI; agent sẽ tự dịch khi user hỏi tiếng EN.
_DOMAIN_SKILLS: dict[str, str] = {
    "sales": """\
Lĩnh vực: KINH DOANH / BÁN HÀNG.
- KPI cốt lõi: Revenue, # đơn (orders), AOV = Revenue/#orders, Win rate =
  #won/#opportunities, Conversion rate = #orders/#leads, Pipeline value,
  Sales cycle days, Customer acquisition cost (CAC), CLV.
- Phễu chuẩn: Lead → MQL → SQL → Opportunity → Won. Drop-off ở bước nào
  là vấn đề ở đó (lead quality vs sales execution vs pricing).
- Red flag: win rate < 15% B2B / < 5% B2C; pipeline coverage < 3× quota;
  AOV giảm + #orders tăng → bào mòn giá; top 1 KH chiếm > 30% revenue =
  rủi ro tập trung; sales cycle dài hơn cùng kỳ > 20% = pipeline kẹt.
- Đừng nhầm: "lead" ≠ "opportunity"; "booking" (ký) ≠ "revenue" (ghi
  nhận); "gross" ≠ "net" sau chiết khấu/return.
- Khi user hỏi "tại sao doanh thu giảm" → phân rã: giá × số lượng × mix
  sản phẩm × kênh × phân khúc KH; tìm bậc đóng góp lớn nhất.""",

    "marketing": """\
Lĩnh vực: MARKETING.
- KPI cốt lõi: Reach, Impressions, CTR = Clicks/Impressions, CPC = Spend/
  Clicks, CPM = Spend/Impressions × 1000, CR = Conversions/Clicks, CPA =
  Spend/Conversions, ROAS = Revenue/Ad spend, LTV/CAC.
- Phễu marketing: Awareness → Consideration → Conversion → Retention.
  Mỗi tầng có metric riêng (impressions / engagement / CR / churn).
- Ngưỡng tham khảo (digital, vary theo ngành): CTR < 1% search hoặc <
  0.5% display = yếu; CR < 1% = phễu hỏng hoặc landing kém; ROAS < 1 =
  lỗ; ROAS 3-5 ổn; > 5 rất tốt.
- Red flag: spend tăng + CR giảm → audience/landing/creative xuống cấp;
  CPC tăng đột ngột → đối thủ bid mạnh hoặc Quality Score giảm; bounce
  rate > 70% trên trang đích; engagement cao nhưng CR thấp → traffic
  không match intent.
- Đừng nhầm: reach (unique) vs impressions (lần hiện); attribution
  last-click bóp méo các kênh top-of-funnel.""",

    "finance": """\
Lĩnh vực: TÀI CHÍNH.
- KPI cốt lõi: Revenue, COGS, Gross profit = Rev − COGS, Gross margin %,
  OPEX, EBITDA, Net profit, Cash flow (operating/investing/financing),
  AR/AP days (DSO/DPO), Burn rate, Runway = Cash/Burn, Budget vs Actual
  variance %.
- Nguyên tắc: phân biệt rõ DOANH THU (recognized) vs THU TIỀN (cash);
  CHI PHÍ (incurred) vs CHI TIỀN (paid). Một dashboard có thể trộn cả
  hai — đọc tên cột kỹ.
- Red flag: gross margin giảm > 3 điểm % so với cùng kỳ = giá vào tăng
  hoặc giá bán bị ép; DSO tăng = công nợ chậm thu; OPEX tăng nhanh hơn
  Revenue = đòn bẩy âm; runway < 6 tháng = critical; variance vs budget
  > ±10% = cần giải trình.
- Glossary: CapEx vs OpEx; cash vs accrual; gross vs net; pre-tax vs
  post-tax; YoY vs MoM vs QoQ.
- Khi user hỏi "lợi nhuận sao giảm" → bóc tách Revenue mix, COGS, OPEX,
  one-off items; đừng kết luận "chi phí cao" khi chưa so margin.""",

    "ops": """\
Lĩnh vực: VẬN HÀNH / SẢN XUẤT.
- KPI cốt lõi: Throughput (sản lượng/thời gian), Cycle time, Lead time,
  OEE = Availability × Performance × Quality, FPY (First Pass Yield),
  Defect rate / scrap rate, On-time delivery (OTD), Inventory turnover =
  COGS/Avg inventory, Days inventory on hand, Downtime hours, MTBF/MTTR,
  SLA compliance %.
- Khái niệm: Cycle time = thời gian thực sự sản xuất 1 đơn vị; Lead time
  = từ lúc nhận order đến lúc giao (gồm chờ). Đừng nhầm.
- Ngưỡng tham khảo: OEE world-class ≥ 85%, average 60%, < 40% = nghiêm
  trọng; FPY < 95% trong sản xuất chính xác = vấn đề chất lượng; OTD <
  90% = SLA rủi ro; defect rate > 2% (industry tùy thuộc) = cần action.
- Red flag: throughput tăng + defect rate tăng = đẩy năng suất bằng
  cách hy sinh chất lượng; downtime tập trung vào 1-2 máy/line = bottle-
  neck; tồn kho tăng + sales đứng yên = dòng tiền âm sắp tới.
- 7 lãng phí (Lean): overproduction, waiting, transport, over-processing,
  inventory, motion, defects — dùng để phân loại insight.""",

    "hr": """\
Lĩnh vực: NHÂN SỰ.
- KPI cốt lõi: Headcount, Attrition (turnover) rate = #leavers/Avg HC,
  Voluntary vs involuntary attrition, Time to hire, Cost per hire,
  Offer acceptance rate, Tenure trung bình, eNPS, Absence rate, Training
  hours/người, Performance distribution.
- Ngưỡng tham khảo: attrition tự nguyện > 15%/năm (ngoài tech) hoặc >
  20% (tech) = cảnh báo; time to hire > 60 ngày = bottleneck recruiting;
  offer acceptance < 70% = lương/employer brand có vấn đề.
- Red flag: attrition tập trung ở high-performer hoặc 1 phòng = hệ thống
  có vấn đề (manager/lương/career path); tỉ lệ nữ/nam lệch mạnh ở 1 cấp
  = D&I issue; chấm công bất thường (>2σ) = burnout hoặc gian lận.
- Glossary: headcount đầu kỳ vs cuối kỳ vs trung bình (FTE); attrition
  rolling 12m chuẩn hơn YTD vì khử mùa vụ.""",

    "support": """\
Lĩnh vực: CHĂM SÓC KHÁCH HÀNG / SUPPORT.
- KPI cốt lõi: Ticket volume, FRT (First Response Time), Resolution time
  (P50/P90), CSAT, NPS, FCR (First Contact Resolution), Backlog size,
  SLA compliance %, Reopen rate, Ticket per agent.
- Ngưỡng tham khảo: CSAT < 80% = báo động; SLA compliance < 90% = vi
  phạm hợp đồng; FCR < 70% = quy trình kéo dài; reopen > 10% = giải
  pháp tạm; backlog tăng liên tục 3 tuần = thiếu năng lực.
- Red flag: volume tăng + CSAT giảm = sản phẩm có lỗi mới hoặc tài liệu
  yếu; 1 agent xử lý quá nhiều = rủi ro burnout/chất lượng; cùng 1 chủ
  đề chiếm > 20% tickets = bug/UX cần escalate sang product.
- Phân loại tickets theo: type (bug/how-to/billing), severity (P0-P3),
  channel (email/chat/phone), product area — để tìm root cause.""",

    "education": """\
Lĩnh vực: ĐÀO TẠO / GIÁO DỤC.
- KPI cốt lõi: Enrollment, Completion rate = #completed/#enrolled,
  Drop-out rate, Pass rate, Average score, Engagement (lessons/active
  user, time spent), CSAT khóa học, Cost per student, Retention K+1.
- Ngưỡng: completion < 30% MOOC bình thường, < 50% với khóa trả phí =
  cần soát lại nội dung/động cơ; pass rate < 60% = bài kiểm tra quá khó
  hoặc giảng dạy chưa hiệu quả; drop-out tập trung ở module X = nội
  dung điểm chết.
- Red flag: enrollment cao + engagement thấp = marketing thừa, sản
  phẩm thiếu; điểm trung bình tăng đột ngột = grade inflation hoặc đề
  dễ; tỉ lệ trượt cao ở 1 GV/lớp = vấn đề giảng dạy.""",

    "task_management": """\
Lĩnh vực: QUẢN LÝ CÔNG VIỆC / DỰ ÁN.
- KPI cốt lõi: Total tasks, Completion rate = #done/#total, Overdue rate
  = #overdue/#total, Cycle time (created → done), Throughput tasks/tuần,
  WIP (in-progress count), Aging WIP (#task > N ngày), On-time rate.
- Ngưỡng: completion < 50% = đội đang chậm; overdue > 20% = SLA xuống
  cấp; WIP > 2× headcount = đa nhiệm quá tải; aging WIP > 14 ngày =
  task "zombie".
- Red flag: total task tăng + completion giảm = workload vượt năng lực;
  overdue tập trung 1 phòng = bottleneck; assignee nhiều task pending =
  rủi ro single point of failure.
- Đừng nhầm: "đã giao" ≠ "đã làm xong"; "đúng hạn" tính theo deadline
  ban đầu, không phải deadline đã dời.""",
}


def get_domain_skill(domain: str) -> str:
    """Trả đoạn skill text cho domain. Rỗng nếu không có (generic / unknown)."""
    if not domain:
        return ""
    return _DOMAIN_SKILLS.get(domain.strip().lower(), "")


def format_domain_skill_block(domain: str) -> str:
    """Render skill thành block sẵn sàng nối vào system prompt.

    Trả chuỗi rỗng khi domain không có skill — caller chỉ cần concat.
    """
    body = get_domain_skill(domain)
    if not body:
        return ""
    return (
        "═══ DOMAIN KNOW-HOW (tham khảo, KHÔNG ghi đè dữ liệu thực) ═══\n"
        f"{body}\n"
        "→ Dùng phần này như checklist khi triage và viết câu trả lời. "
        "Nếu dashboard không có metric tương ứng, không bịa — chỉ chọn "
        "góc nhìn liên quan tới các chart đang có."
    )


__all__ = ["get_domain_skill", "format_domain_skill_block"]
