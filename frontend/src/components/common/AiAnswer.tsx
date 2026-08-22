'use client';

/**
 * How an agent's answer becomes a screen. ONE implementation, two surfaces.
 *
 * The model does not write plain prose. It writes prose plus markers — `[chart:N]`
 * for a citation, `[HIGH]`/`[MED]`/`[LOW]` for confidence, `[DESC]`/`[DIAG]`/
 * `[PRED]`/`[PRESC]` for the kind of insight, and `[FOLLOWUP]` lines for questions
 * to offer next. Rendering that text means parsing those out and drawing them, and
 * printing it raw is not a lesser version of the same thing: it shows the reader
 * the machinery instead of the answer.
 *
 * WHY IT MOVED HERE.
 * All of this lived inside `DashboardAiBot`, unexported, so the Agent Flow test
 * panel printed the raw string — an author testing their flow read
 * `[FOLLOWUP] ...` and `[chart:686][HIGH][DESC]` as literal text while the viewer
 * on the same flow saw chips and badges. Testing a flow against a different
 * renderer than the one that serves it is not testing the flow. Copying the parser
 * into the panel would have made the two drift instead of differ, so there is one
 * copy, here, and both import it.
 *
 * `ChartNamesContext` carries `id → chart title` so a citation can name the tile it
 * came from. It defaults to an empty Map, so a surface that has no chart list still
 * renders a valid, if less helpful, chip.
 */
import { BarChart3 } from 'lucide-react';
import React, { useMemo } from 'react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';

// The model writes `[chart:N]` in its answers. The UI renders these as
// chips, but users don't read chart_id — they read chart NAMES. This
// context lets every nested chip resolve `N → "Chart Name"` without
// threading a prop through 4 components.
export const ChartNamesContext = React.createContext<Map<number, string>>(new Map());


// Extract `[FOLLOWUP] ...?` lines from assistant content. Returns the
// remaining body (with the markers removed) plus the list of suggestion
// questions in original order.
export function extractFollowups(text: string): { body: string; suggestions: string[] } {
  if (!text) return { body: '', suggestions: [] };
  const suggestions: string[] = [];
  const bodyLines: string[] = [];
  for (const line of text.split('\n')) {
    // Tolerate leading markdown list markers ("- ", "* ", "1. ", "•") the
    // model sometimes prepends to [FOLLOWUP] lines — else the chips leak as
    // raw text instead of rendering as clickable suggestions.
    const m = /^[\s>*•.)\-\d]*\[FOLLOWUP\]\s*(.+?)\s*$/i.exec(line);
    if (m && m[1]) {
      const q = m[1].trim();
      if (q && suggestions.length < 5) suggestions.push(q);
      continue;
    }
    bodyLines.push(line);
  }

  // Fallback: model forgot the marker. Pull trailing standalone question
  // lines (max 5) — only if explicit markers gave us nothing.
  if (suggestions.length === 0) {
    while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') {
      bodyLines.pop();
    }
    const tail: string[] = [];
    while (bodyLines.length && tail.length < 5) {
      const candidate = bodyLines[bodyLines.length - 1].trim();
      // Strip leading bullet / number markers the model may have prepended.
      const cleaned = candidate.replace(/^[-*\u2022\d.\)\s]+/, '').trim();
      const isQuestion = cleaned.length > 0
        && cleaned.length <= 160
        && cleaned.endsWith('?')
        // Reject lines that look like a real bullet of the analysis (have a
        // leading "-" before stripping → that was a body bullet, not a
        // standalone follow-up).
        && !/^[-*\u2022]/.test(candidate);
      if (!isQuestion) break;
      tail.unshift(cleaned);
      bodyLines.pop();
      // Eat blank separator lines too
      while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') {
        bodyLines.pop();
      }
    }
    // Need at least 2 trailing questions to be confident this is a follow-up
    // block and not a single rhetorical question in the body.
    if (tail.length >= 2) suggestions.push(...tail);
    else if (tail.length === 1) {
      // Put it back — single rhetorical question stays in body.
      bodyLines.push('', tail[0]);
    }
  }

  // Trim trailing blank lines left behind after stripping markers
  while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') {
    bodyLines.pop();
  }
  return { body: bodyLines.join('\n'), suggestions };
}

// Hand-rolled (no dependency). Supports:
//   - paragraphs separated by blank lines
//   - headings: # h1, ## h2, ### h3
//   - unordered list: lines starting with `- ` or `* `
//   - inline: **bold**, *italic*, `code`
//   - citation: [chart:N] → small chip
//   - confidence: [HIGH] [MED] [LOW] → coloured badge

interface RichMarkdownProps { text: string }

export function RichMarkdown({ text }: RichMarkdownProps) {
  const blocks = useMemo(() => parseBlocks(normalizeAgentText(text)), [text]);
  return <div className="flex flex-col gap-2">{blocks.map((b, i) => renderBlock(b, i))}</div>;
}

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: 1 | 2 | 3; text: string }
  | { kind: 'ul'; items: string[] };

function parseBlocks(text: string): Block[] {
  if (!text) return [];
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') { i++; continue; }

    // Heading
    const h = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (h) {
      blocks.push({ kind: 'h', level: h[1].length as 1 | 2 | 3, text: h[2] });
      i++;
      continue;
    }

    // List
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    // Paragraph: collect until blank line
    const paraLines = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,3})\s+/.test(lines[i].trim()) && !/^[-*]\s+/.test(lines[i].trim())) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ kind: 'p', text: paraLines.join('\n') });
  }
  return blocks;
}

function renderBlock(block: Block, key: number): React.ReactNode {
  if (block.kind === 'h') {
    const cls =
      block.level === 1 ? 'text-base font-strong'
      : block.level === 2 ? 'text-sm font-strong'
      : 'text-caption font-strong';
    return <div key={key} className={cls}>{renderInline(block.text)}</div>;
  }
  if (block.kind === 'ul') {
    return (
      <ul key={key} className="list-disc space-y-1 pl-4">
        {block.items.map((it, i) => (
          <li key={i}>{renderInline(it)}</li>
        ))}
      </ul>
    );
  }
  return <div key={key}>{renderInline(block.text)}</div>;
}

// Some models forget the brackets and emit `chart:10HIGH` instead of
// `[chart:10] [HIGH]`. Pre-normalize so the inline tokenizer can render
// proper chips.
function normalizeAgentText(text: string): string {
  if (!text) return text;
  let out = text;
  // 1. Bracket-less citations: `chart:10` → `[chart:10]`. Skip ones already
  //    bracketed by negative look-behind (regex literal won't allow lookbehind
  //    in older targets, so do it via a guard prefix capture).
  out = out.replace(/(^|[^\[\w])(chart:\d+)/gi, (_m, pre, body) => `${pre}[${body.toLowerCase()}]`);
  // 2. Bracket-less confidence tags glued onto a citation: `]HIGH` / `]MED` /
  //    `]LOW` → `] [HIGH]`. Also matches a number stuck right after `chart:N`.
  out = out.replace(/(\[chart:\d+\])\s*(HIGH|MED|LOW)\b/g, (_m, c, lvl) => `${c} [${lvl}]`);
  // 3. Bare confidence tag right after a closing bracket of a chart chip with
  //    a space already there (idempotent for already-bracketed forms).
  out = out.replace(/(\[chart:\d+\])\s+\[?(HIGH|MED|LOW)\]?(?!\w)/g, (_m, c, lvl) => `${c} [${lvl}]`);
  // 4. Insight-ladder tokens — models (esp. gpt-4o) improvise the tag:
  //    `[DIG]`, `[DIST]`, `[descriptive]`, `[Diagnostic]`… Map ANY short
  //    all-letter bracket token that isn't a known chip to the nearest rung
  //    by prefix, so it renders as a chip instead of leaking as raw text.
  //    Chart/confidence chips are already-normalized above and skipped here.
  // Map the intended rung. gpt-4o also emits Vietnamese/garbled attempts
  // (`[DỊA]`, `[Dự kiến]`, `[DONE]`) — fold accents first so prefix-matching
  // catches them, then any STILL-unknown letter-only bracket token is dropped
  // entirely (never leak a raw `[XXX]` into the answer). Chart/confidence/WEB
  // chips and anything with digits or `:` are preserved.
  // KB marks a definition taken from AppBI's own governed knowledge. It has to
  // survive here, or the drop-unknown-tokens rule below erases the very tag that
  // keeps the model from reaching for [WEB] on a link with web research off.
  const KNOWN = new Set(['HIGH', 'MED', 'LOW', 'WEB', 'KB']);
  out = out.replace(/\[([^\]\d:]{2,20})\]/gu, (m, word) => {
    const w = String(word)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip diacritics
      .replace(/đ/gi, 'd')
      .trim().toUpperCase();
    if (KNOWN.has(w)) return m;
    if (w.startsWith('DES') || w.startsWith('MO TA') || w.startsWith('MOTA')) return '[DESC]';
    if (w.startsWith('DIA') || w.startsWith('DIG') || w.startsWith('DIST') || w.startsWith('CHAN')) return '[DIAG]';
    if (w.startsWith('PRED') || w.startsWith('FORE') || w.startsWith('DU BAO') || w.startsWith('DU KIEN')) return '[PRED]';
    if (w.startsWith('PRES') || w.startsWith('REC') || w.startsWith('ACT') || w.startsWith('DE XUAT') || w.startsWith('HANH DONG')) return '[PRESC]';
    // Unknown short letter-only token at a bullet edge = a botched tag → drop.
    return '';
  });
  return out;
}

const INLINE_PATTERN = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[chart:\d+(?:\s*[—–-]\s*"[^"\]]+")?\]|\[HIGH\]|\[MED\]|\[LOW\]|\[DESC\]|\[DIAG\]|\[PRED\]|\[PRESC\])/g;

export function renderInline(text: string): React.ReactNode[] {
  if (!text) return [];
  const parts = text.split(INLINE_PATTERN);
  const out: React.ReactNode[] = [];
  parts.forEach((part, idx) => {
    if (!part) return;
    if (part.startsWith('**') && part.endsWith('**')) {
      // Recurse so [chart:N] / [HIGH] tags inside bold text still render as chips
      out.push(<strong key={idx}>{renderInline(part.slice(2, -2))}</strong>);
      return;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      // Recurse so tags inside italic text still render as chips
      out.push(<em key={idx}>{renderInline(part.slice(1, -1))}</em>);
      return;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      out.push(
        <code key={idx} className="rounded bg-black/10 px-1 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>,
      );
      return;
    }
    // Match either short `[chart:N]` or long `[chart:N — "Title"]`
    const cm = /^\[chart:(\d+)(?:\s*[—–-]\s*"([^"]+)")?\]$/.exec(part);
    if (cm) {
      out.push(<ChartChip key={idx} chartId={Number(cm[1])} chartName={cm[2] || undefined} />);
      return;
    }
    if (part === '[HIGH]' || part === '[MED]' || part === '[LOW]') {
      out.push(<ConfidenceBadge key={idx} level={part.slice(1, -1) as 'HIGH' | 'MED' | 'LOW'} />);
      return;
    }
    if (part === '[DESC]' || part === '[DIAG]' || part === '[PRED]' || part === '[PRESC]') {
      out.push(
        <InsightTypeChip
          key={idx}
          type={part.slice(1, -1).toLowerCase() as 'desc' | 'diag' | 'pred' | 'presc'}
        />,
      );
      return;
    }
    // Plain text — preserve newlines as <br/>
    const lines = part.split('\n');
    lines.forEach((line, j) => {
      out.push(<span key={`${idx}-${j}`}>{line}</span>);
      if (j < lines.length - 1) out.push(<br key={`${idx}-${j}-br`} />);
    });
  });
  return out;
}

export function ChartChip({ chartId, chartName }: { chartId: number; chartName?: string }) {
  const { t } = useI18n();
  // If the model only emitted `[chart:N]`, look up the name from the
  // dashboard manifest so the user sees the chart TITLE, not a raw id.
  const namesMap = React.useContext(ChartNamesContext);
  const resolvedName = chartName || namesMap.get(chartId);

  const handleClick = () => {
    const target = document.querySelector(`[data-chart-id="${chartId}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('ring-2', 'ring-brand', 'ring-offset-2');
      setTimeout(() => target.classList.remove('ring-2', 'ring-brand', 'ring-offset-2'), 1800);
    }
  };
  // Prefer the chart name as the visible label. Fall back to `chart:N` only
  // when we have no name (e.g. before recon has loaded). The id is shown as
  // a small monospace suffix only on hover via tooltip, never in-line.
  const label = resolvedName || `chart:${chartId}`;
  const tooltip = resolvedName
    ? t('dashboards.aiBot.chartChipTooltipNamed', { name: resolvedName, id: chartId })
    : t('dashboards.aiBot.chartChipTooltip', { id: chartId });
  return (
    <button
      onClick={handleClick}
      className="mx-0.5 inline-flex max-w-[260px] items-center gap-1 truncate rounded bg-brand/10 px-1.5 py-0 align-baseline text-[0.78em] font-strong text-brand transition-colors hover:bg-brand/20"
      title={tooltip}
    >
      <BarChart3 className="h-2.5 w-2.5 flex-shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

const _CONFIDENCE_TOOLTIPS: Record<'HIGH' | 'MED' | 'LOW', string> = {
  HIGH: 'Đọc trực tiếp từ dữ liệu biểu đồ',
  MED: 'Tính từ phép tính trên dữ liệu biểu đồ',
  LOW: 'Quan sát định tính, không khẳng định chắc chắn',
};


export function ConfidenceBadge({ level }: { level: 'HIGH' | 'MED' | 'LOW' }) {
  const cls =
    level === 'HIGH' ? 'bg-success/15 text-success'
    : level === 'MED' ? 'bg-warning/15 text-warning'
    : 'bg-text-tertiary/15 text-text-tertiary';
  return (
    <span
      className={`mx-0.5 inline-flex cursor-help items-center rounded px-1 py-0 text-[0.65em] font-strong ${cls}`}
      title={_CONFIDENCE_TOOLTIPS[level]}
    >
      {level}
    </span>
  );
}

// ── Insight ladder (Phase 16 — InsightBench rework) ──────────────────────────
// Descriptive → Diagnostic → Predictive → Prescriptive. Same taxonomy as the
// backend prompt contract ([DESC]/[DIAG]/[PRED]/[PRESC] tokens).

const _INSIGHT_TYPE_META: Record<'desc' | 'diag' | 'pred' | 'presc', { label: string; tooltip: string; cls: string }> = {
  desc: {
    label: 'Mô tả',
    tooltip: 'Descriptive — chuyện gì đã xảy ra (đọc trực tiếp từ dữ liệu)',
    cls: 'bg-info/15 text-info',
  },
  diag: {
    label: 'Chẩn đoán',
    tooltip: 'Diagnostic — vì sao xảy ra (bóc tách phân khúc / so sánh kỳ / tương quan)',
    cls: 'bg-warning/15 text-warning',
  },
  pred: {
    label: 'Dự báo',
    tooltip: 'Predictive — điều gì sắp xảy ra (chiếu xu hướng từ dữ liệu)',
    cls: 'bg-brand/15 text-brand',
  },
  presc: {
    label: 'Đề xuất',
    tooltip: 'Prescriptive — nên làm gì (hành động cụ thể bám theo phát hiện)',
    cls: 'bg-success/15 text-success',
  },
};

export function InsightTypeChip({ type }: { type: 'desc' | 'diag' | 'pred' | 'presc' }) {
  const meta = _INSIGHT_TYPE_META[type];
  return (
    <span
      className={`mx-0.5 inline-flex cursor-help items-center rounded px-1 py-0 text-[0.65em] font-strong ${meta.cls}`}
      title={meta.tooltip}
    >
      {meta.label}
    </span>
  );
}

