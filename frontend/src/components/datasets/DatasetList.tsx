/**
 * Dataset List Component
 * Displays table of datasets with actions
 */
'use client';

import { Dataset } from '@/types/api';
import { FileText, Edit, Trash2, Play, RefreshCw, CheckCircle2, XCircle, Loader2 } from 'lucide-react';

function SyncBadge({ syncConfig, materialization }: { syncConfig?: Dataset['sync_config']; materialization?: Dataset['materialization'] }) {
  const mode = materialization?.mode;
  if (mode === 'parquet') {
    const scheduleEnabled = syncConfig?.schedule?.enabled;
    return (
      <span className="px-2 py-0.5 inline-flex items-center gap-1 text-xs rounded-full bg-emerald-100 text-emerald-700">
        <RefreshCw className="w-3 h-3" />
        {scheduleEnabled ? 'Auto sync' : 'Manual sync'}
      </span>
    );
  }
  if (mode === 'view' || mode === 'table') {
    return (
      <span className="px-2 py-0.5 inline-flex text-xs rounded-full bg-purple-100 text-purple-700">
        {mode}
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 inline-flex text-xs rounded-full bg-gray-100 text-gray-500">
      live
    </span>
  );
}

interface DatasetListProps {
  datasets: Dataset[];
  dataSources: Array<{ id: number; name: string }>;
  onEdit: (dataset: Dataset) => void;
  onDelete: (id: number) => void;
  onExecute: (dataset: Dataset) => void;
  isDeleting?: number | null;
}

export default function DatasetList({
  datasets,
  dataSources,
  onEdit,
  onDelete,
  onExecute,
  isDeleting,
}: DatasetListProps) {
  const getDataSourceName = (dataSourceId: number) => {
    const ds = dataSources.find((d) => d.id === dataSourceId);
    return ds?.name || `ID: ${dataSourceId}`;
  };

  if (datasets.length === 0) {
    return (
      <div className="text-center py-12">
        <FileText className="w-16 h-16 text-gray-300 mx-auto mb-4" />
        <p className="text-gray-500 text-lg mb-2">No datasets yet</p>
        <p className="text-gray-400 text-sm">Create your first dataset to get started</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Name
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Data Source
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Description
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Storage
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
          {datasets.map((dataset) => (
            <tr key={dataset.id} className="hover:bg-gray-50">
              <td className="px-6 py-4 whitespace-nowrap">
                <div className="flex items-center">
                  <FileText className="w-5 h-5 text-gray-400 mr-3" />
                  <div className="text-sm font-medium text-gray-900">{dataset.name}</div>
                </div>
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                <span className="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 text-blue-800">
                  {getDataSourceName(dataset.data_source_id)}
                </span>
              </td>
              <td className="px-6 py-4">
                <div className="text-sm text-gray-500 max-w-xs truncate">
                  {dataset.description || '—'}
                </div>
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                <SyncBadge syncConfig={dataset.sync_config} materialization={dataset.materialization} />
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {new Date(dataset.created_at).toLocaleDateString()}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => onExecute(dataset)}
                    className="text-green-600 hover:text-green-900 p-1 rounded hover:bg-green-50"
                    title="Execute & preview"
                  >
                    <Play className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => onEdit(dataset)}
                    className="text-blue-600 hover:text-blue-900 p-1 rounded hover:bg-blue-50"
                    title="Edit"
                  >
                    <Edit className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => onDelete(dataset.id)}
                    disabled={isDeleting === dataset.id}
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
