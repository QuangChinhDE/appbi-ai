/**
 * Workboard › Settings — the real, full-page settings home.
 *
 * A two-pane settings layout (left section nav + content) that fills the tab —
 * NOT a narrow centered column. Owns everything that used to live in the Build
 * canvas's "App settings" modal, reorganised into the product IA:
 *
 *   General      — App name · Description · Identity (+ App health)
 *   Data         — Dataset · Data binding · Rebind / mapping
 *   Appearance   — Branding · Theme · Login appearance
 *   Navigation   — Mobile · Desktop
 *   Documents    — Print template
 *   Advanced     — Auto-number · Export · Technical settings
 *
 * Layout-driven sections (Appearance/Navigation/Documents/Auto-number) edit the
 * mini-app layout and AUTOSAVE (same hook as the builder). Board-DB fields
 * (name/description/icon, optimistic-lock column) save explicitly. Changing the
 * dataset runs the two-phase rebind (preview impact → apply to the draft).
 */
'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  Compass,
  Database,
  Download,
  FileText,
  Info,
  Loader2,
  Palette,
  RefreshCw,
  SlidersHorizontal,
  Wrench,
} from 'lucide-react';

import {
  useWorkboard,
  useWorkboardReadinessAudit,
  useUpdateWorkboard,
} from '@/hooks/use-workboards';
import { useDatasets } from '@/hooks/use-datasets';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/common/Modal';
import { toast } from '@/lib/toast';
import { apiClient } from '@/lib/api-client';
import {
  workboardApi,
  type Workboard,
  type WorkboardAuditIssue,
  type RebindPreview,
} from '@/lib/api/workboards';
import { ensureLayout, type MiniAppLayoutSpec } from '@/components/workboards/builder/types';
import { useDebouncedAutosave } from '@/components/workboards/builder/useDebouncedAutosave';
import {
  DatasetSection,
  NavigationSection,
  ThemeSection,
  ExperienceStudioSection,
  PrintTemplateSection,
  AutoNumberSection,
  SettingsPanel,
} from '@/components/workboards/builder/AppSettingsEditor';
import WorkboardImportExportModal from '@/components/workboards/builder/WorkboardImportExportModal';
import { registerAutosaveFlush } from '@/components/workboards/builder/autosaveFlushRegistry';
import { useI18n } from '@/providers/LanguageProvider';

type SectionKey = 'general' | 'data' | 'appearance' | 'navigation' | 'documents' | 'advanced';

interface DatasetTableInfo {
  id: number;
  display_name: string;
  source_table_name?: string;
  columns: { name: string; type?: string }[];
}

interface DatasetTableApi {
  id: number;
  display_name: string;
  source_table_name?: string;
  columns_cache?: unknown;
}

function columnsFromCache(cache: unknown): { name: string; type?: string }[] {
  const arr: unknown[] = Array.isArray(cache)
    ? cache
    : cache && typeof cache === 'object' && Array.isArray((cache as { columns?: unknown }).columns)
      ? (cache as { columns: unknown[] }).columns
      : [];
  return arr
    .filter((c): c is { name: unknown; type?: unknown } =>
      Boolean(c && typeof c === 'object' && 'name' in c),
    )
    .map((c) => ({ name: String(c.name), type: c.type ? String(c.type) : undefined }));
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

function getSections(t: Translate): Array<{ key: SectionKey; label: string; icon: React.ReactNode; hint: string }> {
  return [
    { key: 'general', label: t('workboards.settings.sections.general'), icon: <Info className="h-4 w-4" />, hint: t('workboards.settings.sections.generalHint') },
    { key: 'data', label: t('workboards.settings.sections.data'), icon: <Database className="h-4 w-4" />, hint: t('workboards.settings.sections.dataHint') },
    { key: 'appearance', label: t('workboards.settings.sections.appearance'), icon: <Palette className="h-4 w-4" />, hint: t('workboards.settings.sections.appearanceHint') },
    { key: 'navigation', label: t('workboards.settings.sections.navigation'), icon: <Compass className="h-4 w-4" />, hint: t('workboards.settings.sections.navigationHint') },
    { key: 'documents', label: t('workboards.settings.sections.documents'), icon: <FileText className="h-4 w-4" />, hint: t('workboards.settings.sections.documentsHint') },
    { key: 'advanced', label: t('workboards.settings.sections.advanced'), icon: <SlidersHorizontal className="h-4 w-4" />, hint: t('workboards.settings.sections.advancedHint') },
  ];
}

export default function WorkboardSettingsPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { data: workboard } = useWorkboard(id);
  if (!workboard) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-text-tertiary" />
      </div>
    );
  }
  // Keyed on id so a different board remounts (fresh lazy-init of layout state).
  return <SettingsInner key={workboard.id} workboard={workboard} />;
}

function SettingsInner({ workboard }: { workboard: Workboard }) {
  const { t } = useI18n();
  const id = workboard.id;
  const update = useUpdateWorkboard();
  const { data: datasets = [] } = useDatasets();
  const canEdit = getResourcePermissions(workboard.user_permission ?? undefined).canEdit;

  const [section, setSection] = useState<SectionKey>('general');
  const sections = getSections(t);

  // ── Layout state + autosave (Appearance / Navigation / Documents / Auto-number).
  // Lazy-init from the loaded board (like the builder) so there's no
  // default→real flip that would trigger a spurious save on open.
  const [layout, setLayoutRaw] = useState<MiniAppLayoutSpec>(() => ensureLayout(workboard.layout_json));
  const setLayout = canEdit ? setLayoutRaw : () => {};
  const autosave = useDebouncedAutosave(id, layout, canEdit);

  // Let the topbar Publish button drain THIS page's pending autosave before it
  // snapshots the draft (same registry the builder uses; only one tab mounts at
  // a time so there's no clash).
  useEffect(() => {
    registerAutosaveFlush(autosave.flush);
    return () => registerAutosaveFlush(null);
  }, [autosave.flush]);

  // ── Board-DB fields (General identity + Advanced technical) — explicit save.
  const [name, setName] = useState(workboard.name || '');
  const [description, setDescription] = useState(workboard.description || '');
  const [icon, setIcon] = useState(workboard.icon || '');
  const [lockColumn, setLockColumn] = useState(workboard.optimistic_lock_column || '');

  // ── Dataset rebind (two-phase) + import/export.
  const [rebindPlan, setRebindPlan] = useState<(RebindPreview & { targetDatasetId: number }) | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [tables, setTables] = useState<DatasetTableInfo[]>([]);

  const identityDirty =
    name.trim() !== (workboard.name || '') ||
    (description.trim() || '') !== (workboard.description || '') ||
    (icon.trim() || '') !== (workboard.icon || '');
  const lockDirty = (lockColumn.trim() || '') !== (workboard.optimistic_lock_column || '');

  const saveBoard = async (patch: Record<string, unknown>, okMsg: string) => {
    try {
      await update.mutateAsync({ id, data: patch });
      toast.success(okMsg);
    } catch {
      toast.error(t('workboards.settings.saveFailed'));
    }
  };

  const handleDatasetChange = async (nextDatasetId: number) => {
    if (!canEdit || !nextDatasetId || nextDatasetId === workboard.dataset_id) return;
    try {
      // Persist pending draft edits so the preview reflects them — but ONLY when
      // something is actually pending. flush() force-saves unconditionally, so
      // calling it while clean would bump the draft version and spuriously flip
      // the board to "unpublished changes".
      if (autosave.status === 'pending' || autosave.status === 'saving') {
        await autosave.flush();
      }
      const plan = await workboardApi.previewRebind(id, nextDatasetId);
      setRebindPlan({ ...plan, targetDatasetId: nextDatasetId });
    } catch {
      toast.error(t('workboards.settings.rebindPreviewFailed'));
    }
  };

  const applyRebind = async () => {
    if (!rebindPlan) return;
    try {
      const updated = await update.mutateAsync({
        id,
        data: { dataset_id: rebindPlan.targetDatasetId },
      });
      setLayoutRaw(ensureLayout(updated.layout_json)); // reflect the rebound draft
      toast.success(t('workboards.settings.datasetChangedToast'));
      setRebindPlan(null);
    } catch {
      toast.error(t('workboards.settings.datasetChangeFailed'));
    }
  };

  useEffect(() => {
    let alive = true;
    setTables([]);
    (async () => {
      try {
        const r = await apiClient.get(`/datasets/${workboard.dataset_id}/tables`);
        const arr = Array.isArray(r.data) ? (r.data as DatasetTableApi[]) : [];
        if (!alive) return;
        setTables(
          arr.map((table) => ({
            id: table.id,
            display_name: table.display_name,
            source_table_name: table.source_table_name,
            columns: columnsFromCache(table.columns_cache),
          })),
        );
      } catch {
        if (alive) setTables([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workboard.dataset_id]);

  return (
    <div className="flex h-full min-h-0">
      {/* Left section nav */}
      <nav className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-[rgb(var(--border-line))] bg-surface-1 p-2">
        <div className="px-2 py-2 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
          {t('workboards.settings.title')}
        </div>
        {sections.map((s) => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            className={`flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
              section === s.key
                ? 'bg-brand/10 text-brand'
                : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
            }`}
          >
            <span className="mt-0.5 shrink-0">{s.icon}</span>
            <span className="min-w-0">
              <span className="block text-caption font-medium">{s.label}</span>
              <span className="block truncate text-tiny text-text-tertiary">{s.hint}</span>
            </span>
          </button>
        ))}
        <div className="mt-auto px-2 pt-3">
          <AutosaveBadge status={autosave.status} savedAt={autosave.savedAt} error={autosave.errorMessage} />
        </div>
      </nav>

      {/* Content */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="max-w-4xl space-y-5 p-6">
          {section === 'general' && (
            <>
              <AppHealthCard workboardId={id} />
              <SettingsPanel title={t('workboards.settings.appInfo')} icon={<Info className="h-4 w-4" />}>
                <div className="space-y-4">
                  <Field label={t('workboards.settings.appName')}>
                    <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} placeholder={t('workboards.settings.appNamePlaceholder')} />
                  </Field>
                  <Field label={t('workboards.settings.description')}>
                    <Textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canEdit} rows={3} placeholder={t('workboards.settings.descriptionPlaceholder')} />
                  </Field>
                </div>
              </SettingsPanel>

              <SettingsPanel title={t('workboards.settings.identity')} icon={<Info className="h-4 w-4" />}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t('workboards.settings.iconEmoji')}>
                    <Input value={icon} onChange={(e) => setIcon(e.target.value)} disabled={!canEdit} placeholder={t('workboards.settings.iconEmojiPlaceholder')} maxLength={8} />
                  </Field>
                  <Field label={t('workboards.settings.slugReadonly')}>
                    <Input value={workboard.slug || ''} readOnly disabled />
                  </Field>
                </div>
                <p className="mt-2 text-tiny text-text-tertiary">
                  {t('workboards.settings.slugHint')}
                </p>
              </SettingsPanel>

              {canEdit && (
                <SaveBar
                  dirty={identityDirty}
                  loading={update.isPending}
                  onSave={() =>
                    saveBoard(
                      { name: name.trim(), description: description.trim(), icon: icon.trim() || undefined },
                      t('workboards.settings.appInfoSaved'),
                    )
                  }
                />
              )}
            </>
          )}

          {section === 'data' && (
            <>
              <SettingsPanel title="Dataset" icon={<Database className="h-4 w-4" />}>
                <DatasetSection
                  datasets={datasets}
                  currentDatasetId={workboard.dataset_id}
                  datasetChangePending={update.isPending}
                  onDatasetChange={handleDatasetChange}
                />
              </SettingsPanel>
              <SettingsPanel title={t('workboards.settings.dataBindingReadonly')} icon={<Database className="h-4 w-4" />}>
                <div className="grid gap-3 sm:grid-cols-2 text-caption">
                  <ReadonlyRow label={t('workboards.settings.primaryTableId')} value={String(workboard.primary_table_id ?? '—')} />
                  <ReadonlyRow label={t('workboards.settings.primaryKey')} value={(workboard.primary_key_columns || []).join(', ') || '—'} />
                </div>
                <p className="mt-2 text-tiny text-text-tertiary">
                  {t('workboards.settings.dataBindingHint')}
                </p>
              </SettingsPanel>
            </>
          )}

          {section === 'appearance' && (
            <>
              <SettingsPanel title={t('workboards.settings.experienceStudio')} icon={<Palette className="h-4 w-4" />}>
                <ExperienceStudioSection
                  layout={layout}
                  onChange={setLayout}
                  disabled={!canEdit}
                />
              </SettingsPanel>
              <SettingsPanel title={t('workboards.settings.legacyBranding')} icon={<Palette className="h-4 w-4" />}>
                <ThemeSection layout={layout} onChange={setLayout} />
              </SettingsPanel>
            </>
          )}

          {section === 'navigation' && (
            <SettingsPanel title={t('workboards.settings.navigation')} icon={<Compass className="h-4 w-4" />}>
              <NavigationSection layout={layout} onChange={setLayout} />
            </SettingsPanel>
          )}

          {section === 'documents' && (
            <SettingsPanel title={t('workboards.settings.printTemplate')} icon={<FileText className="h-4 w-4" />}>
              <PrintTemplateSection layout={layout} onChange={setLayout} />
            </SettingsPanel>
          )}

          {section === 'advanced' && (
            <>
              <SettingsPanel title={t('workboards.settings.autoNumber')} icon={<SlidersHorizontal className="h-4 w-4" />}>
                <AutoNumberSection layout={layout} tables={tables} onChange={setLayout} />
              </SettingsPanel>

              <SettingsPanel title={t('workboards.settings.importExport')} icon={<Download className="h-4 w-4" />}>
                <p className="mb-3 text-caption text-text-tertiary">
                  {t('workboards.settings.importExportDescription')}
                </p>
                <Button variant="secondary" size="sm" leadingIcon={<Download className="h-3.5 w-3.5" />} onClick={() => setShowExport(true)}>
                  {t('workboards.settings.exportApp')}
                </Button>
              </SettingsPanel>

              <SettingsPanel title={t('workboards.settings.technical')} icon={<Wrench className="h-4 w-4" />}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <ReadonlyRow label={t('workboards.settings.writeMode')} value={workboard.write_mode || '—'} />
                  <Field label={t('workboards.settings.optimisticLockColumn')}>
                    <Input value={lockColumn} onChange={(e) => setLockColumn(e.target.value)} disabled={!canEdit} placeholder={t('workboards.settings.optimisticLockPlaceholder')} />
                  </Field>
                </div>
                <p className="mt-2 text-tiny text-text-tertiary">
                  {t('workboards.settings.optimisticLockHint')}
                </p>
                {canEdit && (
                  <div className="mt-3">
                    <SaveBar
                      dirty={lockDirty}
                      loading={update.isPending}
                      onSave={() => saveBoard({ optimistic_lock_column: lockColumn.trim() }, t('workboards.settings.technicalSaved'))}
                    />
                  </div>
                )}
              </SettingsPanel>
            </>
          )}
        </div>
      </div>

      {rebindPlan && (
        <Modal
          isOpen
          onClose={() => setRebindPlan(null)}
          title={t('workboards.settings.rebindTitle')}
          size="md"
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setRebindPlan(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" size="sm" onClick={applyRebind} loading={update.isPending}>
                {t('workboards.settings.applyToDraft')}
              </Button>
            </>
          }
        >
          <p className="mb-3 text-caption text-text-secondary">
            {t('workboards.settings.rebindSummary', {
              remap: rebindPlan.remap_count,
              clear: rebindPlan.clear_count,
            })}
          </p>
          {rebindPlan.remapped.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
                {t('workboards.settings.remapped')}
              </div>
              <ul className="space-y-1">
                {rebindPlan.remapped.map((r, i) => (
                  <li key={i} className="rounded border border-success/25 bg-success/5 px-2 py-1 text-tiny text-text-secondary">
                    {r.screen_title || r.screen_id || r.table_name || '—'}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {rebindPlan.cleared.length > 0 && (
            <div>
              <div className="mb-1 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
                {t('workboards.settings.cleared')}
              </div>
              <ul className="space-y-1">
                {rebindPlan.cleared.map((r, i) => (
                  <li key={i} className="rounded border border-warning/30 bg-warning/5 px-2 py-1 text-tiny text-text-secondary">
                    {r.screen_title || r.screen_id || r.table_name || '—'} — {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Modal>
      )}

      {showExport && (
        <WorkboardImportExportModal workboard={workboard} mode="export" onClose={() => setShowExport(false)} />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-caption font-medium text-text-secondary">{label}</label>
      {children}
    </div>
  );
}

function ReadonlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-3 py-2">
      <div className="text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">{label}</div>
      <div className="mt-0.5 truncate text-caption text-text-primary">{value}</div>
    </div>
  );
}

function SaveBar({ dirty, loading, onSave }: { dirty: boolean; loading: boolean; onSave: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-end gap-2">
      {dirty && <span className="text-tiny text-text-tertiary">{t('workboards.settings.unsavedChanges')}</span>}
      <Button variant="primary" size="sm" onClick={onSave} loading={loading} disabled={!dirty}>
        {t('workboards.settings.saveChanges')}
      </Button>
    </div>
  );
}

function AutosaveBadge({
  status,
  savedAt,
  error,
}: {
  status: 'idle' | 'pending' | 'saving' | 'saved' | 'error';
  savedAt: Date | null;
  error: string | null;
}) {
  const { t } = useI18n();
  if (status === 'saving' || status === 'pending') {
    return (
      <span className="flex items-center gap-1.5 text-tiny text-text-tertiary">
        <Loader2 className="h-3 w-3 animate-spin" /> {t('workboards.settings.saving')}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="flex items-center gap-1.5 text-tiny text-danger" title={error || ''}>
        <AlertTriangle className="h-3 w-3" /> {t('workboards.settings.saveError')}
      </span>
    );
  }
  if (status === 'saved' && savedAt) {
    return (
      <span className="flex items-center gap-1.5 text-tiny text-success">
        <CheckCircle2 className="h-3 w-3" /> {t('workboards.settings.autoSaved')}
      </span>
    );
  }
  return <span className="text-tiny text-text-quaternary">{t('workboards.settings.autosave')}</span>;
}

function AppHealthCard({ workboardId }: { workboardId: number }) {
  const { t } = useI18n();
  const { data: audit, isFetching, refetch } = useWorkboardReadinessAudit(workboardId);
  const errors = (audit?.issues || []).filter((i: WorkboardAuditIssue) => i.severity === 'error');
  const warnings = (audit?.issues || []).filter((i: WorkboardAuditIssue) => i.severity === 'warning');
  const healthy = audit?.ok && errors.length === 0;

  return (
    <section
      className={`rounded-xl border p-4 ${
        healthy ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {healthy ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          )}
          <div>
            <p className={`text-caption font-semibold ${healthy ? 'text-success' : 'text-danger'}`}>
              {healthy
                ? t('workboards.settings.readyToPublish')
                : t('workboards.settings.notReadyToPublish', {
                    errors: errors.length,
                    warnings: warnings.length,
                  })}
            </p>
            {errors.length > 0 && (
              <ul className="mt-2 space-y-1">
                {errors.map((issue, idx) => (
                  <li key={idx} className="text-tiny text-text-secondary">
                    <strong className="text-text-primary">{issue.screen_title || issue.screen_id || 'App'}</strong>: {issue.detail}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <Button variant="ghost" size="xs" onClick={() => void refetch()} leadingIcon={<RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />}>
          {t('workboards.settings.refresh')}
        </Button>
      </div>
    </section>
  );
}
