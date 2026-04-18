// @ts-nocheck
import { CheckCircle2, ChevronDown, ChevronUp, Loader2, Search, X } from 'lucide-react';

export function SelectTablesStep(props: any) {
  const {
    isVietnamese,
    wizardText,
    datasetDetailsQuery,
    tables,
    tableSearch,
    setTableSearch,
    setExpandedDatasetIds,
    datasetSelectionGroups,
    normalizedTableSearch,
    visibleTableCount,
    toggleDatasetExpanded,
    setDatasetTableSelection,
    selectedKeys,
    toggleTable,
    selectedTableCards,
    clearSelectedTables,
    selectedTables,
    selectedDatasetCount,
    setSelectedKeys,
    openGuides,
    toggleGuide,
    expandedDatasetIds,
  } = props;

  return (
    <div className="space-y-5">
      {/* Header: subtitle + selected chips */}
      <div>
        <p className="text-sm text-text-tertiary">
          {isVietnamese
            ? 'AI sẽ phân tích các bảng bạn chọn để tự động tạo dashboard. Chọn ít, chọn đúng.'
            : 'The AI Agent will analyze the tables you pick to auto-generate a dashboard. Choose few, choose well.'}
        </p>
        {selectedTableCards.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-text-tertiary">
              {isVietnamese ? `${selectedTables.length} đã chọn:` : `${selectedTables.length} selected:`}
            </span>
            {selectedTableCards.map((item) => (
              <span key={item.key} className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-3 py-1 text-xs font-medium text-brand">
                {item.tableName}
                <button
                  type="button"
                  onClick={() => setSelectedKeys((prev) => prev.filter((key) => key !== item.key))}
                  className="rounded-full p-0.5 text-brand hover:bg-brand/15 hover:text-brand"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={clearSelectedTables}
              className="text-xs text-text-quaternary hover:text-text-secondary"
            >
              {isVietnamese ? 'Xoá tất cả' : 'Clear all'}
            </button>
          </div>
        )}
      </div>

      {/* Search bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-quaternary" />
          <input
            value={tableSearch}
            onChange={(event) => setTableSearch(event.target.value)}
            placeholder={wizardText.searchPlaceholder}
            className="w-full rounded-lg border border-[rgb(var(--border-strong))] bg-surface-1 py-2.5 pl-9 pr-3 text-sm text-text-primary outline-none transition focus:border-brand focus:ring-2 focus:ring-brand"
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setExpandedDatasetIds(datasetSelectionGroups.map((group) => group.dataset.id))}
            disabled={Boolean(normalizedTableSearch)}
            className="rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-xs font-medium text-text-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {wizardText.expandAll}
          </button>
          <button
            type="button"
            onClick={() => setExpandedDatasetIds([])}
            disabled={Boolean(normalizedTableSearch)}
            className="rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-xs font-medium text-text-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {wizardText.collapseAll}
          </button>
        </div>
      </div>

      {/* Loading / Empty states */}
      {datasetDetailsQuery.isLoading && (
        <div className="flex items-center gap-2 rounded-lg border border-[rgb(var(--border-line))] p-5 text-text-secondary">
          <Loader2 className="h-4 w-4 animate-spin" />
          {wizardText.loadingTables}
        </div>
      )}

      {!datasetDetailsQuery.isLoading && tables.length === 0 && (
        <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 p-8 text-center">
          <p className="text-base font-medium text-text-primary">{wizardText.noDatasetTables}</p>
          <p className="mt-2 text-sm text-text-tertiary">{wizardText.noDatasetTablesDesc}</p>
        </div>
      )}

      {!datasetDetailsQuery.isLoading && tables.length > 0 && datasetSelectionGroups.length === 0 && (
        <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 p-8 text-center">
          <p className="text-base font-medium text-text-primary">{wizardText.noMatch}</p>
          <p className="mt-2 text-sm text-text-tertiary">{wizardText.noMatchDesc}</p>
        </div>
      )}

      {/* Dataset groups with inline table rows */}
      <div className="space-y-4">
        {datasetSelectionGroups.map((group) => {
          const isExpanded = normalizedTableSearch ? true : expandedDatasetIds.includes(group.dataset.id);
          const allVisibleSelected =
            group.visibleTables.length > 0 && group.visibleSelectedCount === group.visibleTables.length;

          return (
            <div key={group.dataset.id} className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
              {/* Dataset header */}
              <div className="flex items-center justify-between gap-3 px-5 py-4">
                <button
                  type="button"
                  onClick={() => toggleDatasetExpanded(group.dataset.id)}
                  disabled={Boolean(normalizedTableSearch)}
                  className="flex items-center gap-3 text-left disabled:cursor-default"
                >
                  <span className="text-text-quaternary">
                    {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </span>
                  <div>
                    <h4 className="text-sm font-semibold text-text-primary">{group.dataset.name}</h4>
                    {group.dataset.description && (
                      <p className="mt-0.5 text-xs text-text-tertiary">{group.dataset.description}</p>
                    )}
                  </div>
                </button>
                <div className="flex items-center gap-2">
                  {group.selectedCount > 0 && (
                    <span className="rounded-full bg-brand/10 px-2.5 py-0.5 text-[11px] font-semibold text-brand">
                      {group.selectedCount}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      setDatasetTableSelection(
                        group.dataset.id,
                        group.visibleTables.map((table) => table.id),
                        !allVisibleSelected,
                      )
                    }
                    className="rounded-md border border-[rgb(var(--border-line))] px-2.5 py-1 text-[11px] font-medium text-text-tertiary hover:bg-surface-2"
                  >
                    {allVisibleSelected
                      ? isVietnamese ? 'Bỏ chọn' : 'Clear'
                      : isVietnamese ? 'Chọn tất cả' : 'Select all'}
                  </button>
                </div>
              </div>

              {/* Table rows */}
              {isExpanded && (
                <div className="border-t border-[rgb(var(--border-line))]">
                  {group.visibleTables.map((table) => {
                    const key = `${group.dataset.id}:${table.id}`;
                    const checked = selectedKeys.includes(key);
                    return (
                      <button
                        key={table.id}
                        onClick={() => toggleTable(group.dataset.id, table.id)}
                        className={`flex w-full items-center gap-4 border-b border-[rgb(var(--border-line))] px-5 py-3 text-left transition last:border-b-0 ${
                          checked
                            ? 'bg-brand/10/60'
                            : 'bg-surface-1 hover:bg-surface-2'
                        }`}
                      >
                        {/* Checkbox */}
                        <div
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition ${
                            checked ? 'border-brand bg-brand text-white' : 'border-[rgb(var(--border-strong))] bg-surface-1'
                          }`}
                        >
                          {checked && <CheckCircle2 className="h-3.5 w-3.5" />}
                        </div>

                        {/* Table info */}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <p className="text-sm font-medium text-text-primary">{table.display_name}</p>
                            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium uppercase text-text-tertiary">
                              {table.source_kind === 'generated_calendar'
                                ? 'Date'
                                : table.source_kind === 'derived_table'
                                  ? 'Calculated'
                                  : table.source_kind === 'sql_query'
                                    ? 'SQL'
                                    : 'Source'}
                            </span>
                          </div>
                          {table.auto_description && (
                            <p className="mt-0.5 truncate text-xs text-text-tertiary">{table.auto_description}</p>
                          )}
                        </div>

                        {/* Column count hint */}
                        {table.columns_cache?.columns && (
                          <span className="shrink-0 text-xs text-text-quaternary">
                            {table.columns_cache.columns.length} {isVietnamese ? 'cột' : 'cols'}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
