/**
 * WorkboardImportModal — list-page entry point for importing workboard
 * templates. Same flow as the import side of WorkboardImportExportModal,
 * extracted so the list page doesn't need a workboard prop.
 */
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Upload } from 'lucide-react';

import { useDatasets, useDatasetTables } from '@/hooks/use-datasets';
import { useImportWorkboard } from '@/hooks/use-workboards';
import { Button } from '@/components/ui/Button';
import { FieldGroup, Input } from '@/components/ui/Input';
import { Modal } from '@/components/common/Modal';
import { toast } from '@/lib/toast';
import type { DatasetTable } from '@/hooks/use-datasets';
import type { WorkboardImportReport } from '@/lib/api/workboards';

type ImportReport = WorkboardImportReport;

interface TemplateColumn {
  name: string;
  type?: string;
}

interface TemplateTable {
  key: string;
  old_table_id: number;
  source_table_name: string | null;
  display_name: string | null;
  dataset_name?: string | null;
  columns: TemplateColumn[];
}

interface TargetTable {
  id: number;
  source_table_name?: string | null;
  display_name: string;
  columns: TemplateColumn[];
}

interface WorkboardTemplateBundle {
  kind?: string;
  workboard?: { name?: string };
  tables_meta?: Record<string, TemplateTableMeta>;
  layout_json?: { screens?: unknown[] };
}

interface TemplateTableMeta {
  source_table_name?: string | null;
  display_name?: string | null;
  dataset_name?: string | null;
  columns?: unknown;
}

interface ApiErrorShape {
  response?: {
    data?: {
      detail?: string;
    };
  };
}

export default function WorkboardImportModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { data: datasets = [] } = useDatasets();
  const importMutation = useImportWorkboard();
  const [bundle, setBundle] = useState<WorkboardTemplateBundle | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [datasetId, setDatasetId] = useState<number | null>(null);
  const { data: datasetTables = [], isLoading: tablesLoading } = useDatasetTables(datasetId);
  const [name, setName] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [createdId, setCreatedId] = useState<number | null>(null);
  const [tableMapping, setTableMapping] = useState<Record<string, number | ''>>({});
  const [columnMapping, setColumnMapping] = useState<Record<string, Record<string, string>>>({});

  const sourceTables = useMemo(() => buildTemplateTables(bundle), [bundle]);
  const targetTables = useMemo(() => datasetTables.map(toTargetTable), [datasetTables]);

  useEffect(() => {
    if (!bundle || !datasetId) {
      setTableMapping({});
      setColumnMapping({});
      return;
    }
    setTableMapping((current) => {
      const next: Record<string, number | ''> = {};
      for (const source of sourceTables) {
        const currentValue = current[source.key];
        const stillValid =
          typeof currentValue === 'number' && targetTables.some((target) => target.id === currentValue);
        next[source.key] = stillValid
          ? currentValue
          : inferTargetTable(source, targetTables)?.id ?? '';
      }
      return next;
    });
  }, [bundle, datasetId, sourceTables, targetTables]);

  const handleFile = async (file: File) => {
    setBundleError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as WorkboardTemplateBundle;
      if (parsed.kind !== 'workboard_template') {
        setBundleError('File không phải bundle workboard hợp lệ.');
        return;
      }
      setBundle(parsed);
      if (parsed.workboard?.name && !name) setName(`${parsed.workboard.name} (imported)`);
    } catch {
      setBundleError('Không đọc được file JSON.');
    }
  };

  const handleSubmit = async () => {
    if (!bundle || !datasetId) return;
    try {
      const mappingPayload = buildMappingPayload(
        sourceTables,
        targetTables,
        tableMapping,
        columnMapping,
      );
      const data = await importMutation.mutateAsync({
        bundle: bundle as Record<string, unknown>,
        target_dataset_id: datasetId,
        target_name: name.trim() || undefined,
        table_mapping: mappingPayload.table_mapping,
        column_mapping: mappingPayload.column_mapping,
      });
      setCreatedId(data.id);
      setReport((data._import_report as ImportReport) || null);
      toast.success('Đã import workboard');
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Import thất bại.'));
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Import workboard từ template"
      size="lg"
      footer={
        createdId ? (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Đóng
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                onClose();
                router.push(`/workboards/${createdId}`);
              }}
            >
              Mở workboard mới
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Huỷ
            </Button>
            <Button
              variant="primary"
              size="sm"
              leadingIcon={<Upload className="h-3.5 w-3.5" />}
              onClick={handleSubmit}
              disabled={!bundle || !datasetId || importMutation.isPending}
              loading={importMutation.isPending}
            >
              Import
            </Button>
          </>
        )
      }
    >
      {createdId && report ? (
        <ImportSuccessReport report={report} />
      ) : (
        <div className="space-y-4">
          <FieldGroup
            label="Bundle file (.json)"
            description="Là file bạn export từ workboard khác."
            required
          >
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
              className="block w-full text-caption"
            />
            {bundleError && (
              <p className="mt-1 text-tiny text-danger">{bundleError}</p>
            )}
            {bundle && (
              <div className="mt-2 rounded-md border border-success/20 bg-success/5 p-2 text-caption text-text-secondary">
                <CheckCircle2 className="mr-1 inline h-3.5 w-3.5 text-success" />
                Bundle hợp lệ — {Object.keys(bundle.tables_meta || {}).length}{' '}
                bảng tham chiếu, {Array.isArray(bundle.layout_json?.screens) ? bundle.layout_json.screens.length : 0} screen.
              </div>
            )}
          </FieldGroup>

          <FieldGroup
            label="Tên workboard mới"
            description="Để trống = dùng tên từ bundle."
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Imported workboard"
              disabled={!bundle}
            />
          </FieldGroup>

          <FieldGroup
            label="Dataset đích"
            required
            description="Chọn dataset rồi map lại bảng/cột nếu tên trên máy này khác template."
          >
            <select
              value={datasetId ?? ''}
              onChange={(e) => setDatasetId(e.target.value ? Number(e.target.value) : null)}
              disabled={!bundle}
              className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-body disabled:opacity-50"
            >
              <option value="">— Chọn dataset —</option>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </FieldGroup>

          {bundle && datasetId && (
            <ImportMappingEditor
              sourceTables={sourceTables}
              targetTables={targetTables}
              tableMapping={tableMapping}
              columnMapping={columnMapping}
              tablesLoading={tablesLoading}
              onTableMappingChange={(sourceKey, targetId) => {
                setTableMapping((current) => ({ ...current, [sourceKey]: targetId }));
              }}
              onColumnMappingChange={(sourceKey, sourceColumn, targetColumn) => {
                setColumnMapping((current) => ({
                  ...current,
                  [sourceKey]: {
                    ...(current[sourceKey] || {}),
                    [sourceColumn]: targetColumn,
                  },
                }));
              }}
            />
          )}
        </div>
      )}
    </Modal>
  );
}


function ImportMappingEditor({
  sourceTables,
  targetTables,
  tableMapping,
  columnMapping,
  tablesLoading,
  onTableMappingChange,
  onColumnMappingChange,
}: {
  sourceTables: TemplateTable[];
  targetTables: TargetTable[];
  tableMapping: Record<string, number | ''>;
  columnMapping: Record<string, Record<string, string>>;
  tablesLoading: boolean;
  onTableMappingChange: (sourceKey: string, targetId: number | '') => void;
  onColumnMappingChange: (
    sourceKey: string,
    sourceColumn: string,
    targetColumn: string,
  ) => void;
}) {
  if (tablesLoading) {
    return (
      <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-3 text-caption text-text-tertiary">
        Đang tải bảng trong dataset đích...
      </div>
    );
  }

  if (sourceTables.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <h4 className="text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
        Mapping bảng và cột
      </h4>
      <div className="max-h-[44vh] space-y-2 overflow-y-auto pr-1">
        {sourceTables.map((source) => {
          const mappedTargetId = tableMapping[source.key] || '';
          const target = targetTables.find((item) => item.id === mappedTargetId) || null;
          const effectiveColumns = getEffectiveColumnMapping(
            source,
            target,
            columnMapping[source.key],
          );
          return (
            <div
              key={source.key}
              className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-3"
            >
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(220px,280px)]">
                <div className="min-w-0">
                  <div className="truncate text-caption font-emphasis text-text-primary">
                    {source.display_name || source.source_table_name || `Table ${source.old_table_id}`}
                  </div>
                  <div className="truncate text-tiny text-text-tertiary">
                    {source.source_table_name || 'Không có source_table_name'} · {source.columns.length} cột
                  </div>
                </div>
                <select
                  value={mappedTargetId}
                  onChange={(e) =>
                    onTableMappingChange(
                      source.key,
                      e.target.value ? Number(e.target.value) : '',
                    )
                  }
                  className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2.5 py-1.5 text-caption"
                >
                  <option value="">— Không map bảng này —</option>
                  {targetTables.map((targetTable) => (
                    <option key={targetTable.id} value={targetTable.id}>
                      {targetTable.display_name} ({targetTable.source_table_name || `#${targetTable.id}`})
                    </option>
                  ))}
                </select>
              </div>

              {target && source.columns.length > 0 && (
                <div className="mt-3 grid gap-1.5 md:grid-cols-2">
                  {source.columns.map((column) => (
                    <label
                      key={column.name}
                      className="grid grid-cols-[minmax(0,1fr)_minmax(130px,1fr)] items-center gap-2 text-tiny"
                    >
                      <span className="truncate text-text-secondary" title={column.name}>
                        {column.name}
                      </span>
                      <select
                        value={effectiveColumns[column.name] || ''}
                        onChange={(e) =>
                          onColumnMappingChange(source.key, column.name, e.target.value)
                        }
                        className="min-w-0 rounded border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1"
                      >
                        <option value="">— bỏ qua —</option>
                        {target.columns.map((targetColumn) => (
                          <option key={targetColumn.name} value={targetColumn.name}>
                            {targetColumn.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


function ImportSuccessReport({ report }: { report: ImportReport }) {
  const matched = report.matched_tables.length;
  const missing = report.missing_tables.length;
  const colIssues = report.missing_columns.length;
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-success/20 bg-success/5 p-3 text-caption">
        <div className="font-emphasis text-success">
          <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />
          Workboard đã được tạo
        </div>
        <div className="mt-1 text-text-secondary">
          {matched} bảng map thành công.
          {missing > 0 && ` ${missing} bảng chưa khớp.`}
          {colIssues > 0 && ` ${colIssues} cột không tồn tại — sẽ hiện trong Builder để bạn dọn.`}
        </div>
      </div>

      {missing > 0 && (
        <div>
          <h4 className="mb-1 text-tiny font-emphasis uppercase tracking-wider text-warning">
            <AlertTriangle className="mr-1 inline h-3 w-3" />
            Bảng chưa khớp ({missing})
          </h4>
          <div className="space-y-1">
            {report.missing_tables.map((t, i) => (
              <div
                key={i}
                className="rounded-md border border-warning/30 bg-warning/5 p-2 text-caption"
              >
                <div className="font-emphasis text-text-primary">
                  {t.display_name || t.source_table_name || `Table ${t.old_table_id}`}
                </div>
                <div className="text-tiny text-text-tertiary">
                  source_table_name:{' '}
                  <code className="bg-surface-2 px-1">{t.source_table_name}</code>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


function buildTemplateTables(bundle: WorkboardTemplateBundle | null): TemplateTable[] {
  const tablesMeta = bundle?.tables_meta || {};
  return Object.entries(tablesMeta).map(([key, meta]) => ({
    key,
    old_table_id: Number(key),
    source_table_name: meta?.source_table_name ?? null,
    display_name: meta?.display_name ?? null,
    dataset_name: meta?.dataset_name ?? null,
    columns: normaliseColumns(meta?.columns),
  }));
}

function toTargetTable(table: DatasetTable): TargetTable {
  return {
    id: table.id,
    source_table_name: table.source_table_name,
    display_name: table.display_name,
    columns: normaliseColumns(table.columns_cache),
  };
}

function normaliseColumns(raw: unknown): TemplateColumn[] {
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { columns?: unknown }).columns)
      ? ((raw as { columns: unknown[] }).columns)
      : [];
  return arr
    .filter((item): item is { name: unknown; type?: unknown } =>
      Boolean(item && typeof item === 'object' && 'name' in item),
    )
    .map((item) => ({ name: String(item.name), type: item.type ? String(item.type) : undefined }));
}

function normaliseName(value?: string | null): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[`"\[\]]/g, '')
    .replace(/^[^.]+\./, '')
    .replace(/[^a-z0-9]+/g, '');
}

function inferTargetTable(source: TemplateTable, targets: TargetTable[]): TargetTable | null {
  const sourceNames = [
    source.source_table_name,
    source.display_name,
    source.source_table_name?.split('.').pop(),
  ].map(normaliseName).filter(Boolean);
  return (
    targets.find((target) => {
      const targetNames = [
        target.source_table_name,
        target.display_name,
        target.source_table_name?.split('.').pop(),
      ].map(normaliseName).filter(Boolean);
      return sourceNames.some((name) => targetNames.includes(name));
    }) || null
  );
}

function inferTargetColumn(sourceColumn: string, targetColumns: TemplateColumn[]): string {
  const exact = targetColumns.find((item) => item.name === sourceColumn);
  if (exact) return exact.name;
  const normalisedSource = normaliseName(sourceColumn);
  return targetColumns.find((item) => normaliseName(item.name) === normalisedSource)?.name || '';
}

function getEffectiveColumnMapping(
  source: TemplateTable,
  target: TargetTable | null,
  saved?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!target) return out;
  for (const column of source.columns) {
    const savedValue = saved?.[column.name];
    out[column.name] =
      savedValue && target.columns.some((item) => item.name === savedValue)
        ? savedValue
        : inferTargetColumn(column.name, target.columns);
  }
  return out;
}

function buildMappingPayload(
  sources: TemplateTable[],
  targets: TargetTable[],
  tableMapping: Record<string, number | ''>,
  columnMapping: Record<string, Record<string, string>>,
): {
  table_mapping: Record<string, number | null>;
  column_mapping: Record<string, Record<string, string>>;
} {
  const tablePayload: Record<string, number | null> = {};
  const columnPayload: Record<string, Record<string, string>> = {};

  for (const source of sources) {
    const mappedTargetId = tableMapping[source.key] || '';
    tablePayload[source.key] = mappedTargetId ? Number(mappedTargetId) : null;
    const target = targets.find((item) => item.id === mappedTargetId) || null;
    const effective = getEffectiveColumnMapping(source, target, columnMapping[source.key]);
    const mappedColumns = Object.fromEntries(
      Object.entries(effective).filter(([, targetColumn]) => Boolean(targetColumn)),
    );
    if (Object.keys(mappedColumns).length > 0) {
      columnPayload[source.key] = mappedColumns;
    }
  }

  return { table_mapping: tablePayload, column_mapping: columnPayload };
}

function getApiErrorMessage(err: unknown, fallback: string): string {
  return (err as ApiErrorShape)?.response?.data?.detail || fallback;
}
