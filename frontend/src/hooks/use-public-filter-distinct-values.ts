'use client';

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { publicDashboardApi } from '@/lib/api/public';
import {
  getColumnKey,
  getDistinctValueFilterContext,
  getFilterKey,
  type BaseFilter,
  type ColumnInfo,
} from '@/lib/filters';

export function usePublicFilterDistinctValues(
  token: string,
  sessionToken: string | undefined,
  columns: ColumnInfo[],
  filters: BaseFilter[],
  fallbackDistinctValues: Record<string, string[]>,
) {
  const activeSemanticDistinctTargets = useMemo(() => {
    if (!token || columns.length === 0 || filters.length === 0) {
      return [];
    }

    const columnsByKey = new Map(
      columns.map((column) => [getColumnKey(column), column]),
    );
    const activeColumns = new Map<string, ColumnInfo>();

    for (const filter of filters) {
      const key = getFilterKey(filter);
      const column = columnsByKey.get(key);
      if (!column?.datasetId || !column.semanticField) continue;
      // Parity with the editor: categorical columns always, plus
      // numeric/date columns used as a multi-select slicer
      // ('in'/'not_in' → value checklist). Otherwise a numeric dim like
      // `year` shows an empty checklist though the BE has the values.
      const isCategorical = column.type === 'dropdown' || column.type === 'text';
      const isListMode = filter.operator === 'in' || filter.operator === 'not_in';
      if (!isCategorical && !isListMode) continue;
      activeColumns.set(key, column);
    }

    return Array.from(activeColumns.values()).map((column) => {
      const filterContext = getDistinctValueFilterContext(filters, column);
      return {
        column,
        filterContext,
        filterContextKey: JSON.stringify(filterContext),
      };
    });
  }, [columns, filters, token]);

  const semanticDistinctQueries = useQueries({
    queries: activeSemanticDistinctTargets.map(({ column, filterContext, filterContextKey }) => ({
      queryKey: ['public-filter-distinct', token, column.datasetId, column.semanticField, sessionToken ?? 'anon', filterContextKey],
      queryFn: () => publicDashboardApi.getFilterDistinctValues(
        token,
        column.datasetId!,
        column.semanticField!,
        sessionToken,
        200,
        filterContext,
      ),
      enabled: Boolean(token && column.datasetId && column.semanticField),
      staleTime: 5 * 60 * 1000,
    })),
  });

  return useMemo(() => {
    const mergedValues: Record<string, string[]> = { ...fallbackDistinctValues };

    activeSemanticDistinctTargets.forEach(({ column }, index) => {
      const values = semanticDistinctQueries[index]?.data?.values;
      if (values) {
        mergedValues[getColumnKey(column)] = values;
      }
    });

    return mergedValues;
  }, [activeSemanticDistinctTargets, fallbackDistinctValues, semanticDistinctQueries]);
}
