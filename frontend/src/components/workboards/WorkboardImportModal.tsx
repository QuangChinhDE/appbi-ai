/**
 * WorkboardImportModal — list-page entry point for importing workboard
 * templates. Same flow as the import side of WorkboardImportExportModal,
 * extracted so the list page doesn't need a workboard prop.
 */
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Loader2,
  Plug,
  Sparkles,
  Upload,
} from 'lucide-react';

import { useDatasets, useDatasetTables } from '@/hooks/use-datasets';
import { useDataSources } from '@/hooks/use-datasources';
import { useImportWorkboard } from '@/hooks/use-workboards';
import { Button } from '@/components/ui/Button';
import { FieldGroup, Input } from '@/components/ui/Input';
import { Modal } from '@/components/common/Modal';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import type { DatasetTable } from '@/hooks/use-datasets';
import {
  workboardApi,
  type WorkboardBundleDatasource,
  type WorkboardImportReport,
  type WorkboardSourceInspect,
} from '@/lib/api/workboards';
import { workspaceAdminApi } from '@/lib/api/workspaces';

type ImportReport = WorkboardImportReport;

interface TemplateColumn {
  name: string;
  type?: string;
}

interface TemplateTable {
  key: string;
  old_table_id: number;
  source_table_name: string | null;
  display_name: string | null;
  dataset_name?: string | null;
  columns: TemplateColumn[];
}

interface TargetTable {
  id: number;
  source_table_name?: string | null;
  display_name: string;
  columns: TemplateColumn[];
}

interface WorkboardTemplateBundle {
  kind?: string;
  bundle_version?: number;
  workboard?: { name?: string };
  tables_meta?: Record<string, TemplateTableMeta>;
  layout_json?: { screens?: unknown[] };
  // v2 full-dataset payload (drives the "pick a Source" auto-create flow).
  datasources?: WorkboardBundleDatasource[];
  dataset_tables?: Array<{ old_table_id?: number; source_kind?: string }>;
  app_users?: unknown[];
}

interface TemplateTableMeta {
  source_table_name?: string | null;
  display_name?: string | null;
  dataset_name?: string | null;
  columns?: unknown;
}

interface ApiErrorShape {
  response?: {
    data?: {
      detail?: string;
    };
  };
}

export default function WorkboardImportModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: datasets = [], isLoading: datasetsLoading, error: datasetsError } = useDatasets();
  const { data: datasources = [], isLoading: datasourcesLoading } = useDataSources();
  const importMutation = useImportWorkboard();
  const [bundle, setBundle] = useState<WorkboardTemplateBundle | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);
  // Two ways to land the workboard's data: auto-create a fresh Dataset from a
  // chosen Source (v2, the headline flow), or map onto an existing Dataset.
  const [mode, setMode] = useState<'new' | 'reuse'>('new');

  // ── NEW mode: pick a Source per bundle datasource → auto-create dataset ──
  const [datasourceMap, setDatasourceMap] = useState<Record<string, number>>({});
  const [inspect, setInspect] = useState<WorkboardSourceInspect | null>(null);
  const [inspecting, setInspecting] = useState(false);
  // old_table_id -> source table name override (manual fix for a renamed table).
  const [overrides, setOverrides] = useState<Record<number, string>>({});
  const [submittingNew, setSubmittingNew] = useState(false);

  // ── REUSE mode: existing dataset + table/column mapping ──
  const [datasetId, setDatasetId] = useState<number | null>(null);
  const { data: datasetTables = [], isLoading: tablesLoading } = useDatasetTables(datasetId);

  const [name, setName] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [createdId, setCreatedId] = useState<number | null>(null);
  // Imported workboard identity, kept so we can publish it to a public Cổng
  // (the workspace menu is keyed by slug) without a round-trip.
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState<string>('');
  const [publicLink, setPublicLink] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [tableMapping, setTableMapping] = useState<Record<string, number | ''>>({});
  const [columnMapping, setColumnMapping] = useState<Record<string, Record<string, string>>>({});
  const [autoMapping, setAutoMapping] = useState(false);
  // ``pendingAiMap`` holds the AI's proposal until the admin reviews the
  // diff and confirms. We never overwrite the live mapping silently —
  // user complaint was "AI thêm/sửa/xoá kiểu gì tôi cũng không biết".
  const [pendingAiMap, setPendingAiMap] = useState<{
    table_mapping: Record<string, number | ''>;
    column_mapping: Record<string, Record<string, string>>;
    ai_used: boolean;
  } | null>(null);

  const handleAutoMap = async () => {
    if (!bundle || !datasetId) return;
    setAutoMapping(true);
    try {
      const r = await workboardApi.autoMapImport(
        bundle as Record<string, unknown>,
        datasetId,
      );
      const nextTable: Record<string, number | ''> = {};
      for (const [k, v] of Object.entries(r.table_mapping || {})) {
        nextTable[k] = typeof v === 'number' ? v : '';
      }
      setPendingAiMap({
        table_mapping: nextTable,
        column_mapping: r.column_mapping || {},
        ai_used: r.ai_used,
      });
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('workboards.import.autoMapFailed')));
    } finally {
      setAutoMapping(false);
    }
  };

  const applyAiMap = () => {
    if (!pendingAiMap) return;
    setTableMapping(pendingAiMap.table_mapping);
    setColumnMapping(pendingAiMap.column_mapping);
    toast.success(
      pendingAiMap.ai_used
        ? t('workboards.import.aiMappingApplied')
        : t('workboards.import.heuristicMappingApplied'),
    );
    setPendingAiMap(null);
  };

  const sourceTables = useMemo(() => buildTemplateTables(bundle), [bundle]);
  const targetTables = useMemo(() => datasetTables.map(toTargetTable), [datasetTables]);
  const targetDatasetHasNoTables = Boolean(datasetId && !tablesLoading && targetTables.length === 0);

  useEffect(() => {
    if (!bundle || !datasetId) {
      setTableMapping({});
      setColumnMapping({});
      return;
    }
    setTableMapping((current) => {
      const next: Record<string, number | ''> = {};
      let changed = false;
      for (const source of sourceTables) {
        const currentValue = current[source.key];
        const stillValid =
          typeof currentValue === 'number' && targetTables.some((target) => target.id === currentValue);
        const nextValue = stillValid
          ? currentValue
          : inferTargetTable(source, targetTables)?.id ?? '';
        next[source.key] = nextValue;
        if (current[source.key] !== nextValue) changed = true;
      }
      // Skip the state update entirely when nothing actually moved — every
      // re-render here closes the open native <select>, which is what users
      // see as "vừa chọn xong nhảy mất". useDatasetTables refetch alone was
      // enough to keep this effect ping-ponging.
      return changed || Object.keys(next).length !== Object.keys(current).length
        ? next
        : current;
    });
  }, [bundle, datasetId, sourceTables, targetTables]);

  // ── NEW-mode derived + handlers ─────────────────────────────────────
  const bundleDatasources = useMemo(() => bundle?.datasources || [], [bundle]);
  const canAutoCreate =
    (bundle?.bundle_version ?? 1) >= 2 &&
    (bundle?.dataset_tables?.length ?? 0) > 0 &&
    bundleDatasources.length > 0;
  const allSourcesSelected =
    bundleDatasources.length > 0 && bundleDatasources.every((b) => datasourceMap[b.ref]);

  // Pre-fill each bundle datasource with a same-named live Source (or the only
  // one available), so the common single-source case needs zero clicks.
  useEffect(() => {
    if (!bundle || bundleDatasources.length === 0 || datasources.length === 0) return;
    setDatasourceMap((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const bds of bundleDatasources) {
        if (next[bds.ref]) continue;
        const match =
          datasources.find(
            (d) => (d.name || '').toLowerCase() === (bds.name || '').toLowerCase(),
          ) || (datasources.length === 1 ? datasources[0] : null);
        if (match) {
          next[bds.ref] = match.id;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [bundle, bundleDatasources, datasources]);

  const handleInspect = async () => {
    if (!bundle || !allSourcesSelected) return;
    setInspecting(true);
    try {
      const r = await workboardApi.inspectImportSource(
        bundle as Record<string, unknown>,
        datasourceMap,
      );
      setInspect(r);
      if (!r.all_found) {
        toast.error(
          t('workboards.import.sourceMissingTablesToast', { missing: r.physical_total - r.physical_found, total: r.physical_total }),
        );
      } else {
        toast.success(t('workboards.import.sourceAllTablesFoundToast', { total: r.physical_total }));
      }
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('workboards.import.inspectSourceFailed')));
    } finally {
      setInspecting(false);
    }
  };

  const openCleanOrReport = (data: {
    id?: number;
    slug?: string | null;
    name?: string;
    _import_report?: ImportReport;
  }) => {
    // Import may have just created a brand-new dataset + workboard. Refresh the
    // cached lists so the new builder's "Bound dataset" name resolves (instead
    // of momentarily showing "— no dataset —") and the workboards list updates.
    queryClient.invalidateQueries({ queryKey: ['datasets'] });
    queryClient.invalidateQueries({ queryKey: ['workboards'] });
    setCreatedId(data.id ?? null);
    setCreatedSlug(data.slug ?? null);
    setCreatedName(data.name ?? '');
    setPublicLink(null);
    setPublishError(null);
    setReport((data._import_report as ImportReport) || null);
    // We DON'T auto-navigate to the Builder anymore: the common goal after
    // import is to publish the app and grab its public link to share with
    // end-users (no AppBI account needed). The success screen offers both
    // "Tạo link công khai" and "Mở workboard mới".
    toast.success(t('workboards.import.importedToast'));
  };

  // Publish the imported workboard to a brand-new public Cổng and surface its
  // shareable link. createWithWorkboard makes a workspace whose menu already
  // contains this workboard with access_mode='public_app_users', so the
  // imported app-users can log in via PIN at /ws/{token} with no AppBI account.
  const handleCreatePublicLink = async () => {
    if (!createdSlug) {
      setPublishError(
        t('workboards.import.missingSlugPublishError'),
      );
      return;
    }
    setPublishing(true);
    setPublishError(null);
    try {
      const ws = await workspaceAdminApi.createWithWorkboard({
        name: createdName || createdSlug,
        workboardSlug: createdSlug,
        workboardLabel: createdName || createdSlug,
      });
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      setPublicLink(`${origin}/ws/${ws.token}`);
      toast.success(t('workboards.import.publicPortalCreatedToast'));
    } catch (err: unknown) {
      setPublishError(getApiErrorMessage(err, t('workboards.import.publicPortalCreateFailed')));
    } finally {
      setPublishing(false);
    }
  };

  const copyPublicLink = async () => {
    if (!publicLink) return;
    try {
      await navigator.clipboard.writeText(publicLink);
      toast.success(t('workboards.import.linkCopiedToast'));
    } catch {
      toast.error(t('workboards.import.copyBlocked'));
    }
  };

  const handleSubmitNew = async () => {
    if (!bundle || !allSourcesSelected) return;
    setSubmittingNew(true);
    try {
      const tableSourceOverrides: Record<string, string> = {};
      for (const [k, v] of Object.entries(overrides)) {
        if (v) tableSourceOverrides[String(k)] = v;
      }
      const data = await workboardApi.importFromSource({
        bundle: bundle as Record<string, unknown>,
        datasource_map: datasourceMap,
        target_name: name.trim() || undefined,
        table_source_overrides: Object.keys(tableSourceOverrides).length
          ? tableSourceOverrides
          : undefined,
      });
      openCleanOrReport(data);
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('workboards.import.importFailed')));
    } finally {
      setSubmittingNew(false);
    }
  };

  const handleFile = async (file: File) => {
    setBundleError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as WorkboardTemplateBundle;
      if (parsed.kind !== 'workboard_template') {
        setBundleError(t('workboards.import.invalidBundle'));
        return;
      }
      setBundle(parsed);
      setReport(null);
      setCreatedId(null);
      setInspect(null);
      setOverrides({});
      setDatasourceMap({});
      // v2 bundles default to the "pick a Source → auto-create" flow; older
      // (v1) bundles can only reuse an existing dataset.
      const autoCapable =
        (parsed.bundle_version ?? 1) >= 2 &&
        (parsed.dataset_tables?.length ?? 0) > 0 &&
        (parsed.datasources?.length ?? 0) > 0;
      setMode(autoCapable ? 'new' : 'reuse');
      if (parsed.workboard?.name && !name) setName(t('workboards.import.importedName', { name: parsed.workboard.name }));
    } catch {
      setBundleError(t('workboards.import.readJsonFailed'));
    }
  };

  const handleSubmitReuse = async () => {
    if (!bundle || !datasetId) return;
    try {
      const mappingPayload = buildMappingPayload(
        sourceTables,
        targetTables,
        tableMapping,
        columnMapping,
      );
      const data = await importMutation.mutateAsync({
        bundle: bundle as Record<string, unknown>,
        target_dataset_id: datasetId,
        target_name: name.trim() || undefined,
        table_mapping: mappingPayload.table_mapping,
        column_mapping: mappingPayload.column_mapping,
      });
      openCleanOrReport(data);
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('workboards.import.importFailed')));
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('workboards.import.title')}
      size="lg"
      footer={
        createdId ? (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('workboards.import.close')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                onClose();
                router.push(`/workboards/${createdId}`);
              }}
            >
              {t('workboards.import.openNewWorkboard')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('workboards.import.cancel')}
            </Button>
            {mode === 'new' ? (
              <Button
                variant="primary"
                size="sm"
                leadingIcon={<Upload className="h-3.5 w-3.5" />}
                onClick={handleSubmitNew}
                disabled={!bundle || !allSourcesSelected || submittingNew}
                loading={submittingNew}
              >
                {t('workboards.import.createDatasetAndImport')}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                leadingIcon={<Upload className="h-3.5 w-3.5" />}
                onClick={handleSubmitReuse}
                disabled={!bundle || !datasetId || targetDatasetHasNoTables || importMutation.isPending}
                loading={importMutation.isPending}
              >
                {t('workboards.action.import')}
              </Button>
            )}
          </>
        )
      }
    >
      {createdId ? (
        <div className="space-y-4">
          {report ? (
            <ImportSuccessReport report={report} />
          ) : (
            <div className="flex items-start gap-2 rounded-md border border-success/20 bg-success/5 p-3 text-caption text-text-secondary">
              <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" />
              <div>{t('workboards.import.successSimple')}</div>
            </div>
          )}
          <div className="space-y-2 rounded-md border border-info/20 bg-info/5 p-3">
            <div className="text-caption font-medium text-text-primary">
              {t('workboards.import.shareTitle')}
            </div>
            <div className="text-caption text-text-tertiary">
              {t('workboards.import.shareDescription')}
            </div>
            {publicLink ? (
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={publicLink}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 truncate rounded border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1 text-caption text-text-primary"
                />
                <Button variant="secondary" size="sm" onClick={copyPublicLink}>
                  {t('workboards.import.copy')}
                </Button>
                <a href={publicLink} target="_blank" rel="noreferrer">
                  <Button variant="ghost" size="sm">{t('workboards.import.open')}</Button>
                </a>
              </div>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={handleCreatePublicLink}
                loading={publishing}
                disabled={publishing}
              >
                {t('workboards.import.createPublicLink')}
              </Button>
            )}
            {publishError && (
              <div className="text-caption text-error">{publishError}</div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <FieldGroup
            label={t('workboards.import.bundleFileLabel')}
            description={t('workboards.import.bundleFileDescription')}
            required
          >
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
              className="block w-full text-caption"
            />
            {bundleError && (
              <p className="mt-1 text-tiny text-danger">{bundleError}</p>
            )}
            {bundle && (
              <div className="mt-2 rounded-md border border-success/20 bg-success/5 p-2 text-caption text-text-secondary">
                <CheckCircle2 className="mr-1 inline h-3.5 w-3.5 text-success" />
                {t('workboards.import.validBundle', { count: Array.isArray(bundle.layout_json?.screens) ? bundle.layout_json.screens.length : 0 })}
                {canAutoCreate && (
                  <>
                    , {t('workboards.import.datasetTableCount', { count: bundle.dataset_tables?.length ?? 0 })},{' '}
                    {t('workboards.import.sourceCount', { count: bundleDatasources.length })} ({bundleDatasources.map((d) => d.name).join(', ')})
                  </>
                )}
                {(bundle.app_users?.length ?? 0) > 0 && (
                  <>, {t('workboards.import.appUserCount', { count: bundle.app_users?.length ?? 0 })}</>
                )}.
              </div>
            )}
          </FieldGroup>

          <FieldGroup
            label={t('workboards.import.newNameLabel')}
            description={t('workboards.import.newNameDescription')}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('workboards.import.newNamePlaceholder')}
              disabled={!bundle}
            />
          </FieldGroup>

          {bundle && (
            <>
              {/* Mode toggle: auto-create from Source (v2) vs reuse a dataset. */}
              {canAutoCreate ? (
                <div className="grid grid-cols-2 gap-2">
                  <ModeButton
                    active={mode === 'new'}
                    onClick={() => setMode('new')}
                    icon={Plug}
                    title={t('workboards.import.modeNewTitle')}
                    desc={t('workboards.import.modeNewDescription')}
                  />
                  <ModeButton
                    active={mode === 'reuse'}
                    onClick={() => setMode('reuse')}
                    icon={Database}
                    title={t('workboards.import.modeReuseTitle')}
                    desc={t('workboards.import.modeReuseDescription')}
                  />
                </div>
              ) : (
                <div className="rounded-md border border-warning/30 bg-warning/5 p-2 text-tiny text-warning">
                  {t('workboards.import.legacyBundleWarning')}
                </div>
              )}

              {mode === 'new' && canAutoCreate ? (
                <div className="space-y-3">
                  <FieldGroup
                    label={t('workboards.import.sourceLabel')}
                    required
                    description={t('workboards.import.sourceDescription')}
                  >
                    <div className="space-y-2">
                      {bundleDatasources.map((bds) => (
                        <div
                          key={bds.ref}
                          className="grid grid-cols-[minmax(0,1fr)_minmax(200px,300px)] items-center gap-2"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-caption font-emphasis text-text-primary">
                              {bds.name}
                            </div>
                            <div className="text-tiny text-text-tertiary">
                              {t('workboards.import.originalSource')} · {bds.type}
                            </div>
                          </div>
                          <select
                            value={datasourceMap[bds.ref] ?? ''}
                            onChange={(e) => {
                              const v = e.target.value ? Number(e.target.value) : 0;
                              setDatasourceMap((m) => ({ ...m, [bds.ref]: v }));
                              setInspect(null);
                            }}
                            className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2.5 py-1.5 text-caption"
                          >
                            <option value="">
                              {datasourcesLoading
                                ? t('workboards.import.loadingSources')
                                : t('workboards.import.sourcePlaceholder')}
                            </option>
                            {datasources.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.name} ({d.type})
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        leadingIcon={
                          inspecting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          )
                        }
                        onClick={handleInspect}
                        disabled={!allSourcesSelected || inspecting}
                      >
                        {t('workboards.import.inspectSource')}
                      </Button>
                      <span className="text-tiny text-text-tertiary">
                        {t('workboards.import.inspectHint')}
                      </span>
                    </div>
                  </FieldGroup>

                  {inspect && (
                    <SourceInspectPreview
                      inspect={inspect}
                      overrides={overrides}
                      onOverride={(oldId, tbl) =>
                        setOverrides((o) => ({ ...o, [oldId]: tbl }))
                      }
                    />
                  )}
                </div>
              ) : (
                <>
                  <FieldGroup
                    label={t('workboards.import.targetDatasetLabel')}
                    required
                    description={t('workboards.import.targetDatasetDescription')}
                  >
                    <select
                      value={datasetId ?? ''}
                      onChange={(e) => setDatasetId(e.target.value ? Number(e.target.value) : null)}
                      className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-body"
                    >
                      <option value="">
                        {datasetsLoading
                          ? t('workboards.import.loadingDatasets')
                          : datasets.length === 0
                          ? t('workboards.import.noDatasetOption')
                          : t('workboards.import.datasetPlaceholder')}
                      </option>
                      {datasets.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                    {!datasetsLoading && datasets.length === 0 && (
                      <p className="mt-1 text-tiny text-warning">
                        {datasetsError
                          ? t('workboards.import.datasetLoadFailed')
                          : t('workboards.import.noDatasetWarning')}
                      </p>
                    )}
                    {targetDatasetHasNoTables && (
                      <p className="mt-1 text-tiny text-warning">
                        {t('workboards.import.targetDatasetNoTables')}
                      </p>
                    )}
                  </FieldGroup>

                  {datasetId && (
                    <>
                      <div className="flex items-center justify-between rounded-md border border-brand/20 bg-brand/5 px-3 py-2">
                        <div className="text-caption text-text-secondary">
                          <strong>{t('workboards.import.aiAutoMapTitle')}</strong>{' '}
                          {t('workboards.import.aiAutoMapDescription')}
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          leadingIcon={<Sparkles className="h-3.5 w-3.5" />}
                          loading={autoMapping}
                          disabled={autoMapping || tablesLoading}
                          onClick={handleAutoMap}
                          title={t('workboards.import.aiAutoMapButtonTitle')}
                        >
                          {t('workboards.import.aiAutoMapButton')}
                        </Button>
                      </div>

                      <ImportMappingEditor
                        sourceTables={sourceTables}
                        targetTables={targetTables}
                        tableMapping={tableMapping}
                        columnMapping={columnMapping}
                        tablesLoading={tablesLoading}
                        onTableMappingChange={(sourceKey, targetId) => {
                          setTableMapping((current) => ({ ...current, [sourceKey]: targetId }));
                        }}
                        onColumnMappingChange={(sourceKey, sourceColumn, targetColumn) => {
                          setColumnMapping((current) => ({
                            ...current,
                            [sourceKey]: {
                              ...(current[sourceKey] || {}),
                              [sourceColumn]: targetColumn,
                            },
                          }));
                        }}
                      />
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {pendingAiMap && (
        <AiMapPreviewModal
          sourceTables={sourceTables}
          targetTables={targetTables}
          currentTableMapping={tableMapping}
          currentColumnMapping={columnMapping}
          proposedTableMapping={pendingAiMap.table_mapping}
          proposedColumnMapping={pendingAiMap.column_mapping}
          aiUsed={pendingAiMap.ai_used}
          onCancel={() => setPendingAiMap(null)}
          onApply={applyAiMap}
        />
      )}
    </Modal>
  );
}


function ModeButton({
  active,
  onClick,
  icon: Icon,
  title,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ElementType;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-start gap-2 rounded-lg border p-3 text-left transition-colors ${
        active ? 'border-brand bg-brand/5' : 'border-[rgb(var(--border-line))] hover:border-brand/50'
      }`}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${active ? 'text-brand' : 'text-text-tertiary'}`} />
      <div className="min-w-0">
        <div className={`text-caption font-emphasis ${active ? 'text-brand' : 'text-text-primary'}`}>
          {title}
        </div>
        <div className="mt-0.5 text-tiny text-text-tertiary">{desc}</div>
      </div>
    </button>
  );
}

function SourceInspectPreview({
  inspect,
  overrides,
  onOverride,
}: {
  inspect: WorkboardSourceInspect;
  overrides: Record<number, string>;
  onOverride: (oldId: number, tbl: string) => void;
}) {
  const { t } = useI18n();
  const physical = inspect.tables.filter((t) => t.source_kind === 'physical_table');
  return (
    <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-3">
      <div className="mb-2 flex items-center gap-2 text-caption">
        {inspect.all_found ? (
          <CheckCircle2 className="h-4 w-4 text-success" />
        ) : (
          <AlertTriangle className="h-4 w-4 text-warning" />
        )}
        <span className="font-emphasis text-text-primary">
          {t('workboards.import.sourceInspectCount', {
            found: inspect.physical_found,
            total: inspect.physical_total,
          })}
        </span>
        {!inspect.all_found && (
          <span className="text-tiny text-warning">{t('workboards.import.sourceInspectMissingHint')}</span>
        )}
      </div>
      <div className="max-h-[34vh] space-y-1 overflow-y-auto pr-1">
        {physical.map((table) => (
          <div
            key={table.old_table_id}
            className="flex items-center gap-2 rounded border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1.5 text-caption"
          >
            {table.status === 'found' ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-text-primary">
                {table.display_name || table.source_table_name}
              </div>
              <div className="truncate text-tiny text-text-tertiary">
                {table.status === 'found'
                  ? t('workboards.import.sourceInspectMatched', { table: table.matched_source_table || '' })
                  : t('workboards.import.sourceInspectMissing')}
              </div>
            </div>
            {table.status === 'missing' && (table.available_sample?.length ?? 0) > 0 && (
              <select
                value={overrides[table.old_table_id] ?? ''}
                onChange={(e) => onOverride(table.old_table_id, e.target.value)}
                className="max-w-[180px] rounded border border-warning/40 bg-surface-0 px-1.5 py-1 text-tiny"
              >
                <option value="">{t('workboards.import.replacementTablePlaceholder')}</option>
                {table.available_sample!.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}


function ImportMappingEditor({
  sourceTables,
  targetTables,
  tableMapping,
  columnMapping,
  tablesLoading,
  onTableMappingChange,
  onColumnMappingChange,
}: {
  sourceTables: TemplateTable[];
  targetTables: TargetTable[];
  tableMapping: Record<string, number | ''>;
  columnMapping: Record<string, Record<string, string>>;
  tablesLoading: boolean;
  onTableMappingChange: (sourceKey: string, targetId: number | '') => void;
  onColumnMappingChange: (
    sourceKey: string,
    sourceColumn: string,
    targetColumn: string,
  ) => void;
}) {
  const { t } = useI18n();
  if (tablesLoading) {
    return (
      <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-3 text-caption text-text-tertiary">
        {t('workboards.import.loadingTargetTables')}
      </div>
    );
  }

  if (sourceTables.length === 0) {
    return null;
  }

  if (targetTables.length === 0) {
    return (
      <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-caption text-warning">
        {t('workboards.import.targetTablesEmpty')}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h4 className="text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
        {t('workboards.import.mappingTitle')}
      </h4>
      <div className="max-h-[44vh] space-y-2 overflow-y-auto pr-1">
        {sourceTables.map((source) => {
          // ``tableMapping`` stores either a number id or '' (no mapping).
          // ``find`` does strict-equality, so coerce '' away before lookup
          // — otherwise ``item.id === ''`` is always false and the column
          // mapping editor below thinks no target is selected even when
          // the user just picked one.
          const mappedTargetId = tableMapping[source.key];
          const mappedTargetIdNum =
            typeof mappedTargetId === 'number' ? mappedTargetId : null;
          const target =
            mappedTargetIdNum === null
              ? null
              : targetTables.find((item) => item.id === mappedTargetIdNum) || null;
          const effectiveColumns = getEffectiveColumnMapping(
            source,
            target,
            columnMapping[source.key],
          );
          const unmappedColumns = target
            ? source.columns
                .filter((column) => !effectiveColumns[column.name])
                .map((column) => column.name)
            : [];
          return (
            <div
              key={source.key}
              className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-3"
            >
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(220px,280px)]">
                <div className="min-w-0">
                  <div className="truncate text-caption font-emphasis text-text-primary">
                    {source.display_name || source.source_table_name || t('workboards.import.tableFallback', { id: source.old_table_id })}
                  </div>
                  <div className="truncate text-tiny text-text-tertiary">
                    {source.source_table_name || t('workboards.import.noSourceTableName')} · {t('workboards.import.columnCount', { count: source.columns.length })}
                  </div>
                </div>
                <select
                  value={mappedTargetIdNum ?? ''}
                  onChange={(e) =>
                    onTableMappingChange(
                      source.key,
                      e.target.value ? Number(e.target.value) : '',
                    )
                  }
                  className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2.5 py-1.5 text-caption"
                >
                  <option value="">{t('workboards.import.skipTableOption')}</option>
                  {targetTables.map((targetTable) => (
                    <option key={targetTable.id} value={targetTable.id}>
                      {targetTable.display_name} ({targetTable.source_table_name || `#${targetTable.id}`})
                    </option>
                  ))}
                </select>
              </div>

              {target && source.columns.length > 0 && (
                <>
                  {unmappedColumns.length > 0 && (
                    <p className="mt-2 rounded border border-warning/30 bg-warning/5 px-2 py-1 text-tiny text-warning">
                      {t('workboards.import.unmappedColumns', {
                        count: unmappedColumns.length,
                        columns: unmappedColumns.slice(0, 6).join(', '),
                      })}
                      {unmappedColumns.length > 6 ? '…' : ''}
                    </p>
                  )}
                  <div className="mt-3 grid gap-1.5 md:grid-cols-2">
                    {source.columns.map((column) => (
                      <label
                        key={column.name}
                        className="grid grid-cols-[minmax(0,1fr)_minmax(130px,1fr)] items-center gap-2 text-tiny"
                      >
                        <span className="truncate text-text-secondary" title={column.name}>
                          {column.name}
                        </span>
                        <select
                          value={effectiveColumns[column.name] || ''}
                          onChange={(e) =>
                            onColumnMappingChange(source.key, column.name, e.target.value)
                          }
                          className="min-w-0 rounded border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1"
                        >
                          <option value="">{t('workboards.import.skipColumnOption')}</option>
                          {target.columns.map((targetColumn) => (
                            <option key={targetColumn.name} value={targetColumn.name}>
                              {targetColumn.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


function ImportSuccessReport({
  report,
}: {
  report: ImportReport;
}) {
  const { t } = useI18n();
  const matched = report.matched_tables.length;
  const missing = report.missing_tables.length;
  const colIssues = report.missing_columns.length;
  const usersImported = report.app_users_imported ?? 0;
  const usersNeedingPin = report.app_users_needing_pin ?? [];
  const rebuild = report.dataset_rebuild;
  const skippedRebuild = rebuild?.skipped_tables ?? [];
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-success/20 bg-success/5 p-3 text-caption">
        <div className="font-emphasis text-success">
          <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />
          {t('workboards.import.reportTitle')}
        </div>
        <div className="mt-1 text-text-secondary">
          {rebuild && (
            <>
              {t('workboards.import.reportDatasetCreatedPrefix')} <strong>“{rebuild.dataset_name}”</strong>{' '}
              {t('workboards.import.reportDatasetCreatedSuffix', { count: rebuild.created_tables.length })}{' '}
            </>
          )}
          {t('workboards.import.reportMatchedTables', { count: matched })}
          {missing > 0 && ` ${t('workboards.import.reportMissingTables', { count: missing })}`}
          {colIssues > 0 && ` ${t('workboards.import.reportMissingColumns', { count: colIssues })}`}
          {usersImported > 0 && ` ${t('workboards.import.reportUsersImported', { count: usersImported })}`}
        </div>
      </div>

      {skippedRebuild.length > 0 && (
        <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-caption text-warning">
          <strong>{t('workboards.import.reportSkippedTablesTitle', { count: skippedRebuild.length })}</strong>{' '}
          {t('workboards.import.reportSkippedTablesBody')}
        </div>
      )}

      {usersNeedingPin.length > 0 && (
        <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-caption text-warning">
          <strong>{t('workboards.import.reportUsersNeedPinTitle', { count: usersNeedingPin.length })}</strong>{' '}
          {t('workboards.import.reportUsersNeedPinPrefix')} <strong>{t('workboards.import.usersTab')}</strong>{' '}
          {t('workboards.import.reportUsersNeedPinSuffix')}{' '}
          <span className="text-text-secondary">
            {usersNeedingPin.slice(0, 8).join(', ')}
            {usersNeedingPin.length > 8 && ` ${t('workboards.import.moreUsers', { count: usersNeedingPin.length - 8 })}`}
          </span>
        </div>
      )}

      {missing > 0 && (
        <div>
          <h4 className="mb-1 text-tiny font-emphasis uppercase tracking-wider text-warning">
            <AlertTriangle className="mr-1 inline h-3 w-3" />
            {t('workboards.import.missingTablesHeading', { count: missing })}
          </h4>
          <div className="space-y-1">
            {report.missing_tables.map((table, i) => (
              <div
                key={i}
                className="rounded-md border border-warning/30 bg-warning/5 p-2 text-caption"
              >
                <div className="font-emphasis text-text-primary">
                  {table.display_name || table.source_table_name || t('workboards.import.tableFallback', { id: table.old_table_id })}
                </div>
                <div className="text-tiny text-text-tertiary">
                  {t('workboards.import.sourceTableNameLabel')}{' '}
                  <code className="bg-surface-2 px-1">{table.source_table_name}</code>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {colIssues > 0 && (
        <div>
          <h4 className="mb-1 text-tiny font-emphasis uppercase tracking-wider text-warning">
            <AlertTriangle className="mr-1 inline h-3 w-3" />
            {t('workboards.import.missingColumnsHeading', { count: colIssues })}
          </h4>
          <div className="space-y-1">
            {report.missing_columns.slice(0, 12).map((item, i) => (
              <div
                key={`${item.screen}-${item.where}-${item.column}-${i}`}
                className="rounded-md border border-warning/30 bg-warning/5 p-2 text-caption"
              >
                <code className="bg-surface-2 px-1">{item.column}</code>
                <span className="ml-2 text-tiny text-text-tertiary">
                  {item.screen || t('workboards.import.screenFallback')} · {item.where}
                </span>
              </div>
            ))}
            {report.missing_columns.length > 12 && (
              <p className="text-tiny text-text-tertiary">
                {t('workboards.import.moreColumns', { count: report.missing_columns.length - 12 })}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function buildTemplateTables(bundle: WorkboardTemplateBundle | null): TemplateTable[] {
  const tablesMeta = bundle?.tables_meta || {};
  return Object.entries(tablesMeta).map(([key, meta]) => ({
    key,
    old_table_id: Number(key),
    source_table_name: meta?.source_table_name ?? null,
    display_name: meta?.display_name ?? null,
    dataset_name: meta?.dataset_name ?? null,
    columns: normaliseColumns(meta?.columns),
  }));
}

function toTargetTable(table: DatasetTable): TargetTable {
  return {
    id: table.id,
    source_table_name: table.source_table_name,
    display_name: table.display_name,
    columns: normaliseColumns(table.columns_cache),
  };
}

function normaliseColumns(raw: unknown): TemplateColumn[] {
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { columns?: unknown }).columns)
      ? ((raw as { columns: unknown[] }).columns)
      : [];
  return arr
    .filter((item): item is { name: unknown; type?: unknown } =>
      Boolean(item && typeof item === 'object' && 'name' in item),
    )
    .map((item) => ({ name: String(item.name), type: item.type ? String(item.type) : undefined }));
}

function normaliseName(value?: string | null): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[`"\[\]]/g, '')
    .replace(/^[^.]+\./, '')
    .replace(/[^a-z0-9]+/g, '');
}

function inferTargetTable(source: TemplateTable, targets: TargetTable[]): TargetTable | null {
  const sourceNames = [
    source.source_table_name,
    source.display_name,
    source.source_table_name?.split('.').pop(),
  ].map(normaliseName).filter(Boolean);
  return (
    targets.find((target) => {
      const targetNames = [
        target.source_table_name,
        target.display_name,
        target.source_table_name?.split('.').pop(),
      ].map(normaliseName).filter(Boolean);
      return sourceNames.some((name) => targetNames.includes(name));
    }) || null
  );
}

function inferTargetColumn(sourceColumn: string, targetColumns: TemplateColumn[]): string {
  const exact = targetColumns.find((item) => item.name === sourceColumn);
  if (exact) return exact.name;
  const normalisedSource = normaliseName(sourceColumn);
  return targetColumns.find((item) => normaliseName(item.name) === normalisedSource)?.name || '';
}

function getEffectiveColumnMapping(
  source: TemplateTable,
  target: TargetTable | null,
  saved?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!target) return out;
  for (const column of source.columns) {
    const savedValue = saved?.[column.name];
    out[column.name] =
      savedValue && target.columns.some((item) => item.name === savedValue)
        ? savedValue
        : inferTargetColumn(column.name, target.columns);
  }
  return out;
}

function buildMappingPayload(
  sources: TemplateTable[],
  targets: TargetTable[],
  tableMapping: Record<string, number | ''>,
  columnMapping: Record<string, Record<string, string>>,
): {
  table_mapping: Record<string, number | null>;
  column_mapping: Record<string, Record<string, string>>;
} {
  const tablePayload: Record<string, number | null> = {};
  const columnPayload: Record<string, Record<string, string>> = {};

  for (const source of sources) {
    const mappedTargetId = tableMapping[source.key] || '';
    tablePayload[source.key] = mappedTargetId ? Number(mappedTargetId) : null;
    const target = targets.find((item) => item.id === mappedTargetId) || null;
    const effective = getEffectiveColumnMapping(source, target, columnMapping[source.key]);
    const mappedColumns = Object.fromEntries(
      Object.entries(effective).filter(([, targetColumn]) => Boolean(targetColumn)),
    );
    if (Object.keys(mappedColumns).length > 0) {
      columnPayload[source.key] = mappedColumns;
    }
  }

  return { table_mapping: tablePayload, column_mapping: columnPayload };
}

function getApiErrorMessage(err: unknown, fallback: string): string {
  return (err as ApiErrorShape)?.response?.data?.detail || fallback;
}


// ── AI map preview modal ────────────────────────────────────────────────

interface TableDiffRow {
  sourceKey: string;
  sourceLabel: string;
  before: string;
  after: string;
  changed: boolean;
}

interface ColumnDiffRow {
  sourceKey: string;
  sourceLabel: string;
  sourceColumn: string;
  before: string;
  after: string;
  status: 'unchanged' | 'added' | 'changed' | 'removed';
}

function AiMapPreviewModal({
  sourceTables,
  targetTables,
  currentTableMapping,
  currentColumnMapping,
  proposedTableMapping,
  proposedColumnMapping,
  aiUsed,
  onCancel,
  onApply,
}: {
  sourceTables: TemplateTable[];
  targetTables: TargetTable[];
  currentTableMapping: Record<string, number | ''>;
  currentColumnMapping: Record<string, Record<string, string>>;
  proposedTableMapping: Record<string, number | ''>;
  proposedColumnMapping: Record<string, Record<string, string>>;
  aiUsed: boolean;
  onCancel: () => void;
  onApply: () => void;
}) {
  const { t } = useI18n();
  const targetById = useMemo(() => {
    const map = new Map<number, TargetTable>();
    for (const targetTable of targetTables) map.set(targetTable.id, targetTable);
    return map;
  }, [targetTables]);

  const tableDiffs = useMemo<TableDiffRow[]>(() => {
    return sourceTables.map((s) => {
      const before = currentTableMapping[s.key];
      const after = proposedTableMapping[s.key] ?? '';
      const labelOf = (id: number | '' | undefined) =>
        typeof id === 'number'
          ? (targetById.get(id)?.display_name
              || targetById.get(id)?.source_table_name
              || `#${id}`)
          : t('workboards.import.unmappedTable');
      return {
        sourceKey: s.key,
        sourceLabel: s.display_name || s.source_table_name || t('workboards.import.tableFallback', { id: s.old_table_id }),
        before: labelOf(before),
        after: labelOf(after),
        changed: before !== after,
      };
    });
  }, [sourceTables, currentTableMapping, proposedTableMapping, targetById, t]);

  const columnDiffs = useMemo<ColumnDiffRow[]>(() => {
    const out: ColumnDiffRow[] = [];
    for (const s of sourceTables) {
      const beforeCols = currentColumnMapping[s.key] || {};
      const afterCols = proposedColumnMapping[s.key] || {};
      const allCols = new Set<string>([
        ...s.columns.map((c) => c.name),
        ...Object.keys(beforeCols),
        ...Object.keys(afterCols),
      ]);
      for (const col of allCols) {
        const before = beforeCols[col] ?? '';
        const after = afterCols[col] ?? '';
        if (!before && !after) continue;
        let status: ColumnDiffRow['status'];
        if (before && !after) status = 'removed';
        else if (!before && after) status = 'added';
        else if (before === after) status = 'unchanged';
        else status = 'changed';
        out.push({
          sourceKey: s.key,
          sourceLabel: s.display_name || s.source_table_name || s.key,
          sourceColumn: col,
          before,
          after,
          status,
        });
      }
    }
    return out;
  }, [sourceTables, currentColumnMapping, proposedColumnMapping]);

  const tableChanged = tableDiffs.filter((r) => r.changed).length;
  const colAdded = columnDiffs.filter((r) => r.status === 'added').length;
  const colChanged = columnDiffs.filter((r) => r.status === 'changed').length;
  const colRemoved = columnDiffs.filter((r) => r.status === 'removed').length;

  return (
    <Modal
      isOpen
      onClose={onCancel}
      title={aiUsed ? t('workboards.import.aiPreviewTitle') : t('workboards.import.heuristicPreviewTitle')}
      size="xl"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t('workboards.import.aiPreviewCancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={onApply}>
            {t('workboards.import.aiPreviewApply')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="rounded-md border border-info/20 bg-info/5 p-3 text-caption text-text-secondary">
          {aiUsed ? (
            <>
              {t('workboards.import.aiPreviewBodyPrefix')} <strong>{t('workboards.import.aiPreviewNotApplied')}</strong> —
              {t('workboards.import.aiPreviewBodySuffix')} <em>{t('workboards.import.aiPreviewApply')}</em>.
            </>
          ) : (
            <>
              {t('workboards.import.heuristicPreviewBody')}
            </>
          )}
        </div>

        <div className="grid grid-cols-4 gap-2 text-center text-caption">
          <DiffStat label={t('workboards.import.diffTablesChanged')} value={tableChanged} tone="info" />
          <DiffStat label={t('workboards.import.diffColumnsAdded')} value={colAdded} tone="success" />
          <DiffStat label={t('workboards.import.diffColumnsChanged')} value={colChanged} tone="warning" />
          <DiffStat label={t('workboards.import.diffColumnsRemoved')} value={colRemoved} tone="danger" />
        </div>

        <div>
          <h4 className="mb-1 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
            {t('workboards.import.tableMappingHeading')}
          </h4>
          {tableDiffs.length === 0 ? (
            <p className="text-tiny text-text-tertiary">{t('workboards.import.noTableDiffs')}</p>
          ) : (
            <div className="overflow-hidden rounded-md border border-[rgb(var(--border-line))]">
              <table className="w-full text-caption">
                <thead className="bg-surface-2 text-tiny text-text-tertiary">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Source</th>
                    <th className="px-3 py-1.5 text-left font-medium">{t('workboards.import.currentColumn')}</th>
                    <th className="px-3 py-1.5 text-left font-medium">{t('workboards.import.proposedColumn')}</th>
                  </tr>
                </thead>
                <tbody>
                  {tableDiffs.map((row) => (
                    <tr
                      key={row.sourceKey}
                      className={`border-t border-[rgb(var(--border-line))] ${
                        row.changed ? 'bg-warning/5' : ''
                      }`}
                    >
                      <td className="px-3 py-1.5 font-medium text-text-primary">
                        {row.sourceLabel}
                      </td>
                      <td className="px-3 py-1.5 text-text-tertiary">{row.before}</td>
                      <td className="px-3 py-1.5">
                        <span
                          className={
                            row.changed
                              ? 'font-medium text-warning'
                              : 'text-text-secondary'
                          }
                        >
                          {row.after}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <h4 className="mb-1 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
            {t('workboards.import.columnMappingHeading')}
          </h4>
          {columnDiffs.length === 0 ? (
            <p className="text-tiny text-text-tertiary">
              {t('workboards.import.noColumnDiffs')}
            </p>
          ) : (
            <div className="max-h-[40vh] overflow-auto rounded-md border border-[rgb(var(--border-line))]">
              <table className="w-full text-caption">
                <thead className="sticky top-0 bg-surface-2 text-tiny text-text-tertiary">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">{t('workboards.import.tableColumn')}</th>
                    <th className="px-3 py-1.5 text-left font-medium">{t('workboards.import.sourceColumn')}</th>
                    <th className="px-3 py-1.5 text-left font-medium">{t('workboards.import.currentColumn')}</th>
                    <th className="px-3 py-1.5 text-left font-medium">{t('workboards.import.proposedColumn')}</th>
                    <th className="px-3 py-1.5 text-left font-medium">{t('workboards.import.statusColumn')}</th>
                  </tr>
                </thead>
                <tbody>
                  {columnDiffs.map((row, idx) => (
                    <tr
                      key={`${row.sourceKey}-${row.sourceColumn}-${idx}`}
                      className="border-t border-[rgb(var(--border-line))]"
                    >
                      <td className="px-3 py-1 text-text-tertiary">{row.sourceLabel}</td>
                      <td className="px-3 py-1 font-mono text-text-primary">
                        {row.sourceColumn}
                      </td>
                      <td className="px-3 py-1 font-mono text-text-tertiary">
                        {row.before || '—'}
                      </td>
                      <td className="px-3 py-1 font-mono">
                        <span className={diffStatusToClass(row.status)}>
                          {row.after || '—'}
                        </span>
                      </td>
                      <td className="px-3 py-1">
                        <DiffStatusBadge status={row.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function DiffStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'info' | 'success' | 'warning' | 'danger';
}) {
  const toneClass = {
    info: 'text-info border-info/30 bg-info/5',
    success: 'text-success border-success/30 bg-success/5',
    warning: 'text-warning border-warning/30 bg-warning/5',
    danger: 'text-danger border-danger/30 bg-danger/5',
  }[tone];
  return (
    <div className={`rounded-md border ${toneClass} p-2`}>
      <div className="text-h3 font-emphasis">{value}</div>
      <div className="text-tiny opacity-70">{label}</div>
    </div>
  );
}

function diffStatusToClass(status: ColumnDiffRow['status']): string {
  switch (status) {
    case 'added':
      return 'text-success';
    case 'changed':
      return 'text-warning';
    case 'removed':
      return 'text-danger line-through';
    default:
      return 'text-text-tertiary';
  }
}

function DiffStatusBadge({ status }: { status: ColumnDiffRow['status'] }) {
  const { t } = useI18n();
  const text = {
    unchanged: t('workboards.import.diffStatusUnchanged'),
    added: t('workboards.import.diffStatusAdded'),
    changed: t('workboards.import.diffStatusChanged'),
    removed: t('workboards.import.diffStatusRemoved'),
  }[status];
  const cls = {
    unchanged: 'bg-surface-2 text-text-tertiary',
    added: 'bg-success/15 text-success',
    changed: 'bg-warning/15 text-warning',
    removed: 'bg-danger/15 text-danger',
  }[status];
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-tiny ${cls}`}>
      {text}
    </span>
  );
}
