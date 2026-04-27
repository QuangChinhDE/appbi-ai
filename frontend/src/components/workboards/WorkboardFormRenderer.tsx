'use client';

import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { FieldGroup, Input, Textarea } from '@/components/ui/Input';
import type { WorkboardFormField, WorkboardFormSpec } from '@/lib/api/workboards';

interface Props {
  form: WorkboardFormSpec;
  submitLabel?: string;
  initialValues?: Record<string, unknown> | null;
  submitting?: boolean;
  error?: string | null;
  title?: string | null;
  onSubmit: (values: Record<string, unknown>) => Promise<void> | void;
  onCancel?: () => void;
}

function toInputValue(field: WorkboardFormField, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (field.widget === 'date') {
    return String(value).slice(0, 10);
  }
  if (field.widget === 'datetime') {
    const text = String(value);
    return text.includes('T') ? text.slice(0, 16) : text;
  }
  return String(value);
}

function toSubmitValue(field: WorkboardFormField, value: unknown): unknown {
  if (field.widget === 'checkbox') {
    return Boolean(value);
  }
  if (value === '' || value === null || value === undefined) {
    return null;
  }
  if (field.widget === 'number') {
    const num = Number(value);
    return Number.isFinite(num) ? num : value;
  }
  return value;
}

export function WorkboardFormRenderer({
  form,
  submitLabel,
  initialValues,
  submitting = false,
  error,
  title,
  onSubmit,
  onCancel,
}: Props) {
  const [values, setValues] = useState<Record<string, unknown>>({});

  const fields = useMemo(() => form.fields ?? [], [form.fields]);

  useEffect(() => {
    const nextValues: Record<string, unknown> = {};
    fields.forEach((field) => {
      const explicit = initialValues?.[field.column];
      if (explicit !== undefined) {
        nextValues[field.column] = explicit;
        return;
      }
      if (field.default !== undefined) {
        nextValues[field.column] = field.default;
        return;
      }
      nextValues[field.column] = field.widget === 'checkbox' ? false : '';
    });
    setValues(nextValues);
  }, [fields, initialValues]);

  const requiredMissing = useMemo(() => {
    return fields.some((field) => {
      if (!field.required) return false;
      const value = values[field.column];
      if (field.widget === 'checkbox') return false;
      return value === '' || value === null || value === undefined;
    });
  }, [fields, values]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload: Record<string, unknown> = {};
    fields.forEach((field) => {
      const currentValue = values[field.column];
      if (field.readonly && (currentValue === '' || currentValue === null || currentValue === undefined)) {
        return;
      }
      payload[field.column] = toSubmitValue(field, currentValue);
    });
    await onSubmit(payload);
  };

  const lookupOptions = form.lookups ?? {};

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-5"
    >
      {title ? (
        <div>
          <h2 className="text-body font-emphasis text-text-primary">{title}</h2>
        </div>
      ) : null}

      {fields.map((field) => {
        const value = values[field.column];
        const inputValue = toInputValue(field, value);
        const commonLabel = field.label || field.column;
        const options = lookupOptions[field.column] ?? field.lookup?.values ?? [];

        return (
          <FieldGroup
            key={field.column}
            label={commonLabel}
            required={field.required}
            description={field.help_text || undefined}
          >
            {field.widget === 'textarea' ? (
              <Textarea
                value={inputValue}
                onChange={(event) => setValues((current) => ({ ...current, [field.column]: event.target.value }))}
                placeholder={field.placeholder}
                rows={4}
                disabled={field.readonly || submitting}
              />
            ) : field.widget === 'select' || field.widget === 'lookup' ? (
              <select
                className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-body"
                value={inputValue}
                onChange={(event) => setValues((current) => ({ ...current, [field.column]: event.target.value }))}
                disabled={field.readonly || submitting}
              >
                <option value="">-- Select --</option>
                {options.map((option, index) => (
                  <option key={`${field.column}-${index}`} value={String(option.value ?? '')}>
                    {String(option.label ?? option.value ?? '')}
                  </option>
                ))}
              </select>
            ) : field.widget === 'checkbox' ? (
              <label className="inline-flex items-center gap-2 text-caption text-text-primary">
                <input
                  type="checkbox"
                  checked={Boolean(value)}
                  onChange={(event) => setValues((current) => ({ ...current, [field.column]: event.target.checked }))}
                  disabled={field.readonly || submitting}
                />
                <span>{field.placeholder || 'Enabled'}</span>
              </label>
            ) : (
              <Input
                type={
                  field.widget === 'number'
                    ? 'number'
                    : field.widget === 'date'
                      ? 'date'
                      : field.widget === 'datetime'
                        ? 'datetime-local'
                        : 'text'
                }
                value={inputValue}
                onChange={(event) => setValues((current) => ({ ...current, [field.column]: event.target.value }))}
                placeholder={field.placeholder}
                disabled={field.readonly || submitting}
              />
            )}
          </FieldGroup>
        );
      })}

      {error ? (
        <div className="rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-caption text-red-600">
          {error}
        </div>
      ) : null}

      <div className="flex justify-end gap-2 pt-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" variant="primary" disabled={submitting || requiredMissing}>
          {submitLabel || form.submit_label || 'Save'}
        </Button>
      </div>
    </form>
  );
}

export default WorkboardFormRenderer;
