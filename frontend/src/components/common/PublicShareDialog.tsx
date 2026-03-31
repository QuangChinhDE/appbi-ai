'use client';

import { useState } from 'react';
import { X, Link2, Copy, Check, Trash2, Globe, Filter, ChevronDown, ChevronUp } from 'lucide-react';
import { useShareDashboard, useUnshareDashboard } from '@/hooks/use-dashboards';
import { toast } from 'sonner';
import type { BaseFilter } from '@/lib/filters';

interface PublicShareDialogProps {
  dashboardId: number;
  dashboardName: string;
  currentToken: string | null | undefined;
  globalFilters?: BaseFilter[];
  onClose: () => void;
}

export function PublicShareDialog({
  dashboardId,
  dashboardName,
  currentToken,
  globalFilters = [],
  onClose,
}: PublicShareDialogProps) {
  const [token, setToken] = useState<string | null | undefined>(currentToken);
  const [copied, setCopied] = useState(false);
  // Preset filter IDs to encode into the share link (default: all active filters)
  const [presetFilterIds, setPresetFilterIds] = useState<Set<string>>(
    new Set(globalFilters.map(f => f.id))
  );
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const shareMutation = useShareDashboard();
  const unshareMutation = useUnshareDashboard();

  // Always use runtime origin so custom domains work automatically
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const presetFilters = globalFilters.filter(f => presetFilterIds.has(f.id));
  const filterParam = presetFilters.length > 0
    ? `?filters=${encodeURIComponent(JSON.stringify(presetFilters))}`
    : '';
  const resolvedPublicUrl = token ? `${origin.replace(/\/$/, '')}/d/${token}${filterParam}` : null;

  const handleGenerate = async () => {
    try {
      const result = await shareMutation.mutateAsync(dashboardId);
      setToken(result.share_token);
    } catch {
      toast.error('Failed to generate share link.');
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

  const handleCopy = () => {
    if (!resolvedPublicUrl) return;
    navigator.clipboard.writeText(resolvedPublicUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const toggleFilter = (id: string) => {
    setPresetFilterIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const formatFilterLabel = (f: BaseFilter): string => {
    const field = f.label ?? f.field;
    const val = Array.isArray(f.value) ? f.value.join(' – ') : String(f.value ?? '');
    return `${field}: ${val}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="mx-4 w-full max-w-md rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <div className="flex items-center gap-2">
            <Globe className="h-5 w-5 text-blue-600" />
            <h2 className="text-base font-semibold text-gray-900">Public link</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-gray-500">
            Anyone with the link can view <strong>{dashboardName}</strong> in read-only mode — no login required.
          </p>

          {/* Preset filters section */}
          {globalFilters.length > 0 && (
            <div className="rounded-lg border border-gray-200">
              <button
                type="button"
                onClick={() => setFiltersExpanded(v => !v)}
                className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                <span className="flex items-center gap-2">
                  <Filter className="h-4 w-4 text-gray-400" />
                  Preset filters
                  {presetFilterIds.size > 0 && (
                    <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-xs font-semibold text-blue-700">
                      {presetFilterIds.size}
                    </span>
                  )}
                </span>
                {filtersExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
              {filtersExpanded && (
                <div className="border-t border-gray-100 px-3 py-2 space-y-1">
                  <p className="text-xs text-gray-400 mb-2">
                    Selected filters will be applied when anyone opens this link.
                  </p>
                  {globalFilters.map(f => (
                    <label key={f.id} className="flex items-center gap-2 cursor-pointer rounded px-1 py-1 hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={presetFilterIds.has(f.id)}
                        onChange={() => toggleFilter(f.id)}
                        className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600"
                      />
                      <span className="text-xs text-gray-700 truncate">{formatFilterLabel(f)}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {resolvedPublicUrl ? (
            <>
              {/* Link display */}
              <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                <Link2 className="h-4 w-4 flex-shrink-0 text-gray-400" />
                <span className="flex-1 truncate text-xs text-gray-700 font-mono">{resolvedPublicUrl}</span>
                <button
                  onClick={handleCopy}
                  className="flex-shrink-0 rounded p-1 text-gray-400 hover:text-blue-600"
                  title="Copy link"
                >
                  {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>

              <div className="flex items-center justify-between gap-3">
                <button
                  onClick={handleCopy}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? 'Copied!' : 'Copy link'}
                </button>
                <button
                  onClick={handleRevoke}
                  disabled={unshareMutation.isPending}
                  className="flex items-center gap-2 rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                  Revoke
                </button>
              </div>

              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Revoking the link immediately disables public access. You can always generate a new one.
              </p>
            </>
          ) : (
            <>
              <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center">
                <Globe className="mx-auto mb-2 h-8 w-8 text-gray-300" />
                <p className="text-sm text-gray-500">No public link yet</p>
                <p className="mt-1 text-xs text-gray-400">Generate a link to share this dashboard externally.</p>
              </div>
              <button
                onClick={handleGenerate}
                disabled={shareMutation.isPending}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                <Link2 className="h-4 w-4" />
                {shareMutation.isPending ? 'Generating…' : 'Generate public link'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
