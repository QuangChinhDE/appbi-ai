'use client';

import { useEffect, useMemo, useState, type ElementType } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  Database,
  FileCode2,
  LayoutDashboard,
  Plug,
  Sparkles,
  Table2,
  X,
} from 'lucide-react';
import { useAgentReportSpecs } from '@/hooks/use-agent-report-specs';
import { useCharts } from '@/hooks/use-charts';
import { useDashboards } from '@/hooks/use-dashboards';
import { useDatasets } from '@/hooks/use-datasets';
import { useDataSources } from '@/hooks/use-datasources';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { cn } from '@/lib/utils';

const DISMISS_KEY = 'appbi:getting-started-dismissed';

type GuideTabKey = 'flow' | 'dataset' | 'chart' | 'dashboard' | 'import-html';

interface GuideSetupStep {
  key: string;
  icon: ElementType;
  title: string;
  titleVi: string;
  summary: string;
  summaryVi: string;
  href: string;
  ctaLabel: string;
  ctaLabelVi: string;
  done: boolean;
}

interface GuideDocSection {
  title: string;
  titleVi: string;
  description: string;
  descriptionVi: string;
  points: string[];
  pointsVi: string[];
}

interface GuideDocTab {
  key: GuideTabKey;
  label: string;
  labelVi: string;
  icon: ElementType;
  intro: string;
  introVi: string;
  note?: string;
  noteVi?: string;
  sections: GuideDocSection[];
  href: string;
  ctaLabel: string;
  ctaLabelVi: string;
  layout?: 'grid' | 'single';
}

function useGuideProgress() {
  const { data: datasources } = useDataSources();
  const { data: datasets } = useDatasets();
  const { data: charts } = useCharts({ limit: 1 });
  const { data: dashboards } = useDashboards();
  const { data: reports } = useAgentReportSpecs();

  const hasDatasource = (datasources?.length ?? 0) > 0;
  const hasDataset = (datasets?.length ?? 0) > 0;
  const hasTable = (datasets ?? []).some(
    (dataset: any) => (dataset.tables?.length ?? dataset.table_count ?? 0) > 0,
  );
  const hasChart = (charts?.length ?? 0) > 0;
  const hasDashboard = (dashboards?.length ?? 0) > 0;
  const hasReport = (reports?.length ?? 0) > 0;

  const steps = useMemo<GuideSetupStep[]>(
    () => [
      {
        key: 'datasource',
        icon: Plug,
        title: 'Connect data sources',
        titleVi: 'Kết nối data source',
        summary: 'Link warehouse, database, Google Sheet, or file upload and sync the tables you need.',
        summaryVi: 'Kết nối warehouse, database, Google Sheet hoặc upload file rồi sync các bảng cần dùng.',
        href: '/datasources',
        ctaLabel: 'Open Data Sources',
        ctaLabelVi: 'Mở Data Sources',
        done: hasDatasource,
      },
      {
        key: 'dataset',
        icon: Database,
        title: 'Create datasets',
        titleVi: 'Tạo dataset',
        summary: 'Group related business tables into one analysis-ready dataset.',
        summaryVi: 'Nhóm các bảng nghiệp vụ liên quan vào cùng một dataset để phân tích.',
        href: '/datasets',
        ctaLabel: 'Open Datasets',
        ctaLabelVi: 'Mở Datasets',
        done: hasDataset,
      },
      {
        key: 'tables',
        icon: Table2,
        title: 'Prepare tables and model',
        titleVi: 'Chuẩn bị bảng và model',
        summary: 'Add source tables, calculated tables, calendar tables, then review Quality and Model tabs.',
        summaryVi: 'Thêm source table, calculated table, calendar table rồi rà soát tab Quality và Model.',
        href: '/datasets',
        ctaLabel: 'Refine Dataset',
        ctaLabelVi: 'Hoàn thiện Dataset',
        done: hasTable,
      },
      {
        key: 'charts',
        icon: BarChart3,
        title: 'Create reusable charts',
        titleVi: 'Tạo chart dùng lại được',
        summary: 'Build saved charts in Explore before placing them into dashboards.',
        summaryVi: 'Tạo chart đã lưu trong Explore trước khi đưa vào dashboard.',
        href: '/explore/new',
        ctaLabel: 'Open Explore',
        ctaLabelVi: 'Mở Explore',
        done: hasChart,
      },
      {
        key: 'dashboard',
        icon: LayoutDashboard,
        title: 'Compose dashboards',
        titleVi: 'Ghép dashboard',
        summary: 'Assemble saved charts, imported pages, or AI-generated output into the final delivery.',
        summaryVi: 'Ghép chart đã lưu, page import, hoặc output AI thành dashboard bàn giao cuối cùng.',
        href: '/dashboards',
        ctaLabel: 'Open Dashboards',
        ctaLabelVi: 'Mở Dashboards',
        done: hasDashboard || hasReport,
      },
    ],
    [hasChart, hasDashboard, hasDataset, hasDatasource, hasReport, hasTable],
  );

  const completedCount = steps.filter((step) => step.done).length;
  const allDone = completedCount === steps.length;
  const nextRecommendedStep = steps.find((step) => !step.done) ?? null;

  return {
    steps,
    completedCount,
    allDone,
    nextRecommendedStep,
  };
}

function buildGuideTabs(nextRecommendedStep: GuideSetupStep | null, allDone: boolean): GuideDocTab[] {
  return [
    {
      key: 'flow',
      label: 'System flow',
      labelVi: 'Luồng hệ thống',
      icon: Sparkles,
      intro:
        'Use this tab as the operating map for AppBI. The normal path is Data Sources -> Datasets -> Explore -> Dashboards, while AI Reports and Import HTML help you accelerate specific stages.',
      introVi:
        'Dùng tab này như bản đồ vận hành AppBI. Luồng chuẩn là Data Sources -> Datasets -> Explore -> Dashboards; còn AI Reports và Import HTML là các nhánh tăng tốc cho từng tình huống.',
      note:
        'Recommended order: stabilize the data model first, then save reusable charts, then compose dashboards or import external layouts.',
      noteVi:
        'Thứ tự khuyến nghị: ổn định model dữ liệu trước, sau đó lưu chart dùng lại được, rồi mới ghép dashboard hoặc import layout ngoài.',
      sections: [
        {
          title: 'Recommended module order',
          titleVi: 'Thứ tự module khuyến nghị',
          description:
            'Most teams move through the same checkpoints before a dashboard is considered reliable enough to share.',
          descriptionVi:
            'Phần lớn team đều đi qua cùng một chuỗi checkpoint trước khi dashboard đủ ổn định để chia sẻ.',
          points: [
            'Start from Data Sources: verify the connection, inspect schemas, and sync only the tables you actually need.',
            'Move to Datasets: combine source tables, calculated tables, and a calendar table so your business logic lives in one place.',
            'Review the Quality and Model tabs before charting so joins, null handling, and date logic are already settled.',
            'Create saved charts in Explore, then assemble them inside Dashboards for executives, operators, or drill-down audiences.',
          ],
          pointsVi: [
            'Bắt đầu từ Data Sources: kiểm tra kết nối, xem schema, và chỉ sync những bảng thực sự cần dùng.',
            'Chuyển sang Datasets: gom source table, calculated table và calendar table để business logic nằm gọn trong một nơi.',
            'Rà soát tab Quality và Model trước khi làm chart để join, xử lý null và logic thời gian đã ổn định.',
            'Tạo chart đã lưu trong Explore rồi ghép vào Dashboards cho từng nhóm người dùng như executive, operator hoặc drill-down.',
          ],
        },
        {
          title: 'Three ways to ship output',
          titleVi: 'Ba cách tạo đầu ra',
          description:
            'AppBI currently supports a manual BI flow, an AI-assisted report flow, and an Import HTML flow. Choose based on where the starting asset already exists.',
          descriptionVi:
            'Hiện tại AppBI hỗ trợ luồng BI thủ công, luồng AI-assisted report và luồng Import HTML. Chọn cách làm theo việc asset ban đầu đang nằm ở đâu.',
          points: [
            'Manual BI flow: prepare the dataset, create charts in Explore, then place those charts into a dashboard page by page.',
            'AI-assisted flow: once the dataset is ready, AI Reports can propose chart sections and assemble a first dashboard draft for you.',
            'Import HTML flow: use this when the layout or chart plan already exists in HTML, either prepared manually or generated by Claude/MCP.',
            'Do not use Import HTML as a substitute for weak data modeling. The dataset layer still decides whether filters and charts stay correct after import.',
          ],
          pointsVi: [
            'Luồng BI thủ công: chuẩn bị dataset, tạo chart trong Explore rồi đặt các chart đó vào dashboard theo từng page.',
            'Luồng AI-assisted: khi dataset đã sẵn sàng, AI Reports có thể đề xuất chart section và ghép một bản dashboard nháp cho bạn.',
            'Luồng Import HTML: dùng khi layout hoặc chart plan đã có sẵn ở HTML, do bạn làm tay hoặc do Claude/MCP sinh ra.',
            'Không nên dùng Import HTML để bù cho data modeling yếu. Lớp dataset vẫn quyết định filter và chart có còn đúng sau import hay không.',
          ],
        },
        {
          title: 'Before sharing with users',
          titleVi: 'Trước khi chia sẻ cho người dùng',
          description:
            'A dashboard feels reliable when the supporting model, naming, and page structure are predictable.',
          descriptionVi:
            'Dashboard chỉ thật sự đáng tin khi model, naming và cấu trúc page phía dưới nó đủ ổn định và dễ đoán.',
          points: [
            'Use business-readable names for datasets, charts, dashboard pages, and filters so the next editor understands your intent quickly.',
            'Keep one overview page and one or more detail pages instead of mixing every metric into a single crowded dashboard.',
            'Test the full filter path: dataset joins, chart aggregations, dashboard filters, and any public/share configuration before rollout.',
            'If an issue is about grain or joins, fix Dataset first. If it is about encoding or aggregation, fix the chart. If it is about layout, fix the dashboard.',
          ],
          pointsVi: [
            'Dùng tên dễ hiểu theo nghiệp vụ cho dataset, chart, page dashboard và filter để người chỉnh sau nắm ý đồ nhanh hơn.',
            'Nên có một page overview và một hoặc vài page detail, thay vì dồn mọi metric vào một dashboard quá đông.',
            'Test toàn bộ đường đi của filter: join ở dataset, aggregation ở chart, filter ở dashboard và cấu hình share/public trước khi rollout.',
            'Nếu lỗi nằm ở grain hoặc join thì sửa Dataset trước. Nếu lỗi ở encoding hoặc aggregation thì sửa chart. Nếu lỗi ở bố cục thì sửa dashboard.',
          ],
        },
      ],
      href: allDone ? '/dashboards' : nextRecommendedStep?.href ?? '/datasources',
      ctaLabel: allDone ? 'Open Dashboards' : nextRecommendedStep?.ctaLabel ?? 'Open Data Sources',
      ctaLabelVi: allDone ? 'Mở Dashboards' : nextRecommendedStep?.ctaLabelVi ?? 'Mở Data Sources',
    },
    {
      key: 'dataset',
      label: 'Dataset',
      labelVi: 'Dataset',
      icon: Database,
      intro:
        'Dataset is where AppBI becomes trustworthy. Tables, calculated logic, quality checks, and semantic modeling should be settled here before you optimize charts or dashboards.',
      introVi:
        'Dataset là nơi AppBI trở nên đáng tin. Bảng dữ liệu, logic tính toán, kiểm tra chất lượng và semantic model nên được chốt ở đây trước khi tối ưu chart hay dashboard.',
      note: 'The current dataset detail surface is organized around three tabs: Tables, Quality, and Model.',
      noteVi: 'Màn dataset detail hiện tại được tổ chức theo ba tab chính: Tables, Quality và Model.',
      sections: [
        {
          title: 'Build the right table stack',
          titleVi: 'Dựng đúng bộ bảng dữ liệu',
          description:
            'The Tables tab is the main workspace for deciding what data enters analysis and how it is grouped.',
          descriptionVi:
            'Tab Tables là nơi chính để quyết định dữ liệu nào được đưa vào phân tích và được nhóm ra sao.',
          points: [
            'Create the dataset first, then add only the tables that serve the reporting goal instead of copying the whole source schema.',
            'Use source tables for raw business data, calculated tables for transformed logic, and a calendar table for standard time analysis.',
            'Prefer predictable table names and stable primary keys because those choices will affect Explore, Dashboard filters, and Import HTML mapping later.',
          ],
          pointsVi: [
            'Tạo dataset trước, sau đó chỉ thêm những bảng phục vụ đúng mục tiêu báo cáo thay vì kéo toàn bộ schema nguồn vào.',
            'Dùng source table cho dữ liệu nghiệp vụ gốc, calculated table cho logic biến đổi, và calendar table cho phân tích thời gian chuẩn.',
            'Ưu tiên tên bảng dễ hiểu và khóa chính ổn định vì các quyết định này sẽ ảnh hưởng tới Explore, filter dashboard và mapping của Import HTML về sau.',
          ],
        },
        {
          title: 'Use calculated and calendar logic intentionally',
          titleVi: 'Dùng calculated và calendar có chủ đích',
          description:
            'Calculated logic should simplify downstream reporting, not hide unstable source issues.',
          descriptionVi:
            'Calculated logic nên làm phần báo cáo phía sau đơn giản hơn, chứ không nên che giấu lỗi bất ổn từ dữ liệu nguồn.',
          points: [
            'Create calculated tables or calculated columns when you need cleaner dimensions, normalized categories, lookup mapping, or pre-joined business views.',
            'Add a standard date/calendar table early if your charts need week, month, quarter, rolling trend, or year-over-year comparisons.',
            'Keep the table grain explicit. If a table mixes header-level and line-level facts carelessly, every downstream chart will be harder to trust.',
          ],
          pointsVi: [
            'Tạo calculated table hoặc calculated column khi cần dimension sạch hơn, category đã chuẩn hóa, lookup mapping hoặc business view đã join sẵn.',
            'Thêm standard date/calendar table sớm nếu chart cần week, month, quarter, rolling trend hoặc so sánh year-over-year.',
            'Giữ grain của bảng thật rõ. Nếu một bảng trộn lẫn fact cấp header và cấp line thì mọi chart phía sau sẽ khó đáng tin.',
          ],
        },
        {
          title: 'Review Quality before visual work',
          titleVi: 'Rà soát Quality trước khi làm biểu đồ',
          description:
            'Quality checks are cheaper than chart debugging because they surface structural problems while the scope is still local to the dataset.',
          descriptionVi:
            'Kiểm tra Quality rẻ hơn debug chart vì nó lộ ra các vấn đề cấu trúc khi phạm vi vẫn còn nằm trong dataset.',
          points: [
            'Open the Quality tab after each major schema change to inspect null-heavy columns, inconsistent values, and other data-health signals.',
            'Fix issues at the source or calculated layer first instead of compensating with chart-side filters everywhere.',
            'Rerun the check after you add new joins, calculated logic, or refreshed source tables so the chart layer does not inherit stale assumptions.',
          ],
          pointsVi: [
            'Mở tab Quality sau mỗi thay đổi schema lớn để kiểm tra cột nhiều null, giá trị không nhất quán và các tín hiệu sức khỏe dữ liệu khác.',
            'Sửa lỗi ở source hoặc calculated layer trước thay vì bù bằng filter phía chart ở khắp nơi.',
            'Chạy lại kiểm tra sau khi thêm join, calculated logic hoặc refresh source table để lớp chart không phải kế thừa giả định cũ.',
          ],
        },
        {
          title: 'Model for reuse',
          titleVi: 'Model để tái sử dụng',
          description:
            'The Model tab is where you make datasets understandable and reusable for everybody else in the system.',
          descriptionVi:
            'Tab Model là nơi bạn biến dataset thành thứ dễ hiểu và tái sử dụng được cho những người khác trong hệ thống.',
          points: [
            'Define relationships and semantic views so Explore and Dashboards can follow the intended business joins instead of guessing.',
            'Use business-facing names for entities, measures, and dimensions so chart builders do not have to decode raw source naming.',
            'Confirm the model again before Import HTML because imported charts still depend on valid field names, joins, and date behavior underneath.',
          ],
          pointsVi: [
            'Định nghĩa relationship và semantic view để Explore và Dashboards đi theo đúng business join thay vì phải đoán.',
            'Dùng tên theo nghiệp vụ cho entity, measure và dimension để người làm chart không phải tự giải mã tên nguồn thô.',
            'Kiểm tra lại model trước khi Import HTML vì chart import vẫn phụ thuộc vào field name, join và logic thời gian phía dưới.',
          ],
        },
      ],
      href: '/datasets',
      ctaLabel: 'Open Datasets',
      ctaLabelVi: 'Mở Datasets',
    },
    {
      key: 'chart',
      label: 'Chart / Explore',
      labelVi: 'Chart / Explore',
      icon: BarChart3,
      intro:
        'Explore is the chart-building module. Use it to create saved visual assets that can later be reused across many dashboards instead of rebuilding the same logic repeatedly.',
      introVi:
        'Explore là module dựng chart. Hãy dùng nó để tạo các visual asset đã lưu và có thể tái sử dụng ở nhiều dashboard, thay vì lặp lại cùng một logic nhiều lần.',
      note:
        'Explore is chart-only. Calculated-table editing belongs in Dataset or in the Dashboard import/edit flow, not inside the Explore editor itself.',
      noteVi:
        'Explore chỉ dành cho chart. Việc chỉnh calculated table nằm ở Dataset hoặc luồng import/edit của Dashboard, không nằm trực tiếp trong Explore editor.',
      sections: [
        {
          title: 'Start from the correct source table',
          titleVi: 'Bắt đầu từ đúng bảng nguồn',
          description:
            'A chart is only as stable as the dataset table it reads from, so pick the table and grain deliberately before touching chart cosmetics.',
          descriptionVi:
            'Độ ổn định của chart phụ thuộc trực tiếp vào dataset table mà nó đọc, nên hãy chọn bảng và grain thật chủ đích trước khi chỉnh giao diện chart.',
          points: [
            'Open Explore, create a new chart, then choose the dataset and the table that already matches the question you want to answer.',
            'If the required business view is still missing, go back to Dataset first instead of forcing the wrong source table to behave like the right one.',
            'Save charts with names that encode intent, such as the metric, grain, and audience, because dashboards will reuse them later.',
          ],
          pointsVi: [
            'Mở Explore, tạo chart mới, rồi chọn dataset và table đã khớp với câu hỏi phân tích bạn muốn trả lời.',
            'Nếu business view cần dùng vẫn chưa có, hãy quay về Dataset trước thay vì cố ép một source table sai thành đúng.',
            'Lưu chart với tên thể hiện rõ ý đồ, ví dụ metric, grain và audience, vì dashboard sẽ tái sử dụng chúng về sau.',
          ],
        },
        {
          title: 'Map fields to the right roles',
          titleVi: 'Gán field vào đúng vai trò',
          description:
            'The editor supports different role shapes depending on chart type, so field assignment should follow the visual grammar of the chart.',
          descriptionVi:
            'Editor hỗ trợ nhiều kiểu role khác nhau theo từng chart type, nên việc gán field phải đi theo đúng ngữ pháp của loại chart đó.',
          points: [
            'Use dimension, time field, and breakdown for categorical or time-based charts; use metrics for the aggregated values you want to compare.',
            'Combo charts support a line metric, scatter charts use scatterX and scatterY, and table charts can switch into pivot mode with row dimension, column dimension, and pivot metric.',
            'Do not overload one chart with too many roles. If the story needs several business questions, split it into multiple saved charts.',
          ],
          pointsVi: [
            'Dùng dimension, time field và breakdown cho chart theo category hoặc thời gian; dùng metrics cho các giá trị tổng hợp cần so sánh.',
            'Combo chart hỗ trợ line metric, scatter chart dùng scatterX và scatterY, còn table chart có thể chuyển sang pivot mode với row dimension, column dimension và pivot metric.',
            'Đừng nhồi quá nhiều role vào một chart. Nếu câu chuyện cần trả lời nhiều câu hỏi nghiệp vụ khác nhau, hãy tách thành nhiều chart đã lưu.',
          ],
        },
        {
          title: 'Refine with preview, filters, sort, and limit',
          titleVi: 'Tinh chỉnh bằng preview, filter, sort và limit',
          description:
            'Validation inside Explore should happen before a chart reaches Dashboard, because layout is the wrong place to discover aggregation mistakes.',
          descriptionVi:
            'Việc kiểm tra trong Explore nên diễn ra trước khi chart lên Dashboard, vì layout không phải nơi phù hợp để phát hiện lỗi aggregation.',
          points: [
            'Use preview data and SQL preview to verify that the dataset fields, grouping, and measures are producing the rows you expect.',
            'Apply chart filters, sort rules, and row limits carefully so saved charts stay fast and interpretable when reused on large dashboards.',
            'Check legends, axis labels, default time grain, and formatting before you save. These details become part of every dashboard that consumes the chart.',
          ],
          pointsVi: [
            'Dùng preview data và SQL preview để xác nhận field, grouping và measure trong dataset đang sinh ra đúng các dòng bạn mong muốn.',
            'Áp dụng chart filter, sort rule và row limit cẩn thận để chart đã lưu vừa nhanh vừa dễ đọc khi được tái sử dụng trong dashboard lớn.',
            'Kiểm tra legend, nhãn trục, time grain mặc định và format trước khi lưu. Các chi tiết này sẽ đi theo mọi dashboard dùng chart đó.',
          ],
        },
        {
          title: 'Treat saved charts as reusable assets',
          titleVi: 'Xem chart đã lưu như reusable asset',
          description:
            'The strongest dashboard workflows reuse charts, because you fix one source visual and every dependent page benefits immediately.',
          descriptionVi:
            'Luồng dashboard tốt nhất là luồng tái sử dụng chart, vì bạn chỉ cần sửa một visual gốc và mọi page phụ thuộc sẽ hưởng lợi ngay.',
          points: [
            'Keep saved charts in Explore even if a dashboard is the final delivery. That gives you one source of truth for the visual logic.',
            'When a dashboard card looks wrong, decide whether the problem belongs to the chart config or to the surrounding dashboard context before editing.',
            'Use chart reuse aggressively across overview pages, deep-dive pages, and AI-generated dashboards to keep the visual language consistent.',
          ],
          pointsVi: [
            'Giữ chart đã lưu trong Explore kể cả khi dashboard mới là đầu ra cuối cùng. Như vậy bạn có một nguồn sự thật duy nhất cho visual logic.',
            'Khi một card trên dashboard trông sai, hãy quyết định lỗi nằm ở chart config hay ở bối cảnh dashboard xung quanh trước khi sửa.',
            'Tái sử dụng chart càng nhiều càng tốt giữa page overview, page deep-dive và dashboard do AI sinh ra để giữ ngôn ngữ trực quan nhất quán.',
          ],
        },
      ],
      href: '/explore/new',
      ctaLabel: 'Open Explore',
      ctaLabelVi: 'Mở Explore',
    },
    {
      key: 'dashboard',
      label: 'Dashboard',
      labelVi: 'Dashboard',
      icon: LayoutDashboard,
      intro:
        'Dashboard is the delivery layer. It should combine trustworthy dataset logic, reusable charts, and clean page structure into a presentation that other people can act on.',
      introVi:
        'Dashboard là lớp bàn giao cuối. Nó cần kết hợp dataset logic đáng tin, chart tái sử dụng được và cấu trúc page rõ ràng thành một sản phẩm mà người khác có thể hành động dựa trên đó.',
      note:
        'Use Dashboard for composition, layout, filters, sharing, and page structure. Push data logic down to Dataset and visual logic down to Explore whenever possible.',
      noteVi:
        'Dùng Dashboard cho composition, layout, filter, chia sẻ và cấu trúc page. Hãy đẩy data logic xuống Dataset và visual logic xuống Explore bất cứ khi nào có thể.',
      sections: [
        {
          title: 'Compose dashboards from stable building blocks',
          titleVi: 'Ghép dashboard từ building block ổn định',
          description:
            'Dashboards are easier to maintain when they consume saved charts and clean datasets rather than embedding one-off logic everywhere.',
          descriptionVi:
            'Dashboard sẽ dễ bảo trì hơn khi nó dùng chart đã lưu và dataset sạch, thay vì nhúng quá nhiều logic dùng một lần ở khắp nơi.',
          points: [
            'Create the dashboard after the key charts already exist, then add those charts into the layout instead of rebuilding the same analysis inside every page.',
            'Keep one page focused on one audience or one business question so users can understand the flow quickly.',
            'When Import HTML is used, treat the imported page as a starting layout and still verify the underlying dataset, filters, and field mapping.',
          ],
          pointsVi: [
            'Tạo dashboard sau khi các chart chính đã tồn tại, rồi thêm các chart đó vào layout thay vì dựng lại cùng một phân tích trong từng page.',
            'Giữ mỗi page tập trung vào một audience hoặc một câu hỏi nghiệp vụ để người dùng hiểu luồng nhanh hơn.',
            'Khi dùng Import HTML, hãy xem page import như một layout khởi đầu và vẫn kiểm tra lại dataset, filter và field mapping phía dưới.',
          ],
        },
        {
          title: 'Use layout and filters with discipline',
          titleVi: 'Dùng layout và filter có kỷ luật',
          description:
            'Strong layout and filter hygiene keeps dashboards readable as they grow across multiple pages and teams.',
          descriptionVi:
            'Kỷ luật về layout và filter giúp dashboard vẫn dễ đọc khi số page và số team cùng tham gia tăng lên.',
          points: [
            'Arrange cards so summary KPIs and trend visuals appear before detail tables or diagnostic charts.',
            'Reuse consistent dimensions and date logic across filters so cross-page comparisons do not silently drift.',
            'If the page becomes too dense, split it. Page-level clarity usually beats one giant dashboard full of exceptions.',
          ],
          pointsVi: [
            'Sắp xếp card sao cho KPI tổng quan và chart xu hướng xuất hiện trước table chi tiết hoặc chart chẩn đoán.',
            'Tái sử dụng dimension và logic thời gian nhất quán giữa các filter để so sánh giữa các page không bị lệch ngầm.',
            'Nếu page quá dày, hãy tách ra. Độ rõ ràng ở cấp page thường tốt hơn một dashboard khổng lồ đầy ngoại lệ.',
          ],
        },
        {
          title: 'Share only after owner-level review',
          titleVi: 'Chỉ chia sẻ sau khi owner đã rà soát',
          description:
            'Publishing is the last mile, so it is worth doing one explicit review pass for permissions and interaction behavior.',
          descriptionVi:
            'Việc publish là chặng cuối, nên đáng để dành một vòng rà soát rõ ràng cho permission và hành vi tương tác.',
          points: [
            'Check the owner, sharing scope, and any public-link settings before sending dashboards to business users.',
            'Validate that dashboard filters, chart parameters, and imported pages still behave correctly for non-editor viewers.',
            'If a dashboard is public-facing, review names, labels, and hidden technical fields as if the audience has no internal context.',
          ],
          pointsVi: [
            'Kiểm tra owner, phạm vi chia sẻ và mọi thiết lập public-link trước khi gửi dashboard cho business user.',
            'Xác nhận filter dashboard, chart parameter và page import vẫn chạy đúng với người xem không có quyền editor.',
            'Nếu dashboard hướng ra bên ngoài, hãy rà soát tên, nhãn và field kỹ thuật ẩn theo giả định người xem không có bối cảnh nội bộ.',
          ],
        },
        {
          title: 'Know where to fix problems',
          titleVi: 'Biết sửa vấn đề ở đúng lớp',
          description:
            'Teams lose time when they patch symptoms in Dashboard instead of fixing the layer that truly owns the behavior.',
          descriptionVi:
            'Team thường mất thời gian khi vá triệu chứng ở Dashboard thay vì sửa lớp thực sự sở hữu hành vi đó.',
          points: [
            'Fix joins, measures, calculated fields, and naming in Dataset when the whole dashboard feels semantically wrong.',
            'Fix chart type, role mapping, formatting, filters, or aggregation in Explore when a single visual communicates the wrong story.',
            'Fix page sequence, card layout, audience split, or sharing in Dashboard when the data is right but the presentation is weak.',
          ],
          pointsVi: [
            'Sửa join, measure, calculated field và naming ở Dataset khi toàn bộ dashboard sai về mặt ngữ nghĩa.',
            'Sửa chart type, role mapping, format, filter hoặc aggregation ở Explore khi một visual đơn lẻ kể sai câu chuyện.',
            'Sửa thứ tự page, card layout, phân tách audience hoặc chia sẻ ở Dashboard khi dữ liệu đúng nhưng phần trình bày còn yếu.',
          ],
        },
      ],
      href: '/dashboards',
      ctaLabel: 'Open Dashboards',
      ctaLabelVi: 'Mở Dashboards',
    },
    {
      key: 'import-html',
      label: 'Import HTML',
      labelVi: 'Import HTML',
      icon: FileCode2,
      intro:
        'Import HTML is the fast lane for externally prepared dashboard plans. Use it when the page structure already exists in HTML and AppBI should turn that plan into a working dashboard.',
      introVi:
        'Import HTML là làn tăng tốc cho các dashboard plan đã chuẩn bị từ bên ngoài. Dùng nó khi cấu trúc page đã có sẵn trong HTML và AppBI cần biến plan đó thành dashboard chạy được.',
      note:
        'Current behavior: single-file appbi-import/v1 keeps the detailed editor path, while v2 or batch input goes through the page-level multi-page build flow.',
      noteVi:
        'Hành vi hiện tại: single-file appbi-import/v1 giữ luồng detailed editor, còn v2 hoặc batch input sẽ đi qua luồng build multi-page ở cấp page.',
      sections: [
        {
          title: 'Manual import inside AppBI',
          titleVi: 'Import thủ công trong AppBI',
          description:
            'Use the product UI when you want to inspect the import result directly, fix issues interactively, and choose the target dashboard at the end.',
          descriptionVi:
            'Dùng giao diện sản phẩm khi bạn muốn kiểm tra trực tiếp kết quả import, sửa lỗi tương tác và chọn dashboard đích ở bước cuối.',
          points: [
            'Open Dashboards and launch Import HTML. Start with the dashboard you want to create or the existing dashboard you want to append into.',
            'For one single-page HTML file, use the v1 detailed path when you need chart-by-chart validation, draft dataset preparation, or manual fixes before build.',
            'For multiple pages, either upload several single-page HTML files or a single appbi-import/v2 HTML file with pages[]. The build will expand them page by page.',
            'Choose whether to create a new dashboard or append into an existing one only after the previewed page set matches the intended output.',
          ],
          pointsVi: [
            'Mở Dashboards rồi chạy Import HTML. Bắt đầu từ dashboard bạn muốn tạo mới hoặc dashboard hiện có mà bạn muốn append vào.',
            'Với một file HTML single-page, hãy dùng đường v1 detailed khi bạn cần validate từng chart, chuẩn bị draft dataset hoặc sửa tay trước khi build.',
            'Với nhiều page, hãy upload nhiều file HTML single-page hoặc một file appbi-import/v2 có pages[]. Quá trình build sẽ bung chúng theo từng page.',
            'Chỉ chọn tạo dashboard mới hay append vào dashboard cũ sau khi tập page preview đã đúng với output mong muốn.',
          ],
        },
        {
          title: 'Choose v1 vs v2 with intent',
          titleVi: 'Chọn v1 hay v2 có chủ đích',
          description:
            'The right contract depends on whether you need one detailed page editor or one artifact that expands into many dashboard pages.',
          descriptionVi:
            'Contract đúng phụ thuộc vào việc bạn cần một detailed page editor hay một artifact có thể bung thành nhiều dashboard page.',
          points: [
            'Use appbi-import/v1 when one HTML should create exactly one page and you want the safest backward-compatible editing surface.',
            'Use appbi-import/v2 when one HTML artifact should create multiple pages via pages[]. A v1 file will never become multi-page by itself.',
            'Batch or v2 mode is page-level by design: it is faster for multi-page delivery, but it is not the same as the single-page detailed editor for every page.',
            'If the workbook is complex or spans many sheets, an existing dataset is usually safer than relying on one direct upload to infer every physical source correctly.',
          ],
          pointsVi: [
            'Dùng appbi-import/v1 khi một HTML phải tạo đúng một page và bạn muốn bề mặt chỉnh sửa tương thích ngược, an toàn nhất.',
            'Dùng appbi-import/v2 khi một artifact HTML phải tạo nhiều page thông qua pages[]. Một file v1 sẽ không thể tự biến thành multi-page.',
            'Batch hoặc v2 được thiết kế ở cấp page: nó nhanh hơn cho multi-page delivery, nhưng không giống detailed editor single-page cho từng page.',
            'Nếu workbook phức tạp hoặc trải qua nhiều sheet, dùng existing dataset thường an toàn hơn so với trông chờ một lần upload trực tiếp suy ra đúng mọi physical source.',
          ],
        },
        {
          title: 'Claude MCP import flow',
          titleVi: 'Luồng import bằng Claude MCP',
          description:
            'Use the MCP server when Claude is generating or validating the HTML for you and you want an inspect -> validate -> import workflow.',
          descriptionVi:
            'Dùng MCP server khi Claude là bên sinh hoặc kiểm tra HTML cho bạn và bạn muốn đi theo luồng inspect -> validate -> import.',
          points: [
            'Set APPBI_BASE_URL and APPBI_PAT first so Claude can call the existing AppBI import pipeline through MCP.',
            'Inspect source files first, then validate generated HTML with validate_html_metadata_content before you import.',
            'If one HTML must produce multiple pages, require appbi-import/v2 with pages[] explicitly. A validate result that says page_count=1 means that HTML is still single-page.',
            'When the HTML was generated in chat or inside Claude Desktop Local Agent, prefer import_html_dashboard_content with html_content instead of a VM-local html_path.',
            'If uploaded files live under /mnt/user-data/uploads and the basename is unique, MCP can map them. Otherwise, pass the content directly to stay deterministic.',
          ],
          pointsVi: [
            'Thiết lập APPBI_BASE_URL và APPBI_PAT trước để Claude có thể gọi luồng import hiện có của AppBI qua MCP.',
            'Inspect source file trước, sau đó validate HTML đã sinh bằng validate_html_metadata_content rồi mới import.',
            'Nếu một HTML phải tạo ra nhiều page, hãy yêu cầu rõ appbi-import/v2 với pages[]. Nếu kết quả validate báo page_count=1 thì HTML đó vẫn là single-page.',
            'Khi HTML được sinh trong chat hoặc bên trong Claude Desktop Local Agent, hãy ưu tiên import_html_dashboard_content với html_content thay vì html_path cục bộ của VM.',
            'Nếu file upload nằm dưới /mnt/user-data/uploads và basename là duy nhất, MCP có thể map được. Nếu không, hãy truyền thẳng content để luồng luôn deterministic.',
          ],
        },
        {
          title: 'Update existing dashboards safely',
          titleVi: 'Cập nhật dashboard hiện có một cách an toàn',
          description:
            'Appending, replacing, and deleting pages should follow explicit intent so imports do not quietly damage the current dashboard contract.',
          descriptionVi:
            'Việc append, replace và delete page cần đi theo ý định rõ ràng để import không âm thầm làm hỏng contract hiện tại của dashboard.',
          points: [
            'Inspect the current dashboard structure first so you know whether the request is really a replace-page change or an append-page change.',
            'Use replace_dashboard_page_from_html_content when one existing page should be updated in place from new HTML output.',
            'Use append_to_dashboard only when the user explicitly wants an extra page added alongside the current pages.',
            'Delete obsolete pages after replacement if the old page should no longer remain visible in the dashboard.',
          ],
          pointsVi: [
            'Inspect cấu trúc dashboard hiện tại trước để biết yêu cầu thật sự là replace page hay append page.',
            'Dùng replace_dashboard_page_from_html_content khi một page hiện có cần được cập nhật tại chỗ bằng HTML mới.',
            'Chỉ dùng append_to_dashboard khi người dùng nói rõ rằng họ muốn thêm page mới song song với các page hiện có.',
            'Xóa các page cũ không còn cần thiết sau khi replace nếu page cũ không nên tiếp tục hiển thị trong dashboard.',
          ],
        },
      ],
      href: '/dashboards',
      ctaLabel: 'Open Dashboards',
      ctaLabelVi: 'Mở Dashboards',
      layout: 'single',
    },
  ];
}

function GuideTabContent({
  doc,
  setupSteps,
  vi,
  onNavigate,
}: {
  doc: GuideDocTab;
  setupSteps: GuideSetupStep[];
  vi: boolean;
  onNavigate: (href: string) => void;
}) {
  const Icon = doc.icon;
  const recommendedKey = setupSteps.find((step) => !step.done)?.key ?? null;

  return (
    <div className="h-full overflow-y-auto px-5 pb-6 pt-5">
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-5 py-4 shadow-linear-sm">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-small font-strong text-text-primary">
              {vi ? doc.labelVi : doc.label}
            </h3>
            <p className="mt-1 text-caption leading-relaxed text-text-secondary">
              {vi ? doc.introVi : doc.intro}
            </p>
          </div>
        </div>
      </div>

      {(vi ? doc.noteVi : doc.note) && (
        <div className="mt-4 rounded-xl border border-brand/20 bg-brand/10 px-4 py-3 text-caption leading-relaxed text-brand">
          {vi ? doc.noteVi : doc.note}
        </div>
      )}

      {doc.key === 'flow' && (
        <div className="mt-5 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {setupSteps.map((step) => {
            const StepIcon = step.icon;
            const isRecommended = recommendedKey === step.key;

            return (
              <button
                key={step.key}
                onClick={() => onNavigate(step.href)}
                className={cn(
                  'rounded-xl border p-4 text-left shadow-linear-sm transition-colors',
                  step.done
                    ? 'border-success/20 bg-success/5 hover:bg-success/10'
                    : isRecommended
                      ? 'border-brand/30 bg-brand/5 hover:bg-brand/10'
                      : 'border-[rgb(var(--border-line))] bg-surface-1 hover:bg-surface-2',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div
                    className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                      step.done
                        ? 'bg-success/10 text-success'
                        : isRecommended
                          ? 'bg-brand/10 text-brand'
                          : 'bg-surface-2 text-text-tertiary',
                    )}
                  >
                    {step.done ? (
                      <CheckCircle2 className="h-5 w-5" />
                    ) : (
                      <StepIcon className="h-5 w-5" />
                    )}
                  </div>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-tiny font-emphasis',
                      step.done
                        ? 'bg-success/10 text-success'
                        : isRecommended
                          ? 'bg-brand/10 text-brand'
                          : 'bg-surface-2 text-text-tertiary',
                    )}
                  >
                    {step.done ? (vi ? 'Đã có' : 'Done') : isRecommended ? (vi ? 'Tiếp theo' : 'Next') : vi ? 'Mở module' : 'Open module'}
                  </span>
                </div>
                <h4 className="mt-4 text-caption font-emphasis text-text-primary">
                  {vi ? step.titleVi : step.title}
                </h4>
                <p className="mt-1 text-caption leading-relaxed text-text-secondary">
                  {vi ? step.summaryVi : step.summary}
                </p>
                <div className="mt-4 inline-flex items-center gap-1 text-caption font-emphasis text-brand">
                  <span>{vi ? step.ctaLabelVi : step.ctaLabel}</span>
                  <ChevronRight className="h-4 w-4" />
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div
        className={cn(
          'mt-5 grid gap-4',
          doc.layout === 'single' ? 'grid-cols-1' : 'xl:grid-cols-2',
        )}
      >
        {doc.sections.map((section) => (
          <section
            key={section.title}
            className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm"
          >
            <h4 className="text-small font-strong text-text-primary">
              {vi ? section.titleVi : section.title}
            </h4>
            <p className="mt-1 text-caption leading-relaxed text-text-secondary">
              {vi ? section.descriptionVi : section.description}
            </p>
            <ol className="mt-4 space-y-3">
              {(vi ? section.pointsVi : section.points).map((point, index) => (
                <li key={`${section.title}-${index}`} className="flex gap-3">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-tiny font-strong text-brand">
                    {index + 1}
                  </span>
                  <span className="text-caption leading-relaxed text-text-secondary">{point}</span>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>

      <div className="mt-6 flex justify-end border-t border-[rgb(var(--border-line))] pt-4">
        <Button
          variant="primary"
          onClick={() => onNavigate(doc.href)}
          trailingIcon={<ArrowRight className="h-4 w-4" />}
        >
          {vi ? doc.ctaLabelVi : doc.ctaLabel}
        </Button>
      </div>
    </div>
  );
}

function GuideDialog({
  open,
  onClose,
  locale,
  setupSteps,
  completedCount,
  allDone,
  nextRecommendedStep,
}: {
  open: boolean;
  onClose: () => void;
  locale: string;
  setupSteps: GuideSetupStep[];
  completedCount: number;
  allDone: boolean;
  nextRecommendedStep: GuideSetupStep | null;
}) {
  const router = useRouter();
  const vi = locale === 'vi';
  const [activeTab, setActiveTab] = useState<GuideTabKey>('flow');

  useEffect(() => {
    if (open) {
      setActiveTab('flow');
    }
  }, [open]);

  const docs = useMemo(
    () => buildGuideTabs(nextRecommendedStep, allDone),
    [allDone, nextRecommendedStep],
  );
  const currentDoc = docs.find((doc) => doc.key === activeTab) ?? docs[0];
  const tabs = useMemo<TabItem<GuideTabKey>[]>(
    () =>
      docs.map((doc) => {
        const Icon = doc.icon;
        return {
          key: doc.key,
          label: vi ? doc.labelVi : doc.label,
          icon: <Icon className="h-3.5 w-3.5" />,
          badge:
            doc.key === 'flow' ? (
              <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-tiny text-text-tertiary">
                {completedCount}/{setupSteps.length}
              </span>
            ) : undefined,
        };
      }),
    [completedCount, docs, setupSteps.length, vi],
  );

  if (!open) return null;

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={vi ? 'Hướng dẫn sử dụng AppBI' : 'How to use AppBI'}
      size="xl"
      bodyClassName="overflow-hidden p-0"
      contentClassName="h-[88vh] max-h-[760px]"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-[rgb(var(--border-line))] px-5 pb-3 pt-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-caption font-emphasis text-text-primary">
                {vi ? 'Guide theo module' : 'Module guide'}
              </p>
              <p className="mt-1 text-caption text-text-tertiary">
                {vi
                  ? `${completedCount}/${setupSteps.length} checkpoint đã có dữ liệu. Mở từng tab để xem flow, Dataset, Chart, Dashboard và Import HTML.`
                  : `${completedCount}/${setupSteps.length} checkpoints detected. Open each tab for the flow, Dataset, Chart, Dashboard, and Import HTML guides.`}
              </p>
            </div>
            {allDone && (
              <span className="rounded-full bg-success/10 px-2.5 py-1 text-tiny font-emphasis text-success">
                {vi ? 'Đã đủ nền tảng' : 'Foundation ready'}
              </span>
            )}
          </div>
          <div className="mt-4 overflow-x-auto pb-1">
            <Tabs items={tabs} value={activeTab} onChange={setActiveTab} variant="pill" size="sm" className="min-w-max" />
          </div>
        </div>

        <GuideTabContent
          doc={currentDoc}
          setupSteps={setupSteps}
          vi={vi}
          onNavigate={(href) => {
            onClose();
            router.push(href);
          }}
        />
      </div>
    </Modal>
  );
}

export function GettingStartedGuide({ locale = 'en' }: { locale?: string }) {
  const vi = locale === 'vi';
  const [dismissed, setDismissed] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const { steps, completedCount, allDone, nextRecommendedStep } = useGuideProgress();

  useEffect(() => {
    setDismissed(localStorage.getItem(DISMISS_KEY) === '1');
  }, []);

  if (dismissed || allDone) return null;

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  };

  return (
    <>
      <div className="relative mb-6 overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
        <button
          onClick={handleDismiss}
          className="absolute right-2 top-2 z-10 rounded-md p-1 text-text-quaternary hover:bg-surface-2 hover:text-text-secondary"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>

        <button
          onClick={() => setModalOpen(true)}
          className="flex w-full items-center gap-4 p-5 text-left transition-colors hover:bg-surface-2"
        >
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
            <Sparkles className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-small font-strong text-text-primary">
              {vi ? 'Trung tâm hướng dẫn AppBI' : 'AppBI guide center'}
            </h3>
            <p className="mt-0.5 text-caption text-text-tertiary">
              {vi
                ? `${completedCount}/${steps.length} checkpoint đã hoàn thành — mở guide theo flow, Dataset, Chart, Dashboard và Import HTML`
                : `${completedCount}/${steps.length} checkpoints completed — open the flow, Dataset, Chart, Dashboard, and Import HTML guides`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <div className="flex items-center gap-1.5">
              {steps.map((step) => (
                <div
                  key={step.key}
                  className={cn('h-2.5 w-2.5 rounded-full', step.done ? 'bg-success' : 'bg-surface-3')}
                />
              ))}
            </div>
            <ChevronRight className="h-4 w-4 text-text-quaternary" />
          </div>
        </button>
      </div>

      <GuideDialog
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        locale={locale}
        setupSteps={steps}
        completedCount={completedCount}
        allDone={allDone}
        nextRecommendedStep={nextRecommendedStep}
      />
    </>
  );
}

export function GettingStartedModal({
  open,
  onClose,
  locale = 'en',
}: {
  open: boolean;
  onClose: () => void;
  locale?: string;
}) {
  const { steps, completedCount, allDone, nextRecommendedStep } = useGuideProgress();

  return (
    <GuideDialog
      open={open}
      onClose={onClose}
      locale={locale}
      setupSteps={steps}
      completedCount={completedCount}
      allDone={allDone}
      nextRecommendedStep={nextRecommendedStep}
    />
  );
}