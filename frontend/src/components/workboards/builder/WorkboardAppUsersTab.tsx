/**
 * WorkboardAppUsersTab manages end-user accounts for a workboard mini-app.
 *
 * Main UX goals:
 * - fixed product roles: user / admin / owner
 * - explicit mini-app hierarchy: owner full access, scoped admin/user branches
 * - dataset-backed selects for non-hierarchy access keys discovered from RLS
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
  type WorkboardAccessAudit,
  type AccessAuditEntry,
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
import { MultiColumnPicker, SingleColumnPicker } from './BuilderValueControls';
import { useI18n } from '@/providers/LanguageProvider';

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

type AccessIssueKind =
  | 'missing_column'
  | 'empty_column'
  | 'missing_miniapp_user_column'
  | 'legacy_rule_column';

interface AccessIssue {
  fieldKey: string;
  fieldLabel: string;
  tableId: number;
  tableLabel: string;
  column: string;
  screenTitle: string;
  kind: AccessIssueKind;
}

interface ContextRow {
  key: string;
  value: string;
}

const MINIAPP_USER_COLUMN = 'miniapp_user';

const HIERARCHY_CONTEXT_KEYS = new Set([
  'manager_username',
  'manager_usernames',
  'reports_to',
  'scope_usernames',
  'managed_usernames',
  'visible_usernames',
  'scope_admin_usernames',
  'managed_admins',
  'managed_admin_usernames',
  'direct_report_usernames',
]);
const RESERVED_CONTEXT_KEYS = new Set([
  'username',
  'role',
  'full_name',
  ...HIERARCHY_CONTEXT_KEYS,
]);
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
  if (Array.isArray(value)) return value.map((item) => displayValue(item)).filter(Boolean).join(', ');
  if (typeof value === 'string') return value;
  return String(value);
}

function stringListFromContext(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return Array.from(
      new Set(value.map((item) => String(item).trim()).filter(Boolean)),
    );
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return stringListFromContext(parsed);
      } catch {
        // Fall through to comma parsing.
      }
    }
    return Array.from(
      new Set(trimmed.split(',').map((part) => part.trim()).filter(Boolean)),
    );
  }
  const text = String(value).trim();
  return text ? [text] : [];
}

function firstStringFromContext(...values: unknown[]): string {
  for (const value of values) {
    const [first] = stringListFromContext(value);
    if (first) return first;
  }
  return '';
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
    .filter(([key]) => !accessKeySet.has(key) && !HIERARCHY_CONTEXT_KEYS.has(key))
    .map(([key, value]) => `${key}=${displayValue(value)}`);
  const parts = [...accessParts, ...extraParts];
  return parts.length > 0 ? parts.join(', ') : '—';
}

function renderHierarchySummary(
  context: Record<string, unknown>,
  directReports: string[] = [],
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const manager = firstStringFromContext(context.manager_username, context.reports_to);
  const adminBranches = stringListFromContext(
    context.scope_admin_usernames ?? context.managed_admins ?? context.managed_admin_usernames,
  );
  const explicitUsers = stringListFromContext(
    context.scope_usernames ?? context.managed_usernames ?? context.visible_usernames,
  );
  const parts: string[] = [];
  if (manager) parts.push(t('workboards.users.reportsTo', { username: manager }));
  if (directReports.length > 0) {
    parts.push(t('workboards.users.directUsers', { users: directReports.join(', ') }));
  }
  if (adminBranches.length > 0) {
    parts.push(t('workboards.users.adminBranches', { users: adminBranches.join(', ') }));
  }
  if (explicitUsers.length > 0) {
    parts.push(t('workboards.users.extraUsers', { users: explicitUsers.join(', ') }));
  }
  return parts.join(' | ') || t('workboards.users.selfOnly');
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
  const { t } = useI18n();
  const [users, setUsers] = useState<WorkboardAppUserResponse[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingAccess, setLoadingAccess] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<WorkboardAppUserResponse | 'new' | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkboardAppUserResponse | null>(null);
  const [accessFields, setAccessFields] = useState<AccessFieldConfig[]>([]);
  const [accessIssues, setAccessIssues] = useState<AccessIssue[]>([]);
  const [audit, setAudit] = useState<WorkboardAccessAudit | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);

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
      setError(getApiErrorMessage(err, 'Could not load users.'));
    } finally {
      setLoadingUsers(false);
    }
  };

  const loadAccessFields = async () => {
    setLoadingAccess(true);
    try {
      const tables = await loadDatasetTables(workboard.dataset_id);
      const tablesById = new Map(tables.map((table) => [table.id, table]));
      const specs = collectAccessFieldSpecs(workboard, tables);

      if (specs.length === 0) {
        setAccessFields([]);
        setAccessIssues([]);
        return;
      }

      const sourceOptions = new Map<string, AccessFieldOption[]>();
      const distinctJobs: Array<Promise<void>> = [];
      for (const spec of specs) {
        for (const source of spec.sources) {
          const cacheKey = `${source.tableId}:${source.column}`;
          if (sourceOptions.has(cacheKey)) continue;
          const tableMeta = tablesById.get(source.tableId);
          const columnExists = tableMeta?.columns.some(
            (col) => col.name === source.column,
          );
          sourceOptions.set(cacheKey, []);
          if (!columnExists) continue;
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

      const issues: AccessIssue[] = [];
      const seenIssue = new Set<string>();
      for (const spec of specs) {
        for (const source of spec.sources) {
          const tableMeta = tablesById.get(source.tableId);
          const columnExists = tableMeta?.columns.some(
            (col) => col.name === source.column,
          );
          const kind: AccessIssueKind | null = !columnExists
            ? 'missing_column'
            : (sourceOptions.get(`${source.tableId}:${source.column}`) || []).length === 0
              ? 'empty_column'
              : null;
          if (!kind) continue;
          const dedupeKey = `${spec.key}:${source.tableId}:${source.column}:${kind}`;
          if (seenIssue.has(dedupeKey)) continue;
          seenIssue.add(dedupeKey);
          issues.push({
            fieldKey: spec.key,
            fieldLabel: spec.label,
            tableId: source.tableId,
            tableLabel: source.tableLabel,
            column: source.column,
            screenTitle: source.screenTitle,
            kind,
          });
        }
      }

      setAccessFields(nextFields);
      setAccessIssues(issues);
    } finally {
      setLoadingAccess(false);
    }
  };

  const loadAudit = async () => {
    setAuditLoading(true);
    try {
      const result = await workboardApi.getAccessAudit(workboard.id);
      setAudit(result);
    } catch (err) {
      console.warn('Failed to load access audit', err);
      setAudit(null);
    } finally {
      setAuditLoading(false);
    }
  };

  const handleToggleShared = async (tableId: number, shared: boolean) => {
    try {
      await workboardApi.setTableMiniappShare(workboard.id, tableId, shared);
      await loadAudit();
      toast.success(shared ? t('workboards.users.sharedMarked') : t('workboards.users.sharedUnmarked'));
    } catch (err) {
      toast.error(getApiErrorMessage(err, t('workboards.users.sharedUpdateFailed')));
    }
  };

  useEffect(() => {
    void loadUsers();
    void loadAccessFields();
    void loadAudit();
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
  const directReportsByUsername = useMemo(() => {
    const next = new Map<string, string[]>();
    for (const row of users) {
      const manager = firstStringFromContext(row.context?.manager_username, row.context?.reports_to);
      if (!manager) continue;
      next.set(manager, [...(next.get(manager) || []), row.username]);
    }
    return next;
  }, [users]);

  return (
    <div className="flex h-full flex-col bg-surface-0">
      <div className="flex items-center gap-3 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2.5">
        <UserCircle2 className="h-4 w-4 text-text-tertiary" />
        <h2 className="text-sm font-medium text-text-primary">{t('workboards.users.title')}</h2>
        <span className="text-caption text-text-tertiary">
          {t(users.length === 1 ? 'workboards.users.countOne' : 'workboards.users.countMany', { count: users.length })}
        </span>
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-caption text-text-secondary">
          {t('workboards.users.rolesHint')}
        </span>
        <div className="flex-1" />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-quaternary" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('workboards.users.searchPlaceholder')}
            className="h-7 w-56 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 pl-7 pr-2 text-caption"
          />
        </div>
        <Button size="sm" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>
          {t('workboards.users.addUser')}
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {audit && (
          <AccessAuditBanner
            audit={audit}
            datasetId={workboard.dataset_id}
            onToggleShared={handleToggleShared}
            onRefresh={loadAudit}
            loading={auditLoading}
          />
        )}

        {accessIssues.length > 0 && (
          <AccessIssuesBanner
            datasetId={workboard.dataset_id}
            issues={accessIssues}
          />
        )}

        {ownersUsingDefaultPin.length > 0 && (
          <div className="mb-4 rounded-md border border-danger/30 bg-danger/5 p-3 text-caption text-danger">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                {t('workboards.users.defaultOwnerPrefix')}{' '}
                <strong>
                  {ownersUsingDefaultPin.map((user) => user.username).join(', ')}
                </strong>{' '}
                {t('workboards.users.defaultOwnerMiddle')} <strong>123456</strong>. {t('workboards.users.defaultOwnerSuffix')}
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
                ? t('workboards.users.empty')
                : t('workboards.users.noMatches')}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-[rgb(var(--border-line))] bg-surface-1">
            <table className="w-full text-caption">
              <thead className="border-b border-[rgb(var(--border-line))] bg-surface-2 text-caption text-text-tertiary">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">{t('workboards.users.username')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('workboards.users.fullName')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('workboards.users.role')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('workboards.users.miniappScope')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('workboards.users.rlsContext')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('workboards.users.active')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('workboards.users.actions')}</th>
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
                            title={t('workboards.users.defaultPinTitle')}
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
                        <span className="inline-flex items-center rounded bg-surface-2 px-1.5 py-0.5 text-caption">
                          {formatAppUserRoleLabel(user.role)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="max-w-[280px] px-3 py-2 text-caption text-text-tertiary">
                      {isOwnerAppUserRole(user.role)
                        ? t('workboards.users.fullAccess')
                        : renderHierarchySummary(
                            user.context || {},
                            directReportsByUsername.get(user.username) || [],
                            t,
                          )}
                    </td>
                    <td className="max-w-[320px] px-3 py-2 text-caption text-text-tertiary">
                      {renderContextSummary(user.context || {}, accessFields)}
                    </td>
                    <td className="px-3 py-2">
                      {user.active ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <span className="text-caption text-text-tertiary">{t('workboards.users.off')}</span>
                      )}
                      {!user.has_pin && (
                        <span
                          title={t('workboards.users.noPinTitle')}
                          className="ml-1.5 inline-flex rounded bg-warning/10 px-1.5 py-0.5 text-caption text-warning"
                        >
                          {t('workboards.users.noPin')}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => setEditing(user)}
                        className="mr-1 rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
                        title={t('workboards.users.edit')}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setPendingDelete(user)}
                        className="rounded p-1 text-text-tertiary hover:bg-danger/10 hover:text-danger"
                        title={t('workboards.users.delete')}
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
          datasetId={workboard.dataset_id}
          user={editing === 'new' ? null : editing}
          contextSuggestions={contextSuggestions}
          accessFields={accessFields}
          accessIssues={accessIssues}
          loadingAccess={loadingAccess}
          existingUsers={users}
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
          title={t('workboards.users.deleteTitle', { username: pendingDelete.username })}
          size="sm"
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setPendingDelete(null)}>
                {t('workboards.users.cancel')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={async () => {
                  try {
                    await workboardApi.deleteAppUser(workboard.id, pendingDelete.id);
                    toast.success(t('workboards.users.deletedToast'));
                    setPendingDelete(null);
                    void loadUsers();
                  } catch (err) {
                    toast.error(getApiErrorMessage(err, t('workboards.users.deleteFailed')));
                  }
                }}
              >
                {t('workboards.users.delete')}
              </Button>
            </>
          }
        >
          <p className="text-body text-text-secondary">
            {t('workboards.users.deleteDescription')}
          </p>
        </Modal>
      )}
    </div>
  );
}

function AppUserEditModal({
  workboardId,
  datasetId,
  user,
  contextSuggestions,
  accessFields,
  accessIssues,
  loadingAccess,
  existingUsers,
  onClose,
  onSaved,
}: {
  workboardId: number;
  datasetId: number;
  user: WorkboardAppUserResponse | null;
  contextSuggestions: string[];
  accessFields: AccessFieldConfig[];
  accessIssues: AccessIssue[];
  loadingAccess: boolean;
  existingUsers: WorkboardAppUserResponse[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
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
  const [managerUsername, setManagerUsername] = useState(() =>
    firstStringFromContext(user?.context?.manager_username, user?.context?.reports_to),
  );
  const [scopeAdminUsernames, setScopeAdminUsernames] = useState<string[]>(() =>
    stringListFromContext(
      user?.context?.scope_admin_usernames ??
        user?.context?.managed_admins ??
        user?.context?.managed_admin_usernames,
    ),
  );
  const [scopeUsernames, setScopeUsernames] = useState<string[]>(() =>
    stringListFromContext(
      user?.context?.scope_usernames ??
        user?.context?.managed_usernames ??
        user?.context?.visible_usernames,
    ),
  );

  const editingUsername = user?.username ?? '';
  const managerOptions = useMemo(
    () =>
      existingUsers
        .filter((row) => row.username && row.username !== editingUsername)
        .map((row) => row.username),
    [existingUsers, editingUsername],
  );
  const adminBranchOptions = useMemo(
    () =>
      existingUsers
        .filter((row) => {
          if (!row.username || row.username === editingUsername) return false;
          const normalized = normalizeAppUserRole(row.role);
          return normalized === 'admin' || normalized === 'owner';
        })
        .map((row) => row.username),
    [existingUsers, editingUsername],
  );
  const userLabelByUsername = useMemo(() => {
    const map: Record<string, string> = {};
    for (const row of existingUsers) {
      if (!row.username) continue;
      const roleLabel = row.role ? formatAppUserRoleLabel(row.role) : '';
      map[row.username] = row.full_name
        ? `${row.username} — ${row.full_name}${roleLabel ? ` (${roleLabel})` : ''}`
        : roleLabel
          ? `${row.username} (${roleLabel})`
          : row.username;
    }
    return map;
  }, [existingUsers]);

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
    () =>
      contextSuggestions.filter(
        (key) => !accessKeySet.has(key) && !HIERARCHY_CONTEXT_KEYS.has(key),
      ),
    [accessKeySet, contextSuggestions],
  );

  const [contextRows, setContextRows] = useState<ContextRow[]>(() => {
    const seed = Object.entries(user?.context ?? {})
      .filter(([key]) => !accessKeySet.has(key) && !HIERARCHY_CONTEXT_KEYS.has(key))
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
      setError(t('workboards.users.usernameRequired'));
      return;
    }
    if (isCreate && !pin) {
      setError(t('workboards.users.pinRequired'));
      return;
    }
    const cleanUsername = username.trim();
    const cleanManagerUsername = managerUsername.trim();
    if (cleanManagerUsername && cleanManagerUsername === cleanUsername) {
      setError(t('workboards.users.managerCannotSelf'));
      return;
    }

    const context: Record<string, unknown> = {};
    if (cleanManagerUsername) {
      context.manager_username = cleanManagerUsername;
    }
    if (scopeAdminUsernames.length > 0) {
      context.scope_admin_usernames = scopeAdminUsernames;
    }
    if (scopeUsernames.length > 0) {
      context.scope_usernames = scopeUsernames;
    }
    for (const field of effectiveAccessFields) {
      const value = selectedAccessValues[field.key];
      if (value === null || value === undefined || value === '') continue;
      context[field.key] = value;
    }
    for (const row of contextRows) {
      const key = row.key.trim();
      if (!key) continue;
      if (RESERVED_CONTEXT_KEYS.has(key) || accessKeySet.has(key)) continue;
      context[key] = row.value;
    }

    setSubmitting(true);
    try {
      if (isCreate) {
        const payload: WorkboardAppUserCreate = {
          username: cleanUsername,
          pin,
          full_name: fullName || null,
          role,
          active,
          context,
        };
        await workboardApi.createAppUser(workboardId, payload);
        toast.success(t('workboards.users.createdToast'));
      } else {
        const payload: WorkboardAppUserUpdate = {
          username: cleanUsername,
          full_name: fullName || null,
          role,
          active,
          context,
        };
        if (pin) payload.pin = pin;
        await workboardApi.updateAppUser(workboardId, user!.id, payload);
        toast.success(t('workboards.users.updatedToast'));
      }
      onSaved();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, t('workboards.users.saveFailed')));
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
      title={isCreate ? t('workboards.users.createTitle') : t('workboards.users.editTitle', { username: user?.username || '' })}
      size="xl"
      contentClassName="h-[80vh]"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('workboards.users.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={handleSave} loading={submitting} disabled={submitting}>
            {isCreate ? t('workboards.users.create') : t('workboards.users.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-caption font-medium text-text-secondary">{t('workboards.users.usernameRequiredLabel')}</span>
            <Input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder={t('workboards.users.usernamePlaceholder')}
              autoFocus={isCreate}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-caption font-medium text-text-secondary">
              {isCreate ? t('workboards.users.pinCreateLabel') : t('workboards.users.pinEditLabel')}
            </span>
            <Input
              type="password"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              placeholder={isCreate ? t('workboards.users.pinCreatePlaceholder') : t('workboards.users.pinEditPlaceholder')}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-caption font-medium text-text-secondary">{t('workboards.users.fullName')}</span>
            <Input
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder="Jane Doe"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-caption font-medium text-text-secondary">{t('workboards.users.role')}</span>
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
            <p className="mt-1 text-caption text-text-tertiary">{selectedRoleInfo.description}</p>
          </label>
        </div>

        <label className="flex items-center gap-2 text-caption text-text-secondary">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
            className="h-3.5 w-3.5"
          />
          {t('workboards.users.activeAllowSignin')}
        </label>

        <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-3">
          <div className="mb-2">
            <h3 className="text-caption font-medium text-text-secondary">{t('workboards.users.hierarchyTitle')}</h3>
            <p className="text-caption text-text-tertiary">
              {t('workboards.users.hierarchyDescription')}
            </p>
            {isOwnerAppUserRole(role) && (
              <p className="mt-1 text-caption text-success">
                {t('workboards.users.ownerIgnoresHierarchy')}
              </p>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-caption font-medium text-text-secondary">
                {t('workboards.users.directManager')}
              </span>
              <SingleColumnPicker
                sourceColumns={managerOptions}
                value={managerUsername || null}
                onChange={(next) => setManagerUsername(next || '')}
                placeholder={
                  managerOptions.length === 0
                    ? t('workboards.users.noOtherUsers')
                    : t('workboards.users.pickManager')
                }
                emptyHint={t('workboards.users.noMatchingUsers')}
                labelByValue={userLabelByUsername}
              />
              <p className="mt-1 text-caption text-text-tertiary">
                {t('workboards.users.directManagerHint')}
              </p>
            </label>
            <label className="block">
              <span className="mb-1 block text-caption font-medium text-text-secondary">
                {t('workboards.users.adminBranchesLabel')}
              </span>
              <MultiColumnPicker
                sourceColumns={adminBranchOptions}
                value={scopeAdminUsernames}
                onChange={setScopeAdminUsernames}
                placeholder={
                  adminBranchOptions.length === 0
                    ? t('workboards.users.noAdminsOwners')
                    : t('workboards.users.pickAdminBranches')
                }
                emptyHint={t('workboards.users.noMatchingAdmins')}
              />
              <p className="mt-1 text-caption text-text-tertiary">
                {t('workboards.users.adminBranchesHint')}
              </p>
            </label>
            <label className="block">
              <span className="mb-1 block text-caption font-medium text-text-secondary">
                {t('workboards.users.extraVisibleUsernames')}
              </span>
              <MultiColumnPicker
                sourceColumns={managerOptions}
                value={scopeUsernames}
                onChange={setScopeUsernames}
                placeholder={
                  managerOptions.length === 0
                    ? t('workboards.users.noOtherUsers')
                    : t('workboards.users.pickExtraUsers')
                }
                emptyHint={t('workboards.users.noMatchingUsers')}
              />
              <p className="mt-1 text-caption text-text-tertiary">
                {t('workboards.users.extraUsersHint')}
              </p>
            </label>
          </div>
        </div>

        <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-3">
          <div className="mb-2">
            <h3 className="text-caption font-medium text-text-secondary">{t('workboards.users.rlsFieldsTitle')}</h3>
            <p className="text-caption text-text-tertiary">
              {t('workboards.users.rlsFieldsDescription')}
            </p>
            {isOwnerAppUserRole(role) && (
              <p className="mt-1 text-caption text-success">
                {t('workboards.users.ownerOptionalContext')}
              </p>
            )}
          </div>

          {accessIssues.length > 0 && (
            <div className="mb-3">
              <AccessIssuesBanner datasetId={datasetId} issues={accessIssues} />
            </div>
          )}

          {loadingAccess ? (
            <div className="flex items-center gap-2 text-caption text-text-tertiary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('workboards.users.loadingAccessOptions')}
            </div>
          ) : effectiveAccessFields.length === 0 ? (
            <p className="text-caption text-text-tertiary">
              {t('workboards.users.noAccessFields')}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {effectiveAccessFields.map((field) => {
                const currentValue = selectedAccessValues[field.key];
                const selectValue =
                  currentValue === null || currentValue === undefined || currentValue === ''
                    ? ''
                    : optionKeyForValue(currentValue);
                return (
                  <label key={field.key} className="block">
                    <span className="mb-1 block text-caption font-medium text-text-secondary">
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
                        <option value="">{t('workboards.users.pickValue')}</option>
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
                        placeholder={t('workboards.users.enterField', { label: field.label.toLowerCase() })}
                      />
                    )}
                    <p className="mt-1 text-caption text-text-tertiary">
                      {t('workboards.users.usedByRole')} {field.roles.map((roleValue) => formatAppUserRoleLabel(roleValue)).join(', ')}
                    </p>
                    <p className="text-caption text-text-quaternary">
                      {t('workboards.users.sourceLabel')} {field.sources.map((source) => `${source.screenTitle} → ${source.column}`).join(' | ')}
                    </p>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-caption font-medium text-text-secondary">
              {t('workboards.users.additionalContext')}
            </span>
            <button
              type="button"
              onClick={addRow}
              className="inline-flex items-center gap-1 text-caption text-brand hover:underline"
            >
              <Plus className="h-3 w-3" /> {t('workboards.users.addKey')}
            </button>
          </div>
          {contextRows.length === 0 ? (
            <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-1 p-2 text-caption text-text-tertiary">
              {t('workboards.users.noAdditionalContext')}
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
                    title={t('workboards.users.deleteRow')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {advancedSuggestions.length > 0 && (
            <p className="mt-1 text-caption text-text-tertiary">
              {t('workboards.users.suggestedFromLayout')} {advancedSuggestions.map((key) => (
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

function AccessIssueDescription({ row }: { row: AccessIssue }) {
  const code = (text: string) => (
    <code className="rounded bg-surface-2 px-1 text-text-secondary">{text}</code>
  );
  switch (row.kind) {
    case 'missing_miniapp_user_column':
      return (
        <>
          Thiếu cột {code(MINIAPP_USER_COLUMN)} — bảng này được dùng làm nguồn
          cho screen {code(row.screenTitle)}. Thêm cột để mini-app tự lọc theo
          username (giá trị từng dòng = username của app user sở hữu).
        </>
      );
    case 'legacy_rule_column':
      return (
        <>
          Rule RLS cũ đang lọc theo cột {code(row.column)} thay vì{' '}
          {code(MINIAPP_USER_COLUMN)} ({row.screenTitle}). Convention mới yêu
          cầu mọi bảng fact lọc qua {code(MINIAPP_USER_COLUMN)}; rule này sẽ
          không nhận được giá trị mặc định khi tạo user.
        </>
      );
    case 'missing_column':
      return (
        <>
          Thiếu cột {code(row.column)} — RLS placeholder{' '}
          {code(`{{app_user.${row.fieldKey}}}`)} không có chỗ để lọc (
          {row.screenTitle}).
        </>
      );
    case 'empty_column':
      return (
        <>
          Cột {code(row.column)} chưa có giá trị nào — app user không có lựa
          chọn để gán quyền ({row.screenTitle}).
        </>
      );
    default:
      return null;
  }
}

function AccessAuditBanner({
  audit,
  datasetId,
  onToggleShared,
  onRefresh,
  loading,
}: {
  audit: WorkboardAccessAudit;
  datasetId: number;
  onToggleShared: (tableId: number, shared: boolean) => void;
  onRefresh: () => void;
  loading: boolean;
}) {
  const { tables, summary } = audit;
  const unknowns = tables.filter((t) => t.mode === 'unknown');
  const joinedThrough = tables.filter((t) => t.mode === 'joined_through');
  const legacy = tables.filter((t) => t.legacy_rules.length > 0);

  if (tables.length === 0) return null;

  const hasBlocker = unknowns.length > 0;
  const tone = hasBlocker
    ? 'border-danger/30 bg-danger/5'
    : joinedThrough.length + legacy.length > 0
      ? 'border-warning/30 bg-warning/5'
      : 'border-success/30 bg-success/5';

  return (
    <div className={`mb-4 rounded-md border p-3 text-caption ${tone}`}>
      <div className="flex items-start gap-2">
        {hasBlocker ? (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
        ) : (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        )}
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-3">
            <span className="font-medium text-text-primary">
              Phân quyền dữ liệu
            </span>
            <span className="text-text-tertiary">
              {summary.per_user} per-user · {summary.joined_through} qua quan hệ ·{' '}
              {summary.shared} shared · {summary.unknown} chưa rõ
            </span>
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="ml-auto text-info hover:underline disabled:opacity-50"
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          {tables.map((entry) => (
            <AccessAuditRow
              key={entry.table_id}
              entry={entry}
              datasetId={datasetId}
              onToggleShared={onToggleShared}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function AccessAuditRow({
  entry,
  datasetId,
  onToggleShared,
}: {
  entry: AccessAuditEntry;
  datasetId: number;
  onToggleShared: (tableId: number, shared: boolean) => void;
}) {
  const modeStyle: Record<typeof entry.mode, string> = {
    per_user: 'bg-success/10 text-success',
    joined_through: 'bg-info/10 text-info',
    shared: 'bg-surface-2 text-text-secondary',
    unknown: 'bg-danger/10 text-danger',
  };
  const modeLabel: Record<typeof entry.mode, string> = {
    per_user: 'per-user',
    joined_through: 'qua quan hệ',
    shared: 'shared',
    unknown: 'chưa rõ',
  };
  return (
    <div className="rounded bg-surface-0/60 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-text-primary">{entry.table_name}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${modeStyle[entry.mode]}`}>
          {modeLabel[entry.mode]}
        </span>
        <span className="text-text-tertiary">{entry.reason}</span>
        <a
          href={`/datasets/${datasetId}?table=${entry.table_id}&tab=schema`}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1 rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-0.5 text-caption text-text-secondary hover:border-brand/40 hover:text-brand"
        >
          Mở dataset
        </a>
        {entry.mode === 'unknown' && (
          <button
            type="button"
            onClick={() => onToggleShared(entry.table_id, true)}
            className="rounded border border-warning/30 bg-warning/5 px-2 py-0.5 text-caption text-warning hover:bg-warning/10"
            title="Đánh dấu bảng là shared / dim public"
          >
            Đánh dấu shared
          </button>
        )}
        {entry.mode === 'shared' && (
          <button
            type="button"
            onClick={() => onToggleShared(entry.table_id, false)}
            className="rounded border border-[rgb(var(--border-line))] px-2 py-0.5 text-caption text-text-secondary hover:bg-surface-2"
          >
            Bỏ shared
          </button>
        )}
      </div>
      {entry.chain && entry.chain.length > 0 && (
        <div className="mt-1 text-caption text-text-tertiary">
          Chain:{' '}
          {entry.chain.map((hop, idx) => (
            <span key={idx}>
              {idx > 0 ? ' → ' : ''}
              <code className="rounded bg-surface-2 px-1">{hop.from_view}.{hop.from_columns.join('+')}</code>
              <span> = </span>
              <code className="rounded bg-surface-2 px-1">{hop.to_view}.{hop.to_columns.join('+')}</code>
            </span>
          ))}
        </div>
      )}
      {entry.legacy_rules.length > 0 && (
        <div className="mt-1 text-caption text-warning">
          Legacy rule:{' '}
          {entry.legacy_rules.map((r, idx) => (
            <span key={idx}>
              {idx > 0 ? '; ' : ''}
              {r.screen_title}: filter_column =
              <code className="ml-1 rounded bg-surface-2 px-1 text-text-secondary">{r.filter_column}</code>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function AccessIssuesBanner({
  datasetId,
  issues,
}: {
  datasetId: number;
  issues: AccessIssue[];
}) {
  const grouped = useMemo(() => {
    const map = new Map<number, { tableLabel: string; rows: AccessIssue[] }>();
    for (const issue of issues) {
      const bucket = map.get(issue.tableId) ?? {
        tableLabel: issue.tableLabel,
        rows: [] as AccessIssue[],
      };
      bucket.rows.push(issue);
      map.set(issue.tableId, bucket);
    }
    return Array.from(map.entries()).map(([tableId, value]) => ({
      tableId,
      tableLabel: value.tableLabel,
      rows: value.rows,
    }));
  }, [issues]);

  const hasBlocker = issues.some(
    (issue) =>
      issue.kind === 'missing_column' ||
      issue.kind === 'missing_miniapp_user_column',
  );
  const tone = hasBlocker
    ? 'border-danger/30 bg-danger/5 text-danger'
    : 'border-warning/30 bg-warning/5 text-warning';

  return (
    <div className={`mb-4 rounded-md border p-3 text-caption ${tone}`}>
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="font-medium">
            Source dữ liệu chưa sẵn sàng để phân quyền theo app user
          </div>
          <p className="text-text-secondary">
            Mỗi bảng fact dùng trong screen phải có cột{' '}
            <code className="rounded bg-surface-2 px-1 text-text-secondary">
              miniapp_user
            </code>{' '}
            để mini-app tự lọc theo username của app user (dim không cần — dim
            kế thừa quyền qua join). Thiếu cột → mini-app sẽ trả 0 dòng cho
            user không phải owner.
          </p>
          <ul className="space-y-1.5">
            {grouped.map((group) => (
              <li key={group.tableId} className="rounded bg-surface-0/60 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-text-primary">
                    {group.tableLabel}
                  </span>
                  <a
                    href={`/datasets/${datasetId}?table=${group.tableId}&tab=schema`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-0.5 text-caption text-text-secondary hover:border-brand/40 hover:text-brand"
                  >
                    Mở dataset
                  </a>
                </div>
                <ul className="mt-1 space-y-0.5 text-text-tertiary">
                  {group.rows.map((row) => (
                    <li key={`${row.fieldKey}:${row.column}:${row.kind}`}>
                      <AccessIssueDescription row={row} />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
