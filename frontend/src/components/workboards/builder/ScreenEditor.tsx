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
  LayoutDashboard,
  Table as TableIcon,
  Trash2,
} from 'lucide-react';

import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { useI18n } from '@/providers/LanguageProvider';
import { BUILDER_GRID_2, BuilderSection } from './BuilderChrome';
import { CheckboxMultiSelect, MultiColumnPicker } from './BuilderValueControls';
import { buildAppUserRoleOptions, normalizeAppUserRole } from './appUserRoles';
import type { ScreenSpec } from './types';
import FormScreenEditor from './FormScreenEditor';
import DocScreenEditor from './DocScreenEditor';
import DashboardScreenEditor from './DashboardScreenEditor';
import TableScreenEditor from './TableScreenEditor';
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

const KIND_ICONS: Record<ScreenSpec['kind'], React.ElementType> = {
  form: ClipboardEdit,
  table: TableIcon,
  doc: FileText,
  dashboard: LayoutDashboard,
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
  const { t } = useI18n();
  const [tab, setTab] = useState<TabId>('content');

  React.useEffect(() => {
    // Any incoming field-focus request always wants the user on the
    // Content tab — that's where every kind's fields/columns/blocks live.
    if (focusFieldColumn) setTab('content');
  }, [focusFieldColumn]);

  const fieldCount = screen.kind === 'form' ? (screen.form?.fields?.length ?? 0) : undefined;
  const tableColCount =
    screen.kind === 'table' ? (screen.table?.columns?.length ?? 0) : undefined;
  const blockCount = screen.kind === 'doc' ? (screen.doc?.blocks?.length ?? 0) : undefined;
  const contentCount = fieldCount ?? tableColCount ?? blockCount;
  const ruleCount = (screen.rls || []).length;
  const KindIcon = KIND_ICONS[screen.kind];
  const kindLabel = t(`workboards.builder.kind.${screen.kind}`);

  const items: TabItem<TabId>[] = [
    { key: 'content', label: t('workboards.builder.tabs.content'), badge: badge(contentCount) },
    { key: 'permission', label: t('workboards.builder.tabs.access'), badge: badge(ruleCount) },
    { key: 'settings', label: t('workboards.builder.tabs.settings') },
  ];

  return (
    <div className="w-full space-y-4">
      {/* Screen header — kind eyebrow + title + delete affordance. Lets
          the user identify what they're configuring without ambiguity. */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
            <KindIcon className="h-3 w-3" />
            {t('workboards.builder.screenKindEyebrow', { kind: kindLabel })}
          </div>
          <h2 className="mt-1 truncate text-h3 font-strong text-text-primary">
            {screen.title || t('workboards.builder.untitledScreen')}
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
            title={t('workboards.builder.deleteThisScreen')}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('workboards.builder.delete')}
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
              workboardId={workboardId}
            />
          )}
          {screen.kind === 'table' && (
            <TableScreenEditor
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
        </>
      )}

      {tab === 'permission' && (
        <PermissionTab
          screen={screen}
          tables={tables}
          workboardId={workboardId}
          onChange={onChange}
        />
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
  workboardId,
  onChange,
}: {
  screen: ScreenSpec;
  tables: DatasetTableInfo[];
  workboardId?: number;
  onChange: (next: ScreenSpec) => void;
}) {
  const { t } = useI18n();
  const roleOptions = buildAppUserRoleOptions(screen.visible_for_roles, t).filter(
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
        <div className="font-medium text-text-primary">
          {t('workboards.builder.permission.defaultsByRole')}
        </div>
        <ul className="mt-1 space-y-0.5">
          <li>
            {t('workboards.builder.permission.ownerDefault')}
          </li>
          <li>
            {t('workboards.builder.permission.adminDefault')}
          </li>
          <li>
            {t('workboards.builder.permission.userDefault')}
          </li>
        </ul>
      </div>

      {screen.kind === 'dashboard' ? (
        <BuilderSection
          title={t('workboards.builder.permission.roleRules')}
          description={t('workboards.builder.permission.dashboardRoleRulesDescription')}
        >
          <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2.5 text-caption text-text-tertiary">
            {t('workboards.builder.permission.dashboardNoRls')}
          </p>
        </BuilderSection>
      ) : (
        <BuilderSection
          title={t('workboards.builder.permission.roleRules')}
          description={t('workboards.builder.permission.roleRulesDescription')}
        >
          <RlsEditor
            screen={screen}
            tables={tables}
            workboardId={workboardId}
            onChange={onChange}
          />
        </BuilderSection>
      )}

      <BuilderSection
        title={t('workboards.builder.permission.openRoles')}
        description={t('workboards.builder.permission.openRolesDescription')}
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
  const { t } = useI18n();
  const tableCols = tables.find((table) => table.id === screen.table_id)?.columns ?? [];

  return (
    <div className="space-y-4">
      <BuilderSection
        title={t('workboards.builder.settings.display')}
        description={t('workboards.builder.settings.displayDescription')}
      >
        <div className={BUILDER_GRID_2}>
          <Field label={t('workboards.builder.settings.screenTitle')}>
            <input
              value={screen.title}
              onChange={(event) => onChange({ ...screen, title: event.target.value })}
              className={INPUT}
              placeholder={t('workboards.builder.settings.screenTitlePlaceholder')}
            />
          </Field>
          <Field label={t('workboards.builder.settings.shortDescription')}>
            <input
              value={screen.description || ''}
              onChange={(event) =>
                onChange({ ...screen, description: event.target.value })
              }
              className={INPUT}
              placeholder={t('workboards.builder.settings.shortDescriptionPlaceholder')}
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
          {t('workboards.builder.settings.showInNavigation')}
        </label>
      </BuilderSection>

      <BuilderSection
        title={t('workboards.builder.settings.identifierIcon')}
        description={t('workboards.builder.settings.identifierIconDescription')}
      >
        <div className={BUILDER_GRID_2}>
          <Field label={t('workboards.builder.settings.internalId')}>
            {/* Read-only: screen.id is the join key for mini_app_nav.items,
                screen_groups[].screen_ids, and go_to_screen/after_submit_screen/
                header_screen_id/scan_go_to_screen. Renaming it in place would
                orphan every one of those references (the backend only scrubs
                dangling group ids — it does not repoint actions/nav). */}
            <input
              value={screen.id}
              readOnly
              title={t('workboards.builder.settings.internalIdTitle')}
              className={`${INPUT} cursor-not-allowed bg-slate-50 text-slate-400`}
            />
          </Field>
          <Field label={t('workboards.builder.settings.icon')}>
            <IconPicker
              value={screen.icon}
              onChange={(next) => onChange({ ...screen, icon: next })}
              placeholder={t('workboards.builder.iconPicker.placeholder')}
            />
          </Field>
        </div>
      </BuilderSection>

      <BuilderSection
        title={t('workboards.builder.settings.primaryKeyColumns')}
        description={t('workboards.builder.settings.primaryKeyDescription')}
      >
        {tableCols.length > 0 ? (
          <MultiColumnPicker
            sourceColumns={tableCols.map((column) => column.name)}
            value={screen.primary_key_columns || []}
            onChange={(primaryKeyColumns) =>
              onChange({ ...screen, primary_key_columns: primaryKeyColumns })
            }
            placeholder={t('workboards.builder.settings.primaryKeyPlaceholder')}
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
            placeholder={t('workboards.builder.settings.primaryKeyTextPlaceholder')}
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
