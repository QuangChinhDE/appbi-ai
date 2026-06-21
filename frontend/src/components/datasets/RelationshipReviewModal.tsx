/**
 * RelationshipReviewModal — non-destructive Gen-model flow.
 *
 * Replaces the old "Generate Model = wipe-and-recreate" button. When the
 * builder clicks "Detect relationships" we fetch a diff against the
 * current saved model:
 *
 *   - existing[]    relationships already saved (read-only, status=kept)
 *   - recommended[] new candidates we want the builder to confirm
 *   - obsolete[]    saved joins whose columns/views no longer exist
 *   - warnings[]    M-N, deep-scan-capped, datasource-quota notices
 *
 * The builder ticks the recommendations they want and clicks "Apply".
 * Anything ticked into "Reject" becomes a tombstone so it stops
 * surfacing in future runs (until they hit "Reset rejections").
 *
 * Pass design (BE):
 *   Pass 1 — DB foreign-key constraints from INFORMATION_SCHEMA
 *   Pass 2 — column-name heuristic (`*_id` matching table names)
 *   Pass 2.5 — same-name overlap probe (always on; fetches one table
 *              at a time, sets intersected in Python). Catches the
 *              VN business pattern where two tables share a column
 *              name without declaring FK.
 *   Pass 3 — opt-in "Deep scan": cross-name overlap probe between
 *              every type-compatible column pair (slower, capped).
 */
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  RotateCcw,
  X,
} from 'lucide-react';

import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/providers/LanguageProvider';
import { toast } from '@/lib/toast';
import {
  type RelationshipSuggestion,
  type RelationshipSuggestionsResponse,
  useApplyJoinSuggestions,
  useClearJoinRejections,
  useGenerateJoinSuggestions,
  useRejectJoinSuggestions,
} from '@/hooks/use-dataset-model';

interface Props {
  datasetId: number;
  open: boolean;
  onClose: () => void;
  onApplied: () => void;
}

const CONFIDENCE_LOW_THRESHOLD = 0.8;

function suggestionKey(s: RelationshipSuggestion): string {
  return [
    s.from_view,
    '→',
    s.to_view,
    s.from_columns.join(','),
    '=',
    s.to_columns.join(','),
  ].join(' ');
}

function originLabel(origin: RelationshipSuggestion['origin']): string {
  switch (origin) {
    case 'auto_db_constraint':
      return 'DB foreign key';
    case 'auto_fk':
      return 'Column name match';
    case 'auto_same_name':
      return 'Shared column name';
    case 'auto_type_distinct':
      return 'Data value overlap';
    case 'manual':
      return 'Manual';
  }
}

function originTone(origin: RelationshipSuggestion['origin']): string {
  switch (origin) {
    case 'auto_db_constraint':
      return 'bg-success/10 text-success';
    case 'auto_fk':
      return 'bg-info/10 text-info';
    case 'auto_same_name':
      return 'bg-info/10 text-info';
    case 'auto_type_distinct':
      return 'bg-warning/10 text-warning';
    case 'manual':
      return 'bg-surface-2 text-text-secondary';
  }
}

// Convert raw reason tags from BE into human-readable labels.
function formatReason(tag: string): string {
  if (tag === 'db_fk_constraint') return 'DB foreign key';
  if (tag === 'column_name_match') return 'Column name matches target table';
  if (tag === 'same_column_name') return 'Same column name on both sides';
  if (tag === 'type_compatible') return 'Compatible column types';
  if (tag === 'pk_resolved_from_db') return 'Target PK resolved from DB';
  if (tag === 'target_is_pk') return 'Target column is the primary key';
  if (tag === 'source_is_pk') return 'Source column is the primary key';
  if (tag === 'both_pk') return 'Both columns are primary keys';
  if (tag === 'target_unique_in_data') return 'Target column appears unique in the sample';
  if (tag === 'source_unique_in_data') return 'Source column appears unique in the sample';
  if (tag === 'both_unique_in_data') return 'Both columns appear unique in the sample';
  if (tag === 'distinct_count_heuristic') return 'Inferred from distinct counts (lower confidence)';
  if (tag === 'equal_distinct_count_ambiguous') return 'Equal distinct counts — direction is ambiguous';
  if (tag.startsWith('overlap_')) {
    const pct = tag.replace(/[^0-9]/g, '');
    return `Value overlap ${pct}%`;
  }
  return tag;
}

function ConfidencePill({ value }: { value?: number }) {
  const { t } = useI18n();
  if (value == null) return null;
  const pct = Math.round(value * 100);
  const lowConfidence = value < CONFIDENCE_LOW_THRESHOLD;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${
        lowConfidence ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success'
      }`}
      title={
        lowConfidence
          ? t('datasets.relationshipReview.lowConfidenceTooltip')
          : t('datasets.relationshipReview.highConfidenceTooltip')
      }
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${lowConfidence ? 'bg-danger' : 'bg-success'}`}
      />
      {t('datasets.relationshipReview.percentMatch', { pct })}
    </span>
  );
}

export default function RelationshipReviewModal({
  datasetId,
  open,
  onClose,
  onApplied,
}: Props) {
  const { t } = useI18n();
  const [data, setData] = useState<RelationshipSuggestionsResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [deepScan, setDeepScan] = useState(false);

  const generate = useGenerateJoinSuggestions();
  const apply = useApplyJoinSuggestions();
  const reject = useRejectJoinSuggestions();
  const clearRejections = useClearJoinRejections();

  // Fetch once on open; the builder can re-fetch with Deep scan from inside.
  useEffect(() => {
    if (!open) return;
    setData(null);
    setSelected(new Set());
    setRejected(new Set());
    setDeepScan(false);
    void runGenerate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const runGenerate = async (withDeepScan: boolean) => {
    try {
      const result = await generate.mutateAsync({ datasetId, deepScan: withDeepScan });
      setData(result);
      // Default: pre-select only high-confidence suggestions so low-conf
      // matches get a deliberate review instead of auto-applying.
      const recKeys = new Set(
        result.recommended
          .filter((s) => (s.confidence ?? 1) >= CONFIDENCE_LOW_THRESHOLD)
          .map(suggestionKey),
      );
      setSelected(recKeys);
      setRejected(new Set());
    } catch (err) {
      toast.error(t('datasets.relationshipReview.loadFailed'));
      console.error(err);
    }
  };

  const recommended = data?.recommended ?? [];
  const existing = data?.existing ?? [];
  const obsolete = data?.obsolete ?? [];
  const warnings = data?.warnings ?? [];
  const viewLabels = data?.view_labels ?? {};

  const labelFor = (viewName: string) => viewLabels[viewName] ?? viewName;

  const toggleSelect = (s: RelationshipSuggestion) => {
    const key = suggestionKey(s);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setRejected((prev) => {
      if (!prev.has(suggestionKey(s))) return prev;
      const next = new Set(prev);
      next.delete(suggestionKey(s));
      return next;
    });
  };

  const toggleReject = (s: RelationshipSuggestion) => {
    const key = suggestionKey(s);
    setRejected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setSelected((prev) => {
      if (!prev.has(suggestionKey(s))) return prev;
      const next = new Set(prev);
      next.delete(suggestionKey(s));
      return next;
    });
  };

  const selectedSuggestions = useMemo(
    () => recommended.filter((s) => selected.has(suggestionKey(s))),
    [recommended, selected],
  );
  const rejectedSuggestions = useMemo(
    () => recommended.filter((s) => rejected.has(suggestionKey(s))),
    [recommended, rejected],
  );

  const handleApply = async () => {
    if (selectedSuggestions.length === 0 && rejectedSuggestions.length === 0) {
      onClose();
      return;
    }
    try {
      if (selectedSuggestions.length > 0) {
        const result = await apply.mutateAsync({
          datasetId,
          selections: selectedSuggestions,
        });
        toast.success(t('datasets.relationshipReview.addedToast', { count: result.added }));
        if (result.errors.length > 0) {
          toast.error(t('datasets.relationshipReview.applyPartialFailed', { count: result.errors.length }));
          console.warn('Apply errors:', result.errors);
        }
      }
      if (rejectedSuggestions.length > 0) {
        await reject.mutateAsync({
          datasetId,
          rejections: rejectedSuggestions,
        });
      }
      onApplied();
      onClose();
    } catch (err) {
      toast.error(t('datasets.relationshipReview.applyFailed'));
      console.error(err);
    }
  };

  const handleClearRejections = async () => {
    try {
      const result = await clearRejections.mutateAsync({ datasetId });
      toast.success(t('datasets.relationshipReview.clearedToast', { count: result.cleared }));
      await runGenerate(deepScan);
    } catch (err) {
      toast.error(t('datasets.relationshipReview.resetRejectionsFailed'));
      console.error(err);
    }
  };

  const isLoading = generate.isPending;
  const isFirstLoad = isLoading && !data;
  const isReScanning = isLoading && !!data;
  const isApplying = apply.isPending || reject.isPending;

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={t('datasets.relationshipReview.title')}
      size="2xl"
      contentClassName="h-[85vh]"
      footer={
        <>
          <div className="mr-auto flex items-center gap-3 text-caption text-text-tertiary">
            {data && (
              <>
                <span>
                  {t('datasets.relationshipReview.toAddToReject', {
                    add: selectedSuggestions.length,
                    reject: rejectedSuggestions.length,
                  })}
                </span>
                {data.rejected_count > 0 && (
                  <button
                    type="button"
                    onClick={handleClearRejections}
                    className="inline-flex items-center gap-1 text-info hover:underline"
                  >
                    <RotateCcw className="h-3 w-3" />
                    {t('datasets.relationshipReview.resetRejections', { count: data.rejected_count })}
                  </button>
                )}
              </>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isApplying}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleApply}
            loading={isApplying}
            disabled={
              isApplying ||
              isLoading ||
              (selectedSuggestions.length === 0 && rejectedSuggestions.length === 0)
            }
          >
            {t('datasets.relationshipReview.apply')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-3">
          <div className="flex-1">
            <p className="text-caption font-medium text-text-primary">
              {t('datasets.relationshipReview.howItWorksTitle')}
            </p>
            <p className="text-caption text-text-tertiary">
              {t('datasets.relationshipReview.howItWorksIntro')}{' '}
              <strong>{t('datasets.relationshipReview.stepDbFk')}</strong>,{' '}
              <strong>{t('datasets.relationshipReview.stepColumnMatch')}</strong>{' '}
              {t('datasets.relationshipReview.stepColumnMatchEg')}{' '}
              <code className="font-mono">customer_id</code>{' '}
              {t('datasets.relationshipReview.stepColumnMatchArrowTable')}{' '}
              <code className="font-mono">customer</code>),{' '}
              {t('datasets.relationshipReview.stepAnd')}{' '}
              <strong>{t('datasets.relationshipReview.stepSameName')}</strong>{' '}
              {t('datasets.relationshipReview.stepSameNameDesc')}{' '}
              <strong>{t('datasets.relationshipReview.deepScan')}</strong>{' '}
              {t('datasets.relationshipReview.deepScanHelp')}
            </p>
          </div>
          <div className="flex items-center gap-2 ml-3">
            <label className="flex items-center gap-2 text-caption">
              <input
                type="checkbox"
                checked={deepScan}
                onChange={(event) => setDeepScan(event.target.checked)}
                disabled={isLoading}
                className="h-4 w-4"
              />
              <span className="font-medium">{t('datasets.relationshipReview.deepScan')}</span>
            </label>
            <button
              type="button"
              onClick={() => void runGenerate(deepScan)}
              disabled={isLoading}
              className="inline-flex items-center gap-1 rounded border border-[rgb(var(--border-strong))] bg-surface-0 px-2 py-1 text-caption text-text-secondary hover:bg-surface-2 disabled:opacity-50"
            >
              {isLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              {t('datasets.relationshipReview.reScan')}
            </button>
          </div>
        </div>

        {isReScanning && (
          <div className="flex items-center gap-2 rounded-md border border-info/30 bg-info/5 p-2.5 text-caption text-info">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>
              {deepScan
                ? t('datasets.relationshipReview.reScanningDeep')
                : t('datasets.relationshipReview.reScanningBasic')}
            </span>
          </div>
        )}

        {warnings.length > 0 && (
          <div className="rounded-md border border-warning/30 bg-warning/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <div className="flex-1">
                <p className="text-caption font-medium text-warning">{t('datasets.relationshipReview.warnings')}</p>
                <ul className="mt-1 space-y-1 text-caption text-text-secondary">
                  {warnings.map((w, idx) => (
                    <li key={idx}>{w.reason}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        {isFirstLoad ? (
          <DetectingPlaceholder deepScan={deepScan} />
        ) : !data ? (
          <p className="text-center text-caption text-text-tertiary">{t('datasets.relationshipReview.noData')}</p>
        ) : (
          <>
            <Section
              title={t('datasets.relationshipReview.alreadySaved', { count: existing.length })}
              hint={t('datasets.relationshipReview.alreadySavedHint')}
              empty={t('datasets.relationshipReview.alreadySavedEmpty')}
            >
              {existing.map((s) => (
                <RelationshipRow
                  key={suggestionKey(s)}
                  suggestion={s}
                  variant="kept"
                  labelFor={labelFor}
                />
              ))}
            </Section>

            <Section
              title={t('datasets.relationshipReview.newSuggestions', { count: recommended.length })}
              hint={t('datasets.relationshipReview.newSuggestionsHint')}
              empty={
                <EmptyRecommendationsHint
                  data={data}
                  deepScan={deepScan}
                  onToggleDeepScan={() => {
                    setDeepScan(true);
                    void runGenerate(true);
                  }}
                />
              }
            >
              {recommended.map((s) => {
                const key = suggestionKey(s);
                return (
                  <RelationshipRow
                    key={key}
                    suggestion={s}
                    variant="recommended"
                    selected={selected.has(key)}
                    rejected={rejected.has(key)}
                    onToggleSelect={() => toggleSelect(s)}
                    onToggleReject={() => toggleReject(s)}
                    labelFor={labelFor}
                  />
                );
              })}
            </Section>

            {obsolete.length > 0 && (
              <Section
                title={t('datasets.relationshipReview.possiblyStale', { count: obsolete.length })}
                hint={t('datasets.relationshipReview.possiblyStaleHint')}
              >
                {obsolete.map((s) => (
                  <RelationshipRow
                    key={suggestionKey(s)}
                    suggestion={s}
                    variant="obsolete"
                    obsoleteReason={s.reason}
                    labelFor={labelFor}
                  />
                ))}
              </Section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function DetectingPlaceholder({ deepScan }: { deepScan: boolean }) {
  const { t } = useI18n();
  return (
    <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-brand" />
        <div>
          <p className="text-caption font-medium text-text-primary">
            {t('datasets.relationshipReview.detecting')}
          </p>
          <p className="mt-1 text-caption text-text-tertiary">
            {deepScan
              ? t('datasets.relationshipReview.detectingDeep')
              : t('datasets.relationshipReview.detectingBasic')}
          </p>
        </div>
        <div className="mt-2 w-full max-w-md space-y-1.5">
          <div className="h-2 animate-pulse rounded bg-surface-2" />
          <div className="h-2 w-4/5 animate-pulse rounded bg-surface-2" />
          <div className="h-2 w-3/5 animate-pulse rounded bg-surface-2" />
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  empty,
  children,
}: {
  title: string;
  hint: string;
  empty?: React.ReactNode;
  children: React.ReactNode;
}) {
  const list = React.Children.toArray(children);
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-caption font-medium text-text-primary">{title}</h3>
        <p className="text-caption text-text-tertiary">{hint}</p>
      </div>
      {list.length === 0 ? (
        typeof empty === 'string' || empty === undefined ? (
          <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-1 p-3 text-center text-caption text-text-tertiary">
            {empty || '—'}
          </p>
        ) : (
          empty
        )
      ) : (
        <div className="space-y-1.5">{list}</div>
      )}
    </div>
  );
}

function EmptyRecommendationsHint({
  data,
  deepScan,
  onToggleDeepScan,
}: {
  data: RelationshipSuggestionsResponse | null;
  deepScan: boolean;
  onToggleDeepScan: () => void;
}) {
  const { t } = useI18n();
  const stats = data?.stats;
  if (!data) return null;
  const reasons: string[] = [];
  if (stats) {
    if (stats.tables_scanned <= 1) {
      reasons.push(
        t('datasets.relationshipReview.reasonTooFewTables', { count: stats.tables_scanned }),
      );
    }
    if (
      stats.fk_constraints_found === 0 &&
      stats.name_matches_found === 0 &&
      stats.same_name_hits === 0 &&
      stats.tables_scanned > 1
    ) {
      reasons.push(
        t('datasets.relationshipReview.reasonNoSignals'),
      );
    }
    if (stats.already_existing_skipped > 0) {
      reasons.push(
        t('datasets.relationshipReview.reasonAlreadyExisting', { count: stats.already_existing_skipped }),
      );
    }
    if (stats.rejected_skipped > 0) {
      reasons.push(
        t('datasets.relationshipReview.reasonRejectedSkipped', { count: stats.rejected_skipped }),
      );
    }
    if (stats.quota_warnings > 0) {
      reasons.push(
        t('datasets.relationshipReview.reasonQuota', { count: stats.quota_warnings }),
      );
    } else if (!deepScan) {
      reasons.push(
        t('datasets.relationshipReview.reasonDeepScanOff'),
      );
    } else if (stats.key_like_columns_total === 0) {
      reasons.push(
        t('datasets.relationshipReview.reasonNoKeyLike'),
      );
    } else if (stats.overlap_probes_run === 0) {
      reasons.push(
        t('datasets.relationshipReview.reasonNoCompatiblePairs', { count: stats.key_like_columns_total }),
      );
    } else if (stats.overlap_probes_failed > 0 && stats.overlap_probes_hit === 0) {
      reasons.push(
        t('datasets.relationshipReview.reasonProbesFailed', {
          run: stats.overlap_probes_run,
          failed: stats.overlap_probes_failed,
        }),
      );
    } else if (stats.overlap_probes_below_threshold > 0 && stats.overlap_probes_hit === 0) {
      reasons.push(
        t('datasets.relationshipReview.reasonProbesBelowThreshold', {
          run: stats.overlap_probes_run,
          below: stats.overlap_probes_below_threshold,
        }),
      );
    }
  }

  return (
    <div className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-1 p-3 text-caption">
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" />
        <div className="flex-1 space-y-2">
          <p className="font-medium text-text-primary">{t('datasets.relationshipReview.noNewSuggestions')}</p>
          {reasons.length > 0 && (
            <ul className="ml-4 list-disc space-y-1 text-text-tertiary">
              {reasons.map((reason, idx) => (
                <li key={idx}>{reason}</li>
              ))}
            </ul>
          )}
          {stats && (
            <div className="space-y-0.5 text-text-quaternary">
              <p>
                {t('datasets.relationshipReview.statsScanned', {
                  tables: stats.tables_scanned,
                  keyLike: stats.key_like_columns_total,
                  fk: stats.fk_constraints_found,
                  nameMatch: stats.name_matches_found,
                  sameName: stats.same_name_hits,
                })}
                {stats.overlap_probes_run > 0
                  ? t('datasets.relationshipReview.statsDeepProbes', {
                      hit: stats.overlap_probes_hit,
                      below: stats.overlap_probes_below_threshold,
                      failed: stats.overlap_probes_failed,
                      total: stats.overlap_probes_run,
                    })
                  : ''}
              </p>
              <p>
                {stats.tables_with_db_pk > 0 || stats.tables_with_raw_types > 0
                  ? t('datasets.relationshipReview.statsDbIntrospectionOk', {
                      pk: stats.tables_with_db_pk,
                      rawType: stats.tables_with_raw_types,
                    })
                  : t('datasets.relationshipReview.statsDbIntrospectionFail')}
              </p>
              {stats.datasource_reads > 0 && (
                <p>
                  {t('datasets.relationshipReview.statsDatasourceReads', { count: stats.datasource_reads })}
                  {stats.quota_warnings > 0
                    ? t('datasets.relationshipReview.statsQuotaWarnings', { count: stats.quota_warnings })
                    : ''}
                </p>
              )}
            </div>
          )}
          {!deepScan && (
            <button
              type="button"
              onClick={onToggleDeepScan}
              className="inline-flex items-center gap-1 rounded border border-brand/40 bg-brand/10 px-2 py-1 text-caption text-brand hover:bg-brand/20"
            >
              {t('datasets.relationshipReview.enableDeepScanRerun')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function RelationshipRow({
  suggestion,
  variant,
  selected,
  rejected,
  onToggleSelect,
  onToggleReject,
  obsoleteReason,
  labelFor,
}: {
  suggestion: RelationshipSuggestion;
  variant: 'kept' | 'recommended' | 'obsolete';
  selected?: boolean;
  rejected?: boolean;
  onToggleSelect?: () => void;
  onToggleReject?: () => void;
  obsoleteReason?: string;
  labelFor: (viewName: string) => string;
}) {
  const { t } = useI18n();
  const isActive = variant === 'recommended' && selected;
  const isDimmed = variant === 'recommended' && rejected;
  const lowConfidence =
    variant === 'recommended' &&
    suggestion.confidence != null &&
    suggestion.confidence < CONFIDENCE_LOW_THRESHOLD;

  return (
    <div
      className={`flex items-start gap-3 rounded-md border p-2.5 ${
        isActive
          ? 'border-brand/40 bg-brand/5'
          : isDimmed
            ? 'border-[rgb(var(--border-line))] bg-surface-1 opacity-60'
            : variant === 'obsolete'
              ? 'border-warning/30 bg-warning/5'
              : lowConfidence
                ? 'border-danger/30 bg-danger/5'
                : 'border-[rgb(var(--border-line))] bg-surface-1'
      }`}
    >
      {variant === 'recommended' && (
        <input
          type="checkbox"
          checked={!!selected}
          onChange={onToggleSelect}
          className="mt-1 h-4 w-4"
          aria-label={t('datasets.relationshipReview.addThisRelationship')}
        />
      )}
      {variant === 'kept' && (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      )}
      {variant === 'obsolete' && (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      )}

      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-1.5 text-caption">
          <TableColumnTag
            tableLabel={labelFor(suggestion.from_view)}
            columns={suggestion.from_columns}
          />
          <span className="text-text-tertiary">→</span>
          <TableColumnTag
            tableLabel={labelFor(suggestion.to_view)}
            columns={suggestion.to_columns}
          />
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${originTone(suggestion.origin)}`}
          >
            {originLabel(suggestion.origin)}
          </span>
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-tertiary">
            {suggestion.relationship.replace(/_/g, '-')}
          </span>
          <ConfidencePill value={suggestion.confidence} />
          {lowConfidence && (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-medium text-danger"
              title="This suggestion may not be a real relationship — review carefully before applying."
            >
              <AlertCircle className="h-3 w-3" />
              Review carefully
            </span>
          )}
        </div>
        {suggestion.reasons && suggestion.reasons.length > 0 && (
          <p className="mt-1 text-caption text-text-tertiary">
            Why: {suggestion.reasons.map(formatReason).join(' · ')}
          </p>
        )}
        {obsoleteReason && (
          <p className="mt-1 text-caption text-warning">{obsoleteReason}</p>
        )}
      </div>

      {variant === 'recommended' && onToggleReject && (
        <button
          type="button"
          onClick={onToggleReject}
          className={`shrink-0 rounded p-1 text-text-tertiary hover:bg-danger/10 hover:text-danger ${
            rejected ? 'bg-danger/10 text-danger' : ''
          }`}
          title={rejected ? 'Undo reject' : "Reject (won't be suggested again)"}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function TableColumnTag({
  tableLabel,
  columns,
}: {
  tableLabel: string;
  columns: string[];
}) {
  return (
    <span className="inline-flex items-center gap-0.5 rounded bg-surface-2 px-1 font-mono text-text-primary">
      <span className="font-medium">{tableLabel}</span>
      <span className="text-text-tertiary">.</span>
      <span>{columns.join('+')}</span>
    </span>
  );
}
