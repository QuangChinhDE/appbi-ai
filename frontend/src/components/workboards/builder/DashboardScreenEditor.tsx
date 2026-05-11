/**
 * DashboardScreenEditor - configure a workboard screen that embeds an AppBI
 * Dashboard.
 *
 * Layout (matches the user's mental model):
 *
 *   1. Pick a dashboard (or paste a share token for manual mode).
 *   2. "Map theo role": list of dashboard filter slots that should be filled
 *      with the viewing app_user.role. One row per slot. No value here —
 *      backend substitutes role at provision time.
 *   3. "Filter cố định": list of slots with a hard-coded value applied to
 *      every managed link regardless of role.
 *
 * The Dashboard module's own filter pipeline handles the resulting filters
 * unchanged — workboard does not pin/lock anything special server-side.
 */
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Lock, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { BuilderSection } from './BuilderChrome';
import { INPUT, Lbl } from './ScreenEditor';
import type {
  DashboardRoleFilterMappingSpec,
  DashboardScreenSpecBuilt,
  DashboardStaticFilterSpec,
  ScreenSpec,
} from './types';
import { apiClient } from '@/lib/api-client';

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
  const dashboard: DashboardScreenSpecBuilt = screen.dashboard || {};
  const update = (patch: Partial<DashboardScreenSpecBuilt>) =>
    onChange({ ...screen, dashboard: { ...dashboard, ...patch } });

  const isManaged = typeof dashboard.dashboard_id === 'number' && dashboard.dashboard_id > 0;
  const mapping = dashboard.role_filter_mapping ?? [];
  const staticFilters = dashboard.static_filters ?? [];

  // ── Accessible dashboard list (slim) ────────────────────────────────────
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
      setListError(getApiErrorMessage(err, 'Không tải được danh sách dashboard.'));
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

  // ── Filter fields for the picked dashboard ──────────────────────────────
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
        setFieldsError(getApiErrorMessage(err, 'Không tải được danh sách cột filter của dashboard.'));
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

  // ── Mode switching ──────────────────────────────────────────────────────

  const switchToManaged = (dashboardId: number) => {
    update({
      dashboard_id: dashboardId,
      share_token: null,
    });
  };

  const switchToManual = () => {
    update({
      dashboard_id: null,
      role_filter_mapping: [],
      static_filters: [],
      managed_links: {},
    });
  };

  // ── Role mapping CRUD ───────────────────────────────────────────────────

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

  // ── Static filter CRUD ──────────────────────────────────────────────────

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

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <BuilderSection
        title="Dashboard nhúng"
        description="Chọn 1 dashboard bạn có quyền xem. Workboard tự sinh public link riêng theo từng role của app_user — không cần ai vào module Dashboard tạo link trước."
        action={
          <button
            type="button"
            onClick={() => void refreshList()}
            disabled={listLoading}
            className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] px-2 py-1 text-tiny text-text-secondary hover:bg-surface-2 disabled:opacity-50"
            title="Refresh danh sách dashboard"
          >
            <RefreshCw className={`h-3 w-3 ${listLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        }
      >
        <Lbl label="Dashboard">
          <select
            className={INPUT}
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
          >
            <option value="__manual__">— Paste share token thủ công —</option>
            {accessible.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.permission !== 'full' && d.permission !== 'edit' ? ' (view)' : ''}
              </option>
            ))}
          </select>
          {listError && <p className="mt-1 text-tiny text-danger">{listError}</p>}
          {!listError && !listLoading && accessible.length === 0 && (
            <p className="mt-1 text-tiny text-text-tertiary">
              Bạn chưa có dashboard nào được chia sẻ. Tạo một dashboard trước hoặc dùng chế độ paste token bên dưới.
            </p>
          )}
        </Lbl>

        {selectedDashboard && (
          <div className="rounded-md border border-info/20 bg-info/5 px-3 py-2 text-tiny text-text-secondary">
            <div className="font-emphasis text-text-primary">{selectedDashboard.name}</div>
            {selectedDashboard.description && (
              <div className="mt-0.5">{selectedDashboard.description}</div>
            )}
            <div className="mt-1 text-text-tertiary">
              {fieldsLoading
                ? 'Đang tải danh sách cột filter…'
                : fieldsError
                  ? fieldsError
                  : filterFields.length === 0
                    ? 'Dashboard này chưa expose cột filter nào — chỉ embed nguyên dashboard, không có map role hay filter cố định. Vào Dashboard cấu hình Access filter trước, sau đó Refresh.'
                    : `${filterFields.length} cột filter khả dụng${
                        hasPublicFiltersConfig
                          ? ' (lấy từ Access filter DA đã cấu hình)'
                          : ' (suy ra từ chart bindings)'
                      }.`}
            </div>
          </div>
        )}
      </BuilderSection>

      {isManaged && (
        <>
          <BuilderSection
            title="Map theo role"
            description="Mỗi dòng = 1 cột filter của dashboard sẽ được tự động fill bằng role của app_user đang xem. Backend tự sinh link riêng cho từng role."
            action={
              <button
                type="button"
                onClick={addMapping}
                disabled={
                  filterFields.length === 0 || mapping.length >= filterFields.length
                }
                className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] px-2 py-1 text-tiny text-text-secondary hover:bg-surface-2 disabled:opacity-50"
              >
                <Plus className="h-3 w-3" /> Thêm mapping
              </button>
            }
          >
            {mapping.length === 0 && (
              <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] px-3 py-2.5 text-tiny text-text-tertiary">
                Chưa map cột nào — mọi role thấy cùng dữ liệu. Thêm mapping để mỗi role chỉ thấy phần của mình.
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
                          ⚠ {m.semanticField} (không còn trong dashboard)
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
                      <option value="contains">contains</option>
                    </select>
                    <span className="text-tiny text-text-tertiary">← app_user.role</span>
                    <button
                      type="button"
                      onClick={() => removeMapping(idx)}
                      className="ml-auto rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-danger"
                      title="Xoá mapping"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </BuilderSection>

          <BuilderSection
            title="Filter cố định"
            description="Filter có giá trị tĩnh, áp cho mọi role. Ví dụ: chỉ hiện dữ liệu của năm 2026, chỉ trạng thái 'active'..."
            action={
              <button
                type="button"
                onClick={addStaticFilter}
                disabled={filterFields.length === 0}
                className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] px-2 py-1 text-tiny text-text-secondary hover:bg-surface-2 disabled:opacity-50"
              >
                <Plus className="h-3 w-3" /> Thêm filter
              </button>
            }
          >
            {staticFilters.length === 0 && (
              <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] px-3 py-2.5 text-tiny text-text-tertiary">
                Chưa có filter cố định. Thêm khi muốn pin một giá trị cho mọi role.
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
                          ⚠ {f.semanticField} (không còn trong dashboard)
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
                      <option value="in">in</option>
                      <option value="not_in">not in</option>
                      <option value="gt">&gt;</option>
                      <option value="gte">≥</option>
                      <option value="lt">&lt;</option>
                      <option value="lte">≤</option>
                      <option value="contains">contains</option>
                    </select>
                    <input
                      className={`${INPUT} flex-1 min-w-[140px]`}
                      placeholder={isMulti ? 'Nhiều giá trị, cách nhau dấu phẩy' : 'Giá trị'}
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
                      title="Xoá filter"
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
              title={`Public link đã sinh (${managedRoles.length + (managedTokensByRole['__default__'] ? 1 : 0)})`}
              description="Tự động cập nhật mỗi khi bạn lưu workboard hoặc thêm/xoá app_user."
            >
              <ul className="space-y-0.5 text-tiny text-text-tertiary">
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
                      mở thử
                    </a>
                  </li>
                ))}
                {managedTokensByRole['__default__'] && (
                  <li>
                    <code className="rounded bg-surface-2 px-1 text-text-secondary">default</code>
                    &nbsp;→&nbsp;
                    <a
                      href={`/embed/${managedTokensByRole['__default__']}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 text-brand hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                      mở thử
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
          title="Share token thủ công"
          description="Paste share_token có sẵn (do bạn hoặc người khác đã tạo trong Dashboard share dialog). Mini-app nhúng nguyên link — không có managed link, không map role, không filter cố định."
        >
          <Lbl label="Share token / URL">
            <input
              className={INPUT}
              placeholder="Ví dụ: abc123xyz hoặc https://.../embed/abc123xyz"
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
              className="inline-flex items-center gap-1 text-tiny font-emphasis text-brand hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              Mở thử /embed/{dashboard.share_token} trong tab mới
            </a>
          )}
        </BuilderSection>
      )}

      <BuilderSection title="Tuỳ chọn iframe" description="Áp dụng cho cả 2 chế độ.">
        <Lbl label="Mật khẩu chung (nếu có)">
          <div className="relative">
            <input
              type="text"
              className={`${INPUT} pl-7`}
              placeholder="Để trống nếu link không bảo vệ"
              value={dashboard.password || ''}
              onChange={(event) => update({ password: event.target.value || null })}
            />
            <Lock className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-tertiary" />
          </div>
          <p className="mt-1 text-tiny text-text-tertiary">
            Áp cho TẤT CẢ managed link sinh ra. Mini-app tự auth thay app_user.
          </p>
        </Lbl>

        <Lbl label="Chiều cao iframe (px) — tuỳ chọn">
          <input
            type="number"
            min={200}
            max={4000}
            className={INPUT}
            placeholder="Để trống để tự co theo nội dung dashboard"
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
      </BuilderSection>
    </div>
  );
}
