'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  X, Link2, Copy, Check, Trash2, Globe, Filter, Plus,
  Eye, EyeOff, Clock, Loader2, ArrowLeft, Lock, Code2, Sparkles,
} from 'lucide-react';
import { dashboardApi, PublicLink } from '@/lib/api/dashboards';
import { chartApi } from '@/lib/api/charts';
import { DashboardFilterBar } from '@/components/dashboards/DashboardFilterBar';
import { useFilterDistinctValues } from '@/hooks/use-filter-distinct-values';
import { toast } from '@/lib/toast';
import {
  buildPublicLinkTheme,
  describePublicLinkAppearance,
  normalizePublicLinkAppearance,
} from '@/lib/public-link-appearance';
import { PublicLinkAppearanceEditor } from '@/components/common/PublicLinkAppearanceEditor';
import {
  getFilterDisplayLabel,
  inferColumnTypeFromData,
  type BaseFilter,
  type ColumnInfo,
} from '@/lib/filters';
import type { PublicLinkAppearanceConfig } from '@/types/api';

interface PublicLinksManagerProps {
  dashboardId: number;
  dashboardName: string;
  availableColumns?: ColumnInfo[];
  columnChartCount?: Map<string, number>;
  distinctValues?: Record<string, string[]>;
  onClose: () => void;
}

type ModalView = 'list' | 'create' | 'edit';

const DEFAULT_APPEARANCE = normalizePublicLinkAppearance(null);

export function PublicLinksManager({
  dashboardId,
  dashboardName,
  availableColumns: propColumns,
  columnChartCount: propChartCount,
  distinctValues: propDistinctValues,
  onClose,
}: PublicLinksManagerProps) {
  const [links, setLinks] = useState<PublicLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  const [columns, setColumns] = useState<ColumnInfo[]>(propColumns ?? []);
  const [chartCount, setChartCount] = useState<Map<string, number>>(propChartCount ?? new Map());
  const [dv, setDv] = useState<Record<string, string[]>>(propDistinctValues ?? {});
  const [columnsLoading, setColumnsLoading] = useState(false);

  const [view, setView] = useState<ModalView>('list');
  const [editingLink, setEditingLink] = useState<PublicLink | null>(null);

  const [formName, setFormName] = useState('');
  const [formFilters, setFormFilters] = useState<BaseFilter[]>([]);
  const [formAppearance, setFormAppearance] = useState<PublicLinkAppearanceConfig>(DEFAULT_APPEARANCE);
  const [formPassword, setFormPassword] = useState('');
  const [passwordEnabled, setPasswordEnabled] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [changePassword, setChangePassword] = useState(false);
  const [previewMode, setPreviewMode] = useState<'public' | 'embed'>('public');

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [copiedEmbedId, setCopiedEmbedId] = useState<number | null>(null);
  const [copiedSnippetId, setCopiedSnippetId] = useState<number | null>(null);

  const getEmbedUrl = (link: PublicLink) => `${origin.replace(/\/$/, '')}/embed/${link.token}`;

  const getIframeSnippet = (link: PublicLink) =>
    `<iframe\n  src="${getEmbedUrl(link)}"\n  loading="lazy"\n  style="width:100%;min-height:680px;border:0;border-radius:24px;background:#f8fafc;"\n  referrerpolicy="strict-origin-when-cross-origin"\n  title="${link.name.replace(/"/g, '&quot;')}"\n></iframe>`;

  const copyText = (text: string, onDone: () => void) => {
    navigator.clipboard.writeText(text).then(onDone).catch(() => toast.error('Failed to copy'));
  };

  const fetchColumnData = useCallback(async () => {
    if ((propColumns?.length ?? 0) > 0) return;
    setColumnsLoading(true);
    try {
      const dash = await dashboardApi.getById(dashboardId);
      const charts = dash.dashboard_charts ?? [];
      if (!charts.length) return;

      const colMap = new Map<string, ColumnInfo>();
      const countMap = new Map<string, Set<number>>();
      const dvMap = new Map<string, Set<string>>();

      await Promise.all(
        charts.map(async (dc) => {
          try {
            const resp = await chartApi.getData(dc.chart_id, undefined, 'dashboard');
            const rows = resp?.data ?? [];
            if (!rows.length) return;

            const fields = Object.keys(rows[0]);
            for (const field of fields) {
              if (!colMap.has(field)) {
                colMap.set(field, { name: field, type: inferColumnTypeFromData(field, rows) });
              }
              if (!countMap.has(field)) countMap.set(field, new Set());
              countMap.get(field)?.add(dc.chart_id);

              if (!dvMap.has(field)) dvMap.set(field, new Set());
              const set = dvMap.get(field);
              for (const row of rows) {
                const val = row[field];
                if (val !== null && val !== undefined && String(val) !== '') {
                  set?.add(String(val));
                }
              }
            }
          } catch {
            // skip failed charts
          }
        }),
      );

      const totalCharts = charts.length;
      const sortedCols = Array.from(colMap.values())
        .map((column) => {
          const coverage = countMap.get(column.name)?.size ?? 0;
          return {
            ...column,
            chartCoverage: coverage,
            datasetChartCount: totalCharts,
            sharedAcrossDataset: totalCharts > 0 && coverage === totalCharts,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      setColumns(sortedCols);
      setChartCount(new Map(Array.from(countMap.entries()).map(([k, s]) => [k, s.size])));
      const result: Record<string, string[]> = {};
      dvMap.forEach((set, field) => { result[field] = Array.from(set).sort(); });
      setDv(result);
    } catch {
      // non-critical
    } finally {
      setColumnsLoading(false);
    }
  }, [dashboardId, propColumns]);

  const fetchLinks = useCallback(async () => {
    try {
      const data = await dashboardApi.listPublicLinks(dashboardId);
      setLinks(data);
    } catch {
      toast.error('Failed to load public links');
    } finally {
      setLoading(false);
    }
  }, [dashboardId]);

  useEffect(() => {
    fetchLinks();
    fetchColumnData();
  }, [fetchLinks, fetchColumnData]);

  const activeColumns: ColumnInfo[] = (propColumns?.length ?? 0) > 0 ? propColumns ?? [] : columns;
  const activeChartCount: Map<string, number> = (propChartCount?.size ?? 0) > 0 ? propChartCount ?? new Map() : chartCount;
  const baseDistinctValues: Record<string, string[]> = Object.keys(propDistinctValues ?? {}).length > 0
    ? propDistinctValues ?? {}
    : dv;
  const activeDistinctValues = useFilterDistinctValues(activeColumns, formFilters, baseDistinctValues);
  const requiresPasswordValue = passwordEnabled && (
    view === 'create'
    || changePassword
    || !editingLink?.has_password
  );
  const isPasswordFormValid = !requiresPasswordValue || formPassword.trim().length > 0;
  const previewTheme = useMemo(() => buildPublicLinkTheme(formAppearance), [formAppearance]);
  const previewAppearance = previewTheme.appearance;
  const previewLinkName = formName.trim() || dashboardName;
  const previewTitle = previewAppearance.headline ?? previewLinkName;
  const configuredAccessFilterCount = formFilters.filter((filter) => (
    Array.isArray(filter.value)
      ? filter.value.length > 0
      : filter.value !== '' && filter.value !== null && filter.value !== undefined
  )).length;

  const resolvePasswordPayload = (): { password?: string; validationError?: string } => {
    const trimmedPassword = formPassword.trim();

    if (view === 'create') {
      if (!passwordEnabled) return {};
      if (!trimmedPassword) {
        return { validationError: 'Please enter a password or choose no password' };
      }
      return { password: trimmedPassword };
    }

    if (!editingLink) return {};

    if (!changePassword) {
      return {};
    }

    if (!passwordEnabled) {
      return editingLink.has_password ? { password: '' } : {};
    }

    if (!trimmedPassword) {
      return { validationError: 'Please enter a password' };
    }

    return { password: trimmedPassword };
  };

  const handleCreate = async () => {
    if (!formName.trim()) {
      toast.error('Please enter a name');
      return;
    }
    const { password, validationError } = resolvePasswordPayload();
    if (validationError) {
      toast.error(validationError);
      return;
    }
    setCreating(true);
    try {
      const link = await dashboardApi.createPublicLink(dashboardId, {
        name: formName.trim(),
        filters_config: formFilters,
        appearance_config: formAppearance,
        password,
      });
      setLinks((prev) => [link, ...prev]);
      resetForm();
      setView('list');
      toast.success('Public link created');
    } catch {
      toast.error('Failed to create link');
    } finally {
      setCreating(false);
    }
  };

  const handleUpdate = async () => {
    if (!editingLink) return;
    const { password, validationError } = resolvePasswordPayload();
    if (validationError) {
      toast.error(validationError);
      return;
    }
    setSaving(true);
    try {
      const passwordField: { password?: string } = {};
      if (password !== undefined) {
        passwordField.password = password;
      }
      const updated = await dashboardApi.updatePublicLink(dashboardId, editingLink.id, {
        name: formName.trim() || undefined,
        filters_config: formFilters,
        appearance_config: formAppearance,
        ...passwordField,
      });
      setLinks((prev) => prev.map((link) => (link.id === editingLink.id ? updated : link)));
      resetForm();
      setView('list');
      toast.success('Link updated');
    } catch {
      toast.error('Failed to update link');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (link: PublicLink, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const updated = await dashboardApi.updatePublicLink(dashboardId, link.id, {
        is_active: !link.is_active,
      });
      setLinks((prev) => prev.map((item) => (item.id === link.id ? updated : item)));
      toast.success(updated.is_active ? 'Link activated' : 'Link deactivated');
    } catch {
      toast.error('Failed to toggle link');
    }
  };

  const handleDelete = async (link: PublicLink, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await dashboardApi.deletePublicLink(dashboardId, link.id);
      setLinks((prev) => prev.filter((item) => item.id !== link.id));
      toast.success('Link deleted');
    } catch {
      toast.error('Failed to delete link');
    }
  };

  const openEdit = (link: PublicLink) => {
    setEditingLink(link);
    setFormName(link.name);
    setFormFilters((link.filters_config ?? []) as BaseFilter[]);
    setFormAppearance(normalizePublicLinkAppearance(link.appearance_config));
    setFormPassword('');
    setPasswordEnabled(link.has_password);
    setShowPassword(false);
    setChangePassword(false);
    setPreviewMode('public');
    setView('edit');
  };

  const openCreate = () => {
    resetForm();
    setView('create');
  };

  const resetForm = () => {
    setFormName('');
    setFormFilters([]);
    setFormAppearance(DEFAULT_APPEARANCE);
    setFormPassword('');
    setPasswordEnabled(false);
    setShowPassword(false);
    setChangePassword(false);
    setPreviewMode('public');
    setEditingLink(null);
  };

  const goBack = () => {
    resetForm();
    setView('list');
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    const d = new Date(dateStr);
    return d.toLocaleDateString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatFilterSummary = (filters: BaseFilter[] | null): string => {
    if (!filters?.length) return 'No filters, all data is visible.';
    const names = filters.map((filter) => getFilterDisplayLabel(filter)).join(', ');
    return `Filtered by ${names}`;
  };

  const renderConfiguratorPreview = () => {
    const showEmbedHeader = true;
    const previewUrl = previewMode === 'public'
      ? `${origin.replace(/\/$/, '')}/d/${editingLink?.token ?? 'preview-token'}`
      : `${origin.replace(/\/$/, '')}/embed/${editingLink?.token ?? 'preview-token'}`;

    return (
      <div className="space-y-5 lg:sticky lg:top-0">
        <div className="rounded-[28px] border border-slate-200/80 bg-white/92 p-5 shadow-[0_20px_60px_-48px_rgba(15,23,42,0.45)]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Preview before publish</p>
              <p className="mt-1 text-sm text-slate-500">Switch between the full public page and iframe embed surface.</p>
            </div>
            <div className="flex items-center rounded-full border border-slate-200 bg-slate-50 p-1">
              <button
                type="button"
                onClick={() => setPreviewMode('public')}
                className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition ${
                  previewMode === 'public'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <Globe className="h-3.5 w-3.5" />
                Public page
              </button>
              <button
                type="button"
                onClick={() => setPreviewMode('embed')}
                className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition ${
                  previewMode === 'embed'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <Code2 className="h-3.5 w-3.5" />
                Embed
              </button>
            </div>
          </div>

          <div className="mt-4 overflow-hidden rounded-[26px] border border-slate-200/80 bg-white shadow-[0_18px_40px_-30px_rgba(15,23,42,0.35)]">
            <div className="flex items-center gap-2 border-b border-slate-200/80 px-4 py-2.5" style={previewTheme.topBarStyle}>
              <span className="h-2.5 w-2.5 rounded-full bg-rose-300" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-300" />
              <span className="ml-2 min-w-0 truncate text-[11px] text-slate-500">{previewUrl}</span>
            </div>

            {previewMode === 'public' ? (
              <div className="space-y-4 p-4" style={previewTheme.pageStyle}>
                <div className="rounded-[22px] border p-3" style={previewTheme.panelStyle}>
                  <div className="flex flex-col gap-3">
                    <h4 className="truncate text-base font-semibold tracking-tight text-slate-950">{previewTitle}</h4>

                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-full border px-3 py-1 text-[11px] font-medium" style={previewTheme.accentPillStyle}>
                        Compact report rail
                      </span>
                      {previewAppearance.show_page_tabs && (
                        <span className="rounded-full border px-3 py-1 text-[11px] font-medium" style={previewTheme.neutralPillStyle}>
                          Page tabs visible
                        </span>
                      )}
                      <span className="rounded-full border px-3 py-1 text-[11px] font-medium" style={previewTheme.neutralPillStyle}>
                        {previewAppearance.allow_viewer_filters ? 'Viewer filters enabled' : 'Viewer filters hidden'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="rounded-[24px] border p-3" style={previewTheme.canvasFrameStyle}>
                  <div className="rounded-[20px] p-3" style={previewTheme.canvasInnerStyle}>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="h-28 rounded-[18px] border border-slate-200/80 bg-white/90" />
                      <div className="h-28 rounded-[18px] border border-slate-200/80 bg-white/90" />
                      <div className="h-36 rounded-[18px] border border-slate-200/80 bg-white/90 sm:col-span-2" />
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3 p-4" style={previewTheme.pageStyle}>
                <div className="overflow-hidden rounded-[22px] border" style={previewTheme.shellStyle}>
                  {showEmbedHeader ? (
                    <div className="border-b px-4 py-3" style={previewTheme.panelStyle}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h4 className="truncate text-base font-semibold text-slate-950">{previewTitle}</h4>
                        </div>
                        <span className="rounded-full border px-2.5 py-1 text-[10px] font-medium" style={previewTheme.neutralPillStyle}>
                          Compact viewer rail
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="border-b px-4 py-3 text-[11px] text-slate-500" style={previewTheme.panelStyle}>
                      Embed header hidden, report starts immediately with controls and canvas.
                    </div>
                  )}

                  <div className="border-b px-4 py-3" style={previewTheme.panelStyle}>
                    <div className="flex flex-wrap gap-2">
                      {previewAppearance.show_page_tabs && (
                        <span className="rounded-full border px-3 py-1 text-[11px] font-medium" style={previewTheme.accentPillStyle}>
                          Tabs
                        </span>
                      )}
                      <span className="rounded-full border px-3 py-1 text-[11px] font-medium" style={previewTheme.neutralPillStyle}>
                        {previewAppearance.allow_viewer_filters ? 'Interactive filters' : 'Locked view'}
                      </span>
                    </div>
                  </div>

                  <div className="p-3">
                    <div className="rounded-[20px] border p-3" style={previewTheme.canvasFrameStyle}>
                      <div className="rounded-[18px] p-3" style={previewTheme.canvasInnerStyle}>
                        <div className="grid gap-3">
                          <div className="h-24 rounded-[16px] border border-slate-200/80 bg-white/90" />
                          <div className="h-36 rounded-[16px] border border-slate-200/80 bg-white/90" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="rounded-[28px] border border-slate-200/80 bg-white/92 p-5 shadow-[0_20px_60px_-48px_rgba(15,23,42,0.45)]">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Publishing summary</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <div className="rounded-[20px] border border-slate-200 bg-slate-50/80 px-4 py-3">
              <p className="text-xs font-medium text-slate-500">Access scope</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">
                        {configuredAccessFilterCount > 0 ? `${configuredAccessFilterCount} access filter${configuredAccessFilterCount === 1 ? '' : 's'}` : 'All dashboard data'}
                      </p>
            </div>
            <div className="rounded-[20px] border border-slate-200 bg-slate-50/80 px-4 py-3">
              <p className="text-xs font-medium text-slate-500">Viewer controls</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">
                {previewAppearance.allow_viewer_filters ? 'Interactive' : 'Read-only without filter controls'}
              </p>
            </div>
            <div className="rounded-[20px] border border-slate-200 bg-slate-50/80 px-4 py-3">
              <p className="text-xs font-medium text-slate-500">Viewer layout</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">Compact control rail + full-width canvas</p>
            </div>
            <div className="rounded-[20px] border border-slate-200 bg-slate-50/80 px-4 py-3">
              <p className="text-xs font-medium text-slate-500">Security</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">{passwordEnabled ? 'Password required' : 'Open link access'}</p>
            </div>
          </div>
        </div>

        {view === 'edit' && editingLink?.is_active && (
          <div className="rounded-[28px] border border-slate-200/80 bg-white/92 p-5 shadow-[0_20px_60px_-48px_rgba(15,23,42,0.45)]">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Share outputs</p>
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2 rounded-[18px] border border-slate-200 bg-slate-50 px-3 py-2.5">
                <Link2 className="h-4 w-4 text-slate-400" />
                <span className="min-w-0 flex-1 truncate text-xs font-mono text-slate-500">
                  {origin.replace(/\/$/, '')}/d/{editingLink.token}
                </span>
                <button
                  onClick={() => {
                    copyText(`${origin.replace(/\/$/, '')}/d/${editingLink.token}`, () => {
                      setCopiedId(editingLink.id);
                      setTimeout(() => setCopiedId(null), 2000);
                    });
                  }}
                  className="rounded-lg p-1 text-slate-400 transition hover:bg-white hover:text-slate-700"
                >
                  {copiedId === editingLink.id ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>

              <div className="flex items-center gap-2 rounded-[18px] border border-slate-200 bg-slate-50 px-3 py-2.5">
                <Code2 className="h-4 w-4 text-slate-400" />
                <span className="min-w-0 flex-1 truncate text-xs font-mono text-slate-500">
                  {getEmbedUrl(editingLink)}
                </span>
                <button
                  onClick={() => {
                    copyText(getEmbedUrl(editingLink), () => {
                      setCopiedEmbedId(editingLink.id);
                      setTimeout(() => setCopiedEmbedId(null), 2000);
                    });
                  }}
                  className="rounded-lg p-1 text-slate-400 transition hover:bg-white hover:text-slate-700"
                >
                  {copiedEmbedId === editingLink.id ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </button>
                <button
                  onClick={() => {
                    copyText(getIframeSnippet(editingLink), () => {
                      setCopiedSnippetId(editingLink.id);
                      setTimeout(() => setCopiedSnippetId(null), 2000);
                    });
                  }}
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-500 transition hover:border-slate-300 hover:text-slate-700"
                >
                  {copiedSnippetId === editingLink.id ? 'Copied' : '</>'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderLinkCard = (link: PublicLink) => {
    const appearanceSummary = describePublicLinkAppearance(link.appearance_config);
    const theme = buildPublicLinkTheme(link.appearance_config);
    const appearance = theme.appearance;
    const previewTitle = appearance.headline ?? link.name;

    return (
      <div
        key={link.id}
        onClick={() => openEdit(link)}
        className="cursor-pointer rounded-[28px] border border-slate-200/80 bg-white/92 p-4 shadow-[0_20px_60px_-48px_rgba(15,23,42,0.45)] transition hover:border-slate-300 hover:shadow-[0_28px_80px_-52px_rgba(15,23,42,0.42)]"
      >
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr),320px]">
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-base font-semibold text-slate-900">{link.name}</h3>
                  {!link.is_active && (
                    <span className="rounded-full border border-slate-300 bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-500">
                      Inactive
                    </span>
                  )}
                  {link.has_password && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700">
                      <Lock className="h-3 w-3" />
                      Password
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-slate-500">{formatFilterSummary((link.filters_config ?? []) as BaseFilter[])}</p>
              </div>

              <div className="flex items-center gap-1">
                <button
                  onClick={(event) => handleToggleActive(link, event)}
                  className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                  title={link.is_active ? 'Deactivate' : 'Activate'}
                >
                  {link.is_active ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
                <button
                  onClick={(event) => handleDelete(link, event)}
                  className="rounded-xl p-2 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border px-3 py-1 text-xs font-medium" style={theme.accentPillStyle}>
                {appearanceSummary.presetLabel}
              </span>
              <span className="rounded-full border px-3 py-1 text-xs font-medium" style={theme.neutralPillStyle}>
                {appearanceSummary.accentLabel}
              </span>
              {!appearance.allow_viewer_filters && (
                <span className="rounded-full border px-3 py-1 text-xs font-medium" style={theme.neutralPillStyle}>
                  Filters hidden
                </span>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-[20px] border border-slate-200 bg-slate-50/80 px-3 py-3">
                <p className="flex items-center gap-1 text-xs font-medium text-slate-500">
                  <Eye className="h-3.5 w-3.5" />
                  Views
                </p>
                <p className="mt-2 text-lg font-semibold text-slate-900">{link.access_count}</p>
              </div>
              <div className="rounded-[20px] border border-slate-200 bg-slate-50/80 px-3 py-3">
                <p className="flex items-center gap-1 text-xs font-medium text-slate-500">
                  <Clock className="h-3.5 w-3.5" />
                  Last access
                </p>
                <p className="mt-2 text-sm font-medium text-slate-700">{formatDate(link.last_accessed_at)}</p>
              </div>
              <div className="rounded-[20px] border border-slate-200 bg-slate-50/80 px-3 py-3">
                <p className="text-xs font-medium text-slate-500">Created</p>
                <p className="mt-2 text-sm font-medium text-slate-700">{formatDate(link.created_at)}</p>
              </div>
            </div>

            {link.is_active && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 rounded-[18px] border border-slate-200 bg-slate-50 px-3 py-2.5">
                  <Link2 className="h-4 w-4 text-slate-400" />
                  <span className="min-w-0 flex-1 truncate text-xs font-mono text-slate-500">
                    {origin.replace(/\/$/, '')}/d/{link.token}
                  </span>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      copyText(`${origin.replace(/\/$/, '')}/d/${link.token}`, () => {
                        setCopiedId(link.id);
                        setTimeout(() => setCopiedId(null), 2000);
                      });
                    }}
                    className="rounded-lg p-1 text-slate-400 transition hover:bg-white hover:text-slate-700"
                    title="Copy page URL"
                  >
                    {copiedId === link.id ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>

                <div className="flex items-center gap-2 rounded-[18px] border border-slate-200 bg-slate-50 px-3 py-2.5">
                  <Code2 className="h-4 w-4 text-slate-400" />
                  <span className="min-w-0 flex-1 truncate text-xs font-mono text-slate-500">
                    {origin.replace(/\/$/, '')}/embed/{link.token}
                  </span>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      copyText(getEmbedUrl(link), () => {
                        setCopiedEmbedId(link.id);
                        setTimeout(() => setCopiedEmbedId(null), 2000);
                      });
                    }}
                    className="rounded-lg p-1 text-slate-400 transition hover:bg-white hover:text-slate-700"
                    title="Copy embed URL"
                  >
                    {copiedEmbedId === link.id ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                  </button>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      copyText(getIframeSnippet(link), () => {
                        setCopiedSnippetId(link.id);
                        setTimeout(() => setCopiedSnippetId(null), 2000);
                      });
                    }}
                    className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-500 transition hover:border-slate-300 hover:text-slate-700"
                    title="Copy iframe HTML snippet"
                  >
                    {copiedSnippetId === link.id ? 'Copied' : '</>'}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div
            className="overflow-hidden rounded-[26px] border"
            style={theme.heroStyle}
          >
            <div className="space-y-4 p-5">
              <h4 className="text-xl font-semibold tracking-tight text-slate-950">{previewTitle}</h4>
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full border px-3 py-1 text-[11px] font-medium" style={theme.accentPillStyle}>
                  Compact rail
                </span>
                {appearance.show_page_tabs && (
                  <span className="rounded-full border px-3 py-1 text-[11px] font-medium" style={theme.neutralPillStyle}>
                    Tabs on
                  </span>
                )}
                <span className="rounded-full border px-3 py-1 text-[11px] font-medium" style={theme.neutralPillStyle}>
                  {appearance.allow_viewer_filters ? 'Viewer filters on' : 'Viewer filters off'}
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="h-20 rounded-[18px] border border-slate-200/80 bg-white/90" />
                <div className="h-20 rounded-[18px] border border-slate-200/80 bg-white/90" />
                <div className="h-24 rounded-[18px] border border-slate-200/80 bg-white/90 sm:col-span-2" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-4 backdrop-blur-sm">
      <div className="flex h-[94vh] w-[min(1480px,100%)] flex-col overflow-hidden rounded-[32px] border border-slate-200/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(248,250,252,0.98))] shadow-[0_42px_140px_-58px_rgba(15,23,42,0.55)]">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200/80 px-6 py-5">
          <div className="flex items-center gap-3">
            {view !== 'list' && (
              <button
                onClick={goBack}
                className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-950 text-white shadow-lg shadow-slate-900/10">
              <Globe className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Share surface
              </p>
              <h2 className="text-lg font-semibold text-slate-950">
                {view === 'list' ? 'Public Links' : view === 'create' ? 'Create Public Link' : 'Edit Public Link'}
              </h2>
              <p className="text-sm text-slate-500">{dashboardName}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className={view === 'list' ? 'flex-1 overflow-y-auto' : 'flex-1 overflow-hidden'}>
          {view === 'list' && (
            <div className="p-6">
              <div className="grid gap-6 xl:grid-cols-[320px,minmax(0,1fr)]">
                <div className="space-y-4">
                  <div className="rounded-[28px] border border-slate-200/80 bg-white/90 p-5 shadow-[0_20px_60px_-48px_rgba(15,23,42,0.45)]">
                    <div className="flex items-center gap-2 text-slate-900">
                      <Sparkles className="h-4 w-4 text-sky-600" />
                      <h3 className="text-sm font-semibold">Viewer presentation</h3>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-500">
                      Each link now keeps only the settings people actually notice: title, tone, and whether tabs or viewer filters are available.
                      The shared viewer itself stays compact and fixed so the report content gets maximum space.
                    </p>
                    <button
                      onClick={openCreate}
                      className="mt-5 flex w-full items-center justify-center gap-2 rounded-[20px] bg-blue-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-blue-700"
                    >
                      <Plus className="h-4 w-4" />
                      Create new public link
                    </button>
                  </div>

                  <div className="rounded-[28px] border border-slate-200/80 bg-white/90 p-5 shadow-[0_20px_60px_-48px_rgba(15,23,42,0.45)]">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Tips</p>
                    <div className="mt-3 space-y-3 text-sm text-slate-500">
                      <p>Use the headline to rename the same dashboard for different audiences without cloning it.</p>
                      <p>Keep tabs on only when the dashboard really has multiple pages worth switching between.</p>
                      <p>Turn viewer filters off for locked executive views, and keep them on when viewers need light exploration.</p>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  {loading ? (
                    <div className="flex items-center justify-center rounded-[28px] border border-slate-200 bg-white/90 px-4 py-16 text-sm text-slate-500">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Loading public links...
                    </div>
                  ) : links.length === 0 ? (
                    <div className="rounded-[28px] border border-dashed border-slate-300 bg-white/85 px-6 py-16 text-center">
                      <Globe className="mx-auto h-10 w-10 text-slate-300" />
                      <p className="mt-4 text-base font-semibold text-slate-700">No public links yet</p>
                      <p className="mt-2 text-sm text-slate-500">
                        Create a link to publish this dashboard with its own filters and presentation settings.
                      </p>
                    </div>
                  ) : (
                    links.map(renderLinkCard)
                  )}
                </div>
              </div>
            </div>
          )}

          {(view === 'create' || view === 'edit') && (
            <div className="flex h-full flex-col p-6">
              <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,1fr),520px]">
                <div className="min-h-0 space-y-5 overflow-y-auto pr-1 lg:pr-3">
                  <div className="rounded-[28px] border border-slate-200/80 bg-white/90 p-5 shadow-[0_20px_60px_-48px_rgba(15,23,42,0.45)]">
                    <div className="flex items-center gap-2 text-slate-900">
                      <Globe className="h-4 w-4 text-sky-600" />
                      <h3 className="text-sm font-semibold">Link identity</h3>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-500">
                      Name the audience-facing link first. This name is also the default fallback title if you leave the presentation headline empty.
                    </p>
                    <label className="mb-2 mt-4 block text-sm font-medium text-slate-700">Link name</label>
                    <input
                      type="text"
                      value={formName}
                      onChange={(event) => setFormName(event.target.value)}
                      placeholder='e.g. "CEO View", "Sales Team", "Quarterly Briefing"'
                      className="w-full rounded-2xl border border-slate-300 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100"
                      autoFocus
                    />
                    <p className="mt-2 text-sm leading-6 text-slate-500">
                      Use a descriptive name so you can distinguish audience-specific links later.
                    </p>
                  </div>

                  <PublicLinkAppearanceEditor
                    value={formAppearance}
                    dashboardName={dashboardName}
                    onChange={setFormAppearance}
                  />

                  <div className="rounded-[28px] border border-slate-200/80 bg-white/90 p-5 shadow-[0_20px_60px_-48px_rgba(15,23,42,0.45)]">
                    <div className="flex items-center gap-2 text-slate-900">
                      <Filter className="h-4 w-4 text-sky-600" />
                      <h3 className="text-sm font-semibold">Access filters</h3>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-500">
                      Restrict the data available through this link. Viewer filters on the public page operate on top of these rules.
                    </p>

                    <div className="mt-4">
                      {columnsLoading ? (
                        <div className="flex items-center justify-center rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-10 text-sm text-slate-500">
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Loading available columns...
                        </div>
                      ) : activeColumns.length > 0 ? (
                        <div className="rounded-[22px] border border-slate-200 bg-slate-50/70 p-3">
                          <DashboardFilterBar
                            columns={activeColumns}
                            columnChartCount={activeChartCount}
                            distinctValues={activeDistinctValues}
                            filters={formFilters}
                            onFiltersChange={setFormFilters}
                          />
                          {formFilters.length === 0 && (
                            <p className="px-2 py-2 text-center text-xs text-slate-500">
                              No filters added. This link can access all dashboard data.
                            </p>
                          )}
                        </div>
                      ) : (
                        <div className="rounded-[20px] border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center">
                          <p className="text-sm font-medium text-slate-700">No columns available</p>
                          <p className="mt-1 text-xs text-slate-500">
                            Add charts to the dashboard first, then create public filters here.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-[28px] border border-slate-200/80 bg-white/90 p-5 shadow-[0_20px_60px_-48px_rgba(15,23,42,0.45)]">
                    <div className="flex items-center gap-2 text-slate-900">
                      <Lock className="h-4 w-4 text-amber-500" />
                      <h3 className="text-sm font-semibold">Password protection</h3>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-500">
                      Public and embed links do not require an AppBI account. Add a password only if viewers need a second gate.
                    </p>

                    {view === 'edit' && editingLink?.has_password && !changePassword ? (
                      <div className="mt-4 flex items-center justify-between gap-3 rounded-[20px] border border-amber-200 bg-amber-50 px-4 py-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-amber-900">Password is set</p>
                          <p className="text-xs text-amber-700">Sessions expire after 2 hours.</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => {
                              setChangePassword(true);
                              setPasswordEnabled(true);
                              setFormPassword('');
                            }}
                            className="text-xs font-medium text-slate-700 hover:text-slate-900"
                          >
                            Change
                          </button>
                          <button
                            onClick={() => {
                              setChangePassword(true);
                              setPasswordEnabled(false);
                              setFormPassword('');
                            }}
                            className="text-xs font-medium text-rose-600 hover:text-rose-700"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-4 space-y-3">
                        <div className="grid gap-2 sm:grid-cols-2">
                          <button
                            type="button"
                            onClick={() => {
                              setPasswordEnabled(false);
                              setFormPassword('');
                              if (view === 'edit' && editingLink?.has_password) {
                                setChangePassword(true);
                              } else {
                                setChangePassword(false);
                              }
                            }}
                            className={`rounded-[20px] border px-4 py-3 text-left transition ${
                              !passwordEnabled
                                ? 'border-blue-600 bg-blue-600 text-white shadow-lg shadow-blue-600/15'
                                : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'
                            }`}
                          >
                            <p className="text-sm font-semibold">No password</p>
                            <p className={`mt-1 text-xs leading-5 ${!passwordEnabled ? 'text-slate-300' : 'text-slate-500'}`}>
                              Open immediately with the public or embed link.
                            </p>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setPasswordEnabled(true);
                              if (view === 'edit') {
                                setChangePassword(true);
                              }
                            }}
                            className={`rounded-[20px] border px-4 py-3 text-left transition ${
                              passwordEnabled
                                ? 'border-blue-600 bg-blue-600 text-white shadow-lg shadow-blue-600/15'
                                : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'
                            }`}
                          >
                            <p className="text-sm font-semibold">Require password</p>
                            <p className={`mt-1 text-xs leading-5 ${passwordEnabled ? 'text-slate-300' : 'text-slate-500'}`}>
                              Viewers only need the link password, not an AppBI login.
                            </p>
                          </button>
                        </div>

                        {passwordEnabled && (
                          <div className="relative">
                            <input
                              type={showPassword ? 'text' : 'password'}
                              value={formPassword}
                              onChange={(event) => setFormPassword(event.target.value)}
                              placeholder="Enter password"
                              className="w-full rounded-2xl border border-slate-300 px-3 py-2.5 pr-10 text-sm text-slate-700 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100"
                            />
                            <button
                              type="button"
                              onClick={() => setShowPassword((current) => !current)}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition hover:text-slate-700"
                            >
                              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          </div>
                        )}

                        {view === 'edit' && changePassword && (
                          <button
                            onClick={() => {
                              setChangePassword(false);
                              setFormPassword('');
                              setPasswordEnabled(Boolean(editingLink?.has_password));
                            }}
                            className="text-xs font-medium text-slate-500 hover:text-slate-700"
                          >
                            Cancel password change
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="min-h-0 overflow-y-auto pl-0 lg:pl-1">
                  {renderConfiguratorPreview()}
                </div>
              </div>

              <div className="mt-6 flex items-center gap-3 border-t border-slate-200/80 pt-5">
                {view === 'create' ? (
                  <button
                    onClick={handleCreate}
                    disabled={creating || !formName.trim() || !isPasswordFormValid}
                    className="inline-flex items-center gap-2 rounded-[18px] bg-blue-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
                  >
                    {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    {creating ? 'Creating...' : 'Create link'}
                  </button>
                ) : (
                  <button
                    onClick={handleUpdate}
                    disabled={saving || !formName.trim() || !isPasswordFormValid}
                    className="inline-flex items-center gap-2 rounded-[18px] bg-blue-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    {saving ? 'Saving...' : 'Save changes'}
                  </button>
                )}
                <button
                  onClick={goBack}
                  className="rounded-[18px] px-4 py-3 text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {view === 'list' && (
          <div className="border-t border-slate-200/80 px-6 py-4">
            <p className="text-center text-xs text-slate-500">
              Click any link card to edit its filters, password, or presentation. Deactivated links return 404.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
