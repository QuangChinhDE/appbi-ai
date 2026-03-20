'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { Eye, Trash2, LayoutDashboard, Loader2 } from 'lucide-react';
import { Dashboard } from '@/types/api';
import { getResourcePermissions } from '@/hooks/use-resource-permission';

interface DashboardListProps {
  dashboards: Dashboard[];
  onDelete?: (id: number) => void;
  deletingId?: number;
}

export function DashboardList({ dashboards, onDelete, deletingId }: DashboardListProps) {
  const router = useRouter();

  if (dashboards.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
        <LayoutDashboard className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-900 mb-2">No dashboards yet</h3>
        <p className="text-gray-500">
          Create your first dashboard to organize your charts.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Name
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Charts
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Created
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {dashboards.map((dashboard) => (
            <tr key={dashboard.id} className="hover:bg-gray-50">
              <td className="px-6 py-4">
                <div className="text-sm font-medium text-gray-900">
                  {dashboard.name}
                </div>
                {dashboard.description && (
                  <div className="text-sm text-gray-500">{dashboard.description}</div>
                )}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {dashboard.dashboard_charts?.length || 0} charts
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {new Date(dashboard.created_at).toLocaleDateString()}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                <div className="flex justify-end space-x-2">
                  <button
                    onClick={() => router.push(`/dashboards/${dashboard.id}`)}
                    className="text-blue-600 hover:text-blue-900"
                    title="Open dashboard"
                  >
                    <Eye className="h-5 w-5" />
                  </button>
                  {onDelete && getResourcePermissions(dashboard.user_permission).canDelete && (
                  <button
                    onClick={() => onDelete(dashboard.id)}
                    disabled={deletingId === dashboard.id}
                    className="text-red-600 hover:text-red-900 disabled:opacity-50"
                    title="Delete dashboard"
                  >
                    {deletingId === dashboard.id ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <Trash2 className="h-5 w-5" />
                    )}
                  </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
