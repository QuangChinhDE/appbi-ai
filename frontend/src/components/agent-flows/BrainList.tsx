'use client';

/**
 * The catalogue of brains.
 *
 * BUILT LIKE THE OTHER CATALOGUES, DELIBERATELY.
 * Datasets, dashboards, datasources, workboards and explore all render
 * `PageListLayout` + a stats strip + click-to-filter tags + `PaginatedCollection`
 * over a grid of cards and an `app-list-table`. This screen does the same, with the
 * same class names, because a module that invents its own list is a module users
 * have to learn twice — and the previous version of this file had no filters, no
 * pagination, no owner, no row actions, and showed `brain_key` as the most
 * prominent thing about a brain.
 *
 * WHAT A ROW HAS TO ANSWER
 * Not "what is it called" — the name does that. It has to answer *is anything
 * running this*, and *how big is it*, because those decide whether editing it is
 * safe. Both come from the server (`link_count`, `step_count`); neither was on
 * screen before.
 */
import {
  AlertTriangle, Brain, Calendar, Check, ChevronRight, Copy, Layers, Link2, Loader2,
  MessagesSquare, Plus, Share2, Trash2,
} from 'lucide-react';
import React from 'react';

import { AppModalShell } from '@/components/common/AppModalShell';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { PageListLayout } from '@/components/common/PageListLayout';
import { PaginatedCollection } from '@/components/common/PaginatedCollection';
import { ShareDialog } from '@/components/common/ShareDialog';
import { Button, IconButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterTag } from '@/components/ui/FilterTag';
import { FieldGroup, Input, Textarea } from '@/components/ui/Input';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import {
  blankNode, deleteBrainVersion, getAuthoringPrompt, getBrain, importDraft, listBrains,
  saveBrain, starterFlow,
  type FlowType, slugifyBrainKey,
  type AuthoringPrompt,
  type BrainDetail,
  type BrainSummary,
  type FlowBody,
  type FlowNode,
  type ImportedDraft,
} from '@/lib/agentFlows';

import { MetaChip, StatusBadge, formatWhen } from './shared';

type StatusFilter = 'all' | 'published' | 'draft';

const FILTERS: { key: StatusFilter; labelKey: string }[] = [
  { key: 'all', labelKey: 'agentFlows.list.filter.all' },
  { key: 'published', labelKey: 'agentFlows.list.filter.published' },
  { key: 'draft', labelKey: 'agentFlows.list.filter.draft' },
];

/** The newest version of each brain, plus what its published state actually is.
 *
 *  `/brains` returns EVERY version, so listing rows verbatim reads as ten brains
 *  where there is one. Collapsing to the newest is not enough on its own either: a
 *  brain whose newest version is a draft may still have a published version
 *  answering viewers right now, and a row that says only "Nháp v4" hides that. */
export interface BrainRowModel {
  latest: BrainSummary;
  publishedVersion: number | null;
  versionCount: number;
}

function collapse(rows: BrainSummary[]): BrainRowModel[] {
  const byKey = new Map<string, BrainRowModel>();
  rows.forEach((row) => {
    const cur = byKey.get(row.brain_key);
    if (!cur) {
      byKey.set(row.brain_key, {
        latest: row,
        publishedVersion: row.status === 'published' ? row.version : null,
        versionCount: 1,
      });
      return;
    }
    if (row.version > cur.latest.version) cur.latest = row;
    if (row.status === 'published') cur.publishedVersion = row.version;
    cur.versionCount += 1;
  });
  return [...byKey.values()].sort((a, b) => a.latest.name.localeCompare(b.latest.name, 'vi'));
}

/** Which body a new flow starts life with.
 *
 *  `blank` is the original two-step seed. `bi_report` is the V1 starter. It is a
 *  choice of CONTENT, not a mode of the product: both end at the same save call
 *  and the same builder. */
type CreatePreset = 'blank' | 'bi_report';

export function BrainList({
  onOpen, canEdit,
}: {
  onOpen: (idOrKey: string | number) => void;
  canEdit: boolean;
}) {
  const { t } = useI18n();
  const [rows, setRows] = React.useState<BrainSummary[] | null>(null);
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState<StatusFilter>('all');
  const [creating, setCreating] = React.useState(false);
  const [shareTarget, setShareTarget] = React.useState<BrainSummary | null>(null);
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<BrainRowModel | null>(null);

  const reload = React.useCallback(async () => {
    try {
      setRows(await listBrains());
    } catch {
      setRows([]);
      toast.error(t('agentFlows.list.loadFailed'));
    }
  }, [t]);
  React.useEffect(() => { void reload(); }, [reload]);

  const brains = React.useMemo(() => collapse(rows || []), [rows]);

  const shown = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return brains.filter((b) => {
      if (status === 'published' && b.publishedVersion === null) return false;
      if (status === 'draft' && b.publishedVersion !== null) return false;
      if (!q) return true;
      return b.latest.name.toLowerCase().includes(q)
        || b.latest.brain_key.toLowerCase().includes(q)
        || (b.latest.description || '').toLowerCase().includes(q);
    });
  }, [brains, search, status]);

  const liveCount = brains.filter((b) => b.publishedVersion !== null).length;
  const servingCount = brains.reduce((n, b) => n + (b.latest.link_count || 0), 0);

  /** THE TYPE DECIDES THE SEED, because the two surfaces hand a flow different
   *  things and a starting flow should already be shaped for what it will get.
   *
   *  bot   a report always arrives, so the flow opens by reading it.
   *  chat  only text arrives. There is no "the report", so the flow opens by
   *        working out which of the things its author granted the question is
   *        about — which is what the discover tools are for.
   *
   *  Before this every flow was seeded `report_read → agent` regardless, so every
   *  flow was born unable to run in Chat and nothing said so.
   */
  const create = async (
    name: string, description: string, flowType: FlowType, preset: CreatePreset = 'blank',
  ) => {
    const key = slugifyBrainKey(name);

    // THE STARTER IS NOT A SECOND CREATION PATH. It produces a body and falls
    // into the same `saveBrain` below, so a flow born from it is indistinguishable
    // from one built by hand the moment it exists.
    if (preset === 'bi_report') {
      await saveBrain({
        brain_key: key,
        name: name.trim(),
        description: description.trim() || t('agentFlows.list.starter.defaultDescription'),
        flow_type: 'bot',
        body: starterFlow(t),
      });
      setCreating(false);
      onOpen(key);
      return;
    }

    const nodes: FlowNode[] = [];
    let writer: FlowNode;

    if (flowType === 'bot') {
      const reader = blankNode('report_read', []);
      writer = blankNode('agent', [reader]) as FlowNode;
      nodes.push({ ...reader, name: t('agentFlows.list.seed.readerName') } as FlowNode);
      nodes.push({
        ...writer,
        name: t('agentFlows.list.seed.writerName'),
        prompt: t('agentFlows.list.seed.writerPrompt'),
      } as FlowNode);
    } else {
      writer = blankNode('agent', []) as FlowNode;
      nodes.push({
        ...writer,
        name: t('agentFlows.list.seed.chatWriterName'),
        prompt: t('agentFlows.list.seed.chatWriterPrompt'),
        // Granted rather than left to the author to find: without a way to work
        // out WHICH asset a question is about, a chat flow has nothing to measure.
        tools: [{ tool: 'search_business_assets' }, { tool: 'resolve_chart_candidates' }],
      } as FlowNode);
    }

    await saveBrain({
      brain_key: key,
      name: name.trim(),
      description: description.trim(),
      flow_type: flowType,
      body: { nodes, answer_node: writer.key },
    });
    setCreating(false);
    onOpen(key);
  };

  /** Save a draft an outside assistant wrote, then open it in the builder.
   *
   *  Saved through the SAME `saveBrain` the blank path uses — the import
   *  endpoint only reads and reports, so there is no second way for a flow to
   *  enter the system. What arrives here has already passed the real contract. */
  const createFromDraft = async (d: ImportedDraft) => {
    const flowName = (d.name || '').trim() || t('agentFlows.list.create.ai.draftName');
    const key = slugifyBrainKey(flowName);
    await saveBrain({
      brain_key: key,
      name: flowName,
      description: (d.description || '').trim(),
      // The server returns the body it already validated through the real `Flow`
      // contract, so `nodes` is present by construction — the cast says that
      // rather than widening the client type and losing the check everywhere else.
      body: (d.body || { nodes: [] }) as unknown as FlowBody,
    });
    setCreating(false);
    onOpen(key);
  };

  const duplicate = async (row: BrainRowModel) => {
    setBusyKey(row.latest.brain_key);
    try {
      // Copies the version the author is looking at, not "the published one":
      // duplicating a draft you are iterating on is the common case.
      const source = await getBrain(row.latest.brain_key, row.latest.version);
      const name = `${source.name} (${t('agentFlows.list.duplicateSuffix')})`;
      await saveBrain({
        brain_key: slugifyBrainKey(name),
        name,
        description: source.description,
        body: source.body,
      });
      toast.success(t('agentFlows.list.duplicateSuccess'));
      await reload();
    } catch (e) {
      toast.error(detailMsg(e) || t('agentFlows.list.duplicateFailed'));
    } finally {
      setBusyKey(null);
    }
  };

  const removeDraft = async (row: BrainRowModel) => {
    setBusyKey(row.latest.brain_key);
    try {
      await deleteBrainVersion(row.latest.brain_key, row.latest.version);
      toast.success(t('agentFlows.list.deleteSuccess', { version: row.latest.version }));
      await reload();
    } catch (e) {
      toast.error(detailMsg(e) || t('agentFlows.list.deleteFailed'));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <>
      <PageListLayout
        title={t('agentFlows.title')}
        description={t('agentFlows.list.description')}
        overview={(
          <ModuleOverview
            icon={Brain}
            title="Agent Flows"
            stats={[
              { label: t('agentFlows.list.stat.brains'), value: brains.length },
              { label: t('agentFlows.list.stat.running'), value: liveCount, helper: t('agentFlows.list.stat.runningHelper') },
              { label: t('agentFlows.list.stat.draftOnly'), value: brains.length - liveCount, helper: t('agentFlows.list.stat.draftOnlyHelper') },
              { label: t('agentFlows.list.stat.linksUsing'), value: servingCount, helper: t('agentFlows.list.stat.linksUsingHelper') },
            ]}
            storageKey="agent-flows-overview"
          />
        )}
        action={canEdit ? (
          <Button data-testid="new-flow" size="sm" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>
            {t('agentFlows.list.newBrain')}
          </Button>
        ) : undefined}
        isLoading={rows === null}
        loadingText={t('agentFlows.list.loading')}
        searchPlaceholder={t('agentFlows.list.searchPlaceholder')}
        searchValue={search}
        onSearchValueChange={setSearch}
        defaultView="list"
        toolbarExtra={(
          <div className="flex items-center gap-1.5">
            {FILTERS.map((f) => (
              <FilterTag
                key={f.key}
                tone={f.key === 'published' ? 'success' : f.key === 'draft' ? 'warning' : 'neutral'}
                active={status === f.key}
                onClick={() => setStatus(f.key)}
              >
                {t(f.labelKey)}
              </FilterTag>
            ))}
          </div>
        )}
      >
        {({ viewMode }) => {
          if (brains.length === 0) {
            return (
              <EmptyState
                icon={<Brain className="h-6 w-6" />}
                title={t('agentFlows.list.emptyTitle')}
                description={t('agentFlows.list.emptyDescription')}
                action={canEdit ? (
                  <Button size="sm" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>
                    {t('agentFlows.list.newBrain')}
                  </Button>
                ) : undefined}
              />
            );
          }
          if (shown.length === 0) {
            return (
              <EmptyState
                icon={<Brain className="h-6 w-6" />}
                title={t('agentFlows.list.noMatchTitle')}
                description={t('agentFlows.list.noMatchDescription')}
                action={(
                  <Button size="sm" variant="secondary" onClick={() => { setSearch(''); setStatus('all'); }}>
                    {t('agentFlows.list.clearFilters')}
                  </Button>
                )}
              />
            );
          }

          return (
            <PaginatedCollection
              items={shown}
              viewMode={viewMode}
              resetKey={`${search}|${status}|${viewMode}`}
            >
              {({ pageItems, pagination, hasFooter }) => (
                <div className={viewMode === 'grid' ? 'space-y-3' : undefined}>
                  {viewMode === 'grid' ? (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {pageItems.map((row) => (
                        <BrainCard
                          key={row.latest.brain_key}
                          row={row}
                          canEdit={canEdit}
                          busy={busyKey === row.latest.brain_key}
                          onOpen={onOpen}
                          onDuplicate={() => void duplicate(row)}
                          onDelete={() => setConfirmDelete(row)}
                          onShare={() => setShareTarget(row.latest)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className={`border border-[rgb(var(--border-line))] bg-surface-1 ${hasFooter ? 'rounded-t-xl border-b-0' : 'rounded-xl'}`}>
                      <div className="app-list-table-wrap">
                        <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
                          <thead className="bg-surface-2">
                            <tr>
                              <th className="app-list-header w-[34%]">{t('agentFlows.list.header.brain')}</th>
                              <th className="app-list-header w-[14%]">{t('agentFlows.list.header.status')}</th>
                              <th className="app-list-header w-[10%]">{t('agentFlows.list.header.steps')}</th>
                              <th className="app-list-header w-[12%]">{t('agentFlows.list.header.links')}</th>
                              <th className="app-list-header w-[14%]">{t('agentFlows.list.header.owner')}</th>
                              <th className="app-list-header w-[12%]">{t('agentFlows.list.header.updated')}</th>
                              {/* Wide enough for the uppercase tracked label on one
                                  line; at 92px "HÀNH ĐỘNG" wrapped and pushed the
                                  header row to two lines. */}
                              <th className="app-list-header w-[116px] text-right">{t('agentFlows.list.header.actions')}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                            {pageItems.map((row) => (
                              <BrainTableRow
                                key={row.latest.brain_key}
                                row={row}
                                canEdit={canEdit}
                                busy={busyKey === row.latest.brain_key}
                                onOpen={onOpen}
                                onDuplicate={() => void duplicate(row)}
                                onDelete={() => setConfirmDelete(row)}
                                onShare={() => setShareTarget(row.latest)}
                              />
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  {pagination}
                </div>
              )}
            </PaginatedCollection>
          );
        }}
      </PageListLayout>

      {creating && (
        <CreateBrainModal
          onClose={() => setCreating(false)}
          onCreate={create}
          onCreateFromDraft={createFromDraft}
        />
      )}

      <ConfirmDialog
        isOpen={confirmDelete !== null}
        title={t('agentFlows.list.deleteTitle', { version: confirmDelete?.latest.version ?? '' })}
        description={
          confirmDelete?.publishedVersion !== null && confirmDelete
            ? t('agentFlows.list.deletePublishedDescription', { name: confirmDelete.latest.name, version: confirmDelete.publishedVersion })
            : t('agentFlows.list.deleteOnlyDraftDescription', { name: confirmDelete?.latest.name ?? '' })
        }
        confirmLabel={t('agentFlows.list.deleteConfirm')}
        variant="danger"
        onConfirm={() => { if (confirmDelete) void removeDraft(confirmDelete); }}
        onClose={() => setConfirmDelete(null)}
      />

      {/* Shares are keyed by `brain_key`, not by a version id — one share covers
          the flow across every version of it, which is what "I shared this flow
          with you" has to mean for a resource that gets re-saved. */}
      {shareTarget && (
        <ShareDialog
          resourceType="agent_brain"
          resourceId={shareTarget.brain_key}
          resourceName={shareTarget.name}
          notice={<SharedReach brainKey={shareTarget.brain_key} />}
          onClose={() => setShareTarget(null)}
        />
      )}
    </>
  );
}

/** WHAT SHARING THIS FLOW LENDS.
 *
 *  Sharing an Agent Flow is not like sharing a report. Whoever receives it can ask
 *  it questions, and it answers using its AUTHOR's reading rights over everything
 *  it attached — the recipient needs no access of their own to any of it. That is
 *  the module's model on purpose (`permissions.run_scope`: "the reader is not a
 *  term"), and the thing that keeps it honest is saying so here.
 *
 *  It matters more since an attached dataset started granting the charts built on
 *  it: one dataset reaches 184 charts across 8 reports on this deployment, so
 *  "shared a dataset with this assistant" is a far larger statement than it looks.
 *  The count is shown for that reason.
 *
 *  Fetched when the dialog opens rather than carried on the list row: it needs the
 *  flow BODY, and putting that on every row of the gallery would be a body per
 *  card for a panel most people never open.
 */
function SharedReach({ brainKey }: { brainKey: string }) {
  const { t } = useI18n();
  const [reads, setReads] = React.useState<BrainDetail['reads'] | null>(null);

  React.useEffect(() => {
    let alive = true;
    getBrain(brainKey)
      .then((d) => { if (alive) setReads(d.reads || []); })
      // Silent: a failed disclosure must not block sharing, and an empty panel
      // says nothing false. The server-side `check_attachments` gate is what
      // actually bounds the delegation.
      .catch(() => { if (alive) setReads([]); });
    return () => { alive = false; };
  }, [brainKey]);

  if (!reads?.length) return null;
  return (
    <div className="rounded-lg border border-warning/25 bg-warning/5 p-3">
      <p className="text-caption leading-relaxed text-warning">
        {t('agentFlows.list.share.lendsTitle')}
      </p>
      <ul className="mt-2 space-y-1">
        {reads.map((r) => (
          <li key={`${r.source}:${r.ref}`} className="flex items-center gap-1.5 text-tiny text-text-secondary">
            <MetaChip muted>{r.label}</MetaChip>
            <span className="min-w-0 truncate">{r.name || r.ref}</span>
            {r.reach && <span className="flex-shrink-0 text-text-quaternary">· {r.reach}</span>}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-tiny leading-relaxed text-text-tertiary">
        {t('agentFlows.list.share.lendsHint')}
      </p>
    </div>
  );
}

function detailMsg(e: unknown): string | undefined {
  return (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
}

/** Whether the newest version is a draft that can be thrown away. The server
 *  refuses to delete a published version, so offering the action would be offering
 *  a 409. */
function isDeletableDraft(row: BrainRowModel): boolean {
  return row.latest.status === 'draft';
}

/* ── grid card ────────────────────────────────────────────────────────────── */

function BrainCard({
  row, canEdit, busy, onOpen, onDuplicate, onDelete, onShare,
}: {
  row: BrainRowModel;
  canEdit: boolean;
  busy: boolean;
  onOpen: (idOrKey: string | number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onShare: () => void;
}) {
  const { t, locale } = useI18n();
  const b = row.latest;
  const links = b.link_count || 0;
  return (
    <div className="group rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 transition-[box-shadow,border-color] hover:border-[rgb(var(--border-strong))] hover:shadow-linear">
      <button type="button" onClick={() => onOpen(b.flow_id ?? b.brain_key)} className="w-full p-4 text-left">
        <div className="mb-2.5 flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <Brain className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-small font-strong text-text-primary transition-colors group-hover:text-brand">
                {b.name}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5">
                <StatusBadge
                  status={row.publishedVersion !== null ? 'published' : 'draft'}
                  version={row.publishedVersion ?? b.version}
                  size="xs"
                />
                {row.publishedVersion !== null && b.status === 'draft' && (
                  <MetaChip tone="warning">{t('agentFlows.list.draftUnpublished', { version: b.version })}</MetaChip>
                )}
                {/* WHICH SURFACE, IN THE LIST. A gallery where half the entries
                    cannot be used where you are standing has to say which half
                    from the outside — otherwise the only way to find out is to
                    open each one. */}
                <MetaChip muted>
                  {t('agentFlows.list.create.type.' + (b.flow_type ?? 'bot') + '.name')}
                </MetaChip>
              </span>
            </span>
          </div>
          <ChevronRight className="h-4 w-4 flex-shrink-0 text-text-quaternary transition-colors group-hover:text-brand" />
        </div>

        <p className="mb-3 line-clamp-2 min-h-[2.25rem] text-caption leading-relaxed text-text-secondary">
          {b.description || <span className="text-text-quaternary">{t('agentFlows.list.noDescriptionOpen')}</span>}
        </p>

        <div className="flex flex-wrap items-center gap-3 text-tiny text-text-quaternary">
          <span className="inline-flex items-center gap-1">
            <Layers className="h-3 w-3" />
            {t('agentFlows.list.stepCount', { count: b.node_count ?? 0 })}
          </span>
          {/* A chat flow cannot be attached to a report link, so "0 links" is not
              a state it is in — it is a sentence that does not apply. */}
          {(b.flow_type ?? 'bot') === 'chat' ? (
            <span className="inline-flex items-center gap-1">
              <MessagesSquare className="h-3 w-3" />
              {t('agentFlows.list.usedInChat')}
            </span>
          ) : (
            <span className={`inline-flex items-center gap-1 ${links > 0 ? 'text-brand' : ''}`}>
              <Link2 className="h-3 w-3" />
              {links > 0 ? t('agentFlows.list.linksUsingCount', { count: links }) : t('agentFlows.list.noLinksUsing')}
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            {formatWhen(b.published_at || b.created_at, locale)}
          </span>
        </div>
      </button>

      <div className="flex items-center justify-between gap-1 border-t border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5">
        <OwnerBadge email={b.owner_email} />
        <div className="flex items-center gap-0.5">
          <IconButton
            aria-label={t('agentFlows.list.shareAria')} variant="ghost" size="sm"
            title={t('agentFlows.list.shareTitle')} disabled={busy} onClick={onShare}
          >
            <Share2 className="h-3.5 w-3.5" />
          </IconButton>
          {canEdit && (
            <IconButton
              aria-label={t('agentFlows.list.duplicateAria')} variant="ghost" size="sm" title={t('agentFlows.list.duplicateTitle')}
              disabled={busy} onClick={onDuplicate}
            >
              <Copy className="h-3.5 w-3.5" />
            </IconButton>
          )}
          {canEdit && isDeletableDraft(row) && (
            <IconButton
              aria-label={t('agentFlows.list.deleteDraftAria')} variant="ghost" size="sm" title={t('agentFlows.list.deleteConfirm')}
              className="hover:text-danger" disabled={busy} onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── table row ────────────────────────────────────────────────────────────── */

function BrainTableRow({
  row, canEdit, busy, onOpen, onDuplicate, onDelete, onShare,
}: {
  row: BrainRowModel;
  canEdit: boolean;
  busy: boolean;
  onOpen: (idOrKey: string | number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onShare: () => void;
}) {
  const { t, locale } = useI18n();
  const b = row.latest;
  const links = b.link_count || 0;
  return (
    <tr className="hover:bg-surface-2">
      <td className="app-list-cell">
        <button type="button" onClick={() => onOpen(b.flow_id ?? b.brain_key)} className="flex w-full items-start gap-3 text-left">
          <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
            <Brain className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="app-list-text-main block text-caption font-emphasis text-text-primary transition-colors hover:text-brand">
              {b.name}
            </span>
            <span className="app-list-text-sub mt-0.5 block text-tiny text-text-tertiary">
              {b.description || t('agentFlows.list.noDescription')}
            </span>
          </span>
        </button>
      </td>
      <td className="app-list-cell">
        <div className="flex flex-col items-start gap-1">
          <StatusBadge
            status={row.publishedVersion !== null ? 'published' : 'draft'}
            version={row.publishedVersion ?? b.version}
          />
          {row.publishedVersion !== null && b.status === 'draft' && (
            <MetaChip tone="warning">{t('agentFlows.list.draftVersion', { version: b.version })}</MetaChip>
          )}
          {/* The table is the view that loads first, so the type has to be here
              and not only on the cards. */}
          <MetaChip muted>
            {t('agentFlows.list.create.type.' + (b.flow_type ?? 'bot') + '.name')}
          </MetaChip>
        </div>
      </td>
      <td className="app-list-cell text-caption tabular-nums text-text-secondary">{b.node_count ?? 0}</td>
      <td className="app-list-cell">
        {/* "—" would read as "not used yet". A chat flow is not waiting for a link;
            it cannot have one. */}
        {(b.flow_type ?? 'bot') === 'chat' ? (
          <span className="inline-flex items-center gap-1 text-caption text-text-tertiary">
            <MessagesSquare className="h-3.5 w-3.5" />
            {t('agentFlows.list.usedInChat')}
          </span>
        ) : links > 0 ? (
          <span className="inline-flex items-center gap-1 text-caption font-emphasis tabular-nums text-brand">
            <Link2 className="h-3.5 w-3.5" />
            {links}
          </span>
        ) : (
          <span className="text-caption text-text-quaternary">{t('agentFlows.common.none')}</span>
        )}
      </td>
      <td className="app-list-cell"><OwnerBadge email={b.owner_email} /></td>
      <td className="app-list-cell text-tiny text-text-tertiary">
        {formatWhen(b.published_at || b.created_at, locale)}
      </td>
      <td className="app-list-cell text-right">
        <div className="inline-flex items-center gap-0.5">
          <IconButton
            aria-label={t('agentFlows.list.shareAria')} variant="ghost" size="sm"
            title={t('agentFlows.list.shareTitle')} disabled={busy} onClick={onShare}
          >
            <Share2 className="h-3.5 w-3.5" />
          </IconButton>
          {canEdit && (
            <IconButton
              aria-label={t('agentFlows.list.duplicateAria')} variant="ghost" size="sm" title={t('agentFlows.list.duplicateTitle')}
              disabled={busy} onClick={onDuplicate}
            >
              <Copy className="h-3.5 w-3.5" />
            </IconButton>
          )}
          {canEdit && isDeletableDraft(row) && (
            <IconButton
              aria-label={t('agentFlows.list.deleteDraftAria')} variant="ghost" size="sm" title={t('agentFlows.list.deleteConfirm')}
              className="hover:text-danger" disabled={busy} onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </div>
      </td>
    </tr>
  );
}

/* ── create ───────────────────────────────────────────────────────────────── */

/**
 * Naming happens BEFORE the brain exists.
 *
 * The previous build POSTed a brain called "Bộ não mới" with a random key the
 * instant the button was pressed. Every mis-click left a permanent row, the key was
 * unreadable forever after, and there was no delete on the list to clean it up.
 */
function CreateBrainModal({
  onClose, onCreate, onCreateFromDraft,
}: {
  onClose: () => void;
  onCreate: (
    name: string, description: string, flowType: FlowType, preset: CreatePreset,
  ) => Promise<void>;
  onCreateFromDraft: (d: ImportedDraft) => Promise<void>;
}) {
  const { t } = useI18n();
  // STARTER FIRST, AND SELECTED. An author who has never built a flow was
  // previously handed a blank canvas or told to go and prompt a third-party model.
  // The default is now the one route that ends in a working assistant.
  const [mode, setMode] = React.useState<'starter' | 'blank' | 'ai'>('starter');
  const [flowType, setFlowType] = React.useState<FlowType>('bot');
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // ── the "have an assistant draft it" path ────────────────────────────────
  const [brief, setBrief] = React.useState<AuthoringPrompt | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [pasted, setPasted] = React.useState('');
  const [draft, setDraft] = React.useState<ImportedDraft | null>(null);
  const [checking, setChecking] = React.useState(false);

  React.useEffect(() => {
    // Fetched only when the author opens that tab — it is a 11KB string and most
    // flows are still made blank.
    if (mode !== 'ai' || brief) return;
    getAuthoringPrompt().then(setBrief).catch(() => setBrief(null));
  }, [mode, brief]);

  const submit = async () => {
    if (!name.trim()) { setError(t('agentFlows.list.create.nameRequired')); return; }
    setBusy(true);
    setError(null);
    try {
      await onCreate(
        name, description,
        // A report assistant IS a bot flow — there is no second answer, so the
        // starter does not ask a question it already knows.
        mode === 'starter' ? 'bot' : flowType,
        mode === 'starter' ? 'bi_report' : 'blank',
      );
    } catch (e) {
      setError(detailMsg(e) || t('agentFlows.list.create.failed'));
      setBusy(false);
    }
  };

  const checkDraft = async () => {
    setChecking(true);
    setError(null);
    setDraft(null);
    try {
      setDraft(await importDraft(pasted, name.trim() || undefined));
    } catch (e) {
      setError(detailMsg(e) || t('agentFlows.list.create.ai.unreadable'));
    } finally { setChecking(false); }
  };

  const createFromDraft = async () => {
    if (!draft?.ok) return;
    setBusy(true);
    setError(null);
    try {
      await onCreateFromDraft(draft);
    } catch (e) {
      setError(detailMsg(e) || t('agentFlows.list.create.failed'));
      setBusy(false);
    }
  };

  const copyBrief = async () => {
    if (!brief) return;
    try {
      await navigator.clipboard.writeText(brief.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError(t('agentFlows.list.create.ai.copyBlocked'));
    }
  };

  return (
    <AppModalShell
      onClose={onClose}
      title={t('agentFlows.list.create.title')}
      description={t('agentFlows.list.create.description')}
      icon={<Brain className="h-4 w-4" />}
      maxWidthClass={mode === 'ai' ? 'max-w-2xl' : 'max-w-lg'}
      closeDisabled={busy}
      footer={(
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>
            {t('agentFlows.list.create.cancel')}
          </Button>
          {mode !== 'ai' ? (
            <Button data-testid="create-submit" size="sm" loading={busy} onClick={() => void submit()}>
              {t('agentFlows.list.create.submit')}
            </Button>
          ) : (
            <Button size="sm" loading={busy} disabled={!draft?.ok}
                    onClick={() => void createFromDraft()}>
              {t('agentFlows.list.create.fromDraft')}
            </Button>
          )}
        </div>
      )}
    >
      <div className="space-y-3.5">
        {/* Three ways in, and they are not peers. The starter is the route a
            pilot author is expected to take; the other two are for somebody who
            already knows what they want to build. Neither of them is removed —
            the hierarchy is the whole change. */}
        <div className="flex gap-1 rounded-lg bg-surface-2 p-1">
          {([
            ['starter', t('agentFlows.list.create.mode.starter')],
            ['blank', t('agentFlows.list.create.mode.blank')],
            ['ai', t('agentFlows.list.create.mode.ai')],
          ] as const).map(([m, label]) => (
            <button
              key={m}
              type="button"
              data-testid={`create-mode-${m}`}
              aria-pressed={mode === m}
              onClick={() => { setMode(m); setError(null); }}
              className={cn(
                'flex-1 rounded-md px-2 py-1.5 text-caption transition',
                mode === m ? 'bg-surface-1 font-medium shadow-sm' : 'text-text-tertiary',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* WHAT WILL EXIST IN A MOMENT, in the product's words.
            Three steps are named because the author is about to see three cards
            on a canvas, and a starter whose result cannot be predicted from the
            dialog is just a differently-shaped blank page. */}
        {mode === 'starter' && (
          <div
            data-testid="starter-summary"
            className="rounded-lg border border-brand/25 bg-brand/5 p-3"
          >
            <p className="text-caption font-strong text-text-primary">
              {t('agentFlows.list.starter.cardTitle')}
            </p>
            <p className="mt-1 text-tiny leading-snug text-text-secondary">
              {t('agentFlows.list.starter.cardWhat')}
            </p>
            <ol className="mt-2 space-y-1">
              {(['readName', 'gatherName', 'answerName'] as const).map((k, i) => (
                <li key={k} className="flex gap-2 text-tiny leading-snug text-text-secondary">
                  <span className="text-text-quaternary">{i + 1}.</span>
                  <span>{t(`agentFlows.list.starter.${k}`)}</span>
                </li>
              ))}
            </ol>
            <p className="mt-2 text-tiny leading-snug text-text-tertiary">
              {t('agentFlows.list.starter.cardNext')}
            </p>
          </div>
        )}

        <FieldGroup label={t('agentFlows.list.create.name')} required={mode !== 'ai'}>
          <Input
            autoFocus
            data-testid="create-name"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && mode !== 'ai') void submit(); }}
            placeholder={t('agentFlows.list.create.namePlaceholder')}
            invalid={Boolean(error) && mode !== 'ai' && !name.trim()}
          />
        </FieldGroup>

        {/* WHICH SURFACE, ASKED BEFORE ANYTHING ELSE IS TYPED.
            It decides the seed, both pickers, and what the flow may assume it is
            handed — so it is a choice, not a setting found later. Every flow used
            to be seeded for a report regardless, which meant every flow was born
            unable to run in Chat with nothing on screen saying so. */}
        {mode === 'blank' && (
          <FieldGroup
            label={t('agentFlows.list.create.typeLabel')}
            description={t('agentFlows.list.create.typeHint')}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {(['bot', 'chat'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setFlowType(kind)}
                  aria-pressed={flowType === kind}
                  className={cn(
                    'rounded-lg border p-3 text-left transition',
                    flowType === kind
                      ? 'border-brand bg-brand/5'
                      : 'border-[rgb(var(--border-line))] hover:bg-surface-2',
                  )}
                >
                  <span className="block text-caption font-strong">
                    {t(`agentFlows.list.create.type.${kind}.name`)}
                  </span>
                  <span className="mt-0.5 block text-tiny leading-snug text-text-tertiary">
                    {t(`agentFlows.list.create.type.${kind}.what`)}
                  </span>
                  <span className="mt-1.5 block text-tiny leading-snug text-text-quaternary">
                    {t(`agentFlows.list.create.type.${kind}.gets`)}
                  </span>
                </button>
              ))}
            </div>
          </FieldGroup>
        )}

        {mode !== 'ai' && (
          <FieldGroup
            label={t('agentFlows.list.create.descriptionLabel')}
            description={t('agentFlows.list.create.descriptionHint')}
          >
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('agentFlows.list.create.descriptionPlaceholder')}
            />
          </FieldGroup>
        )}

        {mode === 'ai' && (
          <div className="space-y-3">
            <ol className="space-y-3">
              <li>
                <div className="mb-1.5 flex items-center gap-2">
                  <StepDot n={1} />
                  <b className="text-caption font-strong">{t('agentFlows.list.create.ai.step1')}</b>
                  {brief && (
                    <span className="text-tiny text-text-tertiary">
                      {t('agentFlows.list.create.ai.stats', {
                        types: brief.stats.node_types, tools: brief.stats.tools,
                      })}
                    </span>
                  )}
                </div>
                <p className="mb-1.5 text-tiny leading-5 text-text-tertiary">
                  {t('agentFlows.list.create.ai.step1Hint')}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" disabled={!brief}
                          onClick={() => void copyBrief()}>
                    {copied ? t('agentFlows.list.create.ai.copied') : t('agentFlows.list.create.ai.copy')}
                  </Button>
                  {!brief && <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />}
                </div>
              </li>

              <li>
                <div className="mb-1.5 flex items-center gap-2">
                  <StepDot n={2} />
                  <b className="text-caption font-strong">{t('agentFlows.list.create.ai.step2')}</b>
                </div>
                <Textarea
                  rows={5}
                  value={pasted}
                  onChange={(e) => { setPasted(e.target.value); setDraft(null); }}
                  placeholder={t('agentFlows.list.create.ai.pastePlaceholder')}
                />
                <Button size="sm" variant="secondary" className="mt-1.5"
                        loading={checking} disabled={!pasted.trim()}
                        onClick={() => void checkDraft()}>
                  {t('agentFlows.list.create.ai.check')}
                </Button>
              </li>
            </ol>

            {draft && !draft.ok && (
              <div className="rounded-lg border border-danger/25 bg-danger/5 p-2.5">
                <p className="mb-1 flex items-center gap-1.5 text-tiny font-medium text-danger">
                  <AlertTriangle className="h-3.5 w-3.5" /> {t('agentFlows.list.create.ai.draftBad')}
                </p>
                {draft.errors.map((e, i) => (
                  <p key={i} className="text-tiny leading-5 text-danger">{e}</p>
                ))}
                <p className="mt-1.5 text-tiny text-text-tertiary">
                  {t('agentFlows.list.create.ai.draftBadHint')}
                </p>
              </div>
            )}

            {draft?.ok && (
              <div className="rounded-lg border border-success/30 bg-success/5 p-2.5">
                <p className="mb-1.5 flex items-center gap-1.5 text-tiny font-medium text-success">
                  <Check className="h-3.5 w-3.5" />
                  {t('agentFlows.list.create.ai.draftOk', {
                    count: draft.node_count ?? 0, answer: draft.answer_node ?? '',
                  })}
                </p>
                {/* WHAT IS STILL EMPTY, before creating rather than after.
                    The brief tells the assistant to leave every id blank, so a
                    good draft arrives incomplete BY DESIGN — saying which steps
                    wait on an attachment is the difference between "here is a
                    flow" and "here is a flow that reads nothing yet". */}
                {(draft.needs_attachment?.length || draft.todo?.length) ? (
                  <div className="mt-1.5 border-t border-success/20 pt-1.5">
                    <p className="mb-1 text-tiny font-medium text-text-secondary">
                      {t('agentFlows.list.create.ai.stillNeeded')}
                    </p>
                    {draft.needs_attachment?.map((n) => (
                      <p key={n.key} className="text-tiny leading-5 text-text-secondary">
                        · <b>{n.name || n.key}</b> — {n.why}
                      </p>
                    ))}
                    {draft.todo?.map((x, i) => (
                      <p key={i} className="text-tiny leading-5 text-text-tertiary">· {x}</p>
                    ))}
                  </div>
                ) : null}
                {draft.warnings.map((w, i) => (
                  <p key={i} className="mt-1.5 rounded border border-warning/25 bg-warning/5 p-1.5 text-tiny leading-5 text-warning">
                    {w}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="flex gap-1.5 rounded-md border border-danger/25 bg-danger/10 px-2.5 py-2 text-tiny leading-snug text-danger">
            <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
            <span>{error}</span>
          </p>
        )}
      </div>
    </AppModalShell>
  );
}

function StepDot({ n }: { n: number }) {
  return (
    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-brand/10 text-tiny font-strong text-brand">
      {n}
    </span>
  );
}
