/**
 * ScreenEditor — center pane of the builder.
 *
 * Three tabs (Form / Quyền / Nâng cao). Screen-level meta (title, description,
 * show-in-nav) lives in a popover triggered from the sidebar gear icon, not
 * here. The active screen kind drives the Form-tab content; Data-table
 * picking moved into that tab too so users don't bounce between tabs.
 */
'use client';

import React, { useState } from 'react';

import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { BUILDER_GRID_2, BuilderSection } from './BuilderChrome';
import { CheckboxMultiSelect } from './BuilderValueControls';
import { buildAppUserRoleOptions, normalizeAppUserRole } from './appUserRoles';
import type { ScreenSpec } from './types';
import FormScreenEditor from './FormScreenEditor';
import ListScreenEditor from './ListScreenEditor';
import DocScreenEditor from './DocScreenEditor';
import RlsEditor from './RlsEditor';
import { useBuilderMode, type BuilderMode } from './useBuilderMode';

interface DatasetTableInfo {
  id: number;
  display_name: string;
  source_table_name: string;
  columns: { name: string; type?: string }[];
}

interface Props {
  screen: ScreenSpec;
  allScreens: ScreenSpec[];
  tables: DatasetTableInfo[];
  tablesLoading: boolean;
  onChange: (next: ScreenSpec) => void;
  focusFieldColumn?: string | null;
  onFocusFieldHandled?: () => void;
}

type TabId = 'form' | 'permission' | 'advanced';

const KIND_LABELS: Record<ScreenSpec['kind'], string> = {
  form: 'Form',
  list: 'Danh sách',
  doc: 'Báo cáo',
  dashboard: 'Dashboard',
};

export default function ScreenEditor({
  screen,
  allScreens,
  tables,
  tablesLoading,
  onChange,
  focusFieldColumn,
  onFocusFieldHandled,
}: Props) {
  const [tab, setTab] = useState<TabId>('form');
  const [mode, setMode] = useBuilderMode();

  React.useEffect(() => {
    if (focusFieldColumn) setTab('form');
  }, [focusFieldColumn]);

  const screenLabel = KIND_LABELS[screen.kind];
  const fieldCount = screen.kind === 'form' ? (screen.form?.fields?.length ?? 0) : undefined;
  const columnCount = screen.kind === 'list' ? (screen.list?.columns?.length ?? 0) : undefined;
  const blockCount = screen.kind === 'doc' ? (screen.doc?.blocks?.length ?? 0) : undefined;
  const ruleCount = (screen.rls || []).length;

  const items: TabItem<TabId>[] = [
    {
      key: 'form',
      label: screenLabel,
      badge: badge(fieldCount ?? columnCount ?? blockCount),
    },
    { key: 'permission', label: 'Quyền', badge: badge(ruleCount) },
    { key: 'advanced', label: 'Nâng cao' },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex items-end justify-between gap-3">
        <Tabs<TabId> items={items} value={tab} onChange={setTab} variant="underline" />
        <ModeToggle mode={mode} onChange={setMode} />
      </div>

      {tab === 'form' && (
        <>
          {screen.kind === 'form' && (
            <FormScreenEditor
              screen={screen}
              allScreens={allScreens}
              tables={tables}
              tablesLoading={tablesLoading}
              onChange={onChange}
              mode={mode}
              focusFieldColumn={focusFieldColumn}
              onFocusFieldHandled={onFocusFieldHandled}
            />
          )}
          {screen.kind === 'list' && (
            <ListScreenEditor
              screen={screen}
              allScreens={allScreens}
              tables={tables}
              onChange={onChange}
              mode={mode}
            />
          )}
          {screen.kind === 'doc' && (
            <DocScreenEditor
              screen={screen}
              tables={tables}
              onChange={onChange}
              mode={mode}
            />
          )}
        </>
      )}

      {tab === 'permission' && (
        <PermissionTab screen={screen} tables={tables} mode={mode} onChange={onChange} />
      )}

      {tab === 'advanced' && (
        <AdvancedTab screen={screen} tables={tables} onChange={onChange} />
      )}
    </div>
  );
}

function badge(count?: number): React.ReactNode {
  if (!count) return undefined;
  return (
    <span className="ml-1 rounded-full bg-surface-2 px-1.5 text-tiny text-text-tertiary">
      {count}
    </span>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: BuilderMode;
  onChange: (next: BuilderMode) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-0.5">
      {(['basic', 'advanced'] as BuilderMode[]).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={
            mode === m
              ? 'rounded px-2 py-0.5 text-tiny font-medium text-text-primary bg-surface-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]'
              : 'rounded px-2 py-0.5 text-tiny font-medium text-text-tertiary hover:text-text-primary'
          }
          title={m === 'basic' ? 'Chế độ Cơ bản' : 'Chế độ Nâng cao'}
        >
          {m === 'basic' ? 'Cơ bản' : 'Nâng cao'}
        </button>
      ))}
    </div>
  );
}

// ── Permission tab ────────────────────────────────────────────────────────

function PermissionTab({
  screen,
  tables,
  mode,
  onChange,
}: {
  screen: ScreenSpec;
  tables: DatasetTableInfo[];
  mode: BuilderMode;
  onChange: (next: ScreenSpec) => void;
}) {
  const roleOptions = buildAppUserRoleOptions(screen.visible_for_roles).filter(
    (option) => option.value !== 'owner',
  );
  const selectedRoles = new Set(
    (screen.visible_for_roles || [])
      .map((role) => normalizeAppUserRole(role) || role)
      .filter(Boolean),
  );

  return (
    <div className="space-y-4">
      {/* Behaviour banner — what each role gets by default */}
      <div className="rounded-lg border border-info/20 bg-info/5 px-3 py-2.5 text-tiny text-text-secondary">
        <div className="font-medium text-text-primary">Mặc định theo vai trò</div>
        <ul className="mt-1 space-y-0.5">
          <li>
            • <span className="font-medium">Owner</span> — luôn toàn quyền, bỏ qua mọi rule. Không cần cấu hình.
          </li>
          <li>
            • <span className="font-medium">Admin</span> — thấy mọi dòng dữ liệu. Chỉ thêm rule khi muốn giới hạn riêng.
          </li>
          <li>
            • <span className="font-medium">User</span> — bị giới hạn theo rule bên dưới (mặc định không thấy gì nếu không có rule cho User).
          </li>
        </ul>
      </div>

      <BuilderSection
        title="Quy tắc theo vai trò"
        description="Mỗi rule = một vai trò + phạm vi xem/sửa/xoá. Owner bị ẩn vì luôn full quyền."
      >
        <RlsEditor screen={screen} tables={tables} onChange={onChange} />
      </BuilderSection>

      {mode === 'advanced' && (
        <BuilderSection
          title="Vai trò được vào màn hình (advanced)"
          description="Để trống = ai đăng nhập cũng vào được (đúng với rule ở trên). Chọn cụ thể nếu muốn giới hạn ngay từ menu."
        >
          <CheckboxMultiSelect
            options={roleOptions}
            selectedValues={Array.from(selectedRoles)}
            onChange={(values) => onChange({ ...screen, visible_for_roles: values })}
            columns={3}
          />
        </BuilderSection>
      )}
    </div>
  );
}

// ── Advanced tab ──────────────────────────────────────────────────────────

function AdvancedTab({
  screen,
  tables,
  onChange,
}: {
  screen: ScreenSpec;
  tables: DatasetTableInfo[];
  onChange: (next: ScreenSpec) => void;
}) {
  const tableCols = tables.find((table) => table.id === screen.table_id)?.columns ?? [];

  return (
    <div className="space-y-4">
      <BuilderSection
        title="Định danh & icon"
        description="Các thuộc tính kỹ thuật. Chỉ chỉnh khi bạn biết mình đang làm gì."
      >
        <div className={BUILDER_GRID_2}>
          <Field label="ID (slug nội bộ)">
            <input
              value={screen.id}
              onChange={(event) =>
                onChange({ ...screen, id: event.target.value.replace(/\s+/g, '-') })
              }
              className={INPUT}
            />
          </Field>
          <Field label="Tên icon (Lucide)">
            <input
              value={screen.icon || ''}
              onChange={(event) => onChange({ ...screen, icon: event.target.value })}
              className={INPUT}
              placeholder="ClipboardEdit, ListChecks, FileText..."
            />
          </Field>
        </div>
      </BuilderSection>

      <BuilderSection
        title="Cột định danh (primary key)"
        description="Cột dùng để xác định 1 dòng duy nhất. Chỉ cần đặt khi muốn cho phép sửa/xoá dòng."
      >
        {tableCols.length > 0 ? (
          <CheckboxMultiSelect
            options={tableCols.map((column) => ({
              value: column.name,
              label: column.name,
              description: column.type,
            }))}
            selectedValues={screen.primary_key_columns || []}
            onChange={(primaryKeyColumns) =>
              onChange({ ...screen, primary_key_columns: primaryKeyColumns })
            }
            columns={2}
          />
        ) : (
          <input
            value={(screen.primary_key_columns || []).join(', ')}
            onChange={(event) =>
              onChange({
                ...screen,
                primary_key_columns: event.target.value
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              })
            }
            className={INPUT}
            placeholder="vd: shift_id"
          />
        )}
      </BuilderSection>
    </div>
  );
}

// ── Shared input class + label helpers (re-exported for sub-editors) ──────

export const INPUT =
  'min-h-9 w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-3 py-2 text-caption text-text-primary placeholder:text-text-quaternary shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] transition-colors focus:border-brand focus:outline-none';

export function Lbl({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={className || 'block'}>
      <span className="mb-1 block text-tiny font-emphasis text-text-secondary">
        {label}
      </span>
      {children}
    </label>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={className || 'block'}>
      <span className="mb-1 block text-tiny font-emphasis text-text-secondary">
        {label}
      </span>
      {children}
    </label>
  );
}
