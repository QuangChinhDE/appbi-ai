'use client';

/**
 * RelationshipDialog - Modal for adding / editing a join between two tables.
 * Opened from DataModelCanvas when the user wants to define a relationship.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Link2, Plus, Trash2 } from 'lucide-react';
import { AppModalShell } from '@/components/common/AppModalShell';
import {
  useDatasetModelJoinSuggestion,
  type DatasetModelView,
  type AddJoinParams,
} from '@/hooks/use-dataset-model';
import { extractApiError } from '@/lib/api-errors';

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

const JOIN_TYPE_OPTIONS: { value: JoinType; label: string }[] = [
  { value: 'left', label: 'LEFT JOIN' },
  { value: 'inner', label: 'INNER JOIN' },
  { value: 'right', label: 'RIGHT JOIN' },
  { value: 'full', label: 'FULL OUTER JOIN' },
];

const RELATIONSHIP_OPTIONS: {
  value: RelationshipType;
  label: string;
  from: string;
  to: string;
  disabled?: boolean;
}[] = [
  { value: 'one_to_one', label: '1 : 1  -  One to One', from: '1', to: '1' },
  { value: 'one_to_many', label: '1 : N  -  One to Many', from: '1', to: 'N' },
  { value: 'many_to_one', label: 'N : 1  -  Many to One', from: 'N', to: '1' },
  // Phase-3b: N:N allowed but flagged with a red banner in the dialog body
  // because cartesian fan-out can double aggregates.
  { value: 'many_to_many', label: 'N : N  -  Many to Many (cảnh báo)', from: 'N', to: 'N' },
];

const CROSS_FILTER_OPTIONS: { value: CrossFilter; label: string }[] = [
  { value: 'single', label: 'Single — chỉ filter từ source → target' },
  { value: 'both', label: 'Both — filter cả 2 chiều (giống Power BI bidirectional)' },
];

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
  const [fromViewId, setFromViewId] = useState<number | ''>(initialValue?.fromViewId ?? '');
  const [toViewId, setToViewId] = useState<number | ''>(initialValue?.toViewId ?? '');
  const [joinPairs, setJoinPairs] = useState<JoinPair[]>(() => buildJoinPairsFromInitialValue(initialValue));
  const [joinType, setJoinType] = useState<JoinType>(initialValue?.joinType ?? 'left');
  const [relationship, setRelationship] = useState<RelationshipType>(
    initialValue?.relationship ?? 'many_to_one',
  );
  const [alias, setAlias] = useState<string>(initialValue?.alias ?? '');
  const [isActive, setIsActive] = useState<boolean>(initialValue?.isActive ?? true);
  const [crossFilter, setCrossFilter] = useState<CrossFilter>(initialValue?.crossFilter ?? 'single');
  const [error, setError] = useState('');
  const [relationshipTouched, setRelationshipTouched] = useState(false);
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
    setJoinType(initialValue?.joinType ?? 'left');
    setRelationship(initialValue?.relationship ?? 'many_to_one');
    setAlias(initialValue?.alias ?? '');
    setIsActive(initialValue?.isActive ?? true);
    setCrossFilter(initialValue?.crossFilter ?? 'single');
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
    setRelationship(joinSuggestion.relationship);
  }, [autoSuggestRelationship, isOpen, joinSuggestion, relationshipTouched]);

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
      setError('Please select both tables.');
      return;
    }
    if (fromViewId === toViewId) {
      setError('Cannot join a table to itself.');
      return;
    }
    if (normalizedJoinPairs.fromColumns.length !== joinPairs.length || normalizedJoinPairs.toColumns.length !== joinPairs.length) {
      setError('Please select join columns for every key pair.');
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
      });
      onClose();
    } catch (saveError: unknown) {
      // BE có thể trả detail dạng object (vd JOIN_INACTIVE_CASCADE 409) —
      // dùng extractApiError để chuyển an toàn về string, tránh React #31
      // khi render object trực tiếp vào JSX.
      setError(extractApiError(saveError, 'Failed to save relationship.'));
    }
  };

  const relOpt = RELATIONSHIP_OPTIONS.find((option) => option.value === relationship)!;
  const suggestedRelationshipLabel = joinSuggestion
    ? RELATIONSHIP_OPTIONS.find((option) => option.value === joinSuggestion.relationship)?.label
    : null;
  const suggestedUniquenessLabel = joinSuggestion
    && joinSuggestion.from_unique != null
    && joinSuggestion.to_unique != null
    ? ` (${joinSuggestion.from_unique ? 'from unique' : 'from duplicate'}, ${joinSuggestion.to_unique ? 'to unique' : 'to duplicate'})`
    : '';
  const blockingMessage = joinSuggestion?.can_create === false
    ? (joinSuggestion.message || 'This relationship cannot be created.')
    : null;
  const previewPairs = normalizedJoinPairs.fromColumns.map((fromColumn, index) => ({
    fromColumn,
    toColumn: normalizedJoinPairs.toColumns[index] ?? '',
  }));

  return (
    <AppModalShell
      onClose={onClose}
      title={initialValue?.fromViewId ? 'Edit Relationship' : 'Add Relationship'}
      description="Define how two semantic views join and how their cardinality should be interpreted."
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
            Cancel
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
                Saving...
              </>
            ) : (
              'Save Relationship'
            )}
          </button>
        </>
      )}
    >
      <div className="space-y-5">
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-text-secondary">
              From Table
            </label>
            <Select
              value={String(fromViewId)}
              onChange={handleFromViewChange}
              options={viewOptions.filter((option) => option.value !== String(toViewId))}
              placeholder="Select table..."
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
              To Table
            </label>
            <Select
              value={String(toViewId)}
              onChange={handleToViewChange}
              options={viewOptions.filter((option) => option.value !== String(fromViewId))}
              placeholder="Select table..."
            />
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium uppercase tracking-wide text-text-secondary">
              Join Keys
            </label>
            <button
              type="button"
              onClick={handleAddKey}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 text-text-secondary transition-colors hover:bg-surface-2"
              title="Add another key pair"
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
                  From Column {joinPairs.length > 1 ? index + 1 : ''}
                </label>
                {fromColumns.length > 0 ? (
                  <Select
                    value={pair.fromColumn}
                    onChange={(value) => handleJoinPairChange(index, 'fromColumn', value)}
                    options={fromColumns}
                    placeholder="Select column..."
                  />
                ) : (
                  <input
                    type="text"
                    value={pair.fromColumn}
                    onChange={(event) => handleJoinPairChange(index, 'fromColumn', event.target.value)}
                    placeholder="e.g. user_id"
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
                  To Column {joinPairs.length > 1 ? index + 1 : ''}
                </label>
                {toColumns.length > 0 ? (
                  <Select
                    value={pair.toColumn}
                    onChange={(value) => handleJoinPairChange(index, 'toColumn', value)}
                    options={toColumns}
                    placeholder="Select column..."
                  />
                ) : (
                  <input
                    type="text"
                    value={pair.toColumn}
                    onChange={(event) => handleJoinPairChange(index, 'toColumn', event.target.value)}
                    placeholder="e.g. id"
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
                  title="Remove key pair"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-text-secondary">
              Relationship Type
            </label>
            <Select
              value={relationship}
              onChange={(value) => {
                setRelationship(value as RelationshipType);
                setRelationshipTouched(true);
                setAutoSuggestRelationship(false);
              }}
              options={RELATIONSHIP_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
                disabled: option.disabled,
              }))}
            />
            {(isSuggestingRelationship || suggestedRelationshipLabel) && (
              <p className={`text-xs ${joinSuggestion?.can_create === false ? 'text-danger' : 'text-text-quaternary'}`}>
                {isSuggestingRelationship
                  ? 'Checking join cardinality...'
                  : `Suggested from current data: ${suggestedRelationshipLabel}${suggestedUniquenessLabel}`}
              </p>
            )}
            {/* Phase-3b: many-to-many is allowed but high-risk. Show a red
                banner whenever the user (or auto-suggestion) selects it so
                they're nudged toward a bridge-table design. */}
            {relationship === 'many_to_many' && (
              <p className="rounded-md border border-danger/40 bg-danger/5 px-2 py-1.5 text-[11px] leading-snug text-danger">
                ⚠ Many-to-many có thể nhân đôi giá trị aggregate do cartesian fan-out.
                Nên tạo bridge table + 2 quan hệ N:1 thay vì N:N trực tiếp.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-text-secondary">
              Join Type
            </label>
            <Select
              value={joinType}
              onChange={(value) => setJoinType(value as JoinType)}
              options={JOIN_TYPE_OPTIONS}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium uppercase tracking-wide text-text-secondary">
            Alias <span className="normal-case text-text-quaternary">(optional - for role-playing, e.g. "creator", "updater")</span>
          </label>
          <input
            type="text"
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
            placeholder={toView ? `Leave blank to use "${toView.name}"` : 'e.g. creator, updater'}
            className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-3 py-2 text-sm
              focus:outline-none focus:ring-2 focus:ring-brand"
          />
          <p className="text-xs text-text-quaternary">
            Use this when the same table is joined more than once via different keys. Field references will use
            the alias (e.g. <code>creator.email</code>) instead of the table name.
          </p>
        </div>

        {/* Phase-3b: Active toggle + Cross-filter direction. Defaults match
            legacy behaviour (active + single) so existing joins behave as
            before unless the user explicitly opts in. */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-text-secondary">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Active relationship
            </label>
            <p className="text-xs text-text-quaternary leading-snug">
              {isActive
                ? 'Quan hệ đang chạy. Engine sẽ dùng để resolve join path.'
                : 'Tắt — engine sẽ bỏ qua. Dùng khi cần break vòng lặp hoặc giữ role-playing thay thế.'}
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-text-secondary">
              Cross-filter direction
            </label>
            <Select
              value={crossFilter}
              onChange={(value) => setCrossFilter(value as CrossFilter)}
              options={CROSS_FILTER_OPTIONS}
            />
            <p className="text-xs text-text-quaternary leading-snug">
              {crossFilter === 'both'
                ? 'Hai chiều: filter từ fact → dim sẽ cũng lan sang dim → fact. Cẩn thận với ambiguous paths.'
                : 'Một chiều — chuẩn cho hầu hết star schema.'}
            </p>
          </div>
        </div>

        {fromView && toView && previewPairs.length > 0 && (
          <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-xs font-mono text-text-tertiary">
            <div className="mb-1">
              <span className="font-semibold uppercase text-brand">{joinType} JOIN</span>{' '}
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

        {(blockingMessage || error) && (
          <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
            {blockingMessage || error}
          </p>
        )}
      </div>
    </AppModalShell>
  );
}
