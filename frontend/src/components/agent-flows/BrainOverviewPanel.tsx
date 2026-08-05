'use client';

/**
 * The brain, as opposed to one of its steps.
 *
 * Everything here is a property of the whole brain, and none of it had a home
 * before. `description` could not be edited at all — the builder sent
 * `detail.description` straight back on every save, so a brain created without one
 * read "Chưa có mô tả." in the catalogue forever. `warnings` were rendered inside
 * whichever step happened to be selected, so a brain-level caution appeared to be
 * about a step and vanished when you clicked another one. `reads` was counted in a
 * stats strip and never listed. `impact` was in the API client and called by
 * nothing.
 *
 * THE ORDER IS THE READING ORDER OF A REVIEW.
 * What is this for → what is wrong with it → what it can read → who is running it.
 * That is the sequence somebody uses when deciding whether to publish, which is the
 * decision this panel exists to support.
 */
import {
  AlertTriangle, BookOpen, Bot, CheckCircle2, ExternalLink, FileText, Layers, Link2,
  Sigma, TrendingUp,
} from 'lucide-react';
import React from 'react';

import { Badge } from '@/components/ui/Badge';
import { FieldGroup, Textarea } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import type {
  AgentStep, Attachable, BrainDetail, BrainLinkUsage, KnowledgeAttachment,
} from '@/lib/agentFlows';

import { HintText, MetaChip, SectionTitle, formatWhen } from './shared';
import type { StepTab } from './StepEditor';

const SOURCE_ICON: Record<KnowledgeAttachment['source'], React.ReactNode> = {
  document: <FileText className="h-3.5 w-3.5" />,
  semantic: <Sigma className="h-3.5 w-3.5" />,
  metric: <TrendingUp className="h-3.5 w-3.5" />,
};

export function BrainOverviewPanel({
  detail, name, description, steps, sources, links, canEdit, onDescriptionChange, onGoToStep,
}: {
  detail: BrainDetail;
  name: string;
  description: string;
  steps: AgentStep[];
  sources: Attachable;
  links: BrainLinkUsage[] | null;
  canEdit: boolean;
  onDescriptionChange: (value: string) => void;
  onGoToStep: (index: number, tab: StepTab) => void;
}) {
  /** The server's `reads` carries a kind and a ref, never a name — so the panel
   *  resolves refs against the same `attachable` lists the pickers use. A disclosure
   *  that says "Tài liệu 26" discloses nothing. */
  const resolve = React.useCallback((source: KnowledgeAttachment['source'], ref: string): string => {
    const pool = source === 'semantic' ? sources.datasets
      : source === 'metric' ? sources.metrics
        : sources.documents;
    return pool.find((o) => o.ref === ref)?.name || ref;
  }, [sources]);

  /** Which steps attach a given source. The reach list is deduplicated across the
   *  chain, so without this an author cannot tell where a source came from. */
  const attachedBy = React.useCallback((source: string, ref: string): number[] => {
    const out: number[] = [];
    steps.forEach((s, i) => {
      if ((s.knowledge || []).some((k) => k.source === source && k.ref === ref)) out.push(i);
    });
    return out;
  }, [steps]);

  const toolTotal = steps.reduce((n, s) => n + (s.tools || []).length, 0);
  const knowledgeTotal = steps.reduce((n, s) => n + (s.knowledge || []).length, 0);

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4">
      {/* ── identity ── */}
      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <h2 className="text-small font-strong text-text-primary">{name || detail.brain_key}</h2>
          <span className="font-mono text-tiny text-text-quaternary">{detail.brain_key}</span>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <MetaChip><Layers className="mr-1 h-2.5 w-2.5" />{steps.length} bước</MetaChip>
          <MetaChip muted={toolTotal === 0}>{toolTotal} lượt cấp công cụ</MetaChip>
          <MetaChip muted={knowledgeTotal === 0}>{knowledgeTotal} nguồn tri thức</MetaChip>
          <MetaChip>chủ sở hữu {detail.owner_email || '—'}</MetaChip>
          {detail.published_at && <MetaChip>phát hành {formatWhen(detail.published_at)}</MetaChip>}
        </div>

        <FieldGroup
          label="Mô tả"
          description="Hiện trên danh sách bộ não và trong hộp chọn khi cấu hình ChatBot cho một link. Người chọn bộ não thường không phải người viết nó."
        >
          <Textarea
            rows={3}
            value={description}
            disabled={!canEdit}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="Dùng cho báo cáo bán hàng: đọc số trên báo cáo, đối chiếu quy ước GMV rồi trả lời kèm trích nguồn."
          />
        </FieldGroup>
      </section>

      {/* ── warnings ── */}
      <section>
        <SectionTitle count={detail.warnings.length || undefined}>Cần xem lại</SectionTitle>
        {detail.warnings.length === 0 ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-2 text-tiny text-text-tertiary">
            <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-success" />
            Không có cảnh báo nào cho bản đang mở.
          </p>
        ) : (
          <div className="space-y-1.5">
            {detail.warnings.map((w, i) => (
              <p key={i} className="flex gap-2 rounded-lg border border-warning/25 bg-warning/10 px-2.5 py-2 text-tiny leading-relaxed text-text-secondary">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning" />
                <span>{w}</span>
              </p>
            ))}
          </div>
        )}
        <p className="mt-1.5 text-tiny leading-snug text-text-quaternary">
          Đây là cảnh báo, không phải lỗi — bộ não vẫn lưu và phát hành được. Tính lại sau mỗi lần lưu.
        </p>
      </section>

      {/* ── reach ── */}
      <section>
        <SectionTitle count={detail.reads.length || undefined}>Bộ não này đọc được gì</SectionTitle>
        <HintText>
          Chia sẻ bộ não là cho người nhận đọc qua quyền của chủ sở hữu, nên đây cũng chính là
          những gì bạn cho đi khi chia sẻ. Quyền được kiểm lại mỗi lần chạy, không phải lúc phát hành.
        </HintText>
        <div className="mt-2 space-y-1.5">
          {detail.reads.length === 0 && (
            <p className="rounded-lg border border-dashed border-[rgb(var(--border-line))] px-2.5 py-3 text-tiny leading-relaxed text-text-tertiary">
              Không gắn nguồn nào — bộ não chỉ đọc báo cáo đang mở. Đúng nếu bạn muốn dùng nó cho
              mọi báo cáo.
            </p>
          )}
          {detail.reads.map((r) => {
            const kind = r.source as KnowledgeAttachment['source'];
            const usedBy = attachedBy(r.source, r.ref);
            return (
              <div
                key={`${r.source}:${r.ref}`}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-2"
              >
                <span className="flex-shrink-0 text-text-tertiary">{SOURCE_ICON[kind]}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-caption font-emphasis text-text-primary">
                    {resolve(kind, r.ref)}
                  </span>
                  <span className="text-tiny text-text-quaternary">{r.label}</span>
                </span>
                {usedBy.map((i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onGoToStep(i, 'knowledge')}
                    className="flex-shrink-0 rounded border border-[rgb(var(--border-line))] bg-surface-2 px-1.5 py-0.5 text-tiny text-text-tertiary transition-colors hover:border-brand hover:text-brand"
                  >
                    bước {i + 1}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── impact ── */}
      <section>
        <SectionTitle count={links === null ? undefined : links.length}>Đang được dùng ở đâu</SectionTitle>
        <HintText>
          Một bộ não có thể là đầu não của nhiều link. Sửa và phát hành ở đây là đổi câu trả lời của
          tất cả những link dưới đây, ngay lập tức.
        </HintText>
        <div className="mt-2 space-y-1.5">
          {links === null && (
            <p className="text-tiny text-text-tertiary">Đang kiểm…</p>
          )}
          {links !== null && links.length === 0 && (
            <p className="rounded-lg border border-dashed border-[rgb(var(--border-line))] px-2.5 py-3 text-tiny leading-relaxed text-text-tertiary">
              Chưa có link công khai nào trỏ vào bộ não này. Chọn bộ não trong phần ChatBot của một
              link công khai để dùng nó.
            </p>
          )}
          {(links || []).map((l) => (
            <div
              key={l.link_id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-2"
            >
              <Link2 className="h-3.5 w-3.5 flex-shrink-0 text-text-tertiary" />
              <span className="min-w-0 flex-1 truncate text-caption font-emphasis text-text-primary">
                {l.link_name || `Link #${l.link_id}`}
              </span>
              <Badge variant={l.bot_enabled ? 'success' : 'neutral'} size="xs">
                <Bot className="mr-0.5 h-2.5 w-2.5" />
                {l.bot_enabled ? 'ChatBot đang bật' : 'ChatBot đang tắt'}
              </Badge>
              <a
                href={`/d/${l.token}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex flex-shrink-0 items-center gap-1 text-tiny text-brand hover:underline"
              >
                Mở link
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          ))}
        </div>
      </section>

      {/* ── chain summary: the one place the whole flow reads as prose ── */}
      <section>
        <SectionTitle count={steps.length}>Chuỗi bước</SectionTitle>
        <div className="space-y-1.5">
          {steps.map((s, i) => (
            <button
              key={`${s.key}-${i}`}
              type="button"
              onClick={() => onGoToStep(i, 'basic')}
              className={cn(
                'flex w-full items-start gap-2.5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-2 text-left',
                'transition-colors hover:border-brand/60',
              )}
            >
              <span className="mt-0.5 grid h-4.5 w-4.5 flex-shrink-0 place-items-center rounded bg-surface-3 text-tiny font-strong tabular-nums text-text-secondary">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-caption font-emphasis text-text-primary">{s.name || s.key}</span>
                  {i === steps.length - 1 && <Badge variant="success" size="xs">trả lời người xem</Badge>}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-tiny leading-relaxed text-text-tertiary">
                  {s.prompt.trim() || <em className="text-warning">chưa có hướng dẫn — bước này chưa lưu được</em>}
                </span>
                <span className="mt-1 flex flex-wrap gap-1">
                  <MetaChip muted={(s.tools || []).length === 0}>
                    {(s.tools || []).length} công cụ
                  </MetaChip>
                  {(s.knowledge || []).length > 0 && (
                    <MetaChip><BookOpen className="mr-1 h-2.5 w-2.5" />{s.knowledge!.length}</MetaChip>
                  )}
                  <MetaChip muted>
                    {s.provider && s.provider !== 'inherit' ? s.model : 'model theo link'}
                  </MetaChip>
                </span>
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
