'use client';

import { Badge } from '@/components/ui/Badge';
import type {
  DataSource,
  DataSourceCheckState,
  DataSourceDeleteBlocker,
  DataSourceErrorCode,
  DataSourceTestResult,
} from '@/types/api';

/** Human labels for the backend's error categories (source_errors.SOURCE_ERROR_CODES). */
export const SOURCE_ERROR_LABEL: Record<DataSourceErrorCode, string> = {
  auth: 'Authentication failed',
  network: 'Host unreachable',
  permission: 'Permission denied',
  missing_resource: 'Database / dataset not found',
  invalid_config: 'Invalid configuration',
  query: 'Query failed',
  timeout: 'Timed out',
  quota: 'Quota exceeded',
  unsupported: 'Not supported',
  internal: 'Unexpected error',
  policy_blocked: 'Blocked by network policy',
};

const CHECK_LABEL: Record<string, string> = {
  auth: 'Auth',
  reachable: 'Reachable',
  queryable: 'Query',
  discoverable: 'Discover',
};

const CHECK_VARIANT: Record<DataSourceCheckState, 'success' | 'danger' | 'subtle' | 'warning'> = {
  ok: 'success',
  failed: 'danger',
  skipped: 'subtle',
  warning: 'warning',
};

/** Last persisted connection health of a saved source (list + detail pages). */
export function SourceHealthBadge({ source }: { source: Pick<DataSource, 'last_test_status' | 'last_tested_at' | 'last_error_code'> }) {
  const status = source.last_test_status;
  if (!status) {
    return (
      <Badge variant="subtle" size="sm" dot title="No connection test since the last change">
        Not tested
      </Badge>
    );
  }
  const when = source.last_tested_at ? new Date(source.last_tested_at).toLocaleString() : '';
  const reason = source.last_error_code ? SOURCE_ERROR_LABEL[source.last_error_code] : '';
  const title = [reason, when && `Tested ${when}`].filter(Boolean).join(' · ');
  if (status === 'ok') return <Badge variant="success" size="sm" dot title={title}>Healthy</Badge>;
  if (status === 'warning') return <Badge variant="warning" size="sm" dot title={title}>Warning</Badge>;
  return <Badge variant="danger" size="sm" dot title={title}>{reason || 'Error'}</Badge>;
}

/** Structured result of a connection test: status, per-check states, warnings. */
export function SourceTestResultPanel({ result }: { result: DataSourceTestResult }) {
  const tone =
    result.status === 'ok' ? 'border-success/40 bg-success/5'
      : result.status === 'warning' ? 'border-warning/40 bg-warning/5'
        : 'border-danger/40 bg-danger/5';
  return (
    <div className={`rounded-md border p-3 text-sm ${tone}`} data-testid="source-test-result">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">
          {result.status === 'ok' ? 'Connection OK' : result.status === 'warning' ? 'Connected with warnings' : 'Connection failed'}
        </span>
        {result.error_code && (
          <Badge variant={result.status === 'error' ? 'danger' : 'warning'} size="sm">
            {SOURCE_ERROR_LABEL[result.error_code] ?? result.error_code}
          </Badge>
        )}
        <span className="text-tiny text-text-quaternary">{result.duration_ms} ms</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {Object.entries(result.checks || {}).map(([k, v]) => (
          <Badge key={k} variant={CHECK_VARIANT[v as DataSourceCheckState] ?? 'subtle'} size="sm">
            {CHECK_LABEL[k] ?? k}: {v}
          </Badge>
        ))}
      </div>
      {result.message && <p className="mt-2 text-text-secondary break-words">{result.message}</p>}
      {result.warnings?.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-tiny text-warning">
          {result.warnings.map((w, i) => <li key={i} className="break-words">{w}</li>)}
        </ul>
      )}
    </div>
  );
}

const BLOCKER_LABEL: Record<string, string> = {
  dataset: 'Dataset',
  dataset_snapshot: 'Dataset snapshot host',
  knowledge_doc: 'Knowledge doc',
};

/** Map the 409 body of DELETE /datasources/{id} to the shared constraint modal shape. */
export function blockersToConstraints(blockers: DataSourceDeleteBlocker[] | undefined) {
  return (blockers || []).map((b) => ({ type: b.kind, id: b.id, name: b.name }));
}

export function describeBlockers(blockers: DataSourceDeleteBlocker[] | undefined): string {
  return (blockers || [])
    .map((b) => `${BLOCKER_LABEL[b.kind] ?? b.kind} "${b.name}"`)
    .join(', ');
}
