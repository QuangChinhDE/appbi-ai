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
import {
  ClipboardEdit,
  FileText,
  Grid3x3,
  LayoutDashboard,
  ListChecks,
  Trash2,
} from 'lucide-react';

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
import IconPicker from './IconPicker';
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
  /** Called when the user clicks "Delete screen" from inside the editor.
   * The parent is responsible for the confirm + state update; we just
   * surface it on the topbar of the editor so the user doesn't have to
   * go back to the canvas to remove a screen. */
  onDeleteScreen?: () => void;
}

// Tabs use FIXED labels regardless of screen kind. The old design
// renamed the first tab (Form/List/Document/Dashboard) per kind, which
// forced the user to re-acquire "which tab is the content one" every
// time they switched screens. Fixed labels keep the mental model stable;
// the screen kind is communicated via the breadcrumb eyebrow instead.
type TabId = 'content' | 'permission' | 'settings';

const KIND_LABELS: Record<ScreenSpec['kind'], string> = {
  form: 'Form',
  list: 'List',
  doc: 'Document',
  dashboard: 'Dashboard',
  grid: 'Grid',
};

const KIND_ICONS: Record<ScreenSpec['kind'], React.ElementType> = {
  form: ClipboardEdit,
  list: ListChecks,
  doc: FileText,
  dashboard: LayoutDashboard,
  grid: Grid3x3,
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
  onDeleteScreen,
}: Props) {
  const [tab, setTab] = useState<TabId>('content');

  React.useEffect(() => {
    // Any incoming field-focus request always wants the user on the
    // Content tab — that's where every kind's fields/columns/blocks live.
    if (focusFieldColumn) setTab('content');
  }, [focusFieldColumn]);

  const fieldCount = screen.kind === 'form' ? (screen.form?.fields?.length ?? 0) : undefined;
  const columnCount = screen.kind === 'list' ? (screen.list?.columns?.length ?? 0) : undefined;
  const blockCount = screen.kind === 'doc' ? (screen.doc?.blocks?.length ?? 0) : undefined;
  const gridColCount = screen.kind === 'grid' ? (screen.grid?.columns?.length ?? 0) : undefined;
  const contentCount = fieldCount ?? columnCount ?? blockCount ?? gridColCount;
  const ruleCount = (screen.rls || []).length;
  const KindIcon = KIND_ICONS[screen.kind];

  const items: TabItem<TabId>[] = [
    { key: 'content', label: 'Content', badge: badge(contentCount) },
    { key: 'permission', label: 'Permissions', badge: badge(ruleCount) },
    { key: 'settings', label: 'Settings' },
  ];

  return (
    <div className="w-full space-y-4">
      {/* Screen header — kind eyebrow + title + delete affordance. Lets
          the user identify what they're configuring without ambiguity. */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
            <KindIcon className="h-3 w-3" />
            {KIND_LABELS[screen.kind]} · screen
          </div>
          <h2 className="mt-1 truncate text-h3 font-strong text-text-primary">
            {screen.title || 'Untitled screen'}
          </h2>
          {screen.description ? (
            <p className="mt-1 text-caption text-text-tertiary">{screen.description}</p>
          ) : null}
        </div>
        {onDeleteScreen && (
          <button
            type="button"
            onClick={onDeleteScreen}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 text-caption text-text-tertiary hover:border-danger/40 hover:bg-danger/5 hover:text-danger"
            title="Delete this screen"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        )}
      </div>

      <Tabs<TabId> items={items} value={tab} onChange={setTab} variant="underline" />

      {tab === 'content' && (
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

      {tab === 'settings' && (
        <SettingsTab screen={screen} tables={tables} onChange={onChange} />
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

// ── Settings tab ──────────────────────────────────────────────────────────
//
// The Settings tab consolidates everything that used to live in the
// per-row gear popover (title, description, show-in-nav) plus the older
// "Advanced" tab content (slug, icon, primary key). One place for every
// screen-level meta property, so the user knows where to look.

function SettingsTab({
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
        title="Display"
        description="What the user sees when navigating to this screen."
      >
        <div className={BUILDER_GRID_2}>
          <Field label="Screen title">
            <input
              value={screen.title}
              onChange={(event) => onChange({ ...screen, title: event.target.value })}
              className={INPUT}
              placeholder="e.g. Ca làm việc"
            />
          </Field>
          <Field label="Short description">
            <input
              value={screen.description || ''}
              onChange={(event) =>
                onChange({ ...screen, description: event.target.value })
              }
              className={INPUT}
              placeholder="Optional hint shown to end users"
            />
          </Field>
        </div>
        <label className="mt-3 flex items-center gap-2 text-caption text-text-secondary">
          <input
            type="checkbox"
            checked={screen.show_in_nav !== false}
            onChange={(event) =>
              onChange({ ...screen, show_in_nav: event.target.checked })
            }
            className="h-3.5 w-3.5"
          />
          Show in mini-app navigation
        </label>
      </BuilderSection>

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
          <Field label="Icon">
            <IconPicker
              value={screen.icon}
              onChange={(next) => onChange({ ...screen, icon: next })}
              placeholder="Pick an icon"
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
