'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  Copy,
  Eye,
  EyeOff,
  Globe,
  Loader2,
  Trash2,
} from 'lucide-react';

import { Modal } from '@/components/common/Modal';
import { Button, IconButton } from '@/components/ui/Button';
import { FieldGroup, Input } from '@/components/ui/Input';
import type { Workboard, WorkboardAppView, WorkboardPublicLink } from '@/lib/api/workboards';
import { workboardApi } from '@/lib/api/workboards';
import { toast } from '@/lib/toast';

interface Props {
  workboard: Workboard;
  views: WorkboardAppView[];
  onClose: () => void;
}

export function WorkboardPublicLinksModal({ workboard, views, onClose }: Props) {
  const [links, setLinks] = useState<WorkboardPublicLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(`${workboard.name} Form`);
  const [mode, setMode] = useState<'form' | 'view'>('form');
  const [viewId, setViewId] = useState<string>('');
  const [password, setPassword] = useState('');

  const publicViews = useMemo(
    () => views.filter((view) => ['table', 'deck', 'gallery'].includes(view.kind)),
    [views],
  );
  const origin = typeof window !== 'undefined' ? window.location.origin.replace(/\/$/, '') : '';

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await workboardApi.listPublicLinks(workboard.id);
        if (!cancelled) setLinks(data);
      } catch {
        toast.error('Failed to load public links');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [workboard.id]);

  const createLink = async () => {
    if (!name.trim()) {
      toast.error('Link name is required');
      return;
    }
    if (mode === 'view' && !viewId) {
      toast.error('Pick a public view');
      return;
    }
    setSaving(true);
    try {
      const created = await workboardApi.createPublicLink(workboard.id, {
        name: name.trim(),
        mode,
        view_id: mode === 'view' ? viewId : undefined,
        password: password.trim() || undefined,
      });
      setLinks((current) => [created, ...current]);
      setPassword('');
      toast.success('Public link created');
    } catch (err: unknown) {
      const detail = (
        err as { response?: { data?: { detail?: unknown } } }
      )?.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : 'Create link failed');
    } finally {
      setSaving(false);
    }
  };

  const toggleLink = async (link: WorkboardPublicLink) => {
    try {
      const updated = await workboardApi.updatePublicLink(workboard.id, link.id, {
        is_active: !link.is_active,
      });
      setLinks((current) => current.map((item) => (item.id === link.id ? updated : item)));
    } catch {
      toast.error('Failed to update link');
    }
  };

  const deleteLink = async (link: WorkboardPublicLink) => {
    if (!window.confirm(`Delete public link "${link.name}"?`)) return;
    try {
      await workboardApi.deletePublicLink(workboard.id, link.id);
      setLinks((current) => current.filter((item) => item.id !== link.id));
      toast.success('Public link deleted');
    } catch {
      toast.error('Failed to delete link');
    }
  };

  const copyUrl = async (link: WorkboardPublicLink) => {
    const url = `${origin}/w/${link.token}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Copied public URL');
    } catch {
      toast.error('Failed to copy URL');
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Public Links" size="lg">
      <div className="space-y-5">
        <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <div className="mb-3 flex items-center gap-2">
            <Globe className="h-4 w-4 text-brand" />
            <h3 className="text-body font-emphasis text-text-primary">Create public link</h3>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <FieldGroup label="Link name" required>
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </FieldGroup>

            <FieldGroup label="Mode" required>
              <select
                className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-body"
                value={mode}
                onChange={(event) => setMode(event.target.value as 'form' | 'view')}
              >
                <option value="form">Public form</option>
                <option value="view">Readonly view</option>
              </select>
            </FieldGroup>

            {mode === 'view' ? (
              <FieldGroup label="Public view" required>
                <select
                  className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-body"
                  value={viewId}
                  onChange={(event) => setViewId(event.target.value)}
                >
                  <option value="">-- Select a view --</option>
                  {publicViews.map((view) => (
                    <option key={view.id} value={view.id}>
                      {view.label} ({view.kind})
                    </option>
                  ))}
                </select>
              </FieldGroup>
            ) : null}

            <FieldGroup label="Password" description="Optional. Leave blank for open access.">
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Optional"
              />
            </FieldGroup>
          </div>

          <div className="mt-4 flex justify-end">
            <Button
              variant="primary"
              onClick={createLink}
              disabled={saving}
              leadingIcon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
            >
              Create link
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-body font-emphasis text-text-primary">Existing links</h3>
            {loading ? <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" /> : null}
          </div>

          {loading ? null : links.length === 0 ? (
            <div className="rounded-md border border-dashed border-[rgb(var(--border-line))] px-4 py-10 text-center text-caption text-text-tertiary">
              No public links yet.
            </div>
          ) : (
            <div className="space-y-3">
              {links.map((link) => (
                <div
                  key={link.id}
                  className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-caption font-emphasis text-text-primary">{link.name}</span>
                        <span className="rounded-full bg-brand/10 px-2 py-0.5 text-label uppercase tracking-wide text-brand">
                          {link.mode}
                        </span>
                        {link.has_password ? (
                          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-label text-amber-700">
                            password
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 text-tiny text-text-tertiary">
                        {origin}/w/{link.token}
                      </div>
                      <div className="mt-1 text-tiny text-text-tertiary">
                        Accesses: {link.access_count}
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      <IconButton aria-label="Copy URL" variant="ghost" size="sm" onClick={() => copyUrl(link)}>
                        <Copy className="h-4 w-4" />
                      </IconButton>
                      <IconButton
                        aria-label={link.is_active ? 'Disable link' : 'Enable link'}
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleLink(link)}
                      >
                        {link.is_active ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                      </IconButton>
                      <IconButton aria-label="Delete link" variant="ghost" size="sm" onClick={() => deleteLink(link)}>
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </IconButton>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default WorkboardPublicLinksModal;
