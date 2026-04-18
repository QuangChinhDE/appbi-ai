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
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

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

/* ──────────────── shared detail renderer ──────────────── */

function GuideContent({
  steps,
  activeStep,
  setActiveStep,
  vi,
  onCtaNavigate,
}: {
  steps: Step[];
  activeStep: number;
  setActiveStep: (i: number) => void;
  vi: boolean;
  onCtaNavigate: (href: string) => void;
}) {
  const current = steps[activeStep];

  return (
    <div className="flex min-h-0 flex-1 -mx-5 -my-4">
      {/* Left: step list */}
      <div className="w-56 shrink-0 space-y-1 overflow-y-auto border-r border-[rgb(var(--border-line))] bg-surface-2 p-3">
        {steps.map((step, idx) => {
          const Icon = step.icon;
          const isActive = activeStep === idx;
          return (
            <button
              key={step.key}
              onClick={() => setActiveStep(idx)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left transition-colors',
                isActive
                  ? 'bg-surface-1 shadow-linear-sm border border-[rgb(var(--border-line))]'
                  : 'hover:bg-surface-1/60 border border-transparent',
              )}
            >
              <div
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                  step.done
                    ? 'bg-success/10 text-success'
                    : isActive
                      ? 'bg-brand/10 text-brand'
                      : 'bg-surface-3 text-text-quaternary',
                )}
              >
                {step.done ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <Icon className="h-4 w-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'truncate text-caption font-emphasis',
                    step.done
                      ? 'text-success'
                      : isActive
                        ? 'text-text-primary'
                        : 'text-text-secondary',
                  )}
                >
                  {vi ? step.titleVi : step.title}
                </p>
                {step.done && (
                  <p className="text-tiny text-success">
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
                className={cn(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                  current.done ? 'bg-success/10 text-success' : 'bg-brand/10 text-brand',
                )}
              >
                {current.done ? (
                  <CheckCircle2 className="h-5 w-5" />
                ) : (
                  <current.icon className="h-5 w-5" />
                )}
              </div>
              <div>
                <h3 className="text-small font-strong text-text-primary">
                  {vi ? current.titleVi : current.title}
                </h3>
                <p className="mt-1 text-caption leading-relaxed text-text-secondary">
                  {vi ? current.descVi : current.desc}
                </p>
              </div>
            </div>

            {/* Status badge */}
            {current.done && (
              <div className="mb-4 flex items-center gap-2 rounded-md border border-success/20 bg-success/10 px-4 py-2.5">
                <CheckCircle2 className="h-4 w-4 text-success" />
                <span className="text-caption font-emphasis text-success">
                  {vi
                    ? 'Bước này đã hoàn thành! Bạn có thể chuyển sang bước tiếp theo.'
                    : 'This step is complete! You can move to the next step.'}
                </span>
              </div>
            )}

            {/* Instruction list */}
            <div className="mb-6 space-y-3">
              <p className="text-tiny font-strong uppercase tracking-[0.14em] text-text-quaternary">
                {vi ? 'Cách thực hiện' : 'How to do it'}
              </p>
              <ol className="space-y-2.5">
                {(vi ? current.detailsVi : current.details).map((detail, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-tiny font-strong text-brand">
                      {i + 1}
                    </span>
                    <span className="text-caption leading-relaxed text-text-secondary">
                      {detail}
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            {/* Flow diagram */}
            <div className="mb-6 flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
              {steps.map((s, idx) => {
                const Icon = s.icon;
                return (
                  <div key={s.key} className="flex items-center gap-2">
                    <div
                      className={cn(
                        'flex h-8 w-8 items-center justify-center rounded-md',
                        s.done
                          ? 'bg-success/10 text-success'
                          : activeStep === idx
                            ? 'bg-brand/10 text-brand ring-2 ring-brand/30'
                            : 'bg-surface-1 text-text-quaternary',
                      )}
                    >
                      {s.done ? (
                        <CheckCircle2 className="h-4 w-4" />
                      ) : (
                        <Icon className="h-4 w-4" />
                      )}
                    </div>
                    {idx < steps.length - 1 && (
                      <ArrowRight className="h-3.5 w-3.5 text-text-quaternary" />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Action buttons */}
            <div className="mt-auto flex items-center justify-between border-t border-[rgb(var(--border-line))] pt-4">
              <Button
                variant="ghost"
                onClick={() => setActiveStep(Math.max(0, activeStep - 1))}
                disabled={activeStep === 0}
                className={activeStep === 0 ? 'invisible' : ''}
              >
                {vi ? 'Quay lại' : 'Back'}
              </Button>
              <div className="flex items-center gap-2">
                {activeStep < steps.length - 1 && (
                  <Button variant="ghost" onClick={() => setActiveStep(activeStep + 1)}>
                    {vi ? 'Bước tiếp' : 'Next step'}
                  </Button>
                )}
                <Button
                  variant="primary"
                  onClick={() => onCtaNavigate(current.href)}
                  trailingIcon={<ArrowRight className="h-4 w-4" />}
                >
                  {vi ? current.btnLabelVi : current.btnLabel}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ══════════════ GettingStartedGuide ══════════════ */

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
        'Fill in connection details and click "Create" to save. AppBI will validate the connection automatically.',
        'After creating, open the data source to preview schemas and sample rows directly from the source',
        'Add the tables you need into a Dataset and AppBI will query them live',
      ],
      detailsVi: [
        'Vào Data Sources trên sidebar',
        'Nhấn "New data source" và chọn loại: PostgreSQL, MySQL, BigQuery, Google Sheets, hoặc Manual (tải CSV/Excel)',
        'Điền thông tin kết nối rồi nhấn "Create". AppBI sẽ tự kiểm tra kết nối trước khi lưu.',
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

  return (
    <>
      {/* Banner trigger */}
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
              {vi ? 'Hướng dẫn bắt đầu' : 'Getting started guide'}
            </h3>
            <p className="mt-0.5 text-caption text-text-tertiary">
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
                  className={cn(
                    'h-2.5 w-2.5 rounded-full',
                    s.done ? 'bg-success' : 'bg-surface-3',
                  )}
                />
              ))}
            </div>
            <ChevronRight className="h-4 w-4 text-text-quaternary" />
          </div>
        </button>
      </div>

      {/* Modal */}
      {modalOpen && (
        <Modal
          isOpen
          onClose={() => setModalOpen(false)}
          title={vi ? 'Hướng dẫn sử dụng AppBI' : 'How to use AppBI'}
          size="xl"
          bodyClassName="p-0 overflow-hidden"
          contentClassName="h-[85vh] max-h-[680px]"
        >
          <GuideContent
            steps={steps}
            activeStep={activeStep}
            setActiveStep={setActiveStep}
            vi={vi}
            onCtaNavigate={(href) => {
              setModalOpen(false);
              router.push(href);
            }}
          />
        </Modal>
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
      details: ['Go to Data Sources in the sidebar', 'Click "New data source" and choose a type: PostgreSQL, MySQL, BigQuery, Google Sheets, or Manual (CSV/Excel upload)', 'Fill in connection details and click "Create" to save. AppBI will validate the connection automatically.', 'Once connected, your tables will be available for the next step'],
      detailsVi: ['Vào Data Sources trên sidebar', 'Nhấn "New data source" và chọn loại: PostgreSQL, MySQL, BigQuery, Google Sheets, hoặc Manual (tải CSV/Excel)', 'Điền thông tin kết nối rồi nhấn "Create". AppBI sẽ tự kiểm tra kết nối trước khi lưu.', 'Sau khi kết nối thành công, các bảng dữ liệu sẽ sẵn sàng cho bước tiếp theo'],
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

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={vi ? 'Hướng dẫn sử dụng AppBI' : 'How to use AppBI'}
      size="xl"
      bodyClassName="p-0 overflow-hidden"
      contentClassName="h-[85vh] max-h-[680px]"
    >
      <GuideContent
        steps={steps}
        activeStep={activeStep}
        setActiveStep={setActiveStep}
        vi={vi}
        onCtaNavigate={(href) => {
          onClose();
          router.push(href);
        }}
      />
    </Modal>
  );
}
