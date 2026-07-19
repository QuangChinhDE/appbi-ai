'use client';

/**
 * RelationshipDialog - Modal for adding / editing a join between two tables.
 * Opened from DataModelCanvas when the user wants to define a relationship.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, Link2, Plus, Trash2 } from 'lucide-react';
import { AppModalShell } from '@/components/common/AppModalShell';
import {
  useDatasetModelJoinSuggestion,
  type DatasetModelView,
  type AddJoinParams,
} from '@/hooks/use-dataset-model';
import { useDatasetTables } from '@/hooks/use-datasets';
import { extractApiError } from '@/lib/api-errors';
import { useI18n } from '@/providers/LanguageProvider';

export type JoinType = 'left' | 'inner' | 'right' | 'full';
export type RelationshipType =
  | 'one_to_one'
  | 'one_to_many'
  | 'many_to_one'
  | 'many_to_many';

type JoinPair = {
  fromColumn: string;
  toColumn: string;
};

export type CrossFilter = 'single' | 'both';

export interface RelationshipDialogValue {
  fromViewId: number;
  toViewId: number;
  fromColumn: string;
  toColumn: string;
  fromColumns?: string[];
  toColumns?: string[];
  joinType: JoinType;
  relationship: RelationshipType;
  alias?: string | null;
  isActive?: boolean;
  crossFilter?: CrossFilter;
  /**
   * Phase-1 PBI-parity — primary key column(s) on the "one" side view of
   * this relationship. Used by Phase-4 symmetric aggregates to dedupe
   * fan-out before SUM/COUNT/AVG. Optional; when omitted the engine falls
   * back to EXISTS rewrite (correct, slower). Composite PK = list of cols.
   */
  primaryKeyOnToView?: string[] | null;
}

interface RelationshipDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (value: Omit<AddJoinParams, 'datasetId'>) => Promise<void>;
  datasetId: number;
  views: DatasetModelView[];
  initialValue?: Partial<RelationshipDialogValue>;
  isSaving?: boolean;
}

// Structural cardinality metadata (from/to badge). Labels are localized in the
// component via i18n (labelKey) so the dropdown isn't hardcoded to one language.
const RELATIONSHIP_META: {
  value: RelationshipType;
  labelKey: string;
  from: string;
  to: string;
  disabled?: boolean;
}[] = [
  { value: 'one_to_one', labelKey: 'datasets.relationshipDialog.relOneToOne', from: '1', to: '1' },
  { value: 'one_to_many', labelKey: 'datasets.relationshipDialog.relOneToMany', from: '1', to: 'N' },
  { value: 'many_to_one', labelKey: 'datasets.relationshipDialog.relManyToOne', from: 'N', to: '1' },
  // N:N allowed but flagged (cartesian fan-out can double aggregates).
  { value: 'many_to_many', labelKey: 'datasets.relationshipDialog.relManyToMany', from: 'N', to: 'N' },
];

const CROSS_FILTER_META: { value: CrossFilter; labelKey: string }[] = [
  { value: 'single', labelKey: 'datasets.relationshipDialog.crossFilterSingle' },
  { value: 'both', labelKey: 'datasets.relationshipDialog.crossFilterBoth' },
];

function formatPreviewCell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s.length > 24 ? s.slice(0, 23) + '…' : s;
}

/**
 * Compact sample-rows preview for the relationship editor (PBI-parity): shows a
 * few real rows of the table with the selected join column highlighted, so the
 * modeller SEES the values being matched. The highlighted column is pinned to
 * the first position so it's always visible without scrolling.
 */
function TablePreviewGrid({
  rows,
  highlight,
  emptyLabel,
}: {
  rows?: Record<string, unknown>[];
  highlight?: string;
  emptyLabel: string;
}) {
  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-2 px-3 py-4 text-center text-[11px] text-text-quaternary">
        {emptyLabel}
      </div>
    );
  }
  const allCols = Object.keys(rows[0] ?? {});
  const cols = highlight && allCols.includes(highlight)
    ? [highlight, ...allCols.filter((c) => c !== highlight)]
    : allCols;
  const shown = rows.slice(0, 5);
  return (
    <div className="overflow-auto rounded-md border border-[rgb(var(--border-line))] max-h-[140px]">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c}
                className={`sticky top-0 whitespace-nowrap border-b border-[rgb(var(--border-line))] px-2 py-1 text-left font-semibold ${
                  c === highlight ? 'bg-success/20 text-success' : 'bg-surface-2 text-text-tertiary'
                }`}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i} className="border-b border-[rgb(var(--border-line))] last:border-0">
              {cols.map((c) => (
                <td
                  key={c}
                  className={`max-w-[160px] truncate whitespace-nowrap px-2 py-1 ${
                    c === highlight ? 'bg-success/10 font-medium text-text-primary' : 'text-text-secondary'
                  }`}
                  title={r[c] === null || r[c] === undefined ? '' : String(r[c])}
                >
                  {formatPreviewCell(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
  placeholder,
  className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  placeholder?: string;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-3 py-2 text-sm
        focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand
        disabled:bg-surface-2 disabled:text-text-quaternary ${className}`}
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function buildJoinPairsFromInitialValue(
  initialValue?: Partial<RelationshipDialogValue>,
): JoinPair[] {
  const fromColumns = initialValue?.fromColumns?.length
    ? initialValue.fromColumns
    : (initialValue?.fromColumn ? [initialValue.fromColumn] : []);
  const toColumns = initialValue?.toColumns?.length
    ? initialValue.toColumns
    : (initialValue?.toColumn ? [initialValue.toColumn] : []);

  const pairCount = Math.max(fromColumns.length, toColumns.length, 1);
  return Array.from({ length: pairCount }, (_, index) => ({
    fromColumn: fromColumns[index] ?? '',
    toColumn: toColumns[index] ?? '',
  }));
}

function buildSelectionKey(
  fromViewId: number | '',
  toViewId: number | '',
  joinPairs: JoinPair[],
): string {
  const pairsKey = joinPairs
    .map((pair) => `${pair.fromColumn.trim()}=${pair.toColumn.trim()}`)
    .join('|');
  return `${fromViewId}|${toViewId}|${pairsKey}`;
}

function normalizeJoinPairLists(joinPairs: JoinPair[]): { fromColumns: string[]; toColumns: string[] } {
  const normalizedPairs = joinPairs
    .map((pair) => ({
      fromColumn: pair.fromColumn.trim(),
      toColumn: pair.toColumn.trim(),
    }))
    .filter((pair) => pair.fromColumn && pair.toColumn);

  return {
    fromColumns: normalizedPairs.map((pair) => pair.fromColumn),
    toColumns: normalizedPairs.map((pair) => pair.toColumn),
  };
}

export function RelationshipDialog({
  isOpen,
  onClose,
  onSave,
  datasetId,
  views,
  initialValue,
  isSaving = false,
}: RelationshipDialogProps) {
  const { t } = useI18n();
  const [fromViewId, setFromViewId] = useState<number | ''>(initialValue?.fromViewId ?? '');
  const [toViewId, setToViewId] = useState<number | ''>(initialValue?.toViewId ?? '');
  const [joinPairs, setJoinPairs] = useState<JoinPair[]>(() => buildJoinPairsFromInitialValue(initialValue));
  // ONE canonical rule: the SQL join type is DERIVED, never authored. Every
  // Fact–Dimension relationship runs at query time as FACT LEFT JOIN DIM.
  // Cardinality (below) is the single source of truth; join type is not a knob.
  const joinType: JoinType = 'left';
  const [relationship, setRelationship] = useState<RelationshipType>(
    initialValue?.relationship ?? 'many_to_one',
  );
  const [alias, setAlias] = useState<string>(initialValue?.alias ?? '');
  const [isActive, setIsActive] = useState<boolean>(initialValue?.isActive ?? true);
  const [crossFilter, setCrossFilter] = useState<CrossFilter>(initialValue?.crossFilter ?? 'single');
  const [primaryKeyOnToView, setPrimaryKeyOnToView] = useState<string[]>(
    initialValue?.primaryKeyOnToView ?? [],
  );
  const [error, setError] = useState('');
  const [relationshipTouched, setRelationshipTouched] = useState(false);
  // Keep the default view simple (cardinality + cross-filter); the remaining
  // SQL-level knobs (alias, primary key) live under Advanced. Join type is no
  // longer a knob — it is always the canonical LEFT JOIN.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [autoSuggestRelationship, setAutoSuggestRelationship] = useState(!initialValue?.relationship);
  const [previousSelectionKey, setPreviousSelectionKey] = useState('');
  const suppressSelectionResetRef = useRef(false);

  const selectionKey = buildSelectionKey(fromViewId, toViewId, joinPairs);

  useEffect(() => {
    if (!isOpen) return;
    const nextPairs = buildJoinPairsFromInitialValue(initialValue);
    setFromViewId(initialValue?.fromViewId ?? '');
    setToViewId(initialValue?.toViewId ?? '');
    setJoinPairs(nextPairs);
    setRelationship(initialValue?.relationship ?? 'many_to_one');
    setAlias(initialValue?.alias ?? '');
    setIsActive(initialValue?.isActive ?? true);
    setCrossFilter(initialValue?.crossFilter ?? 'single');
    setPrimaryKeyOnToView(initialValue?.primaryKeyOnToView ?? []);
    setError('');
    setRelationshipTouched(false);
    setAutoSuggestRelationship(!initialValue?.relationship);
    setPreviousSelectionKey(buildSelectionKey(initialValue?.fromViewId ?? '', initialValue?.toViewId ?? '', nextPairs));
    suppressSelectionResetRef.current = true;
  }, [initialValue, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (suppressSelectionResetRef.current) {
      suppressSelectionResetRef.current = false;
      return;
    }
    if (previousSelectionKey === selectionKey) return;
    setPreviousSelectionKey(selectionKey);
    setRelationshipTouched(false);
    setAutoSuggestRelationship(true);
  }, [isOpen, previousSelectionKey, selectionKey]);

  const fromView = views.find((view) => view.id === fromViewId);
  const toView = views.find((view) => view.id === toViewId);

  const fromColumns = fromView
    ? fromView.dimensions.map((dimension) => ({ value: dimension.name, label: dimension.label || dimension.name }))
    : [];
  const toColumns = toView
    ? toView.dimensions.map((dimension) => ({ value: dimension.name, label: dimension.label || dimension.name }))
    : [];

  const viewOptions = views.map((view) => ({
    value: String(view.id),
    label: view.table_display_name || view.name,
  }));

  const normalizedJoinPairs = useMemo(() => normalizeJoinPairLists(joinPairs), [joinPairs]);
  const shouldSuggestRelationship = Boolean(
    isOpen
    && datasetId > 0
    && fromViewId
    && toViewId
    && fromViewId !== toViewId
    && joinPairs.length > 0
    && normalizedJoinPairs.fromColumns.length === joinPairs.length
    && normalizedJoinPairs.toColumns.length === joinPairs.length,
  );

  const {
    data: joinSuggestion,
    isLoading: isSuggestingRelationship,
  } = useDatasetModelJoinSuggestion(
    shouldSuggestRelationship ? datasetId : null,
    shouldSuggestRelationship
      ? {
          fromViewId: Number(fromViewId),
          toViewId: Number(toViewId),
          fromColumn: normalizedJoinPairs.fromColumns[0] ?? '',
          toColumn: normalizedJoinPairs.toColumns[0] ?? '',
          fromColumns: normalizedJoinPairs.fromColumns,
          toColumns: normalizedJoinPairs.toColumns,
        }
      : null,
  );

  useEffect(() => {
    if (!isOpen || !joinSuggestion || !autoSuggestRelationship || relationshipTouched) return;
    // Only the CARDINALITY is auto-suggested from the profiled data; the join
    // type is always the canonical LEFT and is not adopted from anywhere.
    setRelationship(joinSuggestion.relationship);
  }, [autoSuggestRelationship, isOpen, joinSuggestion, relationshipTouched]);

  // Sample rows per table (PBI-style data preview). Fetched once while the
  // dialog is open; keyed by DatasetTable id (view.dataset_table_id).
  const { data: datasetTables } = useDatasetTables(isOpen ? datasetId : null);
  const sampleByTableId = useMemo(() => {
    const map = new Map<number, Record<string, unknown>[]>();
    for (const tbl of datasetTables ?? []) {
      if (Array.isArray(tbl.sample_cache) && tbl.sample_cache.length > 0) {
        map.set(tbl.id, tbl.sample_cache as Record<string, unknown>[]);
      }
    }
    return map;
  }, [datasetTables]);

  if (!isOpen) return null;

  const handleFromViewChange = (id: string) => {
    setFromViewId(Number(id));
    setJoinPairs((current) => current.map((pair) => ({ ...pair, fromColumn: '' })));
  };

  const handleToViewChange = (id: string) => {
    setToViewId(Number(id));
    const targetView = views.find((view) => view.id === Number(id));
    const defaultToColumn = targetView?.dimensions.find((dimension) => dimension.name === 'id')?.name ?? '';
    setJoinPairs((current) =>
      current.map((pair, index) => ({
        ...pair,
        toColumn: index === 0 && !pair.toColumn ? defaultToColumn : pair.toColumn,
      })),
    );
  };

  const handleJoinPairChange = (
    index: number,
    side: 'fromColumn' | 'toColumn',
    value: string,
  ) => {
    setJoinPairs((current) =>
      current.map((pair, pairIndex) =>
        pairIndex === index ? { ...pair, [side]: value } : pair,
      ),
    );
  };

  const handleAddKey = () => {
    setJoinPairs((current) => [...current, { fromColumn: '', toColumn: '' }]);
  };

  const handleRemoveKey = (index: number) => {
    setJoinPairs((current) => (
      current.length <= 1 ? current : current.filter((_, pairIndex) => pairIndex !== index)
    ));
  };

  const handleSave = async () => {
    setError('');
    if (!fromViewId || !toViewId) {
      setError(t('datasets.relationshipDialog.errorSelectBothTables'));
      return;
    }
    if (fromViewId === toViewId) {
      setError(t('datasets.relationshipDialog.errorSelfJoin'));
      return;
    }
    if (normalizedJoinPairs.fromColumns.length !== joinPairs.length || normalizedJoinPairs.toColumns.length !== joinPairs.length) {
      setError(t('datasets.relationshipDialog.errorSelectJoinColumns'));
      return;
    }

    try {
      const aliasTrimmed = alias.trim();
      await onSave({
        fromViewId: Number(fromViewId),
        toViewId: Number(toViewId),
        fromColumn: normalizedJoinPairs.fromColumns[0],
        toColumn: normalizedJoinPairs.toColumns[0],
        fromColumns: normalizedJoinPairs.fromColumns,
        toColumns: normalizedJoinPairs.toColumns,
        joinType,
        relationship,
        alias: aliasTrimmed || null,
        isActive,
        crossFilter,
        primaryKeyOnToView: primaryKeyOnToView.length > 0 ? primaryKeyOnToView : null,
      });
      onClose();
    } catch (saveError: unknown) {
      // BE có thể trả detail dạng object (vd JOIN_INACTIVE_CASCADE 409) —
      // dùng extractApiError để chuyển an toàn về string, tránh React #31
      // khi render object trực tiếp vào JSX.
      setError(extractApiError(saveError, t('datasets.relationshipDialog.errorSaveFailed')));
    }
  };

  const relationshipOptions = RELATIONSHIP_META.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
    disabled: option.disabled,
  }));
  const crossFilterOptions = CROSS_FILTER_META.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const relOpt = RELATIONSHIP_META.find((option) => option.value === relationship)!;
  const suggestedRelationshipLabel = joinSuggestion
    ? t(RELATIONSHIP_META.find((option) => option.value === joinSuggestion.relationship)?.labelKey || '')
    : null;
  const suggestedUniquenessLabel = joinSuggestion
    && joinSuggestion.from_unique != null
    && joinSuggestion.to_unique != null
    ? ` (${joinSuggestion.from_unique ? t('datasets.relationshipDialog.fromUnique') : t('datasets.relationshipDialog.fromDuplicate')}, ${joinSuggestion.to_unique ? t('datasets.relationshipDialog.toUnique') : t('datasets.relationshipDialog.toDuplicate')})`
    : '';
  const blockingMessage = joinSuggestion?.can_create === false
    ? (joinSuggestion.message || t('datasets.relationshipDialog.cannotCreate'))
    : null;
  const previewPairs = normalizedJoinPairs.fromColumns.map((fromColumn, index) => ({
    fromColumn,
    toColumn: normalizedJoinPairs.toColumns[index] ?? '',
  }));

  return (
    <AppModalShell
      onClose={onClose}
      title={initialValue?.fromViewId ? t('datasets.relationshipDialog.titleEdit') : t('datasets.relationshipDialog.titleAdd')}
      description={t('datasets.relationshipDialog.description')}
      icon={<Link2 className="h-5 w-5" />}
      maxWidthClass="max-w-[96vw]"
      panelClassName="w-[640px]"
      bodyClassName="px-6 py-5"
      closeDisabled={isSaving}
      footer={(
        <>
          <button
            onClick={onClose}
            disabled={isSaving}
            className="rounded-md border border-[rgb(var(--border-strong))] px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={
              isSaving
              || !fromViewId
              || !toViewId
              || normalizedJoinPairs.fromColumns.length !== joinPairs.length
              || normalizedJoinPairs.toColumns.length !== joinPairs.length
              || joinSuggestion?.can_create === false
            }
            className="flex items-center gap-2 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
          >
            {isSaving ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                {t('datasets.relationshipDialog.saving')}
              </>
            ) : (
              t('datasets.relationshipDialog.saveButton')
            )}
          </button>
        </>
      )}
    >
      <div className="space-y-5">
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-text-secondary">
              {t('datasets.relationshipDialog.fromTable')}
            </label>
            <Select
              value={String(fromViewId)}
              onChange={handleFromViewChange}
              options={viewOptions.filter((option) => option.value !== String(toViewId))}
              placeholder={t('datasets.relationshipDialog.selectTablePlaceholder')}
            />
          </div>

          <div className="flex items-center justify-center pb-0.5">
            <div className="flex items-center gap-1 whitespace-nowrap rounded-full bg-brand/10 px-2 py-1 text-xs font-semibold text-brand">
              <span>{relOpt.from}</span>
              <ArrowRight className="h-3.5 w-3.5" />
              <span>{relOpt.to}</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-text-secondary">
              {t('datasets.relationshipDialog.toTable')}
            </label>
            <Select
              value={String(toViewId)}
              onChange={handleToViewChange}
              options={viewOptions.filter((option) => option.value !== String(fromViewId))}
              placeholder={t('datasets.relationshipDialog.selectTablePlaceholder')}
            />
          </div>
        </div>

        {/* PBI-parity data preview: sample rows of each table with the selected
            join column highlighted, so the modeller sees the values matched. */}
        {(fromView || toView) && (
          <div className="grid grid-cols-[1fr_auto_1fr] gap-3">
            <div className="min-w-0 space-y-1">
              <div className="text-[10px] font-medium uppercase tracking-wide text-text-quaternary truncate">
                {fromView ? (fromView.table_display_name || fromView.name) : t('datasets.relationshipDialog.fromTable')}
              </div>
              <TablePreviewGrid
                rows={fromView?.dataset_table_id != null ? sampleByTableId.get(fromView.dataset_table_id) : undefined}
                highlight={joinPairs[0]?.fromColumn || undefined}
                emptyLabel={t('datasets.relationshipDialog.previewEmpty')}
              />
            </div>
            <div className="w-4" />
            <div className="min-w-0 space-y-1">
              <div className="text-[10px] font-medium uppercase tracking-wide text-text-quaternary truncate">
                {toView ? (toView.table_display_name || toView.name) : t('datasets.relationshipDialog.toTable')}
              </div>
              <TablePreviewGrid
                rows={toView?.dataset_table_id != null ? sampleByTableId.get(toView.dataset_table_id) : undefined}
                highlight={joinPairs[0]?.toColumn || undefined}
                emptyLabel={t('datasets.relationshipDialog.previewEmpty')}
              />
            </div>
          </div>
        )}

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium uppercase tracking-wide text-text-secondary">
              {t('datasets.relationshipDialog.joinKeys')}
            </label>
            <button
              type="button"
              onClick={handleAddKey}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 text-text-secondary transition-colors hover:bg-surface-2"
              title={t('datasets.relationshipDialog.addKeyPair')}
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>

          {joinPairs.map((pair, index) => (
            <div
              key={`${index}-${pair.fromColumn}-${pair.toColumn}`}
              className="grid grid-cols-[1fr_auto_1fr_auto] items-end gap-3"
            >
              <div className="space-y-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                  {t('datasets.relationshipDialog.fromColumn')} {joinPairs.length > 1 ? index + 1 : ''}
                </label>
                {fromColumns.length > 0 ? (
                  <Select
                    value={pair.fromColumn}
                    onChange={(value) => handleJoinPairChange(index, 'fromColumn', value)}
                    options={fromColumns}
                    placeholder={t('datasets.relationshipDialog.selectColumnPlaceholder')}
                  />
                ) : (
                  <input
                    type="text"
                    value={pair.fromColumn}
                    onChange={(event) => handleJoinPairChange(index, 'fromColumn', event.target.value)}
                    placeholder={t('datasets.relationshipDialog.fromColumnPlaceholder')}
                    className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-3 py-2 text-sm
                      focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                )}
              </div>

              <div className="flex items-center justify-center pb-0.5">
                <span className="font-mono text-sm text-text-quaternary">=</span>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                  {t('datasets.relationshipDialog.toColumn')} {joinPairs.length > 1 ? index + 1 : ''}
                </label>
                {toColumns.length > 0 ? (
                  <Select
                    value={pair.toColumn}
                    onChange={(value) => handleJoinPairChange(index, 'toColumn', value)}
                    options={toColumns}
                    placeholder={t('datasets.relationshipDialog.selectColumnPlaceholder')}
                  />
                ) : (
                  <input
                    type="text"
                    value={pair.toColumn}
                    onChange={(event) => handleJoinPairChange(index, 'toColumn', event.target.value)}
                    placeholder={t('datasets.relationshipDialog.toColumnPlaceholder')}
                    className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-3 py-2 text-sm
                      focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                )}
              </div>

              <div className="flex items-center justify-center pb-0.5">
                <button
                  type="button"
                  onClick={() => handleRemoveKey(index)}
                  disabled={joinPairs.length <= 1}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 text-text-secondary transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                  title={t('datasets.relationshipDialog.removeKeyPair')}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* PBI-style: lead with Cardinality + Cross-filter (the two concepts a
            DA reasons about). SQL join type / alias / primary key move to
            Advanced so the default dialog stays approachable. */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-text-secondary">
              {t('datasets.relationshipDialog.relationshipType')}
            </label>
            <Select
              value={relationship}
              onChange={(value) => {
                setRelationship(value as RelationshipType);
                setRelationshipTouched(true);
                setAutoSuggestRelationship(false);
              }}
              options={relationshipOptions}
            />
            {(isSuggestingRelationship || suggestedRelationshipLabel) && (
              <p className={`text-xs ${joinSuggestion?.can_create === false ? 'text-danger' : 'text-text-quaternary'}`}>
                {isSuggestingRelationship
                  ? t('datasets.relationshipDialog.checkingCardinality')
                  : t('datasets.relationshipDialog.suggestedFromData', { label: `${suggestedRelationshipLabel}${suggestedUniquenessLabel}` })}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-text-secondary">
              {t('datasets.relationshipDialog.crossFilterDirection')}
            </label>
            <Select
              value={crossFilter}
              onChange={(value) => setCrossFilter(value as CrossFilter)}
              options={crossFilterOptions}
            />
            <p className="text-xs text-text-quaternary leading-snug">
              {crossFilter === 'both'
                ? t('datasets.relationshipDialog.crossFilterHelpBoth')
                : t('datasets.relationshipDialog.crossFilterHelpSingle')}
            </p>
          </div>
        </div>

        {/* F4 (DA feedback) — a drawn 1:N is auto-oriented to N:1 on the many
            side at save time so a measure chart on the fact can use it. */}
        {joinSuggestion?.will_auto_orient && !relationshipTouched && (
          <p className="rounded-md border border-brand/30 bg-brand/5 px-3 py-2 text-[11px] leading-snug text-brand">
            {t('datasets.relationshipDialog.autoOrientHint')}
          </p>
        )}
        {/* Many-to-many is allowed but high-risk (cartesian fan-out). */}
        {relationship === 'many_to_many' && (
          <p className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-[11px] leading-snug text-danger">
            {t('datasets.relationshipDialog.manyToManyWarning')}
          </p>
        )}

        {/* Plain-language summary (PBI shows a sentence, not SQL). */}
        {fromView && toView && previewPairs.length > 0 && (
          <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-xs leading-relaxed text-text-secondary">
            <span className="font-medium text-text-tertiary">{t('datasets.relationshipDialog.summaryLabel')}: </span>
            {t(
              relationship === 'one_to_many'
                ? 'datasets.relationshipDialog.summaryOneToMany'
                : relationship === 'one_to_one'
                ? 'datasets.relationshipDialog.summaryOneToOne'
                : relationship === 'many_to_many'
                ? 'datasets.relationshipDialog.summaryManyToMany'
                : 'datasets.relationshipDialog.summaryManyToOne',
              {
                from: fromView.table_display_name || fromView.name,
                to: toView.table_display_name || toView.name,
              },
            )}{' '}
            {crossFilter === 'both'
              ? t('datasets.relationshipDialog.crossFilterHelpBoth')
              : t('datasets.relationshipDialog.crossFilterHelpSingle')}
          </div>
        )}

        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-text-secondary">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            {t('datasets.relationshipDialog.activeRelationship')}
          </label>
          <p className="text-xs text-text-quaternary leading-snug">
            {isActive
              ? t('datasets.relationshipDialog.activeHelpOn')
              : t('datasets.relationshipDialog.activeHelpOff')}
          </p>
        </div>

        {/* ── Advanced options (collapsed by default): SQL-level knobs ── */}
        <div className="rounded-md border border-[rgb(var(--border-line))]">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium uppercase tracking-wide text-text-secondary hover:bg-surface-2"
          >
            {showAdvanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {t('datasets.relationshipDialog.advancedOptions')}
          </button>
          {showAdvanced && (
            <div className="space-y-4 border-t border-[rgb(var(--border-line))] px-3 py-3">
              <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                <p className="text-xs text-text-quaternary leading-snug">
                  {t('datasets.relationshipDialog.joinTypeDerivedNote')}
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                  {t('datasets.relationshipDialog.alias')}{' '}
                  <span className="normal-case text-text-quaternary">({t('datasets.relationshipDialog.aliasHint')})</span>
                </label>
                <input
                  type="text"
                  value={alias}
                  onChange={(event) => setAlias(event.target.value)}
                  placeholder={toView ? t('datasets.relationshipDialog.aliasPlaceholderBlank', { name: toView.name }) : t('datasets.relationshipDialog.aliasPlaceholderExample')}
                  className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-3 py-2 text-sm
                    focus:outline-none focus:ring-2 focus:ring-brand"
                />
                <p className="text-xs text-text-quaternary">
                  {t('datasets.relationshipDialog.aliasHelpPrefix')} <code>creator.email</code>{t('datasets.relationshipDialog.aliasHelpSuffix')}
                </p>
              </div>

              {/* Primary key on the "one" side — for symmetric aggregates. */}
              {toView && (relationship === 'many_to_one' || relationship === 'one_to_one') && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                    {t('datasets.relationshipDialog.primaryKeyOn', { name: toView.table_display_name || toView.name })}{' '}
                    <span className="text-text-quaternary normal-case">({t('datasets.relationshipDialog.primaryKeyHint')})</span>
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {toColumns.map((col) => {
                      const checked = primaryKeyOnToView.includes(col.value);
                      return (
                        <label
                          key={col.value}
                          className={`cursor-pointer rounded-md border px-2 py-0.5 text-xs ${
                            checked
                              ? 'border-brand bg-brand/10 text-brand'
                              : 'border-[rgb(var(--border-line))] text-text-secondary'
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={checked}
                            onChange={() =>
                              setPrimaryKeyOnToView((current) =>
                                current.includes(col.value)
                                  ? current.filter((c) => c !== col.value)
                                  : [...current, col.value],
                              )
                            }
                          />
                          {col.label}
                        </label>
                      );
                    })}
                  </div>
                  <p className="text-xs text-text-quaternary leading-snug">
                    {t('datasets.relationshipDialog.primaryKeyHelp')}
                  </p>
                </div>
              )}

              {/* Technical SQL preview (developers). */}
              {fromView && toView && previewPairs.length > 0 && (
                <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-xs font-mono text-text-tertiary">
                  <div className="mb-1">
                    <span className="font-semibold uppercase text-brand">LEFT JOIN</span>{' '}
                    <span className="text-text-secondary">{toView.table_display_name || toView.name}</span>{' '}
                    <span className="text-text-tertiary">ON</span>
                  </div>
                  <div className="space-y-1">
                    {previewPairs.map((pair, index) => (
                      <div key={`${pair.fromColumn}-${pair.toColumn}-${index}`}>
                        <span className="text-text-secondary">
                          {fromView.table_display_name || fromView.name}.{pair.fromColumn}
                        </span>{' '}
                        ={' '}
                        <span className="text-text-secondary">
                          {toView.table_display_name || toView.name}.{pair.toColumn}
                        </span>
                        {index < previewPairs.length - 1 ? <span className="text-text-quaternary"> AND</span> : null}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {(blockingMessage || error) && (
          <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
            {blockingMessage || error}
          </p>
        )}
      </div>
    </AppModalShell>
  );
}
