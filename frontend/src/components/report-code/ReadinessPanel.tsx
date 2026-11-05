'use client';

/**
 * The server's ONE readiness report for the draft (services/report_code/readiness.py):
 * what blocks publishing and what to look at, per place on the page. Shown right after an
 * import and on every save - the author no longer discovers problems one by one after the
 * page renders.
 */
import React, { useEffect, useState } from 'react';
import { AlertOctagon, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';

import { reportCodeApi, type ReadinessItem, type ReadinessReport } from '@/lib/api/report-code';
import { useI18n } from '@/providers/LanguageProvider';

export function ReadinessPanel({ reportId, revision }: { reportId: number; revision: number | null | undefined }) {
  const { t } = useI18n();
  const [rep, setRep] = useState<ReadinessReport | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!revision) { setRep(null); return () => { alive = false; }; }
    reportCodeApi.readiness(reportId, revision).then((r) => { if (alive) setRep(r); }).catch(() => { if (alive) setRep(null); });
    return () => { alive = false; };
  }, [reportId, revision]);

  if (!rep) return null;
  const nBlock = rep.blocking.length;
  const nWarn = rep.warnings.length;
  const tone = nBlock ? 'border-red-300 bg-red-50 text-red-900' : nWarn ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900';
  return (
    <div className={`mx-4 mb-2 rounded-lg border px-3 py-2 text-xs sm:mx-5 ${tone}`} data-testid="studio-readiness" data-ready={rep.ready ? '1' : '0'}>
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        data-testid="studio-readiness-toggle" disabled={!nBlock && !nWarn}>
        {nBlock ? <AlertOctagon className="h-4 w-4 flex-shrink-0 text-red-600" /> : nWarn ? <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-600" /> : <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-600" />}
        <span className="font-medium">
          {nBlock ? t('reportCode.readiness.blocked', { n: nBlock }) : t('reportCode.readiness.ready')}
          {nWarn ? ` · ${t('reportCode.readiness.warnings', { n: nWarn })}` : ''}
        </span>
        {(nBlock || nWarn) ? (open ? <ChevronDown className="ml-auto h-4 w-4" /> : <ChevronRight className="ml-auto h-4 w-4" />) : null}
      </button>
      {open && (
        <ul className="mt-2 max-h-64 space-y-1.5 overflow-y-auto" data-testid="studio-readiness-list">
          {[...rep.blocking.map((x) => ({ ...x, level: 'block' as const })), ...rep.warnings.map((x) => ({ ...x, level: 'warn' as const }))].map((x, i) => (
            <Item key={i} item={x} level={x.level} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Item({ item, level }: { item: ReadinessItem; level: 'block' | 'warn' }) {
  return (
    <li className="rounded-md bg-white/70 px-2 py-1.5 ring-1 ring-inset ring-black/5" data-testid="studio-readiness-item" data-code={item.code} data-level={level}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={`rounded px-1 text-[10px] font-semibold uppercase ${level === 'block' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'}`}>{item.code}</span>
        {item.place?.label && <span className="text-[11px] font-medium text-text-secondary">{item.place.label}</span>}
        <span className="text-text-primary">{item.message}</span>
      </div>
      {item.place?.snippet && <code className="mt-0.5 block truncate text-[11px] text-text-tertiary">{item.place.snippet}</code>}
      {item.fix && <div className="mt-0.5 text-[11px] text-text-secondary">→ {item.fix}</div>}
    </li>
  );
}
