/**
 * Workspace Detail Page - Shows workspace with sidebar tables and grid preview
 */
'use client';

import React, { useState, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { 
  Plus, 
  Search, 
  Database, 
  RefreshCw, 
  ChevronLeft,
  Loader2,
  Columns,
  Trash2,
  AlertTriangle,
  X,
} from 'lucide-react';
import { useWorkspace, useTablePreview, useUpdateTable, useRemoveTable } from '@/hooks/use-dataset-workspaces';
import { DatasetTableGrid } from '@/components/datasets/DatasetTableGrid';
import { AddTableModal } from '@/components/datasets/AddTableModalV2';
import { ManageColumnsDrawer } from '@/components/datasets/ManageColumnsDrawer';
import { AddColumnModal, buildFNS } from '@/components/datasets/AddColumnModal';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import type { Transformation } from '@/hooks/use-dataset-workspaces';

// Inline Excel formula evaluator (mirrors AddColumnModal's evalExcelFormula)
function evalExcelFormulaInPage(
  formula: string,
  row: Record<string, any>,
  fns: Record<string, Function>
): { ok: true; value: any } | { ok: false; error: string } {
  try {
    const colMap: Record<string, string> = {};
    let idx = 0;
    let expr = formula.replace(/\[([^\]]+)\]/g, (_m: string, name: string) => {
      const key = `__COL${idx++}__`;
      colMap[key] = name;
      return key;
    });
    const strings: string[] = [];
    expr = expr.replace(/"([^"]*)"/g, (_m: string, s: string) => {
      strings.push(s);
      return `__STR${strings.length - 1}__`;
    });
    expr = expr
      .replace(/<>/g, '!==')
      .replace(/(?<![<>!=])=(?![>=])/g, '===')
      .replace(/&/g, '+')
      .replace(/\bTRUE\b/gi, 'true')
      .replace(/\bFALSE\b/gi, 'false');
    expr = expr.replace(/\b([A-Z][A-Z0-9_]*)\s*\(/g, (m: string, name: string) => {
      if (name in fns) return `__FN.${name}(`;
      return m;
    });
    expr = expr.replace(/__STR(\d+)__/g, (_m: string, i: string) => JSON.stringify(strings[Number(i)]));
    for (const [key, colName] of Object.entries(colMap)) {
      expr = expr.replace(new RegExp(key, 'g'), `__ROW[${JSON.stringify(colName)}]`);
    }
    // eslint-disable-next-line no-new-func
    const fn = new Function('__ROW', '__FN', `return (${expr});`);
    return { ok: true, value: fn(row, fns) };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export default function WorkspaceDetailPage() {
  const params = useParams();
  const router = useRouter();
  const workspaceId = params?.id ? Number(params.id) : null;
  
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);
  const [previewLimit, setPreviewLimit] = useState(200);
  const [isAddTableModalOpen, setIsAddTableModalOpen] = useState(false);
  const [isManageColumnsOpen, setIsManageColumnsOpen] = useState(false);
  const [isAddColumnModalOpen, setIsAddColumnModalOpen] = useState(false);
  const [editingColumnStep, setEditingColumnStep] = useState<Transformation | null>(null);
  const [tableSearchQuery, setTableSearchQuery] = useState('');
  const [tableToDelete, setTableToDelete] = useState<{ id: number; name: string } | null>(null);
  const [deleteConstraints, setDeleteConstraints] = useState<any[] | null>(null);
  const [isDeletingTable, setIsDeletingTable] = useState(false);

  // Fetch workspace with tables
  const { 
    data: workspace, 
    isLoading: loadingWorkspace,
    error: workspaceError,
    refetch: refetchWorkspace,
  } = useWorkspace(workspaceId);

  const resPerms = getResourcePermissions(workspace?.user_permission);

  // Fetch table preview
  const {
    data: previewData,
    isLoading: loadingPreview,
    error: previewError,
    refetch: refetchPreview,
  } = useTablePreview(workspaceId, selectedTableId, { limit: previewLimit });

  // Filter tables by search
  const filteredTables = useMemo(() => {
    if (!workspace?.tables) return [];
    if (!tableSearchQuery) return workspace.tables;
    
    const query = tableSearchQuery.toLowerCase();
    return workspace.tables.filter((table: any) => 
      table.display_name?.toLowerCase().includes(query) ||
      table.source_table_name.toLowerCase().includes(query)
    );
  }, [workspace?.tables, tableSearchQuery]);

  // Auto-select first table when tables load
  React.useEffect(() => {
    if (workspace?.tables && workspace.tables.length > 0 && !selectedTableId) {
      setSelectedTableId(workspace.tables[0].id);
    }
  }, [workspace?.tables, selectedTableId]);

  // Update table mutation
  const updateTableMutation = useUpdateTable();
  const removeTableMutation = useRemoveTable();

  // Handle table addition success
  const handleTableAddSuccess = () => {
    refetchWorkspace();
    // Auto-select newly added table (will be last in list after refetch)
    setTimeout(() => {
      if (workspace?.tables && workspace.tables.length > 0) {
        setSelectedTableId(workspace.tables[workspace.tables.length - 1].id);
      }
    }, 500);
  };

  // Handle transformations save
  const handleSaveTransformations = async (transformations: Transformation[]) => {
    if (!workspaceId || !selectedTableId) return;

    await updateTableMutation.mutateAsync({
      workspaceId,
      tableId: selectedTableId,
      input: { transformations },
    });

    // Refresh preview to show updated data
    refetchPreview();
    refetchWorkspace();
  };

  // Handle table deletion with dependency check
  const handleDeleteTable = async () => {
    if (!workspaceId || !tableToDelete) return;
    setIsDeletingTable(true);
    try {
      await removeTableMutation.mutateAsync({
        workspaceId,
        tableId: tableToDelete.id,
      });
      // Select another table if the deleted one was selected
      if (selectedTableId === tableToDelete.id) {
        const remaining = (workspace?.tables ?? []).filter((t: any) => t.id !== tableToDelete.id);
        setSelectedTableId(remaining.length > 0 ? remaining[0].id : null);
      }
      setTableToDelete(null);
      setDeleteConstraints(null);
    } catch (err: any) {
      const data = err?.response?.data;
      if (data?.detail?.constraints) {
        setDeleteConstraints(data.detail.constraints);
      } else {
        alert(data?.detail?.message ?? data?.detail ?? 'Không thể xóa bảng.');
        setTableToDelete(null);
      }
    } finally {
      setIsDeletingTable(false);
    }
  };

  // Handle full format change (decimal places, separator, etc.) — persists to DB
  const handleColumnFormatChange = async (colName: string, fmt: Record<string, any> | null) => {
    if (!workspaceId || !selectedTableId) return;
    const current: Record<string, any> = (selectedTable as any)?.column_formats ?? {};
    let updated: Record<string, any>;
    if (fmt === null) {
      updated = { ...current };
      delete updated[colName];
    } else {
      updated = { ...current, [colName]: fmt };
    }
    await updateTableMutation.mutateAsync({
      workspaceId,
      tableId: selectedTableId,
      input: { column_formats: updated },
    });
    refetchWorkspace();
  };

  // Handle deleting a computed column directly from the grid format popover
  const handleDeleteColumn = async (colName: string) => {
    if (!workspaceId || !selectedTableId || !selectedTable) return;
    const existing: Transformation[] = selectedTable.transformations || [];
    const updated = existing.filter(
      (t) =>
        !(
          (t.type === 'js_formula' || t.type === 'add_column') &&
          t.params?.newField === colName
        )
    );
    // Also remove from select_columns list if present
    const withSelectFixed = updated.map((t) => {
      if (t.type === 'select_columns' && Array.isArray(t.params?.columns)) {
        return { ...t, params: { ...t.params, columns: t.params.columns.filter((c: string) => c !== colName) } };
      }
      return t;
    });
    await updateTableMutation.mutateAsync({
      workspaceId,
      tableId: selectedTableId,
      input: { transformations: withSelectFixed },
    });
    refetchWorkspace();
    refetchPreview();
  };

  // Handle editing an existing computed column's formula
  const handleEditColumn = (colName: string) => {
    if (!selectedTable) return;
    const step = (selectedTable.transformations ?? []).find(
      (t) => t.type === 'js_formula' && t.params?.newField === colName
    ) ?? null;
    setEditingColumnStep(step);
    setIsAddColumnModalOpen(true);
  };

  // Handle column type override from format panel
  const handleTypeOverride = async (colName: string, backendType: string | null) => {
    if (!workspaceId || !selectedTableId) return;
    const current: Record<string, string> = (selectedTable as any)?.type_overrides ?? {};
    let updated: Record<string, string>;
    if (backendType === null) {
      updated = { ...current };
      delete updated[colName];
    } else {
      updated = { ...current, [colName]: backendType };
    }
    await updateTableMutation.mutateAsync({
      workspaceId,
      tableId: selectedTableId,
      input: { type_overrides: updated },
    });
    refetchWorkspace();
    refetchPreview();
  };

  const selectedTable = workspace?.tables?.find((t: any) => t.id === selectedTableId);

  // Names of columns produced by js_formula OR add_column transformations (deletable in drawer)
  const computedColumnNames = useMemo(() => {
    return (selectedTable?.transformations ?? [])
      .filter((t: any) =>
        (t.type === 'js_formula' || t.type === 'add_column') &&
        t.enabled !== false &&
        t.params?.newField
      )
      .map((t: any) => t.params.newField as string);
  }, [selectedTable?.transformations]);

  /**
   * Lookup data for cross-table LOOKUP() use in formulas.
   * Keyed by each other table's display label; value = their sample_cache rows.
   * sample_cache holds the first 10 rows cached on last preview.
   */
  const workspaceLookupData = useMemo(() => {
    const result: Record<string, Record<string, any>[]> = {};
    for (const t of workspace?.tables ?? []) {
      if (t.id === selectedTableId) continue; // skip current table
      const label = (t as any).display_name || (t as any).source_table_name || String(t.id);
      const rows: Record<string, any>[] = (t as any).sample_cache ?? [];
      if (rows.length > 0) result[label] = rows;
    }
    return result;
  }, [workspace?.tables, selectedTableId]);

  // Apply js_formula transformations client-side on top of server preview rows
  const computedPreviewData = useMemo(() => {
    if (!previewData) return previewData;
    const jsSteps = (selectedTable?.transformations ?? []).filter(
      (t: any) => t.type === 'js_formula' && t.enabled !== false && t.params?.newField && (t.params?.code || t.params?.formula)
    );
    if (jsSteps.length === 0) return previewData;

    const augmentedRows = previewData.rows.map((row, idx) => {
      const out = { ...row };
      const fns = buildFNS(workspaceLookupData);
      for (const step of jsSteps) {
        try {
          const { code, formula, newField } = step.params as { code?: string; formula?: string; newField: string };
          if (formula) {
            const result = evalExcelFormulaInPage(formula, out, fns);
            if (result.ok) out[newField] = result.value;
          } else if (code) {
            const body = code.trim().includes('return') ? code : `return (${code})`;
            // eslint-disable-next-line no-new-func
            const fn = new Function('$row', '$index', body);
            out[newField] = fn(out, idx);
          }
        } catch {
          // leave column as undefined on error
        }
      }
      return out;
    });

    const addedCols = jsSteps.map((s: any) => ({ name: s.params.newField, type: 'string', nullable: true }));
    return {
      ...previewData,
      rows: augmentedRows,
      columns: [...previewData.columns, ...addedCols],
    };
  }, [previewData, selectedTable?.transformations, workspaceLookupData]);

  /**
   * Column groups for the formula modal:
   * - Group 1: current table's columns (from computedPreviewData)
   * - Group N: each other table with cached columns (columns_cache)
   */
  const modalColumnGroups = useMemo(() => {
    const currentCols = (computedPreviewData?.columns ?? []).map((c) => c.name);
    const groups: { sourceLabel: string; columns: string[] }[] = [
      { sourceLabel: (selectedTable as any)?.display_name || (selectedTable as any)?.source_table_name || 'Bảng hiện tại', columns: currentCols },
    ];
    for (const t of workspace?.tables ?? []) {
      if (t.id === selectedTableId) continue;
      const label = (t as any).display_name || (t as any).source_table_name || String(t.id);
      const cachedCols: string[] = ((t as any).columns_cache?.columns ?? []).map((c: any) => c.name);
      if (cachedCols.length > 0) {
        groups.push({ sourceLabel: `${label} (lookup)`, columns: cachedCols });
      }
    }
    return groups.filter((g) => g.columns.length > 0);
  }, [computedPreviewData?.columns, workspace?.tables, selectedTableId, selectedTable]);

  if (loadingWorkspace) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-3" />
          <p className="text-gray-600">Loading workspace...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (workspaceError || !workspace) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <div className="text-red-600 mb-3">
            <svg className="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Workspace not found</h2>
          <p className="text-gray-600 mb-4">
            {workspaceError instanceof Error ? workspaceError.message : 'Could not load workspace'}
          </p>
          <button
            onClick={() => router.push('/dataset-workspaces')}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            Back to Workspaces
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left Sidebar */}
      <div className="w-80 border-r bg-white flex flex-col">
        {/* Sidebar Header */}
        <div className="p-4 border-b">
          <button
            onClick={() => router.push('/dataset-workspaces')}
            className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 mb-3 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            Back to Workspaces
          </button>
          
          <h1 className="text-lg font-semibold text-gray-900 mb-1">
            {workspace.name}
          </h1>
          {workspace.description && (
            <p className="text-sm text-gray-600">{workspace.description}</p>
          )}
        </div>

        {/* Search Tables */}
        <div className="p-4 border-b">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search tables..."
              value={tableSearchQuery}
              onChange={(e) => setTableSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Tables List */}
        <div className="flex-1 overflow-y-auto">
          {filteredTables.length === 0 ? (
            <div className="p-4 text-center text-gray-500 text-sm">
              {tableSearchQuery ? 'No tables match your search' : 'No tables yet'}
            </div>
          ) : (
            <div className="p-2">
              {filteredTables.map((table: any) => (
                <div
                  key={table.id}
                  className={`group relative w-full flex items-center gap-3 px-3 py-2 rounded-md text-left transition-colors cursor-pointer ${
                    selectedTableId === table.id
                      ? 'bg-blue-50 text-blue-900'
                      : 'hover:bg-gray-100 text-gray-900'
                  }`}
                  onClick={() => setSelectedTableId(table.id)}
                >
                  <Database className="w-4 h-4 flex-shrink-0 text-gray-400" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {table.display_name || table.source_table_name}
                    </div>
                    {table.display_name && (
                      <div className="text-xs text-gray-500 truncate">
                        {table.source_table_name}
                      </div>
                    )}
                  </div>
                  {resPerms.canDelete && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteConstraints(null);
                      setTableToDelete({
                        id: table.id,
                        name: table.display_name || table.source_table_name,
                      });
                    }}
                    className="p-1 hover:bg-red-100 rounded opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-red-600"
                    title="Xóa bảng"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Add Table Button */}
        <div className="p-4 border-t">
          {resPerms.canEdit && (
          <button
            onClick={() => setIsAddTableModalOpen(true)}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Table
          </button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden">
        {workspace.tables.length === 0 ? (
          // Empty state - no tables
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-md px-4">
              <div className="text-gray-400 mb-4">
                <Database className="w-16 h-16 mx-auto" />
              </div>
              <h2 className="text-xl font-semibold text-gray-900 mb-2">
                No tables yet
              </h2>
              <p className="text-gray-600 mb-6">
                Add a table from your datasources to get started with this workspace
              </p>
              {resPerms.canEdit && (
              <button
                onClick={() => setIsAddTableModalOpen(true)}
                className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
              >
                <Plus className="w-5 h-5" />
                Add Table
              </button>
              )}
            </div>
          </div>
        ) : selectedTable ? (
          <>
            {/* Top Bar */}
            <div className="bg-white border-b px-6 py-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-semibold text-gray-900">
                    {selectedTable.display_name || selectedTable.source_table_name}
                  </h2>
                  <span className="px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 rounded">
                    {selectedTable.source_table_name}
                  </span>
                </div>
                
                <div className="flex items-center gap-3">
                  {resPerms.canEdit && (
                  <button
                    onClick={() => setIsManageColumnsOpen(true)}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors"
                  >
                    <Columns className="w-4 h-4" />
                    Columns
                  </button>
                  )}
                  
                  {resPerms.canEdit && (
                  <button
                    onClick={() => setIsAddColumnModalOpen(true)}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Add Column
                  </button>
                  )}
                  
                  <div className="w-px h-6 bg-gray-300" />
                  
                  <label className="flex items-center gap-2 text-sm text-gray-600">
                    Limit:
                    <select
                      value={previewLimit}
                      onChange={(e) => setPreviewLimit(Number(e.target.value))}
                      className="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                      <option value={200}>200</option>
                      <option value={500}>500</option>
                      <option value={1000}>1000</option>
                    </select>
                  </label>
                  
                  <button
                    onClick={() => refetchPreview()}
                    disabled={loadingPreview}
                    className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors disabled:opacity-50"
                    title="Refresh preview"
                  >
                    <RefreshCw className={`w-4 h-4 ${loadingPreview ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>
            </div>

            {/* Grid Body */}
            <div className="flex-1 overflow-auto p-6">
              <DatasetTableGrid
                columns={computedPreviewData?.columns || []}
                rows={computedPreviewData?.rows || []}
                isLoading={loadingPreview}
                error={previewError instanceof Error ? previewError.message : null}
                onRetry={() => refetchPreview()}
                onAddColumn={resPerms.canEdit ? () => setIsAddColumnModalOpen(true) : undefined}
                onDeleteColumn={resPerms.canEdit ? handleDeleteColumn : undefined}
                onEditColumn={resPerms.canEdit ? handleEditColumn : undefined}
                computedColumns={computedColumnNames}
                typeOverrides={(selectedTable as any)?.type_overrides}
                onTypeOverride={handleTypeOverride}
                columnFormatsDb={(selectedTable as any)?.column_formats}
                onColumnFormatChange={handleColumnFormatChange}
              />
            </div>
          </>
        ) : null}
      </div>

      {/* Add Table Modal */}
      <AddTableModal
        workspaceId={workspaceId!}
        isOpen={isAddTableModalOpen}
        onClose={() => setIsAddTableModalOpen(false)}
        onSuccess={handleTableAddSuccess}
      />

      {/* Manage Columns Drawer */}
      {selectedTable && (
        <ManageColumnsDrawer
          table={selectedTable}
          allColumns={(computedPreviewData?.columns || []).map((c) => c.name)}
          computedColumns={computedColumnNames}
          isOpen={isManageColumnsOpen}
          onClose={() => setIsManageColumnsOpen(false)}
          onSave={handleSaveTransformations}
        />
      )}

      {/* Add Column Modal */}
      {selectedTable && (
        <AddColumnModal
          table={selectedTable}
          allColumns={(computedPreviewData?.columns || []).map((c) => c.name)}
          columnGroups={modalColumnGroups}
          previewRows={computedPreviewData?.rows || []}
          lookupData={workspaceLookupData}
          isOpen={isAddColumnModalOpen}
          onClose={() => { setIsAddColumnModalOpen(false); setEditingColumnStep(null); }}
          onSave={handleSaveTransformations}
          editingStep={editingColumnStep}
        />
      )}

      {/* Delete Table Modal */}
      {tableToDelete && (
        <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6">
            {deleteConstraints ? (
              // ---- Constraint error view ----
              <>
                <div className="flex items-start gap-3 mb-4">
                  <AlertTriangle className="w-6 h-6 text-red-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">Không thể xóa bảng</h2>
                    <p className="text-sm text-gray-600 mt-1">
                      Bảng <span className="font-medium">&ldquo;{tableToDelete.name}&rdquo;</span> đang được sử dụng bởi:
                    </p>
                  </div>
                </div>
                <ul className="mb-6 space-y-2">
                  {deleteConstraints.map((c: any, i: number) => (
                    <li key={i} className="flex items-center gap-2 text-sm bg-red-50 rounded-lg px-3 py-2">
                      {c.type === 'chart' ? (
                        <>
                          <span className="text-xs font-semibold uppercase text-red-500 bg-red-100 rounded px-1.5 py-0.5">Chart</span>
                          <span className="text-gray-800">{c.name}</span>
                        </>
                      ) : (
                        <>
                          <span className="text-xs font-semibold uppercase text-amber-600 bg-amber-100 rounded px-1.5 py-0.5">LOOKUP</span>
                          <span className="text-gray-800">Bảng <strong>{c.table_name}</strong>, cột <strong>{c.column}</strong></span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-gray-500 mb-4">
                  Hãy xóa hoặc cập nhật các ràng buộc trên trước khi xóa bảng này.
                </p>
                <div className="flex justify-end">
                  <button
                    onClick={() => { setTableToDelete(null); setDeleteConstraints(null); }}
                    className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-medium"
                  >
                    Đóng
                  </button>
                </div>
              </>
            ) : (
              // ---- Confirmation view ----
              <>
                <div className="flex items-start gap-3 mb-4">
                  <Trash2 className="w-6 h-6 text-red-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">Xóa bảng?</h2>
                    <p className="text-sm text-gray-600 mt-1">
                      Bạn có chắc muốn xóa bảng <span className="font-medium">&ldquo;{tableToDelete.name}&rdquo;</span>? Hành động này không thể hoàn tác.
                    </p>
                  </div>
                </div>
                <div className="flex justify-end gap-3">
                  <button
                    onClick={() => setTableToDelete(null)}
                    disabled={isDeletingTable}
                    className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900 disabled:opacity-50"
                  >
                    Hủy
                  </button>
                  <button
                    onClick={handleDeleteTable}
                    disabled={isDeletingTable}
                    className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 flex items-center gap-2"
                  >
                    {isDeletingTable && <Loader2 className="w-4 h-4 animate-spin" />}
                    Xóa bảng
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
