'use client';

import { useEffect, useMemo, useState } from 'react';
import { Link2, Copy, Check, Trash2, Globe, Filter, ChevronDown, ChevronUp } from 'lucide-react';
import { useShareDashboard, useUnshareDashboard } from '@/hooks/use-dashboards';
import { useFilterDistinctValues } from '@/hooks/use-filter-distinct-values';
import { DashboardFilterBar } from '@/components/dashboards/DashboardFilterBar';
import { toast } from '@/lib/toast';
import { getFilterDisplayLabel, type BaseFilter, type ColumnInfo } from '@/lib/filters';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';

interface PublicShareDialogProps {
  dashboardId: number;
  dashboardName: string;
  currentToken: string | null | undefined;
  globalFilters?: BaseFilter[];
  currentPublicFilters?: BaseFilter[];
  availableColumns?: ColumnInfo[];
  columnChartCount?: Map<string, number>;
  distinctValues?: Record<string, string[]>;
  onClose: () => void;
}

export function PublicShareDialog({
  dashboardId,
  dashboardName,
  currentToken,
  globalFilters = [],
  currentPublicFilters = [],
  availableColumns = [],
  columnChartCount = new Map<string, number>(),
  distinctValues = {},
  onClose,
}: PublicShareDialogProps) {
  const [token, setToken] = useState<string | null | undefined>(currentToken);
  const [copied, setCopied] = useState(false);
  const [publicFilters, setPublicFilters] = useState<BaseFilter[]>(currentPublicFilters.length > 0 ? currentPublicFilters : globalFilters);
  const [savedPublicFilters, setSavedPublicFilters] = useState<BaseFilter[]>(currentPublicFilters.length > 0 ? currentPublicFilters : globalFilters);
  const [filtersExpanded, setFiltersExpanded] = useState(!currentToken || currentPublicFilters.length === 0);
  const shareMutation = useShareDashboard();
  const unshareMutation = useUnshareDashboard();

  // Always use runtime origin so custom domains work automatically
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const resolvedPublicUrl = token ? `${origin.replace(/\/$/, '')}/d/${token}` : null;
  const filtersDirty = useMemo(
    () => JSON.stringify(publicFilters) !== JSON.stringify(savedPublicFilters),
    [publicFilters, savedPublicFilters],
  );
  const { distinctValues: resolvedDistinctValues, droppedFiltersByColumn: resolvedDroppedFilters } =
    useFilterDistinctValues(availableColumns, publicFilters, distinctValues);

  useEffect(() => {
    const next = currentPublicFilters.length > 0 ? currentPublicFilters : globalFilters;
    setPublicFilters(next);
    setSavedPublicFilters(next);
  }, [currentPublicFilters, globalFilters]);

  useEffect(() => {
    if (!token || publicFilters.length === 0) {
      setFiltersExpanded(true);
    }
  }, [token, publicFilters.length]);

  const handleSavePublicLink = async () => {
    try {
      const result = await shareMutation.mutateAsync({
        dashboardId,
        publicFiltersConfig: publicFilters,
      });
      setToken(result.share_token);
      setSavedPublicFilters(publicFilters);
      return result.share_token;
    } catch {
      toast.error('Failed to generate share link.');
      return null;
    }
  };

  const handleRevoke = async () => {
    try {
      await unshareMutation.mutateAsync(dashboardId);
      setToken(null);
      toast.success('Share link revoked.');
    } catch {
      toast.error('Failed to revoke link.');
    }
  };

  const handleCopy = async () => {
    let nextToken = token;
    if (!nextToken || filtersDirty) {
      nextToken = await handleSavePublicLink();
    }
    if (!nextToken) return;
    const nextUrl = `${origin.replace(/\/$/, '')}/d/${nextToken}`;
    navigator.clipboard.writeText(nextUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatFilterLabel = (f: BaseFilter): string => {
    const field = getFilterDisplayLabel(f);
    const val = Array.isArray(f.value) ? f.value.join(' – ') : String(f.value ?? '');
    return `${field}: ${val}`;
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Public link"
      size="md"
    >
      <div className="space-y-4">
        <p className="text-caption text-text-tertiary">
          Anyone with the link can view <strong className="text-text-primary">{dashboardName}</strong> in read-only mode — no login required.
        </p>

        {/* Public filters section */}
        <div className="rounded-md border border-[rgb(var(--border-line))]">
          <button
            type="button"
            onClick={() => setFiltersExpanded(v => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-caption font-emphasis text-text-secondary hover:bg-surface-2"
          >
            <span className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-text-quaternary" />
              Public link filters
              {publicFilters.length > 0 && (
                <Badge variant="brand" size="xs">{publicFilters.length}</Badge>
              )}
            </span>
            {filtersExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {filtersExpanded && (
            <div className="border-t border-[rgb(var(--border-line))] px-3 py-2 space-y-2">
              <p className="text-tiny text-text-tertiary">
                These filters are saved on the server and enforced for everyone opening this link.
              </p>
              {availableColumns.length > 0 ? (
                <DashboardFilterBar
                  columns={availableColumns}
                  columnChartCount={columnChartCount}
                  distinctValues={resolvedDistinctValues}
                  filters={publicFilters}
                  onFiltersChange={setPublicFilters}
                />
              ) : publicFilters.length > 0 ? (
                <div className="space-y-1">
                  {publicFilters.map(f => (
                    <div key={f.id} className="rounded px-1 py-1 text-tiny text-text-secondary">
                      {formatFilterLabel(f)}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-md bg-warning/10 px-3 py-2 text-tiny text-warning">
                  This dialog does not currently have chart column context, so new filters cannot be added here.
                  Open the dashboard detail page, then open Public link there to add filters before sharing.
                </div>
              )}
            </div>
          )}
        </div>

        {resolvedPublicUrl ? (
          <>
            {/* Link display */}
            <div className="flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
              <Link2 className="h-4 w-4 flex-shrink-0 text-text-quaternary" />
              <span className="flex-1 truncate text-tiny text-text-secondary font-mono">{resolvedPublicUrl}</span>
              <button
                onClick={handleCopy}
                className="flex-shrink-0 rounded p-1 text-text-quaternary hover:text-brand"
                title="Copy link"
              >
                {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                fullWidth
                onClick={handleCopy}
                leadingIcon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              >
                {copied ? 'Copied!' : filtersDirty ? 'Save and copy link' : 'Copy link'}
              </Button>
              {token && filtersDirty && (
                <Button variant="secondary" onClick={handleSavePublicLink}>
                  Save filters
                </Button>
              )}
              <Button
                variant="danger"
                onClick={handleRevoke}
                disabled={unshareMutation.isPending}
                leadingIcon={<Trash2 className="h-4 w-4" />}
              >
                Revoke
              </Button>
            </div>

            <p className="text-tiny text-warning bg-warning/10 border border-warning/20 rounded-md px-3 py-2">
              Revoking the link immediately disables public access. You can always generate a new one.
            </p>
          </>
        ) : (
          <>
            <div className="rounded-md border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 px-4 py-6 text-center">
              <Globe className="mx-auto mb-2 h-8 w-8 text-text-quaternary" />
              <p className="text-caption text-text-tertiary">No public link yet</p>
              <p className="mt-1 text-tiny text-text-quaternary">Generate a link to share this dashboard externally.</p>
            </div>
            <Button
              variant="primary"
              fullWidth
              onClick={handleSavePublicLink}
              disabled={shareMutation.isPending}
              loading={shareMutation.isPending}
              leadingIcon={<Link2 className="h-4 w-4" />}
            >
              {shareMutation.isPending ? 'Generating…' : 'Generate public link'}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
