/**
 * DashboardScreenEditor — configure a workboard screen that embeds an
 * AppBI Dashboard.
 *
 * Layout:
 *   1. Pick a dashboard (or paste a share token for manual mode).
 *   2. Role mapping — slots filled with viewing app_user.role.
 *   3. Static filters — hard-coded slot values for every role.
 *   4. Advanced — password + iframe height.
 */
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Lock, Plus, RefreshCw, Trash2 } from 'lucide-react';

import {
  BuilderCollapsibleAdvanced,
  BuilderSection,
  BuilderTopBar,
  BuilderTopBarItem,
} from './BuilderChrome';
import { INPUT, Lbl } from './ScreenEditor';
import type {
  DashboardRoleFilterMappingSpec,
  DashboardScreenSpecBuilt,
  DashboardStaticFilterSpec,
  ScreenSpec,
} from './types';
import { apiClient } from '@/lib/api-client';
import { useI18n } from '@/providers/LanguageProvider';

interface AccessibleDashboard {
  id: number;
  name: string;
  description?: string | null;
  permission: 'none' | 'view' | 'edit' | 'full';
}

interface FilterField {
  semanticField: string;
  datasetId: number;
  name: string;
  label?: string;
  type?: string;
  tableLabel?: string;
}

interface FilterFieldsResponse {
  dashboard_id: number;
  fields: FilterField[];
  has_public_filters_config: boolean;
}

function extractTokenFromInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const urlMatch = trimmed.match(/\/(?:embed|d|public)\/([A-Za-z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  return trimmed;
}

function getApiErrorMessage(err: unknown, fallback: string): string {
  return (
    (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail || fallback
  );
}

function slotKey(datasetId: number, semanticField: string): string {
  return `${datasetId}::${semanticField}`;
}

export default function DashboardScreenEditor({
  screen,
  onChange,
}: {
  screen: ScreenSpec;
  onChange: (next: ScreenSpec) => void;
}) {
  const { t } = useI18n();
  const dashboard: DashboardScreenSpecBuilt = screen.dashboard || {};
  const update = (patch: Partial<DashboardScreenSpecBuilt>) =>
    onChange({ ...screen, dashboard: { ...dashboard, ...patch } });

  const isManaged = typeof dashboard.dashboard_id === 'number' && dashboard.dashboard_id > 0;
  const mapping = useMemo(
    () => dashboard.role_filter_mapping ?? [],
    [dashboard.role_filter_mapping],
  );
  const staticFilters = useMemo(
    () => dashboard.static_filters ?? [],
    [dashboard.static_filters],
  );

  // ── Accessible dashboard list ───────────────────────────────────────
  const [accessible, setAccessible] = useState<AccessibleDashboard[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const refreshList = async () => {
    setListLoading(true);
    setListError(null);
    try {
      const res = await apiClient.get('/dashboards/accessible-summary');
      setAccessible(Array.isArray(res.data) ? (res.data as AccessibleDashboard[]) : []);
    } catch (err) {
      setListError(getApiErrorMessage(err, t('workboards.dashboard.loadAccessibleFailed')));
    } finally {
      setListLoading(false);
    }
  };

  useEffect(() => {
    void refreshList();
  }, []);

  const selectedDashboard = useMemo(
    () => accessible.find((d) => d.id === dashboard.dashboard_id),
    [accessible, dashboard.dashboard_id],
  );

  // ── Filter fields for the picked dashboard ──────────────────────────
  const [filterFields, setFilterFields] = useState<FilterField[]>([]);
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const [hasPublicFiltersConfig, setHasPublicFiltersConfig] = useState(false);

  useEffect(() => {
    let alive = true;
    setFilterFields([]);
    setHasPublicFiltersConfig(false);
    if (!isManaged || !dashboard.dashboard_id) return () => {};
    setFieldsLoading(true);
    setFieldsError(null);
    (async () => {
      try {
        const res = await apiClient.get<FilterFieldsResponse>(
          `/dashboards/${dashboard.dashboard_id}/filter-fields`,
        );
        if (!alive) return;
        setFilterFields(Array.isArray(res.data.fields) ? res.data.fields : []);
        setHasPublicFiltersConfig(Boolean(res.data.has_public_filters_config));
      } catch (err) {
        if (!alive) return;
        setFieldsError(getApiErrorMessage(err, t('workboards.dashboard.loadFilterFieldsFailed')));
      } finally {
        if (alive) setFieldsLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [isManaged, dashboard.dashboard_id]);

  const fieldByKey = useMemo(() => {
    const m = new Map<string, FilterField>();
    for (const f of filterFields) m.set(slotKey(f.datasetId, f.semanticField), f);
    return m;
  }, [filterFields]);

  // ── Mode switching ──────────────────────────────────────────────────

  const switchToManaged = (dashboardId: number) => {
    update({ dashboard_id: dashboardId, share_token: null });
  };

  const switchToManual = () => {
    update({
      dashboard_id: null,
      role_filter_mapping: [],
      static_filters: [],
      managed_links: {},
    });
  };

  // ── Slot helpers ────────────────────────────────────────────────────

  const usedSlotKeys = useMemo(() => {
    const s = new Set<string>();
    for (const m of mapping) s.add(slotKey(m.datasetId, m.semanticField));
    for (const f of staticFilters) s.add(slotKey(f.datasetId, f.semanticField));
    return s;
  }, [mapping, staticFilters]);

  const firstUnusedField = (currentKey?: string): FilterField | undefined =>
    filterFields.find(
      (f) => slotKey(f.datasetId, f.semanticField) === currentKey
        || !usedSlotKeys.has(slotKey(f.datasetId, f.semanticField)),
    );

  const addMapping = () => {
    const next = firstUnusedField();
    if (!next) return;
    update({
      role_filter_mapping: [
        ...mapping,
        { datasetId: next.datasetId, semanticField: next.semanticField, operator: 'eq' },
      ],
    });
  };

  const updateMapping = (idx: number, patch: Partial<DashboardRoleFilterMappingSpec>) =>
    update({
      role_filter_mapping: mapping.map((m, i) => (i === idx ? { ...m, ...patch } : m)),
    });

  const removeMapping = (idx: number) =>
    update({ role_filter_mapping: mapping.filter((_, i) => i !== idx) });

  const addStaticFilter = () => {
    const next = firstUnusedField();
    if (!next) return;
    update({
      static_filters: [
        ...staticFilters,
        {
          datasetId: next.datasetId,
          semanticField: next.semanticField,
          operator: 'eq',
          value: '',
          type: next.type,
        },
      ],
    });
  };

  const updateStaticFilter = (idx: number, patch: Partial<DashboardStaticFilterSpec>) =>
    update({
      static_filters: staticFilters.map((f, i) => (i === idx ? { ...f, ...patch } : f)),
    });

  const removeStaticFilter = (idx: number) =>
    update({ static_filters: staticFilters.filter((_, i) => i !== idx) });

  const managedTokensByRole = dashboard.managed_links || {};
  const managedRoles = Object.keys(managedTokensByRole).filter((r) => r !== '__default__');

  const hasAdvanced = !!dashboard.password || dashboard.height_px != null;

  return (
    <div className="space-y-4">
      {/* Source mode strip — top bar */}
      <BuilderTopBar title={t('workboards.dashboard.source')}>
        <BuilderTopBarItem label="Dashboard" className="flex-1">
          <select
            value={isManaged ? String(dashboard.dashboard_id) : '__manual__'}
            onChange={(event) => {
              const v = event.target.value;
              if (v === '__manual__') {
                switchToManual();
              } else {
                const id = Number(v);
                if (Number.isFinite(id)) switchToManaged(id);
              }
            }}
            disabled={listLoading}
            className="h-9 min-w-0 flex-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 text-caption"
          >
            <option value="__manual__">{t('workboards.dashboard.manualTokenOption')}</option>
            {accessible.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.permission !== 'full' && d.permission !== 'edit' ? ' (view)' : ''}
              </option>
            ))}
          </select>
        </BuilderTopBarItem>
        <button
          type="button"
          onClick={() => void refreshList()}
          disabled={listLoading}
          className="inline-flex h-9 items-center gap-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 text-caption text-text-secondary hover:bg-surface-2 disabled:opacity-50"
          title={t('workboards.dashboard.refreshDashboardsTitle')}
        >
          <RefreshCw className={`h-3 w-3 ${listLoading ? 'animate-spin' : ''}`} />
          {t('workboards.dashboard.refresh')}
        </button>
      </BuilderTopBar>

      {listError && (
        <p className="text-caption text-danger">{listError}</p>
      )}
      {!listError && !listLoading && accessible.length === 0 && (
        <p className="rounded-md border border-info/20 bg-info/5 px-3 py-2 text-caption text-text-secondary">
          {t('workboards.dashboard.noSharedDashboards')}
        </p>
      )}

      {selectedDashboard && (
        <div className="rounded-md border border-info/20 bg-info/5 px-3 py-2 text-caption text-text-secondary">
          <div className="font-emphasis text-text-primary">{selectedDashboard.name}</div>
          {selectedDashboard.description && (
            <div className="mt-0.5">{selectedDashboard.description}</div>
          )}
          <div className="mt-1 text-text-tertiary">
            {fieldsLoading
              ? t('workboards.dashboard.loadingFilterFields')
              : fieldsError
                ? fieldsError
                : filterFields.length === 0
                  ? t('workboards.dashboard.noFilterColumns')
                  : t(
                      hasPublicFiltersConfig
                        ? 'workboards.dashboard.filterColumnsConfigured'
                        : 'workboards.dashboard.filterColumnsInferred',
                      { count: filterFields.length },
                    )}
          </div>
        </div>
      )}

      {isManaged && (
        <>
          <BuilderSection
            title={t('workboards.dashboard.roleMappingTitle', { count: mapping.length })}
            description={t('workboards.dashboard.roleMappingDescription')}
            action={
              <button
                type="button"
                onClick={addMapping}
                disabled={
                  filterFields.length === 0 || mapping.length >= filterFields.length
                }
                className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] px-2 py-1 text-caption text-text-secondary hover:bg-surface-2 disabled:opacity-50"
              >
                <Plus className="h-3 w-3" /> {t('workboards.dashboard.addMapping')}
              </button>
            }
          >
            {mapping.length === 0 && (
              <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] px-3 py-2.5 text-caption text-text-tertiary">
                {t('workboards.dashboard.noMappings')}
              </p>
            )}

            <div className="space-y-1.5">
              {mapping.map((m, idx) => {
                const key = slotKey(m.datasetId, m.semanticField);
                const fieldMeta = fieldByKey.get(key);
                const orphan = filterFields.length > 0 && !fieldMeta;
                return (
                  <div
                    key={idx}
                    className={`flex flex-wrap items-center gap-1.5 rounded-md border bg-surface-1 p-2 ${
                      orphan ? 'border-warning/50 bg-warning/5' : 'border-[rgb(var(--border-line))]'
                    }`}
                  >
                    <select
                      className={`${INPUT} w-64`}
                      value={key}
                      onChange={(event) => {
                        const [dsRaw, sf] = event.target.value.split('::');
                        updateMapping(idx, { datasetId: Number(dsRaw), semanticField: sf });
                      }}
                    >
                      {orphan && (
                        <option value={key} disabled>
                          {t('workboards.dashboard.orphanField', { field: m.semanticField })}
                        </option>
                      )}
                      {filterFields.map((opt) => {
                        const optKey = slotKey(opt.datasetId, opt.semanticField);
                        return (
                          <option key={optKey} value={optKey}>
                            {opt.label || opt.name || opt.semanticField}
                            {opt.tableLabel ? ` · ${opt.tableLabel}` : ''}
                          </option>
                        );
                      })}
                    </select>
                    <select
                      className={`${INPUT} w-24`}
                      value={m.operator ?? 'eq'}
                      onChange={(event) => updateMapping(idx, { operator: event.target.value })}
                    >
                      <option value="eq">=</option>
                      <option value="neq">≠</option>
                      <option value="contains">{t('workboards.dashboard.operator.contains')}</option>
                    </select>
                    <span className="text-caption text-text-tertiary">
                      {t('workboards.dashboard.fromAppUserRole')}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeMapping(idx)}
                      className="ml-auto rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-danger"
                      title={t('workboards.dashboard.deleteMapping')}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </BuilderSection>

          <BuilderSection
            title={t('workboards.dashboard.staticFiltersTitle', { count: staticFilters.length })}
            description={t('workboards.dashboard.staticFiltersDescription')}
            action={
              <button
                type="button"
                onClick={addStaticFilter}
                disabled={filterFields.length === 0}
                className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] px-2 py-1 text-caption text-text-secondary hover:bg-surface-2 disabled:opacity-50"
              >
                <Plus className="h-3 w-3" /> {t('workboards.dashboard.addFilter')}
              </button>
            }
          >
            {staticFilters.length === 0 && (
              <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] px-3 py-2.5 text-caption text-text-tertiary">
                {t('workboards.dashboard.noStaticFilters')}
              </p>
            )}

            <div className="space-y-1.5">
              {staticFilters.map((f, idx) => {
                const key = slotKey(f.datasetId, f.semanticField);
                const fieldMeta = fieldByKey.get(key);
                const orphan = filterFields.length > 0 && !fieldMeta;
                const isMulti = f.operator === 'in' || f.operator === 'not_in';
                return (
                  <div
                    key={idx}
                    className={`flex flex-wrap items-center gap-1.5 rounded-md border bg-surface-1 p-2 ${
                      orphan ? 'border-warning/50 bg-warning/5' : 'border-[rgb(var(--border-line))]'
                    }`}
                  >
                    <select
                      className={`${INPUT} w-56`}
                      value={key}
                      onChange={(event) => {
                        const [dsRaw, sf] = event.target.value.split('::');
                        const meta = fieldByKey.get(event.target.value);
                        updateStaticFilter(idx, {
                          datasetId: Number(dsRaw),
                          semanticField: sf,
                          type: meta?.type ?? f.type,
                        });
                      }}
                    >
                      {orphan && (
                        <option value={key} disabled>
                          {t('workboards.dashboard.orphanField', { field: f.semanticField })}
                        </option>
                      )}
                      {filterFields.map((opt) => {
                        const optKey = slotKey(opt.datasetId, opt.semanticField);
                        return (
                          <option key={optKey} value={optKey}>
                            {opt.label || opt.name || opt.semanticField}
                            {opt.tableLabel ? ` · ${opt.tableLabel}` : ''}
                          </option>
                        );
                      })}
                    </select>
                    <select
                      className={`${INPUT} w-24`}
                      value={f.operator ?? 'eq'}
                      onChange={(event) => updateStaticFilter(idx, { operator: event.target.value })}
                    >
                      <option value="eq">=</option>
                      <option value="neq">≠</option>
                      <option value="in">{t('workboards.dashboard.operator.in')}</option>
                      <option value="not_in">{t('workboards.dashboard.operator.notIn')}</option>
                      <option value="gt">&gt;</option>
                      <option value="gte">≥</option>
                      <option value="lt">&lt;</option>
                      <option value="lte">≤</option>
                      <option value="contains">{t('workboards.dashboard.operator.contains')}</option>
                    </select>
                    <input
                      className={`${INPUT} flex-1 min-w-[140px]`}
                      placeholder={
                        isMulti
                          ? t('workboards.dashboard.multiValuePlaceholder')
                          : t('workboards.dashboard.valuePlaceholder')
                      }
                      value={Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? '')}
                      onChange={(event) => {
                        const raw = event.target.value;
                        const parsed = isMulti
                          ? raw.split(',').map((s) => s.trim()).filter(Boolean)
                          : raw;
                        updateStaticFilter(idx, { value: parsed });
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => removeStaticFilter(idx)}
                      className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-danger"
                      title={t('workboards.dashboard.deleteFilter')}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </BuilderSection>

          {managedRoles.length > 0 && (
            <BuilderSection
              title={t('workboards.dashboard.generatedLinksTitle', {
                count: managedRoles.length + (managedTokensByRole['__default__'] ? 1 : 0),
              })}
              description={t('workboards.dashboard.generatedLinksDescription')}
            >
              <ul className="space-y-0.5 text-caption text-text-tertiary">
                {managedRoles.map((role) => (
                  <li key={role}>
                    <code className="rounded bg-surface-2 px-1 text-text-secondary">{role}</code>
                    &nbsp;→&nbsp;
                    <a
                      href={`/embed/${managedTokensByRole[role]}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 text-brand hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {t('common.open')}
                    </a>
                  </li>
                ))}
                {managedTokensByRole['__default__'] && (
                  <li>
                    <code className="rounded bg-surface-2 px-1 text-text-secondary">
                      {t('workboards.dashboard.defaultLink')}
                    </code>
                    &nbsp;→&nbsp;
                    <a
                      href={`/embed/${managedTokensByRole['__default__']}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 text-brand hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {t('common.open')}
                    </a>
                  </li>
                )}
              </ul>
            </BuilderSection>
          )}
        </>
      )}

      {!isManaged && (
        <BuilderSection
          title={t('workboards.dashboard.manualShareToken')}
          description={t('workboards.dashboard.manualShareTokenDescription')}
        >
          <Lbl label={t('workboards.dashboard.shareTokenUrl')}>
            <input
              className={INPUT}
              placeholder={t('workboards.dashboard.shareTokenPlaceholder')}
              value={dashboard.share_token || ''}
              onChange={(event) =>
                update({ share_token: extractTokenFromInput(event.target.value) || null })
              }
            />
          </Lbl>
          {dashboard.share_token && (
            <a
              href={`/embed/${dashboard.share_token}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-caption font-emphasis text-brand hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              {t('workboards.dashboard.openEmbedLink', { token: dashboard.share_token })}
            </a>
          )}
        </BuilderSection>
      )}

      {/* Advanced — iframe options (applies in both modes) */}
      <BuilderCollapsibleAdvanced
        title={t('workboards.dashboard.iframeOptions')}
        description={t('workboards.dashboard.iframeOptionsDescription')}
        defaultOpen={hasAdvanced}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Lbl label={t('workboards.dashboard.sharedPassword')}>
            <div className="relative">
              <input
                type="text"
                className={`${INPUT} pl-7`}
                placeholder={t('workboards.dashboard.passwordPlaceholder')}
                value={dashboard.password || ''}
                onChange={(event) => update({ password: event.target.value || null })}
              />
              <Lock className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-tertiary" />
            </div>
            <p className="mt-1 text-caption text-text-tertiary">
              {t('workboards.dashboard.passwordHint')}
            </p>
          </Lbl>

          <Lbl label={t('workboards.dashboard.iframeHeight')}>
            <input
              type="number"
              min={200}
              max={4000}
              className={INPUT}
              placeholder={t('workboards.dashboard.autoHeightPlaceholder')}
              value={dashboard.height_px ?? ''}
              onChange={(event) => {
                const raw = event.target.value;
                const n = Number(raw);
                update({
                  height_px:
                    raw === '' || !Number.isFinite(n)
                      ? null
                      : Math.max(200, Math.min(4000, Math.trunc(n))),
                });
              }}
            />
          </Lbl>
        </div>
      </BuilderCollapsibleAdvanced>
    </div>
  );
}
