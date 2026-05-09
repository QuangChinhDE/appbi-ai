'use client';

/**
 * RelationshipDialog — Modal for adding / editing a join between two tables.
 * Opened from DataModelCanvas when the user wants to define a relationship.
 */

import React, { useState, useEffect, useRef } from 'react';
import { ArrowRight, Link2 } from 'lucide-react';
import { AppModalShell } from '@/components/common/AppModalShell';
import {
  useDatasetModelJoinSuggestion,
  type DatasetModelView,
  type AddJoinParams,
} from '@/hooks/use-dataset-model';

// ─── Types ────────────────────────────────────────────────────────────────────

export type JoinType = 'left' | 'inner' | 'right' | 'full';
export type RelationshipType =
  | 'one_to_one'
  | 'one_to_many'
  | 'many_to_one'
  | 'many_to_many';

export interface RelationshipDialogValue {
  fromViewId: number;
  toViewId: number;
  fromColumn: string;
  toColumn: string;
  joinType: JoinType;
  relationship: RelationshipType;
  alias?: string | null;
}

interface RelationshipDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (value: Omit<AddJoinParams, 'datasetId'>) => Promise<void>;
  datasetId: number;
  views: DatasetModelView[];
  /** Pre-fill when editing an existing join */
  initialValue?: Partial<RelationshipDialogValue>;
  isSaving?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

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
  { value: 'one_to_one', label: '1 : 1  —  One to One', from: '1', to: '1' },
  { value: 'one_to_many', label: '1 : N  —  One to Many', from: '1', to: 'N' },
  { value: 'many_to_one', label: 'N : 1  —  Many to One', from: 'N', to: '1' },
  { value: 'many_to_many', label: 'N : N  —  Unsupported', from: 'N', to: 'N', disabled: true },
];

// ─── Select component (native <select> wrapper) ───────────────────────────────

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
      className={`w-full px-3 py-2 text-sm border border-[rgb(var(--border-strong))] rounded-md bg-surface-1
        focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent
        disabled:bg-surface-2 disabled:text-text-quaternary ${className}`}
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function RelationshipDialog({
  isOpen,
  onClose,
  onSave,
  datasetId,
  views,
  initialValue,
  isSaving = false,
}: RelationshipDialogProps) {
  const [fromViewId, setFromViewId] = useState<number | ''>(
    initialValue?.fromViewId ?? ''
  );
  const [toViewId, setToViewId] = useState<number | ''>(
    initialValue?.toViewId ?? ''
  );
  const [fromColumn, setFromColumn] = useState(initialValue?.fromColumn ?? '');
  const [toColumn, setToColumn] = useState(initialValue?.toColumn ?? '');
  const [joinType, setJoinType] = useState<JoinType>(
    initialValue?.joinType ?? 'left'
  );
  const [relationship, setRelationship] = useState<RelationshipType>(
    initialValue?.relationship ?? 'many_to_one'
  );
  const [alias, setAlias] = useState<string>(initialValue?.alias ?? '');
  const [error, setError] = useState('');
  const [relationshipTouched, setRelationshipTouched] = useState(false);
  const [autoSuggestRelationship, setAutoSuggestRelationship] = useState(
    !initialValue?.relationship
  );
  const [previousSelectionKey, setPreviousSelectionKey] = useState('');
  const suppressSelectionResetRef = useRef(false);

  // Derived selection key (computed before hooks so it can be used in dep array)
  const selectionKey = `${fromViewId}|${toViewId}|${fromColumn}|${toColumn}`;

  // Reset when dialog reopens
  useEffect(() => {
    if (isOpen) {
      setFromViewId(initialValue?.fromViewId ?? '');
      setToViewId(initialValue?.toViewId ?? '');
      setFromColumn(initialValue?.fromColumn ?? '');
      setToColumn(initialValue?.toColumn ?? '');
      setJoinType(initialValue?.joinType ?? 'left');
      setRelationship(initialValue?.relationship ?? 'many_to_one');
      setAlias(initialValue?.alias ?? '');
      setError('');
      setRelationshipTouched(false);
      setAutoSuggestRelationship(!initialValue?.relationship);
      setPreviousSelectionKey(
        `${initialValue?.fromViewId ?? ''}|${initialValue?.toViewId ?? ''}|${initialValue?.fromColumn ?? ''}|${initialValue?.toColumn ?? ''}`
      );
      suppressSelectionResetRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

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

  const shouldSuggestRelationship = Boolean(
    isOpen
    && datasetId > 0
    && fromViewId
    && toViewId
    && fromColumn
    && toColumn
    && fromViewId !== toViewId
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
          fromColumn,
          toColumn,
        }
      : null,
  );

  useEffect(() => {
    if (!isOpen || !joinSuggestion || !autoSuggestRelationship || relationshipTouched) return;
    setRelationship(joinSuggestion.relationship);
  }, [autoSuggestRelationship, isOpen, joinSuggestion, relationshipTouched]);

  // Early return AFTER all hooks — avoids Rules of Hooks violation
  if (!isOpen) return null;

  const fromView = views.find((v) => v.id === fromViewId);
  const toView = views.find((v) => v.id === toViewId);

  // Build column lists from view dimensions (includes hidden cols like FK cols)
  const fromColumns = fromView
    ? fromView.dimensions.map((d) => ({ value: d.name, label: d.label || d.name }))
    : [];
  const toColumns = toView
    ? toView.dimensions.map((d) => ({ value: d.name, label: d.label || d.name }))
    : [];

  const viewOptions = views.map((v) => ({
    value: String(v.id),
    label: v.table_display_name || v.name,
  }));

  // Auto-suggest "id" as the to_column when target table is selected
  const handleToViewChange = (id: string) => {
    setToViewId(Number(id));
    const v = views.find((x) => x.id === Number(id));
    if (v) {
      const idCol = v.dimensions.find((d) => d.name === 'id');
      if (idCol) setToColumn('id');
    }
  };

  // Auto-suggest FK column when from view changes
  const handleFromViewChange = (id: string) => {
    setFromViewId(Number(id));
    setFromColumn('');
  };

  const handleSave = async () => {
    setError('');
    if (!fromViewId || !toViewId) {
      setError('Please select both tables.');
      return;
    }
    if (!fromColumn || !toColumn) {
      setError('Please select join columns for both tables.');
      return;
    }
    if (fromViewId === toViewId) {
      setError('Cannot join a table to itself.');
      return;
    }
    try {
      const aliasTrim = alias.trim();
      await onSave({
        fromViewId: Number(fromViewId),
        toViewId: Number(toViewId),
        fromColumn,
        toColumn,
        joinType,
        relationship,
        alias: aliasTrim || null,
      });
      onClose();
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Failed to save relationship.');
    }
  };

  const relOpt = RELATIONSHIP_OPTIONS.find((r) => r.value === relationship)!;
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

  return (
    <AppModalShell
      onClose={onClose}
      title={initialValue?.fromViewId ? 'Edit Relationship' : 'Add Relationship'}
      description="Define how two semantic views join and how their cardinality should be interpreted."
      icon={<Link2 className="h-5 w-5" />}
      maxWidthClass="max-w-[96vw]"
      panelClassName="w-[560px]"
      bodyClassName="px-6 py-5"
      closeDisabled={isSaving}
      footer={(
        <>
          <button
            onClick={onClose}
            disabled={isSaving}
            className="rounded-md border border-[rgb(var(--border-strong))] px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-2 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={
              isSaving
              || !fromViewId
              || !toViewId
              || !fromColumn
              || !toColumn
              || joinSuggestion?.can_create === false
            }
            className="flex items-center gap-2 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover transition-colors disabled:opacity-50"
          >
            {isSaving ? (
              <>
                <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                Saving…
              </>
            ) : (
              'Save Relationship'
            )}
          </button>
        </>
      )}
    >
      <div className="space-y-5">
          {/* Table selectors row */}
          <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
            {/* From table */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                From Table
              </label>
              <Select
                value={String(fromViewId)}
                onChange={handleFromViewChange}
                options={viewOptions.filter((v) => v.value !== String(toViewId))}
                placeholder="Select table…"
              />
            </div>

            {/* Arrow icon */}
            <div className="flex items-center justify-center pb-0.5">
              <div className="flex items-center gap-1 text-xs font-semibold text-brand bg-brand/10 px-2 py-1 rounded-full whitespace-nowrap">
                <span>{relOpt.from}</span>
                <ArrowRight className="w-3.5 h-3.5" />
                <span>{relOpt.to}</span>
              </div>
            </div>

            {/* To table */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                To Table
              </label>
              <Select
                value={String(toViewId)}
                onChange={handleToViewChange}
                options={viewOptions.filter((v) => v.value !== String(fromViewId))}
                placeholder="Select table…"
              />
            </div>
          </div>

          {/* Column selectors row */}
          <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
            {/* From column */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                Join Column
              </label>
              {fromColumns.length > 0 ? (
                <Select
                  value={fromColumn}
                  onChange={setFromColumn}
                  options={fromColumns}
                  placeholder="Select column…"
                />
              ) : (
                <input
                  type="text"
                  value={fromColumn}
                  onChange={(e) => setFromColumn(e.target.value)}
                  placeholder="e.g. user_id"
                  className="w-full px-3 py-2 text-sm border border-[rgb(var(--border-strong))] rounded-md bg-surface-1
                    focus:outline-none focus:ring-2 focus:ring-brand"
                />
              )}
            </div>

            {/* = sign */}
            <div className="flex items-center justify-center pb-0.5">
              <span className="text-text-quaternary font-mono text-sm">=</span>
            </div>

            {/* To column */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                Join Column
              </label>
              {toColumns.length > 0 ? (
                <Select
                  value={toColumn}
                  onChange={setToColumn}
                  options={toColumns}
                  placeholder="Select column…"
                />
              ) : (
                <input
                  type="text"
                  value={toColumn}
                  onChange={(e) => setToColumn(e.target.value)}
                  placeholder="e.g. id"
                  className="w-full px-3 py-2 text-sm border border-[rgb(var(--border-strong))] rounded-md bg-surface-1
                    focus:outline-none focus:ring-2 focus:ring-brand"
                />
              )}
            </div>
          </div>

          {/* Relationship type + Join type */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                Relationship Type
              </label>
              <Select
                value={relationship}
                onChange={(v) => {
                  setRelationship(v as RelationshipType);
                  setRelationshipTouched(true);
                  setAutoSuggestRelationship(false);
                }}
                options={RELATIONSHIP_OPTIONS.map((r) => ({
                  value: r.value,
                  label: r.label,
                  disabled: r.disabled,
                }))}
              />
              {(isSuggestingRelationship || suggestedRelationshipLabel) && (
                <p className={`text-xs ${joinSuggestion?.can_create === false ? 'text-danger' : 'text-text-quaternary'}`}>
                  {isSuggestingRelationship
                    ? 'Checking join cardinality...'
                    : `Suggested from current data: ${suggestedRelationshipLabel}${suggestedUniquenessLabel}`}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                Join Type
              </label>
              <Select
                value={joinType}
                onChange={(v) => setJoinType(v as JoinType)}
                options={JOIN_TYPE_OPTIONS}
              />
            </div>
          </div>

          {/* Optional alias for role-playing dimensions */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-secondary uppercase tracking-wide">
              Alias <span className="normal-case text-text-quaternary">(optional — for role-playing, e.g. "creator", "updater")</span>
            </label>
            <input
              type="text"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder={toView ? `Leave blank to use "${toView.name}"` : 'e.g. creator, updater'}
              className="w-full px-3 py-2 text-sm border border-[rgb(var(--border-strong))] rounded-md bg-surface-1
                focus:outline-none focus:ring-2 focus:ring-brand"
            />
            <p className="text-xs text-text-quaternary">
              Use this when the same table is joined more than once via different keys. Field references will use
              the alias (e.g. <code>creator.email</code>) instead of the table name.
            </p>
          </div>

          {/* SQL preview */}
          {fromView && toView && fromColumn && toColumn && (
            <div className="rounded-md bg-surface-2 px-3 py-2 text-xs font-mono text-text-tertiary border border-[rgb(var(--border-line))]">
              <span className="text-brand font-semibold uppercase">{joinType} JOIN</span>{' '}
              <span className="text-text-secondary">{toView.table_display_name || toView.name}</span>{' '}
              <span className="text-text-tertiary">ON</span>{' '}
              <span className="text-text-secondary">
                {fromView.table_display_name || fromView.name}.{fromColumn}
              </span>{' '}
              = <span className="text-text-secondary">
                {toView.table_display_name || toView.name}.{toColumn}
              </span>
            </div>
          )}

          {/* Error */}
          {(blockingMessage || error) && (
            <p className="text-sm text-danger bg-danger/10 rounded-md px-3 py-2">
              {blockingMessage || error}
            </p>
          )}
      </div>
    </AppModalShell>
  );
}
