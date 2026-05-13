/**
 * ListScreenEditor - object-based list configuration.
 */
'use client';

import React, { useEffect, useState } from 'react';
import {
  Columns3,
  Filter,
  ListFilter,
  MousePointerClick,
  Plus,
  Rows3,
  Trash2,
} from 'lucide-react';

import {
  BUILDER_GRID_2,
  BuilderEmptyHint,
  BuilderIconButton,
  BuilderInspectorPanel,
  BuilderNavigator,
  BuilderNavigatorGroup,
  BuilderNavigatorItem,
  BuilderObjectEditor,
  DataSourcePicker,
} from './BuilderChrome';
import { MultiColumnPicker, SingleColumnPicker } from './BuilderValueControls';
import type { ListFilterSpec, ScreenAction, ScreenSpec } from './types';
import { INPUT, Lbl } from './ScreenEditor';

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
  onChange: (next: ScreenSpec) => void;
}

type ListSpec = NonNullable<ScreenSpec['list']>;
type ActiveItem = 'columns' | 'settings' | 'empty' | `filter:${number}` | `action:${number}`;

const EMPTY_LIST: ListSpec = { columns: [], page_size: 50, row_actions: [] };

const FILTER_KIND_LABEL: Record<ListFilterSpec['kind'], string> = {
  text: 'Text search',
  select: 'Single select',
  date_range: 'Date range',
  number_range: 'Number range',
};

export default function ListScreenEditor({
  screen,
  allScreens,
  tables,
  onChange,
}: Props) {
  const list = screen.list || EMPTY_LIST;
  const filters = list.filters || [];
  const rowActions = list.row_actions || [];
  const tableCols = tables.find((table) => table.id === screen.table_id)?.columns ?? [];
  const columnNames = tableCols.map((column) => column.name);
  const [activeItem, setActiveItem] = useState<ActiveItem>('columns');

  const activeFilterIndex = activeItem.startsWith('filter:')
    ? Number(activeItem.slice('filter:'.length))
    : -1;
  const activeActionIndex = activeItem.startsWith('action:')
    ? Number(activeItem.slice('action:'.length))
    : -1;

  useEffect(() => {
    if (activeItem.startsWith('filter:') && activeFilterIndex >= filters.length) {
      setActiveItem(filters.length > 0 ? `filter:${filters.length - 1}` : 'columns');
    }
    if (activeItem.startsWith('action:') && activeActionIndex >= rowActions.length) {
      setActiveItem(rowActions.length > 0 ? `action:${rowActions.length - 1}` : 'columns');
    }
  }, [activeActionIndex, activeFilterIndex, activeItem, filters.length, rowActions.length]);

  const updateList = (patch: Partial<ListSpec>) =>
    onChange({ ...screen, list: { ...list, ...patch } });

  const addFilter = () => {
    if (columnNames.length === 0) return;
    const next = [
      ...filters,
      { column: columnNames[0], kind: 'text', label: '' } satisfies ListFilterSpec,
    ];
    updateList({ filters: next });
    setActiveItem(`filter:${next.length - 1}`);
  };

  const updateFilter = (idx: number, patch: Partial<ListFilterSpec>) => {
    const next = [...filters];
    next[idx] = { ...next[idx], ...patch };
    updateList({ filters: next });
  };

  const removeFilter = (idx: number) => {
    const next = filters.filter((_, index) => index !== idx);
    updateList({ filters: next });
    if (activeFilterIndex === idx) {
      setActiveItem(next.length > 0 ? `filter:${Math.max(0, Math.min(idx, next.length - 1))}` : 'columns');
    } else if (activeFilterIndex > idx) {
      setActiveItem(`filter:${activeFilterIndex - 1}`);
    }
  };

  const addAction = () => {
    const next = [
      ...rowActions,
      {
        id: `action-${Date.now().toString(36)}`,
        label: 'Open',
        go_to_screen: null,
        carry: [],
      } satisfies ScreenAction,
    ];
    updateList({ row_actions: next });
    setActiveItem(`action:${next.length - 1}`);
  };

  const updateAction = (idx: number, patch: Partial<ScreenAction>) => {
    const next = [...rowActions];
    next[idx] = { ...next[idx], ...patch };
    updateList({ row_actions: next });
  };

  const removeAction = (idx: number) => {
    const next = rowActions.filter((_, index) => index !== idx);
    updateList({ row_actions: next });
    if (activeActionIndex === idx) {
      setActiveItem(next.length > 0 ? `action:${Math.max(0, Math.min(idx, next.length - 1))}` : 'columns');
    } else if (activeActionIndex > idx) {
      setActiveItem(`action:${activeActionIndex - 1}`);
    }
  };

  const renderInspector = () => {
    if (activeItem === 'columns') {
      return (
        <BuilderInspectorPanel
          icon={<Columns3 className="h-4 w-4" />}
          title="Table columns"
          subtitle="Choose which source columns are visible in the list."
        >
          <ColumnsInspector
            columnNames={columnNames}
            selectedColumns={list.columns}
            onChange={(columns) => updateList({ columns })}
          />
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'settings') {
      return (
        <BuilderInspectorPanel
          icon={<Rows3 className="h-4 w-4" />}
          title="Paging and sorting"
          subtitle="Default row count and row ordering for this list."
        >
          <ListSettingsInspector
            list={list}
            columnNames={columnNames}
            onChange={updateList}
          />
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'empty') {
      return (
        <BuilderInspectorPanel
          icon={<ListFilter className="h-4 w-4" />}
          title="Empty state"
          subtitle="Message shown when the list returns zero rows."
        >
          <Lbl label="Empty state message">
            <input
              value={list.empty_state_message || ''}
              onChange={(event) => updateList({ empty_state_message: event.target.value })}
              className={INPUT}
              placeholder="e.g. No data yet."
            />
          </Lbl>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem.startsWith('filter:')) {
      const filter = filters[activeFilterIndex];
      if (!filter) return null;
      return (
        <BuilderInspectorPanel
          icon={<Filter className="h-4 w-4" />}
          title={filter.label?.trim() || filter.column || 'Filter'}
          subtitle={`${FILTER_KIND_LABEL[filter.kind]} - ${filter.column}`}
          action={
            <BuilderIconButton
              onClick={() => removeFilter(activeFilterIndex)}
              title="Delete filter"
              variant="danger"
            >
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </BuilderIconButton>
          }
        >
          <FilterInspector
            filter={filter}
            columnNames={columnNames}
            onChange={(patch) => updateFilter(activeFilterIndex, patch)}
          />
        </BuilderInspectorPanel>
      );
    }

    if (activeItem.startsWith('action:')) {
      const action = rowActions[activeActionIndex];
      if (!action) return null;
      return (
        <BuilderInspectorPanel
          icon={<MousePointerClick className="h-4 w-4" />}
          title={action.label || 'Row action'}
          subtitle={action.go_to_screen ? 'Navigate to another screen' : 'No target screen selected'}
          action={
            <BuilderIconButton
              onClick={() => removeAction(activeActionIndex)}
              title="Delete action"
              variant="danger"
            >
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </BuilderIconButton>
          }
        >
          <RowActionInspector
            action={action}
            allScreens={allScreens}
            currentScreenId={screen.id}
            columnNames={columnNames}
            onChange={(patch) => updateAction(activeActionIndex, patch)}
          />
        </BuilderInspectorPanel>
      );
    }

    return null;
  };

  return (
    <div className="space-y-4">
      <DataSourcePicker
        tableId={screen.table_id}
        tables={tables}
        onChange={(nextId) => onChange({ ...screen, table_id: nextId })}
      />

      {!screen.table_id ? (
        <BuilderEmptyHint className="text-left">
          Pick a primary data source before configuring columns, filters, or row actions.
        </BuilderEmptyHint>
      ) : null}

      <BuilderObjectEditor>
        <BuilderNavigator
          title="List objects"
          description="Select the table setup, a filter, or a row action to edit."
        >
          <BuilderNavigatorGroup title="Table">
            <BuilderNavigatorItem
              icon={<Columns3 className="h-3.5 w-3.5" />}
              label="Columns"
              subtitle={`${list.columns.length} selected`}
              active={activeItem === 'columns'}
              onClick={() => setActiveItem('columns')}
            />
            <BuilderNavigatorItem
              icon={<Rows3 className="h-3.5 w-3.5" />}
              label="Paging and sorting"
              subtitle={`${list.page_size ?? 50} rows/page${
                list.default_sort_column ? ` - ${list.default_sort_column}` : ''
              }`}
              active={activeItem === 'settings'}
              onClick={() => setActiveItem('settings')}
            />
            <BuilderNavigatorItem
              icon={<ListFilter className="h-3.5 w-3.5" />}
              label="Empty state"
              subtitle={list.empty_state_message ? 'Custom message' : 'Default message'}
              active={activeItem === 'empty'}
              onClick={() => setActiveItem('empty')}
            />
          </BuilderNavigatorGroup>

          <BuilderNavigatorGroup
            title={`Filters (${filters.length})`}
            action={
              <button
                type="button"
                onClick={addFilter}
                disabled={columnNames.length === 0}
                className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
                title="Add filter"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            }
          >
            {filters.length === 0 ? (
              <BuilderEmptyHint className="px-3 py-4">No filters yet.</BuilderEmptyHint>
            ) : (
              filters.map((filter, index) => (
                <BuilderNavigatorItem
                  key={`${filter.column}:${index}`}
                  icon={<Filter className="h-3.5 w-3.5" />}
                  label={filter.label?.trim() || filter.column || 'Filter'}
                  subtitle={`${FILTER_KIND_LABEL[filter.kind]} - ${filter.column}`}
                  active={activeItem === `filter:${index}`}
                  onClick={() => setActiveItem(`filter:${index}`)}
                  action={
                    <BuilderIconButton
                      onClick={() => removeFilter(index)}
                      title="Delete filter"
                      variant="danger"
                    >
                      <Trash2 className="h-3 w-3 text-danger" />
                    </BuilderIconButton>
                  }
                />
              ))
            )}
          </BuilderNavigatorGroup>

          <BuilderNavigatorGroup
            title={`Row actions (${rowActions.length})`}
            action={
              <button
                type="button"
                onClick={addAction}
                className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-brand"
                title="Add action"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            }
          >
            {rowActions.length === 0 ? (
              <BuilderEmptyHint className="px-3 py-4">No actions yet.</BuilderEmptyHint>
            ) : (
              rowActions.map((action, index) => (
                <BuilderNavigatorItem
                  key={`${action.id}:${index}`}
                  icon={<MousePointerClick className="h-3.5 w-3.5" />}
                  label={action.label || 'Row action'}
                  subtitle={action.go_to_screen ? `Go to ${action.go_to_screen}` : 'No target'}
                  active={activeItem === `action:${index}`}
                  onClick={() => setActiveItem(`action:${index}`)}
                  action={
                    <BuilderIconButton
                      onClick={() => removeAction(index)}
                      title="Delete action"
                      variant="danger"
                    >
                      <Trash2 className="h-3 w-3 text-danger" />
                    </BuilderIconButton>
                  }
                />
              ))
            )}
          </BuilderNavigatorGroup>
        </BuilderNavigator>

        {renderInspector()}
      </BuilderObjectEditor>
    </div>
  );
}

function ColumnsInspector({
  columnNames,
  selectedColumns,
  onChange,
}: {
  columnNames: string[];
  selectedColumns: string[];
  onChange: (columns: string[]) => void;
}) {
  if (columnNames.length === 0) {
    return (
      <BuilderEmptyHint className="text-left">
        No data source selected, or the table has no columns.
      </BuilderEmptyHint>
    );
  }

  return (
    <div className="space-y-3">
      <MultiColumnPicker
        sourceColumns={columnNames}
        value={selectedColumns}
        onChange={onChange}
        placeholder="Click to pick columns to display..."
      />
      <p className="text-tiny text-text-tertiary">
        The selected order controls the table order in the public list.
      </p>
    </div>
  );
}

function ListSettingsInspector({
  list,
  columnNames,
  onChange,
}: {
  list: ListSpec;
  columnNames: string[];
  onChange: (patch: Partial<ListSpec>) => void;
}) {
  return (
    <div className={BUILDER_GRID_2}>
      <Lbl label="Rows per page">
        <input
          type="number"
          min={10}
          max={500}
          value={list.page_size ?? 50}
          onChange={(event) =>
            onChange({ page_size: Math.min(500, Math.max(10, Number(event.target.value) || 50)) })
          }
          className={INPUT}
        />
      </Lbl>
      <Lbl label="Default sort column">
        <SingleColumnPicker
          sourceColumns={columnNames}
          value={list.default_sort_column || null}
          onChange={(next) => onChange({ default_sort_column: next || null })}
          placeholder="No default sort"
        />
      </Lbl>
      <Lbl label="Default sort direction">
        <select
          value={list.default_sort_direction || 'desc'}
          onChange={(event) =>
            onChange({ default_sort_direction: event.target.value as 'asc' | 'desc' })
          }
          className={INPUT}
        >
          <option value="desc">Desc</option>
          <option value="asc">Asc</option>
        </select>
      </Lbl>
    </div>
  );
}

function FilterInspector({
  filter,
  columnNames,
  onChange,
}: {
  filter: ListFilterSpec;
  columnNames: string[];
  onChange: (patch: Partial<ListFilterSpec>) => void;
}) {
  return (
    <div className={BUILDER_GRID_2}>
      <Lbl label="Source column">
        <SingleColumnPicker
          sourceColumns={columnNames}
          value={filter.column || null}
          onChange={(next) => onChange({ column: next || filter.column })}
          clearable={false}
          placeholder="Pick a column"
        />
      </Lbl>
      <Lbl label="Filter type">
        <select
          value={filter.kind}
          onChange={(event) => onChange({ kind: event.target.value as ListFilterSpec['kind'] })}
          className={INPUT}
        >
          {(Object.keys(FILTER_KIND_LABEL) as ListFilterSpec['kind'][]).map((kind) => (
            <option key={kind} value={kind}>
              {FILTER_KIND_LABEL[kind]}
            </option>
          ))}
        </select>
      </Lbl>
      <Lbl label="Display label">
        <input
          value={filter.label || ''}
          onChange={(event) => onChange({ label: event.target.value })}
          placeholder={filter.column || 'Display label'}
          className={INPUT}
        />
      </Lbl>
    </div>
  );
}

function RowActionInspector({
  action,
  allScreens,
  currentScreenId,
  columnNames,
  onChange,
}: {
  action: ScreenAction;
  allScreens: ScreenSpec[];
  currentScreenId: string;
  columnNames: string[];
  onChange: (patch: Partial<ScreenAction>) => void;
}) {
  return (
    <div className={BUILDER_GRID_2}>
      <Lbl label="Button label">
        <input
          value={action.label}
          onChange={(event) => onChange({ label: event.target.value })}
          placeholder="Open"
          className={INPUT}
        />
      </Lbl>
      <Lbl label="Target screen">
        <select
          value={action.go_to_screen || ''}
          onChange={(event) => onChange({ go_to_screen: event.target.value || null })}
          className={INPUT}
        >
          <option value="">-- pick target screen --</option>
          {allScreens
            .filter((item) => item.id !== currentScreenId)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
        </select>
      </Lbl>
      <Lbl label="Carry columns to target" className="wb-col-span-2">
        {columnNames.length > 0 ? (
          <MultiColumnPicker
            sourceColumns={columnNames}
            value={action.carry || []}
            onChange={(carry) => onChange({ carry })}
            placeholder="Columns to carry over..."
          />
        ) : (
          <input
            value={(action.carry || []).join(', ')}
            onChange={(event) =>
              onChange({
                carry: event.target.value
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
            placeholder="Columns to carry over"
            className={INPUT}
          />
        )}
      </Lbl>
    </div>
  );
}
