/**
 * Doc-type markdown templates — the "structured sections" for KPI/domain, SOP,
 * report guides and AI know-how WITHOUT hard-coded per-type forms: picking a
 * type on an EMPTY document inserts the matching skeleton, which the author
 * fills in normal Markdown. This keeps the whole markdown + {{token}} + RAG
 * pipeline intact while giving AI (and new readers) a predictable structure.
 *
 * Vietnamese-first (the authoring language of the hub).
 */
export const DOC_TEMPLATES: Record<string, string> = {
  domain: `## Ý nghĩa nghiệp vụ
Mảng này nói về điều gì, vì sao quan trọng.

## Chỉ số chính
Chèn chỉ số quản trị bằng nút "Định nghĩa chỉ số" hoặc {{metric:slug}} — kèm ý nghĩa + cách tính.

## Nguồn dữ liệu & làm mới
Dữ liệu lấy từ đâu ({{dataset:id}}), tần suất cập nhật.

## Cách đọc & phân tích
Đọc số theo thứ tự nào, đối chiếu gì với gì.

## Ngoại lệ & lưu ý
Trường hợp ngoại lệ, bẫy khi đọc số.
`,
  sop: `## Mục đích
Quy trình này tồn tại để làm gì.

## Phạm vi
Áp dụng cho bộ phận/tình huống nào.

## Vai trò tham gia
Ai làm gì (người thực hiện, người duyệt).

## Đầu vào
Cần gì trước khi bắt đầu.

## Các bước thực hiện
1. …
2. …
3. …

## Đầu ra
Kết quả bàn giao là gì.

## Ngoại lệ
Khi nào đi lệch quy trình và xử lý ra sao.

## Hệ thống liên quan
Báo cáo/dữ liệu liên quan: {{dashboard:id}}, {{dataset:id}}.
`,
  report: `## Mục tiêu kinh doanh
Báo cáo này trả lời câu hỏi gì, phục vụ quyết định nào.

## Đối tượng sử dụng
Ai xem, xem khi nào.

## Chỉ số trên báo cáo
Chèn {{metric:slug}} cho từng chỉ số chính — kèm ngưỡng/mục tiêu.

## Nguồn dữ liệu
{{dataset:id}} — mô hình, cấp dữ liệu (grain).

## Báo cáo
{{dashboard:id}} — các trang/biểu đồ chính.

## Tần suất cập nhật
Lịch làm mới dữ liệu.

## Lưu ý chất lượng dữ liệu
Giới hạn, dữ liệu chưa đủ, quy ước cần biết.
`,
  ai_knowhow: `## Câu hỏi
Câu hỏi nghiệp vụ mà tri thức này trả lời.

## Trả lời
Câu trả lời chuẩn, ngắn gọn, đúng thuật ngữ.

## Suy luận
Vì sao trả lời như vậy — logic, công thức, nguồn số ({{metric:slug}}, {{dashboard:id}}).

## Ví dụ đúng
Tình huống áp dụng đúng.

## Ví dụ sai / phản ví dụ
Tình huống dễ nhầm và cách phân biệt.

## Quy tắc nghiệp vụ
Các quy tắc bất biến liên quan.
`,
};

/** Template for a doc type, or '' when the type has no skeleton. */
export function docTemplate(docType: string | undefined | null): string {
  return DOC_TEMPLATES[String(docType || '')] ?? '';
}
