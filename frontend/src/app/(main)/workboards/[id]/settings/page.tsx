/**
 * Workboard › Settings — the real, full-page settings home.
 *
 * A two-pane settings layout (left section nav + content) that fills the tab.
 * Owns everything that used to live in the Build canvas's "App settings" modal,
 * reorganised into a small, product-shaped IA:
 *
 *   General      — App name · Description · Identity (+ App health)
 *   Data         — Dataset · Data binding
 *   Appearance   — Experience Studio (theme/shell) · Navigation · Legacy branding
 *   Advanced     — Auto-number · Print template · Import/Export · Technical
 *
 * ONE explicit save model (no silent autosave): every edit — layout-driven
 * (Appearance/Navigation/Documents/Auto-number) AND board-DB fields
 * (name/description/icon, optimistic-lock column) — is held in local state and
 * applied together only when the author clicks the single Save button in the
 * sticky footer. Discard reverts to the last saved state. Nothing takes effect
 * until Save. Changing the dataset runs the two-phase rebind (preview → apply).
 */
'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  type WorkboardUpdateInput,
  type WorkboardLayoutJson,
  type RebindPreview,
} from '@/lib/api/workboards';
import { ensureLayout, type MiniAppLayoutSpec } from '@/components/workboards/builder/types';
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

type SectionKey = 'general' | 'data' | 'appearance' | 'advanced';

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
  // Keyed on id so a different board remounts (fresh lazy-init of local state).
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

  // ── Local DRAFT state (nothing is persisted until Save). ──────────────────
  // Layout (Appearance / Navigation / Documents / Auto-number). Lazy-init from
  // the loaded board so there's no default→real flip.
  const [layout, setLayoutRaw] = useState<MiniAppLayoutSpec>(() => ensureLayout(workboard.layout_json));
  const setLayout = canEdit ? setLayoutRaw : () => {};
  // Board-DB fields (General identity + Advanced technical).
  const [name, setName] = useState(workboard.name || '');
  const [description, setDescription] = useState(workboard.description || '');
  const [icon, setIcon] = useState(workboard.icon || '');
  const [lockColumn, setLockColumn] = useState(workboard.optimistic_lock_column || '');

  // Baseline of the last SAVED layout — dirty is measured against this (and
  // advanced after a successful save / rebind).
  const [savedLayoutJson, setSavedLayoutJson] = useState(() =>
    JSON.stringify(ensureLayout(workboard.layout_json)),
  );
  const layoutJson = useMemo(() => JSON.stringify(layout), [layout]);
  const layoutDirty = layoutJson !== savedLayoutJson;
  const identityDirty =
    name.trim() !== (workboard.name || '') ||
    (description.trim() || '') !== (workboard.description || '') ||
    (icon.trim() || '') !== (workboard.icon || '');
  const lockDirty = (lockColumn.trim() || '') !== (workboard.optimistic_lock_column || '');
  const dirty = canEdit && (layoutDirty || identityDirty || lockDirty);

  // ── Dataset rebind (two-phase) + import/export. ───────────────────────────
  const [rebindPlan, setRebindPlan] = useState<(RebindPreview & { targetDatasetId: number }) | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [tables, setTables] = useState<DatasetTableInfo[]>([]);

  // ── The one explicit save: apply every dirty field in a single atomic PATCH.
  const persist = useCallback(async () => {
    if (!canEdit) return;
    const data: WorkboardUpdateInput = {};
    if (layoutDirty) {
      data.layout_json = layout as unknown as Partial<WorkboardLayoutJson>;
      // Optimistic-concurrency guard only for the whole-board layout write.
      if (typeof workboard.version === 'number') data.expected_version = workboard.version;
    }
    if (identityDirty) {
      data.name = name.trim();
      data.description = description.trim();
      data.icon = icon.trim() || undefined;
    }
    if (lockDirty) data.optimistic_lock_column = lockColumn.trim();
    if (Object.keys(data).length === 0) return;
    await update.mutateAsync({ id, data });
    setSavedLayoutJson(JSON.stringify(layout));
  }, [
    canEdit, layoutDirty, identityDirty, lockDirty, layout, name, description, icon,
    lockColumn, workboard.version, id, update,
  ]);

  const handleSave = async () => {
    if (!dirty) return;
    try {
      await persist();
      toast.success(t('workboards.settings.allSaved'));
    } catch (err) {
      const httpStatus = (err as { response?: { status?: number } })?.response?.status;
      toast.error(
        httpStatus === 409 ? t('workboards.autosave.conflict') : t('workboards.settings.saveFailed'),
      );
    }
  };

  const handleDiscard = () => {
    setLayoutRaw(ensureLayout(JSON.parse(savedLayoutJson)));
    setName(workboard.name || '');
    setDescription(workboard.description || '');
    setIcon(workboard.icon || '');
    setLockColumn(workboard.optimistic_lock_column || '');
  };

  // Let the topbar Publish button drain THIS page's unsaved edits before it
  // snapshots the draft (same registry the builder uses; only one tab mounts a
  // time so there's no clash). Publishing implies saving pending settings.
  useEffect(() => {
    registerAutosaveFlush(async () => {
      if (dirty) await persist();
    });
    return () => registerAutosaveFlush(null);
  }, [dirty, persist]);

  // Guard against losing unsaved edits on a hard reload / tab close.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const handleDatasetChange = async (nextDatasetId: number) => {
    if (!canEdit || !nextDatasetId || nextDatasetId === workboard.dataset_id) return;
    try {
      // Persist any pending draft edits first so the impact preview reflects them.
      if (dirty) await persist();
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
      const nextLayout = ensureLayout(updated.layout_json);
      setLayoutRaw(nextLayout); // reflect the rebound draft
      setSavedLayoutJson(JSON.stringify(nextLayout));
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
      </nav>

      {/* Content column: scrollable body + a single sticky Save footer */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto">
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
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label={t('workboards.settings.iconEmoji')}>
                        <Input value={icon} onChange={(e) => setIcon(e.target.value)} disabled={!canEdit} placeholder={t('workboards.settings.iconEmojiPlaceholder')} maxLength={8} />
                      </Field>
                      <Field label={t('workboards.settings.slugReadonly')}>
                        <Input value={workboard.slug || ''} readOnly disabled />
                      </Field>
                    </div>
                    <p className="text-tiny text-text-tertiary">{t('workboards.settings.slugHint')}</p>
                  </div>
                </SettingsPanel>
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
                  <ExperienceStudioSection layout={layout} onChange={setLayout} disabled={!canEdit} />
                </SettingsPanel>
                <SettingsPanel title={t('workboards.settings.navigation')} icon={<Compass className="h-4 w-4" />}>
                  <NavigationSection layout={layout} onChange={setLayout} />
                </SettingsPanel>
                <Collapsible summary={t('workboards.settings.legacyBranding')} icon={<Palette className="h-4 w-4" />}>
                  <ThemeSection layout={layout} onChange={setLayout} />
                </Collapsible>
              </>
            )}

            {section === 'advanced' && (
              <>
                <SettingsPanel title={t('workboards.settings.autoNumber')} icon={<SlidersHorizontal className="h-4 w-4" />}>
                  <AutoNumberSection layout={layout} tables={tables} onChange={setLayout} />
                </SettingsPanel>

                <SettingsPanel title={t('workboards.settings.printTemplate')} icon={<FileText className="h-4 w-4" />}>
                  <PrintTemplateSection layout={layout} onChange={setLayout} />
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
                </SettingsPanel>
              </>
            )}
          </div>
        </div>

        {canEdit && (
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-[rgb(var(--border-line))] bg-surface-1 px-6 py-3">
            <span className="flex min-w-0 items-center gap-2 text-caption">
              {dirty ? (
                <>
                  <span className="h-2 w-2 shrink-0 rounded-full bg-warning" />
                  <span className="font-medium text-text-primary">{t('workboards.settings.unsavedChanges')}</span>
                  <span className="hidden truncate text-tiny text-text-tertiary sm:inline">· {t('workboards.settings.saveHint')}</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                  <span className="text-text-tertiary">{t('workboards.settings.allSaved')}</span>
                </>
              )}
            </span>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" size="sm" disabled={!dirty || update.isPending} onClick={handleDiscard}>
                {t('workboards.settings.discard')}
              </Button>
              <Button variant="primary" size="sm" disabled={!dirty} loading={update.isPending} onClick={handleSave}>
                {t('workboards.settings.saveChanges')}
              </Button>
            </div>
          </footer>
        )}
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
              remapped: rebindPlan.remap_count,
              cleared: rebindPlan.clear_count,
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

/** A panel that starts collapsed — for rarely-touched / legacy controls so the
 * default view stays uncluttered. */
function Collapsible({ summary, icon, children }: { summary: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <details className="group overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-caption font-medium text-text-secondary hover:text-text-primary [&::-webkit-details-marker]:hidden">
        {icon && <span className="shrink-0 text-text-tertiary">{icon}</span>}
        <span className="flex-1">{summary}</span>
        <SlidersHorizontal className="h-3.5 w-3.5 text-text-quaternary transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t border-[rgb(var(--border-line))] p-4">{children}</div>
    </details>
  );
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
