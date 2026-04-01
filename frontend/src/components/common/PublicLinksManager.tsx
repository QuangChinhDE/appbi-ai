'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  X, Link2, Copy, Check, Trash2, Globe, Filter, Plus,
  Eye, EyeOff, Clock, Loader2, ArrowLeft,
} from 'lucide-react';
import { dashboardApi, PublicLink } from '@/lib/api/dashboards';
import { chartApi } from '@/lib/api/charts';
import { DashboardFilterBar } from '@/components/dashboards/DashboardFilterBar';
import { toast } from 'sonner';
import type { BaseFilter, ColumnInfo } from '@/lib/filters';
import { inferColumnTypeFromData } from '@/lib/filters';

interface PublicLinksManagerProps {
  dashboardId: number;
  dashboardName: string;
  availableColumns?: ColumnInfo[];
  columnChartCount?: Map<string, number>;
  distinctValues?: Record<string, string[]>;
  onClose: () => void;
}

type ModalView = 'list' | 'create' | 'edit';

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

  // Column data (self-fetch if not provided via props)
  const [columns, setColumns] = useState<ColumnInfo[]>(propColumns ?? []);
  const [chartCount, setChartCount] = useState<Map<string, number>>(propChartCount ?? new Map());
  const [dv, setDv] = useState<Record<string, string[]>>(propDistinctValues ?? {});
  const [columnsLoading, setColumnsLoading] = useState(false);

  // Modal view state
  const [view, setView] = useState<ModalView>('list');
  const [editingLink, setEditingLink] = useState<PublicLink | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formFilters, setFormFilters] = useState<BaseFilter[]>([]);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const [copiedId, setCopiedId] = useState<number | null>(null);

  // ── Fetch column data from charts if not provided ──
  const fetchColumnData = useCallback(async () => {
    if ((propColumns?.length ?? 0) > 0) return; // already have data from props
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
            const resp = await chartApi.getData(dc.chart_id);
            const rows = resp?.data ?? [];
            if (!rows.length) return;

            const fields = Object.keys(rows[0]);
            for (const field of fields) {
              if (!colMap.has(field)) {
                colMap.set(field, { name: field, type: inferColumnTypeFromData(field, rows) });
              }
              if (!countMap.has(field)) countMap.set(field, new Set());
              countMap.get(field)!.add(dc.chart_id);

              if (!dvMap.has(field)) dvMap.set(field, new Set());
              const set = dvMap.get(field)!;
              for (const row of rows) {
                const val = row[field];
                if (val !== null && val !== undefined && String(val) !== '') {
                  set.add(String(val));
                }
              }
            }
          } catch { /* skip failed charts */ }
        }),
      );

      const sortedCols = Array.from(colMap.values()).sort((a, b) => a.name.localeCompare(b.name));
      setColumns(sortedCols);
      setChartCount(new Map(Array.from(countMap.entries()).map(([k, s]) => [k, s.size])));
      const result: Record<string, string[]> = {};
      dvMap.forEach((set, field) => { result[field] = Array.from(set).sort(); });
      setDv(result);
    } catch {
      // non-critical — filters just won't be available
    } finally {
      setColumnsLoading(false);
    }
  }, [dashboardId, propColumns]);

  // ── Fetch links ──
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

  useEffect(() => { fetchLinks(); fetchColumnData(); }, [fetchLinks, fetchColumnData]);

  // ── Use props when available, else use self-fetched ──
  const activeColumns = (propColumns?.length ?? 0) > 0 ? propColumns! : columns;
  const activeChartCount = (propChartCount?.size ?? 0) > 0 ? propChartCount! : chartCount;
  const activeDistinctValues = Object.keys(propDistinctValues ?? {}).length > 0 ? propDistinctValues! : dv;

  // ── Handlers ──
  const handleCreate = async () => {
    if (!formName.trim()) { toast.error('Please enter a name'); return; }
    setCreating(true);
    try {
      const link = await dashboardApi.createPublicLink(dashboardId, {
        name: formName.trim(),
        filters_config: formFilters,
      });
      setLinks(prev => [link, ...prev]);
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
    setSaving(true);
    try {
      const updated = await dashboardApi.updatePublicLink(dashboardId, editingLink.id, {
        name: formName.trim() || undefined,
        filters_config: formFilters,
      });
      setLinks(prev => prev.map(l => l.id === editingLink.id ? updated : l));
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
      setLinks(prev => prev.map(l => l.id === link.id ? updated : l));
      toast.success(updated.is_active ? 'Link activated' : 'Link deactivated');
    } catch {
      toast.error('Failed to toggle link');
    }
  };

  const handleDelete = async (link: PublicLink, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await dashboardApi.deletePublicLink(dashboardId, link.id);
      setLinks(prev => prev.filter(l => l.id !== link.id));
      toast.success('Link deleted');
    } catch {
      toast.error('Failed to delete link');
    }
  };

  const handleCopy = (link: PublicLink, e: React.MouseEvent) => {
    e.stopPropagation();
    const url = `${origin.replace(/\/$/, '')}/d/${link.token}`;
    navigator.clipboard.writeText(url);
    setCopiedId(link.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const openEdit = (link: PublicLink) => {
    setEditingLink(link);
    setFormName(link.name);
    setFormFilters((link.filters_config ?? []) as BaseFilter[]);
    setView('edit');
  };

  const openCreate = () => {
    resetForm();
    setView('create');
  };

  const resetForm = () => {
    setFormName('');
    setFormFilters([]);
    setEditingLink(null);
  };

  const goBack = () => {
    resetForm();
    setView('list');
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    const d = new Date(dateStr);
    return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const formatFilterSummary = (filters: any[] | null): string => {
    if (!filters?.length) return 'No filters — shows all data';
    const names = filters.map((f: any) => f.field).join(', ');
    return `Filtered by: ${names}`;
  };

  // ── Render ──
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="mx-4 w-[720px] h-[80vh] flex flex-col rounded-xl bg-white shadow-xl">
        {/* ═══ Header ═══ */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4 flex-shrink-0">
          <div className="flex items-center gap-3">
            {view !== 'list' && (
              <button onClick={goBack} className="p-1 -ml-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100">
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <Globe className="h-5 w-5 text-blue-600" />
            <div>
              <h2 className="text-base font-semibold text-gray-900">
                {view === 'list' ? 'Public Links' : view === 'create' ? 'Create Public Link' : 'Edit Public Link'}
              </h2>
              <p className="text-xs text-gray-400">{dashboardName}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* ═══ Body ═══ */}
        <div className="flex-1 overflow-y-auto">

          {/* ── LIST VIEW ── */}
          {view === 'list' && (
            <div className="p-6 space-y-4">
              {/* Create button */}
              <button
                onClick={openCreate}
                className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 px-4 py-3 text-sm font-medium text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors"
              >
                <Plus className="h-4 w-4" />
                Create new public link
              </button>

              {/* Links list */}
              {loading ? (
                <div className="flex items-center justify-center py-12 text-sm text-gray-400 gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
              ) : links.length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-10 text-center">
                  <Globe className="mx-auto mb-3 h-10 w-10 text-gray-300" />
                  <p className="text-sm font-medium text-gray-500">No public links yet</p>
                  <p className="mt-1 text-xs text-gray-400">Create a link to share this dashboard externally.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {links.map(link => (
                    <div
                      key={link.id}
                      onClick={() => openEdit(link)}
                      className={`rounded-lg border cursor-pointer transition-all hover:shadow-sm ${
                        link.is_active
                          ? 'border-gray-200 bg-white hover:border-blue-300'
                          : 'border-gray-200 bg-gray-50 opacity-60 hover:opacity-80'
                      }`}
                    >
                      <div className="px-4 py-3">
                        {/* Row 1: name + badges + actions */}
                        <div className="flex items-center gap-2">
                          <div className="flex-1 min-w-0 flex items-center gap-2">
                            <h3 className="text-sm font-semibold text-gray-800 truncate">{link.name}</h3>
                            {!link.is_active && (
                              <span className="px-1.5 py-0.5 bg-gray-200 text-gray-600 text-[10px] rounded-full flex-shrink-0">
                                Inactive
                              </span>
                            )}
                            {(link.filters_config?.length ?? 0) > 0 && (
                              <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-[10px] rounded-full flex-shrink-0">
                                <Filter className="w-3 h-3 inline mr-0.5" />
                                {link.filters_config!.length}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-0.5 flex-shrink-0">
                            <button
                              onClick={e => handleCopy(link, e)}
                              disabled={!link.is_active}
                              className="p-1.5 text-gray-400 hover:text-blue-600 disabled:opacity-30 rounded hover:bg-gray-100"
                              title="Copy link"
                            >
                              {copiedId === link.id ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                            </button>
                            <button
                              onClick={e => handleToggleActive(link, e)}
                              className={`p-1.5 rounded hover:bg-gray-100 ${link.is_active ? 'text-gray-400 hover:text-amber-600' : 'text-gray-400 hover:text-green-600'}`}
                              title={link.is_active ? 'Deactivate' : 'Activate'}
                            >
                              {link.is_active ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </button>
                            <button
                              onClick={e => handleDelete(link, e)}
                              className="p-1.5 text-gray-400 hover:text-red-600 rounded hover:bg-gray-100"
                              title="Delete"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>

                        {/* Row 2: filter summary */}
                        <p className="text-xs text-gray-400 mt-1 truncate">
                          {formatFilterSummary(link.filters_config)}
                        </p>

                        {/* Row 3: stats */}
                        <div className="flex items-center gap-4 mt-2 text-[11px] text-gray-400">
                          <span className="flex items-center gap-1">
                            <Eye className="w-3 h-3" />
                            {link.access_count} view{link.access_count !== 1 ? 's' : ''}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            Last: {formatDate(link.last_accessed_at)}
                          </span>
                          <span>Created: {formatDate(link.created_at)}</span>
                        </div>

                        {/* Row 4: URL */}
                        {link.is_active && (
                          <div className="flex items-center gap-2 mt-2 px-2.5 py-1 rounded border border-gray-100 bg-gray-50">
                            <Link2 className="h-3 w-3 flex-shrink-0 text-gray-400" />
                            <span className="flex-1 truncate text-[11px] text-gray-500 font-mono">
                              {origin.replace(/\/$/, '')}/d/{link.token}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── CREATE / EDIT VIEW ── */}
          {(view === 'create' || view === 'edit') && (
            <div className="p-6 space-y-5">
              {/* Name input */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Link name</label>
                <input
                  type="text"
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder='e.g. "CEO View", "Sales Team", "Q1 Report"'
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-400 focus:border-blue-400 outline-none"
                  autoFocus
                />
              </div>

              {/* Filters section */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Filter className="w-4 h-4 text-blue-500" />
                  <h3 className="text-sm font-medium text-gray-700">Filters</h3>
                  <span className="text-xs text-gray-400">
                    — restrict what data viewers can see through this link
                  </span>
                </div>

                {columnsLoading ? (
                  <div className="flex items-center gap-2 py-6 justify-center text-sm text-gray-400">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading available columns…
                  </div>
                ) : activeColumns.length > 0 ? (
                  <div className="rounded-lg border border-gray-200 bg-gray-50/50 p-3">
                    <DashboardFilterBar
                      columns={activeColumns}
                      columnChartCount={activeChartCount}
                      distinctValues={activeDistinctValues}
                      filters={formFilters}
                      onFiltersChange={setFormFilters}
                    />
                    {formFilters.length === 0 && (
                      <p className="text-xs text-gray-400 mt-2 text-center py-2">
                        No filters added — this link will show all dashboard data.
                        Click &quot;Add Filter&quot; above to restrict the view.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center">
                    <p className="text-sm text-gray-500">No columns available</p>
                    <p className="text-xs text-gray-400 mt-1">
                      Add charts to the dashboard first, then create public links with filters.
                    </p>
                  </div>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-3 pt-2 border-t border-gray-100">
                {view === 'create' ? (
                  <button
                    onClick={handleCreate}
                    disabled={creating || !formName.trim()}
                    className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    {creating ? 'Creating…' : 'Create link'}
                  </button>
                ) : (
                  <button
                    onClick={handleUpdate}
                    disabled={saving || !formName.trim()}
                    className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    {saving ? 'Saving…' : 'Save changes'}
                  </button>
                )}
                <button
                  onClick={goBack}
                  className="text-sm text-gray-500 hover:text-gray-700 px-4 py-2.5 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ═══ Footer ═══ */}
        {view === 'list' && (
          <div className="flex-shrink-0 border-t border-gray-200 px-6 py-3">
            <p className="text-xs text-gray-400 text-center">
              Click a link to edit its name and filters. Deactivated links return 404.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
