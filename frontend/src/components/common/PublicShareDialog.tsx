'use client';

import { useState } from 'react';
import { X, Link2, Copy, Check, Trash2, Globe } from 'lucide-react';
import { useShareDashboard, useUnshareDashboard } from '@/hooks/use-dashboards';
import { toast } from 'sonner';

interface PublicShareDialogProps {
  dashboardId: number;
  dashboardName: string;
  currentToken: string | null | undefined;
  onClose: () => void;
}

export function PublicShareDialog({
  dashboardId,
  dashboardName,
  currentToken,
  onClose,
}: PublicShareDialogProps) {
  const [token, setToken] = useState<string | null | undefined>(currentToken);
  const [copied, setCopied] = useState(false);
  const shareMutation = useShareDashboard();
  const unshareMutation = useUnshareDashboard();

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const publicBaseUrl = process.env.NEXT_PUBLIC_APP_URL || origin;
  const resolvedPublicUrl = token ? `${publicBaseUrl.replace(/\/$/, '')}/d/${token}` : null;
  const usesLocalhostBase = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(publicBaseUrl);

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
              {usesLocalhostBase && (
                <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  This link currently uses `localhost`, so it only works on this machine. Set `NEXT_PUBLIC_APP_URL` to your real app URL if you want to share it with other people.
                </p>
              )}
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
