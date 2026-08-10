'use client';

/**
 * The inspector: everything about one node, and nothing about any other.
 *
 * TWO THINGS THAT ARE PROPERTIES HERE AND NOT NODES IN THE PALETTE
 * ---------------------------------------------------------------
 * `retry` and `on_error`. A "Retry node" has to name what it retries, which is a
 * second recording of the graph and a second thing to keep in step with the first.
 * Every node carries them, and this is where an author looks for them anyway.
 *
 * WHY `run_policy` IS A VISIBLE CONTROL
 * ------------------------------------
 * Reuse across turns could have been inferred ("the variable already has a value,
 * so skip"). That is control flow which never appears on the canvas and can only be
 * debugged by guessing. It is a setting, it is shown as a pill on the card, and the
 * trace records `reused` when it fires.
 */
import React from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { Input, Textarea } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import {
  MAX_LOOP_ITERATIONS, MAX_TOOL_CALLS,
  type Condition, type ConditionOp, type FlowNode, type FlowPath,
  type NodeSpec, type ProviderGroup, type SwitchCase, type ToolPack,
} from '@/lib/agentFlows';
import { SectionTitle, HintText } from './shared';

const OPS: { value: ConditionOp; label: string }[] = [
  { value: 'contains', label: 'chứa' },
  { value: 'not_contains', label: 'không chứa' },
  { value: 'equals', label: 'bằng' },
  { value: 'not_equals', label: 'khác' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'is_empty', label: 'rỗng' },
  { value: 'is_not_empty', label: 'không rỗng' },
  { value: 'matches', label: 'khớp regex' },
  { value: 'in_list', label: 'nằm trong' },
];

const RUN_POLICY: { value: string; label: string; hint: string }[] = [
  { value: 'every_turn', label: 'Mỗi lượt hỏi', hint: 'Chạy lại cho mọi câu hỏi.' },
  { value: 'when_stale', label: 'Khi dữ liệu đổi', hint: 'Chỉ chạy lại khi filter/cấu hình đổi — rẻ nhất cho bước đọc báo cáo.' },
  { value: 'once_per_session', label: 'Một lần mỗi phiên', hint: 'Chạy lần đầu, các lượt sau dùng lại kết quả.' },
];

const CONTEXT_POLICY: { value: string; label: string }[] = [
  { value: 'none', label: 'Không gửi hội thoại' },
  { value: 'question', label: 'Chỉ câu hỏi hiện tại' },
  { value: 'last_3', label: '3 lượt gần nhất' },
  { value: 'full', label: 'Toàn bộ hội thoại' },
];

function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 first:mt-0">
      <label className="mb-1 block text-caption font-medium text-text-secondary">{label}</label>
      {hint && <p className="mb-1 text-tiny leading-snug text-text-tertiary">{hint}</p>}
      {children}
    </div>
  );
}

function Select({
  value, onChange, options, className,
}: {
  value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'h-8 w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 text-caption text-text-primary outline-none focus:border-brand',
        className,
      )}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function Toggle({
  on, onChange, title, hint,
}: { on: boolean; onChange: (v: boolean) => void; title: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2 border-t border-[rgb(var(--border-line))] py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <b className="block text-caption font-medium">{title}</b>
        {hint && <span className="mt-px block text-tiny text-text-tertiary">{hint}</span>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        className={cn(
          'h-[18px] w-[34px] flex-shrink-0 rounded-full p-0.5 transition',
          on ? 'bg-brand' : 'bg-surface-3',
        )}
      >
        <span
          className={cn(
            'block h-[14px] w-[14px] rounded-full bg-white shadow-linear-sm transition',
            on && 'translate-x-4',
          )}
        />
      </button>
    </div>
  );
}

function ConditionRows({
  conditions, onChange,
}: { conditions: Condition[]; onChange: (next: Condition[]) => void }) {
  const set = (i: number, patch: Partial<Condition>) =>
    onChange(conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  return (
    <div>
      {conditions.map((c, i) => {
        const unary = c.op === 'is_empty' || c.op === 'is_not_empty';
        return (
          <div key={i} className="mt-1.5 grid grid-cols-[1.2fr_0.8fr_1fr_28px] gap-1.5 first:mt-0">
            <Input value={c.left} onChange={(e) => set(i, { left: e.target.value })}
              placeholder="{{available_metrics}}" className="h-8 text-tiny" />
            <Select value={c.op} onChange={(v) => set(i, { op: v as ConditionOp })} options={OPS} />
            <Input
              value={c.right || ''}
              disabled={unary}
              onChange={(e) => set(i, { right: e.target.value })}
              placeholder={unary ? '—' : 'giá trị'}
              className="h-8 text-tiny"
            />
            <button
              type="button"
              onClick={() => onChange(conditions.filter((_, idx) => idx !== i))}
              className="rounded-md text-text-tertiary hover:bg-surface-2 hover:text-danger"
              aria-label="Xoá điều kiện"
            >
              <Trash2 className="mx-auto h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      <Button
        variant="secondary" size="xs" className="mt-2"
        onClick={() => onChange([...conditions, { left: '', op: 'equals', right: '' }])}
      >
        <Plus className="h-3 w-3" /> Thêm điều kiện
      </Button>
      <HintText>
        Vế trái thường là một biến — gõ <code>{'{{tên_biến}}'}</code>. Với danh sách,
        “chứa” khớp cả tên field đầy đủ (ví dụ <code>revenue</code> khớp{' '}
        <code>bảng.total_revenue</code>).
      </HintText>
    </div>
  );
}

export interface InspectorProps {
  node: FlowNode | null;
  /** Set when the selection is a branch lane rather than a node. */
  path?: FlowPath | null;
  switchCase?: SwitchCase | null;
  isFallback?: boolean;
  spec?: NodeSpec;
  specs: Record<string, NodeSpec>;
  toolPacks: ToolPack[];
  providers: ProviderGroup[];
  isAnswerNode: boolean;
  onChange: (next: FlowNode) => void;
  onChangePath: (next: FlowPath) => void;
  onChangeCase: (next: SwitchCase) => void;
  onDelete: () => void;
  onMakeAnswer: () => void;
}

export function NodeInspector(props: InspectorProps) {
  const { node, path, switchCase, isFallback } = props;

  if (path) return <PathForm path={path} onChange={props.onChangePath} />;
  if (switchCase) return <CaseForm item={switchCase} onChange={props.onChangeCase} />;
  if (isFallback) {
    return (
      <div className="p-3">
        <SectionTitle>Nhánh dự phòng</SectionTitle>
        <HintText>
          Chạy khi không case nào khớp. Không có điều kiện để sửa — tắt nó ở phần
          cấu hình của bước Switch.
        </HintText>
      </div>
    );
  }
  if (!node) {
    return (
      <div className="p-6 text-center text-caption text-text-tertiary">
        Chọn một bước trên canvas để cấu hình.
      </div>
    );
  }
  return <NodeForm {...props} node={node} />;
}

function PathForm({ path, onChange }: { path: FlowPath; onChange: (p: FlowPath) => void }) {
  return (
    <div className="p-3">
      <Field label="Tên nhánh">
        <Input value={path.name || ''} onChange={(e) => onChange({ ...path, name: e.target.value })} />
      </Field>
      <Field
        label="Loại nhánh"
        hint="Fallback chỉ chạy khi không nhánh nào phía trên khớp. Mỗi IF chỉ được một."
      >
        <Select
          value={path.kind}
          onChange={(v) => onChange({ ...path, kind: v as FlowPath['kind'] })}
          options={[
            { value: 'rules', label: 'Theo điều kiện' },
            { value: 'always', label: 'Luôn chạy' },
            { value: 'fallback', label: 'Dự phòng' },
          ]}
        />
      </Field>
      {path.kind === 'rules' && (
        <>
          <Field label="Cách khớp">
            <Select
              value={path.match || 'all'}
              onChange={(v) => onChange({ ...path, match: v as 'all' | 'any' })}
              options={[{ value: 'all', label: 'Khớp TẤT CẢ điều kiện' }, { value: 'any', label: 'Khớp MỘT điều kiện' }]}
            />
          </Field>
          <div className="mt-4 border-t border-[rgb(var(--border-line))] pt-3">
            <SectionTitle>Điều kiện</SectionTitle>
            <ConditionRows
              conditions={path.conditions || []}
              onChange={(conditions) => onChange({ ...path, conditions })}
            />
          </div>
        </>
      )}
    </div>
  );
}

function CaseForm({ item, onChange }: { item: SwitchCase; onChange: (c: SwitchCase) => void }) {
  return (
    <div className="p-3">
      <Field label="Nhãn case">
        <Input value={item.label || ''} onChange={(e) => onChange({ ...item, label: e.target.value })} />
      </Field>
      <Field label="So sánh">
        <div className="grid grid-cols-[0.9fr_1.1fr] gap-1.5">
          <Select
            value={item.op || 'equals'}
            onChange={(v) => onChange({ ...item, op: v as ConditionOp })}
            options={OPS}
          />
          <Input value={item.value || ''} onChange={(e) => onChange({ ...item, value: e.target.value })}
            placeholder="giá trị" />
        </div>
      </Field>
      <HintText>Giá trị được so với ô “Giá trị cần rẽ nhánh” của bước Switch.</HintText>
    </div>
  );
}

function NodeForm(props: InspectorProps & { node: FlowNode }) {
  const { node, spec, toolPacks, providers, isAnswerNode, onChange, onMakeAnswer } = props;
  const set = (patch: Partial<FlowNode>) => onChange({ ...node, ...patch } as FlowNode);

  return (
    <div className="p-3">
      <Field label="Tên bước">
        <Input value={node.name || ''} onChange={(e) => set({ name: e.target.value })}
          placeholder={spec?.label_vi || node.type} />
      </Field>

      {/* ── per-type ─────────────────────────────────────────────────────── */}
      {node.type === 'agent' && (
        <>
          <Field label="Hướng dẫn cho Agent"
            hint="Được NỐI vào prompt nền của hệ thống, không thay thế nó. Dùng {{biến}} để chèn kết quả bước trước.">
            <Textarea rows={6} value={node.prompt}
              onChange={(e) => set({ prompt: e.target.value } as Partial<FlowNode>)} />
          </Field>
          <Field label="Định dạng trả lời">
            <Select
              value={node.output_format || 'chat'}
              onChange={(v) => set({ output_format: v as 'chat' | 'json' } as Partial<FlowNode>)}
              options={[
                { value: 'chat', label: 'Văn bản (chảy chữ theo thời gian thực)' },
                { value: 'json', label: 'Khối có cấu trúc (KPI, bảng, trỏ biểu đồ)' },
              ]}
            />
            <HintText>
              Khối có cấu trúc cho phép trả về KPI/bảng/trỏ vào biểu đồ, nhưng
              không chảy chữ được — người xem chờ rồi thấy một lần.
            </HintText>
          </Field>
          <Field label="Số lần gọi công cụ tối đa">
            <Input type="number" min={1} max={MAX_TOOL_CALLS} value={node.max_tool_calls ?? 8}
              onChange={(e) => set({ max_tool_calls: Number(e.target.value) } as Partial<FlowNode>)} />
          </Field>
          <div className="mt-4 border-t border-[rgb(var(--border-line))] pt-3">
            <SectionTitle>Công cụ được cấp</SectionTitle>
            <ToolPicker
              packs={toolPacks}
              granted={(node.tools || []).map((t) => t.tool)}
              onToggle={(name, on) => set({
                tools: on
                  ? [...(node.tools || []), { tool: name }]
                  : (node.tools || []).filter((t) => t.tool !== name),
              } as Partial<FlowNode>)}
            />
            {isAnswerNode && (node.tools || []).length > 0 && (
              <p className="mt-2 rounded-md border border-warning/25 bg-warning/5 p-2 text-tiny text-warning">
                Đây là bước viết câu trả lời mà vẫn có công cụ — dễ đưa ra số chưa
                qua các bước trước.
              </p>
            )}
          </div>
          <div className="mt-4 border-t border-[rgb(var(--border-line))] pt-3">
            <SectionTitle>Model</SectionTitle>
            <Select
              value={node.provider || 'inherit'}
              onChange={(v) => set({ provider: v as never, model: v === 'inherit' ? '' : node.model } as Partial<FlowNode>)}
              options={providers.map((p) => ({ value: p.provider, label: p.label }))}
            />
            {node.provider && node.provider !== 'inherit' && (
              <div className="mt-1.5">
                <Select
                  value={node.model || ''}
                  onChange={(v) => set({ model: v } as Partial<FlowNode>)}
                  options={[
                    { value: '', label: '— chọn model —' },
                    ...(providers.find((p) => p.provider === node.provider)?.models || [])
                      .map((m) => ({ value: m.model, label: m.label })),
                  ]}
                />
              </div>
            )}
            <HintText>
              “Theo cấu hình của link” giữ flow dùng lại được trên mọi link, kể cả
              link chạy nhà cung cấp khác.
            </HintText>
          </div>
        </>
      )}

      {node.type === 'report_read' && (
        <>
          <Field label="Đọc gì">
            <div className="rounded-lg border border-[rgb(var(--border-line))] px-2.5">
              <Toggle on={node.include_summary !== false} title="Tóm tắt biểu đồ"
                hint="Số tổng quát, không tải toàn bộ dữ liệu."
                onChange={(v) => set({ include_summary: v } as Partial<FlowNode>)} />
              <Toggle on={node.include_data !== false} title="Dữ liệu biểu đồ"
                hint="Đọc rows thật. Tốn hơn."
                onChange={(v) => set({ include_data: v } as Partial<FlowNode>)} />
              <Toggle on={node.include_filters !== false} title="Filter đang áp"
                hint="Trả lời sai vì bỏ qua filter là lỗi hay gặp nhất."
                onChange={(v) => set({ include_filters: v } as Partial<FlowNode>)} />
            </div>
          </Field>
          <Field label="Số dòng tối đa mỗi biểu đồ">
            <Input type="number" min={1} max={5000} value={node.max_rows ?? 200}
              onChange={(e) => set({ max_rows: Number(e.target.value) } as Partial<FlowNode>)} />
          </Field>
          <HintText>
            Bước này KHÔNG chọn báo cáo. Nó đọc đúng những biểu đồ mà link đã cho
            phép khi gán flow.
          </HintText>
        </>
      )}

      {node.type === 'knowledge' && (
        <>
          <Field label="Câu truy vấn" hint="Dùng {{biến}} để tra theo kết quả bước trước.">
            <Textarea rows={3} value={node.query || ''}
              onChange={(e) => set({ query: e.target.value } as Partial<FlowNode>)} />
          </Field>
          <Field label="Số đoạn lấy về (top K)">
            <Input type="number" min={1} max={20} value={node.top_k ?? 5}
              onChange={(e) => set({ top_k: Number(e.target.value) } as Partial<FlowNode>)} />
          </Field>
        </>
      )}

      {node.type === 'web' && (
        <>
          <Field label="Câu tra cứu">
            <Textarea rows={3} value={node.query || ''}
              onChange={(e) => set({ query: e.target.value } as Partial<FlowNode>)} />
          </Field>
          <Field label="Chỉ cho phép các domain này"
            hint="Để trống = không giới hạn. Server chặn thật, không chỉ nhắc mô hình.">
            <Input
              value={(node.allowed_domains || []).join(', ')}
              onChange={(e) => set({
                allowed_domains: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
              } as Partial<FlowNode>)}
              placeholder="statista.com, thinkwithgoogle.com"
            />
          </Field>
          <p className="mt-2 rounded-md border border-warning/25 bg-warning/5 p-2 text-tiny text-warning">
            Bước này chỉ chạy trên link đã bật “Tìm kiếm web”. Link tắt thì bước bị
            bỏ qua và flow vẫn chạy tiếp.
          </p>
        </>
      )}

      {node.type === 'if' && (
        <HintText>
          Chọn từng nhánh trên canvas để sửa điều kiện của nó. Nhánh đầu tiên khớp
          sẽ chạy; nhánh Dự phòng chạy khi không nhánh nào khớp.
        </HintText>
      )}

      {node.type === 'switch' && (
        <>
          <Field label="Giá trị cần rẽ nhánh">
            <Input value={node.value} onChange={(e) => set({ value: e.target.value } as Partial<FlowNode>)}
              placeholder="{{severity}}" />
          </Field>
          <Field label="Cách chạy">
            <Select
              value={node.mode || 'first_match'}
              onChange={(v) => set({ mode: v as never } as Partial<FlowNode>)}
              options={[
                { value: 'first_match', label: 'Chạy case đầu tiên khớp' },
                { value: 'all_match', label: 'Chạy tất cả case khớp (tốn hơn)' },
              ]}
            />
          </Field>
          <div className="mt-3 rounded-lg border border-[rgb(var(--border-line))] px-2.5">
            <Toggle
              on={node.has_fallback !== false}
              title="Có nhánh dự phòng"
              hint="Chạy khi không case nào khớp — nếu tắt, flow đi thẳng xuống bước sau."
              onChange={(v) => set({ has_fallback: v } as Partial<FlowNode>)}
            />
          </div>
          <Button
            variant="secondary" size="xs" className="mt-2"
            onClick={() => set({
              cases: [...node.cases, {
                key: `case_${node.cases.length + 1}`,
                label: `CASE ${node.cases.length + 1}`,
                op: 'equals', value: '', body: [],
              }],
            } as Partial<FlowNode>)}
          >
            <Plus className="h-3 w-3" /> Thêm case
          </Button>
        </>
      )}

      {node.type === 'loop' && (
        <>
          <Field label="Danh sách cần lặp" hint="Thường là một requirement đã map, ví dụ {{segments}}.">
            <Input value={node.over} onChange={(e) => set({ over: e.target.value } as Partial<FlowNode>)} />
          </Field>
          <Field label="Tên biến cho từng phần tử">
            <Input value={node.item_var || 'item'}
              onChange={(e) => set({ item_var: e.target.value } as Partial<FlowNode>)} />
          </Field>
          <Field
            label="Số vòng tối đa"
            hint="Bước tốn kém nhất trong flow: mỗi vòng chứa một AI Agent là một lần gọi mô hình."
          >
            <Input type="number" min={1} max={MAX_LOOP_ITERATIONS} value={node.max_iterations ?? 10}
              onChange={(e) => set({ max_iterations: Number(e.target.value) } as Partial<FlowNode>)} />
          </Field>
          <Field label="Gom kết quả vào biến">
            <Input value={node.collect_into || ''}
              onChange={(e) => set({ collect_into: e.target.value } as Partial<FlowNode>)}
              placeholder="all_findings" />
          </Field>
        </>
      )}

      {node.type === 'filter' && (
        <>
          <Field label="Cách khớp">
            <Select
              value={node.match || 'all'}
              onChange={(v) => set({ match: v as 'all' | 'any' } as Partial<FlowNode>)}
              options={[{ value: 'all', label: 'Khớp TẤT CẢ' }, { value: 'any', label: 'Khớp MỘT' }]}
            />
          </Field>
          <div className="mt-3">
            <SectionTitle>Điều kiện đi tiếp</SectionTitle>
            <ConditionRows
              conditions={node.conditions || []}
              onChange={(conditions) => set({ conditions } as Partial<FlowNode>)}
            />
          </div>
          <HintText>Không khớp thì DỪNG NHÁNH này — các bước sau nhánh vẫn chạy.</HintText>
        </>
      )}

      {node.type === 'set_var' && (
        <>
          <Field label="Tên biến">
            <Input value={node.var} onChange={(e) => set({ var: e.target.value } as Partial<FlowNode>)} />
          </Field>
          <Field label="Giá trị">
            <Textarea rows={3} value={node.value || ''}
              onChange={(e) => set({ value: e.target.value } as Partial<FlowNode>)} />
          </Field>
          <Field label="Kiểu dữ liệu">
            <Select
              value={node.value_type || 'text'}
              onChange={(v) => set({ value_type: v as never } as Partial<FlowNode>)}
              options={[
                { value: 'text', label: 'Văn bản' }, { value: 'number', label: 'Số' },
                { value: 'list', label: 'Danh sách' }, { value: 'object', label: 'Object' },
                { value: 'bool', label: 'Đúng/Sai' },
              ]}
            />
          </Field>
        </>
      )}

      {node.type === 'transform' && (
        <>
          <Field label="Thao tác">
            <Select
              value={node.operation}
              onChange={(v) => set({ operation: v as never } as Partial<FlowNode>)}
              options={[
                { value: 'append_to_list', label: 'Thêm vào danh sách' },
                { value: 'map_fields', label: 'Map các trường' },
                { value: 'format_object', label: 'Ghép thành chuỗi' },
                { value: 'join_text', label: 'Nối danh sách thành văn bản' },
                { value: 'pick', label: 'Chỉ giữ một số trường' },
              ]}
            />
          </Field>
          <Field label="Nguồn">
            <Input value={node.source || ''} onChange={(e) => set({ source: e.target.value } as Partial<FlowNode>)}
              placeholder="{{previous}}" />
          </Field>
          <Field label="Ghi vào biến">
            <Input value={node.target || ''} onChange={(e) => set({ target: e.target.value } as Partial<FlowNode>)} />
          </Field>
        </>
      )}

      {node.type === 'stop' && (
        <>
          <Field label="Câu trả lời trả về" hint="Để trống thì flow dừng mà không nói gì.">
            <Textarea rows={4} value={node.message || ''}
              onChange={(e) => set({ message: e.target.value } as Partial<FlowNode>)} />
          </Field>
        </>
      )}

      {node.type === 'delay' && (
        <>
          <Field
            label="Chờ (giây)"
            hint="Tối đa 30 giây. Link công khai trả lời trong MỘT kết nối đang mở — chờ lâu hơn thì không còn chỗ nào để gửi câu trả lời tới."
          >
            <Input type="number" min={0} max={30} value={node.seconds ?? 1}
              onChange={(e) => set({ seconds: Number(e.target.value) } as Partial<FlowNode>)} />
          </Field>
        </>
      )}

      {/* ── common ───────────────────────────────────────────────────────── */}
      <div className="mt-4 border-t border-[rgb(var(--border-line))] pt-3">
        <SectionTitle>Kết quả & lặp lại</SectionTitle>
        {node.type !== 'set_var' && node.type !== 'if' && node.type !== 'switch' && (
          <Field label="Output variable" hint="Các bước sau đọc kết quả này bằng {{tên}}.">
            <Input value={node.output_var || ''}
              onChange={(e) => set({ output_var: e.target.value })} />
          </Field>
        )}
        <Field label="Chạy lại mỗi lượt?">
          <Select
            value={node.run_policy || 'every_turn'}
            onChange={(v) => set({ run_policy: v as never })}
            options={RUN_POLICY.map((r) => ({ value: r.value, label: r.label }))}
          />
          <HintText>{RUN_POLICY.find((r) => r.value === (node.run_policy || 'every_turn'))?.hint}</HintText>
        </Field>
        {node.type === 'agent' && (
          <Field label="Gửi bao nhiêu hội thoại cho model?"
            hint="Gửi ít hơn thì vừa rẻ hơn vừa chính xác hơn — bước phân loại không cần lời chào.">
            <Select
              value={node.context_policy || 'question'}
              onChange={(v) => set({ context_policy: v as never })}
              options={CONTEXT_POLICY}
            />
          </Field>
        )}
      </div>

      <div className="mt-4 border-t border-[rgb(var(--border-line))] pt-3">
        <SectionTitle>Khi bước này lỗi</SectionTitle>
        <Select
          value={node.on_error || 'continue'}
          onChange={(v) => set({ on_error: v as 'continue' | 'stop' })}
          options={[
            { value: 'continue', label: 'Bỏ qua bước, chạy tiếp' },
            { value: 'stop', label: 'Dừng flow' },
          ]}
        />
        <div className="mt-2 rounded-lg border border-[rgb(var(--border-line))] px-2.5">
          <Toggle
            on={!!node.retry}
            title="Thử lại"
            hint="Thử lại bước này trước khi coi là lỗi."
            onChange={(v) => set({ retry: v ? { max_attempts: 2, backoff_seconds: 1, on: 'error' } : null })}
          />
        </div>
        {node.retry && (
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            <Input type="number" min={1} max={5} value={node.retry.max_attempts}
              onChange={(e) => set({ retry: { ...node.retry!, max_attempts: Number(e.target.value) } })} />
            <Input type="number" min={0} max={30} step="0.5" value={node.retry.backoff_seconds}
              onChange={(e) => set({ retry: { ...node.retry!, backoff_seconds: Number(e.target.value) } })} />
          </div>
        )}
      </div>

      {!isAnswerNode && node.type === 'agent' && (
        <Button variant="secondary" size="xs" className="mt-4" onClick={onMakeAnswer}>
          Đặt làm bước trả lời
        </Button>
      )}
    </div>
  );
}

function ToolPicker({
  packs, granted, onToggle,
}: { packs: ToolPack[]; granted: string[]; onToggle: (name: string, on: boolean) => void }) {
  return (
    <div className="space-y-2">
      {packs.map((pack) => (
        <div key={pack.key} className="rounded-lg border border-[rgb(var(--border-line))]">
          <div className="flex items-center gap-1.5 border-b border-[rgb(var(--border-line))] bg-surface-2/40 px-2 py-1.5">
            <b className="text-tiny font-strong">{pack.label_vi}</b>
            {pack.gated_by_link && (
              <span title={pack.gate_note_vi}
                className="rounded border border-warning/25 bg-warning/5 px-1 text-tiny text-warning">
                theo link
              </span>
            )}
          </div>
          <div className="p-1.5">
            {pack.tools.map((t) => {
              const on = granted.includes(t.name);
              return (
                <label key={t.name}
                  className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-surface-2">
                  <input type="checkbox" checked={on} className="mt-0.5"
                    onChange={(e) => onToggle(t.name, e.target.checked)} />
                  <span className="min-w-0">
                    <b className="block text-tiny font-medium">{t.label_vi}</b>
                    <span className="block text-tiny leading-snug text-text-tertiary">
                      {t.description_vi}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
