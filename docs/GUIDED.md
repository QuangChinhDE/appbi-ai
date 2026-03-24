# AppBI — Hướng Dẫn Sử Dụng

> Tài liệu dành cho người dùng và admin mới bắt đầu với AppBI. Hướng dẫn này đi từ kết nối dữ liệu, xây workspace, tạo chart, lắp dashboard, dùng AI Chat, dùng AI Agent, cho đến chia sẻ và phân quyền.

---

## Mục Lục

1. [AppBI là gì?](#1-appbi-là-gì)
2. [Đăng nhập và giao diện chính](#2-đăng-nhập-và-giao-diện-chính)
3. [Data Sources — Kết nối nguồn dữ liệu](#3-data-sources--kết-nối-nguồn-dữ-liệu)
4. [Dataset Workspaces — Chuẩn bị dữ liệu phân tích](#4-dataset-workspaces--chuẩn-bị-dữ-liệu-phân-tích)
5. [AI Description cho Table và Chart](#5-ai-description-cho-table-và-chart)
6. [Explore — Xây dựng biểu đồ](#6-explore--xây-dựng-biểu-đồ)
7. [Dashboards — Tổng hợp báo cáo](#7-dashboards--tổng-hợp-báo-cáo)
8. [AI Chat — Trợ lý phân tích phản hồi theo câu hỏi](#8-ai-chat--trợ-lý-phân-tích-phản-hồi-theo-câu-hỏi)
9. [AI Agent — Tự động lập kế hoạch và tạo dashboard](#9-ai-agent--tự-động-lập-kế-hoạch-và-tạo-dashboard)
10. [Chia sẻ và phân quyền](#10-chia-sẻ-và-phân-quyền)
11. [Quản trị hệ thống](#11-quản-trị-hệ-thống)
12. [Luồng sử dụng đầy đủ từ A đến Z](#12-luồng-sử-dụng-đầy-đủ-từ-a-đến-z)
13. [Câu hỏi thường gặp](#13-câu-hỏi-thường-gặp)
14. [Ghi chú kỹ thuật và vận hành](#14-ghi-chú-kỹ-thuật-và-vận-hành)

---

## 1. AppBI là gì?

**AppBI** là nền tảng BI self-hosted giúp bạn kết nối dữ liệu, chuẩn bị bảng phân tích, tạo chart, dựng dashboard, rồi khai thác AI để phân tích hoặc tạo báo cáo tự động.

Bạn có thể dùng AppBI để:

- kết nối nhiều loại nguồn dữ liệu như PostgreSQL, MySQL, BigQuery, Google Sheets hoặc file
- sync dữ liệu vào lớp phân tích của hệ thống
- tạo **workspace tables** để chuẩn hóa dữ liệu trước khi vẽ biểu đồ
- tạo chart và ghép nhiều chart thành dashboard
- dùng **AI Chat** để hỏi đáp và khám phá dữ liệu theo câu hỏi
- dùng **AI Agent** để lập plan và tự động tạo một dashboard hoàn chỉnh

### Kiến trúc khái niệm

```text
Nguồn dữ liệu -> Data Source -> Workspace Table -> Chart -> Dashboard
                                              |            |
                                              |            +-> AI Agent build dashboard
                                              +-> AI Chat / AI Description
```

### Hai hệ AI hiện tại

AppBI hiện có hai hệ AI tách biệt:

| Hệ AI | Vai trò | Điểm vào |
|------|---------|----------|
| **AI Chat** | Trả lời câu hỏi, giải thích, tạo chart lẻ khi cần | `/chat` |
| **AI Agent** | Lập plan, tạo nhiều chart, ghép thành dashboard | `/dashboards` |

Ngoài ra còn có **AI Description** cho table và chart. Đây là lớp metadata AI riêng, không phải AI Chat và cũng không phải AI Agent.

---

## 2. Đăng nhập và giao diện chính

Truy cập `http://localhost:3000`, nhập email và mật khẩu rồi bấm **Sign in**.

Sau khi đăng nhập, bạn sẽ thấy sidebar điều hướng chính của hệ thống. Các mục trong sidebar chỉ hiện nếu tài khoản của bạn có quyền truy cập tương ứng.

### Sidebar chính

| Mục | Chức năng |
|-----|-----------|
| **Data Sources** | Tạo và quản lý kết nối tới database, file hoặc sheet |
| **Workspaces** | Tổ chức các bảng dữ liệu phục vụ phân tích |
| **Explore** | Tạo, lưu và chỉnh sửa biểu đồ |
| **Dashboards** | Lắp nhiều biểu đồ thành báo cáo |
| **AI Chat** | Hỏi đáp, phân tích dữ liệu bằng ngôn ngữ tự nhiên |
| **Settings** | Quản lý user, phân quyền và preset role |

### Lưu ý về quyền truy cập

- Không thấy module trong sidebar thường có nghĩa là bạn chưa có quyền module đó.
- Có thấy module chưa chắc đã xem được mọi tài nguyên trong module đó.
- AppBI dùng song song **module permissions** và **resource-level sharing**.

---

## 3. Data Sources — Kết nối nguồn dữ liệu

Data Source là nơi AppBI kết nối tới hệ thống dữ liệu gốc của bạn.

### 3.1 Tạo Data Source mới

1. Vào **Data Sources**
2. Bấm **New Data Source**
3. Chọn loại kết nối
4. Điền thông tin kết nối
5. Bấm **Test Connection**
6. Bấm **Save**

### 3.2 Các loại kết nối thường gặp

| Loại | Khi nào dùng |
|------|-------------|
| **PostgreSQL** | Database PostgreSQL nội bộ hoặc cloud |
| **MySQL** | MySQL hoặc MariaDB |
| **BigQuery** | Google BigQuery |
| **Google Sheets** | Dữ liệu lưu trong spreadsheet |
| **File Upload** | CSV hoặc file dùng cho nhập nhanh |

### 3.3 Sync dữ liệu

Sau khi tạo datasource, bạn cần sync để AppBI có dữ liệu phân tích nội bộ.

Luồng cơ bản:

1. Mở datasource
2. Bấm **Sync Now**
3. Chờ job hoàn tất
4. Kiểm tra trạng thái sync mới nhất

### 3.4 Sync settings

Bạn có thể chọn cách đồng bộ:

- `Manual`
- `Interval`
- `Daily`
- `Cron`

### 3.5 Query Runner

Ở trang chi tiết datasource, bạn có thể dùng **Query Runner** để kiểm tra nhanh dữ liệu bằng SQL trước khi tạo workspace table.

### 3.6 Chia sẻ datasource

Bạn có thể chia sẻ datasource cho người khác với quyền `view` hoặc `edit`, nếu tài khoản của bạn có đủ quyền trên tài nguyên đó.

---

## 4. Dataset Workspaces — Chuẩn bị dữ liệu phân tích

Workspace là lớp mô hình dữ liệu phân tích của AppBI. Đây là nơi bạn đưa bảng vào hệ thống, preview dữ liệu, thêm cột tính toán, đổi format, và chuẩn bị nguồn cho chart.

### 4.1 Tạo workspace

1. Vào **Workspaces**
2. Bấm **New Workspace**
3. Nhập tên và mô tả
4. Bấm **Create**

### 4.2 Thêm bảng vào workspace

Bên trong workspace, bấm **Add Table** và chọn một trong hai kiểu:

- **Physical Table**: dùng bảng thật từ datasource đã sync
- **SQL Query**: dùng truy vấn SQL để tạo bảng phân tích riêng

Khi thêm bảng, bạn thường sẽ chọn:

- datasource
- bảng hoặc câu SQL
- display name

### 4.3 Xem preview và cấu hình hiển thị

Sau khi tạo workspace table, bạn có thể:

- xem preview dữ liệu
- đổi thứ tự cột
- ẩn hoặc hiện cột
- đổi format số, ngày, tiền tệ
- override kiểu dữ liệu nếu cần

### 4.4 Thêm cột tính toán

AppBI hỗ trợ thêm cột mới bằng:

- công thức kiểu Excel-like
- biểu thức JavaScript
- server-side transformation theo flow hệ thống hỗ trợ

### 4.5 Khi nào nên dùng workspace

Workspace đặc biệt phù hợp khi bạn cần:

- gom dữ liệu phân tích theo domain
- làm sạch bảng trước khi vẽ chart
- tạo bảng chuyên cho business user
- tách bảng raw với bảng đã chuẩn hóa cho báo cáo

---

## 5. AI Description cho Table và Chart

AppBI có **AI Description** cho:

- **workspace table**
- **chart**

Đây là lớp metadata AI dùng để giải thích tài nguyên, gợi ý câu hỏi, và hỗ trợ search/AI discovery. Nó không phải là AI Chat và cũng không phải là AI Agent.

### 5.1 AI Description của Table

Ở trang workspace table, bạn có thể mở modal AI Description để xem:

- mô tả bảng do AI sinh ra
- common questions
- trạng thái generation hiện tại
- thời điểm cập nhật gần nhất

### 5.2 AI Description của Chart

Ở trang chart detail, bạn có thể mở AI Description để xem:

- AI summary của biểu đồ
- reasoning hoặc semantic metadata liên quan
- trạng thái generation hiện tại

### 5.3 Trạng thái generation

Hệ thống hiện dùng state rõ ràng hơn cho AI Description:

- `queued`
- `processing`
- `succeeded`
- `failed`
- `stale`

Điều này giúp UI phản ánh đúng tiến trình thay vì để user phải đoán xem AI có đang chạy hay không.

### 5.4 AI đọc gì để mô tả Table

Hiện tại AI không đọc toàn bộ bảng một cách vô hạn. Hệ thống dùng cách an toàn hơn:

- đọc toàn bộ catalog cột
- đọc metadata và column stats
- đọc **sample data đại diện**
- giới hạn theo token budget để tránh prompt quá lớn

Điều này giúp mô tả sát dữ liệu thật hơn so với chỉ đọc header cột, nhưng vẫn kiểm soát được chi phí và tốc độ.

### 5.5 Khi mô tả trở thành stale

Nếu bảng hoặc chart thay đổi đáng kể, AI Description có thể được đánh dấu `stale`. Điều này có nghĩa là nội dung hiện tại có thể không còn phản ánh đúng dữ liệu hoặc cấu hình mới.

### 5.6 Chỉnh tay và regenerate

Bạn có thể:

- chỉnh sửa mô tả bằng tay
- yêu cầu regenerate
- theo dõi trạng thái generation ngay trên modal

Hệ thống hiện tránh việc ghi đè âm thầm khi user đã chỉnh tay.

---

## 6. Explore — Xây dựng biểu đồ

Explore là nơi bạn tạo chart từ workspace tables.

### 6.1 Tạo chart mới

1. Vào **Explore**
2. Bấm **New Chart**
3. Chọn workspace và table
4. Chọn chart type
5. Cấu hình dimension, metric, filters
6. Preview biểu đồ
7. Bấm **Save**

### 6.2 Các chart type phổ biến

| Chart type | Dùng khi nào |
|-----------|---------------|
| **BAR** | So sánh giá trị giữa các nhóm |
| **GROUPED BAR** | So sánh nhiều metric cùng lúc |
| **STACKED BAR** | Thể hiện cơ cấu thành phần |
| **LINE** | Xu hướng theo thời gian hoặc danh mục |
| **AREA** | Xu hướng có nhấn mạnh phần diện tích |
| **TIME SERIES** | Chuỗi thời gian |
| **PIE** | Cơ cấu tỷ trọng |
| **SCATTER** | Tương quan giữa hai biến |
| **TABLE** | Hiển thị dữ liệu dạng bảng |
| **KPI** | Một chỉ số trọng tâm |

### 6.3 Role configuration

Tùy loại chart, bạn sẽ cấu hình các trường như:

- `dimension`
- `metrics`
- `breakdown`
- `time field`
- `x / y field`

### 6.4 Filters và parameters

Bạn có thể thêm filter vào chart và trong nhiều trường hợp có thể dùng parameters để dashboard override ở tầng cao hơn.

### 6.5 Save và reuse

Chart sau khi lưu có thể:

- xuất hiện trong danh sách Explore
- được thêm vào dashboard
- được AI Chat hoặc AI Agent tham chiếu theo quyền truy cập của user

---

## 7. Dashboards — Tổng hợp báo cáo

Dashboard là nơi bạn lắp nhiều chart thành một báo cáo hoàn chỉnh.

### 7.1 Tạo dashboard

1. Vào **Dashboards**
2. Bấm **New Dashboard**
3. Nhập tên và mô tả
4. Bấm **Create**

### 7.2 Thêm chart vào dashboard

Bạn có thể thêm chart đã lưu từ Explore vào dashboard rồi sắp xếp trên grid layout.

### 7.3 Chỉnh layout

Dashboard hỗ trợ:

- kéo thả vị trí chart
- resize chart
- lưu layout riêng với chart definitions

### 7.4 Global filters

Dashboard có thể có bộ lọc toàn cục để áp dụng cho nhiều chart cùng lúc.

### 7.5 Share dashboard

Khi chia sẻ dashboard, hệ thống có thể cascade quyền đến các chart và workspace liên quan theo policy hiện tại.

### 7.6 Dashboard và AI Agent

Trang **Dashboards** cũng là nơi bắt đầu flow **AI Agent**. Nghĩa là ngoài việc tạo dashboard thủ công, user có thể dùng AI để lên plan và build dashboard tự động ngay tại đây.

---

## 8. AI Chat — Trợ lý phân tích phản hồi theo câu hỏi

**AI Chat** là hệ AI có tính chất phản hồi theo câu hỏi. Bạn hỏi, AI tìm dữ liệu phù hợp trong phạm vi bạn được quyền xem, rồi trả lời hoặc tạo chart lẻ nếu cần.

### 8.1 Dùng AI Chat khi nào

AI Chat phù hợp khi bạn muốn:

- hỏi đáp nhanh bằng tiếng Việt hoặc tiếng Anh
- giải thích một insight cụ thể
- khám phá dữ liệu theo từng câu hỏi nhỏ
- tạo một chart lẻ ngay trong cuộc trò chuyện

### 8.2 Luồng sử dụng cơ bản

1. Vào **AI Chat**
2. Tạo session mới
3. Gõ câu hỏi
4. Xem câu trả lời, tool steps và chart nếu có
5. Lưu chart nếu muốn dùng lại

### 8.3 Đặc điểm của AI Chat

- mang tính **reactive**
- bám theo câu hỏi của user
- có lịch sử session
- độc lập với AI Agent

### 8.4 Yêu cầu để dùng AI Chat

- user cần `ai_chat >= view`
- user cần có quyền trên tài nguyên dữ liệu nền
- `ai-chat-service` phải đang chạy trong môi trường triển khai

### 8.5 Nếu chat service đang offline

Chat page vẫn có thể mở, nhưng các thao tác live chat sẽ báo trạng thái không khả dụng rõ ràng thay vì lỗi mơ hồ như trước.

---

## 9. AI Agent — Tự động lập kế hoạch và tạo dashboard

**AI Agent** là hệ AI chủ động hơn, dùng để tạo dashboard hoàn chỉnh từ mô tả bài toán.

### 9.1 AI Agent khác AI Chat ở đâu

| Hệ | Input | Output |
|----|-------|--------|
| **AI Chat** | Câu hỏi | Câu trả lời hoặc chart lẻ |
| **AI Agent** | Brief + selected tables | Plan + dashboard hoàn chỉnh |

### 9.2 Luồng AI Agent hiện tại

1. Vào **Dashboards**
2. Mở **AI Agent**
3. Chọn một hoặc nhiều workspace table
4. Điền brief
5. Yêu cầu AI tạo plan
6. Review và chỉnh lại plan nếu cần
7. Bấm generate để build dashboard
8. Chuyển tới dashboard vừa tạo

### 9.3 Bước Choose tables

Flow chọn bảng hiện đã được tối ưu hơn cho trường hợp nhiều workspace và nhiều table:

- có ô search
- có collapse/expand theo workspace
- có thao tác `Select shown` và `Clear shown`
- có panel tóm tắt scope đã chọn
- có thể bỏ nhanh từng table khỏi selection

Điều này giúp user dễ kiểm soát phạm vi dữ liệu trước khi AI build report.

### 9.4 Bước Write the brief

Brief hiện tại tập trung vào việc tạo dashboard tốt ở lần build hiện tại. Thông thường bạn sẽ điền:

- mục tiêu phân tích
- audience
- timeframe
- KPI cần theo dõi
- các câu hỏi dashboard phải trả lời

### 9.5 Review plan trước khi build

Trước khi build, user có thể xem lại và chỉnh plan, bao gồm những phần như:

- dashboard title
- summary
- section title
- section intent
- chart title
- chart rationale
- bật hoặc tắt chart trước khi build

### 9.6 Multi-dataset ở phiên bản hiện tại

AI Agent hiện có thể nhận nhiều selected tables, nhưng theo cách:

- tạo các section theo dataset hoặc table đã chọn
- không blend hoặc join tự động giữa nhiều dataset như một semantic layer hoàn chỉnh

Nói ngắn gọn: Agent vẽ dashboard từ nhiều nguồn đã chọn, nhưng chưa phải hệ hợp nhất dữ liệu đa bảng một cách sâu.

### 9.7 Giới hạn hiện tại cần biết

Phiên bản hiện tại của AI Agent tập trung vào **tạo dashboard output**. Hệ thống chưa có lớp **saved report spec** hoàn chỉnh để quản lý vòng đời báo cáo dài hạn như lưu brief/plan thành một thực thể độc lập có version history riêng.

Điều đó có nghĩa là:

- bạn có thể xem lại dashboard đã tạo
- bạn có thể mở lại flow để tạo dashboard mới
- nhưng khái niệm “saved report definition có thể rerun và version hóa đầy đủ” vẫn là bước phát triển tiếp theo

### 9.8 Yêu cầu để dùng AI Agent

User cần:

- `ai_agent >= edit`
- `dashboards >= edit`
- `explore_charts >= edit`
- quyền xem trên từng workspace table được chọn
- `ai-agent-service` đang chạy

---

## 10. Chia sẻ và phân quyền

AppBI dùng hai lớp kiểm soát truy cập.

### 10.1 Module permissions

Mỗi module có thể được cấp theo các mức:

- `none`
- `view`
- `edit`
- `full`

Các module chính hiện tại gồm:

- `data_sources`
- `datasets`
- `workspaces`
- `explore_charts`
- `dashboards`
- `ai_chat`
- `ai_agent`
- `settings`

### 10.2 Resource-level sharing

Ngoài module permissions, từng tài nguyên cụ thể còn phải được sở hữu hoặc được share cho user.

Tài nguyên được chia sẻ có thể bao gồm:

- datasource
- workspace
- chart
- dashboard
- chat session trong các flow hỗ trợ

### 10.3 Một số nguyên tắc quan trọng

- Có quyền module không có nghĩa là tự động xem được mọi object trong module đó.
- Dashboard khi được share có thể kéo theo quyền xem các chart và workspace phụ thuộc.
- AI Agent chỉ được dùng trên các bảng mà user thực sự có quyền xem.

---

## 11. Quản trị hệ thống

> Phần này dành cho người dùng có quyền `settings` phù hợp, thường là admin.

### 11.1 Quản lý user

Tại **Settings**, admin có thể:

- xem danh sách user
- tạo user mới
- deactivate user
- gán preset role hoặc chỉnh trực tiếp permission matrix

### 11.2 Permission matrix

AppBI có giao diện phân quyền theo module cho từng user. Admin có thể cấp `none`, `view`, `edit`, `full` tùy module.

### 11.3 Preset roles

Hệ thống hỗ trợ preset quyền để dùng lại nhanh khi tạo user mới hoặc chuẩn hóa nhóm vai trò.

### 11.4 Điều cần nhớ với AI modules

- `ai_chat` và `ai_agent` là hai module riêng
- không nên giả định cấp `ai_chat` thì sẽ dùng được `ai_agent`
- nếu user không thấy AI Agent hoặc không dùng được, hãy kiểm tra cả quyền module lẫn quyền trên workspace tables

---

## 12. Luồng sử dụng đầy đủ từ A đến Z

Dưới đây là một ví dụ điển hình để tạo báo cáo doanh thu.

### Cách 1 — Luồng thủ công

1. Tạo datasource kết nối tới hệ thống bán hàng
2. Sync dữ liệu
3. Tạo workspace `Sales Analytics`
4. Thêm bảng đơn hàng, sản phẩm hoặc doanh thu
5. Tạo chart trong Explore
6. Tạo dashboard và thêm chart vào
7. Chia sẻ dashboard cho team

### Cách 2 — Luồng có AI Chat

1. Chuẩn bị datasource và workspace trước
2. Vào AI Chat
3. Hỏi một câu như `Doanh thu theo tháng năm nay so với năm trước`
4. Xem AI trả lời và chart tạo ra
5. Nếu thấy hợp lý, lưu chart để tái sử dụng

### Cách 3 — Luồng có AI Agent

1. Chuẩn bị workspace tables trước
2. Vào Dashboards
3. Mở AI Agent
4. Chọn các bảng cần dùng
5. Viết brief về bài toán cần giải
6. Review plan do AI tạo
7. Build dashboard hoàn chỉnh
8. Chỉnh tay dashboard sau khi tạo nếu cần

---

## 13. Câu hỏi thường gặp

**Q: Tôi không thấy một module nào đó trong sidebar?**  
A: Hãy kiểm tra quyền module tương ứng. Nếu chưa có, liên hệ admin.

**Q: Tôi thấy module nhưng mở object theo ID hoặc từ link cũ lại bị chặn?**  
A: Điều này thường là đúng. AppBI có object-level access ngoài module permission.

**Q: AI Description của table hoặc chart không cập nhật ngay?**  
A: Hãy kiểm tra trạng thái generation. Nếu đang `queued` hoặc `processing` thì hệ thống đang xử lý. Nếu là `stale`, bạn nên regenerate hoặc kiểm tra resource vừa thay đổi gì.

**Q: AI Description dùng gì để hiểu table?**  
A: Hệ thống dùng catalog cột, stats và sample data đại diện, có giới hạn theo token budget. AI không đọc vô hạn toàn bộ bảng.

**Q: AI Chat mở được nhưng chat không chạy?**  
A: Hãy kiểm tra `ai-chat-service` có đang chạy không và tài khoản có `ai_chat >= view` không.

**Q: AI Agent không hiện hoặc không cho generate?**  
A: Hãy kiểm tra `ai_agent`, `dashboards`, `explore_charts`, cùng quyền xem trên các workspace table đã chọn.

**Q: Nếu muốn phiên bản khác của báo cáo do AI Agent tạo thì sao?**  
A: Ở phiên bản hiện tại, bạn thường sẽ mở lại flow agent và build dashboard mới. Khái niệm saved report spec có version history riêng vẫn là bước nâng cấp tiếp theo.

**Q: Xóa chart khỏi dashboard có làm mất chart gốc không?**  
A: Không. Chart gốc vẫn nằm trong Explore.

---

## 14. Ghi chú kỹ thuật và vận hành

### 14.1 Split AI services

Kiến trúc hiện tại tách riêng:

- `ai-chat-service`
- `ai-agent-service`

Hai service này có thể chạy độc lập trong Docker.

### 14.2 AI Description pipeline

AI Description hiện có pipeline rõ ràng hơn với state machine cho table và chart. Điều này giúp:

- tránh silent skip
- hiển thị lỗi rõ hơn
- theo dõi được trạng thái queued, processing, failed, stale

### 14.3 Dùng Docker theo các mode

Một số mode triển khai thường dùng:

- base stack: `docker-compose.yml`
- chat only: `docker-compose.chat.yml`
- agent only: `docker-compose.agent.yml`
- full AI: `docker-compose.ai.yml`

### 14.4 Khi nào AI features không hoạt động

Hãy kiểm tra lần lượt:

- service AI tương ứng có đang chạy không
- tài khoản có đúng permission không
- datasource đã sync chưa
- workspace table có dữ liệu thật không
- provider key hoặc cấu hình backend có hợp lệ không

### 14.5 Tài liệu liên quan

- `README.md`
- `docs/DOCKER.md`
- `docs/API.md`
- `docs/GUIDED_API_CHART.md`
- `docs/GUIDED_API_DASHBOARD.md`
- `docs/GUIDED_API_AI_AGENT_REPORT.md`

---

## Bảng tham chiếu nhanh

| Tôi muốn... | Đi đến... |
|-------------|-----------|
| Kết nối database mới | `Data Sources` |
| Sync dữ liệu | `Data Sources -> datasource detail` |
| Tạo bảng phân tích | `Workspaces` |
| Xem AI Description của bảng | `Workspace table detail` |
| Tạo chart mới | `Explore` |
| Xem AI Description của chart | `Chart detail` |
| Tạo dashboard thủ công | `Dashboards` |
| Dùng AI Chat | `/chat` |
| Dùng AI Agent | `/dashboards` |
| Chia sẻ tài nguyên | nút `Share` trên resource |
| Phân quyền cho user | `Settings` |

---

*AppBI — Built for analysts, with AI that stays grounded in your data.*
