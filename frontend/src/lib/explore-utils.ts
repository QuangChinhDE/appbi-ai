/**
 * Client-side row filtering for chart tiles.
 */

export interface Filter {
  field: string;
  operator: string; // see FilterBuilder OPERATORS_BY_TYPE
  value: any;
}

export function applyFilters(rows: Record<string, any>[], filters: Filter[]): Record<string, any>[] {
  if (filters.length === 0) return rows;

  return rows.filter(row => {
    return filters.every(filter => {
      const fieldValue = row[filter.field];
      const op = filter.operator;

      // ── Multi-value operators (type-agnostic) ─────────────────────────────
      if (op === 'in' || op === 'notIn' || op === 'not_in') {
        // Value can be array (new) or comma-separated string (legacy)
        let list: any[];
        if (Array.isArray(filter.value)) {
          list = filter.value;
        } else if (typeof filter.value === 'string' && filter.value.includes(',')) {
          list = filter.value.split(',').map(v => v.trim());
        } else {
          list = filter.value ? [filter.value] : [];
        }
        if (list.length === 0) return true; // empty selection = no filter
        const inList = list.map(String).includes(String(fieldValue));
        return op === 'in' ? inList : !inList;
      }

      // ── Between ───────────────────────────────────────────────────────────
      if (op === 'between') {
        const [lo, hi] = Array.isArray(filter.value) ? filter.value : [null, null];
        const strVal = String(fieldValue ?? '').slice(0, 10);
        // Try numeric first
        const numVal = Number(fieldValue);
        const isNumeric = !isNaN(numVal) && fieldValue !== '' && fieldValue !== null;
        if (isNumeric) {
          if (lo !== '' && lo !== null && lo !== undefined && numVal < Number(lo)) return false;
          if (hi !== '' && hi !== null && hi !== undefined && numVal > Number(hi)) return false;
        } else {
          // Date comparison (YYYY-MM-DD prefix)
          if (lo && strVal < String(lo).slice(0, 10)) return false;
          if (hi && strVal > String(hi).slice(0, 10)) return false;
        }
        return true;
      }

      // ── Null checks ───────────────────────────────────────────────────────
      if (op === 'is_null')     return fieldValue === null || fieldValue === undefined;
      if (op === 'is_not_null') return fieldValue !== null && fieldValue !== undefined;

      // ── Date comparisons ──────────────────────────────────────────────────
      // Normalise both sides to YYYY-MM-DD for robust date comparison
      const strFieldVal = String(fieldValue ?? '').slice(0, 10);
      const strFilterVal = String(filter.value ?? '').slice(0, 10);
      const isDateLike = /^\d{4}-\d{2}-\d{2}/.test(strFieldVal);

      if (isDateLike && ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(op)) {
        switch (op) {
          case 'eq':  return strFieldVal === strFilterVal;
          case 'neq': return strFieldVal !== strFilterVal;
          case 'gt':  return strFieldVal >  strFilterVal;
          case 'gte': return strFieldVal >= strFilterVal;
          case 'lt':  return strFieldVal <  strFilterVal;
          case 'lte': return strFieldVal <= strFilterVal;
        }
      }

      // ── Generic comparisons ───────────────────────────────────────────────
      switch (op) {
        case 'eq':
          // eslint-disable-next-line eqeqeq
          return fieldValue == filter.value;
        case 'neq':
          // eslint-disable-next-line eqeqeq
          return fieldValue != filter.value;
        case 'gt':
          return fieldValue > filter.value;
        case 'lt':
          return fieldValue < filter.value;
        case 'gte':
          return fieldValue >= filter.value;
        case 'lte':
          return fieldValue <= filter.value;
        case 'contains':
        case 'notContains': // legacy alias
          if (fieldValue === null || fieldValue === undefined) return false;
          const has = String(fieldValue).toLowerCase().includes(String(filter.value ?? '').toLowerCase());
          return op === 'contains' ? has : !has;
        case 'not_contains':
          if (fieldValue === null || fieldValue === undefined) return op === 'not_contains';
          return !String(fieldValue).toLowerCase().includes(String(filter.value ?? '').toLowerCase());
        case 'starts_with':
          if (fieldValue === null || fieldValue === undefined) return false;
          return String(fieldValue).toLowerCase().startsWith(String(filter.value ?? '').toLowerCase());
        default:
          return true;
      }
    });
  });
}
