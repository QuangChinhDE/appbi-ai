/**
 * ScreenEditor — center pane of the builder.
 *
 * Three tabs (Form / Permissions / Advanced). Screen-level meta (title, description,
 * show-in-nav) lives in a popover triggered from the sidebar gear icon, not
 * here. The active screen kind drives the Form-tab content; Data-table
 * picking moved into that tab too so users don't bounce between tabs.
 */
'use client';

import React, { useState } from 'react';

import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { BUILDER_GRID_2, BuilderSection } from './BuilderChrome';
import { CheckboxMultiSelect, MultiColumnPicker } from './BuilderValueControls';
import { buildAppUserRoleOptions, normalizeAppUserRole } from './appUserRoles';
import type { ScreenSpec } from './types';
import FormScreenEditor from './FormScreenEditor';
import ListScreenEditor from './ListScreenEditor';
import DocScreenEditor from './DocScreenEditor';
import DashboardScreenEditor from './DashboardScreenEditor';
import GridScreenEditor from './GridScreenEditor';
import RlsEditor from './RlsEditor';

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
  workboardId?: number;
  onChange: (next: ScreenSpec) => void;
  focusFieldColumn?: string | null;
  onFocusFieldHandled?: () => void;
}

type TabId = 'form' | 'permission' | 'advanced';

const KIND_LABELS: Record<ScreenSpec['kind'], string> = {
  form: 'Form',
  list: 'List',
  doc: 'Document',
  dashboard: 'Dashboard',
  grid: 'Grid',
};

export default function ScreenEditor({
  screen,
  allScreens,
  tables,
  tablesLoading,
  workboardId,
  onChange,
  focusFieldColumn,
  onFocusFieldHandled,
}: Props) {
  const [tab, setTab] = useState<TabId>('form');

  React.useEffect(() => {
    if (focusFieldColumn) setTab('form');
  }, [focusFieldColumn]);

  const screenLabel = KIND_LABELS[screen.kind];
  const fieldCount = screen.kind === 'form' ? (screen.form?.fields?.length ?? 0) : undefined;
  const columnCount = screen.kind === 'list' ? (screen.list?.columns?.length ?? 0) : undefined;
  const blockCount = screen.kind === 'doc' ? (screen.doc?.blocks?.length ?? 0) : undefined;
  const gridColCount = screen.kind === 'grid' ? (screen.grid?.columns?.length ?? 0) : undefined;
  const ruleCount = (screen.rls || []).length;

  const items: TabItem<TabId>[] = [
    {
      key: 'form',
      label: screenLabel,
      badge: badge(fieldCount ?? columnCount ?? blockCount ?? gridColCount),
    },
    { key: 'permission', label: 'Permissions', badge: badge(ruleCount) },
    { key: 'advanced', label: 'Advanced' },
  ];

  return (
    // No max-width here — the outer pane (WorkboardBuilder) handles
    // sensible centering with max-w-screen-2xl so this layout fills the
    // available pane width when the Live Preview is collapsed.
    <div className="w-full space-y-4">
      <Tabs<TabId> items={items} value={tab} onChange={setTab} variant="underline" />

      {tab === 'form' && (
        <>
          {screen.kind === 'form' && (
            <FormScreenEditor
              screen={screen}
              allScreens={allScreens}
              tables={tables}
              tablesLoading={tablesLoading}
              onChange={onChange}
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
            />
          )}
          {screen.kind === 'doc' && (
            <DocScreenEditor
              screen={screen}
              tables={tables}
              workboardId={workboardId}
              onChange={onChange}
            />
          )}
          {screen.kind === 'dashboard' && (
            <DashboardScreenEditor screen={screen} onChange={onChange} />
          )}
          {screen.kind === 'grid' && (
            <GridScreenEditor screen={screen} tables={tables} onChange={onChange} />
          )}
        </>
      )}

      {tab === 'permission' && (
        <PermissionTab screen={screen} tables={tables} onChange={onChange} />
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
    <span className="ml-1 rounded-full bg-surface-2 px-1.5 text-micro text-text-tertiary">
      {count}
    </span>
  );
}


// ── Permission tab ────────────────────────────────────────────────────────

function PermissionTab({
  screen,
  tables,
  onChange,
}: {
  screen: ScreenSpec;
  tables: DatasetTableInfo[];
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
      <div className="rounded-lg border border-info/20 bg-info/5 px-3 py-2.5 text-caption text-text-secondary">
        <div className="font-medium text-text-primary">Defaults by role</div>
        <ul className="mt-1 space-y-0.5">
          <li>
            • <span className="font-medium">Owner</span> — always full access, ignores all rules. No config needed.
          </li>
          <li>
            • <span className="font-medium">Admin</span> — sees every row. Add a rule only to narrow Admin access.
          </li>
          <li>
            • <span className="font-medium">User</span> — restricted by the rules below (no User rule = User sees nothing).
          </li>
        </ul>
      </div>

      {screen.kind === 'dashboard' ? (
        <BuilderSection
          title="Role rules"
          description="Embedded dashboards use the Dashboard module's own filter / permission pipeline — no row-level RLS here. Restrict who can open the screen below."
        >
          <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2.5 text-caption text-text-tertiary">
            RLS is not used for Dashboard screens.
          </p>
        </BuilderSection>
      ) : (
        <BuilderSection
          title="Role rules"
          description="Each rule = one role + view/edit/delete scope. Owner is hidden because it always has full access."
        >
          <RlsEditor screen={screen} tables={tables} onChange={onChange} />
        </BuilderSection>
      )}

      <BuilderSection
        title="Roles allowed to open this screen"
        description="Empty = every signed-in user can open it (subject to the rules above). Pick specific roles to gate at the menu level."
      >
        <CheckboxMultiSelect
          options={roleOptions}
          selectedValues={Array.from(selectedRoles)}
          onChange={(values) => onChange({ ...screen, visible_for_roles: values })}
          columns={3}
        />
      </BuilderSection>
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
        title="Identifier & icon"
        description="Technical attributes. Only touch these if you know what you're doing."
      >
        <div className={BUILDER_GRID_2}>
          <Field label="ID (internal slug)">
            <input
              value={screen.id}
              onChange={(event) =>
                onChange({ ...screen, id: event.target.value.replace(/\s+/g, '-') })
              }
              className={INPUT}
            />
          </Field>
          <Field label="Icon name (Lucide)">
            <input
              value={screen.icon || ''}
              onChange={(event) => onChange({ ...screen, icon: event.target.value })}
              className={INPUT}
              placeholder="ClipboardEdit, ListChecks, FileText…"
            />
          </Field>
        </div>
      </BuilderSection>

      <BuilderSection
        title="Primary key columns"
        description="Columns that uniquely identify a row. Required only if you want to allow edit / delete."
      >
        {tableCols.length > 0 ? (
          <MultiColumnPicker
            sourceColumns={tableCols.map((column) => column.name)}
            value={screen.primary_key_columns || []}
            onChange={(primaryKeyColumns) =>
              onChange({ ...screen, primary_key_columns: primaryKeyColumns })
            }
            placeholder="Pick primary-key columns…"
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
            placeholder="e.g. shift_id"
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
    <label className={`block ${className ?? ''}`}>
      <span className="mb-1 block text-caption font-emphasis text-text-secondary">
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
    <label className={`block ${className ?? ''}`}>
      <span className="mb-1 block text-caption font-emphasis text-text-secondary">
        {label}
      </span>
      {children}
    </label>
  );
}
