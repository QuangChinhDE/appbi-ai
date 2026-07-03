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
  // PBI-parity: filters that must CASCADE into the slicer values but are NOT
  // themselves rendered as interactive controls — e.g. a public "Filters on
  // this page" entry (pageHiddenFilters). The page filter constrains the whole
  // page, so a slicer's offered values must already be narrowed by it. These
  // join the cascade context only; they never become distinct-fetch targets,
  // so a hidden page-filter field doesn't spawn a spurious dropdown request.
  // getDistinctValueFilterContext still self-strips, so a slicer that shares a
  // field with the page filter won't pin its own list.
  extraContextFilters: BaseFilter[] = [],
) {
  const activeSemanticDistinctTargets = useMemo(() => {
    if (!token || columns.length === 0 || filters.length === 0) {
      return [];
    }
    const contextFilters = extraContextFilters.length > 0
      ? [...filters, ...extraContextFilters]
      : filters;

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
      const filterContext = getDistinctValueFilterContext(contextFilters, column);
      return {
        column,
        filterContext,
        filterContextKey: JSON.stringify(filterContext),
      };
    });
  }, [columns, filters, extraContextFilters, token]);

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
    // Per-column query status so the slicer dropdown can tell "still fetching"
    // from "fetched and got []" — parity with the authed dashboard page
    // (semanticDistinctStatus). WITHOUT this the public path passed no status,
    // so the FilterCard's `!isLoading` guard was vacuously true and the amber
    // "No values match — Try relaxing…" banner showed WHILE the distinct query
    // was still in flight, then values appeared ("vàng xong lại ra data").
    // isLoading deliberately includes isFetching so a REFETCH (after Apply or a
    // cascade-filter change) also suppresses the banner, not just the first load.
    const status: Record<string, { isLoading: boolean; isError: boolean; hasFilterContext: boolean }> = {};

    activeSemanticDistinctTargets.forEach(({ column, filterContext }, index) => {
      const q = semanticDistinctQueries[index];
      const values = q?.data?.values;
      if (values) {
        mergedValues[getColumnKey(column)] = values;
      }
      status[getColumnKey(column)] = {
        isLoading: Boolean(q?.isLoading || q?.isFetching),
        isError: Boolean(q?.isError),
        hasFilterContext: Array.isArray(filterContext) && filterContext.length > 0,
      };
    });

    // Bound each slicer's option list by any HARD page/dashboard scope on the
    // SAME field (extraContextFilters = "Filters on this page" etc.). The BE
    // distinct self-strips the dropdown's own field — which also drops the page
    // scope — so the raw list comes back UNbounded (it offered out-of-scope
    // products like "Tablet" on a page scoped to [Laptop,Charger,Headphones]).
    // Intersect client-side so the viewer can only ever pick IN-scope values —
    // the dropdown mirror of applyScopeBound on the data layer (no escape).
    for (const scope of extraContextFilters) {
      if (scope.operator !== 'in' || !Array.isArray(scope.value)) continue;
      const key = getFilterKey(scope);
      const current = mergedValues[key];
      if (!current) continue;
      const allow = new Set(scope.value.map((v) => String(v)));
      mergedValues[key] = current.filter((v) => allow.has(String(v)));
    }

    return { values: mergedValues, status };
  }, [activeSemanticDistinctTargets, fallbackDistinctValues, semanticDistinctQueries, extraContextFilters]);
}
