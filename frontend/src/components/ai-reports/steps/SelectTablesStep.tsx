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
        <p className="text-sm text-gray-500">
          {isVietnamese
            ? 'AI sẽ phân tích các bảng bạn chọn để tự động tạo dashboard. Chọn ít, chọn đúng.'
            : 'The AI Agent will analyze the tables you pick to auto-generate a dashboard. Choose few, choose well.'}
        </p>
        {selectedTableCards.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-gray-500">
              {isVietnamese ? `${selectedTables.length} đã chọn:` : `${selectedTables.length} selected:`}
            </span>
            {selectedTableCards.map((item) => (
              <span key={item.key} className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
                {item.tableName}
                <button
                  type="button"
                  onClick={() => setSelectedKeys((prev) => prev.filter((key) => key !== item.key))}
                  className="rounded-full p-0.5 text-blue-400 hover:bg-blue-100 hover:text-blue-700"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={clearSelectedTables}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              {isVietnamese ? 'Xoá tất cả' : 'Clear all'}
            </button>
          </div>
        )}
      </div>

      {/* Search bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={tableSearch}
            onChange={(event) => setTableSearch(event.target.value)}
            placeholder={wizardText.searchPlaceholder}
            className="w-full rounded-lg border border-gray-300 bg-white py-2.5 pl-9 pr-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setExpandedDatasetIds(datasetSelectionGroups.map((group) => group.dataset.id))}
            disabled={Boolean(normalizedTableSearch)}
            className="rounded-md border border-gray-300 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {wizardText.expandAll}
          </button>
          <button
            type="button"
            onClick={() => setExpandedDatasetIds([])}
            disabled={Boolean(normalizedTableSearch)}
            className="rounded-md border border-gray-300 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {wizardText.collapseAll}
          </button>
        </div>
      </div>

      {/* Loading / Empty states */}
      {datasetDetailsQuery.isLoading && (
        <div className="flex items-center gap-2 rounded-lg border border-gray-200 p-5 text-gray-600">
          <Loader2 className="h-4 w-4 animate-spin" />
          {wizardText.loadingTables}
        </div>
      )}

      {!datasetDetailsQuery.isLoading && tables.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-8 text-center">
          <p className="text-base font-medium text-gray-900">{wizardText.noDatasetTables}</p>
          <p className="mt-2 text-sm text-gray-500">{wizardText.noDatasetTablesDesc}</p>
        </div>
      )}

      {!datasetDetailsQuery.isLoading && tables.length > 0 && datasetSelectionGroups.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-8 text-center">
          <p className="text-base font-medium text-gray-900">{wizardText.noMatch}</p>
          <p className="mt-2 text-sm text-gray-500">{wizardText.noMatchDesc}</p>
        </div>
      )}

      {/* Dataset groups with inline table rows */}
      <div className="space-y-4">
        {datasetSelectionGroups.map((group) => {
          const isExpanded = normalizedTableSearch ? true : expandedDatasetIds.includes(group.dataset.id);
          const allVisibleSelected =
            group.visibleTables.length > 0 && group.visibleSelectedCount === group.visibleTables.length;

          return (
            <div key={group.dataset.id} className="rounded-xl border border-gray-200 bg-white shadow-sm">
              {/* Dataset header */}
              <div className="flex items-center justify-between gap-3 px-5 py-4">
                <button
                  type="button"
                  onClick={() => toggleDatasetExpanded(group.dataset.id)}
                  disabled={Boolean(normalizedTableSearch)}
                  className="flex items-center gap-3 text-left disabled:cursor-default"
                >
                  <span className="text-gray-400">
                    {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </span>
                  <div>
                    <h4 className="text-sm font-semibold text-gray-900">{group.dataset.name}</h4>
                    {group.dataset.description && (
                      <p className="mt-0.5 text-xs text-gray-500">{group.dataset.description}</p>
                    )}
                  </div>
                </button>
                <div className="flex items-center gap-2">
                  {group.selectedCount > 0 && (
                    <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-[11px] font-semibold text-blue-700">
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
                    className="rounded-md border border-gray-200 px-2.5 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-50"
                  >
                    {allVisibleSelected
                      ? isVietnamese ? 'Bỏ chọn' : 'Clear'
                      : isVietnamese ? 'Chọn tất cả' : 'Select all'}
                  </button>
                </div>
              </div>

              {/* Table rows */}
              {isExpanded && (
                <div className="border-t border-gray-100">
                  {group.visibleTables.map((table) => {
                    const key = `${group.dataset.id}:${table.id}`;
                    const checked = selectedKeys.includes(key);
                    return (
                      <button
                        key={table.id}
                        onClick={() => toggleTable(group.dataset.id, table.id)}
                        className={`flex w-full items-center gap-4 border-b border-gray-50 px-5 py-3 text-left transition last:border-b-0 ${
                          checked
                            ? 'bg-blue-50/60'
                            : 'bg-white hover:bg-gray-50'
                        }`}
                      >
                        {/* Checkbox */}
                        <div
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition ${
                            checked ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 bg-white'
                          }`}
                        >
                          {checked && <CheckCircle2 className="h-3.5 w-3.5" />}
                        </div>

                        {/* Table info */}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <p className="text-sm font-medium text-gray-900">{table.display_name}</p>
                            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-gray-500">
                              {table.source_kind === 'sql_query' ? 'SQL' : 'table'}
                            </span>
                          </div>
                          {table.auto_description && (
                            <p className="mt-0.5 truncate text-xs text-gray-500">{table.auto_description}</p>
                          )}
                        </div>

                        {/* Column count hint */}
                        {table.columns_cache?.columns && (
                          <span className="shrink-0 text-xs text-gray-400">
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
