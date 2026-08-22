'use client';

/**
 * Try the flow the way a viewer will use it: as a CONVERSATION.
 *
 * WHY THIS REPLACED A ONE-QUESTION BOX.
 * The old dialog took a question, ran it, and printed the answer. That looked like
 * a test and quietly put half the authoring surface out of reach — because a flow's
 * behaviour is not a property of one turn:
 *
 *   · `context_policy: last_3` has nothing to read on turn one.
 *   · `run_policy: once_per_session` cannot be observed reusing anything until
 *     there is a second turn to reuse it in.
 *   · a `memory_delta` cannot be seen surviving into a turn that never happens.
 *   · a classifier reads the transcript, so the BRANCH a question takes changes
 *     depending on what was asked before it.
 *
 * An author could configure all four, watch one question answer perfectly, and ship
 * a flow whose second turn behaved in a way nothing had ever shown them. The whole
 * class of "it worked when I tested it" lived in that gap.
 *
 * The session is the same machinery a viewer gets — the server-owned memory store,
 * loaded and saved per turn — so what happens here is what will happen there.
 *
 * AND THE SAME RENDERER.
 * The answer text carries markers: `[chart:N]` citations, `[HIGH]` confidence,
 * `[DESC]`/`[DIAG]` insight kinds, `[FOLLOWUP]` lines. A viewer sees chips and
 * suggestion buttons; the first version of this panel printed the raw string, so an
 * author read `[FOLLOWUP] …` as literal text and judged their own flow by output no
 * viewer will ever see. Both now import one renderer from `common/AiAnswer`, and the
 * follow-up chips here are live — clicking one asks it, which is also the fastest
 * way to reach a second turn.
 */
import {
  FlaskConical, Loader2, Play, RotateCcw, Send, Sparkles, ThumbsDown, ThumbsUp,
} from 'lucide-react';
import React from 'react';

import { AppModalShell } from '@/components/common/AppModalShell';
import { ChartNamesContext, RichMarkdown, extractFollowups } from '@/components/common/AiAnswer';
import { CitationCards } from '@/components/common/CitationCards';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import {
  listTestTargetReports, rateRun, testFlow, testFlowOnReport, walkNodes,
  type FlowLinkUsage, type FlowNode, type ReportTestResult, type TestTargetReport,
} from '@/lib/agentFlows';

/** One alternative a branching node can take, as something testable.
 *
 *  Branches are the part authors get wrong and the part a free-text box hides: you
 *  type a question, read a plausible answer, and never learn it came down the
 *  fallback lane. Each probe carries the label the RUNTIME will push onto the path,
 *  which is what makes the after-the-fact comparison exact rather than a guess. */
type BranchProbe = {
  nodeKey: string;
  nodeName: string;
  /** `name or key` for an IF path, `label or key` for a switch case, the literal
   *  `fallback` otherwise. Mirrors `executor._run_if` / `_run_switch`. */
  pathLabel: string;
  /** A question likely to reach this branch, when the flow says enough to build
   *  one — the compared-against literal. An IF comparing two variables says
   *  nothing useful, and then the author writes their own. */
  hint: string;
};

export function branchProbes(nodes: FlowNode[]): BranchProbe[] {
  const out: BranchProbe[] = [];
  for (const n of walkNodes(nodes || [])) {
    const nodeName = n.name || n.key;
    if (n.type === 'switch') {
      for (const c of n.cases || []) {
        out.push({
          nodeKey: n.key, nodeName,
          pathLabel: c.label || c.key,
          hint: (c.value || '').trim(),
        });
      }
      if (n.has_fallback && (n.fallback || []).length) {
        out.push({ nodeKey: n.key, nodeName, pathLabel: 'fallback', hint: '' });
      }
    } else if (n.type === 'if') {
      for (const p of n.paths || []) {
        out.push({
          nodeKey: n.key, nodeName,
          pathLabel: p.name || p.key,
          hint: (p.conditions || []).map((c) => String(c.right ?? '')).find(Boolean) || '',
        });
      }
    }
  }
  return out;
}

type Envelope = {
  status?: string;
  trace?: { path: string; steps: TraceStepView[] };
  answer?: { blocks: { type: string; markdown?: string }[] };
  notices?: { code: string; text: string }[];
  /** Which passages the answer was built from. The runtime has recorded these for
   *  a while and nothing rendered them — an answer arrived with its evidence
   *  attached and the reader saw prose. */
  citations?: {
    kind: string; ref: string; label?: string; used?: string[];
    version?: number | null; block_to?: number | null; fingerprint?: string;
  }[];
  usage?: {
    llm_calls?: number; tool_calls?: number;
    prompt_tokens?: number; completion_tokens?: number; ms?: number;
  };
};

type TraceStepView = {
  key: string; name: string; type: string; status: string; ms: number;
  branch?: string; tool_calls?: string[]; error?: string;
  prompt_tokens?: number; completion_tokens?: number;
  input_preview?: string; output_preview?: string;
};

type Turn = {
  question: string;
  /** What the author was AIMING at when they sent it, if anything. Kept per turn
   *  rather than globally: the aim belongs to the question that was asked under it,
   *  and a verdict shown against a later turn's route would be a lie. */
  aimed?: string;
  answer: string;
  env?: Envelope;
  runId?: number;
  rating?: 'up' | 'down';
  failed?: string;
};

/** A short, stable id for one test conversation. Not `crypto.randomUUID()` only
 *  because a readable prefix makes these obvious in the runs table. */
function newSessionKey(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `studio-${rand}${Date.now().toString(36)}`.slice(0, 64);
}

export function TestChat({
  brainKey, brainName, links, version, nodes, onOpenRun, onClose,
}: {
  brainKey: string;
  brainName: string;
  links: FlowLinkUsage[];
  version: number;
  nodes: FlowNode[];
  onOpenRun: (runId: number) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const memKey = `appbi.flowtest.${brainKey}`;
  const [reports, setReports] = React.useState<TestTargetReport[] | null>(null);
  /** WHAT THIS CONVERSATION RUNS AGAINST.
   *
   *  A link and a report are both valid answers to "test it on what", and they are
   *  not the same test. A link carries the real contract — its resolved
   *  requirements, its allowed charts, its knowledge scope, its budget — so late in
   *  a build "does it work on THAT link" is the sharper question. A bare report
   *  uses an ad-hoc contract and is what you need before any link exists. Both are
   *  offered, in one list, because the choice is "against what", not "which mode". */
  const [target, setTarget] = React.useState<{ kind: 'report' | 'link'; id: number } | null>(null);
  const reportId = target?.kind === 'report' ? target.id : null;
  const [reportFilter, setReportFilter] = React.useState('');
  const [reportError, setReportError] = React.useState<string | null>(null);
  const [sessionKey, setSessionKey] = React.useState(newSessionKey);
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [draft, setDraft] = React.useState('');
  const [aimed, setAimed] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [readiness, setReadiness] = React.useState<ReportTestResult['readiness']>();
  const [reportInfo, setReportInfo] = React.useState<ReportTestResult['report']>();
  const [openTurn, setOpenTurn] = React.useState<number | null>(null);
  const scroller = React.useRef<HTMLDivElement>(null);

  const probes = React.useMemo(() => branchProbes(nodes), [nodes]);
  /** `id → title`, so a `[chart:N]` citation names the tile. Comes back with the
   *  run because the panel does not otherwise know the report's charts. */
  const chartNames = React.useMemo(() => {
    const m = new Map<number, string>();
    for (const c of reportInfo?.charts || []) m.set(c.id, c.title);
    return m;
  }, [reportInfo]);
  const servedIds = React.useMemo(
    () => new Set(links.map((l) => l.dashboard_id)), [links],
  );

  React.useEffect(() => {
    let alive = true;
    let remembered: { reportId?: number } = {};
    try {
      remembered = JSON.parse(window.localStorage.getItem(memKey) || '{}') || {};
    } catch { /* a corrupt entry is not worth a broken screen */ }

    listTestTargetReports()
      .then((rs) => {
        if (!alive) return;
        // Reports this flow already serves lead the list: a regression is noticed
        // on those first, so they are what an author should re-test on.
        const ordered = [...rs].sort((a, b) => {
          const sa = servedIds.has(a.id) ? 0 : 1;
          const sb = servedIds.has(b.id) ? 0 : 1;
          return sa - sb || a.name.localeCompare(b.name);
        });
        setReports(ordered);
        // A link if the flow has one — it is the sharper test, and a flow WITH
        // links is past the stage where "does it work at all" is the question.
        // Otherwise the remembered report, then the first one offered.
        const kept = remembered.reportId
          && ordered.some((r) => r.id === remembered.reportId)
          ? remembered.reportId : null;
        setTarget((cur) => cur ?? (
          links.length ? { kind: 'link' as const, id: links[0].link_id }
            : (kept ?? ordered[0]?.id) != null
              ? { kind: 'report' as const, id: (kept ?? ordered[0]!.id) }
              : null
        ));
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // A 403 is the honest answer, not a failure to load: this account has no
        // Dashboards permission, so there is no report it may test against.
        const status = (e as { response?: { status?: number } })?.response?.status;
        setReports([]);
        setReportError(
          status === 403
            ? t('agentFlows.test.noReportAccess')
            : t('agentFlows.test.reportsFailed'),
        );
      });
    return () => { alive = false; };
  }, [t, memKey, servedIds, links]);

  React.useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [turns.length, busy]);

  const reset = React.useCallback((why?: string) => {
    setTurns([]);
    setSessionKey(newSessionKey());
    setReadiness(undefined);
    setOpenTurn(null);
    if (why) toast.info(why);
  }, []);

  /** Switching target ENDS the conversation. Memory established over one report's
   *  figures must not be read while answering about another, and two links are two
   *  different data contracts — that is the rule the server already enforces
   *  between public links, and silently keeping the session here would make the
   *  studio the one place it does not hold. */
  const pickTarget = (kind: 'report' | 'link', id: number) => {
    if (target?.kind === kind && target.id === id) return;
    setTarget({ kind, id });
    if (kind === 'report') {
      try {
        window.localStorage.setItem(memKey, JSON.stringify({ reportId: id }));
      } catch { /* private mode: remembering is a convenience */ }
    }
    if (turns.length) reset(t('agentFlows.test.resetOnTargetChange'));
  };

  const send = async (override?: string) => {
    const question = (override ?? draft).trim();
    if (!question || !target || busy) return;
    const history = turns.flatMap((tn) => ([
      { role: 'user' as const, content: tn.question },
      ...(tn.answer ? [{ role: 'assistant' as const, content: tn.answer }] : []),
    ]));
    if (!override) setDraft('');
    setBusy(true);
    const at = turns.length;
    setTurns((prev) => [...prev, { question, aimed: aimed ?? undefined, answer: '' }]);
    try {
      const res = target.kind === 'report'
        ? await testFlowOnReport(brainKey, {
          dashboard_id: target.id, question, version,
          session_key: sessionKey, history,
        })
        : await testFlow(brainKey, {
          link_id: target.id, question, version,
          session_key: sessionKey, history,
        }) as ReportTestResult;
      const env = res.envelope as Envelope | undefined;
      const answer = (env?.answer?.blocks || [])
        .map((b) => b.markdown).filter(Boolean).join('\n\n');
      setReadiness(res.readiness);
      setReportInfo(res.report);
      setTurns((prev) => prev.map((tn, i) => (
        i === at ? { ...tn, answer, env, runId: res.run_row_id ?? undefined } : tn
      )));
      setOpenTurn(at);
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      const msg = typeof detail === 'string' ? detail : t('agentFlows.test.failed');
      setTurns((prev) => prev.map((tn, i) => (i === at ? { ...tn, failed: msg } : tn)));
      toast.error(msg);
    } finally { setBusy(false); }
  };

  const rate = async (i: number, rating: 'up' | 'down') => {
    const turn = turns[i];
    if (!turn?.runId) return;
    const next = turn.rating === rating ? null : rating;
    setTurns((prev) => prev.map((tn, j) => (
      j === i ? { ...tn, rating: next ?? undefined } : tn
    )));
    try {
      await rateRun(brainKey, turn.runId, next);
    } catch {
      toast.error(t('agentFlows.test.rateFailed'));
    }
  };

  const visible = (reports || []).filter(
    (r) => !reportFilter.trim()
      || r.name.toLowerCase().includes(reportFilter.trim().toLowerCase()),
  );
  // Only the ERRORS. A flow mid-build carries advisory warnings by definition, and
  // listing those as "what a real link would still have to answer" told authors a
  // working flow was broken.
  const gaps = readiness?.errors || [];
  const coverage = readiness?.coverage;
  const partialRead = reportInfo
    && reportInfo.charts_total != null && reportInfo.charts_read != null
    && reportInfo.charts_read < reportInfo.charts_total;

  return (
    // A CENTRED MODAL, at the size the Public Link dialog uses. It was full-screen
    // first, which read as leaving the builder rather than trying something in it —
    // and testing is a loop you run WHILE editing, so the canvas staying visible
    // behind the panel is part of the point.
    <AppModalShell
      onClose={onClose}
      title={t('agentFlows.test.title')}
      description={
        <span className="flex items-center gap-1.5">
          <span className="truncate">{brainName}</span>
          <Badge size="xs" variant="neutral">v{version}</Badge>
        </span>
      }
      icon={<FlaskConical className="h-4 w-4" />}
      maxWidthClass="max-w-[96rem]"
      panelClassName="h-[94vh] max-h-[94vh]"
      bodyClassName="p-0"
      footer={turns.length ? (
        <Button size="sm" variant="ghost" onClick={() => reset()}>
          <RotateCcw className="h-3.5 w-3.5" /> {t('agentFlows.test.newConversation')}
        </Button>
      ) : undefined}
    >
    <ChartNamesContext.Provider value={chartNames}>
      <div className="flex h-full min-h-0">
        {/* ── setup ─────────────────────────────────────────────────────────── */}
        <div className="w-[320px] flex-shrink-0 overflow-auto border-r border-[rgb(var(--border-line))] p-3.5">
          {/* LINKS FIRST, when there are any.
              A link carries the contract a viewer actually runs under — its resolved
              requirements, allowed charts, knowledge scope and budget — so a flow
              that has links should be tried on one. A bare report uses an ad-hoc
              contract and is what you need before any link exists. */}
          {!!links.length && (
            <>
              <label className="mb-1 block text-caption font-medium text-text-secondary">
                {t('agentFlows.test.onLink')}
              </label>
              <div className="mb-1.5 overflow-hidden rounded-lg border border-[rgb(var(--border-line))]">
                {links.map((l) => (
                  <button
                    key={l.link_id}
                    type="button"
                    onClick={() => pickTarget('link', l.link_id)}
                    className={cn(
                      'flex w-full items-center gap-2 border-t border-[rgb(var(--border-line))] px-2.5 py-1.5 text-left text-caption first:border-t-0',
                      target?.kind === 'link' && target.id === l.link_id
                        ? 'bg-accent/10 font-medium' : 'hover:bg-surface-2',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{l.link_name}</span>
                    {!l.link_active && (
                      <Badge size="xs" variant="neutral">{t('agentFlows.test.linkInactive')}</Badge>
                    )}
                  </button>
                ))}
              </div>
              <p className="mb-3 text-tiny leading-5 text-text-tertiary">
                {t('agentFlows.test.linkHint')}
              </p>
            </>
          )}

          <label className="mb-1 block text-caption font-medium text-text-secondary">
            {t('agentFlows.test.report')}
          </label>
          {reports === null ? (
            <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
          ) : reportError ? (
            <p className="rounded-lg border border-warning/25 bg-warning/5 p-2.5 text-caption leading-relaxed text-warning">
              {reportError}
            </p>
          ) : !reports.length ? (
            <p className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-2.5 text-caption text-text-tertiary">
              {t('agentFlows.test.noReports')}
            </p>
          ) : (
            <>
              {/* A dropdown is fine for six reports and useless for sixty, and an
                  account with Dashboards access usually has sixty. */}
              {reports.length > 6 && (
                <Input
                  value={reportFilter}
                  onChange={(e) => setReportFilter(e.target.value)}
                  placeholder={t('agentFlows.test.searchReports')}
                  className="mb-1.5 h-8"
                />
              )}
              <div className="max-h-[220px] overflow-auto rounded-lg border border-[rgb(var(--border-line))]">
                {!visible.length ? (
                  <p className="px-2.5 py-2 text-caption text-text-tertiary">
                    {t('agentFlows.test.noMatch')}
                  </p>
                ) : visible.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => pickTarget('report', r.id)}
                    className={cn(
                      'flex w-full items-center gap-2 border-t border-[rgb(var(--border-line))] px-2.5 py-1.5 text-left text-caption first:border-t-0',
                      reportId === r.id ? 'bg-accent/10 font-medium' : 'hover:bg-surface-2',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{r.name}</span>
                    {servedIds.has(r.id) && (
                      <Badge size="xs" variant="info">{t('agentFlows.test.inUse')}</Badge>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
          <p className="mt-1.5 text-tiny leading-5 text-text-tertiary">
            {t('agentFlows.test.reportHint')}
          </p>

          {/* AIM AT A PATH, NOT JUST AT THE FLOW. Picking a branch both fills a
              question aimed there and records the aim, which is what lets a turn
              report "it went somewhere else" — the failure a free-text box cannot
              report because nothing knew what you intended. */}
          {!!probes.length && (
            <>
              <label className="mb-1 mt-4 block text-caption font-medium text-text-secondary">
                {t('agentFlows.test.probeLabel')}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {probes.map((p) => (
                  <button
                    key={`${p.nodeKey}:${p.pathLabel}`}
                    type="button"
                    title={p.nodeName}
                    onClick={() => {
                      setAimed(p.pathLabel);
                      if (p.hint) setDraft(p.hint);
                    }}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-tiny transition',
                      aimed === p.pathLabel
                        ? 'border-accent bg-accent/10 font-medium text-accent'
                        : 'border-[rgb(var(--border-line))] text-text-secondary hover:bg-surface-2',
                    )}
                  >
                    {p.pathLabel}
                  </button>
                ))}
                {aimed && (
                  <button
                    type="button"
                    onClick={() => setAimed(null)}
                    className="rounded-full px-2 py-1 text-tiny text-text-tertiary hover:bg-surface-2"
                  >
                    {t('agentFlows.test.clearProbe')}
                  </button>
                )}
              </div>
            </>
          )}

          {!!gaps.length && (
            <div className="mt-4 rounded-lg border border-warning/25 bg-warning/5 p-2.5">
              <b className="block text-caption text-warning">{t('agentFlows.test.gapsTitle')}</b>
              <ul className="mt-1 space-y-1">
                {gaps.map((g, i) => (
                  <li key={i} className="text-caption leading-relaxed text-warning">• {g.message}</li>
                ))}
              </ul>
            </div>
          )}

          {/* WHAT THIS FLOW CANNOT ANSWER, named before a viewer finds out.
              Derived from the granted tools, so it cannot drift from reality. Not
              framed as an error: narrowing a flow on purpose is legitimate, and the
              point is only that the author should know which questions fall outside
              it — because the bot's own way of saying so is to tell the viewer the
              report has no such information, which blames the data. */}
          {!!coverage && !!coverage.gaps.length && (
            <div className="mt-4 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-2.5">
              <b className="block text-caption text-text-secondary">
                {t('agentFlows.test.coverageTitle', {
                  n: coverage.answerable, total: coverage.total,
                })}
              </b>
              <ul className="mt-1.5 space-y-1.5">
                {coverage.gaps.map((g) => (
                  <li key={g.key} className="text-tiny leading-5 text-text-tertiary">
                    <span className="text-text-secondary">{g.label}</span>
                    {' — '}
                    {t('agentFlows.test.coverageGap', { pack: g.pack })}
                    <br />
                    <span className="italic">“{g.example}”</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {partialRead && (
            <p className="mt-3 text-tiny leading-5 text-text-tertiary">
              {t('agentFlows.test.chartsRead', {
                read: reportInfo!.charts_read!, total: reportInfo!.charts_total!,
              })}
            </p>
          )}

          <p className="mt-4 break-all text-tiny leading-5 text-text-quaternary">
            {t('agentFlows.test.sessionNote', { key: sessionKey })}
          </p>
        </div>

        {/* ── conversation ──────────────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={scroller} className="min-h-0 flex-1 overflow-auto px-4 py-4">
            {!turns.length && !busy && (
              <div className="mx-auto max-w-[560px] pt-10 text-center">
                <p className="text-body font-strong">{t('agentFlows.test.emptyTitle')}</p>
                <p className="mt-1.5 text-caption leading-relaxed text-text-tertiary">
                  {t('agentFlows.test.emptyBody')}
                </p>
              </div>
            )}

            <div className="mx-auto max-w-[780px] space-y-4">
              {turns.map((tn, i) => (
                <TurnView
                  key={i}
                  turn={tn}
                  index={i}
                  open={openTurn === i}
                  isLast={i === turns.length - 1}
                  busy={busy}
                  onToggle={() => setOpenTurn(openTurn === i ? null : i)}
                  onRate={(r) => rate(i, r)}
                  onAsk={(q) => void send(q)}
                  onOpenRun={onOpenRun}
                />
              ))}
              {busy && (
                <div className="flex items-center gap-2 text-caption text-text-tertiary">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('agentFlows.test.running')}
                </div>
              )}
            </div>
          </div>

          <div className="flex-shrink-0 border-t border-[rgb(var(--border-line))] bg-surface-1 p-3">
            <div className="mx-auto flex max-w-[780px] items-end gap-2">
              <Textarea
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends, Shift+Enter breaks the line — the convention of
                  // every chat box, and this one is meant to feel like the one the
                  // viewer will use.
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
                }}
                placeholder={t('agentFlows.test.askPlaceholder')}
                className="flex-1"
              />
              <Button size="sm" onClick={() => void send()} loading={busy} disabled={!target || !draft.trim()}>
                {turns.length ? <Send className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                {turns.length ? t('agentFlows.test.send') : t('agentFlows.test.run')}
              </Button>
            </div>
            <p className="mx-auto mt-1.5 max-w-[780px] text-tiny text-text-quaternary">
              {t('agentFlows.test.turnNote', { n: turns.length + 1 })}
            </p>
          </div>
        </div>
      </div>
    </ChartNamesContext.Provider>
    </AppModalShell>
  );
}

/** One question and what the flow did with it. */
function TurnView({
  turn, index, open, isLast, busy, onToggle, onRate, onAsk, onOpenRun,
}: {
  turn: Turn; index: number; open: boolean;
  /** Suggestion chips are offered on the LAST turn only. Older ones are history,
   *  and a chip halfway up the transcript would ask a question out of order. */
  isLast: boolean;
  busy: boolean;
  onToggle: () => void;
  onRate: (r: 'up' | 'down') => void;
  onAsk: (question: string) => void;
  onOpenRun: (runId: number) => void;
}) {
  const { t } = useI18n();
  const env = turn.env;
  const steps = env?.trace?.steps || [];
  const tokens = (env?.usage?.prompt_tokens || 0) + (env?.usage?.completion_tokens || 0);
  const route = env?.trace?.path || '';
  // Split the markers out of the prose exactly as the viewer's chat does, so the
  // author is judging the same output.
  const answer = React.useMemo(() => extractFollowups(turn.answer || ''), [turn.answer]);
  /** The path is the labels the runtime pushed, joined — so containment is an exact
   *  test, not a heuristic on names. */
  const wentElsewhere = Boolean(
    turn.aimed && env
    && !route.split(' · ').map((x) => x.trim()).includes(turn.aimed),
  );

  return (
    <div>
      <div className="flex justify-end">
        <p className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent/10 px-3.5 py-2 text-caption leading-relaxed">
          {turn.question}
        </p>
      </div>

      {turn.failed ? (
        <p className="mt-2 rounded-lg border border-danger/25 bg-danger/5 p-2.5 text-caption leading-relaxed text-danger">
          {turn.failed}
        </p>
      ) : !env ? null : (
        <div className="mt-2">
          {/* THE ANSWER CAN BE FINE AND THE ROUTING STILL WRONG. Before the answer,
              because an author who reads a good answer first stops reading. */}
          {wentElsewhere && (
            <p className="mb-2 rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-caption leading-relaxed text-warning">
              {t('agentFlows.test.wrongPath', {
                intended: turn.aimed!, actual: route || t('agentFlows.test.noPath'),
              })}
            </p>
          )}

          <div className="rounded-2xl rounded-bl-md border border-[rgb(var(--border-line))] bg-surface-1 px-3.5 py-2.5 text-caption leading-relaxed">
            {answer.body
              ? <RichMarkdown text={answer.body} />
              : <span className="text-text-tertiary">—</span>}
            {/* THE EVIDENCE, openable at the version it was cited from. Testing a
                flow means checking WHERE its answers come from, and until now the
                one screen built for that showed only the prose. */}
            <CitationCards citations={turn.env?.citations || []} />
          </div>

          {/* THE SUGGESTIONS A VIEWER WOULD SEE, and they work here too. Clicking
              one asks it — which is also the shortest path to a second turn, where
              reuse and transcript-reading branches start to matter. */}
          {isLast && !!answer.suggestions.length && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {answer.suggestions.map((q, i) => (
                <button
                  key={i}
                  type="button"
                  disabled={busy}
                  onClick={() => onAsk(q)}
                  className="flex items-center gap-1 rounded-full border border-[rgb(var(--border-line))] px-2.5 py-1 text-tiny text-text-secondary transition hover:border-brand/40 hover:bg-surface-2 disabled:opacity-50"
                >
                  <Sparkles className="h-3 w-3 text-brand" />{q}
                </button>
              ))}
            </div>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-2 px-1">
            <Badge
              size="xs"
              variant={env.status === 'ok' ? 'success' : env.status === 'failed' ? 'danger' : 'warning'}
            >
              {env.status}
            </Badge>
            {!!route && <span className="text-tiny text-text-tertiary">{route}</span>}
            {!!tokens && (
              <span className="text-tiny text-text-tertiary">
                {t('agentFlows.test.cost', {
                  tokens: tokens.toLocaleString(),
                  calls: env.usage?.llm_calls || 0,
                  tools: env.usage?.tool_calls || 0,
                })}
              </span>
            )}
            {/* Reuse is the whole reason this is a conversation and not a box.
                Named on the turn where it happens, so the saving is visible. */}
            {steps.some((s) => s.status === 'reused') && (
              <Badge size="xs" variant="info">
                {t('agentFlows.test.reusedSteps', {
                  n: steps.filter((s) => s.status === 'reused').length,
                })}
              </Badge>
            )}
            <button
              type="button"
              onClick={onToggle}
              className="text-tiny text-accent underline-offset-2 hover:underline"
            >
              {open
                ? t('agentFlows.test.hideSteps')
                : t('agentFlows.test.showSteps', { n: steps.length })}
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => onRate('up')}
              className={cn('rounded p-1', turn.rating === 'up' ? 'text-success' : 'text-text-quaternary hover:bg-surface-2')}
              aria-label={t('agentFlows.test.rateUp')}
            >
              <ThumbsUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onRate('down')}
              className={cn('rounded p-1', turn.rating === 'down' ? 'text-danger' : 'text-text-quaternary hover:bg-surface-2')}
              aria-label={t('agentFlows.test.rateDown')}
            >
              <ThumbsDown className="h-3.5 w-3.5" />
            </button>
            {!!turn.runId && (
              <button
                type="button"
                onClick={() => onOpenRun(turn.runId!)}
                className="text-tiny text-accent underline-offset-2 hover:underline"
              >
                {t('agentFlows.test.openRun')}
              </button>
            )}
          </div>

          {/* Notices explain an answer that would otherwise look unexplained — a
              branch that matched nothing, a truncated read, a reset memory. */}
          {!!(env.notices || []).length && (
            <ul className="mt-2 space-y-1">
              {env.notices!.map((n, i) => (
                <li key={i} className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-1.5 text-tiny leading-5 text-text-secondary">
                  {n.text}
                </li>
              ))}
            </ul>
          )}

          {open && (
            <div className="mt-2 overflow-hidden rounded-lg border border-[rgb(var(--border-line))]">
              {steps.map((s, i) => (
                <div key={i} className="border-t border-[rgb(var(--border-line))] px-2.5 py-1.5 text-tiny first:border-t-0">
                  <div className="flex items-center gap-2">
                    <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full',
                      s.status === 'ok' ? 'bg-success'
                        : s.status === 'error' ? 'bg-danger'
                        : s.status === 'reused' ? 'bg-info' : 'bg-surface-3')} />
                    <span className="min-w-0 flex-1 truncate">{s.name || s.key}</span>
                    {/* Which lane the step ran in. Shown only where the flow has
                        lanes, because that is where "did my branch run" is asked. */}
                    {!!s.branch && (
                      <span className="flex-shrink-0 rounded bg-surface-2 px-1.5 text-text-tertiary">{s.branch}</span>
                    )}
                    <span className="flex-shrink-0 text-text-quaternary">{s.status} · {s.ms}ms</span>
                  </div>
                  {!!s.error && (
                    <p className="mt-1 pl-3.5 leading-5 text-danger">{s.error}</p>
                  )}
                  {!!(s.tool_calls || []).length && (
                    <p className="mt-1 pl-3.5 leading-5 text-text-quaternary">
                      {s.tool_calls!.join(', ')}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {index === 0 && null}
    </div>
  );
}
