/**
 * Data Source List Component
 * Displays table of data sources with actions
 */
'use client';

import { DataSource } from '@/types/api';
import { Database, Edit, Trash2, TestTube } from 'lucide-react';

interface DataSourceListProps {
  dataSources: DataSource[];
  onEdit: (dataSource: DataSource) => void;
  onDelete: (id: number) => void;
  onTest: (dataSource: DataSource) => void;
  isDeleting?: number | null;
}

export default function DataSourceList({
  dataSources,
  onEdit,
  onDelete,
  onTest,
  isDeleting,
}: DataSourceListProps) {
  if (dataSources.length === 0) {
    return (
      <div className="text-center py-12">
        <Database className="w-16 h-16 text-gray-300 mx-auto mb-4" />
        <p className="text-gray-500 text-lg mb-2">No data sources yet</p>
        <p className="text-gray-400 text-sm">Create your first data source to get started</p>
      </div>
    );
  }

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'postgresql':
        return 'bg-blue-100 text-blue-800';
      case 'mysql':
        return 'bg-orange-100 text-orange-800';
      case 'bigquery':
        return 'bg-green-100 text-green-800';
      case 'google_sheets':
        return 'bg-emerald-100 text-emerald-800';
      case 'manual':
        return 'bg-purple-100 text-purple-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'postgresql':
        return 'PostgreSQL';
      case 'mysql':
        return 'MySQL';
      case 'bigquery':
        return 'BigQuery';
      case 'google_sheets':
        return 'Google Sheets';
      case 'manual':
        return 'Manual Table';
      default:
        return type;
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Name
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Type
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Description
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
          {dataSources.map((ds) => (
            <tr key={ds.id} className="hover:bg-gray-50">
              <td className="px-6 py-4 whitespace-nowrap">
                <div className="flex items-center">
                  <Database className="w-5 h-5 text-gray-400 mr-3" />
                  <div className="text-sm font-medium text-gray-900">{ds.name}</div>
                </div>
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                <span
                  className={`px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${getTypeColor(
                    ds.type
                  )}`}
                >
                  {getTypeLabel(ds.type)}
                </span>
              </td>
              <td className="px-6 py-4">
                <div className="text-sm text-gray-500 max-w-xs truncate">
                  {ds.description || '—'}
                </div>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {new Date(ds.created_at).toLocaleDateString()}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => onTest(ds)}
                    className="text-green-600 hover:text-green-900 p-1 rounded hover:bg-green-50"
                    title="Test connection"
                  >
                    <TestTube className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => onEdit(ds)}
                    className="text-blue-600 hover:text-blue-900 p-1 rounded hover:bg-blue-50"
                    title="Edit"
                  >
                    <Edit className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => onDelete(ds.id)}
                    disabled={isDeleting === ds.id}
                    className="text-red-600 hover:text-red-900 p-1 rounded hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
