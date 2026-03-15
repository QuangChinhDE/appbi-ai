/**
 * Data Source Form Component
 * Handles creating and editing data sources with dynamic config fields
 */
'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { DataSourceType, DataSourceCreate } from '@/types/api';
import { Loader2, UploadCloud, FileSpreadsheet, X, CheckCircle, AlertCircle, Radio, WifiOff } from 'lucide-react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api/v1';

// Type shared with backend response
type SheetData = { columns: { name: string; type: string }[]; rows: Record<string, any>[] };

interface DataSourceFormProps {
  initialData?: {
    id?: number;
    name: string;
    type: DataSourceType;
    description?: string;
    config: Record<string, any>;
  };
  onSubmit: (data: DataSourceCreate, meta: { configModified: boolean }) => void;
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

  // Multi-sheet import preview state
  const [importPreview, setImportPreview] = useState<{
    filename: string;
    sheets: Record<string, SheetData>;
    activeSheet: string;
  } | null>(() => {
    const cfg = initialData?.config;
    if (!cfg) return null;
    if (cfg.sheets && Object.keys(cfg.sheets).length > 0) {
      return { filename: '(imported file)', sheets: cfg.sheets, activeSheet: Object.keys(cfg.sheets)[0] };
    }
    if (cfg.columns?.length) {
      return { filename: '(imported file)', sheets: { manual_data: { columns: cfg.columns, rows: cfg.rows || [] } }, activeSheet: 'manual_data' };
    }
    return null;
  });
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Connection test state (for DB types)
  type TestState = 'idle' | 'testing' | 'ok' | 'fail';
  const [testState, setTestState] = useState<TestState>('idle');
  const [testMessage, setTestMessage] = useState('');

  // Track if config was actually changed by the user (matters for edit mode with Manual Table)
  // New datasource: always true. Edit: starts false, becomes true when user re-uploads data.
  const [configModified, setConfigModified] = useState(!initialData);

  // Reset test state whenever config fields change
  useEffect(() => { setTestState('idle'); setTestMessage(''); }, [config]);

  const isDbType = type === DataSourceType.POSTGRESQL || type === DataSourceType.MYSQL;

  const handleTestConnection = useCallback(async () => {
    setTestState('testing');
    setTestMessage('');
    try {
      const res = await fetch(`${API_BASE}/datasources/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, config }),
      });
      const data = await res.json();
      if (data.success) {
        setTestState('ok');
        setTestMessage(data.message ?? 'Connection successful');
      } else {
        setTestState('fail');
        setTestMessage(data.message ?? 'Connection failed');
      }
    } catch (e: any) {
      setTestState('fail');
      setTestMessage(e.message ?? 'Network error');
    }
  }, [type, config]);

  const handleFileImport = async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!['csv', 'xlsx', 'xls'].includes(ext ?? '')) {
      setUploadError('Unsupported file type. Please upload a .csv, .xlsx, or .xls file.');
      return;
    }
    setIsUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${API_BASE}/datasources/manual/parse-file`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail ?? 'Upload failed');
      }
      const data: { filename: string; sheets: Record<string, SheetData> } = await res.json();
      const activeSheet = Object.keys(data.sheets)[0] ?? '';
      setImportPreview({ filename: data.filename, sheets: data.sheets, activeSheet });
      setConfig({ sheets: data.sheets });
      setConfigModified(true);
    } catch (e: any) {
      setUploadError(e.message ?? 'Failed to parse file');
    } finally {
      setIsUploading(false);
    }
  };

  useEffect(() => {
    // Reset config when type changes (only for new datasource creation)
    if (!initialData) {
      setImportPreview(null);
      if (type === DataSourceType.POSTGRESQL) {
        setConfig({ host: 'localhost', port: 5432, database: '', username: '', password: '', schema_name: '' });
      } else if (type === DataSourceType.MYSQL) {
        setConfig({ host: 'localhost', port: 3306, database: '', username: '', password: '' });
      } else if (type === DataSourceType.BIGQUERY) {
        setConfig({ project_id: '', credentials_json: '', default_dataset: '' });
      } else if (type === DataSourceType.GOOGLE_SHEETS) {
        setConfig({ credentials_json: '', spreadsheet_id: '', sheet_name: '' });
      } else if (type === DataSourceType.MANUAL) {
        setConfig({ sheets: {} });
      }
    }
  }, [type, initialData]);

  const handleConfigChange = (key: string, value: any) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setConfigModified(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // For DB types, require a successful test before creating (not when editing)
    if (!initialData && isDbType && testState !== 'ok') return;
    onSubmit(
      { name, type, description: description || undefined, config },
      { configModified },
    );
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

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Database <span className="text-red-500">*</span>
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
            {type === DataSourceType.POSTGRESQL && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Schema <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  value={config.schema_name || ''}
                  onChange={(e) => handleConfigChange('schema_name', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="public"
                />
                <p className="text-xs text-gray-400 mt-0.5">Leave empty to use default (public)</p>
              </div>
            )}
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
    } else if (type === DataSourceType.GOOGLE_SHEETS) {
      return (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Service Account JSON
            </label>
            <textarea
              value={config.credentials_json || ''}
              onChange={(e) => handleConfigChange('credentials_json', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
              placeholder='{"type": "service_account", "project_id": "...", ...}'
              rows={8}
              required
            />
            <p className="text-xs text-gray-500 mt-1">
              Paste your Google Service Account JSON credentials
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Spreadsheet ID
            </label>
            <input
              type="text"
              value={config.spreadsheet_id || ''}
              onChange={(e) => handleConfigChange('spreadsheet_id', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
              required
            />
            <p className="text-xs text-gray-500 mt-1">
              Found in the URL: docs.google.com/spreadsheets/d/<strong>SPREADSHEET_ID</strong>/edit
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Sheet Name (Optional)
            </label>
            <input
              type="text"
              value={config.sheet_name || ''}
              onChange={(e) => handleConfigChange('sheet_name', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Sheet1"
            />
            <p className="text-xs text-gray-500 mt-1">
              Leave empty to use the first sheet
            </p>
          </div>
        </>
      );
    } else if (type === DataSourceType.MANUAL) {
      return (
        <div className="space-y-4">
          {/* Drop zone */}
          <div
            onDragOver={e => { e.preventDefault(); if (!isUploading) setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={e => {
              e.preventDefault();
              setIsDragOver(false);
              if (!isUploading) { const file = e.dataTransfer.files[0]; if (file) handleFileImport(file); }
            }}
            onClick={() => { if (!isUploading) fileInputRef.current?.click(); }}
            className={`border-2 border-dashed rounded-lg p-6 flex flex-col items-center gap-3 transition-colors ${
              isUploading ? 'border-blue-300 bg-blue-50 cursor-wait' :
              isDragOver  ? 'border-blue-400 bg-blue-50 cursor-copy' :
                            'border-gray-300 hover:border-gray-400 bg-gray-50 cursor-pointer'
            }`}
          >
            {isUploading
              ? <><Loader2 className="w-10 h-10 text-blue-500 animate-spin" /><p className="text-sm text-blue-600 font-medium">Đang xử lý file...</p></>
              : <><UploadCloud className={`w-10 h-10 ${isDragOver ? 'text-blue-500' : 'text-gray-400'}`} />
                  <div className="text-center">
                    <p className="text-sm font-medium text-gray-700">Kéo thả file vào đây, hoặc click để chọn</p>
                    <p className="text-xs text-gray-500 mt-1">Hỗ trợ: .csv, .xlsx, .xls · Excel nhiều sheet sẽ được import tất cả</p>
                  </div></>
            }
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) handleFileImport(file);
                e.target.value = '';
              }}
            />
          </div>

          {/* Upload error */}
          {uploadError && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700">{uploadError}</p>
            </div>
          )}

          {/* Preview after import */}
          {importPreview && (() => {
            const sheetNames = Object.keys(importPreview.sheets);
            const active = importPreview.sheets[importPreview.activeSheet] ?? importPreview.sheets[sheetNames[0]];
            if (!active) return null;
            return (
              <div className="border border-green-200 bg-green-50 rounded-lg overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-2 border-b border-green-200">
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet className="w-4 h-4 text-green-600 flex-shrink-0" />
                    <span className="text-sm font-medium text-green-800 truncate max-w-[200px]">{importPreview.filename}</span>
                    <CheckCircle className="w-4 h-4 text-green-500" />
                    <span className="text-xs text-green-700">{sheetNames.length} sheet</span>
                  </div>
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); setImportPreview(null); setConfig({ sheets: {} }); setUploadError(null); setConfigModified(true); }}
                    className="text-gray-400 hover:text-red-500 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Sheet tabs */}
                {sheetNames.length > 1 && (
                  <div className="flex overflow-x-auto border-b border-green-200 bg-white">
                    {sheetNames.map(s => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setImportPreview(prev => prev ? { ...prev, activeSheet: s } : prev)}
                        className={`px-4 py-2 text-xs font-medium whitespace-nowrap border-r border-green-100 transition-colors ${
                          importPreview.activeSheet === s
                            ? 'bg-green-50 text-green-800 border-b-2 border-b-green-600'
                            : 'text-gray-500 hover:bg-gray-50'
                        }`}
                      >
                        {s}
                        <span className="ml-1.5 text-gray-400">{importPreview.sheets[s].rows.length}</span>
                      </button>
                    ))}
                  </div>
                )}

                {/* Active sheet info */}
                <div className="p-3 space-y-2">
                  <div className="flex gap-4 text-xs text-green-700">
                    <span><strong>{active.columns.length}</strong> cột</span>
                    <span><strong>{active.rows.length}</strong> dòng dữ liệu</span>
                  </div>
                  {/* Column tags */}
                  <div className="flex flex-wrap gap-1.5">
                    {active.columns.map(col => (
                      <span key={col.name} className="px-2 py-0.5 bg-white border border-green-200 rounded text-xs text-gray-700">
                        {col.name}<span className="ml-1 text-gray-400">{col.type}</span>
                      </span>
                    ))}
                  </div>
                  {/* Data preview */}
                  {active.rows.length > 0 && (
                    <div className="overflow-x-auto rounded border border-green-200 bg-white">
                      <table className="text-xs w-full">
                        <thead className="bg-gray-50">
                          <tr>
                            {active.columns.map(col => (
                              <th key={col.name} className="px-3 py-1.5 text-left font-medium text-gray-600 border-b whitespace-nowrap">{col.name}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {active.rows.slice(0, 5).map((row, i) => (
                            <tr key={i} className="border-b last:border-0">
                              {active.columns.map(col => (
                                <td key={col.name} className="px-3 py-1.5 text-gray-700 whitespace-nowrap max-w-[140px] truncate">
                                  {String(row[col.name] ?? '')}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {active.rows.length > 5 && (
                        <p className="text-xs text-gray-400 px-3 py-1.5">... và {active.rows.length - 5} dòng nữa</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
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
          <option value={DataSourceType.GOOGLE_SHEETS}>Google Sheets</option>
          <option value={DataSourceType.MANUAL}>Manual Table</option>
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

      {/* Test connection button + result — only for DB types */}
      {isDbType && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={testState === 'testing'}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-blue-400 text-blue-700 rounded-md hover:bg-blue-50 transition-colors disabled:opacity-50"
          >
            {testState === 'testing' ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Testing connection...</>
            ) : (
              <><Radio className="w-4 h-4" /> Test Connection</>
            )}
          </button>
          {testState === 'ok' && (
            <div className="flex items-center gap-2 p-2.5 bg-green-50 border border-green-200 rounded-md">
              <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0" />
              <span className="text-sm text-green-700">{testMessage}</span>
            </div>
          )}
          {testState === 'fail' && (
            <div className="flex items-start gap-2 p-2.5 bg-red-50 border border-red-200 rounded-md">
              <WifiOff className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <span className="text-sm text-red-700">{testMessage}</span>
            </div>
          )}
        </div>
      )}

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
          disabled={isLoading || (!initialData && isDbType && testState !== 'ok')}
          title={!initialData && isDbType && testState !== 'ok' ? 'Test the connection first' : undefined}
        >
          {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
          {initialData ? 'Update' : 'Create'}
        </button>
      </div>
    </form>
  );
}
