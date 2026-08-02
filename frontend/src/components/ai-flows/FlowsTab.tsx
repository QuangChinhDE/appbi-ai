'use client';

/**
 * Flow list + the create wizard.
 *
 * The empty state offers templates rather than a blank canvas, because a blank
 * canvas asks a newcomer to invent a shape they have never seen. Duplicating a
 * working flow teaches the shape and produces something runnable in one click.
 */
import React, { useMemo, useState } from 'react';
import {
  Download, FileStack, Plus, RotateCcw, Sparkles, Trash2, Upload,
} from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Label, Textarea } from '@/components/ui/Input';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import {
  type FlowSummary, cloneFlow, deleteFlow, exportFlow, rollbackFlow,
} from '@/lib/aiFlows';
import { ImportDialog, downloadBundle } from './portability/ImportDialog';
import { EmptyHint, errText, timeAgo } from './shared';

interface Props {
  flows: FlowSummary[];
  canEdit: boolean;
  canPublish: boolean;
  onOpen: (key: string, version: number) => void;
  onChanged: () => void;
}

function slugify(name: string): string {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 48) || 'flow';
}

export function FlowsTab({ flows, canEdit, canPublish, onOpen, onChanged }: Props) {
  const { t } = useI18n();
  const [wizard, setWizard] = useState(false);
  const [importing, setImporting] = useState(false);

  const templates = useMemo(() => flows.filter((f) => f.is_builtin), [flows]);
  const mine = useMemo(() => flows.filter((f) => !f.is_builtin), [flows]);

  const statusLabel = (s: string) => t(`aiFlows.status.${s}`);
  const statusTone = (s: string) =>
    s === 'published' ? 'success' : s === 'in_review' ? 'info' : s === 'archived' ? 'subtle' : 'warning';

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-caption text-text-tertiary">{t('aiFlows.flows.subtitle')}</p>
        {canEdit && (
          <div className="flex flex-shrink-0 gap-2">
            <Button variant="secondary" size="sm" onClick={() => setImporting(true)}>
              <Upload className="h-4 w-4" /> {t('aiFlows.port.import')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => setWizard(true)}>
              <Plus className="h-4 w-4" /> {t('aiFlows.flows.create')}
            </Button>
          </div>
        )}
      </div>

      {mine.length === 0 && (
        <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-0 p-5">
          <div className="mb-1 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand" />
            <h3 className="text-caption font-strong text-text-primary">
              {t('aiFlows.flows.empty.title')}
            </h3>
          </div>
          <p className="mb-3 max-w-xl text-tiny text-text-tertiary">
            {t('aiFlows.flows.empty.body')}
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((tpl) => (
              <TemplateCard
                key={tpl.flow_key}
                tpl={tpl}
                disabled={!canEdit}
                onPick={() => setWizard(true)}
                onOpen={() => onOpen(tpl.flow_key, tpl.version)}
              />
            ))}
          </div>
        </div>
      )}

      <FlowTable
        rows={mine.length ? mine : templates}
        statusLabel={statusLabel}
        statusTone={statusTone}
        canEdit={canEdit}
        canPublish={canPublish}
        onOpen={onOpen}
        onChanged={onChanged}
      />

      {mine.length > 0 && templates.length > 0 && (
        <div>
          <h3 className="mb-2 text-caption font-strong text-text-secondary">
            {t('aiFlows.status.builtin')}
          </h3>
          <FlowTable
            rows={templates}
            statusLabel={statusLabel}
            statusTone={statusTone}
            canEdit={canEdit}
            canPublish={canPublish}
            onOpen={onOpen}
            onChanged={onChanged}
          />
        </div>
      )}

      {wizard && (
        <CreateWizard
          templates={templates}
          existing={flows}
          onClose={() => setWizard(false)}
          onCreated={(key, version) => { setWizard(false); onChanged(); onOpen(key, version); }}
        />
      )}

      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={(key, version) => { setImporting(false); onChanged(); onOpen(key, version); }}
        />
      )}
    </div>
  );
}

function TemplateCard({ tpl, disabled, onPick, onOpen }: {
  tpl: FlowSummary; disabled: boolean; onPick: () => void; onOpen: () => void;
}) {
  const { t } = useI18n();
  const lim = tpl.limits ?? {};
  return (
    <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3">
      <div className="mb-1 flex items-center gap-1.5">
        <FileStack className="h-3.5 w-3.5 text-brand" />
        <span className="truncate text-caption font-emphasis text-text-primary">
          {tpl.display_name}
        </span>
      </div>
      <p className="mb-2 line-clamp-2 text-tiny text-text-tertiary">
        {tpl.description || `${tpl.node_count} bước`}
      </p>
      <div className="mb-2 flex flex-wrap gap-1">
        <Badge variant="subtle" size="xs">{tpl.node_count} bước</Badge>
        {lim.max_model_calls != null && (
          <Badge variant="subtle" size="xs">≤{lim.max_model_calls} lượt AI</Badge>
        )}
        {lim.deadline_seconds != null && (
          <Badge variant="subtle" size="xs">{lim.deadline_seconds}s</Badge>
        )}
      </div>
      <div className="flex gap-1">
        <Button variant="secondary" size="xs" disabled={disabled} onClick={onPick}>
          {t('aiFlows.common.clone')}
        </Button>
        <Button variant="ghost" size="xs" onClick={onOpen}>{t('aiFlows.common.view')}</Button>
      </div>
    </div>
  );
}

function FlowTable({ rows, statusLabel, statusTone, canEdit, canPublish, onOpen, onChanged }: {
  rows: FlowSummary[];
  statusLabel: (s: string) => string;
  statusTone: (s: string) => 'success' | 'warning' | 'info' | 'subtle';
  canEdit: boolean;
  canPublish: boolean;
  onOpen: (key: string, version: number) => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  if (!rows.length) return <EmptyHint>{t('aiFlows.runs.empty')}</EmptyHint>;

  return (
    <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))]">
      <table className="w-full text-caption">
        <thead className="bg-surface-2 text-tiny uppercase tracking-wide text-text-quaternary">
          <tr>
            <th className="px-3 py-2 text-left">{t('aiFlows.flows.col.flow')}</th>
            <th className="px-3 py-2 text-left">{t('aiFlows.flows.col.status')}</th>
            <th className="px-3 py-2 text-right">{t('aiFlows.flows.col.steps')}</th>
            <th className="px-3 py-2 text-left">{t('aiFlows.flows.col.updated')}</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr
              key={`${f.flow_key}-${f.version}`}
              className="border-t border-[rgb(var(--border-line))] hover:bg-surface-2"
            >
              <td className="px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="font-emphasis text-text-primary">{f.display_name}</span>
                  {f.is_builtin && <Badge variant="info" size="xs">{t('aiFlows.status.builtin')}</Badge>}
                </div>
                <code className="text-tiny text-text-tertiary">{f.flow_key} · v{f.version}</code>
              </td>
              <td className="px-3 py-2">
                <Badge variant={statusTone(f.status)} size="xs">{statusLabel(f.status)}</Badge>
              </td>
              <td className="px-3 py-2 text-right text-text-secondary">{f.node_count}</td>
              <td className="px-3 py-2 text-tiny text-text-tertiary">
                {timeAgo(f.published_at ?? f.created_at)}
              </td>
              <td className="px-3 py-2">
                <div className="flex justify-end gap-1">
                  <Button variant="ghost" size="xs" onClick={() => onOpen(f.flow_key, f.version)}>
                    {t('aiFlows.common.open')}
                  </Button>
                  <Button
                    variant="ghost" size="xs" title={t('aiFlows.port.export')}
                    onClick={async () => {
                      try {
                        const bundle = await exportFlow(f.flow_key, f.version);
                        downloadBundle(bundle, `${f.flow_key}_v${f.version}.json`);
                        toast.success(t('aiFlows.port.exported'));
                      } catch (e) { toast.error(errText(e)); }
                    }}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                  {canPublish && f.status === 'published' && !f.is_builtin && (
                    <Button
                      variant="ghost" size="xs" title={t('aiFlows.flows.rollback')}
                      onClick={async () => {
                        try {
                          const r = await rollbackFlow(f.flow_key);
                          toast.success(t('aiFlows.versions.rolledBack', { version: r.version }));
                          onChanged();
                        } catch (e) { toast.error(errText(e)); }
                      }}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {canEdit && !f.is_builtin && f.status !== 'published' && (
                    <Button
                      variant="ghost" size="xs"
                      onClick={async () => {
                        if (!confirm(t('aiFlows.flows.deleteConfirm', { key: f.flow_key, version: f.version }))) return;
                        try { await deleteFlow(f.flow_key, f.version); onChanged(); }
                        catch (e) { toast.error(errText(e)); }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-danger" />
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Create wizard ───────────────────────────────────────────────────────────
function CreateWizard({ templates, existing, onClose, onCreated }: {
  templates: FlowSummary[];
  existing: FlowSummary[];
  onClose: () => void;
  onCreated: (key: string, version: number) => void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<1 | 2>(1);
  const [source, setSource] = useState<FlowSummary | null>(templates[0] ?? null);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const keyTaken = existing.some((f) => f.flow_key === key);

  const submit = async () => {
    if (!source || !name.trim() || !key.trim() || keyTaken) return;
    setBusy(true);
    try {
      const created = await cloneFlow(source.flow_key, source.version, key.trim(), name.trim());
      toast.success(t('aiFlows.flows.cloned'));
      onCreated(created.flow_key, created.version);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-body font-strong text-text-primary">{t('aiFlows.create.title')}</h2>

        {step === 1 ? (
          <>
            <p className="mb-3 text-caption text-text-secondary">{t('aiFlows.create.step1')}</p>
            <div className="space-y-2">
              {templates.map((tpl) => (
                <button
                  key={tpl.flow_key}
                  type="button"
                  onClick={() => setSource(tpl)}
                  className={`flex w-full items-start gap-2 rounded-lg border p-3 text-left transition-colors ${
                    source?.flow_key === tpl.flow_key
                      ? 'border-brand bg-brand/[0.05]'
                      : 'border-[rgb(var(--border-line))] hover:bg-surface-2'
                  }`}
                >
                  <FileStack className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand" />
                  <span className="min-w-0">
                    <span className="block text-caption font-emphasis text-text-primary">
                      {tpl.display_name}
                    </span>
                    <span className="block text-tiny text-text-tertiary">
                      {tpl.description || `${tpl.node_count} bước`}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>{t('aiFlows.common.cancel')}</Button>
              <Button variant="primary" disabled={!source} onClick={() => setStep(2)}>
                {t('aiFlows.create.next')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="mb-3 text-caption text-text-secondary">{t('aiFlows.create.step2')}</p>
            <div className="space-y-3">
              <div>
                <Label>{t('aiFlows.create.name')}</Label>
                <Input
                  autoFocus
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!keyTouched) setKey(slugify(e.target.value));
                  }}
                  placeholder="Phân tích doanh thu"
                />
              </div>
              <div>
                <Label>{t('aiFlows.create.key')}</Label>
                <Input
                  value={key}
                  onChange={(e) => { setKeyTouched(true); setKey(slugify(e.target.value)); }}
                />
                <p className={`mt-1 text-tiny ${keyTaken ? 'text-danger' : 'text-text-quaternary'}`}>
                  {keyTaken ? `“${key}” đã tồn tại` : t('aiFlows.create.keyHint')}
                </p>
              </div>
              <div>
                <Label>{t('aiFlows.create.description')}</Label>
                <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
            </div>
            <div className="mt-5 flex justify-between">
              <Button variant="ghost" onClick={() => setStep(1)}>{t('aiFlows.common.back')}</Button>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={onClose}>{t('aiFlows.common.cancel')}</Button>
                <Button
                  variant="primary"
                  disabled={busy || !name.trim() || !key.trim() || keyTaken}
                  onClick={submit}
                >
                  {t('aiFlows.create.submit')}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
