/**
 * WorkboardImportModal — list-page entry point for importing workboard
 * templates. Same flow as the import side of WorkboardImportExportModal,
 * extracted so the list page doesn't need a workboard prop.
 */
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Sparkles, Upload } from 'lucide-react';

import { useDatasets, useDatasetTables } from '@/hooks/use-datasets';
import { useImportWorkboard } from '@/hooks/use-workboards';
import { Button } from '@/components/ui/Button';
import { FieldGroup, Input } from '@/components/ui/Input';
import { Modal } from '@/components/common/Modal';
import { toast } from '@/lib/toast';
import type { DatasetTable } from '@/hooks/use-datasets';
import { workboardApi, type WorkboardImportReport } from '@/lib/api/workboards';

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
  const { data: datasets = [], isLoading: datasetsLoading, error: datasetsError } = useDatasets();
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
  const [autoMapping, setAutoMapping] = useState(false);
  // ``pendingAiMap`` holds the AI's proposal until the admin reviews the
  // diff and confirms. We never overwrite the live mapping silently —
  // user complaint was "AI thêm/sửa/xoá kiểu gì tôi cũng không biết".
  const [pendingAiMap, setPendingAiMap] = useState<{
    table_mapping: Record<string, number | ''>;
    column_mapping: Record<string, Record<string, string>>;
    ai_used: boolean;
  } | null>(null);

  const handleAutoMap = async () => {
    if (!bundle || !datasetId) return;
    setAutoMapping(true);
    try {
      const r = await workboardApi.autoMapImport(
        bundle as Record<string, unknown>,
        datasetId,
      );
      const nextTable: Record<string, number | ''> = {};
      for (const [k, v] of Object.entries(r.table_mapping || {})) {
        nextTable[k] = typeof v === 'number' ? v : '';
      }
      setPendingAiMap({
        table_mapping: nextTable,
        column_mapping: r.column_mapping || {},
        ai_used: r.ai_used,
      });
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Auto-map thất bại.'));
    } finally {
      setAutoMapping(false);
    }
  };

  const applyAiMap = () => {
    if (!pendingAiMap) return;
    setTableMapping(pendingAiMap.table_mapping);
    setColumnMapping(pendingAiMap.column_mapping);
    toast.success(
      pendingAiMap.ai_used
        ? 'AI đã áp mapping — bạn vẫn có thể chỉnh từng dòng trước khi Import.'
        : 'Đã áp mapping theo tên cột (AI không khả dụng).',
    );
    setPendingAiMap(null);
  };

  const sourceTables = useMemo(() => buildTemplateTables(bundle), [bundle]);
  const targetTables = useMemo(() => datasetTables.map(toTargetTable), [datasetTables]);
  const targetDatasetHasNoTables = Boolean(datasetId && !tablesLoading && targetTables.length === 0);

  useEffect(() => {
    if (!bundle || !datasetId) {
      setTableMapping({});
      setColumnMapping({});
      return;
    }
    setTableMapping((current) => {
      const next: Record<string, number | ''> = {};
      let changed = false;
      for (const source of sourceTables) {
        const currentValue = current[source.key];
        const stillValid =
          typeof currentValue === 'number' && targetTables.some((target) => target.id === currentValue);
        const nextValue = stillValid
          ? currentValue
          : inferTargetTable(source, targetTables)?.id ?? '';
        next[source.key] = nextValue;
        if (current[source.key] !== nextValue) changed = true;
      }
      // Skip the state update entirely when nothing actually moved — every
      // re-render here closes the open native <select>, which is what users
      // see as "vừa chọn xong nhảy mất". useDatasetTables refetch alone was
      // enough to keep this effect ping-ponging.
      return changed || Object.keys(next).length !== Object.keys(current).length
        ? next
        : current;
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
      setReport(null);
      setCreatedId(null);
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
      const importReport = (data._import_report as ImportReport) || null;
      setReport(importReport);

      // Open the workboard straight away when the import landed clean —
      // no missing tables, no missing columns, no app-users that need a
      // manual PIN reset. Anything sticky and we keep the success report
      // so the admin can read what needs follow-up before navigating.
      const cleanImport =
        !importReport
        || (
          importReport.missing_tables.length === 0
          && importReport.missing_columns.length === 0
          && (importReport.app_users_needing_pin?.length ?? 0) === 0
        );
      if (cleanImport && data.id) {
        toast.success('Đã import workboard — mở Builder');
        onClose();
        router.push(`/workboards/${data.id}`);
        return;
      }
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
              disabled={!bundle || !datasetId || targetDatasetHasNoTables || importMutation.isPending}
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
            description="Chọn dataset chứa các bảng dữ liệu cho workboard. Sau khi upload bundle bạn sẽ map từng bảng/cột nếu tên khác template."
          >
            <select
              value={datasetId ?? ''}
              onChange={(e) => setDatasetId(e.target.value ? Number(e.target.value) : null)}
              className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-body"
            >
              <option value="">
                {datasetsLoading
                  ? 'Đang tải danh sách dataset...'
                  : datasets.length === 0
                  ? '— Không có dataset nào —'
                  : '— Chọn dataset —'}
              </option>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            {!datasetsLoading && datasets.length === 0 && (
              <p className="mt-1 text-tiny text-warning">
                {datasetsError
                  ? 'Không tải được danh sách dataset — kiểm tra quyền truy cập hoặc kết nối.'
                  : 'Bạn chưa có dataset nào. Vào trang Datasets tạo dataset trước khi import workboard.'}
              </p>
            )}
            {targetDatasetHasNoTables && (
              <p className="mt-1 text-tiny text-warning">
                Dataset này chưa có bảng vật lý nào. Hãy thêm bảng vào dataset trước khi import.
              </p>
            )}
          </FieldGroup>

          {bundle && datasetId && (
            <>
              <div className="flex items-center justify-between rounded-md border border-brand/20 bg-brand/5 px-3 py-2">
                <div className="text-caption text-text-secondary">
                  <strong>AI auto-map</strong> đề xuất mapping bảng/cột dựa trên
                  tên + kiểu dữ liệu. Bấm để xem trước những thay đổi rồi
                  quyết định áp hay không — không có gì bị ghi đè trước khi
                  bạn duyệt.
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  leadingIcon={<Sparkles className="h-3.5 w-3.5" />}
                  loading={autoMapping}
                  disabled={autoMapping || tablesLoading}
                  onClick={handleAutoMap}
                  title="Gọi AI để gợi ý mapping. Sau đó bạn sẽ thấy preview diff trước khi áp."
                >
                  Gợi ý mapping bằng AI
                </Button>
              </div>

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
            </>
          )}
        </div>
      )}

      {pendingAiMap && (
        <AiMapPreviewModal
          sourceTables={sourceTables}
          targetTables={targetTables}
          currentTableMapping={tableMapping}
          currentColumnMapping={columnMapping}
          proposedTableMapping={pendingAiMap.table_mapping}
          proposedColumnMapping={pendingAiMap.column_mapping}
          aiUsed={pendingAiMap.ai_used}
          onCancel={() => setPendingAiMap(null)}
          onApply={applyAiMap}
        />
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

  if (targetTables.length === 0) {
    return (
      <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-caption text-warning">
        Dataset đích chưa có bảng nào để map. Import sẽ bị chặn cho đến khi dataset có ít nhất một bảng.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h4 className="text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
        Mapping bảng và cột
      </h4>
      <div className="max-h-[44vh] space-y-2 overflow-y-auto pr-1">
        {sourceTables.map((source) => {
          // ``tableMapping`` stores either a number id or '' (no mapping).
          // ``find`` does strict-equality, so coerce '' away before lookup
          // — otherwise ``item.id === ''`` is always false and the column
          // mapping editor below thinks no target is selected even when
          // the user just picked one.
          const mappedTargetId = tableMapping[source.key];
          const mappedTargetIdNum =
            typeof mappedTargetId === 'number' ? mappedTargetId : null;
          const target =
            mappedTargetIdNum === null
              ? null
              : targetTables.find((item) => item.id === mappedTargetIdNum) || null;
          const effectiveColumns = getEffectiveColumnMapping(
            source,
            target,
            columnMapping[source.key],
          );
          const unmappedColumns = target
            ? source.columns
                .filter((column) => !effectiveColumns[column.name])
                .map((column) => column.name)
            : [];
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
                  value={mappedTargetIdNum ?? ''}
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
                <>
                  {unmappedColumns.length > 0 && (
                    <p className="mt-2 rounded border border-warning/30 bg-warning/5 px-2 py-1 text-tiny text-warning">
                      {unmappedColumns.length} cột chưa map: {unmappedColumns.slice(0, 6).join(', ')}
                      {unmappedColumns.length > 6 ? '…' : ''}
                    </p>
                  )}
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
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


function ImportSuccessReport({
  report,
}: {
  report: ImportReport;
}) {
  const matched = report.matched_tables.length;
  const missing = report.missing_tables.length;
  const colIssues = report.missing_columns.length;
  const usersImported = report.app_users_imported ?? 0;
  const usersNeedingPin = report.app_users_needing_pin ?? [];
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
          {usersImported > 0 && ` ${usersImported} app user đã import.`}
        </div>
      </div>

      {usersNeedingPin.length > 0 && (
        <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-caption text-warning">
          <strong>{usersNeedingPin.length} user chưa có PIN</strong> (bundle export
          không kèm credentials). Vào tab <strong>Users</strong> trong Builder
          để đặt PIN cho:{' '}
          <span className="text-text-secondary">
            {usersNeedingPin.slice(0, 8).join(', ')}
            {usersNeedingPin.length > 8 && ` +${usersNeedingPin.length - 8} khác`}
          </span>
        </div>
      )}

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

      {colIssues > 0 && (
        <div>
          <h4 className="mb-1 text-tiny font-emphasis uppercase tracking-wider text-warning">
            <AlertTriangle className="mr-1 inline h-3 w-3" />
            Cột chưa khớp ({colIssues})
          </h4>
          <div className="space-y-1">
            {report.missing_columns.slice(0, 12).map((item, i) => (
              <div
                key={`${item.screen}-${item.where}-${item.column}-${i}`}
                className="rounded-md border border-warning/30 bg-warning/5 p-2 text-caption"
              >
                <code className="bg-surface-2 px-1">{item.column}</code>
                <span className="ml-2 text-tiny text-text-tertiary">
                  {item.screen || 'screen'} · {item.where}
                </span>
              </div>
            ))}
            {report.missing_columns.length > 12 && (
              <p className="text-tiny text-text-tertiary">
                Và {report.missing_columns.length - 12} cột khác.
              </p>
            )}
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


// ── AI map preview modal ────────────────────────────────────────────────

interface TableDiffRow {
  sourceKey: string;
  sourceLabel: string;
  before: string;
  after: string;
  changed: boolean;
}

interface ColumnDiffRow {
  sourceKey: string;
  sourceLabel: string;
  sourceColumn: string;
  before: string;
  after: string;
  status: 'unchanged' | 'added' | 'changed' | 'removed';
}

function AiMapPreviewModal({
  sourceTables,
  targetTables,
  currentTableMapping,
  currentColumnMapping,
  proposedTableMapping,
  proposedColumnMapping,
  aiUsed,
  onCancel,
  onApply,
}: {
  sourceTables: TemplateTable[];
  targetTables: TargetTable[];
  currentTableMapping: Record<string, number | ''>;
  currentColumnMapping: Record<string, Record<string, string>>;
  proposedTableMapping: Record<string, number | ''>;
  proposedColumnMapping: Record<string, Record<string, string>>;
  aiUsed: boolean;
  onCancel: () => void;
  onApply: () => void;
}) {
  const targetById = useMemo(() => {
    const map = new Map<number, TargetTable>();
    for (const t of targetTables) map.set(t.id, t);
    return map;
  }, [targetTables]);

  const tableDiffs = useMemo<TableDiffRow[]>(() => {
    return sourceTables.map((s) => {
      const before = currentTableMapping[s.key];
      const after = proposedTableMapping[s.key] ?? '';
      const labelOf = (id: number | '' | undefined) =>
        typeof id === 'number'
          ? (targetById.get(id)?.display_name
              || targetById.get(id)?.source_table_name
              || `#${id}`)
          : '— chưa map —';
      return {
        sourceKey: s.key,
        sourceLabel: s.display_name || s.source_table_name || `Table ${s.old_table_id}`,
        before: labelOf(before),
        after: labelOf(after),
        changed: before !== after,
      };
    });
  }, [sourceTables, currentTableMapping, proposedTableMapping, targetById]);

  const columnDiffs = useMemo<ColumnDiffRow[]>(() => {
    const out: ColumnDiffRow[] = [];
    for (const s of sourceTables) {
      const beforeCols = currentColumnMapping[s.key] || {};
      const afterCols = proposedColumnMapping[s.key] || {};
      const allCols = new Set<string>([
        ...s.columns.map((c) => c.name),
        ...Object.keys(beforeCols),
        ...Object.keys(afterCols),
      ]);
      for (const col of allCols) {
        const before = beforeCols[col] ?? '';
        const after = afterCols[col] ?? '';
        if (!before && !after) continue;
        let status: ColumnDiffRow['status'];
        if (before && !after) status = 'removed';
        else if (!before && after) status = 'added';
        else if (before === after) status = 'unchanged';
        else status = 'changed';
        out.push({
          sourceKey: s.key,
          sourceLabel: s.display_name || s.source_table_name || s.key,
          sourceColumn: col,
          before,
          after,
          status,
        });
      }
    }
    return out;
  }, [sourceTables, currentColumnMapping, proposedColumnMapping]);

  const tableChanged = tableDiffs.filter((r) => r.changed).length;
  const colAdded = columnDiffs.filter((r) => r.status === 'added').length;
  const colChanged = columnDiffs.filter((r) => r.status === 'changed').length;
  const colRemoved = columnDiffs.filter((r) => r.status === 'removed').length;

  return (
    <Modal
      isOpen
      onClose={onCancel}
      title={aiUsed ? 'AI đề xuất mapping' : 'Đề xuất mapping (heuristic)'}
      size="xl"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Huỷ — không thay đổi
          </Button>
          <Button variant="primary" size="sm" onClick={onApply}>
            Áp dụng đề xuất
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="rounded-md border border-info/20 bg-info/5 p-3 text-caption text-text-secondary">
          {aiUsed ? (
            <>
              AI đã so sánh schema source (template) với schema target (dataset)
              và đề xuất các thay đổi sau. <strong>Chưa có gì được áp dụng</strong> —
              xem kỹ rồi bấm <em>Áp dụng đề xuất</em>, hoặc Huỷ để giữ mapping
              hiện tại.
            </>
          ) : (
            <>
              AI không khả dụng (chưa cấu hình API key hoặc đã hết quota).
              Hệ thống đã fallback sang khớp tên cột theo heuristic
              (lowercase + bỏ ký tự đặc biệt). Xem các thay đổi rồi quyết định.
            </>
          )}
        </div>

        <div className="grid grid-cols-4 gap-2 text-center text-caption">
          <DiffStat label="Bảng đổi" value={tableChanged} tone="info" />
          <DiffStat label="Cột thêm" value={colAdded} tone="success" />
          <DiffStat label="Cột đổi" value={colChanged} tone="warning" />
          <DiffStat label="Cột bỏ" value={colRemoved} tone="danger" />
        </div>

        <div>
          <h4 className="mb-1 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
            Mapping bảng
          </h4>
          {tableDiffs.length === 0 ? (
            <p className="text-tiny text-text-tertiary">Không có bảng nào.</p>
          ) : (
            <div className="overflow-hidden rounded-md border border-[rgb(var(--border-line))]">
              <table className="w-full text-caption">
                <thead className="bg-surface-2 text-tiny text-text-tertiary">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Source</th>
                    <th className="px-3 py-1.5 text-left font-medium">Hiện tại</th>
                    <th className="px-3 py-1.5 text-left font-medium">Đề xuất</th>
                  </tr>
                </thead>
                <tbody>
                  {tableDiffs.map((row) => (
                    <tr
                      key={row.sourceKey}
                      className={`border-t border-[rgb(var(--border-line))] ${
                        row.changed ? 'bg-warning/5' : ''
                      }`}
                    >
                      <td className="px-3 py-1.5 font-medium text-text-primary">
                        {row.sourceLabel}
                      </td>
                      <td className="px-3 py-1.5 text-text-tertiary">{row.before}</td>
                      <td className="px-3 py-1.5">
                        <span
                          className={
                            row.changed
                              ? 'font-medium text-warning'
                              : 'text-text-secondary'
                          }
                        >
                          {row.after}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <h4 className="mb-1 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
            Mapping cột
          </h4>
          {columnDiffs.length === 0 ? (
            <p className="text-tiny text-text-tertiary">
              Không có cột nào đề xuất thay đổi.
            </p>
          ) : (
            <div className="max-h-[40vh] overflow-auto rounded-md border border-[rgb(var(--border-line))]">
              <table className="w-full text-caption">
                <thead className="sticky top-0 bg-surface-2 text-tiny text-text-tertiary">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Bảng</th>
                    <th className="px-3 py-1.5 text-left font-medium">Cột source</th>
                    <th className="px-3 py-1.5 text-left font-medium">Hiện tại</th>
                    <th className="px-3 py-1.5 text-left font-medium">Đề xuất</th>
                    <th className="px-3 py-1.5 text-left font-medium">Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {columnDiffs.map((row, idx) => (
                    <tr
                      key={`${row.sourceKey}-${row.sourceColumn}-${idx}`}
                      className="border-t border-[rgb(var(--border-line))]"
                    >
                      <td className="px-3 py-1 text-text-tertiary">{row.sourceLabel}</td>
                      <td className="px-3 py-1 font-mono text-text-primary">
                        {row.sourceColumn}
                      </td>
                      <td className="px-3 py-1 font-mono text-text-tertiary">
                        {row.before || '—'}
                      </td>
                      <td className="px-3 py-1 font-mono">
                        <span className={diffStatusToClass(row.status)}>
                          {row.after || '—'}
                        </span>
                      </td>
                      <td className="px-3 py-1">
                        <DiffStatusBadge status={row.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function DiffStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'info' | 'success' | 'warning' | 'danger';
}) {
  const toneClass = {
    info: 'text-info border-info/30 bg-info/5',
    success: 'text-success border-success/30 bg-success/5',
    warning: 'text-warning border-warning/30 bg-warning/5',
    danger: 'text-danger border-danger/30 bg-danger/5',
  }[tone];
  return (
    <div className={`rounded-md border ${toneClass} p-2`}>
      <div className="text-h3 font-emphasis">{value}</div>
      <div className="text-tiny opacity-70">{label}</div>
    </div>
  );
}

function diffStatusToClass(status: ColumnDiffRow['status']): string {
  switch (status) {
    case 'added':
      return 'text-success';
    case 'changed':
      return 'text-warning';
    case 'removed':
      return 'text-danger line-through';
    default:
      return 'text-text-tertiary';
  }
}

function DiffStatusBadge({ status }: { status: ColumnDiffRow['status'] }) {
  const text = {
    unchanged: 'không đổi',
    added: 'thêm',
    changed: 'đổi',
    removed: 'bỏ',
  }[status];
  const cls = {
    unchanged: 'bg-surface-2 text-text-tertiary',
    added: 'bg-success/15 text-success',
    changed: 'bg-warning/15 text-warning',
    removed: 'bg-danger/15 text-danger',
  }[status];
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-tiny ${cls}`}>
      {text}
    </span>
  );
}
