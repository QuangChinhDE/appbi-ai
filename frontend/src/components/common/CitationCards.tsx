'use client';

/**
 * The sources an answer was built from — openable at the version it used.
 *
 * WHY THIS EXISTS
 * ---------------
 * The runtime has been recording `FlowOutput.citations` for a while: which
 * document, which section, which block, which published version. Nothing rendered
 * them. An answer arrived with its evidence attached and the reader saw prose.
 *
 * WHY "OPEN" IS A ROUND TRIP AND NOT A LINK
 * -----------------------------------------
 * A citation names a VERSION, and `govern_doc_block` holds only the current one —
 * the AST is deleted and rewritten on every re-publish. Linking to the document
 * would show today's text under a citation that was made against version 5, with
 * nothing to say so. The resolve endpoint rebuilds the version that was actually
 * cited from its stored snapshot and checks the content fingerprint, so this can
 * show three honestly different things:
 *
 *   resolved + verified      the exact text, confirmed unchanged
 *   source_changed           the passage moved on since the answer was written
 *   version_not_kept         the snapshot is gone and nothing can be shown
 *
 * The third is the one worth building for. "The source has changed" is the fact a
 * reader most needs and the one a plain link can never tell them.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText, AlertTriangle, Check, Loader2 } from 'lucide-react';
import { resolveCitation, type ResolvedCitation } from '@/lib/catalog';
import { useI18n } from '@/providers/LanguageProvider';
import { cn } from '@/lib/utils';

export type AnswerCitation = {
  kind: string;
  ref: string;
  label?: string;
  used?: string[];
  url?: string;
  quote?: string;
  /** WHICH published version this passage came from, and a hash of what it said.
   *  Without them the resolve call can only report "here is something at those
   *  coordinates" — the block table holds one version, so an ordinal recorded in
   *  March resolves against June's document with nothing to say so. */
  version?: number | null;
  block_to?: number | null;
  fingerprint?: string;
};

/** `ref` is `"doc:block"` for a document passage — the runtime writes it that way
 *  so two passages from different sections of one document stay two citations. */
function parseRef(ref: string): { docId: number; block: number | null } | null {
  const [left, right] = String(ref || '').split(':');
  const docId = Number(left);
  if (!Number.isFinite(docId) || docId <= 0) return null;
  const block = Number(right);
  return { docId, block: Number.isFinite(block) ? block : null };
}

export function CitationCards({ citations }: { citations: AnswerCitation[] }) {
  const { t } = useI18n();
  const docs = (citations || []).filter((c) => c.kind === 'document');
  if (!docs.length) return null;

  return (
    <div className="mt-3 space-y-1.5">
      <p className="text-micro uppercase tracking-wide text-text-quaternary">
        {t('citation.sources', { n: docs.length })}
      </p>
      {docs.map((c, i) => <CitationCard key={`${c.ref}-${i}`} citation={c} />)}
    </div>
  );
}

function CitationCard({ citation }: { citation: AnswerCitation }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resolved, setResolved] = useState<ResolvedCitation | null>(null);
  const parsed = parseRef(citation.ref);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || resolved || !parsed) return;
    setLoading(true);
    try {
      setResolved(await resolveCitation({
        doc_id: parsed.docId,
        block: parsed.block ?? undefined,
        block_to: citation.block_to ?? undefined,
        document_version: citation.version ?? undefined,
        content_fingerprint: citation.fingerprint || undefined,
      }));
    } catch {
      // A citation that cannot be opened is a normal outcome, not an error to
      // shout about — the card says so in place of the passage.
      setResolved({ status: 'document_gone', resolved: false, verified: false,
                    text: null, note: t('citation.openFailed') } as ResolvedCitation);
    } finally {
      setLoading(false);
    }
  };

  const tone =
    resolved?.status === 'resolved' && resolved.verified ? 'ok'
    : resolved?.status === 'resolved' ? 'plain'
    : resolved ? 'warn' : 'plain';

  return (
    <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1">
      <button onClick={toggle}
        className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-surface-2">
        {open ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-quaternary" />
              : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-quaternary" />}
        <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-quaternary" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-caption text-text-secondary">
            {citation.label || citation.ref}
          </span>
          {citation.used?.length ? (
            <span className="text-micro text-text-quaternary">
              {t('citation.usedAs', { n: citation.used.join(', ') })}
            </span>
          ) : null}
        </span>
        {loading && <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-brand" />}
      </button>

      {open && resolved && (
        <div className="border-t border-[rgb(var(--border-line))] px-2.5 py-2">
          <div className={cn(
            'mb-1.5 flex items-center gap-1.5 text-micro',
            tone === 'ok' ? 'text-success' : tone === 'warn' ? 'text-warning' : 'text-text-tertiary',
          )}>
            {tone === 'ok' ? <Check className="h-3 w-3" />
             : tone === 'warn' ? <AlertTriangle className="h-3 w-3" /> : null}
            <span>{statusText(resolved, t)}</span>
          </div>
          {resolved.text ? (
            <p className="whitespace-pre-wrap text-caption leading-relaxed text-text-secondary">
              {resolved.text}
            </p>
          ) : (
            <p className="text-caption italic text-text-quaternary">{resolved.note}</p>
          )}
          {resolved.text && resolved.note && (
            <p className="mt-1 text-micro text-text-quaternary">{resolved.note}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** What the reader is told, in the order they care about it: whether this is the
 *  text the answer used, then which version it came from. */
function statusText(
  r: ResolvedCitation,
  t: (k: string, p?: Record<string, string | number>) => string,
): string {
  if (r.status === 'resolved' && r.verified) {
    return r.is_current
      ? t('citation.verifiedCurrent', { v: r.version ?? '?' })
      : t('citation.verifiedOld', { v: r.version ?? '?', cur: r.current_version ?? '?' });
  }
  if (r.status === 'resolved') return t('citation.unverified', { v: r.version ?? '?' });
  if (r.status === 'source_changed') return t('citation.changed');
  if (r.status === 'version_not_kept') return t('citation.versionGone', { v: r.version ?? '?' });
  if (r.status === 'block_not_found') return t('citation.blockGone');
  return t('citation.docGone');
}
