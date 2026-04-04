'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plug,
  Database,
  Table2,
  Bot,
  CheckCircle2,
  ChevronRight,
  X,
  Sparkles,
  ArrowRight,
} from 'lucide-react';
import { useDataSources } from '@/hooks/use-datasources';
import { useDatasets } from '@/hooks/use-datasets';
import { useAgentReportSpecs } from '@/hooks/use-agent-report-specs';

const DISMISS_KEY = 'appbi:getting-started-dismissed';

interface Step {
  key: string;
  icon: React.ElementType;
  title: string;
  titleVi: string;
  desc: string;
  descVi: string;
  details: string[];
  detailsVi: string[];
  href: string;
  btnLabel: string;
  btnLabelVi: string;
  done: boolean;
}

export function GettingStartedGuide({ locale = 'en' }: { locale?: string }) {
  const router = useRouter();
  const vi = locale === 'vi';

  const [dismissed, setDismissed] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    setDismissed(localStorage.getItem(DISMISS_KEY) === '1');
  }, []);

  const { data: datasources } = useDataSources();
  const { data: datasets } = useDatasets();
  const { data: reports } = useAgentReportSpecs();

  const hasDatasource = (datasources?.length ?? 0) > 0;
  const hasDataset = (datasets?.length ?? 0) > 0;
  const hasTable = (datasets ?? []).some(
    (ws: any) => (ws.tables?.length ?? ws.table_count ?? 0) > 0,
  );
  const hasReport = (reports?.length ?? 0) > 0;

  const steps: Step[] = [
    {
      key: 'datasource',
      icon: Plug,
      title: 'Step 1: Connect a data source',
      titleVi: 'Bước 1: Kết nối nguồn dữ liệu',
      desc: 'First, connect your database or upload a file so AppBI can access your data.',
      descVi: 'Đầu tiên, kết nối database hoặc tải file lên để AppBI có thể truy cập dữ liệu của bạn.',
      details: [
        'Go to Data Sources in the sidebar',
        'Click "New data source" and choose a type: PostgreSQL, MySQL, BigQuery, Google Sheets, or Manual (CSV/Excel upload)',
        'Fill in connection details and click "Test Connection" to verify',
        'After creating, open the data source and click "Sync" to import tables into the system',
        'Once synced, your tables will appear in Datasets when you add them',
      ],
      detailsVi: [
        'Vào Data Sources trên sidebar',
        'Nhấn "New data source" và chọn loại: PostgreSQL, MySQL, BigQuery, Google Sheets, hoặc Manual (tải CSV/Excel)',
        'Điền thông tin kết nối và nhấn "Test Connection" để kiểm tra',
        'Sau khi tạo xong, mở data source và nhấn "Sync" để đồng bộ danh sách bảng vào hệ thống',
        'Sau khi sync, các bảng sẽ xuất hiện trong Datasets khi bạn thêm table',
      ],
      href: '/datasources',
      btnLabel: 'Go to Data Sources',
      btnLabelVi: 'Đi tới Data Sources',
      done: hasDatasource,
    },
    {
      key: 'dataset',
      icon: Database,
      title: 'Step 2: Create a dataset',
      titleVi: 'Bước 2: Tạo dataset',
      desc: 'A dataset groups related tables together for analysis. Think of it like a project folder.',
      descVi: 'Dataset nhóm các bảng liên quan lại với nhau để phân tích. Giống như một thư mục dự án.',
      details: [
        'Go to Datasets in the sidebar',
        'Click "New dataset" and give it a name (e.g. "Sales Analysis Q4")',
        'A dataset can hold tables from different data sources',
        'You can share datasets with team members later',
      ],
      detailsVi: [
        'Vào Datasets trên sidebar',
        'Nhấn "New dataset" và đặt tên (VD: "Phân tích doanh thu Q4")',
        'Một dataset có thể chứa bảng từ nhiều data source khác nhau',
        'Bạn có thể chia sẻ dataset với đồng nghiệp sau',
      ],
      href: '/datasets',
      btnLabel: 'Go to Datasets',
      btnLabelVi: 'Đi tới Datasets',
      done: hasDataset,
    },
    {
      key: 'table',
      icon: Table2,
      title: 'Step 3: Add tables to dataset',
      titleVi: 'Bước 3: Thêm bảng vào dataset',
      desc: 'Select which tables from your data source to include in the dataset.',
      descVi: 'Chọn những bảng nào từ data source để đưa vào dataset.',
      details: [
        'Open the dataset you just created',
        'Click "Add table" and pick from your connected data sources',
        'Choose "Physical table" to import directly, or "SQL query" to write custom SQL',
        'Preview data to make sure it looks right, then save',
        'Add as many tables as you need for your analysis',
      ],
      detailsVi: [
        'Mở dataset vừa tạo',
        'Nhấn "Add table" và chọn từ các data source đã kết nối',
        'Chọn "Physical table" để import trực tiếp, hoặc "SQL query" để viết SQL tuỳ chỉnh',
        'Xem trước dữ liệu để đảm bảo đúng, rồi lưu',
        'Thêm bao nhiêu bảng tuỳ ý cho nhu cầu phân tích',
      ],
      href: '/datasets',
      btnLabel: 'Go to Datasets',
      btnLabelVi: 'Đi tới Datasets',
      done: hasTable,
    },
    {
      key: 'report',
      icon: Bot,
      title: 'Step 4: Build an AI Report',
      titleVi: 'Bước 4: Tạo AI Report',
      desc: 'Let AI automatically analyze your data and build a complete dashboard with charts and insights.',
      descVi: 'Để AI tự động phân tích dữ liệu và tạo dashboard hoàn chỉnh với biểu đồ và insight.',
      details: [
        'Go to AI Reports in the sidebar and click "New report"',
        'Select tables — choose the dataset tables you want to analyze',
        'Write a brief — describe what you want: goals, audience, timeframe',
        'Review plan — AI proposes chart sections and layout, you can adjust',
        'Build — AI creates all charts, generates insights, and assembles the dashboard',
        'Your finished dashboard appears in the Dashboards page!',
      ],
      detailsVi: [
        'Vào AI Reports trên sidebar và nhấn "New report"',
        'Chọn bảng — chọn các bảng dataset muốn phân tích',
        'Viết brief — mô tả mục tiêu, người đọc, khung thời gian',
        'Xem kế hoạch — AI đề xuất các section biểu đồ, bạn có thể chỉnh sửa',
        'Build — AI tạo toàn bộ biểu đồ, sinh insight, và ghép thành dashboard',
        'Dashboard hoàn chỉnh sẽ xuất hiện trong trang Dashboards!',
      ],
      href: '/ai-reports',
      btnLabel: 'Go to AI Reports',
      btnLabelVi: 'Đi tới AI Reports',
      done: hasReport,
    },
  ];

  const completedCount = steps.filter((s) => s.done).length;
  const allDone = completedCount === steps.length;

  // Auto-select first incomplete step
  useEffect(() => {
    const firstIncomplete = steps.findIndex((s) => !s.done);
    if (firstIncomplete >= 0) setActiveStep(firstIncomplete);
  }, [hasDatasource, hasDataset, hasTable, hasReport]);

  if (dismissed || allDone) return null;

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  };

  const current = steps[activeStep];

  return (
    <>
      {/* Banner trigger */}
      <div className="relative mb-6 overflow-hidden rounded-xl border border-blue-200 bg-gradient-to-r from-blue-50 via-white to-indigo-50 shadow-sm">
        <button
          onClick={handleDismiss}
          className="absolute right-3 top-3 z-10 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        >
          <X className="h-4 w-4" />
        </button>
        <button
          onClick={() => setModalOpen(true)}
          className="flex w-full items-center gap-4 p-5 text-left transition-colors hover:bg-blue-50/40"
        >
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-100">
            <Sparkles className="h-6 w-6 text-blue-600" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-gray-900">
              {vi ? 'Hướng dẫn bắt đầu' : 'Getting started guide'}
            </h3>
            <p className="mt-0.5 text-sm text-gray-500">
              {vi
                ? `${completedCount}/${steps.length} bước hoàn thành — Nhấn để xem hướng dẫn chi tiết từng bước`
                : `${completedCount}/${steps.length} completed — Click for step-by-step instructions`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {/* Mini progress dots */}
            <div className="flex items-center gap-1.5">
              {steps.map((s) => (
                <div
                  key={s.key}
                  className={`h-2.5 w-2.5 rounded-full ${
                    s.done ? 'bg-green-500' : 'bg-gray-300'
                  }`}
                />
              ))}
            </div>
            <ChevronRight className="h-5 w-5 text-gray-400" />
          </div>
        </button>
      </div>

      {/* Modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setModalOpen(false)}
        >
          <div
            className="mx-4 flex h-[85vh] max-h-[680px] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100">
                  <Sparkles className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">
                    {vi ? 'Hướng dẫn sử dụng AppBI' : 'How to use AppBI'}
                  </h2>
                  <p className="text-xs text-gray-500">
                    {vi
                      ? 'Làm theo 4 bước để tạo dashboard AI đầu tiên'
                      : 'Follow 4 steps to create your first AI dashboard'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setModalOpen(false)}
                className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex min-h-0 flex-1">
              {/* Left: step list */}
              <div className="w-56 shrink-0 space-y-1 overflow-y-auto border-r border-gray-100 bg-gray-50/70 p-3">
                {steps.map((step, idx) => {
                  const Icon = step.icon;
                  const isActive = activeStep === idx;
                  return (
                    <button
                      key={step.key}
                      onClick={() => setActiveStep(idx)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-all ${
                        isActive
                          ? 'bg-white shadow-sm ring-1 ring-blue-200'
                          : 'hover:bg-white/60'
                      }`}
                    >
                      <div
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                          step.done
                            ? 'bg-green-100'
                            : isActive
                              ? 'bg-blue-100'
                              : 'bg-gray-200/70'
                        }`}
                      >
                        {step.done ? (
                          <CheckCircle2 className="h-4 w-4 text-green-600" />
                        ) : (
                          <Icon
                            className={`h-4 w-4 ${isActive ? 'text-blue-600' : 'text-gray-400'}`}
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p
                          className={`truncate text-xs font-medium ${
                            step.done
                              ? 'text-green-700'
                              : isActive
                                ? 'text-gray-900'
                                : 'text-gray-600'
                          }`}
                        >
                          {vi ? step.titleVi : step.title}
                        </p>
                        {step.done && (
                          <p className="text-[10px] text-green-600">
                            {vi ? 'Hoàn thành' : 'Done'}
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Right: step detail */}
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
                {current && (
                  <>
                    {/* Step header */}
                    <div className="mb-5 flex items-start gap-3">
                      <div
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                          current.done ? 'bg-green-100' : 'bg-blue-100'
                        }`}
                      >
                        {current.done ? (
                          <CheckCircle2 className="h-5 w-5 text-green-600" />
                        ) : (
                          <current.icon className="h-5 w-5 text-blue-600" />
                        )}
                      </div>
                      <div>
                        <h3 className="text-base font-semibold text-gray-900">
                          {vi ? current.titleVi : current.title}
                        </h3>
                        <p className="mt-1 text-sm leading-relaxed text-gray-600">
                          {vi ? current.descVi : current.desc}
                        </p>
                      </div>
                    </div>

                    {/* Status badge */}
                    {current.done && (
                      <div className="mb-4 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5">
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                        <span className="text-sm font-medium text-green-700">
                          {vi
                            ? 'Bước này đã hoàn thành! Bạn có thể chuyển sang bước tiếp theo.'
                            : 'This step is complete! You can move to the next step.'}
                        </span>
                      </div>
                    )}

                    {/* Instruction list */}
                    <div className="mb-6 space-y-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                        {vi ? 'Cách thực hiện' : 'How to do it'}
                      </p>
                      <ol className="space-y-2.5">
                        {(vi ? current.detailsVi : current.details).map(
                          (detail, i) => (
                            <li key={i} className="flex gap-3">
                              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-bold text-blue-600">
                                {i + 1}
                              </span>
                              <span className="text-sm leading-relaxed text-gray-700">
                                {detail}
                              </span>
                            </li>
                          ),
                        )}
                      </ol>
                    </div>

                    {/* Flow diagram */}
                    <div className="mb-6 flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                      {steps.map((s, idx) => {
                        const Icon = s.icon;
                        return (
                          <div key={s.key} className="flex items-center gap-2">
                            <div
                              className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                                s.done
                                  ? 'bg-green-100'
                                  : activeStep === idx
                                    ? 'bg-blue-100 ring-2 ring-blue-300'
                                    : 'bg-white'
                              }`}
                            >
                              {s.done ? (
                                <CheckCircle2 className="h-4 w-4 text-green-500" />
                              ) : (
                                <Icon
                                  className={`h-4 w-4 ${
                                    activeStep === idx ? 'text-blue-600' : 'text-gray-400'
                                  }`}
                                />
                              )}
                            </div>
                            {idx < steps.length - 1 && (
                              <ArrowRight className="h-3.5 w-3.5 text-gray-300" />
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Action buttons */}
                    <div className="mt-auto flex items-center justify-between border-t border-gray-100 pt-4">
                      <button
                        onClick={() => setActiveStep(Math.max(0, activeStep - 1))}
                        disabled={activeStep === 0}
                        className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:invisible"
                      >
                        {vi ? 'Quay lại' : 'Back'}
                      </button>
                      <div className="flex items-center gap-3">
                        {activeStep < steps.length - 1 && (
                          <button
                            onClick={() => setActiveStep(activeStep + 1)}
                            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100"
                          >
                            {vi ? 'Bước tiếp' : 'Next step'}
                          </button>
                        )}
                        <button
                          onClick={() => {
                            setModalOpen(false);
                            router.push(current.href);
                          }}
                          className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
                        >
                          {vi ? current.btnLabelVi : current.btnLabel}
                          <ArrowRight className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ── Standalone modal trigger (for sidebar help button) ── */

export function GettingStartedModal({
  open,
  onClose,
  locale = 'en',
}: {
  open: boolean;
  onClose: () => void;
  locale?: string;
}) {
  const router = useRouter();
  const vi = locale === 'vi';
  const [activeStep, setActiveStep] = useState(0);

  const { data: datasources } = useDataSources();
  const { data: datasets } = useDatasets();
  const { data: reports } = useAgentReportSpecs();

  const hasDatasource = (datasources?.length ?? 0) > 0;
  const hasDataset = (datasets?.length ?? 0) > 0;
  const hasTable = (datasets ?? []).some(
    (ws: any) => (ws.tables?.length ?? ws.table_count ?? 0) > 0,
  );
  const hasReport = (reports?.length ?? 0) > 0;

  const steps: Step[] = [
    {
      key: 'datasource', icon: Plug,
      title: 'Step 1: Connect a data source', titleVi: 'Bước 1: Kết nối nguồn dữ liệu',
      desc: 'First, connect your database or upload a file so AppBI can access your data.',
      descVi: 'Đầu tiên, kết nối database hoặc tải file lên để AppBI có thể truy cập dữ liệu của bạn.',
      details: ['Go to Data Sources in the sidebar', 'Click "New data source" and choose a type: PostgreSQL, MySQL, BigQuery, Google Sheets, or Manual (CSV/Excel upload)', 'Fill in connection details and click "Test Connection" to verify', 'Once connected, your tables will be available for the next step'],
      detailsVi: ['Vào Data Sources trên sidebar', 'Nhấn "New data source" và chọn loại: PostgreSQL, MySQL, BigQuery, Google Sheets, hoặc Manual (tải CSV/Excel)', 'Điền thông tin kết nối và nhấn "Test Connection" để kiểm tra', 'Sau khi kết nối thành công, các bảng dữ liệu sẽ sẵn sàng cho bước tiếp theo'],
      href: '/datasources', btnLabel: 'Go to Data Sources', btnLabelVi: 'Đi tới Data Sources', done: hasDatasource,
    },
    {
      key: 'dataset', icon: Database,
      title: 'Step 2: Create a dataset', titleVi: 'Bước 2: Tạo dataset',
      desc: 'A dataset groups related tables together for analysis.', descVi: 'Dataset nhóm các bảng liên quan lại với nhau để phân tích.',
      details: ['Go to Datasets in the sidebar', 'Click "New dataset" and give it a name (e.g. "Sales Analysis Q4")', 'A dataset can hold tables from different data sources', 'You can share datasets with team members later'],
      detailsVi: ['Vào Datasets trên sidebar', 'Nhấn "New dataset" và đặt tên (VD: "Phân tích doanh thu Q4")', 'Một dataset có thể chứa bảng từ nhiều data source khác nhau', 'Bạn có thể chia sẻ dataset với đồng nghiệp sau'],
      href: '/datasets', btnLabel: 'Go to Datasets', btnLabelVi: 'Đi tới Datasets', done: hasDataset,
    },
    {
      key: 'table', icon: Table2,
      title: 'Step 3: Add tables to dataset', titleVi: 'Bước 3: Thêm bảng vào dataset',
      desc: 'Select which tables from your data source to include.', descVi: 'Chọn những bảng nào từ data source để đưa vào dataset.',
      details: ['Open the dataset you just created', 'Click "Add table" and pick from your connected data sources', 'Choose "Physical table" to import directly, or "SQL query" for custom SQL', 'Preview data to make sure it looks right, then save', 'Add as many tables as you need for your analysis'],
      detailsVi: ['Mở dataset vừa tạo', 'Nhấn "Add table" và chọn từ các data source đã kết nối', 'Chọn "Physical table" để import trực tiếp, hoặc "SQL query" để viết SQL tuỳ chỉnh', 'Xem trước dữ liệu để đảm bảo đúng, rồi lưu', 'Thêm bao nhiêu bảng tuỳ ý cho nhu cầu phân tích'],
      href: '/datasets', btnLabel: 'Go to Datasets', btnLabelVi: 'Đi tới Datasets', done: hasTable,
    },
    {
      key: 'report', icon: Bot,
      title: 'Step 4: Build an AI Report', titleVi: 'Bước 4: Tạo AI Report',
      desc: 'Let AI automatically analyze your data and build a complete dashboard.', descVi: 'Để AI tự động phân tích dữ liệu và tạo dashboard hoàn chỉnh.',
      details: ['Go to AI Reports in the sidebar and click "New report"', 'Select tables — choose the dataset tables you want to analyze', 'Write a brief — describe what you want: goals, audience, timeframe', 'Review plan — AI proposes chart sections and layout, you can adjust', 'Build — AI creates all charts, generates insights, and assembles the dashboard', 'Your finished dashboard appears in the Dashboards page!'],
      detailsVi: ['Vào AI Reports trên sidebar và nhấn "New report"', 'Chọn bảng — chọn các bảng dataset muốn phân tích', 'Viết brief — mô tả mục tiêu, người đọc, khung thời gian', 'Xem kế hoạch — AI đề xuất các section biểu đồ, bạn có thể chỉnh sửa', 'Build — AI tạo toàn bộ biểu đồ, sinh insight, và ghép thành dashboard', 'Dashboard hoàn chỉnh sẽ xuất hiện trong trang Dashboards!'],
      href: '/ai-reports', btnLabel: 'Go to AI Reports', btnLabelVi: 'Đi tới AI Reports', done: hasReport,
    },
  ];

  useEffect(() => {
    const idx = steps.findIndex((s) => !s.done);
    if (idx >= 0) setActiveStep(idx);
  }, [hasDatasource, hasDataset, hasTable, hasReport]);

  if (!open) return null;

  const current = steps[activeStep];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="mx-4 flex h-[85vh] max-h-[680px] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100">
              <Sparkles className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">{vi ? 'Hướng dẫn sử dụng AppBI' : 'How to use AppBI'}</h2>
              <p className="text-xs text-gray-500">{vi ? 'Làm theo 4 bước để tạo dashboard AI đầu tiên' : 'Follow 4 steps to create your first AI dashboard'}</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"><X className="h-5 w-5" /></button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Left nav */}
          <div className="w-56 shrink-0 space-y-1 overflow-y-auto border-r border-gray-100 bg-gray-50/70 p-3">
            {steps.map((step, idx) => {
              const Icon = step.icon;
              const isActive = activeStep === idx;
              return (
                <button key={step.key} onClick={() => setActiveStep(idx)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-all ${isActive ? 'bg-white shadow-sm ring-1 ring-blue-200' : 'hover:bg-white/60'}`}>
                  <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${step.done ? 'bg-green-100' : isActive ? 'bg-blue-100' : 'bg-gray-200/70'}`}>
                    {step.done ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <Icon className={`h-4 w-4 ${isActive ? 'text-blue-600' : 'text-gray-400'}`} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`truncate text-xs font-medium ${step.done ? 'text-green-700' : isActive ? 'text-gray-900' : 'text-gray-600'}`}>{vi ? step.titleVi : step.title}</p>
                    {step.done && <p className="text-[10px] text-green-600">{vi ? 'Hoàn thành' : 'Done'}</p>}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Right detail */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
            {current && (
              <>
                <div className="mb-5 flex items-start gap-3">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${current.done ? 'bg-green-100' : 'bg-blue-100'}`}>
                    {current.done ? <CheckCircle2 className="h-5 w-5 text-green-600" /> : <current.icon className="h-5 w-5 text-blue-600" />}
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-gray-900">{vi ? current.titleVi : current.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-gray-600">{vi ? current.descVi : current.desc}</p>
                  </div>
                </div>

                {current.done && (
                  <div className="mb-4 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <span className="text-sm font-medium text-green-700">{vi ? 'Bước này đã hoàn thành!' : 'This step is complete!'}</span>
                  </div>
                )}

                <div className="mb-6 space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">{vi ? 'Cách thực hiện' : 'How to do it'}</p>
                  <ol className="space-y-2.5">
                    {(vi ? current.detailsVi : current.details).map((detail, i) => (
                      <li key={i} className="flex gap-3">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-bold text-blue-600">{i + 1}</span>
                        <span className="text-sm leading-relaxed text-gray-700">{detail}</span>
                      </li>
                    ))}
                  </ol>
                </div>

                <div className="mb-6 flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                  {steps.map((s, idx) => {
                    const Icon = s.icon;
                    return (
                      <div key={s.key} className="flex items-center gap-2">
                        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${s.done ? 'bg-green-100' : activeStep === idx ? 'bg-blue-100 ring-2 ring-blue-300' : 'bg-white'}`}>
                          {s.done ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <Icon className={`h-4 w-4 ${activeStep === idx ? 'text-blue-600' : 'text-gray-400'}`} />}
                        </div>
                        {idx < steps.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-gray-300" />}
                      </div>
                    );
                  })}
                </div>

                <div className="mt-auto flex items-center justify-between border-t border-gray-100 pt-4">
                  <button onClick={() => setActiveStep(Math.max(0, activeStep - 1))} disabled={activeStep === 0}
                    className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:invisible">
                    {vi ? 'Quay lại' : 'Back'}
                  </button>
                  <div className="flex items-center gap-3">
                    {activeStep < steps.length - 1 && (
                      <button onClick={() => setActiveStep(activeStep + 1)} className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100">
                        {vi ? 'Bước tiếp' : 'Next step'}
                      </button>
                    )}
                    <button onClick={() => { onClose(); router.push(current.href); }}
                      className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700">
                      {vi ? current.btnLabelVi : current.btnLabel}
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
