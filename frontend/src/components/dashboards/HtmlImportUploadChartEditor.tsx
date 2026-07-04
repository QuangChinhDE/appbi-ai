/**
 * HtmlImportUploadChartEditor — lightweight editor used when the HTML import
 * source is an uploaded Excel/CSV (the dataset has NOT been materialised yet,
 * so the full ExploreEditor cannot be used). The editor operates on the
 * sample rows already returned by the analyze step and previews charts
 * client-side via buildExploreChartModel.
 *
 * Custom SQL is intentionally not offered here — it requires a live data
 * source. The user can switch to custom SQL after the dashboard is built
 * (the chart will behave like any other chart).
 */
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Info } from 'lucide-react';

import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ExploreChart } from '@/components/explore/ExploreChart';
import {
  DEFAULT_STYLE_CONFIG,
  ExploreChartConfig,
  getChartRoleConfigRequirementMessage,
  normalizeChartStyleConfig,
  normalizeRoleConfig,
  type ChartRoleConfig,
  type ChartStyleConfig,
  type ExploreChartType,
} from '@/components/explore/ExploreChartConfig';
import { usePreviewDashboardHtmlImportCalculatedFields } from '@/hooks/use-dashboards';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import type {
  DashboardHtmlImportCalculatedField,
  DashboardHtmlImportChartPlan,
  DashboardHtmlImportSourceProfile,
} from '@/types/dashboard-html-import';
import type { HtmlImportChartEditResult } from '@/components/dashboards/HtmlImportChartEditor';

interface HtmlImportUploadChartEditorProps {
  isOpen: boolean;
  plan: DashboardHtmlImportChartPlan | null;
  /** Active source profile (single upload / selected sheet / selected source_key). */
  sourceProfile: DashboardHtmlImportSourceProfile | null;
  /** When the import spans multiple sheets/files, this maps source_key → profile. */
  allSourceProfiles?: Record<string, DashboardHtmlImportSourceProfile> | null;
  /** Wizard-level calc fields. Shared so this editor can reference / add them. */
  calculatedFields?: DashboardHtmlImportCalculatedField[];
  onCalculatedFieldsChange?: (fields: DashboardHtmlImportCalculatedField[]) => void;
  onClose: () => void;
  onSave: (edit: HtmlImportChartEditResult) => void | Promise<void>;
}

function profileForPlan(
  plan: DashboardHtmlImportChartPlan | null,
  sourceProfile: DashboardHtmlImportSourceProfile | null,
  allSourceProfiles?: Record<string, DashboardHtmlImportSourceProfile> | null,
): DashboardHtmlImportSourceProfile | null {
  if (!plan) return sourceProfile;
  const key = plan.source_key ? String(plan.source_key) : '';
  if (key && allSourceProfiles && allSourceProfiles[key]) {
    return allSourceProfiles[key];
  }
  return sourceProfile;
}

export function HtmlImportUploadChartEditor({
  isOpen,
  plan,
  sourceProfile,
  allSourceProfiles,
  calculatedFields,
  onCalculatedFieldsChange,
  onClose,
  onSave,
}: HtmlImportUploadChartEditorProps) {
  const { t } = useI18n();
  const activeProfile = useMemo(
    () => profileForPlan(plan, sourceProfile, allSourceProfiles),
    [plan, sourceProfile, allSourceProfiles],
  );

  const [chartType, setChartType] = useState<ExploreChartType>(
    ((plan?.final_chart_type || 'TABLE').toUpperCase() as ExploreChartType),
  );
  const [roleConfig, setRoleConfig] = useState<ChartRoleConfig>(() => (
    normalizeRoleConfig(
      (plan?.final_chart_type || 'TABLE').toUpperCase(),
      (plan?.role_config as ChartRoleConfig) ?? { metrics: [] },
    )
  ));
  const [styleConfig, setStyleConfig] = useState<ChartStyleConfig>(() => (
    normalizeChartStyleConfig(
      (plan?.style_config as ChartStyleConfig) ?? DEFAULT_STYLE_CONFIG,
      undefined,
    )
  ));
  const [chartName, setChartName] = useState<string>(plan?.chart_name ?? plan?.title ?? '');
  const [chartDescription, setChartDescription] = useState<string>(
    plan?.chart_description ?? plan?.rationale ?? '',
  );
  const [sourceKey, setSourceKey] = useState<string>(plan?.source_key ?? '');

  // Reset state whenever the opened plan changes (drawer reuse).
  React.useEffect(() => {
    if (!plan) return;
    const nextType = (plan.final_chart_type || 'TABLE').toUpperCase() as ExploreChartType;
    setChartType(nextType);
    setRoleConfig(normalizeRoleConfig(nextType, (plan.role_config as ChartRoleConfig) ?? { metrics: [] }));
    setStyleConfig(normalizeChartStyleConfig(
      (plan.style_config as ChartStyleConfig) ?? DEFAULT_STYLE_CONFIG,
      undefined,
    ));
    setChartName(plan.chart_name ?? plan.title ?? '');
    setChartDescription(plan.chart_description ?? plan.rationale ?? '');
    setSourceKey(plan.source_key ?? '');
  }, [plan]);

  const baseColumns = useMemo(() => {
    if (!activeProfile) return [] as Array<{ name: string; type: string }>;
    return (activeProfile.columns || []).map((c) => ({ name: c.name, type: c.type }));
  }, [activeProfile]);

  const baseSampleRows = useMemo(() => activeProfile?.sample_rows ?? [], [activeProfile]);

  // Only the calc fields that apply to this source (either unscoped or matching
  // the active source_key). Prevents backend errors about missing columns when
  // a calc field is scoped to a different sheet/table.
  const applicableCalcFields = useMemo<DashboardHtmlImportCalculatedField[]>(() => {
    if (!calculatedFields || calculatedFields.length === 0) return [];
    const effectiveKey = (sourceKey || plan?.source_key || '').trim();
    const colSet = new Set(baseColumns.map((c) => c.name));
    return calculatedFields.filter((field) => {
      if (field.source_key && effectiveKey && field.source_key !== effectiveKey) return false;
      // Drop fields that reference columns not present in this sheet.
      const exprIdents = (field.expression || '').match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
      for (const ident of exprIdents) {
        if (colSet.has(ident)) continue;
        // Allow references to earlier calc fields via their name.
        if (calculatedFields.some((f) => f.name === ident)) continue;
      }
      return true;
    });
  }, [calculatedFields, sourceKey, plan, baseColumns]);

  // Run the server-side preview whenever sample rows or calc expressions
  // change. The enriched sample powers both the live chart preview and the
  // role-config column picker so new calc fields are selectable.
  const previewMutation = usePreviewDashboardHtmlImportCalculatedFields();
  const [enrichedColumns, setEnrichedColumns] = useState<Array<{ name: string; type: string }>>([]);
  const [enrichedRows, setEnrichedRows] = useState<Array<Record<string, unknown>>>([]);
  const [calcFieldErrors, setCalcFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!activeProfile) {
        setEnrichedColumns([]);
        setEnrichedRows([]);
        setCalcFieldErrors({});
        return;
      }
      if (applicableCalcFields.length === 0) {
        setEnrichedColumns(baseColumns);
        setEnrichedRows(baseSampleRows);
        setCalcFieldErrors({});
        return;
      }
      try {
        const result = await previewMutation.mutateAsync({
          sampleRows: baseSampleRows,
          columns: baseColumns,
          calculatedFields: applicableCalcFields,
        });
        if (cancelled) return;
        setEnrichedColumns(result.columns || baseColumns);
        setEnrichedRows(result.rows || baseSampleRows);
        const errMap: Record<string, string> = {};
        for (const e of result.errors || []) {
          if (e?.name) errMap[e.name] = e.error || t('dashboards.htmlImport.invalidExpression');
        }
        setCalcFieldErrors(errMap);
      } catch (error: any) {
        if (cancelled) return;
        // If the entire preview fails, fall back to the base rows but show
        // the failure so the user can fix their expression.
        setEnrichedColumns(baseColumns);
        setEnrichedRows(baseSampleRows);
        const detail =
          error?.response?.data?.detail || error?.message || t('dashboards.htmlImport.previewCalculatedFieldsError');
        toast.error(String(detail));
      }
    }
    run();
    return () => {
      cancelled = true;
    };
    // previewMutation is intentionally excluded because react-query mutations
    // are stable — relying on it would cause effect loops after each run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile, baseColumns, baseSampleRows, applicableCalcFields, t]);

  const availableColumns = enrichedColumns.length > 0 ? enrichedColumns : baseColumns;
  const sampleRows = enrichedRows.length > 0 || applicableCalcFields.length === 0
    ? enrichedRows.length > 0 ? enrichedRows : baseSampleRows
    : baseSampleRows;

  const requirementMessage = useMemo(
    () => getChartRoleConfigRequirementMessage(chartType, roleConfig),
    [chartType, roleConfig],
  );

  const sourceKeyOptions = useMemo(() => {
    if (!allSourceProfiles) return [] as string[];
    return Object.keys(allSourceProfiles);
  }, [allSourceProfiles]);

  const handleApply = async () => {
    if (!plan) return;
    if (!chartName.trim()) {
      return;
    }
    await onSave({
      block_id: plan.block_id,
      final_chart_type: String(chartType),
      role_config: roleConfig as Record<string, any>,
      custom_role_config: (plan.custom_role_config as Record<string, any>) ?? {},
      query_mode: 'generated',
      custom_sql: null,
      base_filters: (plan.base_filters as Array<Record<string, any>>) ?? [],
      style_config: styleConfig as Record<string, any>,
      chart_name: chartName.trim(),
      chart_description: chartDescription.trim() || null,
      source_key: sourceKey || plan.source_key || null,
      // No override — the dataset does not exist yet.
      dataset_table_id_override: null,
    });
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={plan ? t('dashboards.htmlImport.editChartTitle', { title: plan.title }) : t('dashboards.htmlImport.editChart')}
      size="full"
      bodyClassName="overflow-hidden p-0"
      contentClassName="max-w-[92rem]"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('dashboards.htmlImport.cancel')}</Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleApply}
            disabled={!plan || !chartName.trim() || Boolean(requirementMessage)}
          >
            {t('dashboards.htmlImport.applyChanges')}
          </Button>
        </>
      }
    >
      <div className="grid h-full min-h-0 grid-cols-[380px_1fr] divide-x divide-[rgb(var(--border-line))] overflow-hidden">
        <div className="min-h-0 overflow-y-auto bg-surface-2 p-4">
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-brand/30 bg-brand/5 p-3 text-xs text-text-secondary">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
            <div>
              <p className="font-medium text-text-primary">{t('dashboards.htmlImport.quickPreviewTitle')}</p>
              <p className="mt-0.5 text-caption text-text-tertiary">
                {t('dashboards.htmlImport.quickPreviewDescription', { count: sampleRows.length })}
              </p>
            </div>
          </div>

          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">
            {t('dashboards.htmlImport.chartName')}
          </label>
          <Input
            size="sm"
            value={chartName}
            onChange={(event) => setChartName(event.target.value)}
            placeholder={t('dashboards.htmlImport.chartName')}
          />
          <label className="mb-1 mt-3 block text-[11px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">
            {t('dashboards.htmlImport.description')} <span className="font-normal normal-case text-text-quaternary">{t('dashboards.htmlImport.optionalSuffix')}</span>
          </label>
          <Input
            size="sm"
            value={chartDescription}
            onChange={(event) => setChartDescription(event.target.value)}
            placeholder={t('dashboards.htmlImport.chartDescriptionPlaceholder')}
          />

          {sourceKeyOptions.length > 1 && (
            <>
              <label className="mb-1 mt-3 block text-[11px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">
                {t('dashboards.htmlImport.sourceSheetFile')}
              </label>
              <select
                value={sourceKey}
                onChange={(event) => setSourceKey(event.target.value)}
                className="w-full rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-sm text-text-secondary"
              >
                <option value="">{t('dashboards.htmlImport.defaultOption')}</option>
                {sourceKeyOptions.map((key) => (
                  <option key={key} value={key}>{key}</option>
                ))}
              </select>
            </>
          )}

          <div className="mt-4">
            <ExploreChartConfig
              chartType={chartType}
              roleConfig={roleConfig}
              styleConfig={styleConfig}
              availableColumns={availableColumns}
              onChartTypeChange={(t) => {
                setChartType(t);
                setRoleConfig((prev) => normalizeRoleConfig(t, prev));
              }}
              onRoleConfigChange={(next) => setRoleConfig(next)}
              onStyleConfigChange={(next) => setStyleConfig(next)}
            />
          </div>
        </div>

        <div className="min-h-0 overflow-hidden bg-surface-1 p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">{t('dashboards.htmlImport.livePreview')}</p>
            <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-[11px] text-text-tertiary">
              {t('dashboards.htmlImport.sampleRowsCount', { count: sampleRows.length })}
            </span>
          </div>
          {!activeProfile ? (
            <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
              {t('dashboards.htmlImport.noSourcePreviewData')}
            </div>
          ) : requirementMessage ? (
            <div className="flex h-full items-center justify-center">
              <div className="max-w-sm text-center text-text-tertiary">
                <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-warning" />
                <p className="text-sm font-medium text-text-secondary">{t('dashboards.htmlImport.chartSetupIncomplete')}</p>
                <p className="mt-1 text-caption">{requirementMessage}</p>
              </div>
            </div>
          ) : sampleRows.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
              {t('dashboards.htmlImport.noSampleRowsPreview')}
            </div>
          ) : (
            <div className="h-full min-h-0">
              <ExploreChart
                type={String(chartType)}
                data={sampleRows}
                roleConfig={roleConfig}
                styleConfig={styleConfig}
                preAggregated={false}
              />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
