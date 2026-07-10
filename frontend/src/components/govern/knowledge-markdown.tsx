'use client';

/**
 * Shared knowledge helpers: a tiny markdown renderer (headings, bold/italic/
 * code/link, lists, blockquote, Obsidian-style callouts + [[wikilinks]]) +
 * doc-type / status metadata. Kept design-system clean (token classes only)
 * and reused by the Govern Knowledge Hub tab.
 */
import { type ReactNode } from 'react';
import { Info, AlertTriangle, Lightbulb, CheckCircle2, ShieldCheck, Sigma, HelpCircle, Quote, ArrowUpRight } from 'lucide-react';

// ── Obsidian-style callouts: > [!type] Title / > body ────────────────────────
// tone = left-border + tint; icon + default title (VI-first, custom title wins).
const CALLOUTS: Record<string, { icon: ReactNode; border: string; bg: string; text: string; title: string }> = {
  note:    { icon: <Info className="h-3.5 w-3.5" />,          border: 'border-brand',   bg: 'bg-brand/[0.06]',   text: 'text-brand',   title: 'Ghi chú' },
  info:    { icon: <Info className="h-3.5 w-3.5" />,          border: 'border-info',    bg: 'bg-info/[0.07]',    text: 'text-info',    title: 'Thông tin' },
  tip:     { icon: <Lightbulb className="h-3.5 w-3.5" />,     border: 'border-success', bg: 'bg-success/[0.07]', text: 'text-success', title: 'Mẹo' },
  success: { icon: <CheckCircle2 className="h-3.5 w-3.5" />,  border: 'border-success', bg: 'bg-success/[0.07]', text: 'text-success', title: 'Tốt' },
  warning: { icon: <AlertTriangle className="h-3.5 w-3.5" />, border: 'border-warning', bg: 'bg-warning/[0.08]', text: 'text-warning', title: 'Cảnh báo' },
  danger:  { icon: <AlertTriangle className="h-3.5 w-3.5" />, border: 'border-danger',  bg: 'bg-danger/[0.07]',  text: 'text-danger',  title: 'Nguy hiểm' },
  rule:    { icon: <ShieldCheck className="h-3.5 w-3.5" />,   border: 'border-brand',   bg: 'bg-brand/[0.06]',   text: 'text-brand',   title: 'Quy tắc nghiệp vụ' },
  formula: { icon: <Sigma className="h-3.5 w-3.5" />,         border: 'border-info',    bg: 'bg-info/[0.07]',    text: 'text-info',    title: 'Công thức' },
  question:{ icon: <HelpCircle className="h-3.5 w-3.5" />,    border: 'border-text-quaternary', bg: 'bg-surface-2', text: 'text-text-secondary', title: 'Câu hỏi' },
};
const CALLOUT_ALIAS: Record<string, string> = { error: 'danger', bug: 'danger', warn: 'warning', hint: 'tip', faq: 'question', quote: 'note', abstract: 'info', summary: 'info' };

// ── Tiny markdown renderer (headings, bold/italic/code/link, lists, quote) ──
// onDocLink handles internal wikilinks (href scheme "govern:doc:<id>").
function renderInline(text: string, key: string, onDocLink?: (id: number) => void): ReactNode {
  const parts: ReactNode[] = [];
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  const pushText = (s: string, k: string) => {
    const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g;
    let l = 0; let mm: RegExpExecArray | null; let j = 0;
    while ((mm = re.exec(s))) {
      if (mm.index > l) parts.push(s.slice(l, mm.index));
      if (mm[2] != null) parts.push(<strong key={`${k}b${j}`} className="font-strong text-text-primary">{mm[2]}</strong>);
      else if (mm[3] != null) parts.push(<em key={`${k}i${j}`}>{mm[3]}</em>);
      else if (mm[4] != null) parts.push(<code key={`${k}c${j}`} className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[0.85em] text-text-primary">{mm[4]}</code>);
      l = mm.index + mm[0].length; j++;
    }
    if (l < s.length) parts.push(s.slice(l));
  };
  while ((m = linkRe.exec(text))) {
    if (m.index > last) pushText(text.slice(last, m.index), `${key}t${i}`);
    const label = m[1]; const url = m[2];
    if (url.startsWith('govern:doc:')) {
      // Internal [[wikilink]] → clickable in-app navigation (no page reload).
      const id = parseInt(url.slice('govern:doc:'.length), 10);
      parts.push(
        <button key={`${key}w${i}`} type="button" onClick={() => onDocLink?.(id)}
          className="inline-flex items-baseline gap-0.5 rounded font-emphasis text-brand hover:underline">
          {label}<ArrowUpRight className="h-3 w-3 self-center" />
        </button>,
      );
    } else if (url === 'govern:miss') {
      // Unresolved wikilink — the target doc doesn't exist (yet).
      parts.push(<span key={`${key}w${i}`} className="text-text-quaternary underline decoration-dotted" title="Tài liệu chưa tồn tại">{label}</span>);
    } else {
      parts.push(<a key={`${key}l${i}`} href={url} target="_blank" rel="noreferrer" className="text-brand underline underline-offset-2">{label}</a>);
    }
    last = m.index + m[0].length; i++;
  }
  if (last < text.length) pushText(text.slice(last), `${key}t${i}`);
  return parts;
}

export function Markdown({ source, onDocLink }: { source: string; onDocLink?: (id: number) => void }) {
  const lines = (source || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  const ri = (text: string, k: string) => renderInline(text, k, onDocLink);
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] | null = null;  // buffered consecutive "> " lines
  const flushList = (k: string) => {
    if (!list) return;
    const L = list;
    blocks.push(
      L.ordered
        ? <ol key={k} className="my-2.5 ml-5 list-decimal space-y-1.5 text-text-secondary marker:text-text-quaternary">{L.items.map((it, i) => <li key={i} className="pl-1 leading-relaxed">{ri(it, `${k}i${i}`)}</li>)}</ol>
        : <ul key={k} className="my-2.5 ml-5 list-disc space-y-1.5 text-text-secondary marker:text-text-quaternary">{L.items.map((it, i) => <li key={i} className="pl-1 leading-relaxed">{ri(it, `${k}i${i}`)}</li>)}</ul>,
    );
    list = null;
  };
  const flushQuote = (k: string) => {
    if (!quote) return;
    const Q = quote; quote = null;
    const head = Q[0].match(/^\[!(\w+)\]\s*(.*)$/);
    if (head) {
      const type = CALLOUT_ALIAS[head[1].toLowerCase()] || head[1].toLowerCase();
      const c = CALLOUTS[type] || CALLOUTS.note;
      const title = head[2].trim() || c.title;
      const body = Q.slice(1);
      blocks.push(
        <div key={k} className={`my-3 rounded-lg border-l-[3px] ${c.border} ${c.bg} px-3 py-2`}>
          <div className={`flex items-center gap-1.5 text-caption font-strong ${c.text}`}>{c.icon}{title}</div>
          {body.filter((l) => l.trim()).map((l, i) => (
            <p key={i} className="mt-1 text-small leading-relaxed text-text-secondary">{ri(l, `${k}q${i}`)}</p>
          ))}
        </div>,
      );
    } else {
      blocks.push(
        <blockquote key={k} className="my-3 border-l-2 border-brand/50 pl-3.5 italic text-text-secondary">
          {Q.map((l, i) => <p key={i} className="my-0.5">{ri(l, `${k}q${i}`)}</p>)}
        </blockquote>,
      );
    }
  };
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const k = `md${idx}`;
    const q = line.match(/^>\s?(.*)$/);
    if (q) { flushList(k); if (quote === null) quote = []; quote.push(q[1]); return; }
    flushQuote(k);
    const ol = line.match(/^\d+\.\s+(.*)$/);
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ol) { if (!list || !list.ordered) { flushList(k); list = { ordered: true, items: [] }; } list!.items.push(ol[1]); return; }
    if (ul) { if (!list || list.ordered) { flushList(k); list = { ordered: false, items: [] }; } list!.items.push(ul[1]); return; }
    flushList(k);
    if (!line.trim()) return;
    // Reading hierarchy on the SYSTEM type scale (app density: caption 13 /
    // small 15): body = small(15), ### = small strong, ## = body(16) strong,
    // # = h3(20). Clear steps without inflating the page vs the rest of the UI.
    if (line.startsWith('### ')) blocks.push(<h3 key={k} className="mb-1 mt-5 text-small font-strong text-text-primary">{ri(line.slice(4), k)}</h3>);
    else if (line.startsWith('## ')) blocks.push(<h2 key={k} className="mb-1.5 mt-7 text-body font-strong text-text-primary">{ri(line.slice(3), k)}</h2>);
    else if (line.startsWith('# ')) blocks.push(<h1 key={k} className="mb-2 mt-5 text-h3 font-emphasis text-text-primary">{ri(line.slice(2), k)}</h1>);
    else blocks.push(<p key={k} className="my-2.5 leading-relaxed text-text-secondary">{ri(line, k)}</p>);
  });
  flushList('mdend');
  flushQuote('mdendq');
  return <div className="text-small [&>*:first-child]:mt-0">{blocks}</div>;
}

export const DOC_TYPES = ['overview', 'guide', 'domain', 'process', 'sop', 'report', 'ai_knowhow', 'faq', 'article'];
export const DOC_TYPE_LABEL_KEY: Record<string, string> = {
  overview: 'govern.docType.overview',
  guide: 'govern.docType.guide',
  domain: 'govern.docType.domain',
  process: 'govern.docType.process',
  sop: 'govern.docType.sop',
  report: 'govern.docType.report',
  ai_knowhow: 'govern.docType.ai_knowhow',
  faq: 'govern.docType.faq',
  article: 'govern.docType.article',
};
export const STATUS_TONE: Record<string, string> = {
  Published: 'bg-success/10 text-success', Draft: 'bg-surface-2 text-text-tertiary', Archived: 'bg-danger/10 text-danger',
};

export function docTypeLabel(type: string, t: (key: string) => string): string {
  const key = DOC_TYPE_LABEL_KEY[type];
  return key ? t(key) : type;
}

export function statusLabel(status: string, t: (key: string) => string): string {
  const key = `govern.status.${status}`;
  const label = t(key);
  return label === key ? status : label;
}

/** Human-readable target label for a managed metric (operator + value + unit). */
export function managedTargetLabel(m: {
  target_operator?: string | null; target_value?: number | null; target_value2?: number | null; unit?: string | null;
}): string {
  if (!m.target_operator || m.target_value == null) return '—';
  const range = m.target_operator === 'between' && m.target_value2 != null ? `–${m.target_value2}` : '';
  return `${m.target_operator} ${m.target_value}${range}${m.unit ? ' ' + m.unit : ''}`;
}
