/**
 * WorkboardAppUsersTab manages end-user accounts for a workboard mini-app.
 *
 * Main UX goals:
 * - fixed product roles: user / admin / owner
 * - dataset-backed selects for access keys discovered from screen RLS
 * - manual context only as an advanced fallback
 */
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  UserCircle2,
  X,
} from 'lucide-react';

import {
  workboardApi,
  type Workboard,
  type WorkboardAppUserCreate,
  type WorkboardAppUserResponse,
  type WorkboardAppUserUpdate,
} from '@/lib/api/workboards';
import { apiClient } from '@/lib/api-client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/common/Modal';
import { toast } from '@/lib/toast';
import {
  APP_USER_ROLE_OPTIONS,
  buildAppUserRoleOptions,
  formatAppUserRoleLabel,
  isOwnerAppUserRole,
  normalizeAppUserRole,
} from './appUserRoles';

interface Props {
  workboard: Workboard;
}

interface ApiError {
  response?: { data?: { detail?: string | { message?: string } } };
}

interface DatasetTableInfo {
  id: number;
  display_name: string;
  source_table_name: string;
  columns: { name: string; type?: string }[];
}

interface DatasetTableApi {
  id: number;
  display_name: string;
  source_table_name: string;
  columns_cache?: unknown;
}

interface AccessFieldSource {
  tableId: number;
  tableLabel: string;
  column: string;
  screenId: string;
  screenTitle: string;
}

interface AccessFieldOption {
  key: string;
  label: string;
  rawValue: unknown;
}

interface AccessFieldSpec {
  key: string;
  label: string;
  roles: string[];
  sources: AccessFieldSource[];
}

interface AccessFieldConfig extends AccessFieldSpec {
  options: AccessFieldOption[];
}

interface ContextRow {
  key: string;
  value: string;
}

const RESERVED_CONTEXT_KEYS = new Set(['username', 'role', 'full_name']);
const ACCESS_OPTION_PREVIEW_LIMIT = 200;

function getApiErrorMessage(err: unknown, fallback: string): string {
  const detail = (err as ApiError)?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object' && 'message' in detail) {
    return String((detail as { message: string }).message);
  }
  return fallback;
}

function columnsFromCache(cache: unknown): { name: string; type?: string }[] {
  const rows: unknown[] = Array.isArray(cache)
    ? cache
    : cache && typeof cache === 'object' && Array.isArray((cache as { columns?: unknown }).columns)
      ? (cache as { columns: unknown[] }).columns
      : [];
  return rows
    .filter((row): row is { name: unknown; type?: unknown } => Boolean(row && typeof row === 'object' && 'name' in row))
    .map((row) => ({
      name: String(row.name),
      type: row.type ? String(row.type) : undefined,
    }));
}

function collectContextKeySuggestions(workboard: Workboard): string[] {
  const seen = new Set<string>();
  const visit = (node: unknown) => {
    if (typeof node === 'string') {
      const matches = node.match(/\{\{\s*app_user\.([a-zA-Z0-9_]+)\s*\}\}/g);
      if (matches) {
        for (const match of matches) {
          const key = match.replace(/[{}\s]/g, '').replace(/^app_user\./, '');
          if (key && !RESERVED_CONTEXT_KEYS.has(key)) {
            seen.add(key);
          }
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === 'object') {
      for (const item of Object.values(node)) visit(item);
    }
  };
  visit(workboard.layout_json);
  return Array.from(seen).sort();
}

function matchAppUserPlaceholder(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^\{\{\s*app_user\.([a-zA-Z0-9_]+)\s*\}\}$/);
  if (!match) return null;
  const key = match[1];
  return RESERVED_CONTEXT_KEYS.has(key) ? null : key;
}

function makeAccessFieldLabel(key: string): string {
  return key
    .split('_')
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(' ');
}

function optionKeyForValue(value: unknown): string {
  if (value === null) return 'null:';
  if (value === undefined) return 'undefined:';
  if (typeof value === 'number') return `number:${value}`;
  if (typeof value === 'boolean') return `boolean:${value}`;
  return `string:${String(value)}`;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

function collectAccessFieldSpecs(
  workboard: Workboard,
  tables: DatasetTableInfo[],
): AccessFieldSpec[] {
  const tablesById = new Map(tables.map((table) => [table.id, table]));
  const layout = workboard.layout_json as {
    screens?: Array<Record<string, unknown>>;
    rls?: { app_user_rules?: Array<Record<string, unknown>> };
  } | null;
  const screens = Array.isArray(layout?.screens) ? layout!.screens! : [];
  const byKey = new Map<string, AccessFieldSpec>();

  const upsertRule = ({
    tableId,
    screenId,
    screenTitle,
    filterColumn,
    role,
    placeholderKey,
  }: {
    tableId: number;
    screenId: string;
    screenTitle: string;
    filterColumn: string;
    role: string;
    placeholderKey: string;
  }) => {
    const table = tablesById.get(tableId);
    const tableLabel = table
      ? `${table.display_name} (${table.source_table_name})`
      : `Table ${tableId}`;

    const existing = byKey.get(placeholderKey) || {
      key: placeholderKey,
      label: makeAccessFieldLabel(placeholderKey),
      roles: [],
      sources: [],
    };
    if (!existing.roles.includes(role)) {
      existing.roles.push(role);
    }
    if (
      !existing.sources.some(
        (source) =>
          source.tableId === tableId &&
          source.column === filterColumn &&
          source.screenId === screenId,
      )
    ) {
      existing.sources.push({
        tableId,
        tableLabel,
        column: filterColumn,
        screenId,
        screenTitle,
      });
    }
    byKey.set(placeholderKey, existing);
  };

  for (const rawScreen of screens) {
    if (!rawScreen || typeof rawScreen !== 'object') continue;
    const tableId = Number(rawScreen.table_id);
    if (!Number.isFinite(tableId) || tableId <= 0) continue;
    const screenId = String(rawScreen.id || '');
    const screenTitle = String(rawScreen.title || screenId || 'Screen');
    const rules = Array.isArray(rawScreen.rls) ? rawScreen.rls : [];

    for (const rawRule of rules) {
      if (!rawRule || typeof rawRule !== 'object') continue;
      const filterColumn = String((rawRule as { filter_column?: unknown }).filter_column || '').trim();
      if (!filterColumn) continue;
      const placeholderKey = matchAppUserPlaceholder((rawRule as { filter_value?: unknown }).filter_value);
      if (!placeholderKey) continue;
      const normalizedRole = normalizeAppUserRole(String((rawRule as { role?: unknown }).role || '')) || 'user';
      upsertRule({
        tableId,
        screenId,
        screenTitle,
        filterColumn,
        role: normalizedRole,
        placeholderKey,
      });
    }
  }

  const legacyRules = Array.isArray(layout?.rls?.app_user_rules)
    ? layout!.rls!.app_user_rules!
    : [];
  if (legacyRules.length > 0 && workboard.primary_table_id) {
    for (const rawRule of legacyRules) {
      if (!rawRule || typeof rawRule !== 'object') continue;
      const filterColumn = String((rawRule as { filter_column?: unknown }).filter_column || '').trim();
      if (!filterColumn) continue;
      const placeholderKey = matchAppUserPlaceholder((rawRule as { filter_value?: unknown }).filter_value);
      if (!placeholderKey) continue;
      const normalizedRole = normalizeAppUserRole(String((rawRule as { role?: unknown }).role || '')) || 'user';
      upsertRule({
        tableId: workboard.primary_table_id,
        screenId: 'legacy-rls',
        screenTitle: 'Legacy RLS',
        filterColumn,
        role: normalizedRole,
        placeholderKey,
      });
    }
  }

  return Array.from(byKey.values()).sort((left, right) => left.label.localeCompare(right.label));
}

async function loadDatasetTables(datasetId: number): Promise<DatasetTableInfo[]> {
  const response = await apiClient.get<DatasetTableApi[]>(`/datasets/${datasetId}/tables`);
  const rows = Array.isArray(response.data) ? response.data : [];
  return rows.map((table) => ({
    id: table.id,
    display_name: table.display_name,
    source_table_name: table.source_table_name,
    columns: columnsFromCache(table.columns_cache),
  }));
}

async function loadDistinctOptions(
  datasetId: number,
  source: AccessFieldSource,
): Promise<AccessFieldOption[]> {
  const response = await apiClient.post<{ rows?: Array<Record<string, unknown>> }>(
    `/datasets/${datasetId}/tables/${source.tableId}/preview`,
    { limit: ACCESS_OPTION_PREVIEW_LIMIT },
  );
  const rows = Array.isArray(response.data?.rows) ? response.data.rows : [];
  const seen = new Map<string, AccessFieldOption>();
  for (const row of rows) {
    const rawValue = row?.[source.column];
    if (rawValue === null || rawValue === undefined || rawValue === '') continue;
    const key = optionKeyForValue(rawValue);
    if (!seen.has(key)) {
      seen.set(key, {
        key,
        rawValue,
        label: displayValue(rawValue),
      });
    }
  }
  return Array.from(seen.values()).sort((left, right) => left.label.localeCompare(right.label));
}

function renderContextSummary(
  context: Record<string, unknown>,
  accessFields: AccessFieldConfig[],
): string {
  const entries = Object.entries(context || {});
  if (entries.length === 0) return '—';
  const accessKeySet = new Set(accessFields.map((field) => field.key));
  const accessParts = entries
    .filter(([key]) => accessKeySet.has(key))
    .map(([key, value]) => `${makeAccessFieldLabel(key)}=${displayValue(value)}`);
  const extraParts = entries
    .filter(([key]) => !accessKeySet.has(key))
    .map(([key, value]) => `${key}=${displayValue(value)}`);
  return [...accessParts, ...extraParts].join(', ');
}

function mergeInitialAccessValue(
  field: AccessFieldConfig,
  value: unknown,
): AccessFieldConfig {
  if (value === null || value === undefined || value === '') return field;
  const key = optionKeyForValue(value);
  if (field.options.some((option) => option.key === key)) return field;
  return {
    ...field,
    options: [{ key, label: displayValue(value), rawValue: value }, ...field.options],
  };
}

function isOwnerUsingDefaultPin(user: WorkboardAppUserResponse): boolean {
  return isOwnerAppUserRole(user.role) && Boolean(user.using_default_pin);
}

export default function WorkboardAppUsersTab({ workboard }: Props) {
  const [users, setUsers] = useState<WorkboardAppUserResponse[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingAccess, setLoadingAccess] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<WorkboardAppUserResponse | 'new' | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkboardAppUserResponse | null>(null);
  const [accessFields, setAccessFields] = useState<AccessFieldConfig[]>([]);

  const contextSuggestions = useMemo(
    () => collectContextKeySuggestions(workboard),
    [workboard],
  );

  const loadUsers = async () => {
    setLoadingUsers(true);
    setError(null);
    try {
      const rows = await workboardApi.listAppUsers(workboard.id);
      setUsers(rows);
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Không tải được danh sách user.'));
    } finally {
      setLoadingUsers(false);
    }
  };

  const loadAccessFields = async () => {
    setLoadingAccess(true);
    try {
      const tables = await loadDatasetTables(workboard.dataset_id);
      const specs = collectAccessFieldSpecs(workboard, tables);
      if (specs.length === 0) {
        setAccessFields([]);
        return;
      }

      const sourceOptions = new Map<string, AccessFieldOption[]>();
      const distinctJobs: Array<Promise<void>> = [];
      for (const spec of specs) {
        for (const source of spec.sources) {
          const cacheKey = `${source.tableId}:${source.column}`;
          if (sourceOptions.has(cacheKey)) continue;
          sourceOptions.set(cacheKey, []);
          distinctJobs.push(
            loadDistinctOptions(workboard.dataset_id, source)
              .then((options) => {
                sourceOptions.set(cacheKey, options);
              })
              .catch(() => {
                sourceOptions.set(cacheKey, []);
              }),
          );
        }
      }
      await Promise.all(distinctJobs);

      const nextFields: AccessFieldConfig[] = specs.map((spec) => {
        const dedupedOptions = new Map<string, AccessFieldOption>();
        for (const source of spec.sources) {
          const cacheKey = `${source.tableId}:${source.column}`;
          for (const option of sourceOptions.get(cacheKey) || []) {
            if (!dedupedOptions.has(option.key)) {
              dedupedOptions.set(option.key, option);
            }
          }
        }
        return {
          ...spec,
          options: Array.from(dedupedOptions.values()),
        };
      });
      setAccessFields(nextFields);
    } finally {
      setLoadingAccess(false);
    }
  };

  useEffect(() => {
    void loadUsers();
    void loadAccessFields();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workboard.id, workboard.dataset_id]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return users;
    return users.filter((user) =>
      [user.username, user.full_name, user.role]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  }, [users, search]);

  const ownersUsingDefaultPin = useMemo(
    () => users.filter((user) => isOwnerUsingDefaultPin(user)),
    [users],
  );

  return (
    <div className="flex h-full flex-col bg-surface-0">
      <div className="flex items-center gap-3 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2.5">
        <UserCircle2 className="h-4 w-4 text-text-tertiary" />
        <h2 className="text-sm font-medium text-text-primary">App users</h2>
        <span className="text-tiny text-text-tertiary">
          {users.length} {users.length === 1 ? 'user' : 'users'} đăng nhập được mini-app này
        </span>
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-tiny text-text-secondary">
          Role chuẩn: user / admin / owner
        </span>
        <div className="flex-1" />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-quaternary" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Tìm theo username, tên, role..."
            className="h-7 w-56 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 pl-7 pr-2 text-tiny"
          />
        </div>
        <Button size="sm" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>
          Thêm user
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {ownersUsingDefaultPin.length > 0 && (
          <div className="mb-4 rounded-md border border-danger/30 bg-danger/5 p-3 text-caption text-danger">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                Owner mặc định{' '}
                <strong>
                  {ownersUsingDefaultPin.map((user) => user.username).join(', ')}
                </strong>{' '}
                vẫn đang dùng PIN mặc định <strong>123456</strong>. Hãy đổi PIN trong mục sửa user.
              </div>
            </div>
          </div>
        )}

        {loadingUsers ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
          </div>
        ) : error ? (
          <div className="rounded-md border border-danger/30 bg-danger/5 p-3 text-caption text-danger">
            {error}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-1 p-8 text-center">
            <UserCircle2 className="mx-auto h-8 w-8 text-text-quaternary" />
            <p className="mt-2 text-caption text-text-secondary">
              {users.length === 0
                ? 'Chưa có user nào. Bấm "Thêm user" để tạo tài khoản đầu tiên.'
                : 'Không có user nào khớp tìm kiếm.'}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-[rgb(var(--border-line))] bg-surface-1">
            <table className="w-full text-caption">
              <thead className="border-b border-[rgb(var(--border-line))] bg-surface-2 text-tiny text-text-tertiary">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Username</th>
                  <th className="px-3 py-2 text-left font-medium">Full name</th>
                  <th className="px-3 py-2 text-left font-medium">Role</th>
                  <th className="px-3 py-2 text-left font-medium">Dataset access</th>
                  <th className="px-3 py-2 text-left font-medium">Active</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((user) => (
                  <tr
                    key={user.id}
                    className="border-b border-[rgb(var(--border-line))] last:border-b-0 hover:bg-surface-2"
                  >
                    <td className="px-3 py-2 font-medium text-text-primary">
                      <div className="flex items-center gap-1.5">
                        <span>{user.username}</span>
                        {isOwnerUsingDefaultPin(user) && (
                          <span
                            title="Owner này vẫn đang dùng PIN mặc định 123456"
                            className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-danger text-[10px] font-bold leading-none text-white"
                          >
                            !
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-text-secondary">{user.full_name || '—'}</td>
                    <td className="px-3 py-2 text-text-secondary">
                      {user.role ? (
                        <span className="inline-flex items-center rounded bg-surface-2 px-1.5 py-0.5 text-tiny">
                          {formatAppUserRoleLabel(user.role)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="max-w-[320px] px-3 py-2 text-tiny text-text-tertiary">
                      {renderContextSummary(user.context || {}, accessFields)}
                    </td>
                    <td className="px-3 py-2">
                      {user.active ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <span className="text-tiny text-text-tertiary">tắt</span>
                      )}
                      {!user.has_pin && (
                        <span
                          title="Chưa có PIN, admin cần reset trước khi user đăng nhập được"
                          className="ml-1.5 inline-flex rounded bg-warning/10 px-1.5 py-0.5 text-tiny text-warning"
                        >
                          chưa PIN
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => setEditing(user)}
                        className="mr-1 rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
                        title="Sửa"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setPendingDelete(user)}
                        className="rounded p-1 text-text-tertiary hover:bg-danger/10 hover:text-danger"
                        title="Xóa"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <AppUserEditModal
          workboardId={workboard.id}
          user={editing === 'new' ? null : editing}
          contextSuggestions={contextSuggestions}
          accessFields={accessFields}
          loadingAccess={loadingAccess}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void loadUsers();
          }}
        />
      )}

      {pendingDelete && (
        <Modal
          isOpen
          onClose={() => setPendingDelete(null)}
          title={`Xóa user "${pendingDelete.username}"?`}
          size="sm"
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setPendingDelete(null)}>
                Hủy
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={async () => {
                  try {
                    await workboardApi.deleteAppUser(workboard.id, pendingDelete.id);
                    toast.success('Đã xóa user');
                    setPendingDelete(null);
                    void loadUsers();
                  } catch (err) {
                    toast.error(getApiErrorMessage(err, 'Xóa thất bại.'));
                  }
                }}
              >
                Xóa
              </Button>
            </>
          }
        >
          <p className="text-body text-text-secondary">
            Tài khoản này sẽ không đăng nhập được nữa. Hành động này không thể hoàn tác.
          </p>
        </Modal>
      )}
    </div>
  );
}

function AppUserEditModal({
  workboardId,
  user,
  contextSuggestions,
  accessFields,
  loadingAccess,
  onClose,
  onSaved,
}: {
  workboardId: number;
  user: WorkboardAppUserResponse | null;
  contextSuggestions: string[];
  accessFields: AccessFieldConfig[];
  loadingAccess: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isCreate = user === null;
  const normalizedExistingRole = normalizeAppUserRole(user?.role) || 'user';
  const roleOptions = useMemo(
    () => buildAppUserRoleOptions([user?.role, ...accessFields.flatMap((field) => field.roles)]),
    [accessFields, user?.role],
  );
  const [username, setUsername] = useState(user?.username ?? '');
  const [fullName, setFullName] = useState(user?.full_name ?? '');
  const [role, setRole] = useState(normalizedExistingRole);
  const [active, setActive] = useState(user?.active ?? true);
  const [pin, setPin] = useState('');

  const effectiveAccessFields = useMemo(
    () =>
      accessFields.map((field) =>
        mergeInitialAccessValue(field, user?.context?.[field.key]),
      ),
    [accessFields, user?.context],
  );

  const accessKeySet = useMemo(
    () => new Set(effectiveAccessFields.map((field) => field.key)),
    [effectiveAccessFields],
  );

  const [selectedAccessValues, setSelectedAccessValues] = useState<Record<string, unknown>>(() => {
    const seed: Record<string, unknown> = {};
    for (const field of accessFields) {
      const value = user?.context?.[field.key];
      if (value !== null && value !== undefined && value !== '') {
        seed[field.key] = value;
      }
    }
    return seed;
  });

  const advancedSuggestions = useMemo(
    () => contextSuggestions.filter((key) => !accessKeySet.has(key)),
    [accessKeySet, contextSuggestions],
  );

  const [contextRows, setContextRows] = useState<ContextRow[]>(() => {
    const seed = Object.entries(user?.context ?? {})
      .filter(([key]) => !accessKeySet.has(key))
      .map(([key, value]) => ({
        key,
        value: typeof value === 'string' ? value : JSON.stringify(value),
      }));
    if (seed.length === 0 && advancedSuggestions.length > 0) {
      return advancedSuggestions.map((key) => ({ key, value: '' }));
    }
    for (const suggestion of advancedSuggestions) {
      if (!seed.some((row) => row.key === suggestion)) {
        seed.push({ key: suggestion, value: '' });
      }
    }
    return seed;
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedAccessValues((current) => {
      const next = { ...current };
      for (const field of effectiveAccessFields) {
        const existingValue = user?.context?.[field.key];
        if (
          next[field.key] === undefined &&
          existingValue !== null &&
          existingValue !== undefined &&
          existingValue !== ''
        ) {
          next[field.key] = existingValue;
        }
      }
      return next;
    });
  }, [effectiveAccessFields, user?.context]);

  const updateRow = (index: number, patch: Partial<ContextRow>) => {
    setContextRows((rows) => rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  };
  const addRow = () => setContextRows((rows) => [...rows, { key: '', value: '' }]);
  const removeRow = (index: number) =>
    setContextRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index));

  const handleSave = async () => {
    setError(null);
    if (!username.trim()) {
      setError('Username không được rỗng.');
      return;
    }
    if (isCreate && !pin) {
      setError('PIN bắt buộc khi tạo user mới.');
      return;
    }

    const context: Record<string, unknown> = {};
    for (const field of effectiveAccessFields) {
      const value = selectedAccessValues[field.key];
      if (value === null || value === undefined || value === '') continue;
      context[field.key] = value;
    }
    for (const row of contextRows) {
      const key = row.key.trim();
      if (!key) continue;
      context[key] = row.value;
    }

    setSubmitting(true);
    try {
      if (isCreate) {
        const payload: WorkboardAppUserCreate = {
          username: username.trim(),
          pin,
          full_name: fullName || null,
          role,
          active,
          context,
        };
        await workboardApi.createAppUser(workboardId, payload);
        toast.success('Đã tạo user');
      } else {
        const payload: WorkboardAppUserUpdate = {
          username: username.trim(),
          full_name: fullName || null,
          role,
          active,
          context,
        };
        if (pin) payload.pin = pin;
        await workboardApi.updateAppUser(workboardId, user!.id, payload);
        toast.success('Đã cập nhật user');
      }
      onSaved();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Lưu thất bại.'));
    } finally {
      setSubmitting(false);
    }
  };

  const selectedRoleInfo =
    APP_USER_ROLE_OPTIONS.find((option) => option.value === role) ||
    roleOptions.find((option) => option.value === role) ||
    APP_USER_ROLE_OPTIONS[0];

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={isCreate ? 'Tạo user mới' : `Sửa user "${user?.username}"`}
      size="md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Hủy
          </Button>
          <Button variant="primary" size="sm" onClick={handleSave} loading={submitting} disabled={submitting}>
            {isCreate ? 'Tạo' : 'Lưu'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-tiny font-medium text-text-secondary">Username *</span>
            <Input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="vd: cn01"
              autoFocus={isCreate}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-tiny font-medium text-text-secondary">
              {isCreate ? 'PIN *' : 'PIN (để trống = giữ nguyên)'}
            </span>
            <Input
              type="password"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              placeholder={isCreate ? 'PIN đăng nhập' : 'Đặt PIN mới...'}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-tiny font-medium text-text-secondary">Full name</span>
            <Input
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder="Nguyễn Văn A"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-tiny font-medium text-text-secondary">Role</span>
            <select
              value={role}
              onChange={(event) => setRole(event.target.value)}
              className="h-9 w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-3 text-caption"
            >
              {roleOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-tiny text-text-tertiary">{selectedRoleInfo.description}</p>
          </label>
        </div>

        <label className="flex items-center gap-2 text-caption text-text-secondary">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
            className="h-3.5 w-3.5"
          />
          Active (cho phép đăng nhập)
        </label>

        <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-3">
          <div className="mb-2">
            <h3 className="text-tiny font-medium text-text-secondary">Phân quyền theo dataset</h3>
            <p className="text-tiny text-text-tertiary">
              Các field bên dưới được lấy từ cấu hình RLS hiện có của workboard. Chọn trực tiếp từ dữ liệu thay vì nhập tay.
            </p>
            {isOwnerAppUserRole(role) && (
              <p className="mt-1 text-tiny text-success">
                Role owner có toàn quyền trong mini-app. Các field dưới đây chỉ là context bổ sung nếu cần.
              </p>
            )}
          </div>

          {loadingAccess ? (
            <div className="flex items-center gap-2 text-tiny text-text-tertiary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Đang tải access options từ dataset...
            </div>
          ) : effectiveAccessFields.length === 0 ? (
            <p className="text-tiny text-text-tertiary">
              Chưa phát hiện field phân quyền nào từ RLS. Bạn vẫn có thể dùng phần context bổ sung ở dưới.
            </p>
          ) : (
            <div className="space-y-3">
              {effectiveAccessFields.map((field) => {
                const currentValue = selectedAccessValues[field.key];
                const selectValue =
                  currentValue === null || currentValue === undefined || currentValue === ''
                    ? ''
                    : optionKeyForValue(currentValue);
                return (
                  <label key={field.key} className="block">
                    <span className="mb-1 block text-tiny font-medium text-text-secondary">
                      {field.label}
                    </span>
                    {field.options.length > 0 ? (
                      <select
                        value={selectValue}
                        onChange={(event) => {
                          const selected = field.options.find((option) => option.key === event.target.value);
                          setSelectedAccessValues((current) => ({
                            ...current,
                            [field.key]: selected?.rawValue ?? '',
                          }));
                        }}
                        className="h-9 w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-3 text-caption"
                      >
                        <option value="">— Chọn giá trị —</option>
                        {field.options.map((option) => (
                          <option key={option.key} value={option.key}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Input
                        value={displayValue(currentValue)}
                        onChange={(event) =>
                          setSelectedAccessValues((current) => ({
                            ...current,
                            [field.key]: event.target.value,
                          }))
                        }
                        placeholder={`Nhập ${field.label.toLowerCase()}`}
                      />
                    )}
                    <p className="mt-1 text-tiny text-text-tertiary">
                      Dùng cho role: {field.roles.map((roleValue) => formatAppUserRoleLabel(roleValue)).join(', ')}
                    </p>
                    <p className="text-tiny text-text-quaternary">
                      Nguồn: {field.sources.map((source) => `${source.screenTitle} → ${source.column}`).join(' | ')}
                    </p>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-tiny font-medium text-text-secondary">
              Context bổ sung (advanced)
            </span>
            <button
              type="button"
              onClick={addRow}
              className="inline-flex items-center gap-1 text-tiny text-brand hover:underline"
            >
              <Plus className="h-3 w-3" /> Thêm key
            </button>
          </div>
          {contextRows.length === 0 ? (
            <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-1 p-2 text-tiny text-text-tertiary">
              Không có context bổ sung.
            </p>
          ) : (
            <div className="space-y-1">
              {contextRows.map((row, index) => (
                <div key={index} className="flex items-center gap-1.5">
                  <Input
                    value={row.key}
                    onChange={(event) => updateRow(index, { key: event.target.value })}
                    placeholder="key"
                    className="flex-1"
                  />
                  <Input
                    value={row.value}
                    onChange={(event) => updateRow(index, { value: event.target.value })}
                    placeholder="value"
                    className="flex-1"
                  />
                  <button
                    onClick={() => removeRow(index)}
                    className="rounded p-1 text-text-tertiary hover:bg-danger/10 hover:text-danger"
                    title="Xóa row"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {advancedSuggestions.length > 0 && (
            <p className="mt-1 text-tiny text-text-tertiary">
              Gợi ý từ layout: {advancedSuggestions.map((key) => (
                <code key={key} className="mx-0.5 rounded bg-surface-2 px-1">{key}</code>
              ))}
            </p>
          )}
        </div>

        {error && (
          <p className="rounded-md border border-danger/30 bg-danger/5 p-2 text-caption text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
