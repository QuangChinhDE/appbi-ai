'use client';

import React, { useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  X, Upload, Loader2, ChevronRight, ChevronLeft,
  CheckCircle2, AlertTriangle, FileSpreadsheet, Database,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { useImportAnalyze, useImportConfirm } from '@/hooks/use-import-analysis';
import type {
  AnalysisResponse,
  AnalysisColumn,
  AnalysisHeaderLine,
  AnalysisColumnGroup,
  ImportConfirmPayload,
} from '@/types/import-analysis';

interface ImportWizardProps {
  open: boolean;
  onClose: () => void;
}

export function ImportWizard({ open, onClose }: ImportWizardProps) {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [file, setFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);

  // Step 2 editable state
  const [editedTitle, setEditedTitle] = useState('');
  const [editedColumns, setEditedColumns] = useState<AnalysisColumn[]>([]);
  const [editedGroups, setEditedGroups] = useState<AnalysisColumnGroup[]>([]);
  const [editedHeaderLines, setEditedHeaderLines] = useState<AnalysisHeaderLine[]>([]);

  // Step 3
  const [templateName, setTemplateName] = useState('');
  const [includeData, setIncludeData] = useState(true);

  const fileInputRef = useRef<HTMLInputElement>(null!);  // non-null assertion for ref compat
  const analyzeMutation = useImportAnalyze();
  const confirmMutation = useImportConfirm();

  const handleFileSelect = useCallback(
    (f: File) => {
      setFile(f);
      analyzeMutation.mutate(
        { file: f },
        {
          onSuccess: (result) => {
            setAnalysis(result);
            setEditedTitle(result.report_title);
            setEditedColumns(result.columns);
            setEditedGroups(result.column_groups);
            setEditedHeaderLines(result.header_lines);
            setTemplateName(result.report_title || f.name.replace(/\.xlsx?$/i, ''));
            setStep(2);
          },
          onError: (err) => {
            toast.error(`Loi phan tich: ${err.message}`);
          },
        },
      );
    },
    [analyzeMutation],
  );

  const handleSheetChange = useCallback(
    (sheetName: string) => {
      if (!file) return;
      analyzeMutation.mutate(
        { file, sheetName },
        {
          onSuccess: (result) => {
            setAnalysis(result);
            setEditedTitle(result.report_title);
            setEditedColumns(result.columns);
            setEditedGroups(result.column_groups);
            setEditedHeaderLines(result.header_lines);
          },
        },
      );
    },
    [file, analyzeMutation],
  );

  const handleConfirm = useCallback(() => {
    if (!analysis) return;
    const payload: ImportConfirmPayload = {
      file_token: analysis.file_token,
      template_name: templateName,
      page_size: 'A4',
      orientation: 'landscape',
      include_data: includeData,
      analyzed_sheet: analysis.analyzed_sheet,
      report_title: editedTitle,
      report_meta: analysis.report_meta,
      header_lines: editedHeaderLines,
      columns: editedColumns,
      column_groups: editedGroups,
      group_by_column: analysis.group_by_column,
      show_subtotals: analysis.show_subtotals,
      footer_lines: analysis.footer_lines,
      signature_count: analysis.signature_count,
      signature_labels: analysis.signature_labels,
      theme: analysis.theme,
      recommended_table_schema: analysis.recommended_table_schema,
    };
    confirmMutation.mutate(payload, {
      onSuccess: (result) => {
        toast.success('Template da tao thanh cong!');
        onClose();
        router.push(`/templates/${result.template_id}`);
      },
      onError: (err) => {
        toast.error(`Loi tao template: ${err.message}`);
      },
    });
  }, [analysis, templateName, includeData, editedTitle, editedHeaderLines, editedColumns, editedGroups, confirmMutation, onClose, router]);

  const handleReset = () => {
    setStep(1);
    setFile(null);
    setAnalysis(null);
    analyzeMutation.reset();
    confirmMutation.reset();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="flex w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl" style={{ maxHeight: '88vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <div className="flex items-center gap-3">
            <FileSpreadsheet className="h-5 w-5 text-green-600" />
            <span className="text-sm font-semibold text-gray-900">Import from Excel</span>
            <StepIndicator current={step} />
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {step === 1 && (
            <Step1Upload
              file={file}
              isAnalyzing={analyzeMutation.isPending}
              onFileSelect={handleFileSelect}
              fileInputRef={fileInputRef}
            />
          )}
          {step === 2 && analysis && (
            <Step2Preview
              analysis={analysis}
              editedTitle={editedTitle}
              editedColumns={editedColumns}
              editedGroups={editedGroups}
              editedHeaderLines={editedHeaderLines}
              onTitleChange={setEditedTitle}
              onColumnsChange={setEditedColumns}
              onSheetChange={handleSheetChange}
              isReanalyzing={analyzeMutation.isPending}
            />
          )}
          {step === 3 && analysis && (
            <Step3Confirm
              analysis={analysis}
              templateName={templateName}
              includeData={includeData}
              editedColumns={editedColumns}
              onTemplateNameChange={setTemplateName}
              onIncludeDataChange={setIncludeData}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-5 py-3">
          <div>
            {step > 1 && (
              <button
                onClick={() => setStep((step - 1) as 1 | 2 | 3)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 transition-colors"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                Quay lai
              </button>
            )}
            {step === 1 && (
              <button
                onClick={onClose}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 transition-colors"
              >
                Dong
              </button>
            )}
          </div>
          <div>
            {step === 2 && (
              <button
                onClick={() => setStep(3)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
              >
                Tiep theo
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
            {step === 3 && (
              <button
                onClick={handleConfirm}
                disabled={confirmMutation.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-5 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
              >
                {confirmMutation.isPending ? (
                  <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Dang tao...</>
                ) : (
                  <><CheckCircle2 className="h-3.5 w-3.5" /> Tao Template</>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Step indicators ── */

function StepIndicator({ current }: { current: number }) {
  const steps = ['Upload', 'Preview', 'Xac nhan'];
  return (
    <div className="flex items-center gap-1 ml-4">
      {steps.map((label, i) => {
        const num = i + 1;
        const active = num === current;
        const done = num < current;
        return (
          <React.Fragment key={num}>
            {i > 0 && <div className="h-px w-4 bg-gray-300" />}
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                active
                  ? 'bg-blue-100 text-blue-700'
                  : done
                    ? 'bg-green-100 text-green-700'
                    : 'bg-gray-100 text-gray-400'
              }`}
            >
              {done ? <CheckCircle2 className="h-3 w-3" /> : num}
              <span className="hidden sm:inline">{label}</span>
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* ── Step 1: Upload ── */

function Step1Upload({
  file,
  isAnalyzing,
  onFileSelect,
  fileInputRef,
}: {
  file: File | null;
  isAnalyzing: boolean;
  onFileSelect: (f: File) => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
}) {
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && (f.name.endsWith('.xlsx') || f.name.endsWith('.xls') || f.name.endsWith('.csv'))) {
      onFileSelect(f);
    }
  };

  if (isAnalyzing) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600 mb-4" />
        <p className="text-sm font-medium text-gray-700">Dang phan tich cau truc file...</p>
        <p className="text-xs text-gray-400 mt-1">{file?.name}</p>
      </div>
    );
  }

  return (
    <div className="px-8 py-12">
      <div
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => fileInputRef.current?.click()}
        className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 py-16 cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors"
      >
        <Upload className="h-10 w-10 text-gray-400 mb-4" />
        <p className="text-sm font-semibold text-gray-700 mb-1">
          Keo tha file Excel vao day
        </p>
        <p className="text-xs text-gray-400">
          Hoac click de chon file (.xlsx, .csv)
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFileSelect(f);
          }}
        />
      </div>
      <p className="mt-4 text-center text-xs text-gray-400">
        He thong se tu dong nhan dang: tieu de, cot du lieu, nhom cot, ghi chu, o ky ten
      </p>
    </div>
  );
}

/* ── Step 2: Preview ── */

function Step2Preview({
  analysis,
  editedTitle,
  editedColumns,
  editedGroups,
  editedHeaderLines,
  onTitleChange,
  onColumnsChange,
  onSheetChange,
  isReanalyzing,
}: {
  analysis: AnalysisResponse;
  editedTitle: string;
  editedColumns: AnalysisColumn[];
  editedGroups: AnalysisColumnGroup[];
  editedHeaderLines: AnalysisHeaderLine[];
  onTitleChange: (t: string) => void;
  onColumnsChange: (cols: AnalysisColumn[]) => void;
  onSheetChange: (sheet: string) => void;
  isReanalyzing: boolean;
}) {
  const confidenceColor =
    analysis.confidence > 0.7 ? 'text-green-600 bg-green-50 border-green-200' :
    analysis.confidence > 0.4 ? 'text-amber-600 bg-amber-50 border-amber-200' :
    'text-red-600 bg-red-50 border-red-200';

  return (
    <div className="px-6 py-4 space-y-4">
      {/* Top: confidence + sheet selector */}
      <div className="flex items-center justify-between">
        <div className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${confidenceColor}`}>
          {analysis.confidence > 0.7 ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
          Do tin cay: {Math.round(analysis.confidence * 100)}%
        </div>
        {analysis.sheet_names.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Sheet:</span>
            <select
              value={analysis.analyzed_sheet}
              onChange={(e) => onSheetChange(e.target.value)}
              disabled={isReanalyzing}
              className="rounded-md border border-gray-300 px-2 py-1 text-xs"
            >
              {analysis.sheet_names.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            {isReanalyzing && <Loader2 className="h-3 w-3 animate-spin text-blue-600" />}
          </div>
        )}
      </div>

      {/* Header lines */}
      {(editedHeaderLines.length > 0 || editedTitle) && (
        <Section title="Tieu de bao cao">
          {editedHeaderLines.map((hl, i) => (
            <p key={i} className={`text-xs ${hl.bold ? 'font-bold' : ''} text-gray-700`}>
              {hl.text}
              {hl.right_text && <span className="float-right text-gray-500">{hl.right_text}</span>}
            </p>
          ))}
          <input
            className="mt-1 w-full rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm font-bold outline-none focus:ring-2 focus:ring-blue-400"
            value={editedTitle}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="Ten bao cao chinh"
          />
          {analysis.report_meta && (
            <p className="mt-0.5 text-[10px] text-gray-400 font-mono">{analysis.report_meta}</p>
          )}
        </Section>
      )}

      {/* Column groups */}
      {editedGroups.length > 0 && (
        <Section title={`Nhom cot (${editedGroups.length} nhom)`}>
          <div className="flex flex-wrap gap-1.5">
            {editedGroups.map((g, i) => (
              <span key={i} className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs text-blue-700">
                {g.label} ({g.span} cot)
              </span>
            ))}
          </div>
        </Section>
      )}

      {/* Columns table */}
      <Section title={`Cot du lieu (${editedColumns.length} cot)`}>
        <div className="max-h-52 overflow-auto rounded-md border border-gray-200">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium text-gray-500">#</th>
                <th className="px-2 py-1.5 text-left font-medium text-gray-500">Ten cot</th>
                <th className="px-2 py-1.5 text-left font-medium text-gray-500">Key</th>
                <th className="px-2 py-1.5 text-left font-medium text-gray-500">Dinh dang</th>
                <th className="px-2 py-1.5 text-left font-medium text-gray-500">Can le</th>
                <th className="px-2 py-1.5 text-left font-medium text-gray-500">Don vi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {editedColumns.map((col, i) => (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-2 py-1 text-gray-400">{i + 1}</td>
                  <td className="px-2 py-1 font-medium text-gray-900">{col.label}</td>
                  <td className="px-2 py-1 font-mono text-gray-500">{col.key}</td>
                  <td className="px-2 py-1">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      col.format === 'integer' ? 'bg-blue-50 text-blue-700' :
                      col.format === 'decimal' ? 'bg-indigo-50 text-indigo-700' :
                      col.format === 'percentage' ? 'bg-purple-50 text-purple-700' :
                      'bg-gray-50 text-gray-600'
                    }`}>
                      {col.format}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-gray-500">{col.align}</td>
                  <td className="px-2 py-1 text-gray-500 font-mono">{col.suffix || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Data preview */}
      {analysis.data_preview.length > 0 && (
        <Section title={`Du lieu mau (${analysis.total_data_rows} dong tong)`}>
          <div className="max-h-44 overflow-auto rounded-md border border-gray-200">
            <table className="w-full text-[10px]">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  {editedColumns.slice(0, 10).map((col) => (
                    <th key={col.key} className="px-2 py-1 text-left font-medium text-gray-500 whitespace-nowrap">
                      {col.label}
                    </th>
                  ))}
                  {editedColumns.length > 10 && (
                    <th className="px-2 py-1 text-gray-400">+{editedColumns.length - 10}</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {analysis.data_preview.slice(0, 5).map((row, ri) => (
                  <tr key={ri}>
                    {editedColumns.slice(0, 10).map((col) => (
                      <td key={col.key} className="px-2 py-1 whitespace-nowrap text-gray-700">
                        {row[col.key] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Footer + signatures */}
      {(analysis.footer_lines.length > 0 || analysis.signature_count > 0) && (
        <Section title="Footer">
          {analysis.footer_lines.map((line, i) => (
            <p key={i} className="text-xs text-gray-600">{line}</p>
          ))}
          {analysis.signature_count > 0 && (
            <div className="mt-1 flex gap-2">
              {analysis.signature_labels.map((label, i) => (
                <div key={i} className="flex-1 rounded border border-gray-200 p-2 text-center">
                  <div className="h-8 border-b border-dashed border-gray-300 mb-1" />
                  <span className="text-[10px] text-gray-500">{label}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* Grouping */}
      {analysis.group_by_column && (
        <Section title="Nhom du lieu">
          <p className="text-xs text-gray-600">
            Nhom theo: <span className="font-mono font-medium text-blue-600">{analysis.group_by_column}</span>
            {analysis.show_subtotals && ' (co dong tong phu)'}
          </p>
        </Section>
      )}

      {/* Recommended schema */}
      <Section title="Schema goi y cho dataset">
        <p className="text-[10px] text-gray-400 mb-1.5">
          Khi ket noi du lieu dong, dataset can co cac cot sau:
        </p>
        <div className="flex flex-wrap gap-1">
          {analysis.recommended_table_schema.map((col) => (
            <span
              key={col.name}
              className={`rounded border px-2 py-0.5 text-[10px] font-mono ${
                col.type === 'number'
                  ? 'border-blue-200 bg-blue-50 text-blue-700'
                  : 'border-gray-200 bg-gray-50 text-gray-600'
              }`}
            >
              {col.name}
              <span className="ml-1 text-[8px] opacity-60">{col.type}</span>
            </span>
          ))}
        </div>
      </Section>
    </div>
  );
}

/* ── Step 3: Confirm ── */

function Step3Confirm({
  analysis,
  templateName,
  includeData,
  editedColumns,
  onTemplateNameChange,
  onIncludeDataChange,
}: {
  analysis: AnalysisResponse;
  templateName: string;
  includeData: boolean;
  editedColumns: AnalysisColumn[];
  onTemplateNameChange: (n: string) => void;
  onIncludeDataChange: (v: boolean) => void;
}) {
  return (
    <div className="px-8 py-6 space-y-5">
      <div>
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
          Ten template
        </label>
        <input
          className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500"
          value={templateName}
          onChange={(e) => onTemplateNameChange(e.target.value)}
          placeholder="Nhap ten template..."
        />
      </div>

      <div>
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
          Xu ly du lieu
        </label>
        <div className="space-y-2">
          <label
            className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
              includeData ? 'border-blue-300 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'
            }`}
          >
            <input
              type="radio"
              checked={includeData}
              onChange={() => onIncludeDataChange(true)}
              className="mt-0.5 h-4 w-4 text-blue-600"
            />
            <div>
              <p className="text-sm font-medium text-gray-900">Dung du lieu tu file nay</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Tu dong tao datasource va dataset voi {analysis.total_data_rows} dong du lieu.
                Template se hien thi du lieu ngay lap tuc.
              </p>
            </div>
          </label>
          <label
            className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
              !includeData ? 'border-blue-300 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'
            }`}
          >
            <input
              type="radio"
              checked={!includeData}
              onChange={() => onIncludeDataChange(false)}
              className="mt-0.5 h-4 w-4 text-blue-600"
            />
            <div>
              <p className="text-sm font-medium text-gray-900">Ket noi du lieu sau</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Chi tao template (format). Ban se ket noi datasource
                (PostgreSQL, Google Sheets...) sau trong builder.
              </p>
            </div>
          </label>
        </div>
      </div>

      {/* Summary */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Tom tat</p>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="text-gray-500">Cot du lieu:</div>
          <div className="font-medium text-gray-900">{editedColumns.length} cot</div>
          <div className="text-gray-500">Nhom cot:</div>
          <div className="font-medium text-gray-900">{analysis.column_groups.length || 'Khong co'}</div>
          <div className="text-gray-500">Nhom theo:</div>
          <div className="font-medium text-gray-900">{analysis.group_by_column || 'Khong co'}</div>
          <div className="text-gray-500">O ky ten:</div>
          <div className="font-medium text-gray-900">{analysis.signature_count || 'Khong co'}</div>
          {includeData && (
            <>
              <div className="text-gray-500">Du lieu:</div>
              <div className="font-medium text-green-700">{analysis.total_data_rows} dong</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Reusable ── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1.5">
        {title}
      </p>
      {children}
    </div>
  );
}
