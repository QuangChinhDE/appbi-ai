/**
 * WorkboardImportExportModal — share workboard layouts as portable JSON.
 *
 * Export: fetches GET /workboards/{id}/export and offers it as a download.
 * The bundle embeds dataset snapshot + every referenced table's schema so
 * the same workboard can be re-created on another instance.
 *
 * Import: takes a bundle file + the target dataset, calls
 * POST /workboards/import-template, then surfaces a summary of which
 * tables/columns matched. Tables that don't match are reported as
 * "needs wiring" — the workboard still gets created so the admin can
 * fix the missing references in the Builder afterwards.
 */
'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileJson,
  Loader2,
  Upload,
} from 'lucide-react';

import { apiClient } from '@/lib/api-client';
import { useDatasets } from '@/hooks/use-datasets';
import { Button } from '@/components/ui/Button';
import { FieldGroup, Input } from '@/components/ui/Input';
import { Modal } from '@/components/common/Modal';
import { toast } from '@/lib/toast';
import type { Workboard } from '@/lib/api/workboards';

interface Props {
  workboard: Workboard;
  mode: 'export' | 'import';
  onClose: () => void;
}

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

export default function WorkboardImportExportModal({
  workboard,
  mode,
  onClose,
}: Props) {
  return mode === 'export' ? (
    <ExportPanel workboard={workboard} onClose={onClose} />
  ) : (
    <ImportPanel onClose={onClose} />
  );
}


// ── Export ────────────────────────────────────────────────────────────

function ExportPanel({
  workboard,
  onClose,
}: {
  workboard: Workboard;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [bundle, setBundle] = useState<any | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await apiClient.get(`/workboards/${workboard.id}/export`);
        if (alive) setBundle(r.data);
      } catch (err: any) {
        toast.error(err?.response?.data?.detail || 'Không export được.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workboard.id]);

  const handleDownload = () => {
    if (!bundle) return;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const slug = workboard.slug || `workboard-${workboard.id}`;
    a.download = `${slug}.workboard.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopy = async () => {
    if (!bundle) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
      toast.success('Đã copy vào clipboard');
    } catch {
      toast.error('Trình duyệt không cho copy');
    }
  };

  const tablesMeta = (bundle?.tables_meta as Record<string, any>) || {};
  const tableCount = Object.keys(tablesMeta).length;
  const screens = (bundle?.layout_json?.screens || []) as Array<any>;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Export workboard"
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Đóng
          </Button>
          <Button variant="secondary" size="sm" onClick={handleCopy} disabled={!bundle}>
            Copy JSON
          </Button>
          <Button
            variant="primary"
            size="sm"
            leadingIcon={<Download className="h-3.5 w-3.5" />}
            onClick={handleDownload}
            disabled={!bundle}
          >
            Tải file .json
          </Button>
        </>
      }
    >
      {loading && !bundle ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
        </div>
      ) : !bundle ? (
        <p className="text-caption text-text-tertiary">Không có dữ liệu.</p>
      ) : (
        <div className="space-y-4">
          <div className="rounded-md border border-info/20 bg-info/5 p-3 text-caption text-text-secondary">
            File export gồm: layout đầy đủ + snapshot tất cả{' '}
            <strong>{tableCount}</strong> bảng được tham chiếu (tên bảng + cột).
            Khi import vào instance khác, AppBI sẽ map sang bảng có cùng{' '}
            <code className="rounded bg-surface-2 px-1">source_table_name</code> ở
            target dataset; bảng không khớp sẽ để trống và bạn fix trong Builder.
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Stat label="Screens" value={screens.length} />
            <Stat label="Bảng tham chiếu" value={tableCount} />
            <Stat label="Bundle version" value={String(bundle.bundle_version ?? 1)} />
          </div>

          <div>
            <h4 className="mb-1 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
              Bảng có trong bundle
            </h4>
            <div className="space-y-1">
              {Object.entries(tablesMeta).map(([id, m]: [string, any]) => (
                <div
                  key={id}
                  className="flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-caption"
                >
                  <FileJson className="h-3.5 w-3.5 text-text-tertiary" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-emphasis text-text-primary">
                      {m.display_name || m.source_table_name || `Table ${id}`}
                    </div>
                    <div className="truncate text-tiny text-text-quaternary">
                      {m.source_table_name} • {m.columns?.length || 0} cột •
                      dataset: {m.dataset_name || '?'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}


// ── Import ────────────────────────────────────────────────────────────

function ImportPanel({ onClose }: { onClose: () => void }) {
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
            description="Bảng trong bundle được map theo source_table_name vào dataset này. Bảng không khớp sẽ để null — bạn fix sau trong Builder."
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
          {matched} bảng map thành công. {missing > 0 && `${missing} bảng chưa khớp. `}
          {colIssues > 0 &&
            `${colIssues} cột không tồn tại trong target table — sẽ hiện trong Builder để bạn dọn.`}
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

      {colIssues > 0 && (
        <div>
          <h4 className="mb-1 text-tiny font-emphasis uppercase tracking-wider text-text-tertiary">
            Cột không tồn tại ({colIssues})
          </h4>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {report.missing_columns.map((c, i) => (
              <div
                key={i}
                className="flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-tiny"
              >
                <span className="rounded bg-surface-2 px-1.5 py-0.5 text-text-secondary">
                  {c.screen}
                </span>
                <span className="text-text-tertiary">{c.where}</span>
                <code className="bg-danger/10 px-1 text-danger">{c.column}</code>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-2 text-center">
      <div className="text-h3 font-emphasis text-text-primary">{value}</div>
      <div className="text-tiny text-text-tertiary">{label}</div>
    </div>
  );
}
