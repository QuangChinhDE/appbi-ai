'use client';

/**
 * Assigning a flow to a public link — in three steps, and the third one can refuse.
 *
 * THE RULE THIS SCREEN IMPLEMENTS
 * -------------------------------
 * Define the data BEFORE assigning the flow. Not: assign it and let the runtime
 * work out what it may read.
 *
 * A flow declares what it NEEDS (`revenue`, `segments`, …) without knowing any
 * dashboard. This screen says what those mean HERE — which chart, which field —
 * plus which charts the bot may read at all, whether it may reach the web, and how
 * much one question may cost. `preflight` refuses while anything required is
 * unresolved, and until it passes there is no Assign button to press.
 *
 * Everything offered comes from the server, so the picker cannot suggest a field
 * this dashboard does not have — which is the exact failure the whole design exists
 * to prevent.
 */
import React from 'react';
import { AlertTriangle, Check, Loader2, Workflow } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import {
  bindingCandidates, deleteBinding, getBinding, listBrains, preflightBinding, saveBinding,
  type Binding, type BindingCandidates, type BrainSummary,
  type DataContract, type PreflightResult, type ResolveEntry,
} from '@/lib/agentFlows';

const DEFAULT_CONTRACT: DataContract = {
  charts: { mode: 'allowlist', ids: [] },
  resolve: {},
  knowledge: { mode: 'flow_all' },
  capabilities: { web_search: false, read_rows: true, max_rows_per_call: 5000 },
  defaults: {},
  budget: { max_llm_calls: 12, max_tool_calls: 40, max_seconds: 45 },
};

export function FlowBindingEditor({ linkId }: { linkId: number | null }) {
  const [loading, setLoading] = React.useState(true);
  const [flows, setFlows] = React.useState<BrainSummary[]>([]);
  const [binding, setBinding] = React.useState<Binding | null>(null);
  const [brainKey, setBrainKey] = React.useState('');
  const [contract, setContract] = React.useState<DataContract>(DEFAULT_CONTRACT);
  const [candidates, setCandidates] = React.useState<BindingCandidates | null>(null);
  const [check, setCheck] = React.useState<PreflightResult | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (linkId == null) { setLoading(false); return; }
    let alive = true;
    Promise.all([listBrains(), getBinding(linkId)])
      .then(([list, b]) => {
        if (!alive) return;
        // Only published flows can be assigned: a link pointing at a draft would be
        // running something nobody approved.
        setFlows(list.filter((f) => f.status === 'published'));
        setBinding(b);
        if (b) {
          setBrainKey(b.brain_key);
          setContract({ ...DEFAULT_CONTRACT, ...(b.data_contract || {}) });
        }
      })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [linkId]);

  React.useEffect(() => {
    if (linkId == null || !brainKey) { setCandidates(null); return; }
    bindingCandidates(linkId, brainKey).then(setCandidates).catch(() => setCandidates(null));
  }, [linkId, brainKey]);

  // Preflight runs as the mapping changes, so the author sees the gate move rather
  // than discovering it when they press the button.
  React.useEffect(() => {
    if (linkId == null || !brainKey) { setCheck(null); return; }
    const t = setTimeout(() => {
      preflightBinding({ link_id: linkId, brain_key: brainKey, data_contract: contract })
        .then(setCheck)
        .catch(() => setCheck(null));
    }, 300);
    return () => clearTimeout(t);
  }, [linkId, brainKey, contract]);

  if (linkId == null) {
    return (
      <p className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-tiny leading-5 text-text-tertiary">
        Lưu link này trước, rồi quay lại để gán Agent Flow và định nghĩa phạm vi dữ liệu.
      </p>
    );
  }
  if (loading) {
    return <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />;
  }

  const setResolve = (key: string, entry: ResolveEntry | null) => {
    setContract((c) => {
      const next = { ...c.resolve };
      if (entry) next[key] = entry; else delete next[key];
      return { ...c, resolve: next };
    });
  };

  const toggleChart = (id: number) => {
    setContract((c) => {
      const has = c.charts.ids.includes(id);
      return {
        ...c,
        charts: {
          mode: 'allowlist',
          ids: has ? c.charts.ids.filter((x) => x !== id) : [...c.charts.ids, id],
        },
      };
    });
  };

  const assign = async () => {
    setBusy(true);
    try {
      const res = await saveBinding({
        link_id: linkId, brain_key: brainKey, data_contract: contract,
      });
      toast.success('Đã gán flow và ghi nhận phạm vi dữ liệu');
      setBinding(await getBinding(linkId));
      setCheck(res);
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(detail || 'Gán thất bại');
    } finally { setBusy(false); }
  };

  const unassign = async () => {
    setBusy(true);
    try {
      await deleteBinding(linkId);
      setBinding(null); setBrainKey(''); setContract(DEFAULT_CONTRACT); setCheck(null);
      toast.success('Đã gỡ flow khỏi link');
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      {/* 1 — pick */}
      <Step n={1} title="Chọn Agent Flow">
        <select
          value={brainKey}
          onChange={(e) => setBrainKey(e.target.value)}
          className="h-8 w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 text-caption"
        >
          <option value="">— chưa chọn —</option>
          {flows.map((f) => (
            <option key={f.brain_key} value={f.brain_key}>{f.name}</option>
          ))}
        </select>
        {!flows.length && (
          <p className="mt-1.5 text-tiny text-text-tertiary">
            Chưa có flow nào được phát hành. Mở Agent Flows, dựng một flow rồi bấm Phát hành.
          </p>
        )}
        {binding?.status === 'needs_review' && (
          <p className="mt-2 rounded-lg border border-warning/30 bg-warning/5 px-2.5 py-2 text-tiny leading-5 text-warning">
            Link này được chuyển từ cấu hình cũ: bot vẫn chạy như trước, nhưng phạm
            vi dữ liệu <b>chưa được định nghĩa</b>. Cho tới khi bạn gán lại ở đây,
            link sẽ bị ghim ở phiên bản hiện tại và không nhận bản flow mới.
          </p>
        )}
      </Step>

      {/* 2 — define */}
      {brainKey && candidates && (
        <Step n={2} title="Định nghĩa dữ liệu link này cho phép đọc">
          <p className="mb-2 text-tiny leading-5 text-text-tertiary">
            Flow không biết báo cáo nào — bạn chỉ ra ở đây mỗi thứ nó cần ứng với
            cột nào trên báo cáo của link.
          </p>

          {candidates.requirements.items.map((req) => {
            const entry = contract.resolve[req.key];
            const chart = candidates.charts.find((c) => c.id === entry?.chart_id);
            const fields = req.kind === 'dimension'
              ? chart?.dimensions || []
              : chart?.measures || [];
            return (
              <div key={req.key} className="mt-2 rounded-lg border border-[rgb(var(--border-line))] p-2.5">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <b className="text-caption font-medium">{req.label || req.key}</b>
                  <Badge size="xs" variant="neutral">{req.kind}</Badge>
                  {req.required
                    ? <Badge size="xs" variant="danger">bắt buộc</Badge>
                    : <Badge size="xs" variant="neutral">tuỳ chọn</Badge>}
                </div>
                {req.hint && <p className="mb-1.5 text-tiny text-text-tertiary">{req.hint}</p>}
                <div className="grid grid-cols-2 gap-1.5">
                  <select
                    value={entry?.chart_id ?? ''}
                    onChange={(e) => {
                      const id = Number(e.target.value);
                      setResolve(req.key, id
                        ? { kind: req.kind === 'dimension' ? 'dimension' : 'measure', chart_id: id, field: '', label: req.label }
                        : null);
                    }}
                    className="h-8 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 text-tiny"
                  >
                    <option value="">— chọn biểu đồ —</option>
                    {candidates.charts.map((c) => (
                      <option key={c.id} value={c.id}>{c.title || `Chart ${c.id}`}</option>
                    ))}
                  </select>
                  <select
                    value={entry?.field || ''}
                    disabled={!entry?.chart_id}
                    onChange={(e) => setResolve(req.key, { ...(entry as ResolveEntry), field: e.target.value })}
                    className="h-8 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 text-tiny disabled:opacity-50"
                  >
                    <option value="">— chọn trường —</option>
                    {fields.map((f) => (
                      <option key={f.field} value={f.field}>{f.label || f.field}</option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })}

          <div className="mt-3">
            <b className="text-caption font-medium">Biểu đồ bot được đọc</b>
            <p className="mb-1.5 text-tiny text-text-tertiary">
              Chỉ những biểu đồ tick ở đây. Không tick gì thì bot không đọc được gì.
            </p>
            <div className="max-h-44 overflow-auto rounded-lg border border-[rgb(var(--border-line))] p-1.5">
              {candidates.charts.map((c) => (
                <label key={c.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-tiny hover:bg-surface-2">
                  <input
                    type="checkbox"
                    checked={contract.charts.ids.includes(c.id)}
                    onChange={() => toggleChart(c.id)}
                  />
                  <span className="truncate">{c.title || `Chart ${c.id}`}</span>
                </label>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setContract((ct) => ({
                ...ct, charts: { mode: 'allowlist', ids: candidates.charts.map((c) => c.id) },
              }))}
              className="mt-1 text-tiny text-brand hover:underline"
            >
              Chọn tất cả
            </button>
          </div>

          <label className="mt-3 flex items-center gap-2 text-caption">
            <input
              type="checkbox"
              checked={contract.capabilities.web_search}
              onChange={(e) => setContract((c) => ({
                ...c, capabilities: { ...c.capabilities, web_search: e.target.checked },
              }))}
            />
            Cho phép tra cứu web
            {candidates.flow_capabilities.web_search && !contract.capabilities.web_search && (
              <span className="text-tiny text-warning">(flow có bước web — tắt thì bước đó bị bỏ qua)</span>
            )}
          </label>
        </Step>
      )}

      {/* 3 — the gate */}
      {brainKey && (
        <Step n={3} title="Kiểm tra trước khi gán">
          {!check ? (
            <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
          ) : (
            <>
              {check.errors.map((e, i) => (
                <p key={i} className="mb-1.5 flex gap-1.5 rounded-lg border border-danger/25 bg-danger/5 p-2 text-tiny leading-5 text-danger">
                  <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" />{e.message}
                </p>
              ))}
              {check.warnings.map((w, i) => (
                <p key={i} className="mb-1.5 rounded-lg border border-warning/25 bg-warning/5 p-2 text-tiny leading-5 text-warning">
                  {w.message}
                </p>
              ))}
              {check.ok && !check.errors.length && (
                <p className="mb-1.5 flex items-center gap-1.5 text-tiny text-success">
                  <Check className="h-3.5 w-3.5" /> Đủ điều kiện để gán.
                </p>
              )}
              {/* The number the person approving this is committing to. A public
                  link has an unbounded audience and one Loop multiplies a single
                  question by up to 25 model calls. */}
              <p className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-2 text-tiny leading-5 text-text-secondary">
                Ước tính tối đa cho <b>một câu hỏi</b>: {check.estimate.max_llm_calls} lần
                gọi model, {check.estimate.max_tool_calls} lần gọi công cụ.
                {check.estimate.max_tool_calls > contract.budget.max_tool_calls && (
                  <span className="text-warning">
                    {' '}Vượt hạn mức {contract.budget.max_tool_calls} của link — flow sẽ bị
                    cắt giữa chừng và trả lời bằng những gì đã có.
                  </span>
                )}
              </p>

              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={assign} loading={busy} disabled={!check.ok}>
                  {binding ? 'Cập nhật gán' : 'Gán flow vào link'}
                </Button>
                {binding && (
                  <Button variant="secondary" size="sm" onClick={unassign} loading={busy}>
                    Gỡ
                  </Button>
                )}
              </div>
            </>
          )}
        </Step>
      )}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand/10 text-tiny font-strong text-brand">
          {n}
        </span>
        <b className="text-caption font-strong">{title}</b>
      </div>
      {children}
    </div>
  );
}
