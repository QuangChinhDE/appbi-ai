'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Database, FileText, Layers3, Plus, Save, Settings2, Trash2 } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

import type { ReportTemplate, TemplateDocumentBlock, TemplateDocumentDefinition } from '@/types/template';
import type { TemplateDataSource } from '@/types/template';
import type { TemplateDocumentRuntimeBlockPreview } from '@/types/template';
import { Button } from '@/components/ui/Button';
import { FieldGroup, Input, Select, Textarea } from '@/components/ui/Input';
import { DataSourcePicker } from '@/components/templates/builder/DataSourcePicker';
import { useDataset } from '@/hooks/use-datasets';
import { useTemplateDocumentRuntime } from '@/hooks/use-template-data';
import { reportTemplateApi } from '@/lib/api/report-templates';
import { toast } from '@/lib/toast';

const BLOCK_LIBRARY = [
  { type: 'section', label: 'Section' },
  { type: 'stack', label: 'Stack' },
  { type: 'grid', label: 'Grid' },
  { type: 'text', label: 'Text' },
  { type: 'metric', label: 'Metric' },
  { type: 'table', label: 'Table' },
  { type: 'repeater', label: 'Repeater' },
  { type: 'input', label: 'Input' },
  { type: 'signature', label: 'Signature' },
  { type: 'page-break', label: 'Page break' },
];

interface DocumentTemplateWorkspaceProps {
  template: ReportTemplate;
  definition: TemplateDocumentDefinition;
  canEdit: boolean;
  hasChanges: boolean;
  isSaving: boolean;
  onDefinitionChange: (definition: TemplateDocumentDefinition) => void;
  onSave: () => void;
}

const CONTAINER_BLOCK_TYPES = new Set(['page', 'section', 'stack', 'grid', 'repeater']);
const DATA_BOUND_BLOCK_TYPES = new Set(['table', 'metric', 'repeater', 'input']);

function canHaveChildren(block: TemplateDocumentBlock) {
  return CONTAINER_BLOCK_TYPES.has(block.type);
}

function countBlocks(root: TemplateDocumentBlock): number {
  return 1 + (root.children ?? []).reduce((total, child) => total + countBlocks(child), 0);
}

function findParentBlockId(
  block: TemplateDocumentBlock,
  targetId: string,
  parentId: string | null = null,
): string | null {
  if (block.id === targetId) {
    return parentId;
  }
  for (const child of block.children ?? []) {
    const result = findParentBlockId(child, targetId, block.id);
    if (result !== null) {
      return result;
    }
  }
  return null;
}

function updateBlockTree(
  block: TemplateDocumentBlock,
  targetId: string,
  updater: (block: TemplateDocumentBlock) => TemplateDocumentBlock,
): TemplateDocumentBlock {
  if (block.id === targetId) {
    return updater(block);
  }

  let changed = false;
  const nextChildren = (block.children ?? []).map((child) => {
    const nextChild = updateBlockTree(child, targetId, updater);
    if (nextChild !== child) {
      changed = true;
    }
    return nextChild;
  });

  if (!changed) {
    return block;
  }
  return { ...block, children: nextChildren };
}

function mapBlockTree(
  block: TemplateDocumentBlock,
  mapper: (block: TemplateDocumentBlock) => TemplateDocumentBlock,
): TemplateDocumentBlock {
  const nextChildren = (block.children ?? []).map((child) => mapBlockTree(child, mapper));
  const nextBlock = nextChildren.length > 0 || (block.children ?? []).length > 0
    ? { ...block, children: nextChildren }
    : block;
  return mapper(nextBlock);
}

function removeBlockTree(block: TemplateDocumentBlock, targetId: string): TemplateDocumentBlock {
  if (!(block.children ?? []).length) {
    return block;
  }

  let changed = false;
  const nextChildren: TemplateDocumentBlock[] = [];
  for (const child of block.children ?? []) {
    if (child.id === targetId) {
      changed = true;
      continue;
    }
    const nextChild = removeBlockTree(child, targetId);
    if (nextChild !== child) {
      changed = true;
    }
    nextChildren.push(nextChild);
  }

  if (!changed) {
    return block;
  }
  return { ...block, children: nextChildren };
}

function moveBlockWithinParent(block: TemplateDocumentBlock, targetId: string, offset: -1 | 1): TemplateDocumentBlock {
  if (!(block.children ?? []).length) {
    return block;
  }

  const childIndex = (block.children ?? []).findIndex((child) => child.id === targetId);
  if (childIndex >= 0) {
    const nextIndex = childIndex + offset;
    if (nextIndex < 0 || nextIndex >= (block.children ?? []).length) {
      return block;
    }
    const reordered = [...(block.children ?? [])];
    const [moved] = reordered.splice(childIndex, 1);
    reordered.splice(nextIndex, 0, moved);
    return { ...block, children: reordered };
  }

  let changed = false;
  const nextChildren = (block.children ?? []).map((child) => {
    const nextChild = moveBlockWithinParent(child, targetId, offset);
    if (nextChild !== child) {
      changed = true;
    }
    return nextChild;
  });
  return changed ? { ...block, children: nextChildren } : block;
}

function createBlockTemplate(type: string, label: string): TemplateDocumentBlock {
  return {
    id: uuidv4(),
    type,
    name: label,
    ...(type === 'text' ? { content: '' } : {}),
    ...(type === 'metric' ? { title: label, sourceField: '' } : {}),
    ...(type === 'table' ? { title: label, columnKeys: [] } : {}),
    ...(type === 'input' ? { label, sourceField: '' } : {}),
    ...(CONTAINER_BLOCK_TYPES.has(type) ? { children: [] } : {}),
  };
}

function formatPreviewValue(value: any): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  if (typeof value === 'number') {
    return value.toLocaleString('en-US');
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  return String(value);
}

function flattenBlocks(root: TemplateDocumentBlock): TemplateDocumentBlock[] {
  const items: TemplateDocumentBlock[] = [root];
  for (const child of root.children ?? []) {
    items.push(...flattenBlocks(child));
  }
  return items;
}

function BlockTreeNode({
  block,
  depth,
  selectedId,
  onSelect,
}: {
  block: TemplateDocumentBlock;
  depth: number;
  selectedId: string;
  onSelect: (blockId: string) => void;
}) {
  const isSelected = block.id === selectedId;

  return (
    <div>
      <button
        type="button"
        onClick={() => onSelect(block.id)}
        className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
          isSelected
            ? 'bg-brand/10 text-brand'
            : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
        }`}
        style={{ paddingLeft: depth * 14 + 12 }}
      >
        <span className="truncate font-medium">{block.name || block.type}</span>
        <span className="ml-3 shrink-0 text-[11px] uppercase tracking-[0.18em] text-text-quaternary">{block.type}</span>
      </button>

      {(block.children ?? []).length > 0 && (
        <div className="mt-1 space-y-1">
          {(block.children ?? []).map((child) => (
            <BlockTreeNode
              key={child.id}
              block={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CanvasBlock({
  block,
  selectedId,
  onSelect,
  blockPreviews,
  runtimeLoading,
  runtimeError,
}: {
  block: TemplateDocumentBlock;
  selectedId: string;
  onSelect: (blockId: string) => void;
  blockPreviews: Record<string, TemplateDocumentRuntimeBlockPreview>;
  runtimeLoading: boolean;
  runtimeError: string | null;
}) {
  const isSelected = block.id === selectedId;
  const blockPreview = blockPreviews[block.id];

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => onSelect(block.id)}
        className={`w-full rounded-2xl border p-4 text-left transition-colors ${
          isSelected
            ? 'border-brand/50 bg-brand/10'
            : 'border-[rgb(var(--border-line))] bg-surface-1 hover:border-brand/30'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-text-quaternary">{block.type}</p>
            <h3 className="mt-2 text-sm font-semibold text-text-primary">{block.name || block.type}</h3>
          </div>
          <span className="rounded-full bg-surface-2 px-2 py-1 text-[11px] text-text-tertiary">
            {(block.children ?? []).length} child{(block.children ?? []).length === 1 ? '' : 'ren'}
          </span>
        </div>

        {block.type === 'page' && (
          <p className="mt-3 text-xs leading-5 text-text-tertiary">
            Root page container. Pagination, overflow targets, and safe margins are planned here.
          </p>
        )}

        {block.type === 'text' && typeof block.content === 'string' && block.content.trim() && (
          <p className="mt-3 line-clamp-3 text-xs leading-5 text-text-tertiary">{block.content}</p>
        )}

        {DATA_BOUND_BLOCK_TYPES.has(block.type) && (
          <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-text-tertiary">
            {typeof block.dataSourceId === 'string' && block.dataSourceId && (
              <span className="rounded-full bg-surface-2 px-2 py-1">source linked</span>
            )}
            {typeof block.sourceField === 'string' && block.sourceField && (
              <span className="rounded-full bg-surface-2 px-2 py-1">field: {block.sourceField}</span>
            )}
          </div>
        )}

        {block.type === 'table' && (
          <div className="mt-4 overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-white">
            {runtimeLoading ? (
              <div className="px-3 py-4 text-xs text-text-tertiary">Loading preview rows...</div>
            ) : runtimeError ? (
              <div className="px-3 py-4 text-xs text-danger">{runtimeError}</div>
            ) : !blockPreview || blockPreview.kind !== 'table' || (blockPreview.rows?.length ?? 0) === 0 ? (
              <div className="px-3 py-4 text-xs text-text-tertiary">No preview rows available for this table yet.</div>
            ) : (
              <div className="overflow-auto">
                <table className="min-w-full divide-y divide-[rgb(var(--border-line))] text-xs">
                  <thead className="bg-surface-2">
                    <tr>
                      {(blockPreview.columns ?? []).map((columnName) => (
                        <th key={columnName} className="px-3 py-2 text-left font-semibold text-text-secondary">
                          {columnName}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[rgb(var(--border-line))] bg-white">
                    {(blockPreview.rows ?? []).slice(0, 3).map((row, rowIndex) => (
                      <tr key={`${block.id}-row-${rowIndex}`}>
                        {(blockPreview.columns ?? []).map((columnName) => (
                          <td key={`${block.id}-${rowIndex}-${columnName}`} className="px-3 py-2 text-text-tertiary">
                            {formatPreviewValue(row?.[columnName])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {block.type === 'metric' && (
          <div className="mt-4 rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-text-quaternary">Runtime preview</p>
            <p className="mt-2 text-lg font-semibold text-text-primary">{formatPreviewValue(blockPreview?.value)}</p>
          </div>
        )}

        {block.type === 'input' && (
          <div className="mt-4 rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-text-quaternary">Runtime preview</p>
            <div className="mt-2 rounded-lg border border-[rgb(var(--border-line))] bg-white px-3 py-2 text-sm text-text-secondary">
              {typeof block.sourceField === 'string' && block.sourceField
                ? formatPreviewValue(blockPreview?.value)
                : 'Bind a field to preview an input value.'}
            </div>
          </div>
        )}

        {block.type === 'repeater' && (
          <div className="mt-4 rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-text-quaternary">Runtime preview</p>
            {(blockPreview?.items ?? []).length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {(blockPreview?.items ?? []).map((item, index) => (
                  <span key={`${block.id}-repeat-${index}`} className="rounded-full bg-white px-3 py-1 text-xs text-text-secondary">
                    {formatPreviewValue(item)}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-text-tertiary">Bind a field to preview repeater items.</p>
            )}
          </div>
        )}
      </button>

      {(block.children ?? []).length > 0 && (
        <div className="space-y-3 border-l border-dashed border-[rgb(var(--border-line))] pl-4">
          {(block.children ?? []).map((child) => (
            <CanvasBlock
              key={child.id}
              block={child}
              selectedId={selectedId}
              onSelect={onSelect}
              blockPreviews={blockPreviews}
              runtimeLoading={runtimeLoading}
              runtimeError={runtimeError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function DocumentTemplateWorkspace({
  template,
  definition,
  canEdit,
  hasChanges,
  isSaving,
  onDefinitionChange,
  onSave,
}: DocumentTemplateWorkspaceProps) {
  const [selectedMode, setSelectedMode] = useState(definition.modes.default);
  const [selectedBlockId, setSelectedBlockId] = useState(definition.root.id);
  const [showDataSourcePicker, setShowDataSourcePicker] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(definition.dataSources[0]?.id ?? null);
  const [isExporting, setIsExporting] = useState(false);

  const allBlocks = useMemo(() => flattenBlocks(definition.root), [definition.root]);
  const totalBlocks = useMemo(() => countBlocks(definition.root), [definition.root]);
  const selectedBlock = allBlocks.find((block) => block.id === selectedBlockId) ?? definition.root;
  const selectedParentId = useMemo(
    () => findParentBlockId(definition.root, selectedBlock.id),
    [definition.root, selectedBlock.id],
  );
  const designModeActive = canEdit && selectedMode === 'design';
  const bindingModeActive = canEdit && (selectedMode === 'design' || selectedMode === 'bind');
  const currentDataSource = useMemo(
    () => definition.dataSources.find((source) => source.id === selectedSourceId) ?? definition.dataSources[0],
    [definition.dataSources, selectedSourceId],
  );
  const [pickerSourceId, setPickerSourceId] = useState<string | null>(null);
  const pickerSource = useMemo(
    () => pickerSourceId ? definition.dataSources.find((source) => source.id === pickerSourceId) : undefined,
    [definition.dataSources, pickerSourceId],
  );
  const pickerCurrent = useMemo<TemplateDataSource | undefined>(() => {
    if (!pickerSource || pickerSource.kind !== 'dataset_table' || !pickerSource.datasetId || !pickerSource.tableId) {
      return undefined;
    }
    return {
      datasetId: pickerSource.datasetId,
      tableId: pickerSource.tableId,
      datasetName: pickerSource.config?.datasetName || pickerSource.name,
      tableName: pickerSource.config?.tableName,
    };
  }, [pickerSource]);
  const { data: boundDataset } = useDataset(currentDataSource?.datasetId ?? null);
  const documentRuntimeQuery = useTemplateDocumentRuntime(
    template.id,
    definition,
    true,
    8,
  );
  const availableColumns = useMemo(() => {
    if (!currentDataSource?.tableId || !boundDataset?.tables) {
      return [] as Array<{ name: string; type?: string }>;
    }
    const table = (boundDataset.tables as Array<Record<string, any>>).find((item) => item.id === currentDataSource.tableId);
    const cache = table?.columns_cache as any;
    if (Array.isArray(cache?.columns)) {
      return cache.columns
        .map((column: any) => ({ name: String(column.name || ''), type: column.type ? String(column.type) : undefined }))
        .filter((column: { name: string }) => column.name);
    }
    return [] as Array<{ name: string; type?: string }>;
  }, [boundDataset?.tables, currentDataSource?.tableId]);

  useEffect(() => {
    if (!allBlocks.some((block) => block.id === selectedBlockId)) {
      setSelectedBlockId(definition.root.id);
    }
  }, [allBlocks, definition.root.id, selectedBlockId]);

  useEffect(() => {
    if (!definition.modes.available.includes(selectedMode)) {
      setSelectedMode(definition.modes.default);
    }
  }, [definition.modes.available, definition.modes.default, selectedMode]);

  useEffect(() => {
    if (definition.dataSources.length === 0) {
      if (selectedSourceId !== null) {
        setSelectedSourceId(null);
      }
      return;
    }
    if (!selectedSourceId || !definition.dataSources.some((source) => source.id === selectedSourceId)) {
      setSelectedSourceId(definition.dataSources[0].id);
    }
  }, [definition.dataSources, selectedSourceId]);

  const updateDefinition = (next: TemplateDocumentDefinition) => {
    onDefinitionChange(next);
  };

  const handleAddBlock = (type: string, label: string) => {
    if (!designModeActive) {
      return;
    }
    const newBlock = createBlockTemplate(type, label);
    const parentId = canHaveChildren(selectedBlock)
      ? selectedBlock.id
      : selectedParentId ?? definition.root.id;
    const nextRoot = updateBlockTree(definition.root, parentId, (block) => ({
      ...block,
      children: [...(block.children ?? []), newBlock],
    }));
    updateDefinition({ ...definition, root: nextRoot });
    setSelectedBlockId(newBlock.id);
  };

  const handleRenameBlock = (name: string) => {
    if (!designModeActive) {
      return;
    }
    const nextRoot = updateBlockTree(definition.root, selectedBlock.id, (block) => ({
      ...block,
      name,
    }));
    updateDefinition({ ...definition, root: nextRoot });
  };

  const handleDeleteBlock = () => {
    if (!designModeActive || selectedBlock.id === definition.root.id) {
      return;
    }
    const nextRoot = removeBlockTree(definition.root, selectedBlock.id);
    updateDefinition({ ...definition, root: nextRoot });
    setSelectedBlockId(selectedParentId ?? definition.root.id);
  };

  const handleMoveBlock = (offset: -1 | 1) => {
    if (!designModeActive || !selectedParentId) {
      return;
    }
    const nextRoot = moveBlockWithinParent(definition.root, selectedBlock.id, offset);
    updateDefinition({ ...definition, root: nextRoot });
  };

  const handlePageOrientationChange = (orientation: 'portrait' | 'landscape') => {
    if (!designModeActive) {
      return;
    }
    updateDefinition({
      ...definition,
      page: { ...definition.page, orientation },
    });
  };

  const handlePageSizeChange = (size: 'A4' | 'A3' | 'Letter') => {
    if (!designModeActive) {
      return;
    }
    updateDefinition({
      ...definition,
      page: { ...definition.page, size },
    });
  };

  const handleBindDataSource = (dataSource: TemplateDataSource) => {
    if (!bindingModeActive) {
      return;
    }
    const nextSourceId = pickerSource?.id ?? uuidv4();
    const nextSource = {
      id: nextSourceId,
      kind: 'dataset_table' as const,
      datasetId: dataSource.datasetId,
      tableId: dataSource.tableId,
      name: `${dataSource.datasetName ?? 'Dataset'} / ${dataSource.tableName ?? 'Table'}`,
      config: {
        datasetName: dataSource.datasetName,
        tableName: dataSource.tableName,
      },
    };
    updateDefinition({
      ...definition,
      dataSources: pickerSource
        ? definition.dataSources.map((source) => source.id === pickerSource.id ? nextSource : source)
        : [...definition.dataSources, nextSource],
    });
    setSelectedSourceId(nextSourceId);
    setPickerSourceId(null);
    setShowDataSourcePicker(false);
  };

  const handleCreateDataSource = () => {
    if (!bindingModeActive) {
      return;
    }
    setPickerSourceId(null);
    setShowDataSourcePicker(true);
  };

  const handleRemoveDataSource = (sourceId: string) => {
    if (!bindingModeActive) {
      return;
    }
    const nextSources = definition.dataSources.filter((source) => source.id !== sourceId);
    const nextRoot = mapBlockTree(definition.root, (block) => {
      if (block.dataSourceId === sourceId) {
        const nextBlock = { ...block };
        delete nextBlock.dataSourceId;
        return nextBlock;
      }
      return block;
    });
    updateDefinition({
      ...definition,
      dataSources: nextSources,
      root: nextRoot,
    });
    if (selectedSourceId === sourceId) {
      setSelectedSourceId(nextSources[0]?.id ?? null);
    }
  };

  const handleSelectedBlockSourceChange = (sourceId: string) => {
    if (!bindingModeActive || !DATA_BOUND_BLOCK_TYPES.has(selectedBlock.type)) {
      return;
    }
    const nextRoot = updateBlockTree(definition.root, selectedBlock.id, (block) => ({
      ...block,
      dataSourceId: sourceId || undefined,
    }));
    updateDefinition({ ...definition, root: nextRoot });
  };

  const handleToggleTableColumn = (columnName: string) => {
    if (!bindingModeActive || selectedBlock.type !== 'table') {
      return;
    }
    const currentColumnKeys = Array.isArray(selectedBlock.columnKeys)
      ? selectedBlock.columnKeys.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const nextColumnKeys = currentColumnKeys.includes(columnName)
      ? currentColumnKeys.filter((item) => item !== columnName)
      : [...currentColumnKeys, columnName];
    patchSelectedBlock({ columnKeys: nextColumnKeys });
  };

  const patchSelectedBlock = (patch: Record<string, any>) => {
    if (!canEdit) {
      return;
    }
    const nextRoot = updateBlockTree(definition.root, selectedBlock.id, (block) => ({
      ...block,
      ...patch,
    }));
    updateDefinition({ ...definition, root: nextRoot });
  };

  const handleExportExcel = async () => {
    try {
      setIsExporting(true);
      await reportTemplateApi.exportExcel(template.id, [], template.name, {
        blocks: definition,
      });
    } catch (error: any) {
      toast.error(error?.response?.data?.detail || error?.message || 'Failed to export template');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-2">
      <div className="border-b border-[rgb(var(--border-line))] bg-surface-1 px-6 py-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-brand">Clean-slate template</p>
            <h1 className="mt-2 text-xl font-semibold text-text-primary">{template.name}</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Document-layout workspace. The legacy table builder is bypassed for this template engine.
            </p>
          </div>

          <div className="flex flex-col items-start gap-3 lg:items-end">
            <div className="flex flex-wrap gap-2">
              {definition.modes.available.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setSelectedMode(mode)}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                    selectedMode === mode
                      ? 'bg-brand text-white'
                      : 'bg-surface-2 text-text-secondary hover:bg-surface-3'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              {hasChanges && <span className="text-xs font-medium text-warning">Unsaved changes</span>}
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<FileText className="h-3.5 w-3.5" />}
                onClick={handleExportExcel}
                disabled={isExporting}
                loading={isExporting}
              >
                Export Excel
              </Button>
              <Button
                variant="primary"
                size="sm"
                leadingIcon={<Save className="h-3.5 w-3.5" />}
                onClick={onSave}
                disabled={!canEdit || !hasChanges}
                loading={isSaving}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-px bg-[rgb(var(--border-line))] lg:grid-cols-[280px_minmax(0,1fr)_300px]">
        <aside className="min-h-0 overflow-auto bg-surface-1 p-4">
          <div className="rounded-2xl border border-[rgb(var(--border-line))] bg-surface-2 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <Layers3 className="h-4 w-4 text-brand" />
              Block palette
            </div>
            <div className="mt-4 space-y-2">
              {BLOCK_LIBRARY.map((block) => (
                <Button
                  key={block.type}
                  variant="secondary"
                  size="sm"
                  fullWidth
                  className="justify-between rounded-xl"
                  disabled={!designModeActive}
                  onClick={() => handleAddBlock(block.type, block.label)}
                  trailingIcon={<Plus className="h-3.5 w-3.5" />}
                >
                  {block.label}
                </Button>
              ))}
            </div>
            <p className="mt-3 text-xs leading-5 text-text-tertiary">
              {designModeActive
                ? 'Blocks are inserted into the selected container. If a leaf block is selected, the new block is added beside it under the same parent.'
                : 'Switch to Design mode with edit access to add or rearrange blocks.'}
            </p>
          </div>

          <div className="mt-4 rounded-2xl border border-[rgb(var(--border-line))] bg-surface-2 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <Database className="h-4 w-4 text-brand" />
              Data sources
            </div>
            <div className="mt-4 space-y-2">
              {definition.dataSources.length === 0 ? (
                <p className="text-xs leading-5 text-text-tertiary">No data source is attached yet. Bind Data mode will attach dataset tables or manual sources here.</p>
              ) : (
                definition.dataSources.map((source) => (
                  <div
                    key={source.id}
                    className={`rounded-xl border px-3 py-2 text-sm transition-colors ${
                      source.id === currentDataSource?.id
                        ? 'border-brand/30 bg-brand/10'
                        : 'border-[rgb(var(--border-line))] bg-surface-1'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedSourceId(source.id)}
                      className="w-full text-left"
                    >
                      <p className="font-medium text-text-primary">{source.name || source.id}</p>
                      {source.config?.datasetName && (
                        <p className="mt-1 text-[11px] text-text-tertiary">
                          {source.config.datasetName}
                          {source.config?.tableName ? ` / ${source.config.tableName}` : ''}
                        </p>
                      )}
                    </button>
                    {bindingModeActive && (
                      <div className="mt-3 flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => {
                            setSelectedSourceId(source.id);
                            setPickerSourceId(source.id);
                            setShowDataSourcePicker(true);
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          className="text-danger hover:bg-danger/10"
                          onClick={() => handleRemoveDataSource(source.id)}
                        >
                          Remove
                        </Button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
            <div className="mt-4 flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                fullWidth
                disabled={!bindingModeActive}
                onClick={handleCreateDataSource}
              >
                Add source
              </Button>
              <Button
                variant="secondary"
                size="sm"
                fullWidth
                disabled={!bindingModeActive || !currentDataSource}
                onClick={() => {
                  setPickerSourceId(currentDataSource?.id ?? null);
                  setShowDataSourcePicker(true);
                }}
              >
                Edit selected
              </Button>
            </div>
            <p className="mt-3 text-xs leading-5 text-text-tertiary">
              {bindingModeActive
                ? 'Use the existing dataset/table picker so the document engine stays on the same data contract as the rest of the product. Each block can bind to a different source.'
                : 'Switch to Bind Data or Design mode with edit access to attach a dataset table.'}
            </p>
          </div>
        </aside>

        <main className="min-h-0 overflow-auto bg-surface-2 p-5">
          <div className="mx-auto max-w-4xl rounded-[28px] border border-[rgb(var(--border-line))] bg-white p-6 shadow-linear-sm">
            <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] pb-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-text-quaternary">Canvas</p>
                <h2 className="mt-2 text-sm font-semibold text-text-primary">
                  {definition.page.size} · {definition.page.orientation}
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-surface-2 px-3 py-1 text-xs text-text-secondary">
                  {selectedMode} mode
                </span>
                <span className="rounded-full bg-surface-2 px-3 py-1 text-xs text-text-secondary">
                  {totalBlocks} block{totalBlocks === 1 ? '' : 's'}
                </span>
              </div>
            </div>

            <div className="mt-6 space-y-4">
              {(documentRuntimeQuery.data?.warnings ?? []).length > 0 && (
                <div className="rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 text-xs text-warning">
                  {(documentRuntimeQuery.data?.warnings ?? []).join(' ')}
                </div>
              )}
              <CanvasBlock
                block={definition.root}
                selectedId={selectedBlockId}
                onSelect={setSelectedBlockId}
                blockPreviews={documentRuntimeQuery.data?.blocks ?? {}}
                runtimeLoading={documentRuntimeQuery.isLoading}
                runtimeError={documentRuntimeQuery.runtimeErrorMessage}
              />
            </div>
          </div>
        </main>

        <aside className="min-h-0 overflow-auto bg-surface-1 p-4">
          <div className="rounded-2xl border border-[rgb(var(--border-line))] bg-surface-2 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <Settings2 className="h-4 w-4 text-brand" />
              Inspector
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <p className="text-xs font-medium text-text-tertiary">Selected block</p>
                <p className="mt-2 text-sm font-semibold text-text-primary">{selectedBlock.name || selectedBlock.type}</p>
                <p className="mt-1 text-xs text-text-quaternary">{selectedBlock.type} · {selectedBlock.id}</p>
              </div>

              <FieldGroup label="Block name" htmlFor="document-block-name">
                <Input
                  id="document-block-name"
                  size="sm"
                  value={selectedBlock.name || ''}
                  onChange={(event) => handleRenameBlock(event.target.value)}
                  disabled={!designModeActive}
                />
              </FieldGroup>

              <div>
                <p className="text-xs font-medium text-text-tertiary">Children</p>
                <p className="mt-2 text-sm text-text-primary">{selectedBlock.children?.length ?? 0}</p>
              </div>

              {selectedBlock.type === 'page' && (
                <>
                  <FieldGroup label="Page size" htmlFor="document-page-size">
                    <Select
                      id="document-page-size"
                      size="sm"
                      value={definition.page.size}
                      onChange={(event) => handlePageSizeChange(event.target.value as 'A4' | 'A3' | 'Letter')}
                      disabled={!designModeActive}
                    >
                      <option value="A4">A4</option>
                      <option value="A3">A3</option>
                      <option value="Letter">Letter</option>
                    </Select>
                  </FieldGroup>

                  <FieldGroup label="Orientation" htmlFor="document-page-orientation">
                    <Select
                      id="document-page-orientation"
                      size="sm"
                      value={definition.page.orientation}
                      onChange={(event) => handlePageOrientationChange(event.target.value as 'portrait' | 'landscape')}
                      disabled={!designModeActive}
                    >
                      <option value="portrait">Portrait</option>
                      <option value="landscape">Landscape</option>
                    </Select>
                  </FieldGroup>
                </>
              )}

              {DATA_BOUND_BLOCK_TYPES.has(selectedBlock.type) && (
                <FieldGroup label="Data source" htmlFor="document-block-source">
                  <Select
                    id="document-block-source"
                    size="sm"
                    value={typeof selectedBlock.dataSourceId === 'string' ? selectedBlock.dataSourceId : ''}
                    onChange={(event) => handleSelectedBlockSourceChange(event.target.value)}
                    disabled={!bindingModeActive || definition.dataSources.length === 0}
                  >
                    <option value="">No source selected</option>
                    {definition.dataSources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name || source.id}
                      </option>
                    ))}
                  </Select>
                </FieldGroup>
              )}

              {selectedBlock.type === 'text' && (
                <FieldGroup label="Content" htmlFor="document-block-content">
                  <Textarea
                    id="document-block-content"
                    rows={5}
                    value={typeof selectedBlock.content === 'string' ? selectedBlock.content : ''}
                    onChange={(event) => patchSelectedBlock({ content: event.target.value })}
                    disabled={!designModeActive}
                  />
                </FieldGroup>
              )}

              {selectedBlock.type === 'table' && (
                <>
                  <FieldGroup label="Table title" htmlFor="document-table-title">
                    <Input
                      id="document-table-title"
                      size="sm"
                      value={typeof selectedBlock.title === 'string' ? selectedBlock.title : ''}
                      onChange={(event) => patchSelectedBlock({ title: event.target.value })}
                      disabled={!designModeActive}
                    />
                  </FieldGroup>
                  {availableColumns.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-text-tertiary">Visible columns</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {availableColumns.map((column: { name: string; type?: string }) => {
                          const isActive = Array.isArray(selectedBlock.columnKeys) && selectedBlock.columnKeys.includes(column.name);
                          return (
                            <button
                              key={column.name}
                              type="button"
                              onClick={() => handleToggleTableColumn(column.name)}
                              disabled={!bindingModeActive}
                              className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                                isActive
                                  ? 'bg-brand text-white'
                                  : 'bg-surface-1 text-text-secondary hover:bg-surface-3'
                              }`}
                            >
                              {column.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}

              {selectedBlock.type === 'metric' && (
                <>
                  <FieldGroup label="Metric title" htmlFor="document-metric-title">
                    <Input
                      id="document-metric-title"
                      size="sm"
                      value={typeof selectedBlock.title === 'string' ? selectedBlock.title : ''}
                      onChange={(event) => patchSelectedBlock({ title: event.target.value })}
                      disabled={!designModeActive}
                    />
                  </FieldGroup>
                  <FieldGroup label="Source field" htmlFor="document-metric-field">
                    <Select
                      id="document-metric-field"
                      size="sm"
                      value={typeof selectedBlock.sourceField === 'string' ? selectedBlock.sourceField : ''}
                      onChange={(event) => patchSelectedBlock({ sourceField: event.target.value })}
                      disabled={!bindingModeActive || availableColumns.length === 0}
                    >
                      <option value="">Select field</option>
                      {availableColumns.map((column: { name: string; type?: string }) => (
                        <option key={column.name} value={column.name}>
                          {column.name}{column.type ? ` (${column.type})` : ''}
                        </option>
                      ))}
                    </Select>
                  </FieldGroup>
                </>
              )}

              {selectedBlock.type === 'input' && (
                <>
                  <FieldGroup label="Input label" htmlFor="document-input-label">
                    <Input
                      id="document-input-label"
                      size="sm"
                      value={typeof selectedBlock.label === 'string' ? selectedBlock.label : ''}
                      onChange={(event) => patchSelectedBlock({ label: event.target.value })}
                      disabled={!designModeActive}
                    />
                  </FieldGroup>
                  <FieldGroup label="Bound field" htmlFor="document-input-field">
                    <Select
                      id="document-input-field"
                      size="sm"
                      value={typeof selectedBlock.sourceField === 'string' ? selectedBlock.sourceField : ''}
                      onChange={(event) => patchSelectedBlock({ sourceField: event.target.value })}
                      disabled={!bindingModeActive || availableColumns.length === 0}
                    >
                      <option value="">Select field</option>
                      {availableColumns.map((column: { name: string; type?: string }) => (
                        <option key={column.name} value={column.name}>
                          {column.name}{column.type ? ` (${column.type})` : ''}
                        </option>
                      ))}
                    </Select>
                  </FieldGroup>
                </>
              )}

              {selectedBlock.type === 'repeater' && (
                <FieldGroup label="Source field" htmlFor="document-repeater-field">
                  <Select
                    id="document-repeater-field"
                    size="sm"
                    value={typeof selectedBlock.sourceField === 'string' ? selectedBlock.sourceField : ''}
                    onChange={(event) => patchSelectedBlock({ sourceField: event.target.value })}
                    disabled={!bindingModeActive || availableColumns.length === 0}
                  >
                    <option value="">Select field</option>
                    {availableColumns.map((column: { name: string; type?: string }) => (
                      <option key={column.name} value={column.name}>
                        {column.name}{column.type ? ` (${column.type})` : ''}
                      </option>
                    ))}
                  </Select>
                </FieldGroup>
              )}

              {DATA_BOUND_BLOCK_TYPES.has(selectedBlock.type) && availableColumns.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-text-tertiary">Available columns</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {availableColumns.slice(0, 8).map((column: { name: string; type?: string }) => (
                      <span key={column.name} className="rounded-full bg-surface-1 px-2 py-1 text-[11px] text-text-secondary">
                        {column.name}
                      </span>
                    ))}
                    {availableColumns.length > 8 && (
                      <span className="rounded-full bg-surface-1 px-2 py-1 text-[11px] text-text-tertiary">
                        +{availableColumns.length - 8} more
                      </span>
                    )}
                  </div>
                </div>
              )}

              <div>
                <p className="text-xs font-medium text-text-tertiary">Page margin</p>
                <p className="mt-2 text-sm text-text-primary">
                  {definition.page.margin.top} / {definition.page.margin.right} / {definition.page.margin.bottom} / {definition.page.margin.left}
                </p>
              </div>

              <div>
                <p className="text-xs font-medium text-text-tertiary">Theme tokens</p>
                <p className="mt-2 text-sm text-text-primary">{Object.keys(definition.theme.palette).length} colors</p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  leadingIcon={<ArrowUp className="h-3.5 w-3.5" />}
                  onClick={() => handleMoveBlock(-1)}
                  disabled={!designModeActive || !selectedParentId}
                >
                  Move up
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  leadingIcon={<ArrowDown className="h-3.5 w-3.5" />}
                  onClick={() => handleMoveBlock(1)}
                  disabled={!designModeActive || !selectedParentId}
                >
                  Move down
                </Button>
              </div>

              <Button
                variant="danger"
                size="sm"
                fullWidth
                leadingIcon={<Trash2 className="h-3.5 w-3.5" />}
                onClick={handleDeleteBlock}
                disabled={!designModeActive || selectedBlock.id === definition.root.id}
              >
                Delete block
              </Button>

              <div className="rounded-xl border border-dashed border-[rgb(var(--border-line))] bg-surface-1 p-3 text-xs leading-5 text-text-tertiary">
                {canEdit
                  ? designModeActive
                    ? 'This first editing slice supports add, rename, reorder, delete, and page settings. Data binding and block-specific properties land next.'
                    : 'Design edits are locked while you are outside Design mode. Other modes remain visible so the future runtime flow is already represented.'
                  : 'Read-only access. Editing controls for the new workspace will respect the existing permission model.'}
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-[rgb(var(--border-line))] bg-surface-2 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <FileText className="h-4 w-4 text-brand" />
              Structure
            </div>
            <div className="mt-4 space-y-1">
              <BlockTreeNode block={definition.root} depth={0} selectedId={selectedBlockId} onSelect={setSelectedBlockId} />
            </div>
          </div>
        </aside>
      </div>

      {showDataSourcePicker && (
        <DataSourcePicker
          current={pickerCurrent}
          onSelect={handleBindDataSource}
          onClose={() => {
            setPickerSourceId(null);
            setShowDataSourcePicker(false);
          }}
        />
      )}
    </div>
  );
}