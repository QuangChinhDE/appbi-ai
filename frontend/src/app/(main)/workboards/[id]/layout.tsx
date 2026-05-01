/**
 * Layout for ``/workboards/[id]/*`` — shared header (breadcrumb + tabs +
 * Export) above three sibling routes: Builder (default), Users, Preview.
 *
 * Splitting tabs into routes lets users deep-link directly into a tab,
 * keeps browser back/forward semantics sane, and lets each tab keep its
 * own loading state without one giant ``useState<Tab>``.
 */
'use client';

import React, { useEffect, useState } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ChevronLeft,
  ClipboardList,
  Download,
  Eye,
  Loader2,
  UserCircle2,
  Wrench,
} from 'lucide-react';

import { useWorkboard } from '@/hooks/use-workboards';
import { Button } from '@/components/ui/Button';
import WorkboardImportExportModal from '@/components/workboards/builder/WorkboardImportExportModal';
import {
  consumeWorkboardDefaultOwnerNotice,
  type WorkboardDefaultOwnerNotice,
} from '@/lib/workboard-default-owner-notice';

export default function WorkboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const pathname = usePathname() || '';
  const id = Number(params.id);
  const [importExportMode, setImportExportMode] = useState<'export' | null>(null);
  const [defaultOwnerNotice, setDefaultOwnerNotice] = useState<WorkboardDefaultOwnerNotice | null>(null);

  const { data: workboard, isLoading, error } = useWorkboard(id);

  useEffect(() => {
    if (!Number.isFinite(id) || id <= 0) return;
    setDefaultOwnerNotice(consumeWorkboardDefaultOwnerNotice(id));
  }, [id]);

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

  // Active tab inferred from URL — single source of truth, survives
  // refresh and bookmarking.
  const baseHref = `/workboards/${id}`;
  const isUsers = pathname.startsWith(`${baseHref}/users`);
  const isPreview = pathname.startsWith(`${baseHref}/preview`);
  const isBuilder = !isUsers && !isPreview;

  return (
    <div className="flex h-full flex-col">
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

        <div className="inline-flex rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-0.5">
          <SegmentLink active={isBuilder} href={baseHref}>
            <Wrench className="h-3.5 w-3.5" />
            Builder
          </SegmentLink>
          <SegmentLink active={isUsers} href={`${baseHref}/users`}>
            <UserCircle2 className="h-3.5 w-3.5" />
            Users
          </SegmentLink>
          <SegmentLink active={isPreview} href={`${baseHref}/preview`}>
            <Eye className="h-3.5 w-3.5" />
            Preview
          </SegmentLink>
        </div>

        <div className="flex-1" />

        <button
          onClick={() => setImportExportMode('export')}
          className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
          title="Export workboard cho thư viện template"
        >
          <Download className="h-3.5 w-3.5" />
          Export
        </button>
      </div>

      {defaultOwnerNotice && (
        <div className="flex items-start gap-3 border-b border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Owner mặc định vừa được tạo cho workboard này.</p>
            <p className="text-xs text-danger/90">
              Username: <strong>{defaultOwnerNotice.username}</strong> | PIN mặc định:{' '}
              <strong>{defaultOwnerNotice.pin}</strong>. Hãy đổi PIN này trong tab Users.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDefaultOwnerNotice(null)}
            className="rounded px-1 py-0.5 text-xs text-danger/80 transition-colors hover:bg-danger/10 hover:text-danger"
          >
            Đóng
          </button>
        </div>
      )}

      <div className="flex-1 overflow-hidden">{children}</div>

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

function SegmentLink({
  active,
  href,
  children,
}: {
  active: boolean;
  href: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push(href)}
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
