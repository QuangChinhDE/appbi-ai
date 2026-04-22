/**
 * HtmlImportChartEditor — drawer that reuses ExploreEditor in ephemeral mode
 * so a user can hand-edit a single HTML-import chart plan without persisting
 * anything to the database. The edited snapshot is folded back into the
 * wizard's `analysis.chart_plans` via `onSave`.
 *
 * Only supported for `existing_dataset` imports. For `upload_excel` the
 * dataset does not yet exist; use HtmlImportUploadChartEditor instead.
 */
'use client';

import React, { useMemo } from 'react';

import { Modal } from '@/components/common/Modal';
import {
  type ExploreEditorEphemeralResult,
  type ExploreEditorEphemeralSeed,
} from '@/components/explore/ExploreEditor';
import { ChartEditorWithTabs } from '@/components/explore/ChartEditorWithTabs';
import { useDatasetTables } from '@/hooks/use-datasets';
import type {
  DashboardHtmlImportCalculatedField,
  DashboardHtmlImportChartPlan,
} from '@/types/dashboard-html-import';
import type { ChartRoleConfig, ChartStyleConfig, ExploreChartType } from '@/components/explore/ExploreChartConfig';

export interface HtmlImportChartEditResult {
  block_id: string;
  final_chart_type: string;
  role_config: Record<string, any>;
  custom_role_config: Record<string, any>;
  query_mode: 'generated' | 'custom';
  custom_sql: string | null;
  base_filters: Array<Record<string, any>>;
  style_config: Record<string, any>;
  chart_name: string;
  chart_description: string | null;
  source_key: string | null;
  dataset_table_id_override: number | null;
}

interface HtmlImportChartEditorProps {
  isOpen: boolean;
  plan: DashboardHtmlImportChartPlan | null;
  datasetId: number | null;
  /** Maps dataset_table display_name → dataset_table_id for this dataset. */
  tableIdByDisplayName: Record<string, number>;
  /** Maps import source_key -> dataset_table_id for draft datasets. */
  tableIdBySourceKey?: Record<string, number>;
  /** Reverse map for preserving source_key when the user switches tables. */
  sourceKeyByTableId?: Record<number, string>;
  /** Legacy props kept for backward compatibility with the parent wizard. */
  calculatedFields?: DashboardHtmlImportCalculatedField[];
  onCalculatedFieldsChange?: (fields: DashboardHtmlImportCalculatedField[]) => void;
  onClose: () => void;
  onSave: (edit: HtmlImportChartEditResult) => void | Promise<void>;
}

export function HtmlImportChartEditor({
  isOpen,
  plan,
  datasetId,
  tableIdByDisplayName,
  tableIdBySourceKey,
  sourceKeyByTableId,
  onClose,
  onSave,
}: HtmlImportChartEditorProps) {
  const { data: datasetTables = [] } = useDatasetTables(datasetId);

  // Resolve the initial table from the plan's source_key (preferring the
  // override if the user already edited once this session).
  const initialTableId = useMemo<number | null>(() => {
    if (!plan) return null;
    if (typeof plan.dataset_table_id_override === 'number' && plan.dataset_table_id_override > 0) {
      return plan.dataset_table_id_override;
    }
    const sourceKey = plan.source_key ? String(plan.source_key).trim() : '';
    if (sourceKey && tableIdBySourceKey?.[sourceKey]) {
      return tableIdBySourceKey[sourceKey];
    }
    const displayName = sourceKey;
    if (displayName && tableIdByDisplayName[displayName]) {
      return tableIdByDisplayName[displayName];
    }
    // Fall back to the first non-calendar table in the dataset.
    const firstUsable = datasetTables.find((t) => t.source_kind !== 'generated_calendar');
    return firstUsable?.id ?? datasetTables[0]?.id ?? null;
  }, [plan, tableIdByDisplayName, tableIdBySourceKey, datasetTables]);

  const seed = useMemo<ExploreEditorEphemeralSeed | undefined>(() => {
    if (!plan) return undefined;
    const rawChartType = String(plan.final_chart_type || 'TABLE').toUpperCase() as ExploreChartType;
    const queryMode = plan.query_mode === 'custom' && plan.custom_sql ? 'custom' : 'generated';
    const baseFilters = Array.isArray(plan.base_filters)
      ? (plan.base_filters as any[]).filter((item) => item && typeof item === 'object')
      : [];
    return {
      chartType: rawChartType,
      chartName: plan.chart_name ?? plan.title ?? null,
      chartDescription: plan.chart_description ?? plan.rationale ?? null,
      queryMode,
      generatedRoleConfig: (plan.role_config as ChartRoleConfig) ?? null,
      customRoleConfig: (plan.custom_role_config as ChartRoleConfig) ?? null,
      customSql: plan.custom_sql ?? null,
      styleConfig: (plan.style_config as ChartStyleConfig) ?? null,
      baseFilters: baseFilters as any,
    };
  }, [plan]);

  const handleEphemeralSave = async (result: ExploreEditorEphemeralResult) => {
    if (!plan) return;

    // Convert the chosen dataset_table_id back to source_key (display_name) so
    // the backend multi-table resolver keeps working, and record the absolute
    // id as an override for robustness if display_name changes later.
    let nextSourceKey: string | null = plan.source_key ?? null;
    let tableOverride: number | null = null;
    if (result.datasetTableId != null) {
      const matched = datasetTables.find((t) => t.id === result.datasetTableId);
      if (matched) {
        nextSourceKey = sourceKeyByTableId?.[matched.id] ?? matched.display_name;
        tableOverride = matched.id;
      } else {
        tableOverride = result.datasetTableId;
      }
    }

    await onSave({
      block_id: plan.block_id,
      final_chart_type: String(result.chartType),
      role_config: result.generatedRoleConfig as Record<string, any>,
      custom_role_config: result.customRoleConfig as Record<string, any>,
      query_mode: result.queryMode,
      custom_sql: result.queryMode === 'custom' ? result.customSql : null,
      base_filters: (result.baseFilters as unknown as Array<Record<string, any>>) ?? [],
      style_config: result.styleConfig as Record<string, any>,
      chart_name: result.chartName,
      chart_description: result.chartDescription,
      source_key: nextSourceKey,
      dataset_table_id_override: tableOverride,
    });
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={plan ? `Edit chart — ${plan.title}` : 'Edit chart'}
      size="full"
      bodyClassName="overflow-hidden p-0"
      contentClassName="max-w-[96rem]"
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden">
          {plan && datasetId ? (
            <ChartEditorWithTabs
              embedded
              embeddedVariant="dashboard-modal"
              mode="ephemeral"
              chartId={null}
              initialDatasetId={datasetId}
              initialTableId={initialTableId}
              initialSeed={seed}
              lockDatasetSelection
              onBack={onClose}
              onEphemeralSave={handleEphemeralSave}
              backLabel="Back to review"
              saveButtonLabel="Apply Changes"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
              Editor requires an existing dataset context.
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
