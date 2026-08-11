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
  AlertTriangle, Brain, Calendar, ChevronRight, Copy, Layers, Link2, Plus, Trash2,
} from 'lucide-react';
import React from 'react';

import { AppModalShell } from '@/components/common/AppModalShell';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { PageListLayout } from '@/components/common/PageListLayout';
import { PaginatedCollection } from '@/components/common/PaginatedCollection';
import { Button, IconButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterTag } from '@/components/ui/FilterTag';
import { FieldGroup, Input, Textarea } from '@/components/ui/Input';
import { toast } from '@/lib/toast';
import {
  blankNode, deleteBrainVersion, getBrain, listBrains, saveBrain, slugifyBrainKey,
  type BrainSummary,
  type FlowNode,
} from '@/lib/agentFlows';

import { MetaChip, StatusBadge, formatWhen } from './shared';

type StatusFilter = 'all' | 'published' | 'draft';

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'Tất cả' },
  { key: 'published', label: 'Đang chạy' },
  { key: 'draft', label: 'Chỉ có nháp' },
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

export function BrainList({
  onOpen, canEdit,
}: {
  onOpen: (key: string) => void;
  canEdit: boolean;
}) {
  const [rows, setRows] = React.useState<BrainSummary[] | null>(null);
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState<StatusFilter>('all');
  const [creating, setCreating] = React.useState(false);
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<BrainRowModel | null>(null);

  const reload = React.useCallback(async () => {
    try {
      setRows(await listBrains());
    } catch {
      setRows([]);
      toast.error('Không tải được danh sách bộ não.');
    }
  }, []);
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

  const create = async (name: string, description: string) => {
    const key = slugifyBrainKey(name);
    // Seeded with a flow that already runs: read the report, then answer. Two
    // nodes rather than one, because "read the open report" is now a node of its
    // own and costs nothing — a new flow should demonstrate that, not start with
    // an agent doing everything.
    const reader = blankNode('report_read', []);
    const writer = blankNode('agent', [reader]);
    await saveBrain({
      brain_key: key,
      name: name.trim(),
      description: description.trim(),
      body: {
        nodes: [
          { ...reader, name: 'Đọc báo cáo' } as FlowNode,
          {
            ...writer,
            name: 'Trả lời người xem',
            prompt: 'Dùng dữ liệu vừa đọc để trả lời câu hỏi của người xem. '
              + 'Không tự tạo thêm số ngoài những gì đã đọc được.',
          } as FlowNode,
        ],
        answer_node: writer.key,
      },
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
      const name = `${source.name} (bản sao)`;
      await saveBrain({
        brain_key: slugifyBrainKey(name),
        name,
        description: source.description,
        body: source.body,
      });
      toast.success('Đã nhân bản thành một bộ não mới (bản nháp).');
      await reload();
    } catch (e) {
      toast.error(detailMsg(e) || 'Không nhân bản được.');
    } finally {
      setBusyKey(null);
    }
  };

  const removeDraft = async (row: BrainRowModel) => {
    setBusyKey(row.latest.brain_key);
    try {
      await deleteBrainVersion(row.latest.brain_key, row.latest.version);
      toast.success(`Đã xoá bản nháp v${row.latest.version}.`);
      await reload();
    } catch (e) {
      toast.error(detailMsg(e) || 'Không xoá được bản nháp.');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <>
      <PageListLayout
        title="Agent Flows"
        description="Mỗi link công khai có ChatBot sẽ chọn một bộ não. Câu hỏi của người xem đi vào đó và được xử lý theo các bước bạn đặt sẵn."
        overview={(
          <ModuleOverview
            icon={Brain}
            title="Agent Flows"
            stats={[
              { label: 'Bộ não', value: brains.length },
              { label: 'Đang chạy', value: liveCount, helper: 'có một phiên bản đã phát hành' },
              { label: 'Chỉ có nháp', value: brains.length - liveCount, helper: 'chưa phục vụ người xem nào' },
              { label: 'Link đang dùng', value: servingCount, helper: 'tổng số link công khai trỏ vào các bộ não này' },
            ]}
            storageKey="agent-flows-overview"
          />
        )}
        action={canEdit ? (
          <Button size="sm" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>
            Bộ não mới
          </Button>
        ) : undefined}
        isLoading={rows === null}
        loadingText="Đang tải bộ não…"
        searchPlaceholder="Tìm theo tên, mã hoặc mô tả…"
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
                {f.label}
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
                title="Chưa có bộ não nào"
                description="Một bộ não gồm các bước nối tiếp nhau. Bước đầu thường đọc báo cáo và lấy số; bước cuối viết câu trả lời cho người xem."
                action={canEdit ? (
                  <Button size="sm" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>
                    Bộ não mới
                  </Button>
                ) : undefined}
              />
            );
          }
          if (shown.length === 0) {
            return (
              <EmptyState
                icon={<Brain className="h-6 w-6" />}
                title="Không có bộ não nào khớp"
                description="Thử từ khoá khác, hoặc bỏ bộ lọc trạng thái."
                action={(
                  <Button size="sm" variant="secondary" onClick={() => { setSearch(''); setStatus('all'); }}>
                    Xoá bộ lọc
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
                        />
                      ))}
                    </div>
                  ) : (
                    <div className={`border border-[rgb(var(--border-line))] bg-surface-1 ${hasFooter ? 'rounded-t-xl border-b-0' : 'rounded-xl'}`}>
                      <div className="app-list-table-wrap">
                        <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
                          <thead className="bg-surface-2">
                            <tr>
                              <th className="app-list-header w-[34%]">Bộ não</th>
                              <th className="app-list-header w-[14%]">Trạng thái</th>
                              <th className="app-list-header w-[10%]">Bước</th>
                              <th className="app-list-header w-[12%]">Link đang dùng</th>
                              <th className="app-list-header w-[14%]">Chủ sở hữu</th>
                              <th className="app-list-header w-[12%]">Cập nhật</th>
                              {/* Wide enough for the uppercase tracked label on one
                                  line; at 92px "HÀNH ĐỘNG" wrapped and pushed the
                                  header row to two lines. */}
                              <th className="app-list-header w-[116px] text-right">Hành động</th>
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

      {creating && <CreateBrainModal onClose={() => setCreating(false)} onCreate={create} />}

      <ConfirmDialog
        isOpen={confirmDelete !== null}
        title={`Xoá bản nháp v${confirmDelete?.latest.version ?? ''}?`}
        description={
          confirmDelete?.publishedVersion !== null && confirmDelete
            ? `“${confirmDelete.latest.name}” vẫn còn phiên bản v${confirmDelete.publishedVersion} đang phục vụ người xem — bản đó không bị ảnh hưởng.`
            : `“${confirmDelete?.latest.name}” sẽ bị xoá. Không có phiên bản nào khác của bộ não này đang chạy.`
        }
        confirmLabel="Xoá bản nháp"
        variant="danger"
        onConfirm={() => { if (confirmDelete) void removeDraft(confirmDelete); }}
        onClose={() => setConfirmDelete(null)}
      />
    </>
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
  row, canEdit, busy, onOpen, onDuplicate, onDelete,
}: {
  row: BrainRowModel;
  canEdit: boolean;
  busy: boolean;
  onOpen: (key: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const b = row.latest;
  const links = b.link_count || 0;
  return (
    <div className="group rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 transition-[box-shadow,border-color] hover:border-[rgb(var(--border-strong))] hover:shadow-linear">
      <button type="button" onClick={() => onOpen(b.brain_key)} className="w-full p-4 text-left">
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
                  <MetaChip tone="warning">nháp v{b.version} chưa phát hành</MetaChip>
                )}
              </span>
            </span>
          </div>
          <ChevronRight className="h-4 w-4 flex-shrink-0 text-text-quaternary transition-colors group-hover:text-brand" />
        </div>

        <p className="mb-3 line-clamp-2 min-h-[2.25rem] text-caption leading-relaxed text-text-secondary">
          {b.description || <span className="text-text-quaternary">Chưa có mô tả — mở bộ não và viết một dòng ở tab Tổng quan.</span>}
        </p>

        <div className="flex flex-wrap items-center gap-3 text-tiny text-text-quaternary">
          <span className="inline-flex items-center gap-1">
            <Layers className="h-3 w-3" />
            {b.node_count ?? 0} bước
          </span>
          <span className={`inline-flex items-center gap-1 ${links > 0 ? 'text-brand' : ''}`}>
            <Link2 className="h-3 w-3" />
            {links > 0 ? `${links} link đang dùng` : 'chưa link nào dùng'}
          </span>
          <span className="inline-flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            {formatWhen(b.published_at || b.created_at)}
          </span>
        </div>
      </button>

      <div className="flex items-center justify-between gap-1 border-t border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5">
        <OwnerBadge email={b.owner_email} />
        <div className="flex items-center gap-0.5">
          {canEdit && (
            <IconButton
              aria-label="Nhân bản bộ não" variant="ghost" size="sm" title="Nhân bản"
              disabled={busy} onClick={onDuplicate}
            >
              <Copy className="h-3.5 w-3.5" />
            </IconButton>
          )}
          {canEdit && isDeletableDraft(row) && (
            <IconButton
              aria-label="Xoá bản nháp" variant="ghost" size="sm" title="Xoá bản nháp"
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
  row, canEdit, busy, onOpen, onDuplicate, onDelete,
}: {
  row: BrainRowModel;
  canEdit: boolean;
  busy: boolean;
  onOpen: (key: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const b = row.latest;
  const links = b.link_count || 0;
  return (
    <tr className="hover:bg-surface-2">
      <td className="app-list-cell">
        <button type="button" onClick={() => onOpen(b.brain_key)} className="flex w-full items-start gap-3 text-left">
          <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
            <Brain className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="app-list-text-main block text-caption font-emphasis text-text-primary transition-colors hover:text-brand">
              {b.name}
            </span>
            <span className="app-list-text-sub mt-0.5 block text-tiny text-text-tertiary">
              {b.description || 'Chưa có mô tả'}
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
            <MetaChip tone="warning">nháp v{b.version}</MetaChip>
          )}
        </div>
      </td>
      <td className="app-list-cell text-caption tabular-nums text-text-secondary">{b.node_count ?? 0}</td>
      <td className="app-list-cell">
        {links > 0 ? (
          <span className="inline-flex items-center gap-1 text-caption font-emphasis tabular-nums text-brand">
            <Link2 className="h-3.5 w-3.5" />
            {links}
          </span>
        ) : (
          <span className="text-caption text-text-quaternary">—</span>
        )}
      </td>
      <td className="app-list-cell"><OwnerBadge email={b.owner_email} /></td>
      <td className="app-list-cell text-tiny text-text-tertiary">
        {formatWhen(b.published_at || b.created_at)}
      </td>
      <td className="app-list-cell text-right">
        <div className="inline-flex items-center gap-0.5">
          {canEdit && (
            <IconButton
              aria-label="Nhân bản bộ não" variant="ghost" size="sm" title="Nhân bản"
              disabled={busy} onClick={onDuplicate}
            >
              <Copy className="h-3.5 w-3.5" />
            </IconButton>
          )}
          {canEdit && isDeletableDraft(row) && (
            <IconButton
              aria-label="Xoá bản nháp" variant="ghost" size="sm" title="Xoá bản nháp"
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
  onClose, onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, description: string) => Promise<void>;
}) {
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) { setError('Cần một cái tên.'); return; }
    setBusy(true);
    setError(null);
    try {
      await onCreate(name, description);
    } catch (e) {
      setError(detailMsg(e) || 'Không tạo được bộ não.');
      setBusy(false);
    }
  };

  return (
    <AppModalShell
      onClose={onClose}
      title="Bộ não mới"
      description="Bộ não dùng lại được trên nhiều link, nên hãy đặt tên theo việc nó làm, đừng theo tên một báo cáo."
      icon={<Brain className="h-4 w-4" />}
      maxWidthClass="max-w-lg"
      closeDisabled={busy}
      footer={(
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>Huỷ</Button>
          <Button size="sm" loading={busy} onClick={() => void submit()}>Tạo và mở</Button>
        </div>
      )}
    >
      <div className="space-y-3.5">
        <FieldGroup label="Tên bộ não" required>
          <Input
            autoFocus
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            placeholder="ví dụ: Phân tích doanh thu và giải thích thay đổi"
            invalid={Boolean(error) && !name.trim()}
          />
        </FieldGroup>
        <FieldGroup
          label="Mô tả"
          description="Hiện trên danh sách và trong hộp chọn bộ não khi cấu hình link. Một dòng là đủ."
        >
          <Textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Dùng cho báo cáo bán hàng: đọc số trên báo cáo, đối chiếu quy ước rồi trả lời."
          />
        </FieldGroup>
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
