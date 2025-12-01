/**
 * Data Source Form Component
 * Handles creating and editing data sources with dynamic config fields
 */
'use client';

import { useState, useEffect } from 'react';
import { DataSourceType, DataSourceCreate } from '@/types/api';
import { Loader2 } from 'lucide-react';

interface DataSourceFormProps {
  initialData?: {
    id?: number;
    name: string;
    type: DataSourceType;
    description?: string;
    config: Record<string, any>;
  };
  onSubmit: (data: DataSourceCreate) => void;
  onCancel: () => void;
  isLoading?: boolean;
}

export default function DataSourceForm({
  initialData,
  onSubmit,
  onCancel,
  isLoading = false,
}: DataSourceFormProps) {
  const [name, setName] = useState(initialData?.name || '');
  const [type, setType] = useState<DataSourceType>(
    initialData?.type || DataSourceType.POSTGRESQL
  );
  const [description, setDescription] = useState(initialData?.description || '');
  const [config, setConfig] = useState<Record<string, any>>(
    initialData?.config || {}
  );

  useEffect(() => {
    // Reset config when type changes
    if (!initialData) {
      if (type === DataSourceType.POSTGRESQL) {
        setConfig({ host: 'localhost', port: 5432, database: '', username: '', password: '' });
      } else if (type === DataSourceType.MYSQL) {
        setConfig({ host: 'localhost', port: 3306, database: '', username: '', password: '' });
      } else if (type === DataSourceType.BIGQUERY) {
        setConfig({ project_id: '', credentials_json: '', default_dataset: '' });
      }
    }
  }, [type, initialData]);

  const handleConfigChange = (key: string, value: any) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      name,
      type,
      description: description || undefined,
      config,
    });
  };

  const renderConfigFields = () => {
    if (type === DataSourceType.POSTGRESQL || type === DataSourceType.MYSQL) {
      const defaultPort = type === DataSourceType.POSTGRESQL ? 5432 : 3306;
      return (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Host
              </label>
              <input
                type="text"
                value={config.host || ''}
                onChange={(e) => handleConfigChange('host', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="localhost"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Port
              </label>
              <input
                type="number"
                value={config.port || defaultPort}
                onChange={(e) => handleConfigChange('port', parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Database
            </label>
            <input
              type="text"
              value={config.database || ''}
              onChange={(e) => handleConfigChange('database', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="my_database"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Username
              </label>
              <input
                type="text"
                value={config.username || ''}
                onChange={(e) => handleConfigChange('username', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="user"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Password
              </label>
              <input
                type="password"
                value={config.password || ''}
                onChange={(e) => handleConfigChange('password', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="••••••••"
                required
              />
            </div>
          </div>
        </>
      );
    } else if (type === DataSourceType.BIGQUERY) {
      return (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Project ID
            </label>
            <input
              type="text"
              value={config.project_id || ''}
              onChange={(e) => handleConfigChange('project_id', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="my-gcp-project"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Service Account JSON
            </label>
            <textarea
              value={config.credentials_json || ''}
              onChange={(e) => handleConfigChange('credentials_json', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
              placeholder='{"type": "service_account", ...}'
              rows={6}
              required
            />
            <p className="text-xs text-gray-500 mt-1">
              Paste the entire JSON key file content
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Default Dataset (Optional)
            </label>
            <input
              type="text"
              value={config.default_dataset || ''}
              onChange={(e) => handleConfigChange('default_dataset', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="my_dataset"
            />
          </div>
        </>
      );
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Name <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="My Data Source"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Type <span className="text-red-500">*</span>
        </label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as DataSourceType)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={!!initialData}
        >
          <option value={DataSourceType.POSTGRESQL}>PostgreSQL</option>
          <option value={DataSourceType.MYSQL}>MySQL</option>
          <option value={DataSourceType.BIGQUERY}>BigQuery</option>
        </select>
        {initialData && (
          <p className="text-xs text-gray-500 mt-1">Type cannot be changed after creation</p>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Description
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Optional description"
          rows={2}
        />
      </div>

      <div className="border-t pt-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Connection Configuration</h3>
        <div className="space-y-4">{renderConfigFields()}</div>
      </div>

      <div className="flex gap-3 pt-4 border-t">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
          disabled={isLoading}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          disabled={isLoading}
        >
          {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
          {initialData ? 'Update' : 'Create'}
        </button>
      </div>
    </form>
  );
}
