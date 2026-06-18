'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Link2, Copy, Check, Trash2, Globe, Filter, Plus, X,
  Eye, EyeOff, Clock, Loader2, ArrowLeft, Lock, Code2, Sparkles,
} from 'lucide-react';
import { dashboardApi, PublicLink } from '@/lib/api/dashboards';
import { chartApi } from '@/lib/api/charts';
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
import { AppModalShell } from '@/components/common/AppModalShell';
import { Button, IconButton } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';

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

  // Phase-E THẬT (PBI-parity rework) — inherited entries from the
  // owning dashboard. Each one renders a 3-radio Show / Lock-with-value
  // / Hide row. See docs/filter-semantics.md §2.3 and the wireframe
  // confirmed by the user (Slicer #1 + Filter #2 sections).
  const [inheritedSlicers, setInheritedSlicers] = useState<BaseFilter[]>([]);
  const [inheritedFilters, setInheritedFilters] = useState<BaseFilter[]>([]);
  // Per-inherited-entry action; keyed by stable fieldKey or field.
  // `action: 'show'` → don't add anything to link.filters_config
  //                    (viewer sees the entry exactly as the dashboard
  //                    set it).
  // `action: 'lock'` → write {field, operator, value, hidden: false}
  //                    using the override value the author entered.
  // `action: 'hide'` → write {field, hidden: true} so the BE merger
  //                    drops the field entirely.
  type LinkEntryAction = { action: 'show' | 'lock' | 'hide'; value?: any };
  const [linkActions, setLinkActions] = useState<Record<string, LinkEntryAction>>({});

  const [view, setView] = useState<ModalView>('list');
  const [editingLink, setEditingLink] = useState<PublicLink | null>(null);

  const [formName, setFormName] = useState('');
  // Unified-table rework (2026-06-18) — the link's filter UI is now ONE
  // table: every shareable field is a row with a Show / Lock / Hide
  // choice (state in `linkActions`). `extraRows` holds fields that are
  // NOT inherited dashboard slicers/filters but the author chose to gate
  // anyway (replaces the old "Access filters" escape-hatch + "Hidden
  // fields" sections, which overlapped and confused authors). Each is a
  // BaseFilter carrying field/semanticField/datasetId identity.
  const [extraRows, setExtraRows] = useState<BaseFilter[]>([]);
  const [formAppearance, setFormAppearance] = useState<PublicLinkAppearanceConfig>(DEFAULT_APPEARANCE);
  const [formPassword, setFormPassword] = useState('');
  const [passwordEnabled, setPasswordEnabled] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [changePassword, setChangePassword] = useState(false);
  const [previewMode, setPreviewMode] = useState<'public' | 'embed'>('public');
  // Create/Edit form is split into 3 intent-based tabs so the modal isn't
  // one long scroll: appearance (look/behaviour), data (link filters),
  // security (password + share URLs). The preview panel stays on the right.
  const [formTab, setFormTab] = useState<'appearance' | 'data' | 'security'>('appearance');

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
    // Always refresh inherited entries from BE even when the parent
    // pre-supplied columns — slicers_config + filters_config travel
    // on the dashboard object, not on the column list.
    try {
      const dash = await dashboardApi.getById(dashboardId);
      setInheritedSlicers(Array.isArray((dash as any).slicers_config)
        ? ((dash as any).slicers_config as BaseFilter[])
        : []);
      setInheritedFilters(Array.isArray((dash as any).filters_config)
        ? ((dash as any).filters_config as BaseFilter[])
        : []);
    } catch {
      // non-critical — section just renders empty
    }

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
  const baseDistinctValues: Record<string, string[]> = Object.keys(propDistinctValues ?? {}).length > 0
    ? propDistinctValues ?? {}
    : dv;
  const { distinctValues: activeDistinctValues } =
    useFilterDistinctValues(activeColumns, extraRows, baseDistinctValues);

  // ── Unified link-filter table ─────────────────────────────────────
  // Stable identity for a row, mirroring the BE dedupe shape
  // (semanticField first, then bare field, then datasetId).
  const entryKey = useCallback((entry: { field: string; semanticField?: string; datasetId?: number }): string => {
    const sem = (entry.semanticField || '').toLowerCase();
    const ds = entry.datasetId ?? '';
    return sem ? `${ds}|${sem}` : `${ds}|${entry.field.toLowerCase()}`;
  }, []);

  // Source classification + the default action a row starts on.
  type LinkRowSource = 'slicer' | 'filter' | 'extra';
  interface LinkFieldRow {
    key: string;
    field: string;
    semanticField?: string;
    datasetId?: number;
    label: string;
    value?: any;
    source: LinkRowSource;
    dashboardMode?: string; // for filter-pane rows: the dashboard publicMode
  }
  const defaultActionForRow = useCallback((row: LinkFieldRow): LinkEntryAction['action'] => {
    if (row.source === 'extra') return 'lock';
    if (row.source === 'slicer') return 'show';
    // filter-pane row inherits the dashboard's publicMode intent
    const mode = (row.dashboardMode || 'visible').toLowerCase();
    return mode === 'hidden' ? 'hide' : mode === 'locked' ? 'lock' : 'show';
  }, []);

  // Build the single list of rows: inherited slicers (#1) + inherited
  // filter-pane entries (#2) + author-added extra gates (#3). De-duped
  // by field key; an inherited row wins over an extra one on the same
  // field so the author never sees the same field twice.
  const unifiedRows = useMemo<LinkFieldRow[]>(() => {
    const rows: LinkFieldRow[] = [];
    const seen = new Set<string>();
    const push = (entry: BaseFilter, source: LinkRowSource) => {
      const key = entryKey(entry as any);
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({
        key,
        field: entry.field,
        semanticField: entry.semanticField,
        datasetId: entry.datasetId,
        label: (entry as any).label || entry.semanticField || entry.field,
        value: entry.value,
        source,
        dashboardMode: (entry as any).publicMode,
      });
    };
    for (const s of inheritedSlicers) push(s, 'slicer');
    for (const f of inheritedFilters) push(f, 'filter');
    for (const x of extraRows) push(x, 'extra');
    return rows;
  }, [inheritedSlicers, inheritedFilters, extraRows, entryKey]);

  // The action actually in effect for a row (explicit choice or default).
  const effectiveAction = useCallback((row: LinkFieldRow): LinkEntryAction['action'] =>
    linkActions[row.key]?.action ?? defaultActionForRow(row),
  [linkActions, defaultActionForRow]);

  // Columns the author can still ADD as an extra gate (not already a row).
  const addableColumns = useMemo(() => {
    const present = new Set(unifiedRows.map((r) => r.key));
    return activeColumns.filter((c) => !present.has(entryKey({
      field: c.name, semanticField: c.semanticField, datasetId: c.datasetId,
    })));
  }, [activeColumns, unifiedRows, entryKey]);

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
  // How many fields this link actually gates (lock or hide), for the
  // summary chip. 'show' rows inherit the dashboard and don't count.
  const configuredAccessFilterCount = useMemo(
    () => unifiedRows.filter((row) => effectiveAction(row) !== 'show').length,
    [unifiedRows, effectiveAction],
  );

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
        // Unified table → one entry per gated field (see buildLinkFiltersPayload).
        filters_config: buildLinkFiltersPayload(linkActions, unifiedRows),
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
        // Unified table → one entry per gated field (see buildLinkFiltersPayload).
        filters_config: buildLinkFiltersPayload(linkActions, unifiedRows),
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
    // Parse the link's filters_config into per-row actions + any extra
    // (non-inherited) rows so the unified table re-renders the saved state.
    {
      const raw = (link.filters_config ?? []) as any[];
      const parsed = parseExistingLinkFilters(
        raw,
        [...inheritedSlicers, ...inheritedFilters],
      );
      setLinkActions(parsed.actions);
      setExtraRows(parsed.extra);
    }
    setFormAppearance({
      ...normalizePublicLinkAppearance(link.appearance_config),
      // normalizePublicLinkAppearance strips AI bot fields (they are not in
      // NormalizedPublicLinkAppearanceConfig). Restore them from the raw config.
      ai_bot_enabled: link.appearance_config?.ai_bot_enabled,
      ai_bot_provider: link.appearance_config?.ai_bot_provider,
      ai_bot_model: link.appearance_config?.ai_bot_model,
      ai_bot_normal_cost_cap_usd: link.appearance_config?.ai_bot_normal_cost_cap_usd,
      ai_bot_thinking_cost_cap_usd: link.appearance_config?.ai_bot_thinking_cost_cap_usd,
      ai_bot_report_context_note: link.appearance_config?.ai_bot_report_context_note,
      // ai_bot_key is stripped by backend response (security). Use
      // ai_bot_key_configured to show "key is set" indicator in the editor.
      ai_bot_key: undefined,
      ai_bot_key_configured: link.appearance_config?.ai_bot_key_configured,
    });
    setFormPassword('');
    setPasswordEnabled(link.has_password);
    setShowPassword(false);
    setChangePassword(false);
    setPreviewMode('public');
    setFormTab('appearance');
    setView('edit');
  };

  const openCreate = () => {
    resetForm();
    setView('create');
  };

  const resetForm = () => {
    setFormName('');
    setExtraRows([]);
    setLinkActions({});
    setFormAppearance(DEFAULT_APPEARANCE);
    setFormPassword('');
    setPasswordEnabled(false);
    setShowPassword(false);
    setChangePassword(false);
    setPreviewMode('public');
    setFormTab('appearance');
    setEditingLink(null);
  };

  // Serialize the unified rows + their per-row actions into the BE wire
  // shape for `DashboardPublicLink.filters_config`. One row → at most one
  // entry: 'show' inherits (no entry), 'hide' → {…, hidden:true}, 'lock'
  // → a value-bearing entry. See docs/filter-semantics.md §2.3.
  const buildLinkFiltersPayload = (
    actions: Record<string, LinkEntryAction>,
    rows: LinkFieldRow[],
  ): any[] => {
    const out: any[] = [];
    for (const row of rows) {
      const action = actions[row.key]?.action ?? defaultActionForRow(row);
      if (action === 'show') continue;
      if (action === 'hide') {
        out.push({ field: row.field, semanticField: row.semanticField, datasetId: row.datasetId, hidden: true });
        continue;
      }
      // 'lock' — use the author's override value, falling back to the
      // dashboard's saved value. Align operator with value shape: an
      // array value forces in/not_in (a scalar `eq` over a list emits
      // invalid SQL `WHERE field = ('A','B')`).
      const overrideValue = actions[row.key]?.value !== undefined ? actions[row.key]?.value : row.value;
      const inheritedOp = (row as any).operator || 'in';
      const effectiveOp = Array.isArray(overrideValue)
        ? (inheritedOp === 'not_in' ? 'not_in' : 'in')
        : inheritedOp;
      out.push({
        field: row.field,
        semanticField: row.semanticField,
        datasetId: row.datasetId,
        operator: effectiveOp,
        value: overrideValue,
      });
    }
    return out;
  };

  // Parse an existing link.filters_config back into per-row actions +
  // the set of extra (non-inherited) rows that must still render. An
  // entry that matches an inherited slicer/filter becomes an action on
  // that row; anything else becomes an extra row carrying its identity.
  const parseExistingLinkFilters = (
    raw: any[],
    inherited: BaseFilter[],
  ): { actions: Record<string, LinkEntryAction>; extra: BaseFilter[] } => {
    const inheritedByKey = new Map<string, BaseFilter>();
    for (const e of inherited) inheritedByKey.set(entryKey(e), e);
    const actions: Record<string, LinkEntryAction> = {};
    const extra: BaseFilter[] = [];
    for (const entry of raw || []) {
      if (!entry || typeof entry !== 'object') continue;
      const key = entryKey(entry);
      const isHidden = entry.hidden === true;
      actions[key] = isHidden ? { action: 'hide' } : { action: 'lock', value: entry.value };
      if (!inheritedByKey.has(key)) {
        // Non-inherited gate — keep it as a visible row so the author
        // can see and change it (was the old "Access filters" / "Hidden
        // fields" leftover).
        extra.push(entry as BaseFilter);
      }
    }
    return { actions, extra };
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
      <div className="space-y-4 lg:sticky lg:top-0">
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-tiny font-strong uppercase tracking-[0.14em] text-text-quaternary">Preview before publish</p>
              <p className="mt-1 text-caption text-text-tertiary">Switch between the full public page and iframe embed surface.</p>
            </div>
            <div className="flex items-center rounded-full border border-[rgb(var(--border-line))] bg-surface-2 p-1">
              <button
                type="button"
                onClick={() => setPreviewMode('public')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-tiny font-emphasis transition-colors',
                  previewMode === 'public'
                    ? 'bg-brand text-text-inverse shadow-linear-sm'
                    : 'text-text-tertiary hover:text-text-secondary',
                )}
              >
                <Globe className="h-3.5 w-3.5" />
                Public page
              </button>
              <button
                type="button"
                onClick={() => setPreviewMode('embed')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-tiny font-emphasis transition-colors',
                  previewMode === 'embed'
                    ? 'bg-brand text-text-inverse shadow-linear-sm'
                    : 'text-text-tertiary hover:text-text-secondary',
                )}
              >
                <Code2 className="h-3.5 w-3.5" />
                Embed
              </button>
            </div>
          </div>

          <div className="mt-4 overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
            <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] px-4 py-2.5" style={previewTheme.topBarStyle}>
              <span className="h-2.5 w-2.5 rounded-full bg-danger/60" />
              <span className="h-2.5 w-2.5 rounded-full bg-warning/60" />
              <span className="h-2.5 w-2.5 rounded-full bg-success/60" />
              <span className="ml-2 min-w-0 truncate text-tiny text-text-tertiary">{previewUrl}</span>
            </div>

            {previewMode === 'public' ? (
              <div className="space-y-4 p-4" style={previewTheme.pageStyle}>
                <div className="rounded-xl border p-3" style={previewTheme.panelStyle}>
                  <div className="flex flex-col gap-3">
                    <h4 className="truncate text-small font-strong tracking-tight text-text-primary">{previewTitle}</h4>

                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={previewTheme.accentPillStyle}>
                        Compact report rail
                      </span>
                      {previewAppearance.show_page_tabs && (
                        <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={previewTheme.neutralPillStyle}>
                          Page tabs visible
                        </span>
                      )}
                      <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={previewTheme.neutralPillStyle}>
                        {previewAppearance.allow_viewer_filters ? 'Viewer filters enabled' : 'Viewer filters hidden'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border p-3" style={previewTheme.canvasFrameStyle}>
                  <div className="rounded-lg p-3" style={previewTheme.canvasInnerStyle}>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="h-28 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1" />
                      <div className="h-28 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1" />
                      <div className="h-36 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 sm:col-span-2" />
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3 p-4" style={previewTheme.pageStyle}>
                <div className="overflow-hidden rounded-xl border" style={previewTheme.shellStyle}>
                  {showEmbedHeader ? (
                    <div className="border-b px-4 py-3" style={previewTheme.panelStyle}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h4 className="truncate text-small font-strong text-text-primary">{previewTitle}</h4>
                        </div>
                        <span className="rounded-full border px-2.5 py-1 text-tiny font-emphasis" style={previewTheme.neutralPillStyle}>
                          Compact viewer rail
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="border-b px-4 py-3 text-tiny text-text-tertiary" style={previewTheme.panelStyle}>
                      Embed header hidden, report starts immediately with controls and canvas.
                    </div>
                  )}

                  <div className="border-b px-4 py-3" style={previewTheme.panelStyle}>
                    <div className="flex flex-wrap gap-2">
                      {previewAppearance.show_page_tabs && (
                        <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={previewTheme.accentPillStyle}>
                          Tabs
                        </span>
                      )}
                      <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={previewTheme.neutralPillStyle}>
                        {previewAppearance.allow_viewer_filters ? 'Interactive filters' : 'Locked view'}
                      </span>
                    </div>
                  </div>

                  <div className="p-3">
                    <div className="rounded-xl border p-3" style={previewTheme.canvasFrameStyle}>
                      <div className="rounded-lg p-3" style={previewTheme.canvasInnerStyle}>
                        <div className="grid gap-3">
                          <div className="h-24 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1" />
                          <div className="h-36 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
          <p className="text-tiny font-strong uppercase tracking-[0.14em] text-text-quaternary">Publishing summary</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
              <p className="text-tiny font-emphasis text-text-tertiary">Access scope</p>
              <p className="mt-1 text-caption font-strong text-text-primary">
                {configuredAccessFilterCount > 0 ? `${configuredAccessFilterCount} access filter${configuredAccessFilterCount === 1 ? '' : 's'}` : 'All dashboard data'}
              </p>
            </div>
            <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
              <p className="text-tiny font-emphasis text-text-tertiary">Viewer controls</p>
              <p className="mt-1 text-caption font-strong text-text-primary">
                {previewAppearance.allow_viewer_filters ? 'Interactive' : 'Read-only without filter controls'}
              </p>
            </div>
            <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
              <p className="text-tiny font-emphasis text-text-tertiary">Viewer layout</p>
              <p className="mt-1 text-caption font-strong text-text-primary">Compact control rail + full-width canvas</p>
            </div>
            <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
              <p className="text-tiny font-emphasis text-text-tertiary">Security</p>
              <p className="mt-1 text-caption font-strong text-text-primary">{passwordEnabled ? 'Password required' : 'Open link access'}</p>
            </div>
          </div>
        </div>

      </div>
    );
  };

  // Share outputs (page URL + embed URL/snippet) — only meaningful once a
  // link exists. Lives in the "Bảo mật & Chia sẻ" tab.
  const renderShareOutputs = () => {
    if (!(view === 'edit' && editingLink?.is_active)) return null;
    return (
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
        <div className="flex items-center gap-2 text-text-primary">
          <Link2 className="h-4 w-4 text-brand" />
          <h3 className="text-small font-strong">Link chia sẻ</h3>
        </div>
        <p className="mt-2 text-caption leading-6 text-text-tertiary">
          Link trang công khai và mã nhúng iframe cho link này.
        </p>
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
            <Link2 className="h-4 w-4 text-text-quaternary" />
            <span className="min-w-0 flex-1 truncate text-tiny font-mono text-text-tertiary">
              {origin.replace(/\/$/, '')}/d/{editingLink!.token}
            </span>
            <IconButton
              aria-label="Copy page URL"
              variant="ghost"
              size="sm"
              onClick={() => {
                copyText(`${origin.replace(/\/$/, '')}/d/${editingLink!.token}`, () => {
                  setCopiedId(editingLink!.id);
                  setTimeout(() => setCopiedId(null), 2000);
                });
              }}
            >
              {copiedId === editingLink!.id ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </IconButton>
          </div>

          <div className="flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
            <Code2 className="h-4 w-4 text-text-quaternary" />
            <span className="min-w-0 flex-1 truncate text-tiny font-mono text-text-tertiary">
              {getEmbedUrl(editingLink!)}
            </span>
            <IconButton
              aria-label="Copy embed URL"
              variant="ghost"
              size="sm"
              onClick={() => {
                copyText(getEmbedUrl(editingLink!), () => {
                  setCopiedEmbedId(editingLink!.id);
                  setTimeout(() => setCopiedEmbedId(null), 2000);
                });
              }}
            >
              {copiedEmbedId === editingLink!.id ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </IconButton>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => {
                copyText(getIframeSnippet(editingLink!), () => {
                  setCopiedSnippetId(editingLink!.id);
                  setTimeout(() => setCopiedSnippetId(null), 2000);
                });
              }}
            >
              {copiedSnippetId === editingLink!.id ? 'Copied' : '</>'}
            </Button>
          </div>
        </div>
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
        className="cursor-pointer rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4 shadow-linear-sm transition hover:shadow-linear"
      >
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr),320px]">
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-small font-strong text-text-primary">{link.name}</h3>
                  {!link.is_active && (
                    <Badge variant="neutral" size="sm">Inactive</Badge>
                  )}
                  {link.has_password && (
                    <Badge variant="warning" size="sm">
                      <Lock className="h-3 w-3" />
                      Password
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-caption text-text-tertiary">{formatFilterSummary((link.filters_config ?? []) as BaseFilter[])}</p>
              </div>

              <div className="flex items-center gap-1">
                <IconButton
                  aria-label={link.is_active ? 'Deactivate' : 'Activate'}
                  variant="ghost"
                  size="sm"
                  onClick={(event) => handleToggleActive(link, event)}
                >
                  {link.is_active ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </IconButton>
                <IconButton
                  aria-label="Delete"
                  variant="ghost"
                  size="sm"
                  onClick={(event) => handleDelete(link, event)}
                  className="hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={theme.accentPillStyle}>
                {appearanceSummary.presetLabel}
              </span>
              <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={theme.neutralPillStyle}>
                {appearanceSummary.accentLabel}
              </span>
              {!appearance.allow_viewer_filters && (
                <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={theme.neutralPillStyle}>
                  Filters hidden
                </span>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3">
                <p className="flex items-center gap-1 text-tiny font-emphasis text-text-tertiary">
                  <Eye className="h-3.5 w-3.5" />
                  Views
                </p>
                <p className="mt-2 text-body font-strong text-text-primary">{link.access_count}</p>
              </div>
              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3">
                <p className="flex items-center gap-1 text-tiny font-emphasis text-text-tertiary">
                  <Clock className="h-3.5 w-3.5" />
                  Last access
                </p>
                <p className="mt-2 text-caption font-emphasis text-text-secondary">{formatDate(link.last_accessed_at)}</p>
              </div>
              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3">
                <p className="text-tiny font-emphasis text-text-tertiary">Created</p>
                <p className="mt-2 text-caption font-emphasis text-text-secondary">{formatDate(link.created_at)}</p>
              </div>
            </div>

            {link.is_active && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                  <Link2 className="h-4 w-4 text-text-quaternary" />
                  <span className="min-w-0 flex-1 truncate text-tiny font-mono text-text-tertiary">
                    {origin.replace(/\/$/, '')}/d/{link.token}
                  </span>
                  <IconButton
                    aria-label="Copy page URL"
                    variant="ghost"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      copyText(`${origin.replace(/\/$/, '')}/d/${link.token}`, () => {
                        setCopiedId(link.id);
                        setTimeout(() => setCopiedId(null), 2000);
                      });
                    }}
                  >
                    {copiedId === link.id ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                  </IconButton>
                </div>

                <div className="flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                  <Code2 className="h-4 w-4 text-text-quaternary" />
                  <span className="min-w-0 flex-1 truncate text-tiny font-mono text-text-tertiary">
                    {origin.replace(/\/$/, '')}/embed/{link.token}
                  </span>
                  <IconButton
                    aria-label="Copy embed URL"
                    variant="ghost"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      copyText(getEmbedUrl(link), () => {
                        setCopiedEmbedId(link.id);
                        setTimeout(() => setCopiedEmbedId(null), 2000);
                      });
                    }}
                  >
                    {copiedEmbedId === link.id ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                  </IconButton>
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={(event) => {
                      event.stopPropagation();
                      copyText(getIframeSnippet(link), () => {
                        setCopiedSnippetId(link.id);
                        setTimeout(() => setCopiedSnippetId(null), 2000);
                      });
                    }}
                  >
                    {copiedSnippetId === link.id ? 'Copied' : '</>'}
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div
            className="overflow-hidden rounded-xl border"
            style={theme.heroStyle}
          >
            <div className="space-y-4 p-5">
              <h4 className="text-body font-strong tracking-tight text-text-primary">{previewTitle}</h4>
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={theme.accentPillStyle}>
                  Compact rail
                </span>
                {appearance.show_page_tabs && (
                  <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={theme.neutralPillStyle}>
                    Tabs on
                  </span>
                )}
                <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={theme.neutralPillStyle}>
                  {appearance.allow_viewer_filters ? 'Viewer filters on' : 'Viewer filters off'}
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="h-20 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1" />
                <div className="h-20 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1" />
                <div className="h-24 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 sm:col-span-2" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const shellTitle = view === 'list' ? 'Public Links' : view === 'create' ? 'Create Public Link' : 'Edit Public Link';
  const shellDescription = (
    <span className="flex items-center gap-2">
      {view !== 'list' && (
        <button
          onClick={goBack}
          className="inline-flex items-center gap-1 text-caption text-text-tertiary hover:text-text-secondary"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>
      )}
      <span>{dashboardName}</span>
    </span>
  );

  const footer = view === 'create' ? (
    <>
      <Button variant="ghost" onClick={goBack}>Cancel</Button>
      <Button
        variant="primary"
        onClick={handleCreate}
        disabled={creating || !formName.trim() || !isPasswordFormValid}
        loading={creating}
        leadingIcon={!creating && <Plus className="h-4 w-4" />}
      >
        {creating ? 'Creating…' : 'Create link'}
      </Button>
    </>
  ) : view === 'edit' ? (
    <>
      <Button variant="ghost" onClick={goBack}>Cancel</Button>
      <Button
        variant="primary"
        onClick={handleUpdate}
        disabled={saving || !formName.trim() || !isPasswordFormValid}
        loading={saving}
        leadingIcon={!saving && <Check className="h-4 w-4" />}
      >
        {saving ? 'Saving…' : 'Save changes'}
      </Button>
    </>
  ) : undefined;

  return (
    <AppModalShell
      onClose={onClose}
      title={shellTitle}
      description={shellDescription}
      icon={<Globe className="h-4 w-4" />}
      maxWidthClass="max-w-[96rem]"
      panelClassName="h-[94vh] max-h-[94vh]"
      bodyClassName="p-0"
      footer={footer}
    >
      <div className={view === 'list' ? 'h-full overflow-y-auto' : 'h-full overflow-hidden'}>
        {view === 'list' && (
          <div className="p-6">
            <div className="grid gap-6 xl:grid-cols-[320px,minmax(0,1fr)]">
              <div className="space-y-3">
                <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
                  <div className="flex items-center gap-2 text-text-primary">
                    <Sparkles className="h-4 w-4 text-brand" />
                    <h3 className="text-small font-strong">Viewer presentation</h3>
                  </div>
                  <p className="mt-2 text-caption leading-6 text-text-tertiary">
                    Each link now keeps only the settings people actually notice: title, tone, and whether tabs or viewer filters are available.
                    The shared viewer itself stays compact and fixed so the report content gets maximum space.
                  </p>
                  <Button
                    variant="primary"
                    fullWidth
                    className="mt-5"
                    onClick={openCreate}
                    leadingIcon={<Plus className="h-4 w-4" />}
                  >
                    Create new public link
                  </Button>
                </div>

                <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
                  <p className="text-tiny font-strong uppercase tracking-[0.14em] text-text-quaternary">Tips</p>
                  <div className="mt-3 space-y-3 text-caption text-text-tertiary">
                    <p>Use the headline to rename the same dashboard for different audiences without cloning it.</p>
                    <p>Keep tabs on only when the dashboard really has multiple pages worth switching between.</p>
                    <p>Turn viewer filters off for locked executive views, and keep them on when viewers need light exploration.</p>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                {loading ? (
                  <div className="flex items-center justify-center rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-16 text-caption text-text-tertiary">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Loading public links...
                  </div>
                ) : links.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-6 py-16 text-center">
                    <Globe className="mx-auto h-10 w-10 text-text-quaternary" />
                    <p className="mt-4 text-small font-strong text-text-secondary">No public links yet</p>
                    <p className="mt-2 text-caption text-text-tertiary">
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
              <div className="min-h-0 space-y-4 overflow-y-auto pr-1 lg:pr-3">
                <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
                  <div className="flex items-center gap-2 text-text-primary">
                    <Globe className="h-4 w-4 text-brand" />
                    <h3 className="text-small font-strong">Link identity</h3>
                  </div>
                  <p className="mt-2 text-caption leading-6 text-text-tertiary">
                    Name the audience-facing link first. This name is also the default fallback title if you leave the presentation headline empty.
                  </p>
                  <label className="mb-1.5 mt-4 block text-label font-emphasis text-text-secondary">Link name</label>
                  <Input
                    type="text"
                    value={formName}
                    onChange={(event) => setFormName(event.target.value)}
                    placeholder='e.g. "CEO View", "Sales Team", "Quarterly Briefing"'
                    autoFocus
                  />
                  <p className="mt-2 text-caption leading-6 text-text-tertiary">
                    Use a descriptive name so you can distinguish audience-specific links later.
                  </p>
                </div>

                {/* Intent tabs (2026-06-18) — split the long form by purpose
                    so the modal isn't one 9-section scroll. */}
                <div className="flex items-center gap-1 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-1">
                  {([
                    { id: 'appearance', label: 'Giao diện' },
                    { id: 'data', label: 'Dữ liệu (Filter)' },
                    { id: 'security', label: 'Bảo mật & Chia sẻ' },
                  ] as const).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setFormTab(t.id)}
                      className={cn(
                        'flex-1 rounded-md px-3 py-1.5 text-caption font-emphasis transition-colors',
                        formTab === t.id
                          ? 'bg-brand text-text-inverse shadow-linear-sm'
                          : 'text-text-tertiary hover:text-text-secondary',
                      )}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {formTab === 'appearance' && (
                  <PublicLinkAppearanceEditor
                    value={formAppearance}
                    dashboardName={dashboardName}
                    onChange={setFormAppearance}
                  />
                )}

                {/* Dữ liệu tab — unified link-filter table (2026-06-18 rework).
                    ONE surface: every shareable field is a row with Show /
                    Lock / Hide, replacing the old three overlapping sections
                    (3-radio + "Access filters" escape-hatch + "Hidden
                    fields"). BE link_locked is the outermost gate, then
                    page/dashboard filters, then the viewer's slicer. See
                    docs/filter-semantics.md §2.3 + §3. */}
                {formTab === 'data' && (
                <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
                  <div className="flex items-center gap-2 text-text-primary">
                    <Filter className="h-4 w-4 text-brand" />
                    <h3 className="text-small font-strong">Filter cho link này</h3>
                  </div>
                  <p className="mt-2 text-caption leading-6 text-text-tertiary">
                    Mỗi field chọn 1 hành vi: <span className="font-emphasis">👁 Hiện</span> — viewer thấy & chỉnh được; <span className="font-emphasis">🔒 Khoá</span> — ép giá trị, viewer không đổi được (như RLS); <span className="font-emphasis">🚫 Ẩn</span> — bỏ hẳn field khỏi link.
                  </p>
                  <p className="mt-1.5 rounded-md bg-surface-2 px-3 py-2 text-tiny text-text-tertiary">
                    Thứ tự lọc khi xem public: <span className="font-emphasis text-text-secondary">🔒 Khoá ở link</span> (ngoài cùng, không phá được) → <span className="font-emphasis text-text-secondary">Filter trang dashboard</span> → <span className="font-emphasis text-text-secondary">Slicer người xem chọn</span>.
                  </p>

                  <div className="mt-4 space-y-2">
                    {columnsLoading && unifiedRows.length === 0 ? (
                      <div className="flex items-center justify-center rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-8 text-caption text-text-tertiary">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Đang tải field…
                      </div>
                    ) : unifiedRows.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 px-4 py-6 text-center text-tiny text-text-tertiary">
                        Chưa có field nào để cấu hình. Thêm chart/slicer vào dashboard trước, hoặc thêm field bên dưới.
                      </p>
                    ) : (
                      unifiedRows.map((row) => {
                        const action = effectiveAction(row);
                        const lockValue = linkActions[row.key]?.value ?? (action === 'lock' ? row.value : undefined);
                        const sourceLabel =
                          row.source === 'slicer' ? 'Slicer'
                          : row.source === 'filter' ? 'Filter trang'
                          : 'Thêm thủ công';
                        return (
                          <div
                            key={row.key}
                            className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 font-emphasis text-caption text-text-primary">
                                {row.label}
                                <span className="ml-2 rounded bg-surface-1 px-1.5 py-0.5 text-tiny font-normal text-text-tertiary">
                                  {sourceLabel}
                                </span>
                              </div>
                              {row.source === 'extra' && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setExtraRows((prev) => prev.filter((r) => entryKey(r as any) !== row.key));
                                    setLinkActions((prev) => {
                                      const next = { ...prev };
                                      delete next[row.key];
                                      return next;
                                    });
                                  }}
                                  className="shrink-0 rounded p-0.5 text-text-quaternary hover:bg-[rgba(255,255,255,0.06)] hover:text-danger"
                                  title="Bỏ field khỏi danh sách"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-3 text-caption text-text-secondary">
                              {(['show', 'lock', 'hide'] as const).map((opt) => (
                                <label key={opt} className="inline-flex cursor-pointer items-center gap-1.5">
                                  <input
                                    type="radio"
                                    name={`act-${row.key}`}
                                    checked={action === opt}
                                    onChange={() =>
                                      setLinkActions((prev) => ({
                                        ...prev,
                                        [row.key]: { action: opt, value: opt === 'lock' ? (prev[row.key]?.value ?? row.value) : undefined },
                                      }))
                                    }
                                  />
                                  <span>
                                    {opt === 'show' && '👁 Hiện'}
                                    {opt === 'lock' && '🔒 Khoá'}
                                    {opt === 'hide' && '🚫 Ẩn'}
                                  </span>
                                </label>
                              ))}
                            </div>
                            {action === 'lock' && (
                              <div className="mt-2">
                                <label className="block text-tiny text-text-tertiary">Giá trị khoá:</label>
                                <input
                                  type="text"
                                  value={Array.isArray(lockValue) ? lockValue.join(', ') : String(lockValue ?? '')}
                                  onChange={(e) => {
                                    const raw = e.target.value;
                                    const next = raw.includes(',') ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw;
                                    setLinkActions((prev) => ({
                                      ...prev,
                                      [row.key]: { action: 'lock', value: next },
                                    }));
                                  }}
                                  placeholder={Array.isArray(row.value) ? row.value.join(', ') : String(row.value ?? 'nhập giá trị…')}
                                  list={`vals-${row.key}`}
                                  className="mt-1 w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-caption outline-none focus:ring-1 focus:ring-brand"
                                />
                                <datalist id={`vals-${row.key}`}>
                                  {(activeDistinctValues[row.field] ?? activeDistinctValues[row.semanticField ?? ''] ?? []).slice(0, 50).map((v) => (
                                    <option key={v} value={v} />
                                  ))}
                                </datalist>
                                <p className="mt-1 text-tiny text-text-quaternary">
                                  Phân cách bằng dấu phẩy nếu có nhiều giá trị. Để trống = dùng giá trị dashboard mặc định.
                                </p>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>

                  {/* Add a field that isn't an inherited slicer/filter — the
                      old "Access filters" escape-hatch power, folded in. */}
                  {addableColumns.length > 0 && (
                    <div className="mt-3">
                      <label className="block text-tiny text-text-tertiary">+ Thêm field khác để khoá / ẩn:</label>
                      <select
                        value=""
                        onChange={(e) => {
                          const name = e.target.value;
                          if (!name) return;
                          const col = addableColumns.find((c) => c.name === name);
                          if (!col) return;
                          const newRow = {
                            field: col.name,
                            semanticField: col.semanticField,
                            datasetId: col.datasetId,
                            label: col.label || col.name,
                            type: col.type,
                            operator: 'in',
                            value: [],
                          } as unknown as BaseFilter;
                          const k = entryKey(newRow as any);
                          setExtraRows((prev) => [...prev, newRow]);
                          setLinkActions((prev) => ({ ...prev, [k]: { action: 'lock', value: undefined } }));
                        }}
                        className="mt-1 w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-caption outline-none focus:ring-1 focus:ring-brand"
                      >
                        <option value="">— chọn field —</option>
                        {addableColumns.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.label || c.name}{c.datasetName ? ` · ${c.datasetName}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
                )}

                {formTab === 'security' && (
                <>
                <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
                  <div className="flex items-center gap-2 text-text-primary">
                    <Lock className="h-4 w-4 text-warning" />
                    <h3 className="text-small font-strong">Password protection</h3>
                  </div>
                  <p className="mt-2 text-caption leading-6 text-text-tertiary">
                    Public and embed links do not require an AppBI account. Add a password only if viewers need a second gate.
                  </p>

                  {view === 'edit' && editingLink?.has_password && !changePassword ? (
                    <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-warning/20 bg-warning/10 px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-caption font-emphasis text-warning">Password is set</p>
                        <p className="text-tiny text-warning/80">Sessions expire after 2 hours.</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setChangePassword(true);
                            setPasswordEnabled(true);
                            setFormPassword('');
                          }}
                        >
                          Change
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setChangePassword(true);
                            setPasswordEnabled(false);
                            setFormPassword('');
                          }}
                          className="hover:text-danger"
                        >
                          Remove
                        </Button>
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
                          className={cn(
                            'rounded-lg border px-4 py-3 text-left transition-colors',
                            !passwordEnabled
                              ? 'border-brand bg-brand text-text-inverse shadow-linear-sm'
                              : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2',
                          )}
                        >
                          <p className="text-caption font-strong">No password</p>
                          <p className={cn('mt-1 text-tiny leading-5', !passwordEnabled ? 'text-text-inverse/80' : 'text-text-tertiary')}>
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
                          className={cn(
                            'rounded-lg border px-4 py-3 text-left transition-colors',
                            passwordEnabled
                              ? 'border-brand bg-brand text-text-inverse shadow-linear-sm'
                              : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2',
                          )}
                        >
                          <p className="text-caption font-strong">Require password</p>
                          <p className={cn('mt-1 text-tiny leading-5', passwordEnabled ? 'text-text-inverse/80' : 'text-text-tertiary')}>
                            Viewers only need the link password, not an AppBI login.
                          </p>
                        </button>
                      </div>

                      {passwordEnabled && (
                        <Input
                          type={showPassword ? 'text' : 'password'}
                          value={formPassword}
                          onChange={(event) => setFormPassword(event.target.value)}
                          placeholder="Enter password"
                          trailingIcon={
                            <button
                              type="button"
                              onClick={() => setShowPassword((current) => !current)}
                              className="text-text-quaternary hover:text-text-secondary pointer-events-auto"
                            >
                              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          }
                        />
                      )}

                      {view === 'edit' && changePassword && (
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() => {
                            setChangePassword(false);
                            setFormPassword('');
                            setPasswordEnabled(Boolean(editingLink?.has_password));
                          }}
                        >
                          Cancel password change
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                {renderShareOutputs()}
                </>
                )}
              </div>

              <div className="min-h-0 overflow-y-auto pl-0 lg:pl-1">
                {renderConfiguratorPreview()}
              </div>
            </div>
          </div>
        )}

        {view === 'list' && (
          <div className="border-t border-[rgb(var(--border-line))] px-6 py-4">
            <p className="text-center text-tiny text-text-tertiary">
              Click any link card to edit its filters, password, or presentation. Deactivated links return 404.
            </p>
          </div>
        )}
      </div>
    </AppModalShell>
  );
}
