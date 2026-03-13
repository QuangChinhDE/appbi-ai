/**
 * Dashboard Filters Hook
 * Manages dashboard filters with CRUD operations
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { DashboardFilter } from '@/components/dashboard/FilterPanel';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000/api/v1';

export function useDashboardFilters(dashboardId: number) {
  const queryClient = useQueryClient();

  const { data: filters = [], isLoading } = useQuery({
    queryKey: ['dashboard-filters', dashboardId],
    queryFn: async () => {
      const response = await fetch(`${API_BASE_URL}/dashboards/${dashboardId}/filters`);
      if (!response.ok) throw new Error('Failed to fetch filters');
      return response.json();
    },
    enabled: !!dashboardId
  });

  const createFilter = useMutation({
    mutationFn: async (filter: Omit<DashboardFilter, 'id'>) => {
      const response = await fetch(`${API_BASE_URL}/dashboards/${dashboardId}/filters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filter)
      });
      if (!response.ok) throw new Error('Failed to create filter');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard-filters', dashboardId] });
    }
  });

  const updateFilter = useMutation({
    mutationFn: async ({ filterId, updates }: { filterId: number; updates: Partial<DashboardFilter> }) => {
      const response = await fetch(`${API_BASE_URL}/dashboards/${dashboardId}/filters/${filterId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      if (!response.ok) throw new Error('Failed to update filter');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard-filters', dashboardId] });
    }
  });

  const deleteFilter = useMutation({
    mutationFn: async (filterId: number) => {
      const response = await fetch(`${API_BASE_URL}/dashboards/${dashboardId}/filters/${filterId}`, {
        method: 'DELETE'
      });
      if (!response.ok) throw new Error('Failed to delete filter');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard-filters', dashboardId] });
    }
  });

  return {
    filters,
    isLoading,
    createFilter: createFilter.mutate,
    updateFilter: updateFilter.mutate,
    deleteFilter: deleteFilter.mutate,
    isCreating: createFilter.isPending,
    isUpdating: updateFilter.isPending,
    isDeleting: deleteFilter.isPending
  };
}
