'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Sparkles, X } from 'lucide-react';
import type { PublicLinkAiCatalog, PublisherGuide } from '@/types/api';
import { Input } from '@/components/ui/Input';
import { dashboardApi } from '@/lib/api/dashboards';

// The publisher's structured guide for a link's AI Bot (docs/features/public-bot-trust-guide).
// Each section has ONE use - and what code can do, code does: a defined term is answered
// with its definition (no model), a target is compared by code beside the system's figure,
// a cause is only taken from the cause-source charts, an out-of-scope topic is refused.
// Fields and charts are picked from the catalog the bot itself reads for this link.

type Rows<T> = (T & { _k: number })[];

const AREA = 'w-full resize-y rounded-md border border-stroke-strong bg-surface-1 px-2.5 py-1.5 text-caption '
  + 'text-text-primary placeholder:text-text-quaternary focus:border-brand focus:outline-none';
const SELECT = 'h-8 w-full rounded-md border border-stroke-strong bg-surface-1 px-2 text-caption text-text-primary';

let seq = 0;
const keyed = <T,>(items: T[] | undefined): Rows<T> => (items || []).map((it) => ({ ...it, _k: ++seq }));
const plain = <T,>(rows: Rows<T>): T[] => rows.map(({ _k, ...rest }) => rest as unknown as T);

function Section({ title, hint, children, testId }: {
  title: string; hint: string; children: React.ReactNode; testId: string;
}) {
  return (
    <section className="space-y-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3" data-testid={testId}>
      <div>
        <p className="text-tiny font-strong text-text-secondary">{title}</p>
        <p className="text-tiny leading-5 text-text-tertiary">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function AddRow({ onClick, label, testId }: { onClick: () => void; label: string; testId: string }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId}
            className="inline-flex items-center gap-1 text-tiny font-emphasis text-text-link hover:underline">
      <Plus className="h-3 w-3" aria-hidden="true" />{label}
    </button>
  );
}

function Remove({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Xoá dòng"
            className="mt-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-surface-2 hover:text-text-primary">
      <X className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

export function PublisherGuideEditor({ value, onChange, dashboardId, linkId }: {
  value: PublisherGuide | null | undefined;
  onChange: (guide: PublisherGuide | null) => void;
  dashboardId: number;
  /** Null while the link is still being created: the pickers need the link's catalog. */
  linkId: number | null;
}) {
  const [catalog, setCatalog] = useState<PublicLinkAiCatalog | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const loadCatalog = () => {
    if (!linkId) return;
    setCatalogError(false);
    dashboardApi.getPublicLinkAiCatalog(dashboardId, linkId)
      .then(setCatalog)
      .catch(() => setCatalogError(true));
  };
  useEffect(loadCatalog, [dashboardId, linkId]); // eslint-disable-line react-hooks/exhaustive-deps

  // rows being typed live here; only complete rows go up to the form (a half-typed row
  // must not make the save fail)
  const v = value || {};
  const [ctx, setCtx] = useState(v.context || {});
  const [glossary, setGlossary] = useState(() => keyed(v.glossary));
  const [definitions, setDefinitions] = useState(() => keyed((v.definitions || []).map((d) => ({
    ...d, aliasesText: (d.aliases || []).join(', ') }))));
  const [targets, setTargets] = useState(() => keyed((v.targets || []).map((t) => ({ ...t, valueText: String(t.value) }))));
  const [causes, setCauses] = useState(() => keyed(v.cause_sources));
  const [facts, setFacts] = useState(() => keyed(v.facts));
  const [style, setStyle] = useState(v.style || {});
  const [outOfScope, setOutOfScope] = useState(() => keyed(v.out_of_scope));

  const guide = useMemo<PublisherGuide | null>(() => {
    const g: PublisherGuide = {
      v: 1,
      context: Object.fromEntries(Object.entries(ctx).filter(([, s]) => String(s || '').trim())),
      glossary: plain(glossary).filter((r) => r.term?.trim() && r.ref),
      definitions: plain(definitions).filter((r) => r.name?.trim() && r.formula?.trim()).map(({ aliasesText, ...d }) => ({
        ...d, aliases: String(aliasesText || '').split(',').map((s) => s.trim()).filter(Boolean) })),
      targets: plain(targets).filter((r) => r.ref && r.valueText !== '' && Number.isFinite(Number(r.valueText)))
        .map(({ valueText, ...t }) => ({ ...t, value: Number(valueText) })),
      cause_sources: plain(causes).filter((r) => Number.isFinite(r.chart_id)),
      facts: plain(facts).filter((r) => r.title?.trim() && r.content?.trim()),
      style,
      out_of_scope: plain(outOfScope).filter((r) => r.topic?.trim()),
    };
    const empty = !Object.keys(g.context || {}).length && !g.glossary?.length && !g.definitions?.length
      && !g.targets?.length && !g.cause_sources?.length && !g.facts?.length && !g.out_of_scope?.length;
    return empty && !Object.keys(style).length ? null : g;
  }, [ctx, glossary, definitions, targets, causes, facts, style, outOfScope]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    onChange(guide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guide]);

  const fields = catalog?.fields || [];
  const measures = fields.filter((f) => f.kind === 'measure');
  const size = JSON.stringify(guide || {}).length;
  const suggestGlossary = () => {
    const have = new Set(glossary.map((g) => g.ref));
    setGlossary([...glossary, ...keyed(fields.filter((f) => !have.has(f.ref)).map((f) => ({ term: f.label, ref: f.ref })))]);
  };
  const fieldOptions = (list: typeof fields) => (
    <>
      <option value="">— Chọn trường —</option>
      {list.map((f) => <option key={f.ref} value={f.ref}>{f.label}{f.kind === 'measure' ? ' (chỉ số)' : ''}</option>)}
    </>
  );

  return (
    <div className="space-y-3" data-testid="ai-bot-guide">
      {!linkId && <p className="text-tiny text-text-tertiary">Lưu link để chọn trường và biểu đồ cho hướng dẫn.</p>}
      {linkId && catalogError && (
        <p className="text-tiny text-warning">
          Không tải được danh sách trường của báo cáo.{' '}
          <button type="button" className="text-text-link hover:underline" onClick={loadCatalog}>Thử lại</button>
        </p>
      )}
      {linkId && !catalog && !catalogError && <p className="text-tiny text-text-tertiary">Đang tải danh sách trường…</p>}
      {catalog && catalog.charts.length === 0 && (
        <p className="text-tiny text-warning">Báo cáo chưa có biểu đồ công khai nào cho trợ lý đọc.</p>
      )}

      <Section title="Bối cảnh" testId="guide-context"
               hint="Báo cáo dùng để làm gì, cho ai đọc, đơn vị tiền/đơn vị đo, kỳ báo cáo. Trợ lý dùng để định hướng câu trả lời.">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {([['purpose', 'Mục đích (vd: theo dõi doanh thu tháng)'], ['audience', 'Người đọc (vd: ban giám đốc)'],
             ['unit', 'Đơn vị (vd: tỷ VND)'], ['period_note', 'Kỳ (vd: số liệu theo tháng, kỳ hiện tại T08)']] as const)
            .map(([k, ph]) => (
              <Input key={k} value={(ctx as any)[k] || ''} placeholder={ph}
                     onChange={(e) => setCtx({ ...ctx, [k]: e.target.value })} data-testid={`guide-context-${k}`} />
            ))}
        </div>
      </Section>

      <Section title="Thuật ngữ" testId="guide-glossary"
               hint="Từ người xem hay dùng → trường trong báo cáo (vd: “hụt doanh thu” → Chênh lệch kế hoạch). Giúp hệ thống chọn đúng biểu đồ và chỉ số.">
        {glossary.map((r, i) => (
          <div key={r._k} className="flex items-start gap-2">
            <Input value={r.term} placeholder="Từ người xem dùng" className="flex-1"
                   onChange={(e) => setGlossary(glossary.map((x, j) => (j === i ? { ...x, term: e.target.value } : x)))} />
            <select className={`${SELECT} flex-1`} value={r.ref}
                    onChange={(e) => setGlossary(glossary.map((x, j) => (j === i ? { ...x, ref: e.target.value } : x)))}>
              {fieldOptions(fields)}
            </select>
            <Remove onClick={() => setGlossary(glossary.filter((_, j) => j !== i))} />
          </div>
        ))}
        <div className="flex gap-3">
          <AddRow label="Thêm thuật ngữ" testId="guide-glossary-add"
                  onClick={() => setGlossary([...glossary, ...keyed([{ term: '', ref: '' }])])} />
          {fields.length > 0 && (
            <button type="button" onClick={suggestGlossary} data-testid="guide-glossary-suggest"
                    className="inline-flex items-center gap-1 text-tiny font-emphasis text-text-link hover:underline">
              <Sparkles className="h-3 w-3" aria-hidden="true" />Gợi ý từ báo cáo
            </button>
          )}
        </div>
      </Section>

      <Section title="Định nghĩa & công thức" testId="guide-definitions"
               hint="Khi người xem hỏi “X là gì / tính thế nào”, trợ lý trả đúng nguyên văn phần này - không qua AI.">
        {definitions.map((r, i) => {
          const set = (patch: object) => setDefinitions(definitions.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          return (
            <div key={r._k} className="flex items-start gap-2">
              <div className="flex-1 space-y-1.5">
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  <Input value={r.name} placeholder="Tên (vd: Điểm KPI)" onChange={(e) => set({ name: e.target.value })} />
                  <Input value={r.aliasesText} placeholder="Tên khác, cách nhau bởi dấu phẩy"
                         onChange={(e) => set({ aliasesText: e.target.value })} />
                </div>
                <textarea className={AREA} rows={2} value={r.formula} placeholder="Công thức / định nghĩa"
                          onChange={(e) => set({ formula: e.target.value })} />
                <Input value={r.note || ''} placeholder="Ghi chú (tuỳ chọn)" onChange={(e) => set({ note: e.target.value })} />
              </div>
              <Remove onClick={() => setDefinitions(definitions.filter((_, j) => j !== i))} />
            </div>
          );
        })}
        <AddRow label="Thêm định nghĩa" testId="guide-definitions-add"
                onClick={() => setDefinitions([...definitions, ...keyed([{ name: '', aliasesText: '', formula: '', note: '' }])])} />
      </Section>

      <Section title="Mục tiêu / kế hoạch" testId="guide-targets"
               hint="Khi hệ thống trả lời con số của chỉ số này (đúng kỳ), nó tự tính “đạt bao nhiêu % / hụt bao nhiêu” bên cạnh - bằng code, không qua AI.">
        {targets.map((r, i) => {
          const set = (patch: object) => setTargets(targets.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          return (
            <div key={r._k} className="flex items-start gap-2">
              <div className="grid flex-1 grid-cols-2 gap-1.5 sm:grid-cols-4">
                <select className={`${SELECT} col-span-2`} value={r.ref} onChange={(e) => set({ ref: e.target.value })}>
                  {fieldOptions(measures)}
                </select>
                <Input value={r.period || ''} placeholder="Kỳ (vd: T08), trống = mọi kỳ"
                       onChange={(e) => set({ period: e.target.value })} />
                <Input value={r.valueText} placeholder="Giá trị mục tiêu" inputMode="decimal"
                       onChange={(e) => set({ valueText: e.target.value.replace(',', '.') })} />
              </div>
              <Remove onClick={() => setTargets(targets.filter((_, j) => j !== i))} />
            </div>
          );
        })}
        <AddRow label="Thêm mục tiêu" testId="guide-targets-add"
                onClick={() => setTargets([...targets, ...keyed([{ ref: '', period: '', valueText: '', value: 0 }])])} />
      </Section>

      <Section title="Nguồn nguyên nhân" testId="guide-causes"
               hint="Biểu đồ ghi lý do / hành động khắc phục. Trợ lý CHỈ nêu nguyên nhân có trong các biểu đồ này hoặc trong phần Chính sách; không có thì nói “chưa ghi nhận”.">
        {causes.map((r, i) => (
          <div key={r._k} className="flex items-start gap-2">
            <select className={`${SELECT} flex-1`} value={Number.isFinite(r.chart_id) ? String(r.chart_id) : ''}
                    onChange={(e) => setCauses(causes.map((x, j) => (j === i ? { ...x, chart_id: Number(e.target.value) } : x)))}>
              <option value="">— Chọn biểu đồ —</option>
              {(catalog?.charts || []).map((c) => <option key={c.chart_id} value={c.chart_id}>{c.name}</option>)}
            </select>
            <Remove onClick={() => setCauses(causes.filter((_, j) => j !== i))} />
          </div>
        ))}
        <AddRow label="Thêm biểu đồ nguồn" testId="guide-causes-add"
                onClick={() => setCauses([...causes, ...keyed([{ chart_id: Number.NaN }])])} />
      </Section>

      <Section title="Chính sách / kiến thức" testId="guide-facts"
               hint="Thông tin biểu đồ không có (chính sách, quy trình, bối cảnh kinh doanh). Trợ lý dùng để trả lời và ghi rõ là theo thông tin người xuất bản.">
        {facts.map((r, i) => {
          const set = (patch: object) => setFacts(facts.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          return (
            <div key={r._k} className="flex items-start gap-2">
              <div className="flex-1 space-y-1.5">
                <Input value={r.title} placeholder="Tiêu đề (vd: Chính sách đổi trả)" onChange={(e) => set({ title: e.target.value })} />
                <textarea className={AREA} rows={2} value={r.content} placeholder="Nội dung"
                          onChange={(e) => set({ content: e.target.value })} />
              </div>
              <Remove onClick={() => setFacts(facts.filter((_, j) => j !== i))} />
            </div>
          );
        })}
        <AddRow label="Thêm mục" testId="guide-facts-add" onClick={() => setFacts([...facts, ...keyed([{ title: '', content: '' }])])} />
      </Section>

      <Section title="Cách trả lời" testId="guide-style" hint="Độ dài, giọng và ngôn ngữ của phần phân tích.">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <select className={SELECT} value={style.length || 'normal'} onChange={(e) => setStyle({ ...style, length: e.target.value as any })}>
            <option value="short">Ngắn (1–3 ý)</option><option value="normal">Vừa (tối đa 6 ý)</option>
            <option value="detailed">Chi tiết (tối đa 10 ý)</option>
          </select>
          <select className={SELECT} value={style.tone || 'neutral'} onChange={(e) => setStyle({ ...style, tone: e.target.value as any })}>
            <option value="executive">Cho lãnh đạo (kết luận trước)</option><option value="operational">Vận hành (chi tiết hành động)</option>
            <option value="neutral">Trung tính</option>
          </select>
          <select className={SELECT} value={style.language || 'auto'} onChange={(e) => setStyle({ ...style, language: e.target.value as any })}>
            <option value="auto">Theo ngôn ngữ câu hỏi</option><option value="vi">Tiếng Việt</option><option value="en">English</option>
          </select>
        </div>
      </Section>

      <Section title="Ngoài phạm vi" testId="guide-out-of-scope"
               hint="Chủ đề trợ lý từ chối ngay (không gọi AI). Lưu ý: câu hỏi chứa đúng cụm từ này sẽ bị từ chối.">
        {outOfScope.map((r, i) => {
          const set = (patch: object) => setOutOfScope(outOfScope.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          return (
            <div key={r._k} className="flex items-start gap-2">
              <Input value={r.topic} placeholder="Chủ đề (vd: lương nhân viên)" className="flex-1" onChange={(e) => set({ topic: e.target.value })} />
              <Input value={r.reason || ''} placeholder="Lý do hiển thị cho người xem" className="flex-1"
                     onChange={(e) => set({ reason: e.target.value })} />
              <Remove onClick={() => setOutOfScope(outOfScope.filter((_, j) => j !== i))} />
            </div>
          );
        })}
        <AddRow label="Thêm chủ đề" testId="guide-out-of-scope-add"
                onClick={() => setOutOfScope([...outOfScope, ...keyed([{ topic: '', reason: '' }])])} />
      </Section>

      <p className="text-tiny text-text-tertiary" data-testid="guide-size">
        Kích thước hướng dẫn: {size.toLocaleString('vi-VN')} ký tự - được gửi kèm mỗi câu hỏi cần phân tích (tính vào chi phí AI của link).
      </p>
    </div>
  );
}
