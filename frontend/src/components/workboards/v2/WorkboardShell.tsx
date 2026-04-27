'use client';

import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  ClipboardList,
  Edit,
  FileText,
  Grid3x3,
  Image as ImageIcon,
  LayoutDashboard,
  Loader2,
  Map as MapIcon,
  PieChart,
  Table as TableIcon,
  Trash2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';

import WorkboardFormRenderer from '@/components/workboards/WorkboardFormRenderer';
import WorkboardPublicLinksModal from '@/components/workboards/WorkboardPublicLinksModal';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { Button } from '@/components/ui/Button';
import {
  useDeleteWorkboardRow,
  useExecuteV2Action,
  useInsertWorkboardRow,
  usePublishWorkboard,
  useRenderV2View,
  useUpdateWorkboardRow,
  useWorkboardForm,
  useWorkboardV2Views,
} from '@/hooks/use-workboards';
import { toast } from '@/lib/toast';
import type {
  Workboard,
  WorkboardAppAction,
  WorkboardAppView,
  WorkboardRenderViewResponse,
} from '@/lib/api/workboards';

const VIEW_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  table: TableIcon,
  deck: ClipboardList,
  detail: FileText,
  form: Edit,
  gallery: ImageIcon,
  calendar: ClipboardList,
  map: MapIcon,
  chart: PieChart,
  dashboard: LayoutDashboard,
  onboarding: ClipboardList,
};

interface Props {
  workboard: Workboard;
}

interface DetailContext {
  viewId: string;
  pk: Record<string, unknown>;
}

interface EditContext {
  pk?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

function extractErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null) {
    const response = (error as { response?: { data?: { detail?: unknown } } }).response;
    const detail = response?.data?.detail;
    if (typeof detail === 'string' && detail.trim()) {
      return detail;
    }
  }
  return fallback;
}

function buildPk(row: Record<string, unknown>, pkCols: string[]): Record<string, unknown> {
  const pk: Record<string, unknown> = {};
  pkCols.forEach((column) => {
    pk[column] = row[column];
  });
  return pk;
}

function hasPk(pk: Record<string, unknown>): boolean {
  return Object.keys(pk).length > 0 && Object.values(pk).every((value) => value !== undefined);
}

export default function WorkboardShell({ workboard }: Props) {
  const router = useRouter();
  const { data: bundle, isLoading, error } = useWorkboardV2Views(workboard.id);
  const publishMutation = usePublishWorkboard();
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailContext | null>(null);
  const [editContext, setEditContext] = useState<EditContext | null>(null);
  const [publicLinksOpen, setPublicLinksOpen] = useState(false);

  const navIds = useMemo(() => {
    if (!bundle) return [] as string[];
    const ids = new Set<string>();
    if (bundle.nav?.primary_view) ids.add(bundle.nav.primary_view);
    (bundle.nav?.menu_view_ids ?? []).forEach((id) => ids.add(id));
    return Array.from(ids);
  }, [bundle]);

  const navViews = useMemo(() => {
    if (!bundle) return [] as WorkboardAppView[];
    return navIds
      .map((id) => bundle.views.find((view) => view.id === id))
      .filter(Boolean) as WorkboardAppView[];
  }, [bundle, navIds]);

  const currentViewId = activeViewId ?? bundle?.nav?.primary_view ?? navIds[0] ?? null;
  const currentView = bundle?.views.find((view) => view.id === currentViewId) ?? null;
  const formView = bundle?.views.find((view) => view.kind === 'form') ?? null;
  const resourcePerms = getResourcePermissions(workboard.user_permission ?? undefined);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-7 w-7 animate-spin text-brand" />
      </div>
    );
  }

  if (error || !bundle) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
        <ClipboardList className="h-10 w-10 text-text-tertiary" />
        <p className="text-body text-text-secondary">Could not load workboard runtime.</p>
      </div>
    );
  }

  const branding = bundle.branding ?? {};

  return (
    <div className="flex h-full flex-col bg-surface-base">
      <header
        className="flex items-center justify-between gap-3 border-b border-[rgb(var(--border-line))] px-6 py-3"
        style={
          branding.primary_color
            ? { background: branding.primary_color, color: '#fff' }
            : undefined
        }
      >
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push('/workboards')}
            leadingIcon={<ArrowLeft className="h-4 w-4" />}
          >
            Back
          </Button>
          <div className="flex min-w-0 items-center gap-2">
            {branding.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={branding.logo_url}
                alt=""
                className="h-7 w-7 rounded object-contain"
              />
            ) : null}
            <h1 className="truncate text-h3 font-emphasis">
              {branding.app_name || workboard.name}
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {resourcePerms.canEdit ? (
            <>
              {!workboard.is_published ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    publishMutation.mutate(workboard.id, {
                      onSuccess: () => toast.success('Workboard published.'),
                      onError: (err: unknown) =>
                        toast.error(extractErrorMessage(err, 'Publish failed')),
                    });
                  }}
                  disabled={publishMutation.isPending}
                >
                  {publishMutation.isPending ? 'Publishing…' : 'Publish'}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPublicLinksOpen(true)}
              >
                Public Links
              </Button>
            </>
          ) : null}
          {currentView ? (
            <span className="rounded-full bg-white/15 px-2.5 py-1 text-label uppercase tracking-wide">
              {currentView.kind}
            </span>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-56 shrink-0 flex-col gap-0.5 border-r border-[rgb(var(--border-line))] bg-surface-1 p-2">
          {navViews.map((view) => {
            const Icon = VIEW_ICONS[view.kind] ?? ClipboardList;
            const isActive = view.id === currentViewId;
            return (
              <button
                key={view.id}
                type="button"
                onClick={() => {
                  setActiveViewId(view.id);
                  setDetail(null);
                  if (view.kind !== 'form') {
                    setEditContext(null);
                  }
                }}
                className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-caption transition-colors ${
                  isActive
                    ? 'bg-brand/10 text-brand font-emphasis'
                    : 'text-text-secondary hover:bg-surface-2'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{view.label}</span>
              </button>
            );
          })}
          {navViews.length === 0 ? (
            <div className="px-2 py-3 text-label text-text-tertiary">No views configured.</div>
          ) : null}
        </nav>

        <main className="min-w-0 flex-1 overflow-auto p-6">
          {detail ? (
            <DetailRenderer
              workboardId={workboard.id}
              viewId={detail.viewId}
              pk={detail.pk}
              onBack={() => setDetail(null)}
              onEditRow={(pk, values) => {
                if (!formView) {
                  toast.error('No form view is configured for editing.');
                  return;
                }
                setEditContext({ pk, values });
                setDetail(null);
                setActiveViewId(formView.id);
              }}
              bundleActions={bundle.actions ?? []}
            />
          ) : currentView ? (
            <ViewRenderer
              workboardId={workboard.id}
              view={currentView}
              actions={bundle.actions ?? []}
              editContext={editContext}
              onOpenDetail={(pk) => {
                const detailView = bundle.views.find((view) => view.kind === 'detail');
                if (detailView) {
                  setDetail({ viewId: detailView.id, pk });
                }
              }}
              onEditRow={(pk, values) => {
                if (!formView) {
                  toast.error('No form view is configured for editing.');
                  return;
                }
                setEditContext({ pk, values });
                setActiveViewId(formView.id);
              }}
              onFormSaved={() => {
                setEditContext(null);
              }}
            />
          ) : (
            <EmptyState />
          )}
        </main>
      </div>

      {publicLinksOpen ? (
        <WorkboardPublicLinksModal
          workboard={workboard}
          views={bundle.views ?? []}
          onClose={() => setPublicLinksOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ViewRenderer({
  workboardId,
  view,
  actions,
  editContext,
  onOpenDetail,
  onEditRow,
  onFormSaved,
}: {
  workboardId: number;
  view: WorkboardAppView;
  actions: WorkboardAppAction[];
  editContext: EditContext | null;
  onOpenDetail: (pk: Record<string, unknown>) => void;
  onEditRow: (pk: Record<string, unknown>, values: Record<string, unknown>) => void;
  onFormSaved: () => void;
}) {
  const { data, isLoading, error } = useRenderV2View(workboardId, view.id, {
    page: 1,
    page_size: 50,
  });

  if (isLoading && view.kind !== 'form') {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-brand" />
      </div>
    );
  }
  if (error && view.kind !== 'form') {
    return <ErrorBox message={extractErrorMessage(error, String(error))} />;
  }
  if (!data && view.kind !== 'form') {
    return <EmptyState />;
  }

  const viewActions = (view.action_ids ?? [])
    .map((id) => actions.find((action) => action.id === id))
    .filter(Boolean) as WorkboardAppAction[];

  switch (view.kind) {
    case 'table':
      return (
        <TableView
          data={data as WorkboardRenderViewResponse}
          view={view}
          workboardId={workboardId}
          rowActions={viewActions}
          onOpenDetail={onOpenDetail}
          onEditRow={onEditRow}
        />
      );
    case 'deck':
      return <DeckView data={data as WorkboardRenderViewResponse} view={view} onOpenDetail={onOpenDetail} />;
    case 'gallery':
      return <GalleryView data={data as WorkboardRenderViewResponse} view={view} onOpenDetail={onOpenDetail} />;
    case 'form':
      return (
        <FormPane
          workboardId={workboardId}
          view={view}
          editContext={editContext}
          onSaved={onFormSaved}
        />
      );
    case 'calendar':
    case 'map':
    case 'chart':
    case 'dashboard':
      return <PhaseTwoPlaceholder view={view} />;
    default:
      return <EmptyState />;
  }
}

function TableView({
  data,
  view,
  workboardId,
  rowActions,
  onOpenDetail,
  onEditRow,
}: {
  data: WorkboardRenderViewResponse;
  view: WorkboardAppView;
  workboardId: number;
  rowActions: WorkboardAppAction[];
  onOpenDetail: (pk: Record<string, unknown>) => void;
  onEditRow: (pk: Record<string, unknown>, values: Record<string, unknown>) => void;
}) {
  const exec = useExecuteV2Action(workboardId);
  const deleteMutation = useDeleteWorkboardRow(workboardId);
  const cols = data.columns ?? [];
  const rows = data.rows ?? [];
  const pkCols = data.table?.pk ?? [];
  const fallbackActions = Array.isArray(view.config?.row_actions)
    ? (view.config?.row_actions as string[])
    : [];

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[rgb(var(--border-line))] bg-surface-1 p-10 text-center text-caption text-text-tertiary">
        No records yet.
      </div>
    );
  }

  return (
    <div className="overflow-auto rounded-lg border border-[rgb(var(--border-line))] bg-surface-1">
      <div className="flex items-center justify-between gap-2 border-b border-[rgb(var(--border-line))] px-3 py-2">
        <h2 className="text-body font-emphasis">{view.label}</h2>
        <span className="text-label text-text-tertiary">{rows.length} rows</span>
      </div>
      <table className="min-w-full divide-y divide-[rgb(var(--border-line))]">
        <thead className="bg-surface-2">
          <tr>
            {cols.map((column) => (
              <th
                key={column}
                className="px-3 py-2 text-left text-label font-emphasis uppercase tracking-wide text-text-tertiary"
              >
                {column}
              </th>
            ))}
            {(rowActions.length > 0 || fallbackActions.length > 0) ? <th className="w-1" /> : null}
            <th className="w-1" />
          </tr>
        </thead>
        <tbody className="divide-y divide-[rgb(var(--border-line))]">
          {rows.map((row, index) => {
            const pk = buildPk(row, pkCols);
            const rowHasPk = hasPk(pk);
            return (
              <tr
                key={index}
                className={rowHasPk ? 'cursor-pointer hover:bg-surface-2' : 'bg-surface-1'}
                onClick={() => {
                  if (!rowHasPk) return;
                  onOpenDetail(pk);
                }}
              >
                {cols.map((column) => (
                  <td key={column} className="px-3 py-2 text-caption text-text-primary">
                    {String(row[column] ?? '')}
                  </td>
                ))}
                {(rowActions.length > 0 || fallbackActions.length > 0) ? (
                  <td className="px-2 py-1 text-right" onClick={(event) => event.stopPropagation()}>
                    <div className="flex justify-end gap-1">
                      {fallbackActions.includes('edit') && rowHasPk ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onEditRow(pk, row)}
                        >
                          Edit
                        </Button>
                      ) : null}
                      {fallbackActions.includes('delete') && rowHasPk ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (!window.confirm('Delete this row?')) return;
                            deleteMutation.mutate(
                              { pk },
                              {
                                onSuccess: () => toast.success('Row deleted.'),
                                onError: (err: unknown) =>
                                  toast.error(extractErrorMessage(err, 'Delete failed')),
                              },
                            );
                          }}
                        >
                          Delete
                        </Button>
                      ) : null}
                      {rowActions.map((action) => (
                        <Button
                          key={action.id}
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (!rowHasPk) return;
                            if (action.confirm_message && !window.confirm(action.confirm_message)) return;
                            if (action.kind === 'open_url' && action.url) {
                              window.open(action.url, '_blank', 'noopener');
                              return;
                            }
                            exec.mutate({ actionId: action.id, pk });
                          }}
                        >
                          {action.label}
                        </Button>
                      ))}
                    </div>
                  </td>
                ) : null}
                <td className="px-2 text-text-tertiary">
                  {rowHasPk ? <ChevronRight className="h-4 w-4" /> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DeckView({
  data,
  view,
  onOpenDetail,
}: {
  data: WorkboardRenderViewResponse;
  view: WorkboardAppView;
  onOpenDetail: (pk: Record<string, unknown>) => void;
}) {
  const cols = data.columns ?? [];
  const rows = data.rows ?? [];
  const pkCols = data.table?.pk ?? [];
  const titleCol = (view.config?.title_column as string) || data.table?.label_column || cols[0];
  const subCols = cols.filter((column) => column !== titleCol).slice(0, 3);

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {rows.map((row, index) => {
        const pk = buildPk(row, pkCols);
        return (
          <button
            key={index}
            type="button"
            className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-4 text-left transition-shadow hover:shadow-md"
            onClick={() => {
              if (!hasPk(pk)) return;
              onOpenDetail(pk);
            }}
          >
            <div className="mb-2 truncate text-body font-emphasis text-text-primary">
              {String(row[titleCol] ?? '')}
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              {subCols.map((column) => (
                <React.Fragment key={column}>
                  <dt className="truncate text-label uppercase tracking-wide text-text-tertiary">
                    {column}
                  </dt>
                  <dd className="truncate text-caption text-text-secondary">
                    {String(row[column] ?? '')}
                  </dd>
                </React.Fragment>
              ))}
            </dl>
          </button>
        );
      })}
    </div>
  );
}

function GalleryView({
  data,
  view,
  onOpenDetail,
}: {
  data: WorkboardRenderViewResponse;
  view: WorkboardAppView;
  onOpenDetail: (pk: Record<string, unknown>) => void;
}) {
  const cols = data.columns ?? [];
  const rows = data.rows ?? [];
  const pkCols = data.table?.pk ?? [];
  const imageCol =
    (view.config?.image_column as string)
    || cols.find((column) => /image|photo|url|logo/i.test(column));
  const titleCol = (view.config?.title_column as string) || data.table?.label_column || cols[0];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {rows.map((row, index) => {
        const pk = buildPk(row, pkCols);
        return (
          <button
            key={index}
            type="button"
            className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 transition-shadow hover:shadow-md"
            onClick={() => {
              if (!hasPk(pk)) return;
              onOpenDetail(pk);
            }}
          >
            <div className="aspect-square w-full bg-surface-2">
              {imageCol && row[imageCol] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={String(row[imageCol])}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-text-tertiary">
                  <ImageIcon className="h-8 w-8" />
                </div>
              )}
            </div>
            <div className="px-3 py-2 text-left">
              <div className="truncate text-caption font-emphasis text-text-primary">
                {String(row[titleCol] ?? '')}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function DetailRenderer({
  workboardId,
  viewId,
  pk,
  onBack,
  onEditRow,
  bundleActions,
}: {
  workboardId: number;
  viewId: string;
  pk: Record<string, unknown>;
  onBack: () => void;
  onEditRow: (pk: Record<string, unknown>, values: Record<string, unknown>) => void;
  bundleActions: WorkboardAppAction[];
}) {
  const exec = useExecuteV2Action(workboardId);
  const deleteMutation = useDeleteWorkboardRow(workboardId);
  const { data, isLoading, error } = useRenderV2View(workboardId, viewId, { pk });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-brand" />
      </div>
    );
  }
  if (error || !data) {
    return <ErrorBox message={extractErrorMessage(error, 'Row not found')} />;
  }

  const row = data.row;
  const cols = data.columns ?? [];
  const detailActions = (data.view?.action_ids ?? [])
    .map((id) => bundleActions.find((action) => action.id === id))
    .filter(Boolean) as WorkboardAppAction[];

  if (!row) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={onBack} leadingIcon={<ArrowLeft className="h-4 w-4" />}>
          Back
        </Button>
        <EmptyState message="Row not found." />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} leadingIcon={<ArrowLeft className="h-4 w-4" />}>
          Back
        </Button>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onEditRow(pk, row)}
            leadingIcon={<Edit className="h-4 w-4" />}
          >
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (!window.confirm('Delete this row?')) return;
              deleteMutation.mutate(
                { pk },
                {
                  onSuccess: () => {
                    toast.success('Row deleted.');
                    onBack();
                  },
                  onError: (err: unknown) =>
                    toast.error(extractErrorMessage(err, 'Delete failed')),
                },
              );
            }}
            leadingIcon={<Trash2 className="h-4 w-4" />}
          >
            Delete
          </Button>
          {detailActions.map((action) => (
            <Button
              key={action.id}
              variant="secondary"
              size="sm"
              onClick={() => {
                if (action.confirm_message && !window.confirm(action.confirm_message)) return;
                if (action.kind === 'open_url' && action.url) {
                  window.open(action.url, '_blank', 'noopener');
                  return;
                }
                exec.mutate({ actionId: action.id, pk });
              }}
            >
              {action.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-5">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-2">
          {cols.map((column) => (
            <div key={column} className="min-w-0">
              <dt className="text-label uppercase tracking-wide text-text-tertiary">{column}</dt>
              <dd className="break-words text-body text-text-primary">{String(row[column] ?? '—')}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function FormPane({
  workboardId,
  view,
  editContext,
  onSaved,
}: {
  workboardId: number;
  view: WorkboardAppView;
  editContext: EditContext | null;
  onSaved: () => void;
}) {
  const { data: formSpec, isLoading, error } = useWorkboardForm(workboardId);
  const insertMutation = useInsertWorkboardRow(workboardId);
  const updateMutation = useUpdateWorkboardRow(workboardId);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [resetSeed, setResetSeed] = useState(0);
  const isEditing = !!editContext?.pk && hasPk(editContext.pk);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-brand" />
      </div>
    );
  }
  if (error || !formSpec) {
    return <ErrorBox message={extractErrorMessage(error, 'Could not load form.')} />;
  }

  return (
    <WorkboardFormRenderer
      key={`${isEditing ? JSON.stringify(editContext?.pk) : 'new'}:${resetSeed}`}
      form={formSpec}
      title={isEditing ? `${view.label} • Edit row` : view.label}
      submitLabel={isEditing ? 'Update row' : 'Create row'}
      initialValues={editContext?.values ?? null}
      submitting={insertMutation.isPending || updateMutation.isPending}
      error={submitError}
      onCancel={isEditing ? () => onSaved() : undefined}
      onSubmit={async (values) => {
        setSubmitError(null);
        try {
          if (isEditing && editContext?.pk) {
            await updateMutation.mutateAsync({
              pk: editContext.pk,
              values,
            });
            toast.success('Row updated.');
            onSaved();
            return;
          }
          await insertMutation.mutateAsync(values);
          toast.success('Row created.');
          setResetSeed((current) => current + 1);
          onSaved();
        } catch (err: unknown) {
          const detail = (
            err as { response?: { data?: { detail?: unknown } } }
          )?.response?.data?.detail;
          if (detail && typeof detail === 'object' && 'message' in detail) {
            setSubmitError(String((detail as { message?: unknown }).message ?? 'Save failed'));
            return;
          }
          setSubmitError(typeof detail === 'string' ? detail : 'Save failed');
        }
      }}
    />
  );
}

function PhaseTwoPlaceholder({ view }: { view: WorkboardAppView }) {
  const Icon = VIEW_ICONS[view.kind] ?? Grid3x3;
  return (
    <div className="rounded-lg border border-dashed border-[rgb(var(--border-line))] bg-surface-1 p-10 text-center">
      <Icon className="mx-auto h-8 w-8 text-text-tertiary" />
      <p className="mt-2 text-body font-emphasis">{view.label}</p>
      <p className="mt-1 text-caption text-text-tertiary">
        The <code className="rounded bg-surface-2 px-1.5 py-0.5">{view.kind}</code>{' '}
        view kind is on the Phase 2.4 roadmap. The view configuration is preserved
        and will activate once the renderer ships.
      </p>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-caption text-red-600">
      {message}
    </div>
  );
}

function EmptyState({ message }: { message?: string } = {}) {
  return (
    <div className="rounded-lg border border-dashed border-[rgb(var(--border-line))] bg-surface-1 p-10 text-center text-caption text-text-tertiary">
      {message ?? 'No data to display.'}
    </div>
  );
}
