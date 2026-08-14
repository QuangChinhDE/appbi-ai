'use client';

/**
 * What this flow actually did, for real viewers.
 *
 * The four questions this screen exists to answer, none of which had an answer
 * before — the old telemetry table was keyed by link and knew nothing about flows,
 * versions or nodes:
 *
 *   which questions fail        → the flow needs another branch
 *   which node is slow          → optimise the right one
 *   is v6 better than v5        → runs carry their version
 *   was the answer any good     → the viewer's thumb, joined in
 *
 * Test runs are excluded by default. Without that, the first week of any flow's
 * numbers is mostly its author trying things.
 */
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import React from 'react';

import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import {
  getBrain, listNodeSpecs, listRuns, runDetail, runStats,
  type FlowNode, type NodeSpec,
  type RunDetail, type RunRow, type RunStats, type RunStep,
} from '@/lib/agentFlows';
import { FlowCanvas } from './FlowCanvas';
import { formatWhen } from './shared';

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  ok: 'success', partial: 'warning', blocked: 'danger', failed: 'danger', throttled: 'warning',
};
const STATUS_LABEL_KEY: Record<string, string> = {
  ok: 'agentFlows.runs.status.ok',
  partial: 'agentFlows.runs.status.partial',
  blocked: 'agentFlows.runs.status.blocked',
  failed: 'agentFlows.runs.status.failed',
  throttled: 'agentFlows.runs.status.throttled',
};

export function RunsTab({ brainKey }: { brainKey: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [rows, setRows] = React.useState<RunRow[]>([]);
  const [stats, setStats] = React.useState<RunStats | null>(null);
  const [detail, setDetail] = React.useState<RunDetail | null>(null);
  const [status, setStatus] = React.useState('');
  const [hours, setHours] = React.useState(24);
  const [search, setSearch] = React.useState('');
  const [includeTests, setIncludeTests] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  //: Which node the right pane is describing. Reset when a different run is
  //: opened, or the panel would show step 3 of the previous run against this
  //: one's steps.
  const [openStep, setOpenStep] = React.useState<string | null>(null);
  //: The flow body of the version THIS RUN executed, for the canvas in the
  //: middle. Fetched per run rather than once for the brain: a run from v3 must
  //: not be drawn on v12's shape, which is the same rule the per-step config
  //: follows.
  const [flowBody, setFlowBody] = React.useState<FlowNode[] | null>(null);
  const [specs, setSpecs] = React.useState<Record<string, NodeSpec>>({});
  const [answerKey, setAnswerKey] = React.useState('');

  React.useEffect(() => {
    listNodeSpecs().then((list) => {
      setSpecs(Object.fromEntries(list.map((sp) => [sp.type, sp])));
    }).catch(() => setSpecs({}));
  }, []);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      listRuns(brainKey, { status: status || undefined, since_hours: hours, search, include_tests: includeTests }),
      runStats(brainKey, hours),
    ])
      .then(([list, s]) => {
        if (!alive) return;
        setRows(list.runs);
        setStats(s);
      })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [brainKey, status, hours, search, includeTests]);

  const load = React.useCallback(async (runId: number) => {
    setOpenStep(null);
    setFlowBody(null);
    const d = await runDetail(brainKey, runId);
    setDetail(d);
    // The SHAPE the run actually took. Drawing it on the flow's current body
    // would show branches that did not exist when this question was asked.
    if (d.version != null) {
      try {
        const brain = await getBrain(brainKey, d.version);
        setFlowBody(brain.body?.nodes || []);
        setAnswerKey(brain.body?.answer_node || '');
      } catch {
        setFlowBody([]);   // version deleted — the canvas says so rather than lying
      }
    }
  }, [brainKey]);

  // WHICH RUN IS OPEN BELONGS IN THE URL.
  //
  // Selecting a run left the address bar unchanged, so F5 dropped the reader
  // back to an empty list and they had to find the run again by timestamp — and
  // a run could not be sent to anybody. `?run=169` restores the same run, and
  // is what somebody pastes into a bug report.
  const runParam = searchParams?.get('run');

  const open = (row: RunRow) => {
    const next = new URLSearchParams(searchParams?.toString() || '');
    next.set('run', String(row.id));
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  React.useEffect(() => {
    const id = Number(runParam);
    if (!id) { setDetail(null); return; }
    if (detail?.id === id) return;
    // A run id from a link may belong to another flow, be past retention, or
    // simply not exist. Clearing the param says so by returning to the list
    // rather than leaving a URL that keeps failing on every reload.
    load(id).catch(() => {
      const next = new URLSearchParams(searchParams?.toString() || '');
      next.delete('run');
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    });
  }, [runParam, detail?.id, load, pathname, router, searchParams]);

  /** node key → what happened to it in THIS run, for the canvas overlay.
   *  `skipped` covers a node the run never reached: the canvas draws the whole
   *  flow, and a branch nobody took must look different from one that ran. */
  const runStatuses = React.useMemo(() => {
    const out: Record<string, 'running' | 'done' | 'error' | 'skipped' | 'reused'> = {};
    for (const s of detail?.steps || []) {
      out[s.key] = s.status === 'ok' ? 'done'
        : s.status === 'error' || s.status === 'blocked' ? 'error'
        : s.status === 'reused' ? 'reused'
        : 'skipped';
    }
    return out;
  }, [detail]);

  const selectedStep = React.useMemo(
    () => (detail?.steps || []).find((s) => s.key === openStep) || null,
    [detail, openStep],
  );

  return (
    /* FULL BLEED, THREE COLUMNS.
       This was a centred `max-w-[1400px]` page that scrolled as a whole — fine
       for a table, wrong for an inspector: the flow, the run list and the node
       detail each want their own scroll, and capping the width left the canvas
       squeezed into the middle third of a wide screen while margin sat unused on
       both sides. The panes are siblings in one full-height row now, so each
       scrolls independently and the canvas gets whatever is left over. */
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-shrink-0 border-b border-[rgb(var(--border-line))] px-4 pt-3">
        <div className="mb-3 flex flex-wrap items-center gap-6 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2.5">
          <Stat value={stats?.runs ?? 0} label={`Runs / ${hours}h`} />
          {/* "Trả lời được", not "Thành công": a `partial` run DID answer the
              viewer, so it counts here — but printing 100% THÀNH CÔNG above a row
              visibly marked "Một phần" makes the number look wrong even when it is
              right. The label is what had to change. */}
          <Stat value={`${stats?.success_rate ?? 0}%`} label={t('agentFlows.runs.answerable')} />
          <Stat value={`${((stats?.p95_latency_ms ?? 0) / 1000).toFixed(1)}s`} label="P95" />
          <Stat value={stats?.avg_tokens ?? 0} label="Token TB" />
          <Stat value={stats?.errors ?? 0} label={t('agentFlows.runs.errors')} />
          <Stat value={stats?.links ?? 0} label={t('agentFlows.runs.linksUsing')} />
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder={t('agentFlows.runs.searchPlaceholder')} className="w-72" />
          <select value={status} onChange={(e) => setStatus(e.target.value)}
            className="h-8 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 text-caption">
            <option value="">{t('agentFlows.runs.allStatuses')}</option>
            {Object.keys(STATUS_LABEL_KEY).map((s) => <option key={s} value={s}>{t(STATUS_LABEL_KEY[s])}</option>)}
          </select>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}
            className="h-8 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 text-caption">
            <option value={24}>{t('agentFlows.runs.range.24h')}</option>
            <option value={168}>{t('agentFlows.runs.range.7d')}</option>
            <option value={720}>{t('agentFlows.runs.range.30d')}</option>
          </select>
          <label className="flex items-center gap-1.5 text-caption text-text-tertiary">
            <input type="checkbox" checked={includeTests}
              onChange={(e) => setIncludeTests(e.target.checked)} />
            {t('agentFlows.runs.includeTests')}
          </label>
        </div>
      </div>

      {/* left: history · middle: the flow as it ran · right: the chosen node */}
      <div className="flex min-h-0 flex-1">
        {/* CARDS, NOT A TABLE.
            A 360px column cannot carry four aligned columns: every cell truncates
            and the question — the only thing that identifies a run to a person —
            truncates worst. A card gives the question the full width and puts the
            rest on one quiet line under it. */}
        <div className="w-[360px] flex-shrink-0 space-y-1.5 overflow-auto border-r border-[rgb(var(--border-line))] p-2">
          {rows.map((r) => {
            const active = detail?.id === r.id;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => open(r)}
                className={cn(
                  'w-full rounded-lg border px-2.5 py-2 text-left transition',
                  active
                    ? 'border-brand/40 bg-brand/5'
                    : 'border-[rgb(var(--border-line))] bg-surface-1 hover:bg-surface-2',
                )}
              >
                <div className="flex items-start gap-2">
                  <span className={cn('mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full',
                    r.status === 'ok' ? 'bg-success'
                      : r.status === 'partial' || r.status === 'throttled' ? 'bg-warning'
                      : 'bg-danger')} />
                  <span className="line-clamp-2 flex-1 text-caption leading-snug text-text-secondary">
                    {r.question || t('agentFlows.common.none')}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 pl-3.5 text-tiny text-text-quaternary">
                  <span>{formatWhen(r.at, locale)}</span>
                  {r.latency_ms != null && <span>{(r.latency_ms / 1000).toFixed(1)}s</span>}
                  {r.status !== 'ok' && (
                    <Badge variant={STATUS_TONE[r.status] || 'neutral'} size="xs">
                      {STATUS_LABEL_KEY[r.status] ? t(STATUS_LABEL_KEY[r.status]) : r.status}
                    </Badge>
                  )}
                  {r.execution_path && (
                    <span className="truncate">· {r.execution_path}</span>
                  )}
                </div>
              </button>
            );
          })}
          {!rows.length && !loading && (
            <p className="px-3 py-10 text-center text-caption text-text-tertiary">
              {t('agentFlows.runs.empty')}
            </p>
          )}
          {/* A LINKED RUN THAT THE FILTERS HIDE.
              Opening `?run=…` loads the run whatever the filters say — a link
              must not depend on the recipient's filter settings. But an empty
              list beside a fully populated run reads as a broken screen, so the
              mismatch is named, with the one control that resolves it. */}
          {!!detail && !rows.some((r) => r.id === detail.id) && !loading && (
            <p className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-2 text-tiny leading-5 text-text-tertiary">
              Đang xem run #{detail.id} mở từ đường dẫn. Nó không nằm trong danh
              sách bên này vì bộ lọc hiện tại —{' '}
              {!includeTests && (
                <button type="button" onClick={() => setIncludeTests(true)}
                  className="underline underline-offset-2 hover:text-text-secondary">
                  bật “{t('agentFlows.runs.includeTests')}”
                </button>
              )}
              {!includeTests ? ' hoặc nới ' : 'thử nới '}khoảng thời gian.
            </p>
          )}
        </div>

        {/* MIDDLE — the same canvas the Design tab draws, with this run's
            outcome painted onto it. Reused rather than rebuilt: a second
            renderer would drift from the first, and the shape a person debugs
            must be the shape they authored. */}
        <div className="min-w-0 flex-1 overflow-auto bg-surface-2/30">
          {!detail ? (
            <p className="p-10 text-center text-caption text-text-tertiary">
              {t('agentFlows.runs.selectRun')}
            </p>
          ) : flowBody === null ? (
            <p className="p-10 text-center text-caption text-text-tertiary">Đang tải luồng…</p>
          ) : !flowBody.length ? (
            <p className="p-10 text-center text-caption text-text-tertiary">
              Không dựng được luồng của run này — bản v{detail.version} có thể đã bị xoá.
              Các bước vẫn xem được ở khung bên phải.
            </p>
          ) : (
            <div className="p-4">
              <FlowCanvas
                nodes={flowBody}
                specs={specs}
                selectedKey={openStep}
                answerKey={answerKey}
                onSelect={setOpenStep}
                // Read-only: a run is a record, not a place to edit the flow.
                onInsert={() => {}}
                running={runStatuses}
              />
            </div>
          )}
        </div>

        {/* RIGHT — the node clicked on the canvas. Falls back to the run's own
            summary when nothing is selected, so the pane is never blank while a
            run is open. */}
        <aside className="flex w-[420px] flex-shrink-0 flex-col overflow-auto border-l border-[rgb(var(--border-line))] bg-surface-1">
          {!detail ? (
            <p className="p-6 text-center text-caption text-text-tertiary">
              {t('agentFlows.runs.selectRun')}
            </p>
          ) : selectedStep ? (
            <>
              <div className="border-b border-[rgb(var(--border-line))] px-3 py-2.5">
                <div className="text-tiny font-strong uppercase tracking-wider text-text-quaternary">
                  Bước đã chọn
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <StepMark status={selectedStep.status} />
                  <b className="text-caption font-strong">
                    {selectedStep.name || selectedStep.key}
                  </b>
                  <div className="flex-1" />
                  <button type="button" onClick={() => setOpenStep(null)}
                    className="text-tiny text-text-tertiary hover:text-text-secondary">
                    ← Cả run
                  </button>
                </div>
                <div className="mt-1 text-tiny text-text-tertiary">
                  {selectedStep.type} · {selectedStep.ms ?? 0}ms
                  {selectedStep.status === 'reused' && t('agentFlows.runs.step.reused')}
                  {selectedStep.status === 'skipped' && t('agentFlows.runs.step.skipped')}
                </div>
                {selectedStep.error && (
                  <p className="mt-1.5 rounded border border-danger/25 bg-danger/5 p-1.5 text-tiny text-danger">
                    {selectedStep.error}
                  </p>
                )}
                {/* THE FAILURE THAT DOES NOT LOOK LIKE ONE.
                    A `{{name}}` nothing produces resolves to empty and the step
                    runs anyway — a Switch takes its fallback every time, an agent
                    prompt loses the sentence carrying the data, and an answer
                    still comes out. It is the likeliest reason a run reads as
                    Success while being wrong, so it sits above the tabs rather
                    than inside one. */}
                {!!selectedStep.unresolved_refs?.length && (
                  <div className="mt-1.5 rounded border border-warning/30 bg-warning/5 p-2">
                    <p className="text-tiny font-medium text-warning">
                      Bước này dùng biến không ai tạo ra:{' '}
                      {selectedStep.unresolved_refs.map((r) => `{{${r}}}`).join(', ')}
                    </p>
                    <p className="mt-0.5 text-tiny leading-5 text-text-tertiary">
                      Lúc chạy nó rỗng — bước vẫn chạy nhưng như thể không có dữ
                      liệu đó. Nếu đây là Switch/IF thì nó luôn rơi vào nhánh mặc
                      định; nếu là prompt thì model tự viết phần đó.
                    </p>
                  </div>
                )}
              </div>
              <StepInspector step={selectedStep} configSource={detail.config_source} />
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] bg-surface-2/40 px-3 py-2.5">
                <b className="text-caption font-strong">Run #{detail.id}</b>
                <Badge variant={STATUS_TONE[detail.status] || 'neutral'} size="xs">
                  {STATUS_LABEL_KEY[detail.status] ? t(STATUS_LABEL_KEY[detail.status]) : detail.status}
                </Badge>
                <div className="flex-1" />
                {detail.version != null && <Badge size="xs" variant="neutral">v{detail.version}</Badge>}
              </div>
              <div className="p-3">
                {/* Lifted to the top of the run summary: this is what somebody
                    who opened a run BECAUSE the answer looked wrong needs first.
                    Same detector as the builder's badge — it just was not on this
                    screen, which is the screen you reach for when debugging. */}
                {(() => {
                  const bad = detail.steps.filter((s) => s.unresolved_refs?.length);
                  if (!bad.length) return null;
                  return (
                    <div className="mb-2 rounded-md border border-warning/30 bg-warning/5 p-2">
                      <p className="text-tiny font-medium text-warning">
                        {bad.length} bước dùng biến không ai tạo ra
                      </p>
                      {bad.map((s) => (
                        <button
                          key={s.key}
                          type="button"
                          onClick={() => setOpenStep(s.key)}
                          className="mt-0.5 block text-left text-tiny text-text-secondary hover:underline"
                        >
                          · {s.name || s.key}: {s.unresolved_refs.map((r) => `{{${r}}}`).join(', ')}
                        </button>
                      ))}
                      <p className="mt-1 text-tiny leading-5 text-text-tertiary">
                        Những biến này rỗng lúc chạy. Đây là lý do phổ biến nhất
                        khiến một run ghi “Thành công” mà câu trả lời vẫn sai.
                      </p>
                    </div>
                  );
                })()}

                {/* The version this run used may be gone, in which case nothing
                    above could be checked — said out loud rather than shown as
                    an absence of warnings, which reads as "all clear". */}
                {detail.flow_warnings?.filter((w) => w.includes('Không còn bản')
                  || w.includes('không đọc được')).map((w, i) => (
                  <p key={i} className="mb-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 p-2 text-tiny leading-5 text-text-tertiary">
                    {w}
                  </p>
                ))}

                {/* WHY SOME NODES HAVE NO ROW. Without this the reader cannot
                    tell a branch nobody took from a step the executor lost. */}
                {!!detail.not_executed?.length && (
                  <details className="mb-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 p-2">
                    <summary className="cursor-pointer text-tiny text-text-tertiary">
                      {detail.not_executed.length} bước không chạy trong lượt này
                      {detail.not_executed.some((n) => !n.on_branch) && (
                        <span className="ml-1 text-warning">
                          · {detail.not_executed.filter((n) => !n.on_branch).length} nằm trên trục chính
                        </span>
                      )}
                    </summary>
                    {detail.not_executed.map((n) => (
                      <p key={n.key} className={cn('mt-1 text-tiny leading-5',
                        n.on_branch ? 'text-text-quaternary' : 'text-warning')}>
                        · {n.name} ({n.type}) —{' '}
                        {n.on_branch
                          ? 'nằm ở nhánh không được chọn, không chạy là đúng'
                          : 'nằm trên trục chính mà không có bản ghi — cần xem lại'}
                      </p>
                    ))}
                  </details>
                )}

                <p className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 p-2 text-tiny text-text-tertiary">
                  Bấm vào một bước trên sơ đồ để xem nó nhận gì, trả ra gì và chạy
                  với cấu hình nào.
                </p>

                <Label className="mt-3">{t('agentFlows.runs.question')}</Label>
                <p className="mt-1 text-caption text-text-secondary">
                  {detail.question || t('agentFlows.common.none')}
                </p>

                {!!detail.notices.length && (
                  <>
                    <Label className="mt-3">{t('agentFlows.runs.viewerNotes')}</Label>
                    {detail.notices.map((n, i) => (
                      <p key={i} className="mt-1 rounded-md border border-warning/20 bg-warning/5 p-2 text-tiny text-warning">
                        {n.text}
                      </p>
                    ))}
                  </>
                )}

                <Label className="mt-3">{t('agentFlows.runs.answer')}</Label>
                <p className="mt-1 whitespace-pre-wrap text-caption leading-relaxed text-text-secondary">
                  {detail.answer || t('agentFlows.common.none')}
                </p>

                <Label className="mt-3">{t('agentFlows.runs.cost')}</Label>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-2">
                  <Money label="Vào" value={detail.usage.prompt_tokens} unit="token" />
                  <Money label="Ra" value={detail.usage.completion_tokens} unit="token" />
                  <Money label="Model" value={detail.usage.llm_calls} unit="lượt" />
                  <Money label="Tool" value={detail.usage.tool_calls} unit="lượt" />
                  {/* Cost LAST and separately: it is the number an operator is
                      accountable for, and `null` says the provider did not
                      report a price rather than pretending the turn was free. */}
                  <span className="ml-auto text-caption">
                    {detail.usage.usd != null ? (
                      <b className="font-strong">${detail.usage.usd.toFixed(4)}</b>
                    ) : (
                      <span className="text-tiny text-text-quaternary">chưa có giá</span>
                    )}
                  </span>
                </div>

                {/* The step list stays, as a way IN to the canvas: on a long flow
                    finding the one red node by eye is worse than reading a list,
                    and both select the same thing. */}
                {/* The whole run as a file. Previews are trimmed on the server,
                    so this is also the honest way to hand a run to somebody
                    else — a screenshot of a truncated panel is not evidence. */}
                <div className="mt-3 flex items-baseline justify-between">
                  <Label>{t('agentFlows.runs.steps')}</Label>
                  <button
                    type="button"
                    onClick={() => download(`run-${detail.id}.json`, detail)}
                    className="text-tiny text-text-quaternary underline-offset-2 hover:underline"
                  >
                    Tải JSON cả run
                  </button>
                </div>
                <div className="mt-1 overflow-hidden rounded-lg border border-[rgb(var(--border-line))]">
                  {detail.steps.map((s) => {
                    const tok = (s.prompt_tokens ?? 0) + (s.completion_tokens ?? 0);
                    return (
                      <button
                        key={`${s.seq}-${s.key}`}
                        type="button"
                        onClick={() => setOpenStep(s.key)}
                        className="flex w-full items-start gap-2 border-t border-[rgb(var(--border-line))] p-2 text-left transition first:border-t-0 hover:bg-surface-2"
                      >
                        <StepMark status={s.status} />
                        <div className="min-w-0 flex-1">
                          <b className="block text-tiny font-medium">{s.name || s.key}</b>
                          <span className="block text-tiny text-text-tertiary">
                            {s.type} · {s.ms ?? 0}ms
                            {s.prompt_tokens != null && ` · ${tok.toLocaleString()} token`}
                            {!!s.tool_calls?.length && ` · ${s.tool_calls.length} tool`}
                          </span>
                          {s.error && <span className="block text-tiny text-danger">{s.error}</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/** One step, opened up: what it ran with, what it got, what it produced.
 *
 *  INPUT and OUTPUT sit next to each other on purpose. With only the output, a
 *  step that answered badly and a step that was handed nothing to answer from
 *  look identical — and those need opposite fixes, which is the whole reason a
 *  person opens a run.
 *
 *  CONFIG is the settings of the version that RAN, not the flow's current ones.
 *  Labelled with the version so nobody debugs yesterday's result against today's
 *  settings. */
function StepInspector({ step, configSource }: { step: RunStep; configSource?: string }) {
  const [tab, setTab] = React.useState<'config' | 'input' | 'output'>('input');
  const tok = (step.prompt_tokens ?? 0) + (step.completion_tokens ?? 0);

  return (
    <div className="border-t border-[rgb(var(--border-line))] bg-surface-2/50 px-2 pb-2">
      <div className="flex flex-wrap items-center gap-1 py-1.5">
        {([
          ['input', 'INPUT'],
          ['output', 'OUTPUT'],
          ['config', 'Cấu hình'],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn(
              'rounded px-2 py-0.5 text-tiny transition',
              tab === k ? 'bg-surface-1 font-medium shadow-sm' : 'text-text-tertiary hover:text-text-secondary',
            )}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2 text-tiny text-text-quaternary">
          {step.prompt_tokens != null ? (
            <>
              <span>vào {(step.prompt_tokens ?? 0).toLocaleString()}</span>
              <span>ra {(step.completion_tokens ?? 0).toLocaleString()}</span>
              <b className="text-text-tertiary">{tok.toLocaleString()} token</b>
            </>
          ) : (
            // NULL is not zero. A run recorded before per-step accounting genuinely
            // does not know its cost, and "0" would claim the step was free.
            <span>chưa ghi token cho run này</span>
          )}
        </span>
      </div>

      {/* NULL IS NOT "NOTHING". A run recorded before inputs were captured
          returns `null`; a run that genuinely had no variables returns the
          server's own "(chưa có biến nào)". Showing one message for both would
          state a fact about the STEP when the truth is about the RECORD — the
          same lie as printing 0 tokens for a run that never measured them. */}
      {tab === 'input' && (
        <ValueView
          filename={`buoc-${step.key}-input.json`}
          raw={step.input}
          empty={step.input === null
            ? 'Run này chạy trước khi hệ thống ghi INPUT — không có dữ liệu, chứ không phải bước này không đọc gì.'
            : 'Bước này không đọc biến nào — nó chạy chỉ với câu hỏi của người xem.'}
        />
      )}

      {tab === 'output' && (
        <>
          <ValueView
            filename={`buoc-${step.key}-output.json`}
            raw={step.preview}
            empty={step.status === 'skipped'
              ? 'Bước này bị bỏ qua nên không tạo ra kết quả.'
              : 'Bước này không tạo ra kết quả nào.'}
          />
          {!!step.tool_calls?.length && (
            <div className="mt-1.5">
              <div className="mb-1 text-tiny font-strong uppercase tracking-wider text-text-quaternary">
                Công cụ đã gọi ({step.tool_calls.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {step.tool_calls.map((name, i) => (
                  <span key={`${name}-${i}`}
                    className="rounded bg-surface-1 px-1.5 py-0.5 font-mono text-tiny text-text-secondary">
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'config' && (
        <>
          <p className="mb-1 text-tiny text-text-quaternary">
            {configSource?.startsWith('v')
              ? `Cấu hình của bản ${configSource} — đúng bản đã chạy run này, không phải bản hiện tại.`
              : (configSource || 'Không đọc được cấu hình của bản đã chạy.')}
          </p>
          <ValueView
            filename={`buoc-${step.key}-cauhinh.json`}
            raw={step.config ? JSON.stringify(step.config) : null}
            empty="Không còn cấu hình cho bước này — bản flow đã chạy có thể đã bị xoá."
          />
        </>
      )}
    </div>
  );
}

/** Monospace block that says WHY it is empty instead of showing nothing.
 *  A blank panel reads as "the screen is broken"; a sentence reads as data. */
function Pre({ children, empty }: { children: React.ReactNode; empty: string }) {
  const text = typeof children === 'string' ? children.trim() : children;
  if (!text) {
    return <p className="rounded bg-surface-1 p-2 text-tiny italic text-text-quaternary">{empty}</p>;
  }
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-1 p-2 font-mono text-tiny leading-5 text-text-secondary">
      {text}
    </pre>
  );
}

/* ── Reading a value without being a programmer ────────────────────────────────
 *
 * The server records a step's input and output as JSON. Printing that JSON is
 * honest but not legible: the person who opens a run to ask "why did the bot say
 * that" is usually the person who owns the report, not the person who wrote the
 * flow, and `{"charts":[{"chart_id":41,…` tells them nothing.
 *
 * So the same data is rendered by shape — a table as a table, an object as
 * labelled fields, a list as a list — with the raw JSON kept one click away
 * rather than removed, because the person debugging the flow needs exactly the
 * thing the report owner does not. Download is the third door: previews are
 * trimmed on the server, and a file is what you attach to a bug report. */

/** True for `[{a,b},{a,b}]` and for `{columns:[…],rows:[[…]]}` — the two shapes
 *  a step's data actually arrives in. Anything else is not forced into a grid. */
function asTable(v: unknown): { columns: string[]; rows: unknown[][] } | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.columns) && Array.isArray(o.rows) && o.rows.length) {
      const columns = o.columns.map(String);
      // `rows` is USUALLY a list of arrays, but the same envelope is also
      // produced with a list of objects, and one node's shape reached the panel
      // as neither. Rendering assumed arrays and threw, taking the whole
      // inspector down with it — so each row is normalised here, and anything
      // that is not a row drops the table rather than the screen.
      const rows: unknown[][] = [];
      for (const r of o.rows) {
        if (Array.isArray(r)) rows.push(r);
        else if (r && typeof r === 'object') {
          rows.push(columns.map((c) => (r as Record<string, unknown>)[c]));
        } else return null;
      }
      return { columns, rows };
    }
    return null;
  }
  if (!Array.isArray(v) || v.length === 0 || v.length > 200) return null;
  const objs = v.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
  if (objs.length !== v.length) return null;
  const cols = Object.keys(objs[0] as object);
  if (!cols.length || cols.length > 12) return null;
  // Uniform keys only. A ragged list rendered as a grid invents blank cells that
  // look like missing data.
  const uniform = objs.every((r) => {
    const k = Object.keys(r as object);
    return k.length === cols.length && k.every((n) => cols.includes(n));
  });
  if (!uniform) return null;
  return {
    columns: cols,
    rows: objs.map((r) => cols.map((c) => (r as Record<string, unknown>)[c])),
  };
}

function Scalar({ v }: { v: unknown }) {
  if (v === null || v === undefined || v === '') {
    return <span className="text-tiny italic text-text-quaternary">(trống)</span>;
  }
  if (typeof v === 'boolean') {
    return <span className="text-tiny text-text-secondary">{v ? 'có' : 'không'}</span>;
  }
  return (
    <span className="whitespace-pre-wrap break-words text-tiny leading-5 text-text-secondary">
      {String(v)}
    </span>
  );
}

function Value({ v, depth = 0 }: { v: unknown; depth?: number }) {
  const table = asTable(v);
  if (table) {
    return (
      <div className="overflow-x-auto rounded border border-[rgb(var(--border-line))]">
        <table className="w-full border-collapse text-tiny">
          <thead>
            <tr className="bg-surface-2">
              {table.columns.map((c) => (
                <th key={c} className="whitespace-nowrap px-2 py-1 text-left font-medium text-text-tertiary">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.slice(0, 50).map((r, i) => (
              <tr key={i} className="border-t border-[rgb(var(--border-line))]">
                {r.map((cell, j) => (
                  <td key={j} className="px-2 py-1 align-top tabular-nums text-text-secondary">
                    {typeof cell === 'object' && cell !== null
                      ? <Value v={cell} depth={depth + 1} />
                      : <Scalar v={cell} />}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {table.rows.length > 50 && (
          <p className="px-2 py-1 text-tiny text-text-quaternary">
            còn {table.rows.length - 50} dòng nữa — tải JSON để xem đủ
          </p>
        )}
      </div>
    );
  }

  if (Array.isArray(v)) {
    if (!v.length) return <span className="text-tiny italic text-text-quaternary">(danh sách rỗng)</span>;
    return (
      <ul className="space-y-1">
        {v.slice(0, 30).map((item, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="select-none text-tiny tabular-nums text-text-quaternary">{i + 1}.</span>
            <div className="min-w-0 flex-1"><Value v={item} depth={depth + 1} /></div>
          </li>
        ))}
        {v.length > 30 && (
          <li className="text-tiny text-text-quaternary">còn {v.length - 30} mục nữa</li>
        )}
      </ul>
    );
  }

  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length) return <span className="text-tiny italic text-text-quaternary">(trống)</span>;
    return (
      <div className={cn('space-y-1', depth > 0 && 'border-l border-[rgb(var(--border-line))] pl-2')}>
        {entries.map(([k, val]) => {
          const nested = val && typeof val === 'object';
          // Nested objects fold shut past the first level. Everything expanded
          // reproduces the wall of JSON this view exists to replace.
          if (nested && depth >= 1) {
            return (
              <details key={k}>
                <summary className="cursor-pointer text-tiny text-text-tertiary">{k}</summary>
                <div className="mt-1"><Value v={val} depth={depth + 1} /></div>
              </details>
            );
          }
          return (
            <div key={k} className={nested ? '' : 'flex flex-wrap items-baseline gap-x-2'}>
              <span className="text-tiny font-medium text-text-tertiary">{k}</span>
              <div className={nested ? 'mt-0.5' : 'min-w-0 flex-1'}>
                {nested ? <Value v={val} depth={depth + 1} /> : <Scalar v={val} />}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return <Scalar v={v} />;
}

function download(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** A recorded value: rendered by shape, with the raw JSON and a download behind
 *  a toggle. Falls back to plain text for anything that is not JSON — an agent's
 *  answer is prose, and runs recorded before this used `repr()`. */
function ValueView({
  raw, empty, filename,
}: { raw: string | null | undefined; empty: string; filename: string }) {
  const [showRaw, setShowRaw] = React.useState(false);
  const text = (raw ?? '').trim();

  const parsed = React.useMemo(() => {
    if (!text || (text[0] !== '{' && text[0] !== '[')) return undefined;
    try { return JSON.parse(text) as unknown; } catch { return undefined; }
  }, [text]);

  if (!text) {
    return <p className="rounded bg-surface-1 p-2 text-tiny italic text-text-quaternary">{empty}</p>;
  }
  if (parsed === undefined) return <Pre empty={empty}>{text}</Pre>;

  // The input snapshot has a known envelope: an optional human sentence, the
  // named variables, and earlier steps' results. Split so the reader sees WHY
  // before WHAT, and so `{{name}}` and `{{outputs.key}}` stay distinguishable —
  // they are typed differently in a prompt.
  const env = parsed as Record<string, unknown>;
  const isInput = !!env && typeof env === 'object' && !Array.isArray(env)
    && ('vars' in env || 'outputs' in env);
  const vars = (env?.vars ?? {}) as Record<string, unknown>;
  const outs = (env?.outputs ?? {}) as Record<string, unknown>;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setShowRaw((s) => !s)}
          className="text-tiny text-text-quaternary underline-offset-2 hover:underline">
          {showRaw ? 'Xem dạng dễ đọc' : 'Xem JSON gốc'}
        </button>
        <button type="button" onClick={() => download(filename, parsed)}
          className="text-tiny text-text-quaternary underline-offset-2 hover:underline">
          Tải JSON
        </button>
      </div>

      {showRaw ? (
        <Pre empty={empty}>{JSON.stringify(parsed, null, 2)}</Pre>
      ) : isInput ? (
        <div className="space-y-2">
          {typeof env.note === 'string' && (
            <p className="rounded border border-[rgb(var(--border-line))] bg-surface-2 p-2 text-tiny leading-5 text-text-tertiary">
              {env.note}
            </p>
          )}
          {!Object.keys(vars).length && !Object.keys(outs).length && (
            <p className="rounded bg-surface-1 p-2 text-tiny italic text-text-quaternary">{empty}</p>
          )}
          {!!Object.keys(vars).length && (
            <section>
              <h4 className="mb-1 text-tiny font-strong uppercase tracking-wider text-text-quaternary">
                Biến đã đặt tên
              </h4>
              <div className="rounded bg-surface-1 p-2"><Value v={vars} /></div>
            </section>
          )}
          {!!Object.keys(outs).length && (
            <section>
              <h4 className="mb-1 text-tiny font-strong uppercase tracking-wider text-text-quaternary">
                Kết quả của các bước trước
              </h4>
              <div className="rounded bg-surface-1 p-2"><Value v={outs} /></div>
            </section>
          )}
        </div>
      ) : (
        <div className="max-h-80 overflow-auto rounded bg-surface-1 p-2"><Value v={parsed} /></div>
      )}
    </div>
  );
}

function Money({ label, value, unit }: { label: string; value: number | null; unit: string }) {
  return (
    <span className="text-tiny text-text-tertiary">
      {label} <b className="text-caption font-medium text-text-secondary">
        {(value ?? 0).toLocaleString()}
      </b> {unit}
    </span>
  );
}

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <strong className="text-body font-strong">{value}</strong>
      <span className="text-tiny uppercase tracking-wide text-text-tertiary">{label}</span>
    </div>
  );
}

function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('text-tiny font-strong uppercase tracking-wider text-text-quaternary', className)}>
      {children}
    </div>
  );
}

function StepMark({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    ok: ['bg-success/10 text-success', '✓'],
    reused: ['bg-info/10 text-info', '↺'],
    skipped: ['bg-surface-2 text-text-quaternary', '–'],
    error: ['bg-danger/10 text-danger', '×'],
    blocked: ['bg-danger/10 text-danger', '!'],
  };
  const [tone, glyph] = map[status] || map.ok;
  return (
    <span className={cn('flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-tiny', tone)}>
      {glyph}
    </span>
  );
}
