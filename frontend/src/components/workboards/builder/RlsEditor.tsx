/**
 * RlsEditor — per-screen RLS rules. Lives in the right rail of the
 * builder so the rule and the screen it applies to are visible together.
 */
'use client';

import React from 'react';
import { Plus, Shield, Trash2 } from 'lucide-react';

import type { ScreenRlsRuleSpec, ScreenSpec } from './types';
import { INPUT, Lbl } from './ScreenEditor';

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
      role: 'worker',
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
      <div className="mb-3 flex items-center gap-1.5">
        <Shield className="h-3.5 w-3.5 text-text-tertiary" />
        <h3 className="text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
          RLS — Quyền theo role
        </h3>
      </div>

      <p className="mb-3 text-tiny text-text-tertiary">
        Mỗi role config riêng phạm vi xem / sửa / xoá. Worker giả mạo cột{' '}
        <code className="bg-surface-2 px-1">filter_column</code> sẽ bị backend
        force về username thật trên insert.
      </p>

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
            Chưa có rule nào.
            <br />
            Mặc định: tất cả role logged-in đều thấy mọi dòng.
          </p>
        )}
      </div>

      <button
        onClick={add}
        className="mt-3 flex w-full items-center justify-center gap-1 rounded-md border border-brand px-2 py-1.5 text-tiny text-brand hover:bg-brand/10"
      >
        <Plus className="h-3 w-3" />
        Thêm rule
      </button>
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
  return (
    <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-0 p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <input
          value={rule.role}
          onChange={(e) => onChange({ role: e.target.value })}
          placeholder="role"
          className={`${INPUT} flex-1`}
          style={{ fontWeight: 600 }}
        />
        <button onClick={onRemove} className="ml-1 rounded p-1 hover:bg-danger/10">
          <Trash2 className="h-3 w-3 text-danger" />
        </button>
      </div>

      <label className="mb-2 flex items-center gap-1 text-tiny text-text-secondary">
        <input
          type="checkbox"
          checked={!!rule.unrestricted}
          onChange={(e) => onChange({ unrestricted: e.target.checked })}
          className="h-3 w-3"
        />
        Không giới hạn (xem mọi dòng)
      </label>

      {!rule.unrestricted && (
        <div className="grid grid-cols-2 gap-1.5">
          <Lbl label="Cột lọc">
            <select
              value={rule.filter_column || ''}
              onChange={(e) => onChange({ filter_column: e.target.value || null })}
              className={INPUT}
            >
              <option value="">— chọn —</option>
              {tableCols.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </Lbl>
          <Lbl label="Giá trị">
            <input
              value={String(rule.filter_value ?? '')}
              onChange={(e) => onChange({ filter_value: e.target.value })}
              className={INPUT}
              placeholder="vd: {{app_user.username}}"
            />
          </Lbl>
        </div>
      )}

      <div className="mt-2 grid grid-cols-3 gap-1 text-tiny text-text-secondary">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={rule.can_create !== false}
            onChange={(e) => onChange({ can_create: e.target.checked })}
            className="h-3 w-3"
          />
          create
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={rule.can_update !== false}
            onChange={(e) => onChange({ can_update: e.target.checked })}
            className="h-3 w-3"
          />
          update
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={!!rule.can_delete}
            onChange={(e) => onChange({ can_delete: e.target.checked })}
            className="h-3 w-3"
          />
          delete
        </label>
      </div>

      <div className="mt-1.5">
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
          placeholder="Cột readonly (nếu có) — vd: id, created_at"
        />
      </div>
    </div>
  );
}
