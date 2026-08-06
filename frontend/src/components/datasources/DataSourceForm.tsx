/**
 * Data Source Form Component
 * Handles creating and editing data sources with dynamic config fields
 */
'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { DataSourceType, DataSourceCreate } from '@/types/api';
import { Loader2, UploadCloud, FileSpreadsheet, X, CheckCircle, AlertCircle, Radio, WifiOff, Eye, EyeOff } from 'lucide-react';
import { HelpTooltip } from '@/components/ui/HelpTooltip';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';

// Type shared with backend response
type SheetData = { columns: { name: string; type: string }[]; rows: Record<string, any>[] };
type GoogleDataAccessStatus = {
  configured: boolean;
  connected: boolean;
  email: string | null;
  scopes: string[];
  /** App scopes this token was never granted (consent predates them). */
  missing_scopes?: string[];
  /** Connected, but missing a scope — must re-consent or that feature 403s. */
  needs_reconnect?: boolean;
  capabilities?: Record<string, boolean>;
  redirect_uri?: string | null;
};

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'string' && payload.trim()) return payload;
  if (!payload || typeof payload !== 'object') return fallback;

  const candidate = payload as { message?: unknown; detail?: unknown };
  if (typeof candidate.message === 'string' && candidate.message.trim()) return candidate.message;
  if (typeof candidate.detail === 'string' && candidate.detail.trim()) return candidate.detail;
  return fallback;
}

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
  /** When true, all inputs are disabled and the submit button is hidden. */
  readOnly?: boolean;
}

const SENSITIVE_FIELDS = ['password', 'credentials_json', 'api_key', 'token', 'access_token', 'google_oauth_user_id', 'secret_key', 'private_key', 'client_secret', 'service_account_json'];

function getDefaultConfigForType(type: DataSourceType): Record<string, any> {
  if (type === DataSourceType.POSTGRESQL) {
    return { host: 'localhost', port: 5432, database: '', username: '', password: '', schema_name: '' };
  }
  if (type === DataSourceType.MYSQL) {
    return { host: 'localhost', port: 3306, database: '', username: '', password: '' };
  }
  if (type === DataSourceType.BIGQUERY) {
    return { project_id: '', auth_mode: 'service_account', credentials_json: '', default_dataset: '' };
  }
  if (type === DataSourceType.GOOGLE_SHEETS) {
    return { auth_mode: 'service_account', credentials_json: '', spreadsheet_id: '', sheet_name: '' };
  }
  if (type === DataSourceType.MANUAL) {
    return { sheets: {} };
  }
  return {};
}

/** Strip the server's "__stored__" sentinel so form fields appear empty (not leaking masked values). */
function sanitizeConfigForForm(cfg: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(cfg)) {
    out[k] = SENSITIVE_FIELDS.includes(k) && v === '__stored__' ? '' : v;
  }
  return out;
}

export default function DataSourceForm({
  initialData,
  onSubmit,
  onCancel,
  isLoading = false,
  readOnly = false,
}: DataSourceFormProps) {
  const [name, setName] = useState(initialData?.name || '');
  const [type, setType] = useState<DataSourceType>(
    initialData?.type || DataSourceType.POSTGRESQL
  );
  const [description, setDescription] = useState(initialData?.description || '');
  const [config, setConfig] = useState<Record<string, any>>(
    initialData?.config ? sanitizeConfigForForm(initialData.config) : {}
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

  // Inline connection feedback (used for save-time guidance and Google auth errors)
  type TestState = 'idle' | 'fail';
  const [testState, setTestState] = useState<TestState>('idle');
  const [testMessage, setTestMessage] = useState('');

  // Track if config was actually changed by the user (matters for edit mode with Manual Table)
  // New datasource: always true. Edit: starts false, becomes true when user re-uploads data.
  const [configModified, setConfigModified] = useState(!initialData);

  // Show/hide sensitive credential fields (credentials_json, private_key, etc.)
  // Always hidden by default — user must click Show to reveal
  const [showCredentials, setShowCredentials] = useState(false);
  // Show/hide password field for DB connections
  const [showPassword, setShowPassword] = useState(false);

  // Platform-level GCP service account info
  const [platformGcp, setPlatformGcp] = useState<{ available: boolean; email: string | null } | null>(null);
  const [googleDataAccess, setGoogleDataAccess] = useState<GoogleDataAccessStatus | null>(null);
  // Google account just granted in the popup for THIS source, not yet saved.
  const [pendingGoogle, setPendingGoogle] = useState<{ id: string; email: string } | null>(null);
  // "Connected" alone is not enough: a token only works for a capability whose
  // scope was granted at consent time, so a pre-existing connection can look
  // ready here and still 403 at query time.
  const googleCan = (cap: 'bigquery' | 'sheets' | 'docs') =>
    !!googleDataAccess?.connected && googleDataAccess?.capabilities?.[cap] !== false;
  const googleAuthMode = config.auth_mode === 'google_oauth' ? 'google_oauth' : 'service_account';
  const isGoogleCloudType = type === DataSourceType.BIGQUERY || type === DataSourceType.GOOGLE_SHEETS || type === DataSourceType.GOOGLE_DOCS;
  // Google Docs has no service-account path — it is always an OAuth connection.
  useEffect(() => {
    if (type === DataSourceType.GOOGLE_DOCS) {
      setConfig((prev) => (prev?.auth_mode === 'google_oauth' ? prev : { ...prev, auth_mode: 'google_oauth' }));
    }
  }, [type]);
  const currentGoogleDatasourceEmail = typeof config.google_oauth_email === 'string' ? config.google_oauth_email : '';

  const loadGoogleDataAccessStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/auth/google/data-access/status`, { credentials: 'include' });
      if (!response.ok) return;
      const data: GoogleDataAccessStatus = await response.json();
      setGoogleDataAccess(data);
    } catch {
      // Ignore transient fetch failures in the form.
    }
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/datasources/platform-gcp-info`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setPlatformGcp({ available: d.platform_credential_available, email: d.service_account_email }))
      .catch(() => {});
  }, []);
  useEffect(() => { void loadGoogleDataAccessStatus(); }, [loadGoogleDataAccessStatus]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== 'google-data-access') return;
      if (event.data?.status === 'error') {
        setTestState('fail');
        setTestMessage(extractErrorMessage(event.data?.message, 'Google access connection failed.'));
      } else if (event.data?.pending_id) {
        // Hold the granted credential against THIS form until it is saved.
        setPendingGoogle({ id: String(event.data.pending_id), email: String(event.data.email || '') });
        setConfig((prev) => ({ ...prev, google_pending_id: String(event.data.pending_id), google_oauth_email: String(event.data.email || '') }));
        setConfigModified(true);
      }
      void loadGoogleDataAccessStatus();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [loadGoogleDataAccessStatus]);

  // Reset test state whenever config fields change
  useEffect(() => { setTestState('idle'); setTestMessage(''); }, [config]);

  useEffect(() => {
    if (!isGoogleCloudType || googleAuthMode !== 'google_oauth') return;
    if (!googleDataAccess?.email) return;
    if (currentGoogleDatasourceEmail) return;
    setConfig(prev => (
      prev.auth_mode === 'google_oauth' && !prev.google_oauth_email
        ? { ...prev, google_oauth_email: googleDataAccess.email }
        : prev
    ));
  }, [currentGoogleDatasourceEmail, googleAuthMode, googleDataAccess?.email, isGoogleCloudType]);

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
        credentials: 'include',
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
      setConfig(getDefaultConfigForType(type));
    }
  }, [type, initialData]);

  const handleConfigChange = (key: string, value: any) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setConfigModified(true);
  };

  const handleGoogleAuthModeChange = useCallback((nextMode: 'service_account' | 'google_oauth') => {
    setConfig((prev) => ({
      ...prev,
      auth_mode: nextMode,
      ...(nextMode === 'google_oauth' && googleDataAccess?.email
        ? { google_oauth_email: googleDataAccess.email }
        : {}),
    }));
    setConfigModified(true);
  }, [googleDataAccess?.email]);

  // Connect a Google account to THIS data source. The consent popup finishes
  // before a new source has an id, so it returns a short-lived pending id that
  // is claimed when the source is saved — that is what makes each source carry
  // its own account instead of silently inheriting a previous connection.
  const handleConnectGoogleDataAccess = useCallback(() => {
    if (typeof window === 'undefined') return;
    const returnTo = `${window.location.pathname}${window.location.search}`;
    const url = `${API_BASE}/auth/google/data-access/start?popup=1&scope=datasource&return_to=${encodeURIComponent(returnTo)}`;
    const popup = window.open(url, 'google-data-access', 'popup=yes,width=560,height=720');
    if (!popup) {
      window.location.assign(url.replace('popup=1', 'popup=0'));
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly) return;
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
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Host
              </label>
              <input
                type="text"
                value={config.host || ''}
                onChange={(e) => handleConfigChange('host', e.target.value)}
                className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
                placeholder="localhost"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Port
              </label>
              <input
                type="number"
                value={config.port || defaultPort}
                onChange={(e) => handleConfigChange('port', parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Database <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                value={config.database || ''}
                onChange={(e) => handleConfigChange('database', e.target.value)}
                className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
                placeholder="my_database"
                required
              />
            </div>
            {type === DataSourceType.POSTGRESQL && (
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">
                  Schema <span className="text-text-quaternary font-normal">(optional)</span>
                  <HelpTooltip text="Leave empty to use default (public)" />
                </label>
                <input
                  type="text"
                  value={config.schema_name || ''}
                  onChange={(e) => handleConfigChange('schema_name', e.target.value)}
                  className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
                  placeholder="public"
                />
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Username
              </label>
              <input
                type="text"
                value={config.username || ''}
                onChange={(e) => handleConfigChange('username', e.target.value)}
                className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
                placeholder="user"
                required
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm font-medium text-text-secondary">
                  Password
                </label>
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors"
                >
                  {showPassword ? <><EyeOff className="w-3.5 h-3.5" /> Hide</> : <><Eye className="w-3.5 h-3.5" /> Show</>}
                </button>
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                value={config.password || ''}
                onChange={(e) => handleConfigChange('password', e.target.value)}
                className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
                placeholder={initialData ? '(stored — leave blank to keep)' : '••••••••'}
                required={!initialData}
              />
            </div>
          </div>
        </>
      );
    } else if (type === DataSourceType.BIGQUERY) {
      if (googleAuthMode === 'google_oauth') {
        return (
          <>
            <div className="space-y-3">
              <label className="block text-sm font-medium text-text-secondary">
                Authentication
              </label>
              <div className="grid gap-3 md:grid-cols-2">
                <button
                  type="button"
                  onClick={() => handleGoogleAuthModeChange('google_oauth')}
                  className="rounded-lg border border-brand bg-brand/10 px-4 py-3 text-left text-brand transition-colors"
                >
                  <div className="flex items-center gap-2 font-medium">
                    <Radio className="w-4 h-4" />
                    Use my Google account
                  </div>
                  <p className="mt-1 text-xs text-text-tertiary">
                    Query BigQuery with the Google account already connected in AppBI.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => handleGoogleAuthModeChange('service_account')}
                  className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3 text-left text-text-secondary transition-colors hover:border-[rgb(var(--border-strong))]"
                >
                  <div className="flex items-center gap-2 font-medium">
                    <Radio className="w-4 h-4" />
                    Use service account
                  </div>
                  <p className="mt-1 text-xs text-text-tertiary">
                    Switch back to the existing service-account flow.
                  </p>
                </button>
              </div>
            </div>

            <div className={`rounded-lg border px-4 py-3 text-sm ${googleCan('bigquery') ? 'border-success/30 bg-success/10 text-success' : 'border-warning/30 bg-warning/10 text-warning'}`}>
              <div className="font-medium">
                {googleCan('bigquery')
                  ? 'Google data access connected.'
                  : googleDataAccess?.connected
                    ? 'Connected — but this Google connection has not approved BigQuery access yet.'
                    : 'Google data access not connected yet.'}
              </div>
              <p className="mt-1">
                {googleDataAccess?.connected
                  ? <>Your AppBI account is connected to <span className="font-mono">{googleDataAccess.email}</span>{googleCan('bigquery') ? '.' : ' — it was connected before this permission existed, so press Reconnect to approve it.'}</>
                  : googleDataAccess?.configured
                    ? 'Connect your Google account once, then this datasource can use BigQuery directly without a service-account JSON key.'
                    : 'Admin still needs to set AUTH_GOOGLE_CLIENT_SECRET and AUTH_GOOGLE_DATA_REDIRECT_URI on the server.'}
              </p>
              {!readOnly && googleDataAccess?.configured && (
                <button
                  type="button"
                  onClick={handleConnectGoogleDataAccess}
                  className="mt-3 inline-flex items-center rounded-md border border-brand/30 bg-surface-1 px-3 py-1.5 text-sm font-medium text-brand hover:bg-brand/15"
                >
                  {googleDataAccess?.connected ? 'Reconnect Google access' : 'Connect Google access'}
                </button>
              )}
            </div>

            {currentGoogleDatasourceEmail && (
              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3 text-sm text-text-secondary">
                This datasource will use Google account <span className="font-mono">{currentGoogleDatasourceEmail}</span>.
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Project ID
              </label>
              <input
                type="text"
                value={config.project_id || ''}
                onChange={(e) => handleConfigChange('project_id', e.target.value)}
                className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
                placeholder="my-gcp-project"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Default Dataset (Optional)
              </label>
              <input
                type="text"
                value={config.default_dataset || ''}
                onChange={(e) => handleConfigChange('default_dataset', e.target.value)}
                className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
                placeholder="my_dataset"
              />
            </div>
          </>
        );
      }

      return (
        <>
          <div className="space-y-3">
            <label className="block text-sm font-medium text-text-secondary">
              Authentication
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              <button
                type="button"
                onClick={() => handleGoogleAuthModeChange('google_oauth')}
                className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3 text-left text-text-secondary transition-colors hover:border-[rgb(var(--border-strong))]"
              >
                <div className="flex items-center gap-2 font-medium">
                  <Radio className="w-4 h-4" />
                  Use my Google account
                </div>
                <p className="mt-1 text-xs text-text-tertiary">
                  Query BigQuery with the Google account already connected in AppBI.
                </p>
              </button>
              <button
                type="button"
                onClick={() => handleGoogleAuthModeChange('service_account')}
                className="rounded-lg border border-brand bg-brand/10 px-4 py-3 text-left text-brand transition-colors"
              >
                <div className="flex items-center gap-2 font-medium">
                  <Radio className="w-4 h-4" />
                  Use service account
                </div>
                <p className="mt-1 text-xs text-text-tertiary">
                  Keep the existing service-account flow.
                </p>
              </button>
            </div>
          </div>

          {platformGcp?.available && (
            <div className="flex items-start gap-2 px-3 py-2.5 bg-success/10 border border-success/30 rounded-lg text-sm text-success">
              <CheckCircle className="w-4 h-4 mt-0.5 shrink-0 text-success" />
              <div>
                <span className="font-medium">Platform credential active.</span> Share your BigQuery dataset with{' '}
                <span className="font-mono bg-success/15 px-1 rounded">{platformGcp.email}</span> then fill in Project ID below.
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Project ID
            </label>
            <input
              type="text"
              value={config.project_id || ''}
              onChange={(e) => handleConfigChange('project_id', e.target.value)}
              className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
              placeholder="my-gcp-project"
              required
            />
          </div>

          {!platformGcp?.available && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm font-medium text-text-secondary flex items-center">
                  Service Account JSON
                  <HelpTooltip text="Paste the entire JSON key file content from your Google Cloud service account." />
                </label>
                <button
                  type="button"
                  onClick={() => setShowCredentials(v => !v)}
                  className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors"
                >
                  {showCredentials ? <><EyeOff className="w-3.5 h-3.5" /> Hide</> : <><Eye className="w-3.5 h-3.5" /> Show</>}
                </button>
              </div>
              <textarea
                value={config.credentials_json || ''}
                onChange={(e) => handleConfigChange('credentials_json', e.target.value)}
                className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand font-mono text-sm"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                style={!showCredentials ? { WebkitTextSecurity: 'disc' } as any : undefined}
                placeholder={showCredentials ? (initialData ? '(stored — paste new JSON to replace)' : '{"type": "service_account", ...}') : 'Paste Service Account JSON here'}
                rows={6}
                required={!initialData || !config.credentials_json}
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Default Dataset (Optional)
            </label>
            <input
              type="text"
              value={config.default_dataset || ''}
              onChange={(e) => handleConfigChange('default_dataset', e.target.value)}
              className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
              placeholder="my_dataset"
            />
          </div>
        </>
      );
    } else if (type === DataSourceType.GOOGLE_SHEETS) {
      if (googleAuthMode === 'google_oauth') {
        return (
          <>
            <div className="space-y-3">
              <label className="block text-sm font-medium text-text-secondary">
                Authentication
              </label>
              <div className="grid gap-3 md:grid-cols-2">
                <button
                  type="button"
                  onClick={() => handleGoogleAuthModeChange('google_oauth')}
                  className="rounded-lg border border-brand bg-brand/10 px-4 py-3 text-left text-brand transition-colors"
                >
                  <div className="flex items-center gap-2 font-medium">
                    <Radio className="w-4 h-4" />
                    Use my Google account
                  </div>
                  <p className="mt-1 text-xs text-text-tertiary">
                    Read the sheet using the Google account already connected in AppBI.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => handleGoogleAuthModeChange('service_account')}
                  className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3 text-left text-text-secondary transition-colors hover:border-[rgb(var(--border-strong))]"
                >
                  <div className="flex items-center gap-2 font-medium">
                    <Radio className="w-4 h-4" />
                    Use service account
                  </div>
                  <p className="mt-1 text-xs text-text-tertiary">
                    Switch back to the existing service-account flow.
                  </p>
                </button>
              </div>
            </div>

            <div className={`rounded-lg border px-4 py-3 text-sm ${googleCan('sheets') ? 'border-success/30 bg-success/10 text-success' : 'border-warning/30 bg-warning/10 text-warning'}`}>
              <div className="font-medium">
                {googleCan('sheets')
                  ? 'Google data access connected.'
                  : googleDataAccess?.connected
                    ? 'Connected — but this Google connection has not approved Google Sheets access yet.'
                    : 'Google data access not connected yet.'}
              </div>
              <p className="mt-1">
                {googleDataAccess?.connected
                  ? <>Your AppBI account is connected to <span className="font-mono">{googleDataAccess.email}</span>{googleCan('sheets') ? '.' : ' — it was connected before this permission existed, so press Reconnect to approve it.'}</>
                  : googleDataAccess?.configured
                    ? 'Connect your Google account once, then this datasource can read Google Sheets directly without a service-account JSON key.'
                    : 'Admin still needs to set AUTH_GOOGLE_CLIENT_SECRET and AUTH_GOOGLE_DATA_REDIRECT_URI on the server.'}
              </p>
              {!readOnly && googleDataAccess?.configured && (
                <button
                  type="button"
                  onClick={handleConnectGoogleDataAccess}
                  className="mt-3 inline-flex items-center rounded-md border border-brand/30 bg-surface-1 px-3 py-1.5 text-sm font-medium text-brand hover:bg-brand/15"
                >
                  {googleDataAccess?.connected ? 'Reconnect Google access' : 'Connect Google access'}
                </button>
              )}
            </div>

            {currentGoogleDatasourceEmail && (
              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3 text-sm text-text-secondary">
                This datasource will use Google account <span className="font-mono">{currentGoogleDatasourceEmail}</span>.
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1 flex items-center">
                Spreadsheet URL or ID
                <HelpTooltip text="Paste the full Google Sheets link — AppBI will extract the spreadsheet ID automatically." />
              </label>
              <input
                type="text"
                value={config.spreadsheet_id || ''}
                onChange={(e) => {
                  const val = e.target.value.trim();
                  const match = val.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
                  handleConfigChange('spreadsheet_id', match ? match[1] : val);
                }}
                className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
                placeholder="Paste a Google Sheets URL or Spreadsheet ID"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1 flex items-center">
                Sheet Name (Optional)
                <HelpTooltip text="Leave empty to use the first sheet." />
              </label>
              <input
                type="text"
                value={config.sheet_name || ''}
                onChange={(e) => handleConfigChange('sheet_name', e.target.value)}
                className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
                placeholder="Sheet1"
              />
            </div>
          </>
        );
      }

      return (
        <>
          <div className="space-y-3">
            <label className="block text-sm font-medium text-text-secondary">
              Authentication
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              <button
                type="button"
                onClick={() => handleGoogleAuthModeChange('google_oauth')}
                className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3 text-left text-text-secondary transition-colors hover:border-[rgb(var(--border-strong))]"
              >
                <div className="flex items-center gap-2 font-medium">
                  <Radio className="w-4 h-4" />
                  Use my Google account
                </div>
                <p className="mt-1 text-xs text-text-tertiary">
                  Read the sheet with the Google account already connected in AppBI.
                </p>
              </button>
              <button
                type="button"
                onClick={() => handleGoogleAuthModeChange('service_account')}
                className="rounded-lg border border-brand bg-brand/10 px-4 py-3 text-left text-brand transition-colors"
              >
                <div className="flex items-center gap-2 font-medium">
                  <Radio className="w-4 h-4" />
                  Use service account
                </div>
                <p className="mt-1 text-xs text-text-tertiary">
                  Keep the existing service-account flow.
                </p>
              </button>
            </div>
          </div>

          {platformGcp?.available && (
            <div className="flex items-start gap-2 px-3 py-2.5 bg-success/10 border border-success/30 rounded-lg text-sm text-success">
              <CheckCircle className="w-4 h-4 mt-0.5 shrink-0 text-success" />
              <div>
                <span className="font-medium">Platform credential active.</span> Share your Google Sheet with{' '}
                <span className="font-mono bg-success/15 px-1 rounded">{platformGcp.email}</span> then paste the Sheet link below.
              </div>
            </div>
          )}

          {!platformGcp?.available && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm font-medium text-text-secondary flex items-center">
                  Service Account JSON
                  <HelpTooltip text="Paste the entire JSON key file content from your Google Cloud service account." />
                </label>
                <button
                  type="button"
                  onClick={() => setShowCredentials(v => !v)}
                  className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors"
                >
                  {showCredentials ? <><EyeOff className="w-3.5 h-3.5" /> Hide</> : <><Eye className="w-3.5 h-3.5" /> Show</>}
                </button>
              </div>
              <textarea
                value={config.credentials_json || ''}
                onChange={(e) => handleConfigChange('credentials_json', e.target.value)}
                className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand font-mono text-sm"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                style={!showCredentials ? { WebkitTextSecurity: 'disc' } as any : undefined}
                placeholder={showCredentials ? (initialData ? '(stored — paste new JSON to replace)' : '{"type": "service_account", "project_id": "...", ...}') : 'Paste Service Account JSON here'}
                rows={4}
                required={!initialData || !config.credentials_json}
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1 flex items-center">
              Spreadsheet URL hoặc ID
              <HelpTooltip text="Dán toàn bộ link Google Sheets — ID sẽ được tự động trích xuất." />
            </label>
            <input
              type="text"
              value={config.spreadsheet_id || ''}
              onChange={(e) => {
                // Accept full URL or bare ID — extract ID automatically
                const val = e.target.value.trim();
                const match = val.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
                handleConfigChange('spreadsheet_id', match ? match[1] : val);
              }}
              className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
              placeholder="Dán link Google Sheets hoặc Spreadsheet ID"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1 flex items-center">
              Sheet Name (Optional)
              <HelpTooltip text="Leave empty to use the first sheet." />
            </label>
            <input
              type="text"
              value={config.sheet_name || ''}
              onChange={(e) => handleConfigChange('sheet_name', e.target.value)}
              className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
              placeholder="Sheet1"
            />
          </div>
        </>
      );
    } else if (type === DataSourceType.GOOGLE_DOCS) {
      // A Google Docs source is JUST a named Google connection — it carries no
      // tables. Documents pick one of these and supply their own doc URL, so
      // several documents can share one connection, and different connections
      // can point at different Google accounts.
      const g = (config as Record<string, any>)?.google as
        | { connected?: boolean; email?: string | null; per_source?: boolean; capabilities?: Record<string, boolean> | null }
        | undefined;
      const connectedEmail = pendingGoogle?.email || g?.email || null;
      const canDocs = pendingGoogle ? true : !!g?.capabilities?.docs;
      const isConnected = !!pendingGoogle || !!g?.connected;
      return (
        <div className="space-y-4">
          <div className={`rounded-lg border px-4 py-3 text-sm ${canDocs ? 'border-success/30 bg-success/10 text-success' : isConnected ? 'border-warning/30 bg-warning/10 text-warning' : 'border-[rgb(var(--border-strong))] bg-surface-2 text-text-secondary'}`}>
            <div className="font-medium">
              {canDocs
                ? 'Google Docs access is ready.'
                : isConnected
                  ? 'Connected — but this account has not approved Google Docs access.'
                  : 'No Google account connected to this source yet.'}
            </div>
            <p className="mt-1">
              {connectedEmail
                ? <>This source reads Google Docs as <span className="font-mono">{connectedEmail}</span>{pendingGoogle ? ' (save to apply).' : canDocs ? '.' : ' — press Connect again and approve Docs access.'}</>
                : 'Each source connects its own Google account, so different sources can use different accounts.'}
            </p>
            {!readOnly && (
              <button
                type="button"
                onClick={handleConnectGoogleDataAccess}
                className="mt-3 inline-flex items-center rounded-md border border-brand/30 bg-surface-1 px-3 py-1.5 text-sm font-medium text-brand hover:bg-brand/15"
              >
                {isConnected ? 'Connect a different Google account' : 'Connect Google'}
              </button>
            )}
          </div>
          <p className="text-xs text-text-tertiary">
            This source holds no tables. Use it in Govern → Documents: create a document from “Google Docs”,
            pick this source, and paste the document URL.
          </p>
        </div>
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
              isUploading ? 'border-brand/40 bg-brand/10 cursor-wait' :
              isDragOver  ? 'border-brand/50 bg-brand/10 cursor-copy' :
                            'border-[rgb(var(--border-strong))] hover:border-[rgb(var(--border-strong))] bg-surface-2 cursor-pointer'
            }`}
          >
            {isUploading
              ? <><Loader2 className="w-10 h-10 text-brand animate-spin" /><p className="text-sm text-brand font-medium">Đang xử lý file...</p></>
              : <><UploadCloud className={`w-10 h-10 ${isDragOver ? 'text-brand' : 'text-text-quaternary'}`} />
                  <div className="text-center">
                    <p className="text-sm font-medium text-text-secondary">Kéo thả file vào đây, hoặc click để chọn</p>
                    <p className="text-xs text-text-tertiary mt-1">Hỗ trợ: .csv, .xlsx, .xls · Excel nhiều sheet sẽ được import tất cả</p>
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
            <div className="flex items-start gap-2 p-3 bg-danger/10 border border-danger/30 rounded-lg">
              <AlertCircle className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />
              <p className="text-sm text-danger">{uploadError}</p>
            </div>
          )}

          {/* Preview after import */}
          {importPreview && (() => {
            const sheetNames = Object.keys(importPreview.sheets);
            const active = importPreview.sheets[importPreview.activeSheet] ?? importPreview.sheets[sheetNames[0]];
            if (!active) return null;
            return (
              <div className="border border-success/30 bg-success/10 rounded-lg overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-2 border-b border-success/30">
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet className="w-4 h-4 text-success flex-shrink-0" />
                    <span className="text-sm font-medium text-success truncate max-w-[200px]">{importPreview.filename}</span>
                    <CheckCircle className="w-4 h-4 text-success" />
                    <span className="text-xs text-success">{sheetNames.length} sheet</span>
                  </div>
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); setImportPreview(null); setConfig({ sheets: {} }); setUploadError(null); setConfigModified(true); }}
                    className="text-text-quaternary hover:text-danger transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Sheet tabs */}
                {sheetNames.length > 1 && (
                  <div className="flex overflow-x-auto border-b border-success/30 bg-surface-1">
                    {sheetNames.map(s => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setImportPreview(prev => prev ? { ...prev, activeSheet: s } : prev)}
                        className={`px-4 py-2 text-xs font-medium whitespace-nowrap border-r border-success/20 transition-colors ${
                          importPreview.activeSheet === s
                            ? 'bg-success/10 text-success border-b-2 border-b-green-600'
                            : 'text-text-tertiary hover:bg-surface-2'
                        }`}
                      >
                        {s}
                        <span className="ml-1.5 text-text-quaternary">{importPreview.sheets[s].rows.length}</span>
                      </button>
                    ))}
                  </div>
                )}

                {/* Active sheet info */}
                <div className="p-3 space-y-2">
                  <div className="flex gap-4 text-xs text-success">
                    <span><strong>{active.columns.length}</strong> cột</span>
                    <span><strong>{active.rows.length}</strong> dòng dữ liệu</span>
                  </div>
                  {/* Column tags */}
                  <div className="flex flex-wrap gap-1.5">
                    {active.columns.map(col => (
                      <span key={col.name} className="rounded border border-success/30 bg-surface-1 px-2 py-0.5 text-xs text-text-secondary">
                        {col.name}<span className="ml-1 text-text-quaternary">{col.type}</span>
                      </span>
                    ))}
                  </div>
                  {/* Data preview */}
                  {active.rows.length > 0 && (
                    <div className="overflow-x-auto rounded border border-success/30 bg-surface-1">
                      <table className="text-xs w-full">
                        <thead className="bg-surface-2">
                          <tr>
                            {active.columns.map(col => (
                              <th key={col.name} className="px-3 py-1.5 text-left font-medium text-text-secondary border-b whitespace-nowrap">{col.name}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {active.rows.slice(0, 5).map((row, i) => (
                            <tr key={i} className="border-b last:border-0">
                              {active.columns.map(col => (
                                <td key={col.name} className="px-3 py-1.5 text-text-secondary whitespace-nowrap max-w-[140px] truncate">
                                  {String(row[col.name] ?? '')}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {active.rows.length > 5 && (
                        <p className="text-xs text-text-quaternary px-3 py-1.5">... và {active.rows.length - 5} dòng nữa</p>
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
      {readOnly && (
        <div className="flex items-center gap-2 px-3 py-2 bg-warning/10 border border-warning/30 rounded-lg text-warning text-sm">
          <span>You have view-only access to this data source.</span>
        </div>
      )}
      {/* fieldset[disabled] cascades to all form controls inside — no need to touch each input */}
      <fieldset disabled={readOnly} className="space-y-4 border-0 p-0 m-0 disabled:opacity-60">
      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1">
          Name <span className="text-danger">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
          placeholder="My Data Source"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1 flex items-center">
          Type <span className="text-danger ml-0.5">*</span>
          {initialData && <HelpTooltip text="Type cannot be changed after creation." />}
        </label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as DataSourceType)}
          className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
          disabled={!!initialData}
        >
          <option value={DataSourceType.POSTGRESQL}>PostgreSQL</option>
          <option value={DataSourceType.MYSQL}>MySQL</option>
          <option value={DataSourceType.BIGQUERY}>BigQuery</option>
          <option value={DataSourceType.GOOGLE_SHEETS}>Google Sheets</option>
          <option value={DataSourceType.GOOGLE_DOCS}>Google Docs</option>
          <option value={DataSourceType.MANUAL}>Manual Table</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1">
          Description
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
          placeholder="Optional description"
          rows={2}
        />
      </div>

      <div className="border-t pt-4">
        <h3 className="text-sm font-semibold text-text-primary mb-3">Connection Configuration</h3>
        <div className="space-y-4">{renderConfigFields()}</div>
      </div>

      {/* Save-time validation guidance for all non-manual types */}
      {type !== DataSourceType.MANUAL && (
        <div className="space-y-2">
          <div className="rounded-md border border-brand/30 bg-brand/10 px-3 py-2 text-sm text-brand">
            {initialData
              ? 'Connection will be checked automatically when you save configuration changes.'
              : 'Connection will be checked automatically when you create this data source.'}
          </div>
          {testState === 'fail' && (
            <div className="flex items-start gap-2 p-2.5 bg-danger/10 border border-danger/30 rounded-md">
              <WifiOff className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />
              <span className="text-sm text-danger">{testMessage}</span>
            </div>
          )}
        </div>
      )}

      </fieldset>

      <div className="flex gap-3 pt-4 border-t">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-4 py-2 border border-[rgb(var(--border-strong))] rounded-md text-text-secondary hover:bg-surface-2 transition-colors"
          disabled={isLoading}
        >
          {readOnly ? 'Back' : 'Cancel'}
        </button>
        {!readOnly && (
        <button
          type="submit"
          className="flex-1 px-4 py-2 bg-brand text-white rounded-md hover:bg-brand-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          disabled={isLoading}
        >
          {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
          {initialData ? 'Update' : 'Create'}
        </button>
        )}
      </div>
    </form>
  );
}
