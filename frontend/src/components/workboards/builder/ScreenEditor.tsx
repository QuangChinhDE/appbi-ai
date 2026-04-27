/**
 * ScreenEditor — center pane of the builder. Switches editor by screen kind.
 */
'use client';

import React from 'react';
import type { ScreenSpec } from './types';
import FormScreenEditor from './FormScreenEditor';
import ListScreenEditor from './ListScreenEditor';
import DocScreenEditor from './DocScreenEditor';

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
}

export default function ScreenEditor({
  screen,
  allScreens,
  tables,
  tablesLoading,
  onChange,
}: Props) {
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <ScreenHeader screen={screen} tables={tables} onChange={onChange} />

      {screen.kind === 'form' && (
        <FormScreenEditor
          screen={screen}
          allScreens={allScreens}
          tables={tables}
          tablesLoading={tablesLoading}
          onChange={onChange}
        />
      )}
      {screen.kind === 'list' && (
        <ListScreenEditor
          screen={screen}
          allScreens={allScreens}
          tables={tables}
          onChange={onChange}
        />
      )}
      {screen.kind === 'doc' && (
        <DocScreenEditor screen={screen} tables={tables} onChange={onChange} />
      )}
    </div>
  );
}

function ScreenHeader({
  screen,
  tables,
  onChange,
}: {
  screen: ScreenSpec;
  tables: DatasetTableInfo[];
  onChange: (next: ScreenSpec) => void;
}) {
  const tableCols = tables.find((t) => t.id === screen.table_id)?.columns ?? [];

  return (
    <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
      <h2 className="mb-3 text-caption font-emphasis uppercase tracking-wider text-text-quaternary">
        Screen — chung
      </h2>
      <div className="grid grid-cols-2 gap-3">
        <Lbl label="ID (không gian)">
          <input
            value={screen.id}
            onChange={(e) => onChange({ ...screen, id: e.target.value.replace(/\s+/g, '-') })}
            className={INPUT}
          />
        </Lbl>
        <Lbl label="Tiêu đề">
          <input
            value={screen.title}
            onChange={(e) => onChange({ ...screen, title: e.target.value })}
            className={INPUT}
          />
        </Lbl>
        <Lbl label="Icon (lucide name)">
          <input
            value={screen.icon || ''}
            onChange={(e) => onChange({ ...screen, icon: e.target.value })}
            className={INPUT}
            placeholder="ClipboardEdit, ListChecks, FileText..."
          />
        </Lbl>
        <Lbl label="Hiện trên nav?">
          <select
            value={screen.show_in_nav === false ? 'no' : 'yes'}
            onChange={(e) =>
              onChange({ ...screen, show_in_nav: e.target.value === 'yes' })
            }
            className={INPUT}
          >
            <option value="yes">Có</option>
            <option value="no">Không (chỉ truy cập bằng action)</option>
          </select>
        </Lbl>
        <Lbl label="Roles được xem (rỗng = mọi role)">
          <input
            value={(screen.visible_for_roles || []).join(', ')}
            onChange={(e) =>
              onChange({
                ...screen,
                visible_for_roles: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            className={INPUT}
            placeholder="vd: worker, team_lead"
          />
        </Lbl>
        {screen.kind !== 'doc' && (
          <Lbl label="Bảng dữ liệu">
            <select
              value={screen.table_id ?? ''}
              onChange={(e) =>
                onChange({
                  ...screen,
                  table_id: e.target.value ? Number(e.target.value) : null,
                })
              }
              className={INPUT}
            >
              <option value="">— chọn bảng —</option>
              {tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.display_name} ({t.source_table_name})
                </option>
              ))}
            </select>
          </Lbl>
        )}
        <Lbl label="Mô tả ngắn (hiển thị trên screen)">
          <textarea
            value={screen.description || ''}
            onChange={(e) => onChange({ ...screen, description: e.target.value })}
            rows={2}
            className={INPUT}
          />
        </Lbl>
        <Lbl label="Primary key (ngăn cách bằng dấu phẩy)">
          <input
            value={(screen.primary_key_columns || []).join(', ')}
            onChange={(e) =>
              onChange({
                ...screen,
                primary_key_columns: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            className={INPUT}
            placeholder={
              tableCols.length ? `vd: ${tableCols[0]?.name || 'id'}` : 'vd: shift_id'
            }
          />
        </Lbl>
      </div>
    </div>
  );
}

export const INPUT =
  'w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2.5 py-1.5 text-caption focus:border-brand focus:outline-none';

export function Lbl({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-tiny font-emphasis text-text-secondary">
        {label}
      </span>
      {children}
    </label>
  );
}
