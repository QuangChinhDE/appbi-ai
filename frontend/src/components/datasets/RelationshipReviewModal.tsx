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
          ? 'Low confidence — please double-check this relationship before applying'
          : 'High confidence'
      }
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${lowConfidence ? 'bg-danger' : 'bg-success'}`}
      />
      {pct}% match
    </span>
  );
}

export default function RelationshipReviewModal({
  datasetId,
  open,
  onClose,
  onApplied,
}: Props) {
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
      toast.error('Failed to load relationship data.');
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
        toast.success(`Added ${result.added} relationship${result.added === 1 ? '' : 's'}.`);
        if (result.errors.length > 0) {
          toast.error(`${result.errors.length} relationship(s) failed — see console.`);
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
      toast.error('Apply failed.');
      console.error(err);
    }
  };

  const handleClearRejections = async () => {
    try {
      const result = await clearRejections.mutateAsync({ datasetId });
      toast.success(`Cleared ${result.cleared} rejection${result.cleared === 1 ? '' : 's'}.`);
      await runGenerate(deepScan);
    } catch (err) {
      toast.error('Failed to reset rejections.');
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
      title="Detect relationships"
      size="2xl"
      contentClassName="h-[85vh]"
      footer={
        <>
          <div className="mr-auto flex items-center gap-3 text-caption text-text-tertiary">
            {data && (
              <>
                <span>
                  {selectedSuggestions.length} to add ·{' '}
                  {rejectedSuggestions.length} to reject
                </span>
                {data.rejected_count > 0 && (
                  <button
                    type="button"
                    onClick={handleClearRejections}
                    className="inline-flex items-center gap-1 text-info hover:underline"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Reset {data.rejected_count} rejection{data.rejected_count === 1 ? '' : 's'}
                  </button>
                )}
              </>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isApplying}>
            Cancel
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
            Apply
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-3">
          <div className="flex-1">
            <p className="text-caption font-medium text-text-primary">
              How detection works
            </p>
            <p className="text-caption text-text-tertiary">
              Three steps run by default: <strong>DB foreign keys</strong>,{' '}
              <strong>column-name match</strong> (e.g. <code className="font-mono">customer_id</code>{' '}
              → table <code className="font-mono">customer</code>), and{' '}
              <strong>same-name overlap probe</strong> (two tables sharing a
              column name with matching values). Enable <strong>Deep scan</strong>{' '}
              to additionally probe value overlap between differently-named
              columns (slower).
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
              <span className="font-medium">Deep scan</span>
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
              Re-scan
            </button>
          </div>
        </div>

        {isReScanning && (
          <div className="flex items-center gap-2 rounded-md border border-info/30 bg-info/5 p-2.5 text-caption text-info">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>
              {deepScan
                ? 'Probing data values across tables… this may take 10–30 seconds.'
                : 'Scanning foreign keys, column names, and same-name overlaps…'}
            </span>
          </div>
        )}

        {warnings.length > 0 && (
          <div className="rounded-md border border-warning/30 bg-warning/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <div className="flex-1">
                <p className="text-caption font-medium text-warning">Warnings</p>
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
          <p className="text-center text-caption text-text-tertiary">No data.</p>
        ) : (
          <>
            <Section
              title={`Already saved (${existing.length})`}
              hint="Relationships already on the model — read-only here."
              empty="No relationships saved yet."
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
              title={`New suggestions (${recommended.length})`}
              hint="Tick to add, or click × to reject (won't be suggested again)."
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
                title={`Possibly stale (${obsolete.length})`}
                hint="Saved joins whose columns or views no longer exist — review manually on the canvas."
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
  return (
    <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-brand" />
        <div>
          <p className="text-caption font-medium text-text-primary">
            Detecting relationships…
          </p>
          <p className="mt-1 text-caption text-text-tertiary">
            {deepScan
              ? 'Probing value overlap across every type-compatible column pair. This takes 10–30 seconds depending on the datasource.'
              : 'Reading foreign-key constraints, matching column names, and probing same-name columns across tables.'}
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
  const stats = data?.stats;
  if (!data) return null;
  const reasons: string[] = [];
  if (stats) {
    if (stats.tables_scanned <= 1) {
      reasons.push(
        `Dataset only has ${stats.tables_scanned} table — at least 2 tables are needed to form a relationship.`,
      );
    }
    if (
      stats.fk_constraints_found === 0 &&
      stats.name_matches_found === 0 &&
      stats.same_name_hits === 0 &&
      stats.tables_scanned > 1
    ) {
      reasons.push(
        'No declared foreign keys, no `*_id` columns matching another table\'s name, and no two tables share a column name with overlapping values.',
      );
    }
    if (stats.already_existing_skipped > 0) {
      reasons.push(
        `${stats.already_existing_skipped} relationship(s) are already saved (see "Already saved" above) — the detector doesn't re-suggest them.`,
      );
    }
    if (stats.rejected_skipped > 0) {
      reasons.push(
        `${stats.rejected_skipped} suggestion(s) were previously rejected. Click "Reset rejections" below to see them again.`,
      );
    }
    if (stats.quota_warnings > 0) {
      reasons.push(
        `Datasource rate limit hit (e.g. Google Sheets 60 reads/minute) — ${stats.quota_warnings} table(s) were skipped. Wait a minute and click Re-scan.`,
      );
    } else if (!deepScan) {
      reasons.push(
        'Deep scan is off. Enable it and Re-scan to probe value overlap between differently-named columns too.',
      );
    } else if (stats.key_like_columns_total === 0) {
      reasons.push(
        'No table has any "key-like" columns (numeric / short string). Check that columns_cache has been populated and types are tagged.',
      );
    } else if (stats.overlap_probes_run === 0) {
      reasons.push(
        `Found ${stats.key_like_columns_total} key-like column(s) but no type-compatible pairs. Cached type labels may not match the detector's known types — ask a dev to check BE logs for "Overlap probe".`,
      );
    } else if (stats.overlap_probes_failed > 0 && stats.overlap_probes_hit === 0) {
      reasons.push(
        `Probed ${stats.overlap_probes_run} column pair(s), ${stats.overlap_probes_failed} of which failed (timeout / type mismatch). See BE logs for "Overlap probe SQL failed".`,
      );
    } else if (stats.overlap_probes_below_threshold > 0 && stats.overlap_probes_hit === 0) {
      reasons.push(
        `Probed ${stats.overlap_probes_run} column pair(s), ${stats.overlap_probes_below_threshold} of which had less than 50% overlap. The data may not match across tables — verify staging or test with real data.`,
      );
    }
  }

  return (
    <div className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-1 p-3 text-caption">
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" />
        <div className="flex-1 space-y-2">
          <p className="font-medium text-text-primary">No new suggestions</p>
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
                Scanned: {stats.tables_scanned} table(s) ·{' '}
                {stats.key_like_columns_total} key-like column(s) ·{' '}
                {stats.fk_constraints_found} FK ·{' '}
                {stats.name_matches_found} name match ·{' '}
                {stats.same_name_hits} same-name hit
                {stats.overlap_probes_run > 0
                  ? ` · deep ${stats.overlap_probes_hit} hit / ${stats.overlap_probes_below_threshold} below threshold / ${stats.overlap_probes_failed} failed (total ${stats.overlap_probes_run})`
                  : ''}
              </p>
              <p>
                DB introspection:{' '}
                {stats.tables_with_db_pk > 0 || stats.tables_with_raw_types > 0
                  ? `${stats.tables_with_db_pk} table(s) with PK, ${stats.tables_with_raw_types} with raw type — used to pick target column and cardinality.`
                  : 'Could not read PK / type from source DB (datasource is not PG / MySQL / BigQuery, or the query failed).'}
              </p>
              {stats.datasource_reads > 0 && (
                <p>
                  Datasource reads: {stats.datasource_reads}
                  {stats.quota_warnings > 0
                    ? ` · ${stats.quota_warnings} quota warning(s)`
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
              Enable Deep scan and re-run
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
          aria-label="Add this relationship"
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
