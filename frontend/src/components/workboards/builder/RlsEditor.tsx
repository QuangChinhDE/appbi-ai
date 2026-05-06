/**
 * RlsEditor — per-screen, per-role row-level rules.
 *
 * Convention enforced here:
 *   - "owner" never appears in the role dropdown — owners are full-access
 *     by definition (see backend roles.is_owner_role).
 *   - Selecting "admin" auto-checks `unrestricted` and locks the filter
 *     fields. Admins are operations users; restricting their data view
 *     by row is rarely what people want and the backend treats them as
 *     unrestricted by default anyway.
 *   - Default new rule role is "user" with `{{app_user.username}}` as the
 *     filter value, which is the common case.
 */
'use client';

import React from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { buildAppUserRoleOptions, normalizeAppUserRole } from './appUserRoles';
import {
  BUILDER_GRID_2,
  BuilderActionButton,
  BuilderIconButton,
  BuilderSubsection,
} from './BuilderChrome';
import { FixedExpressionInput, type SelectOption } from './BuilderValueControls';
import type { ScreenRlsRuleSpec, ScreenSpec } from './types';
import { INPUT, Lbl } from './ScreenEditor';

const RLS_FILTER_VAR_OPTIONS: SelectOption[] = [
  { value: '{{app_user.username}}', label: 'User đang đăng nhập (username)' },
  { value: '{{app_user.full_name}}', label: 'User đang đăng nhập (họ tên)' },
  { value: '{{app_user.role}}', label: 'Vai trò user đang đăng nhập' },
];

interface DatasetTableInfo {
  id: number;
  display_name: string;
  source_table_name: string;
  columns: { name: string; type?: string }[];
}

export default function RlsEditor({
  screen,
  tables,
  onChange,
}: {
  screen: ScreenSpec;
  tables: DatasetTableInfo[];
  onChange: (next: ScreenSpec) => void;
}) {
  const rules = screen.rls || [];
  const tableCols = tables.find((t) => t.id === screen.table_id)?.columns || [];

  const update = (idx: number, patch: Partial<ScreenRlsRuleSpec>) => {
    const next = [...rules];
    next[idx] = { ...next[idx], ...patch };
    onChange({ ...screen, rls: next });
  };
  const add = () => {
    const fresh: ScreenRlsRuleSpec = {
      role: 'user',
      filter_column: null,
      filter_value: '{{app_user.username}}',
      can_create: true,
      can_update: true,
      can_delete: false,
    };
    onChange({ ...screen, rls: [...rules, fresh] });
  };
  const remove = (idx: number) =>
    onChange({ ...screen, rls: rules.filter((_, i) => i !== idx) });

  return (
    <div>
      <div className="mb-3 rounded-md border border-info/20 bg-info/5 p-2.5 text-tiny text-text-secondary">
        <p className="font-emphasis text-text-primary">Quy tắc xem dữ liệu theo vai trò</p>
        <p className="mt-0.5">
          Mỗi quy tắc cho một <em>vai trò</em> (user / admin / …) biết được phép
          xem, thêm, sửa, xoá những dòng nào. Mặc định: Owner và Admin thấy mọi
          dòng. Vai trò khác chỉ thấy đúng những dòng mà <em>cột lọc</em> khớp
          với <em>giá trị so khớp</em>.
        </p>
        <p className="mt-1 text-[11px] text-text-tertiary">
          Ví dụ: cột lọc <code className="font-mono">created_by</code> + giá trị{' '}
          <code className="font-mono">{'{{app_user.username}}'}</code> = mỗi
          user chỉ thấy đúng các dòng do mình tạo.
        </p>
      </div>

      <div className="space-y-2">
        {rules.map((r, idx) => (
          <RuleCard
            key={idx}
            rule={r}
            tableCols={tableCols}
            onChange={(patch) => update(idx, patch)}
            onRemove={() => remove(idx)}
          />
        ))}
        {rules.length === 0 && (
          <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] p-3 text-center text-tiny text-text-tertiary">
            Chưa có quy tắc nào. Mặc định: chỉ Owner / Admin thấy mọi dòng; User
            không thấy gì cho đến khi bạn thêm rule.
          </p>
        )}
      </div>

      <BuilderActionButton
        onClick={add}
        variant="brand"
        className="mt-3 w-full justify-center"
      >
        <Plus className="h-3.5 w-3.5" />
        Thêm quy tắc
      </BuilderActionButton>
    </div>
  );
}

function RuleCard({
  rule,
  tableCols,
  onChange,
  onRemove,
}: {
  rule: ScreenRlsRuleSpec;
  tableCols: { name: string; type?: string }[];
  onChange: (patch: Partial<ScreenRlsRuleSpec>) => void;
  onRemove: () => void;
}) {
  // Build options without `owner` — owner is full-access and editing a rule
  // for it would be misleading.
  const roleOptions = buildAppUserRoleOptions([rule.role]).filter(
    (option) => option.value !== 'owner',
  );
  const normalizedRole = normalizeAppUserRole(rule.role) || 'user';
  const isAdmin = normalizedRole === 'admin';
  // Admin is treated as unrestricted regardless of stored value, so the UI
  // mirrors that: checkbox is on and locked, filter fields are hidden.
  const effectiveUnrestricted = isAdmin ? true : !!rule.unrestricted;

  const handleRoleChange = (nextRole: string) => {
    const patch: Partial<ScreenRlsRuleSpec> = { role: nextRole };
    if (normalizeAppUserRole(nextRole) === 'admin') {
      patch.unrestricted = true;
      patch.filter_column = null;
    }
    onChange(patch);
  };

  return (
    <BuilderSubsection title="Quy tắc" className="p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <select
          value={normalizedRole}
          onChange={(e) => handleRoleChange(e.target.value)}
          className={`${INPUT} flex-1`}
          style={{ fontWeight: 600 }}
        >
          {roleOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <BuilderIconButton onClick={onRemove} title="Xoá quy tắc" variant="danger">
          <Trash2 className="h-3.5 w-3.5 text-danger" />
        </BuilderIconButton>
      </div>

      {isAdmin ? (
        <p className="mb-2 rounded-md border border-info/20 bg-info/5 px-2 py-1.5 text-tiny text-text-secondary">
          Admin mặc định thấy mọi dòng — không cần đặt cột lọc.
        </p>
      ) : (
        <label className="mb-2 flex items-center gap-1.5 text-tiny text-text-secondary">
          <input
            type="checkbox"
            checked={effectiveUnrestricted}
            onChange={(e) => onChange({ unrestricted: e.target.checked })}
            className="h-3 w-3"
          />
          Không giới hạn (xem mọi dòng)
        </label>
      )}

      {!effectiveUnrestricted && (
        <>
          <div className={BUILDER_GRID_2}>
            <Lbl label="Cột lọc">
              <select
                value={rule.filter_column || ''}
                onChange={(e) => onChange({ filter_column: e.target.value || null })}
                className={INPUT}
              >
                <option value="">— chọn cột —</option>
                {tableCols.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Lbl>
            <Lbl label="Giá trị so khớp">
              <FixedExpressionInput
                value={rule.filter_value}
                onChange={(next) => onChange({ filter_value: next })}
                fixedPlaceholder="vd: HN, branch-01, …"
                expressionPlaceholder="vd: {{app_user.username}}"
                expressionOptions={RLS_FILTER_VAR_OPTIONS}
              />
            </Lbl>
          </div>
          {rule.filter_column && rule.filter_value ? (
            <p className="mt-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-[11px] text-text-secondary">
              Vai trò <strong>{normalizedRole}</strong> chỉ thấy các dòng có{' '}
              <code className="font-mono text-text-primary">
                {rule.filter_column}
              </code>{' '}
              ={' '}
              <code className="font-mono text-text-primary">
                {String(rule.filter_value)}
              </code>
              .
            </p>
          ) : null}
        </>
      )}

      <div className="mt-2">
        <div className="mb-1 text-[11px] font-emphasis text-text-tertiary">
          Vai trò này được phép làm gì với các dòng thấy được?
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-tiny text-text-secondary">
          <label className="flex items-center gap-1" title="Cho phép thêm dòng mới">
            <input
              type="checkbox"
              checked={rule.can_create !== false}
              onChange={(e) => onChange({ can_create: e.target.checked })}
              className="h-3 w-3"
            />
            Thêm dòng
          </label>
          <label className="flex items-center gap-1" title="Cho phép sửa dòng">
            <input
              type="checkbox"
              checked={rule.can_update !== false}
              onChange={(e) => onChange({ can_update: e.target.checked })}
              className="h-3 w-3"
            />
            Sửa dòng
          </label>
          <label className="flex items-center gap-1" title="Cho phép xoá dòng">
            <input
              type="checkbox"
              checked={!!rule.can_delete}
              onChange={(e) => onChange({ can_delete: e.target.checked })}
              className="h-3 w-3"
            />
            Xoá dòng
          </label>
        </div>
      </div>

      <div className="mt-2">
        <Lbl label="Cột chỉ đọc (vai trò này không sửa được)">
          <input
            value={(rule.readonly_columns || []).join(', ')}
            onChange={(e) =>
              onChange({
                readonly_columns: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            className={INPUT}
            placeholder="Tên cột, cách nhau dấu phẩy — vd: id, created_at"
          />
        </Lbl>
      </div>
    </BuilderSubsection>
  );
}
