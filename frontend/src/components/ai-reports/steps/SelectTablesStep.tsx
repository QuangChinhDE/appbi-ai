// @ts-nocheck
import { CheckCircle2, ChevronDown, ChevronUp, FileText, Loader2, Search, Sparkles, Table2, X } from 'lucide-react';
import { CollapsibleGuideCard } from './shared/CollapsibleGuideCard';

export function SelectTablesStep(props: any) {
  const {
    isVietnamese,
    wizardText,
    workspaceDetailsQuery,
    tables,
    tableSearch,
    setTableSearch,
    setExpandedWorkspaceIds,
    workspaceSelectionGroups,
    normalizedTableSearch,
    visibleTableCount,
    toggleWorkspaceExpanded,
    setWorkspaceTableSelection,
    selectedKeys,
    toggleTable,
    selectedTableCards,
    clearSelectedTables,
    selectedTables,
    selectedWorkspaceCount,
    setSelectedKeys,
    openGuides,
    toggleGuide,
    expandedWorkspaceIds,
  } = props;

  return (
  <div className="space-y-6">
    <div className="grid gap-4 xl:grid-cols-[1.05fr_0.9fr_0.75fr]">
      <div className="rounded-xl border border-gray-200 bg-blue-50 p-6">
        <div className="mb-3 flex items-center gap-2 text-gray-900">
          <Table2 className="h-5 w-5 text-blue-600" />
          <h3 className="text-lg font-semibold">{wizardText.chooseTablesTitle}</h3>
        </div>
        <p className="text-sm text-gray-600">{wizardText.chooseTablesDesc}</p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="mb-3 flex items-center gap-2 text-gray-900">
          <FileText className="h-5 w-5 text-gray-500" />
          <h3 className="text-lg font-semibold">{wizardText.whatHappensNext}</h3>
        </div>
        <ol className="space-y-3 text-sm text-gray-600">
          {wizardText.nextSteps.map((item, index) => (
            <li key={item}>{index + 1}. {item}</li>
          ))}
        </ol>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-1">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-gray-400">{wizardText.workspaces}</p>
            <p className="mt-2 text-2xl font-semibold text-gray-900">{workspaceDetailsQuery.data?.length ?? 0}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-gray-400">{wizardText.availableTables}</p>
            <p className="mt-2 text-2xl font-semibold text-gray-900">{tables.length}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-gray-400">{wizardText.selectedTables}</p>
            <p className="mt-2 text-2xl font-semibold text-gray-900">{selectedTables.length}</p>
          </div>
        </div>
      </div>
    </div>

    <div className="grid gap-6 xl:grid-cols-[1.18fr_0.82fr]">
      <div className="space-y-4">
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                value={tableSearch}
                onChange={(event) => setTableSearch(event.target.value)}
                placeholder={wizardText.searchPlaceholder}
                className="w-full rounded-lg border border-gray-300 py-2.5 pl-9 pr-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setExpandedWorkspaceIds(workspaceSelectionGroups.map((group) => group.workspace.id))}
                disabled={Boolean(normalizedTableSearch)}
                className="px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              >
                {wizardText.expandAll}
              </button>
              <button
                type="button"
                onClick={() => setExpandedWorkspaceIds([])}
                disabled={Boolean(normalizedTableSearch)}
                className="px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              >
                {wizardText.collapseAll}
              </button>
            </div>
          </div>
          <p className="mt-3 text-xs text-gray-500">
            {isVietnamese
              ? `Đang hiển thị ${workspaceSelectionGroups.length} workspace và ${visibleTableCount} bảng trong view hiện tại.`
              : `Showing ${workspaceSelectionGroups.length} workspace${workspaceSelectionGroups.length !== 1 ? 's' : ''} and ${visibleTableCount} table${visibleTableCount !== 1 ? 's' : ''} in the current view.`}
          </p>
        </div>

        {workspaceDetailsQuery.isLoading && (
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 p-5 text-gray-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            {wizardText.loadingTables}
          </div>
        )}

        {!workspaceDetailsQuery.isLoading && tables.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-8 text-center">
            <p className="text-base font-medium text-gray-900">{wizardText.noWorkspaceTables}</p>
            <p className="mt-2 text-sm text-gray-500">{wizardText.noWorkspaceTablesDesc}</p>
          </div>
        )}

        {!workspaceDetailsQuery.isLoading && tables.length > 0 && workspaceSelectionGroups.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-8 text-center">
            <p className="text-base font-medium text-gray-900">{wizardText.noMatch}</p>
            <p className="mt-2 text-sm text-gray-500">{wizardText.noMatchDesc}</p>
          </div>
        )}

        <div className="space-y-4">
          {workspaceSelectionGroups.map((group) => {
            const isExpanded = normalizedTableSearch ? true : expandedWorkspaceIds.includes(group.workspace.id);
            const allVisibleSelected =
              group.visibleTables.length > 0 && group.visibleSelectedCount === group.visibleTables.length;

            return (
              <div key={group.workspace.id} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                <div className="flex flex-col gap-3 border-b border-gray-100 pb-4 sm:flex-row sm:items-start sm:justify-between">
                  <button
                    type="button"
                    onClick={() => toggleWorkspaceExpanded(group.workspace.id)}
                    disabled={Boolean(normalizedTableSearch)}
                    className="flex items-start gap-3 text-left disabled:cursor-default"
                  >
                    <div className="mt-0.5 text-gray-400">
                      {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-gray-400">{isVietnamese ? 'Workspace' : 'Workspace'}</p>
                      <h4 className="text-lg font-semibold text-gray-900">{group.workspace.name}</h4>
                      {group.workspace.description && (
                        <p className="mt-1 text-sm text-gray-500">{group.workspace.description}</p>
                      )}
                      <p className="mt-2 text-xs text-gray-500">
                        {isVietnamese
                          ? `${group.selectedCount} / ${group.totalTables} bảng đã chọn`
                          : `${group.selectedCount} of ${group.totalTables} table${group.totalTables !== 1 ? 's' : ''} selected`}
                      </p>
                    </div>
                  </button>

                  <div className="flex flex-wrap items-center gap-2">
                    {group.selectedCount > 0 && (
                      <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
                        {isVietnamese ? `${group.selectedCount} đã chọn` : `${group.selectedCount} selected`}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        setWorkspaceTableSelection(
                          group.workspace.id,
                          group.visibleTables.map((table) => table.id),
                          !allVisibleSelected,
                        )
                      }
                      className="px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-300 rounded-full hover:bg-gray-50 transition-colors"
                    >
                      {allVisibleSelected
                        ? isVietnamese ? 'Bỏ chọn phần đang hiển thị' : 'Clear shown'
                        : isVietnamese ? 'Chọn phần đang hiển thị' : 'Select shown'}
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="mt-4 space-y-3">
                    {group.visibleTables.map((table) => {
                      const key = `${group.workspace.id}:${table.id}`;
                      const checked = selectedKeys.includes(key);
                      return (
                        <button
                          key={table.id}
                          onClick={() => toggleTable(group.workspace.id, table.id)}
                          className={`flex w-full items-start justify-between rounded-lg border px-4 py-3 text-left transition ${
                            checked
                              ? 'border-blue-500 bg-blue-50 shadow-sm'
                              : 'border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50/40'
                          }`}
                        >
                          <div>
                            <p className="font-medium text-gray-900">{table.display_name}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-gray-600">
                                {table.source_kind}
                              </span>
                              <span className="text-xs text-gray-400">Table ID {table.id}</span>
                            </div>
                          </div>
                          <div
                            className={`mt-1 flex h-5 w-5 items-center justify-center rounded-full border ${
                              checked ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 bg-white'
                            }`}
                          >
                            {checked && <CheckCircle2 className="h-3.5 w-3.5" />}
                          </div>
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

      <div className="space-y-4 xl:sticky xl:top-0 xl:self-start">
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">{wizardText.selectedScope}</h3>
              <p className="mt-1 text-sm text-gray-500">
                {isVietnamese
                  ? 'Hãy giữ phạm vi gọn. Agent chỉ sử dụng những bảng này.'
                  : 'Keep the scope tight. The Agent will only use these tables.'}
              </p>
            </div>
            {selectedKeys.length > 0 && (
              <button
                type="button"
                onClick={clearSelectedTables}
                className="text-xs font-medium text-gray-600 hover:text-gray-900"
              >
                {wizardText.clearAll}
              </button>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <p className="text-xs uppercase tracking-[0.16em] text-gray-400">{wizardText.selectedTables}</p>
              <p className="mt-2 text-2xl font-semibold text-gray-900">{selectedTables.length}</p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <p className="text-xs uppercase tracking-[0.16em] text-gray-400">{wizardText.selectedWorkspaces}</p>
              <p className="mt-2 text-2xl font-semibold text-gray-900">{selectedWorkspaceCount}</p>
            </div>
          </div>

          {selectedTableCards.length === 0 ? (
            <div className="mt-4 rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
              {wizardText.chooseAtLeastOne}
            </div>
          ) : (
            <div className="mt-4 max-h-[420px] space-y-3 overflow-y-auto pr-1">
              {selectedTableCards.map((item) => (
                <div key={item.key} className="flex items-start justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900">{item.tableName}</p>
                    <p className="mt-1 text-xs uppercase tracking-[0.16em] text-gray-500">{item.workspaceName}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedKeys((prev) => prev.filter((key) => key !== item.key))}
                    className="rounded-md p-1 text-gray-400 hover:bg-white hover:text-gray-700 transition-colors"
                    title={wizardText.removeFromSelection}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <CollapsibleGuideCard
          title={wizardText.selectionTipsTitle}
          description={wizardText.selectionTipsDesc}
          icon={<Sparkles className="h-5 w-5" />}
          isOpen={openGuides['select-guide']}
          onToggle={() => toggleGuide('select-guide')}
          badge={isVietnamese ? 'Hướng dẫn' : 'Guide'}
          tone="blue"
        >
          <ul className="space-y-2 text-sm text-blue-900/90">
            {wizardText.selectionTipsBullets.map((item) => (
              <li key={item}>- {item}</li>
            ))}
          </ul>
        </CollapsibleGuideCard>
      </div>
    </div>
  </div>
  );
}
