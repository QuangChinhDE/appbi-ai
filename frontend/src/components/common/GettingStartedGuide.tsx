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
} from 'lucide-react';
import { useDataSources } from '@/hooks/use-datasources';
import { useWorkspaces } from '@/hooks/use-dataset-workspaces';
import { useAgentReportSpecs } from '@/hooks/use-agent-report-specs';

const DISMISS_KEY = 'appbi:getting-started-dismissed';

interface Step {
  key: string;
  icon: React.ElementType;
  title: string;
  titleVi: string;
  desc: string;
  descVi: string;
  href: string;
  done: boolean;
}

export function GettingStartedGuide({ locale = 'en' }: { locale?: string }) {
  const router = useRouter();
  const vi = locale === 'vi';

  const [dismissed, setDismissed] = useState(true); // hidden until localStorage check
  useEffect(() => {
    setDismissed(localStorage.getItem(DISMISS_KEY) === '1');
  }, []);

  const { data: datasources } = useDataSources();
  const { data: workspaces } = useWorkspaces();
  const { data: reports } = useAgentReportSpecs();

  const hasDatasource = (datasources?.length ?? 0) > 0;
  const hasWorkspace = (workspaces?.length ?? 0) > 0;
  const hasTable = (workspaces ?? []).some(
    (ws: any) => (ws.tables?.length ?? ws.table_count ?? 0) > 0,
  );
  const hasReport = (reports?.length ?? 0) > 0;

  const steps: Step[] = [
    {
      key: 'datasource',
      icon: Plug,
      title: 'Connect a data source',
      titleVi: 'Kết nối nguồn dữ liệu',
      desc: 'PostgreSQL, MySQL, BigQuery, Google Sheets, or upload a file.',
      descVi: 'PostgreSQL, MySQL, BigQuery, Google Sheets, hoặc tải file lên.',
      href: '/datasources',
      done: hasDatasource,
    },
    {
      key: 'workspace',
      icon: Database,
      title: 'Create a workspace',
      titleVi: 'Tạo workspace',
      desc: 'Group related tables into a workspace for analysis.',
      descVi: 'Nhóm các bảng liên quan vào workspace để phân tích.',
      href: '/dataset-workspaces',
      done: hasWorkspace,
    },
    {
      key: 'table',
      icon: Table2,
      title: 'Add tables to workspace',
      titleVi: 'Thêm bảng vào workspace',
      desc: 'Pick tables or write SQL queries from your data source.',
      descVi: 'Chọn bảng hoặc viết SQL query từ nguồn dữ liệu.',
      href: '/dataset-workspaces',
      done: hasTable,
    },
    {
      key: 'report',
      icon: Bot,
      title: 'Build an AI Report',
      titleVi: 'Tạo AI Report',
      desc: 'Select tables, write a brief, and let AI build your dashboard.',
      descVi: 'Chọn bảng, viết brief, để AI tự động tạo dashboard.',
      href: '/ai-reports',
      done: hasReport,
    },
  ];

  const completedCount = steps.filter((s) => s.done).length;
  const allDone = completedCount === steps.length;

  if (dismissed || allDone) return null;

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  };

  return (
    <div className="relative mb-6 rounded-xl border border-blue-200 bg-gradient-to-br from-blue-50 via-white to-indigo-50 p-6 shadow-sm">
      {/* Dismiss */}
      <button
        onClick={handleDismiss}
        className="absolute right-3 top-3 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
      >
        <X className="h-4 w-4" />
      </button>

      {/* Header */}
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100">
          <Sparkles className="h-5 w-5 text-blue-600" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            {vi ? 'Bắt đầu nhanh' : 'Getting started'}
          </h2>
          <p className="text-sm text-gray-500">
            {vi
              ? `${completedCount}/${steps.length} bước hoàn thành`
              : `${completedCount}/${steps.length} steps completed`}
          </p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mb-5 h-2 overflow-hidden rounded-full bg-gray-200">
        <div
          className="h-full rounded-full bg-blue-500 transition-all duration-500"
          style={{ width: `${(completedCount / steps.length) * 100}%` }}
        />
      </div>

      {/* Steps */}
      <div className="grid gap-3 sm:grid-cols-2">
        {steps.map((step, idx) => {
          const Icon = step.icon;
          const isNext = !step.done && steps.slice(0, idx).every((s) => s.done);
          return (
            <button
              key={step.key}
              onClick={() => router.push(step.href)}
              className={`group flex items-start gap-3 rounded-lg border p-4 text-left transition-all ${
                step.done
                  ? 'border-green-200 bg-green-50/50'
                  : isNext
                    ? 'border-blue-300 bg-white shadow-sm hover:shadow-md'
                    : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
              }`}
            >
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                  step.done
                    ? 'bg-green-100'
                    : isNext
                      ? 'bg-blue-100'
                      : 'bg-gray-100'
                }`}
              >
                {step.done ? (
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                ) : (
                  <Icon
                    className={`h-5 w-5 ${isNext ? 'text-blue-600' : 'text-gray-400'}`}
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-sm font-semibold ${
                      step.done
                        ? 'text-green-700'
                        : isNext
                          ? 'text-gray-900'
                          : 'text-gray-600'
                    }`}
                  >
                    {vi ? step.titleVi : step.title}
                  </span>
                  {isNext && (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-700">
                      {vi ? 'Tiếp theo' : 'Next'}
                    </span>
                  )}
                </div>
                <p
                  className={`mt-0.5 text-xs ${step.done ? 'text-green-600' : 'text-gray-500'}`}
                >
                  {vi ? step.descVi : step.desc}
                </p>
              </div>
              {!step.done && (
                <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-gray-300 transition-colors group-hover:text-blue-500" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
