/**
 * Tile instance parameters → filters. ONE implementation for the Builder tile,
 * the chart detail modal and (through its backend twin
 * `backend/app/services/dashboard_parameters.py:instance_parameter_filters`)
 * every public surface. A chart declares parameters (name + column mapping);
 * each tile stores the values its author chose. Both halves run the same
 * vectors: backend/tests/fixtures/instance_parameter_vectors.json
 * (scripts/check-dashboard-parameter-parity.mjs + test_dashboard_parameter_parity.py).
 *
 * Pure, no imports — the contract script executes this file as is.
 */

export interface InstanceParameterDef {
  parameter_name: string;
  parameter_type?: string | null;
  column_mapping?: { column?: string | null; type?: string | null } | null;
}

export interface InstanceParameterFilter {
  field: string;
  operator: 'eq' | 'in' | 'between';
  value: unknown;
}

export const NUMERIC_MAPPING_TYPES = new Set(['number', 'integer', 'float', 'double', 'decimal', 'numeric', 'bigint', 'int']);
export const DATE_MAPPING_TYPES = new Set(['date', 'datetime', 'timestamp', 'time']);

export function resolveParameterMappingType(param: {
  parameter_type?: string | null;
  column_mapping?: { type?: string | null } | null;
}): string {
  const mappingType = (param.column_mapping?.type ?? '').toLowerCase();
  if (mappingType && mappingType !== 'string') return mappingType;

  const parameterType = (param.parameter_type ?? '').toLowerCase();
  if (parameterType === 'time_range') return 'date';
  if (parameterType === 'measure') return 'number';
  return mappingType || 'string';
}

export function coerceParameterAtom(rawValue: unknown, mappingType: string): unknown {
  if (rawValue === undefined || rawValue === null) return rawValue;
  if (NUMERIC_MAPPING_TYPES.has(mappingType)) {
    const num = typeof rawValue === 'number' ? rawValue : Number(String(rawValue).trim());
    return Number.isFinite(num) ? num : String(rawValue).trim();
  }
  return typeof rawValue === 'string' ? rawValue.trim() : rawValue;
}

export function buildInstanceParameterFilters(
  chartParameters: InstanceParameterDef[] | null | undefined,
  instanceParameters: Record<string, unknown> | null | undefined,
): InstanceParameterFilter[] {
  if (!chartParameters?.length || !instanceParameters) return [];

  const filters: InstanceParameterFilter[] = [];
  for (const param of chartParameters) {
    const mappedColumn = param.column_mapping?.column;
    const rawValue = instanceParameters[param.parameter_name];
    if (!mappedColumn || rawValue === undefined || rawValue === null) continue;

    const mappingType = resolveParameterMappingType(param);
    const isDateType = DATE_MAPPING_TYPES.has(mappingType);
    const textValue = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (typeof rawValue === 'string' && !textValue) continue;

    const isRangeValue = typeof rawValue === 'string'
      && (textValue.includes('..') || (isDateType && textValue.includes(',')));
    if (isRangeValue) {
      const parts = (textValue.includes('..') ? textValue.split('..') : textValue.split(','))
        .map((part) => part.trim())
        .filter(Boolean);
      if (parts.length > 0) {
        filters.push({
          field: mappedColumn,
          operator: 'between',
          value: [
            parts[0] ? coerceParameterAtom(parts[0], mappingType) : null,
            parts[1] ? coerceParameterAtom(parts[1], mappingType) : null,
          ],
        });
        continue;
      }
    }

    if (Array.isArray(rawValue) || (typeof rawValue === 'string' && textValue.includes(','))) {
      const values = (Array.isArray(rawValue) ? rawValue : textValue.split(','))
        .map((part) => String(part).trim())
        .filter(Boolean)
        .map((part) => coerceParameterAtom(part, mappingType));
      if (values.length > 0) {
        filters.push({ field: mappedColumn, operator: 'in', value: values });
        continue;
      }
    }

    filters.push({ field: mappedColumn, operator: 'eq', value: coerceParameterAtom(rawValue, mappingType) });
  }
  return filters;
}
