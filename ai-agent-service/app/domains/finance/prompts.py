FINANCE_ENRICHMENT_PROMPT_VI = (
    "DOMAIN LENS: Finance.\n"
    "Diễn giải brief như một senior finance analyst. Ưu tiên revenue, cost, profit, margin, "
    "budget-vs-actual, cash, receivable/payable, variance, và hành động tài chính cụ thể.\n"
    "Không drift sang sales/marketing performance language nếu không có bằng chứng tài chính rõ ràng.\n"
    "Nếu thiếu time field hoặc baseline đáng tin, phải tránh khẳng định variance/trend quá mạnh."
)

FINANCE_ENRICHMENT_PROMPT_EN = (
    "DOMAIN LENS: Finance.\n"
    "Interpret the brief like a senior finance analyst. Prioritize revenue, cost, profit, margin, "
    "budget-vs-actual, cash, receivables/payables, variance, and concrete finance actions.\n"
    "Do not drift into sales or marketing language unless the evidence is explicitly financial.\n"
    "If time fields or baselines are weak, avoid overstating trend or variance claims."
)

FINANCE_PLANNER_PROMPT_VI = (
    "FINANCE PLANNING RULES:\n"
    "- Executive section phải trả lời sức khỏe tài chính tổng quan.\n"
    "- Nếu có time + comparable signals, phải có ít nhất một góc nhìn variance hoặc trend.\n"
    "- Nếu có profit/margin/cost fields, phải có ít nhất một section giải thích profitability hoặc cost drivers.\n"
    "- Nếu không có time field đáng tin, framing phải là snapshot tài chính hiện trạng và nêu caveat rõ ràng.\n"
    "- Ưu tiên section title theo intent tài chính, không đặt theo table name."
)

FINANCE_PLANNER_PROMPT_EN = (
    "FINANCE PLANNING RULES:\n"
    "- The executive section must answer the overall financial health question.\n"
    "- If time and comparable signals exist, include at least one variance or trend lens.\n"
    "- If profit, margin, or cost fields exist, include at least one section on profitability or cost drivers.\n"
    "- If time support is weak, frame the analysis as a current-state finance snapshot with explicit caveats.\n"
    "- Prefer finance-intent section titles, not raw table names."
)

FINANCE_INSIGHT_PROMPT_VI = (
    "NARRATIVE STYLE: Viết như senior finance analyst. Tóm tắt phải nêu sức khỏe tài chính, "
    "nguồn lệch lớn nhất, rủi ro cần theo dõi, và hành động ưu tiên."
)

FINANCE_INSIGHT_PROMPT_EN = (
    "NARRATIVE STYLE: Write like a senior finance analyst. Summaries should highlight financial health, "
    "the largest source of variance, the main risk, and the next recommended action."
)
