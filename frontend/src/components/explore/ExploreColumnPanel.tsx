/**
 * ExploreColumnPanel — Flat searchable list of every dimension and measure
 * defined in the dataset's semantic model. Modeled after Power BI's Fields
 * pane: one searchable list with a "by view" filter chip, no forced grouping.
 *
 * Cross-table flow (Phase-11): when a field's owning view is NOT reachable
 * from the chart's base view via existing JOIN graph, the row stays clickable
 * but renders a "Need join" badge. Clicking the badge calls
 * `onRequestRelationship` with the source/target view names so the parent can
 * open the RelationshipDialog pre-filled.
 */
'use client';

import React, { useMemo, useState } from 'react';
import {
  Hash,
  Type,
  Calendar,
  ToggleLeft,
  Sigma,
  Search,
  AlertTriangle,
  Info,
} from 'lucide-react';
import {
  useDatasetModel,
  type DimensionDefinition,
  type MeasureDefinition,
  type DatasetModelView,
} from '@/hooks/use-dataset-model';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/providers/LanguageProvider';

type Translate = (key: string, values?: Record<string, string | number>) => string;

function DimensionIcon({ type }: { type: string }) {
  switch (type) {
    case 'number':
      return <Hash className="h-3 w-3 shrink-0 text-brand" />;
    case 'date':
    case 'datetime':
      return <Calendar className="h-3 w-3 shrink-0 text-success" />;
    case 'yesno':
      return <ToggleLeft className="h-3 w-3 shrink-0 text-brand" />;
    default:
      return <Type className="h-3 w-3 shrink-0 text-text-tertiary" />;
  }
}

type FieldKind = 'dimension' | 'measure';

interface FlatField {
  kind: FieldKind;
  view: DatasetModelView;
  dimension?: DimensionDefinition;
  measure?: MeasureDefinition;
  label: string;
  searchHaystack: string;
}

interface ExploreColumnPanelProps {
  datasetId: number | null;
  /**
   * Names of views reachable from the chart's base view via the join graph.
   * Fields from views NOT in this set get a "need join" badge. When undefined
   * all views are treated as reachable.
   */
  reachableViewNames?: Set<string>;
  /**
   * Name of the chart's base view — used as the "from" side when the user
   * asks to add a relationship. When null, the badge button is hidden because
   * we don't know what to join against.
   */
  baseViewName?: string | null;
  onSelectDimension?: (dim: DimensionDefinition, viewName: string) => void;
  onSelectMeasure?: (measure: MeasureDefinition, viewName: string) => void;
  /**
   * Fired when the user clicks the "Need join" badge on an unreachable field.
   * Parent should open RelationshipDialog pre-filled with these view names.
   */
  onRequestRelationship?: (params: { fromViewName: string; toViewName: string }) => void;
}

function measureTitle(measure: MeasureDefinition, t: Translate) {
  const source = measure.expression || measure.sql || measure.name;
  const parts = [`${measure.type.toUpperCase()}(${source})`];
  if (measure.filters?.length) parts.push(t('explore.columnPanel.measureFilters', { count: measure.filters.length }));
  if (measure.depends_on?.length) parts.push(t('explore.columnPanel.dependsOn', { fields: measure.depends_on.join(', ') }));
  return parts.join(' | ');
}

function viewLabel(view: DatasetModelView) {
  return view.table_display_name || view.name;
}

export function ExploreColumnPanel({
  datasetId,
  reachableViewNames,
  baseViewName,
  onSelectDimension,
  onSelectMeasure,
  onRequestRelationship,
}: ExploreColumnPanelProps) {
  const { t } = useI18n();
  const { data: model, isLoading } = useDatasetModel(datasetId);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewFilter, setViewFilter] = useState<string>('__all__');

  const views = useMemo<DatasetModelView[]>(() => {
    if (!model?.views) return [];
    return model.views.filter(
      (v) =>
        !v.hidden_in_canvas &&
        (!v.dimensions.every((d) => d.hidden) || !v.measures.every((m) => m.hidden)),
    );
  }, [model?.views]);

  // Phase-13: empty-state — dataset has multiple views but no joins between
  // them. Surface a banner so users understand multi-table charts need a relationship.
  const hasMultipleViewsWithoutJoins = useMemo(() => {
    if (!model || views.length < 2) return false;
    const totalJoins = (model.explores ?? []).reduce(
      (sum, e) => sum + ((e.joins ?? []).filter((j) => j.is_active !== false).length),
      0,
    );
    return totalJoins === 0;
  }, [model, views.length]);

  const allFields = useMemo<FlatField[]>(() => {
    const out: FlatField[] = [];
    for (const view of views) {
      for (const dim of view.dimensions) {
        if (dim.hidden) continue;
        const label = dim.label || dim.name;
        out.push({
          kind: 'dimension',
          view,
          dimension: dim,
          label,
          searchHaystack: `${label} ${dim.name} ${viewLabel(view)}`.toLowerCase(),
        });
      }
      for (const measure of view.measures) {
        if (measure.hidden) continue;
        const label = measure.label || measure.name;
        out.push({
          kind: 'measure',
          view,
          measure,
          label,
          searchHaystack: `${label} ${measure.name} ${viewLabel(view)} ${measure.folder ?? ''}`.toLowerCase(),
        });
      }
    }
    return out;
  }, [views]);

  const filteredFields = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allFields.filter((field) => {
      if (viewFilter !== '__all__' && field.view.name !== viewFilter) return false;
      if (q && !field.searchHaystack.includes(q)) return false;
      return true;
    });
  }, [allFields, searchQuery, viewFilter]);

  const dimensionFields = useMemo(
    () => filteredFields.filter((f) => f.kind === 'dimension'),
    [filteredFields],
  );
  const measureFields = useMemo(
    () => filteredFields.filter((f) => f.kind === 'measure'),
    [filteredFields],
  );

  const isReachable = (viewName: string) =>
    reachableViewNames === undefined || reachableViewNames.has(viewName);

  if (!datasetId) return null;

  if (isLoading) {
    return <div className="px-4 py-3 text-caption text-text-quaternary">{t('explore.columnPanel.loadingModel')}</div>;
  }

  if (!model?.model_id || views.length === 0) {
    return (
      <div className="group/help relative flex cursor-default items-center gap-1.5 px-4 py-3 text-caption italic text-text-quaternary">
        {t('explore.columnPanel.noDataModel')}
        <span className="inline-flex items-center">
          <Info className="h-3.5 w-3.5 text-text-quaternary transition-colors group-hover/help:text-brand" />
          <span className="pointer-events-none absolute left-4 top-full z-50 mt-1 hidden w-64 rounded-md bg-surface-inverse px-2.5 py-2 text-tiny not-italic tracking-normal text-text-inverse shadow-linear-lg group-hover/help:block">
            {t('explore.columnPanel.noDataModelHelp')}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="space-y-2 px-4 pb-2 pt-3">
        <Input
          size="sm"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('explore.columnPanel.searchFields')}
          leadingIcon={<Search className="h-3.5 w-3.5" />}
        />
        <div className="flex flex-wrap items-center gap-1">
          <button
            onClick={() => setViewFilter('__all__')}
            className={`rounded-full border px-2 py-0.5 text-tiny transition-colors ${
              viewFilter === '__all__'
                ? 'border-brand bg-brand/10 text-brand'
                : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-tertiary hover:bg-surface-2'
            }`}
          >
            {t('explore.columnPanel.allViews')}
          </button>
          {views.map((v) => (
            <button
              key={v.id}
              onClick={() => setViewFilter(v.name)}
              className={`rounded-full border px-2 py-0.5 text-tiny transition-colors ${
                viewFilter === v.name
                  ? 'border-brand bg-brand/10 text-brand'
                  : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-tertiary hover:bg-surface-2'
              }`}
              title={isReachable(v.name) ? undefined : t('explore.columnPanel.viewNotJoined')}
            >
              {viewLabel(v)}
              {!isReachable(v.name) && <span className="ml-1 text-warning">⚠</span>}
            </button>
          ))}
        </div>
      </div>

      {hasMultipleViewsWithoutJoins && (
        <div className="mx-4 mb-2 rounded-md border border-warning/40 bg-warning/5 px-2.5 py-1.5 text-tiny leading-snug text-warning">
          <div className="font-emphasis">{t('explore.columnPanel.noRelationshipsTitle')}</div>
          <div className="opacity-90">
            {t('explore.columnPanel.multiTableNeedJoinPrefix')} <em>{t('explore.columnPanel.dataModel')}</em> {t('explore.columnPanel.multiTableNeedJoinMiddle')}{' '}
            <em>{t('explore.columnPanel.needJoin')}</em> {t('explore.columnPanel.multiTableNeedJoinSuffix')}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto pb-2">
        {dimensionFields.length === 0 && measureFields.length === 0 && (
          <div className="px-4 py-6 text-center text-caption italic text-text-quaternary">
            {t('explore.columnPanel.noFieldsMatch')}
          </div>
        )}

        {dimensionFields.length > 0 && (
          <div className="mb-2">
            <div className="sticky top-0 z-10 bg-surface-1 px-4 py-1 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
              {t('explore.columnPanel.dimensions')}
            </div>
            {dimensionFields.map((field) => {
              const dim = field.dimension!;
              const reachable = isReachable(field.view.name);
              // Phase-13: indent rows that have a parent dim. Pure visual
              // signal — engine doesn't care; just helps DA scan a
              // Year → Quarter → Month hierarchy at a glance.
              const hasParent = Boolean(dim.parent);
              const titleParts = [
                dim.description,
                dim.sql,
                dim.name,
                hasParent ? t('explore.columnPanel.childOf', { parent: dim.parent! }) : null,
              ].filter(Boolean) as string[];
              return (
                <FieldRow
                  key={`d-${field.view.id}-${dim.name}`}
                  reachable={reachable}
                  baseViewName={baseViewName ?? null}
                  fromViewName={field.view.name}
                  fromViewLabel={viewLabel(field.view)}
                  onRequestRelationship={onRequestRelationship}
                  hoverColorClass="hover:bg-brand/10 hover:text-brand"
                  title={titleParts.join(' • ')}
                  onClick={() => onSelectDimension?.(dim, field.view.name)}
                >
                  {hasParent && (
                    <span
                      aria-hidden
                      className="ml-2 text-text-quaternary"
                      title={t('explore.columnPanel.drillDownChildOf', { parent: dim.parent! })}
                    >
                      ↳
                    </span>
                  )}
                  <DimensionIcon type={dim.type} />
                  <span className="truncate">{field.label}</span>
                </FieldRow>
              );
            })}
          </div>
        )}

        {measureFields.length > 0 && (
          <div className="mb-2">
            <div className="sticky top-0 z-10 bg-surface-1 px-4 py-1 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
              {t('explore.columnPanel.measures')}
            </div>
            {measureFields.map((field) => {
              const m = field.measure!;
              const reachable = isReachable(field.view.name);
              return (
                <FieldRow
                  key={`m-${field.view.id}-${m.name}`}
                  reachable={reachable}
                  baseViewName={baseViewName ?? null}
                  fromViewName={field.view.name}
                  fromViewLabel={viewLabel(field.view)}
                  onRequestRelationship={onRequestRelationship}
                  hoverColorClass="hover:bg-warning/10 hover:text-warning"
                  title={measureTitle(m, t)}
                  onClick={() => onSelectMeasure?.(m, field.view.name)}
                >
                  <Sigma className="h-3 w-3 shrink-0 text-warning" />
                  <span className="truncate">{field.label}</span>
                  {(m.filters?.length ?? 0) > 0 && (
                    <span className="rounded bg-warning/10 px-1 text-tiny text-warning">
                      f{m.filters?.length}
                    </span>
                  )}
                  <span className="ml-auto text-tiny uppercase text-text-quaternary">{m.type}</span>
                </FieldRow>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface FieldRowProps {
  reachable: boolean;
  baseViewName: string | null;
  fromViewName: string;
  fromViewLabel: string;
  onRequestRelationship?: (params: { fromViewName: string; toViewName: string }) => void;
  hoverColorClass: string;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}

function FieldRow({
  reachable,
  baseViewName,
  fromViewName,
  fromViewLabel,
  onRequestRelationship,
  hoverColorClass,
  title,
  onClick,
  children,
}: FieldRowProps) {
  const { t } = useI18n();

  return (
    <div className="group flex w-full items-center gap-2 px-4 py-1 text-caption">
      <button
        onClick={onClick}
        title={title}
        className={`flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left text-text-secondary transition-colors ${hoverColorClass}`}
      >
        {children}
      </button>
      <span className="shrink-0 text-tiny text-text-quaternary opacity-60 group-hover:opacity-100">
        {fromViewLabel}
      </span>
      {!reachable && baseViewName && (
        <button
          onClick={() =>
            onRequestRelationship?.({
              fromViewName: baseViewName,
              toViewName: fromViewName,
            })
          }
          title={t('explore.columnPanel.missingJoinTitle', { from: baseViewName, to: fromViewLabel })}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-tiny font-emphasis text-warning hover:bg-warning/20"
        >
          <AlertTriangle className="h-2.5 w-2.5" />
          {t('explore.columnPanel.needJoin')}
        </button>
      )}
    </div>
  );
}
