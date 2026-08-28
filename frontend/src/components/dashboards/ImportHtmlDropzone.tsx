'use client';

import React, { useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, FileCode2, Sparkles, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { useI18n } from '@/providers/LanguageProvider';

/**
 * Bringing the HTML in.
 *
 * This used to be a 280px empty code box as the first thing in the dialog, with
 * the file button underneath it as a secondary action. Nobody hand-writes a
 * dashboard's HTML into a modal — they bring a file — so the arrangement had
 * the rare path taking all the space and the normal one hiding below it.
 *
 * It also said nothing about the file it was given. Whether a document carries
 * its own plan is the single most important thing about an import — declared
 * plans are exact and need no model — and that was invisible until after
 * Analyze had already run. Now it is read the moment the file lands.
 */

const APPBI_PLAN_RE =
  /<script[^>]+type\s*=\s*["']application\/appbi-dashboard["'][^>]*>([\s\S]*?)<\/script>/i;

export type PlanSummary = {
  declared: boolean;
  version?: string;
  datasetName?: string;
  datasetId?: number;
  chartCount?: number;
  widgetCount?: number;
  templateFamily?: string;
};

/** What the file says about itself, read before anything is sent anywhere. */
export function readPlanSummary(html: string): PlanSummary {
  const match = APPBI_PLAN_RE.exec(String(html ?? ''));
  if (!match) return { declared: false };
  try {
    const plan = JSON.parse(match[1]);
    const contract = plan?.source_contract ?? {};
    const dashboard = plan?.dashboard ?? {};
    return {
      declared: true,
      version: typeof plan?.version === 'string' ? plan.version : undefined,
      datasetName: typeof contract.dataset_name === 'string' ? contract.dataset_name : undefined,
      datasetId: typeof contract.dataset_id === 'number' ? contract.dataset_id : undefined,
      chartCount: Array.isArray(plan?.charts) ? plan.charts.length : undefined,
      widgetCount: Array.isArray(plan?.widgets) ? plan.widgets.length : undefined,
      templateFamily: typeof dashboard.template_family === 'string' ? dashboard.template_family : undefined,
    };
  } catch {
    // A malformed plan is worth knowing about, but it is not a declared plan.
    return { declared: false };
  }
}

function formatSize(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${Math.round(chars / 1024)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImportHtmlDropzone({
  htmlInput,
  onHtmlChange,
  htmlFilename,
  onFiles,
  batchDocuments,
  onRemoveDocument,
  onClearBatch,
  selectedDatasetName,
}: {
  htmlInput: string;
  onHtmlChange: (value: string) => void;
  htmlFilename: string;
  onFiles: (files: File[]) => void;
  batchDocuments: Array<{ documentId: string; filename: string | null; pageName: string }>;
  onRemoveDocument: (documentId: string) => void;
  onClearBatch: () => void;
  selectedDatasetName?: string | null;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);

  const isBatch = batchDocuments.length > 0;
  const plan = useMemo(() => readPlanSummary(htmlInput), [htmlInput]);
  const hasHtml = htmlInput.trim().length > 0;

  // The mismatch worth catching before anything is sent: a file written for one
  // dataset, about to be imported against another.
  const datasetMismatch = Boolean(
    plan.declared && plan.datasetName && selectedDatasetName
    && plan.datasetName.trim().toLowerCase() !== selectedDatasetName.trim().toLowerCase(),
  );

  const accept = (files: File[]) => {
    const htmlFiles = files.filter((file) => /\.html?$/i.test(file.name) || file.type === 'text/html');
    if (htmlFiles.length) onFiles(htmlFiles);
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept=".html,.htm,text/html"
        multiple
        className="hidden"
        onChange={(event) => {
          accept(Array.from(event.target.files ?? []));
          event.currentTarget.value = '';
        }}
      />

      {isBatch ? (
        <div className="space-y-2 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-3">
          {batchDocuments.map((document) => (
            <div
              key={document.documentId}
              className="flex items-center gap-2.5 rounded-lg border border-brand/20 bg-brand/5 px-3 py-2"
            >
              <FileCode2 className="h-4 w-4 shrink-0 text-brand" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-caption font-medium text-text-primary">{document.filename}</p>
                <p className="truncate text-caption text-text-tertiary">{document.pageName}</p>
              </div>
              <button
                type="button"
                aria-label={t('dashboards.htmlImport.dropzoneRemove')}
                onClick={() => onRemoveDocument(document.documentId)}
                className="rounded p-1 text-text-tertiary hover:bg-brand/10 hover:text-brand"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-1">
            <Button variant="secondary" size="xs" onClick={() => inputRef.current?.click()}>
              {t('dashboards.htmlImport.dropzoneAddMore')}
            </Button>
            <Button variant="ghost" size="xs" onClick={onClearBatch}>
              {t('dashboards.htmlImport.clearHtmlBatch')}
            </Button>
          </div>
        </div>
      ) : hasHtml ? (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10">
              <FileCode2 className="h-4.5 w-4.5 text-brand" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text-primary">
                {htmlFilename || t('dashboards.htmlImport.dropzonePasted')}
              </p>
              <p className="mt-0.5 text-caption text-text-tertiary">{formatSize(htmlInput.length)}</p>

              {plan.declared ? (
                <div className="mt-2.5 rounded-lg border border-[rgb(16_185_129_/_0.28)] bg-[rgb(16_185_129_/_0.08)] px-3 py-2">
                  <p className="flex items-center gap-1.5 text-caption font-semibold text-[rgb(4_120_87)]">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {t('dashboards.htmlImport.dropzonePlanFound')}
                  </p>
                  <p className="mt-1 text-caption leading-relaxed text-text-secondary">
                    {t('dashboards.htmlImport.dropzonePlanDetail', {
                      charts: plan.chartCount ?? 0,
                      widgets: plan.widgetCount ?? 0,
                      template: plan.templateFamily ?? '—',
                    })}
                    {plan.datasetName ? ` · ${plan.datasetName}` : ''}
                  </p>
                </div>
              ) : (
                <div className="mt-2.5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                  <p className="flex items-center gap-1.5 text-caption font-semibold text-text-secondary">
                    <Sparkles className="h-3.5 w-3.5" />
                    {t('dashboards.htmlImport.dropzoneNoPlan')}
                  </p>
                  <p className="mt-1 text-caption leading-relaxed text-text-tertiary">
                    {t('dashboards.htmlImport.dropzoneNoPlanDetail')}
                  </p>
                </div>
              )}

              {datasetMismatch && (
                <p className="mt-2 rounded-lg bg-[rgb(245_158_11_/_0.12)] px-3 py-2 text-caption text-[rgb(146_64_14)]">
                  {t('dashboards.htmlImport.dropzoneDatasetMismatch', {
                    declared: plan.datasetName ?? '',
                    selected: selectedDatasetName ?? '',
                  })}
                </p>
              )}
            </div>
            <button
              type="button"
              aria-label={t('dashboards.htmlImport.dropzoneRemove')}
              onClick={() => onHtmlChange('')}
              className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : (
        <div
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            accept(Array.from(event.dataTransfer.files ?? []));
          }}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
            dragging
              ? 'border-brand bg-brand/5'
              : 'border-[rgb(var(--border-strong))] bg-surface-1 hover:border-brand/50 hover:bg-brand/[0.03]'
          }`}
        >
          <Upload className="h-6 w-6 text-text-tertiary" />
          <p className="mt-3 text-sm font-medium text-text-primary">
            {t('dashboards.htmlImport.dropzoneTitle')}
          </p>
          <p className="mt-1 max-w-md text-caption leading-relaxed text-text-tertiary">
            {t('dashboards.htmlImport.dropzoneHint')}
          </p>
        </div>
      )}

      {!isBatch && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setPasteOpen((open) => !open)}
            className="flex items-center gap-1 text-caption text-text-tertiary hover:text-text-secondary"
          >
            <ChevronDown className={`h-3 w-3 transition-transform ${pasteOpen ? 'rotate-180' : ''}`} />
            {t('dashboards.htmlImport.dropzonePasteToggle')}
          </button>
          {pasteOpen && (
            <Textarea
              value={htmlInput}
              onChange={(event) => onHtmlChange(event.target.value)}
              rows={8}
              className="mt-2 font-mono text-xs"
              placeholder="<html>…</html>"
            />
          )}
        </div>
      )}
    </div>
  );
}
