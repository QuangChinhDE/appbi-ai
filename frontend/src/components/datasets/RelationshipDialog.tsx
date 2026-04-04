'use client';

/**
 * RelationshipDialog — Modal for adding / editing a join between two tables.
 * Opened from DataModelCanvas when the user wants to define a relationship.
 */

import React, { useState, useEffect } from 'react';
import { X, ArrowRight, Link2 } from 'lucide-react';
import type { DatasetModelView, AddJoinParams } from '@/hooks/use-dataset-model';

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
}

interface RelationshipDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (value: Omit<AddJoinParams, 'datasetId'>) => Promise<void>;
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
}[] = [
  { value: 'one_to_one', label: '1 : 1  —  One to One', from: '1', to: '1' },
  { value: 'one_to_many', label: '1 : N  —  One to Many', from: '1', to: 'N' },
  { value: 'many_to_one', label: 'N : 1  —  Many to One', from: 'N', to: '1' },
  { value: 'many_to_many', label: 'N : N  —  Many to Many', from: 'N', to: 'N' },
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
  options: { value: string; label: string }[];
  placeholder?: string;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full px-3 py-2 text-sm border border-gray-300 rounded-md bg-white
        focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
        disabled:bg-gray-50 disabled:text-gray-400 ${className}`}
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
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
  const [error, setError] = useState('');

  // Reset when dialog reopens
  useEffect(() => {
    if (isOpen) {
      setFromViewId(initialValue?.fromViewId ?? '');
      setToViewId(initialValue?.toViewId ?? '');
      setFromColumn(initialValue?.fromColumn ?? '');
      setToColumn(initialValue?.toColumn ?? '');
      setJoinType(initialValue?.joinType ?? 'left');
      setRelationship(initialValue?.relationship ?? 'many_to_one');
      setError('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

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
      await onSave({
        fromViewId: Number(fromViewId),
        toViewId: Number(toViewId),
        fromColumn,
        toColumn,
        joinType,
        relationship,
      });
      onClose();
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Failed to save relationship.');
    }
  };

  const relOpt = RELATIONSHIP_OPTIONS.find((r) => r.value === relationship)!;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-xl shadow-2xl w-[560px] max-w-[96vw] mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-blue-600" />
            <h2 className="text-base font-semibold text-gray-900">
              {initialValue?.fromViewId ? 'Edit Relationship' : 'Add Relationship'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          {/* Table selectors row */}
          <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
            {/* From table */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-gray-600 uppercase tracking-wide">
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
              <div className="flex items-center gap-1 text-xs font-semibold text-blue-600 bg-blue-50 px-2 py-1 rounded-full whitespace-nowrap">
                <span>{relOpt.from}</span>
                <ArrowRight className="w-3.5 h-3.5" />
                <span>{relOpt.to}</span>
              </div>
            </div>

            {/* To table */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-gray-600 uppercase tracking-wide">
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
              <label className="text-xs font-medium text-gray-600 uppercase tracking-wide">
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
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md
                    focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              )}
            </div>

            {/* = sign */}
            <div className="flex items-center justify-center pb-0.5">
              <span className="text-gray-400 font-mono text-sm">=</span>
            </div>

            {/* To column */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-gray-600 uppercase tracking-wide">
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
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md
                    focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              )}
            </div>
          </div>

          {/* Relationship type + Join type */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-gray-600 uppercase tracking-wide">
                Relationship Type
              </label>
              <Select
                value={relationship}
                onChange={(v) => setRelationship(v as RelationshipType)}
                options={RELATIONSHIP_OPTIONS.map((r) => ({
                  value: r.value,
                  label: r.label,
                }))}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-gray-600 uppercase tracking-wide">
                Join Type
              </label>
              <Select
                value={joinType}
                onChange={(v) => setJoinType(v as JoinType)}
                options={JOIN_TYPE_OPTIONS}
              />
            </div>
          </div>

          {/* SQL preview */}
          {fromView && toView && fromColumn && toColumn && (
            <div className="rounded-md bg-gray-50 px-3 py-2 text-xs font-mono text-gray-500 border border-gray-200">
              <span className="text-blue-600 font-semibold uppercase">{joinType} JOIN</span>{' '}
              <span className="text-gray-700">{toView.table_display_name || toView.name}</span>{' '}
              <span className="text-gray-500">ON</span>{' '}
              <span className="text-gray-700">
                {fromView.table_display_name || fromView.name}.{fromColumn}
              </span>{' '}
              = <span className="text-gray-700">
                {toView.table_display_name || toView.name}.{toColumn}
              </span>
            </div>
          )}

          {/* Error */}
          {error && (
            <p className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t bg-gray-50 rounded-b-xl">
          <button
            onClick={onClose}
            disabled={isSaving}
            className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300
              rounded-md hover:bg-gray-100 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || !fromViewId || !toViewId || !fromColumn || !toColumn}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md
              hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isSaving ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Saving…
              </>
            ) : (
              'Save Relationship'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
