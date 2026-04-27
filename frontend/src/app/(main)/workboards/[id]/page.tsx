'use client';

import React, { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ChevronLeft,
  ClipboardList,
  Download,
  Eye,
  Loader2,
  Wrench,
} from 'lucide-react';

import { useWorkboard } from '@/hooks/use-workboards';
import { Button } from '@/components/ui/Button';
import WorkboardBuilder from '@/components/workboards/builder/WorkboardBuilder';
import WorkboardPreview from '@/components/workboards/builder/WorkboardPreview';
import WorkboardImportExportModal from '@/components/workboards/builder/WorkboardImportExportModal';

type Tab = 'builder' | 'preview';

export default function WorkboardRuntimePage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [tab, setTab] = useState<Tab>('builder');
  const [importExportMode, setImportExportMode] = useState<'export' | 'import' | null>(null);

  const { data: workboard, isLoading, error } = useWorkboard(id);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-7 w-7 animate-spin text-brand" />
      </div>
    );
  }

  if (error || !workboard) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
        <ClipboardList className="h-10 w-10 text-text-tertiary" />
        <p className="text-body text-text-secondary">Workboard not found.</p>
        <Button
          onClick={() => router.push('/workboards')}
          leadingIcon={<ChevronLeft className="h-4 w-4" />}
        >
          Back to list
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Single compact 11-row header — same shape as the dataset detail page. */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4">
        <button
          onClick={() => router.push('/workboards')}
          className="flex items-center gap-1 text-sm text-text-tertiary transition-colors hover:text-text-primary"
        >
          <ChevronLeft className="h-4 w-4" />
          Workboards
        </button>
        <span className="text-text-quaternary">/</span>
        <span className="max-w-[260px] truncate text-sm font-medium text-text-primary">
          {workboard.name}
        </span>

        <div className="mx-1 h-5 w-px bg-surface-3" />

        {/* Segmented control */}
        <div className="inline-flex rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-0.5">
          <SegmentBtn active={tab === 'builder'} onClick={() => setTab('builder')}>
            <Wrench className="h-3.5 w-3.5" />
            Builder
          </SegmentBtn>
          <SegmentBtn active={tab === 'preview'} onClick={() => setTab('preview')}>
            <Eye className="h-3.5 w-3.5" />
            Preview
          </SegmentBtn>
        </div>

        <div className="flex-1" />

        {/* Export only — Import button lives on the list page so users can
            create a new workboard from a template without first having to
            open an existing one. */}
        <button
          onClick={() => setImportExportMode('export')}
          className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
          title="Export workboard cho thư viện template"
        >
          <Download className="h-3.5 w-3.5" />
          Export
        </button>
      </div>

      <div className="flex-1 overflow-hidden">
        {tab === 'builder' && <WorkboardBuilder workboard={workboard} />}
        {tab === 'preview' && <WorkboardPreview workboard={workboard} />}
      </div>

      {importExportMode && (
        <WorkboardImportExportModal
          workboard={workboard}
          mode={importExportMode}
          onClose={() => setImportExportMode(null)}
        />
      )}
    </div>
  );
}

function SegmentBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-surface-1 text-brand shadow-linear-sm'
          : 'text-text-tertiary hover:bg-surface-1'
      }`}
    >
      {children}
    </button>
  );
}
