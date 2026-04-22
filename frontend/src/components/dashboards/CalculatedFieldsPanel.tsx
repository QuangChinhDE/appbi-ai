/**
 * CalculatedFieldsPanel â€” Excel-style calculated fields editor for the HTML
 * import wizard. Delegates the add/edit experience to the shared
 * `AddColumnModal` component so users get the exact same UX as when they
 * build calculated columns inside a Dataset (column chips, function picker,
 * live preview).
 *
 * The stored expression uses Excel-style ``[Column Name]`` references. The
 * backend ``TransformationCompiler`` understands this syntax and quotes each
 * reference as a proper DuckDB / BigQuery identifier at compile time.
 */
'use client';

import React, { useMemo, useState } from 'react';
import { AlertTriangle, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { AddColumnModal } from '@/components/datasets/AddColumnModal';
import type { DatasetTable, Transformation } from '@/hooks/use-datasets';
import type { DashboardHtmlImportCalculatedField } from '@/types/dashboard-html-import';

interface CalculatedFieldsPanelProps {
  fields: DashboardHtmlImportCalculatedField[];
  onChange: (fields: DashboardHtmlImportCalculatedField[]) => void;
  availableColumns: Array<{ name: string; type?: string }>;
  /** Sample rows used by the live formula preview inside AddColumnModal. */
  previewRows?: Array<Record<string, any>>;
  /** Optional list of source_keys for multi-sheet imports. */
  sourceKeys?: string[];
  /** Per-field validation errors reported by backend preview/validate. */
  fieldErrors?: Record<string, string>;
  title?: string;
  subtitle?: string;
  /** Active source_key (multi-sheet uploads); used as the default for new fields. */
  defaultSourceKey?: string | null;
}

const FAKE_TABLE_BASE: Pick<DatasetTable,
  'id' | 'dataset_id' | 'source_kind' | 'enabled' | 'created_at' | 'updated_at'
> = {
  id: 0,
  dataset_id: 0,
  source_kind: 'physical_table',
  enabled: true,
  created_at: '',
  updated_at: '',
};

/**
 * Wrap bare identifier tokens that match known column names with [] brackets
 * so they show up as chips inside AddColumnModal. Quoted strings and already
 * bracketed references are preserved.
 */
function wrapBareIdentifiers(expression: string, columns: string[]): string {
  if (!expression) return '';
  if (columns.length === 0) return expression;

  // Preserve anything already inside [...] or quoted strings.
  const placeholders: string[] = [];
  const masked = expression
    .replace(/\[[^\]]+\]/g, (match) => {
      placeholders.push(match);
      return `\u0000${placeholders.length - 1}\u0000`;
    })
    .replace(/"[^"]*"|'[^']*'/g, (match) => {
      placeholders.push(match);
      return `\u0000${placeholders.length - 1}\u0000`;
    });

  const sorted = [...columns].sort((a, b) => b.length - a.length);
  let working = masked;
  for (const col of sorted) {
    // Only safe to \b-match when column is a "simple" identifier.
    if (!/^[A-Za-z_][\w]*$/.test(col)) continue;
    const escaped = col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    working = working.replace(new RegExp(`\\b${escaped}\\b`, 'g'), `[${col}]`);
  }
  return working.replace(/\u0000(\d+)\u0000/g, (_, index) => placeholders[Number(index)] ?? '');
}

export function CalculatedFieldsPanel({
  fields,
  onChange,
  availableColumns,
  previewRows = [],
  sourceKeys,
  fieldErrors,
  title = 'Calculated Fields',
  subtitle = 'Excel-style formulas with [Column] references. IF / ROUND / ABS / COALESCE / NULLIF supported.',
  defaultSourceKey,
}: CalculatedFieldsPanelProps) {
  // editingIndex: -1 = adding new, >=0 = editing existing, null = closed
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const columnNames = useMemo(() => availableColumns.map((c) => c.name), [availableColumns]);
  const sortedSourceKeys = useMemo(() => {
    if (!sourceKeys || sourceKeys.length === 0) return [] as string[];
    return [...sourceKeys].sort();
  }, [sourceKeys]);

  const fakeTransformations = useMemo<Transformation[]>(() => {
    return fields.map((field, index) => ({
      id: `cf-${index}`,
      type: 'js_formula',
      enabled: true,
      params: {
        newField: field.name,
        formula: wrapBareIdentifiers(field.expression, columnNames),
      },
    }));
  }, [fields, columnNames]);

  const editingTransformation = useMemo<Transformation | null>(() => {
    if (editingIndex == null || editingIndex < 0) return null;
    return fakeTransformations[editingIndex] ?? null;
  }, [editingIndex, fakeTransformations]);

  const fakeTable = useMemo<DatasetTable>(() => ({
    ...FAKE_TABLE_BASE,
    display_name: 'Imported source',
    transformations: fakeTransformations,
  }), [fakeTransformations]);

  const closeModal = () => setEditingIndex(null);

  /**
   * AddColumnModal writes back the full transformations list. Extract the
   * newly-added or edited js_formula step and fold it back into our
   * ``calculated_fields`` schema.
   */
  const handleModalSave = async (nextTransformations: Transformation[]) => {
    const formulaSteps = nextTransformations.filter((step) => step.type === 'js_formula');

    if (editingIndex == null || editingIndex < 0) {
      // ADD: use the last js_formula step (AddColumnModal appends new steps)
      const appended = formulaSteps[formulaSteps.length - 1];
      if (!appended) return;
      const nextFields: DashboardHtmlImportCalculatedField[] = [
        ...fields,
        {
          name: String(appended.params?.newField || '').trim(),
          expression: String(appended.params?.formula || '').trim(),
          label: String(appended.params?.newField || '').trim(),
          source_key: defaultSourceKey || null,
        },
      ];
      onChange(nextFields);
    } else {
      // EDIT: find the edited step by id, preserve surrounding metadata
      const editingId = fakeTransformations[editingIndex]?.id;
      const editedStep = editingId
        ? formulaSteps.find((step) => step.id === editingId)
        : formulaSteps[editingIndex];
      if (!editedStep) return;
      const nextFields = fields.map((field, index) => {
        if (index !== editingIndex) return field;
        return {
          ...field,
          expression: String(editedStep.params?.formula || '').trim(),
          // Name is locked in edit mode (AddColumnModal hides the name input)
        };
      });
      onChange(nextFields);
    }
  };

  const remove = (index: number) => {
    const next = fields.filter((_, i) => i !== index);
    onChange(next);
  };

  return (
    <div className="rounded-xl border border-brand/20 bg-gradient-to-br from-brand/5 to-surface-1 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Sparkles className="h-4 w-4 text-brand" /> {title}
          </p>
          <p className="mt-1 text-caption text-text-secondary">{subtitle}</p>
        </div>
        <Button
          variant="secondary"
          size="xs"
          leadingIcon={<Plus className="h-3 w-3" />}
          onClick={() => setEditingIndex(-1)}
        >
          New field
        </Button>
      </div>

      {fields.length > 0 && (
        <div className="mt-3 space-y-2">
          {fields.map((field, index) => {
            const error = fieldErrors?.[field.name];
            return (
              <div
                key={`${field.name}-${index}`}
                className={`rounded-lg border px-3 py-2 ${
                  error ? 'border-danger/40 bg-danger/5' : 'border-brand/20 bg-surface-1'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-text-primary truncate">
                      {field.label || field.name}
                    </p>
                    <p className="text-caption font-mono text-text-tertiary mt-0.5 truncate">
                      {field.name} = {wrapBareIdentifiers(field.expression, columnNames)}
                    </p>
                    {field.source_key && sortedSourceKeys.length > 1 && (
                      <p className="text-caption text-brand/80 mt-0.5">Source: {field.source_key}</p>
                    )}
                    {error && (
                      <p className="mt-1 flex items-start gap-1 text-caption text-danger">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        <span className="font-mono break-all">{error}</span>
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="xs"
                      leadingIcon={<Pencil className="h-3 w-3" />}
                      onClick={() => setEditingIndex(index)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      leadingIcon={<Trash2 className="h-3 w-3" />}
                      onClick={() => remove(index)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editingIndex != null && (
        <AddColumnModal
          table={fakeTable}
          allColumns={columnNames}
          previewRows={previewRows}
          isOpen
          onClose={closeModal}
          onSave={handleModalSave}
          editingStep={editingTransformation}
        />
      )}
    </div>
  );
}
