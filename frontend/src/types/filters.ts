/**
 * Filter types for dataset-based Explore
 * Re-exports from shared lib/filters.ts for backward compatibility
 */

export type {
  FilterOperator,
  FilterType,
  BaseFilter,
  DashboardFilter,
} from '@/lib/filters';

export type {
  BaseFilter as ExploreFilter,
} from '@/lib/filters';

export {
  getFilterTypeForColumn,
  getDistinctValues,
  applyFiltersToRows as applyExploreFilters,
  getDefaultOperator,
} from '@/lib/filters';
