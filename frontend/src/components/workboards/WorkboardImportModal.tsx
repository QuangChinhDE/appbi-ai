/**
 * WorkboardImportModal — list-page entry point for importing workboard
 * templates. Same flow as the import side of WorkboardImportExportModal,
 * extracted so the list page doesn't need a workboard prop.
 */
'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Upload } from 'lucide-react';

import { apiClient } from '@/lib/api-client';
import { useDatasets } from '@/hooks/use-datasets';
import { Button } from '@/components/ui/Button';
import { FieldGroup, Input } from '@/components/ui/Input';
import { Modal } from '@/components/common/Modal';
import { toast } from '@/lib/toast';

interface ImportReport {
  matched_tables: Array<{
    old_table_id: number;
    source_table_name: string | null;
    display_name: string | null;
    new_table_id: number | null;
  }>;
  missing_tables: Array<{
    old_table_id: number;
    source_table_name: string | null;
    display_name: string | null;
  }>;
  missing_columns: Array<{
    screen: string;
    where: string;
    column: string;
  }>;
}

export default function WorkboardImportModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { data: datasets = [] } = useDatasets();
  const [bundle, setBundle] = useState<any | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [datasetId, setDatasetId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [createdId, setCreatedId] = useState<number | null>(null);

  const handleFile = async (file: File) => {
    setBundleError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (parsed?.kind !== 'workboard_template') {
        setBundleError('File không phải bundle workboard hợp lệ.');
        return;
      }
      setBundle(parsed);
      const wb = parsed.workboard || {};
      if (wb.name && !name) setName(`${wb.name} (imported)`);
    } catch {
      setBundleError('Không đọc được file JSON.');
    }
  };

  const handleSubmit = async () => {
    if (!bundle || !datasetId) return;
    setSubmitting(true);
    try {
      const r = await apiClient.post('/workboards/_import_template', {
        bundle,
        target_dataset_id: datasetId,
        target_name: name.trim() || undefined,
      });
      const data = r.data;
      setCreatedId(data.id);
      setReport((data._import_report as ImportReport) || null);
      toast.success('Đã import workboard');
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || 'Import thất bại.');
    } finally {
      setSubmitting(false);
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
              disabled={!bundle || !datasetId || submitting}
              loading={submitting}
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
                bảng tham chiếu, {(bundle.layout_json?.screens || []).length} screen.
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
            description="Bảng trong bundle map theo source_table_name vào dataset này. Bảng không khớp sẽ để null — fix sau trong Builder."
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
        </div>
      )}
    </Modal>
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
