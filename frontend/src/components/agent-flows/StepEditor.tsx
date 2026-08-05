'use client';

/**
 * One step's configuration: what it is for, what it may DO, what it may READ, and
 * which model runs it.
 *
 * The four-way split is the only division that holds, and it is kept from the
 * previous build. What changed is the room: this used to be a half-screen rail, so
 * twenty-four tools each with a "when to use this" field and knowledge sources each
 * needing a paragraph were all crammed into a 520px column. It now gets the main
 * surface, which is what makes a two-column tool grid and a full-width prompt
 * possible.
 *
 * CONTROLS ONLY WHERE THE RUNTIME HONOURS THEM.
 * Temperature, timeout and output format are still absent, and `model_tier` with
 * them: `runtime/loop.py::_resolve_model` reads only `provider`/`model` and falls
 * back to the link's, so a tier selector would be a control that changes nothing.
 * A knob that looks like it worked is worse than a missing one.
 */
import {
  AlertTriangle, BookOpen, Check, Eye, EyeOff, Globe, Info, KeyRound, Search, Trash2, Wrench,
} from 'lucide-react';
import React from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button, IconButton } from '@/components/ui/Button';
import { FieldGroup, Input, Select, Textarea } from '@/components/ui/Input';
import { Tabs } from '@/components/ui/Tabs';
import { cn } from '@/lib/utils';
import {
  MAX_TOOL_CALLS, MIN_KNOWLEDGE_DESCRIPTION,
  type AgentStep, type Attachable, type AttachableItem, type KnowledgeAttachment,
  type ProviderGroup, type StepProblem, type ToolPack,
} from '@/lib/agentFlows';

import { COST_LEGEND, CostChip, HintText, SearchPicker, TabCount } from './shared';

export type StepTab = 'basic' | 'tools' | 'knowledge' | 'advanced';

export function StepEditor({
  step, index, isLast, tab, onTabChange, problems, packs, providers, sources, canEdit, onPatch,
}: {
  step: AgentStep;
  index: number;
  isLast: boolean;
  tab: StepTab;
  onTabChange: (tab: StepTab) => void;
  problems: StepProblem[];
  packs: ToolPack[];
  providers: ProviderGroup[];
  sources: Attachable;
  canEdit: boolean;
  onPatch: (p: Partial<AgentStep>) => void;
}) {
  const toolCount = (step.tools || []).length;
  const knowledgeCount = (step.knowledge || []).length;
  const problemTabs = new Set(problems.map((p) => p.tab));

  return (
    <div className="flex h-full flex-col">
      {/* Sub-bar: which step, and the four facets of it. Sticky so the tabs stay
          reachable while a long tool list scrolls. */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2">
        <span className="grid h-5 w-5 flex-shrink-0 place-items-center rounded bg-brand text-tiny font-strong tabular-nums text-text-inverse">
          {index + 1}
        </span>
        <span className="min-w-0 max-w-[280px] truncate text-caption font-strong text-text-primary">
          {step.name || step.key}
        </span>
        {isLast && <Badge variant="success" size="xs">Bước trả lời người xem</Badge>}
        <span className="font-mono text-tiny text-text-quaternary">{step.key}</span>
        <div className="flex-1" />
        <Tabs<StepTab>
          variant="pill"
          size="sm"
          value={tab}
          onChange={onTabChange}
          items={[
            {
              key: 'basic', label: 'Cơ bản',
              badge: problemTabs.has('basic') ? <ProblemDot /> : undefined,
            },
            {
              key: 'tools', label: 'Công cụ',
              badge: toolCount > 0 ? <TabCount n={toolCount} /> : undefined,
            },
            {
              key: 'knowledge', label: 'Tri thức',
              badge: problemTabs.has('knowledge')
                ? <ProblemDot />
                : knowledgeCount > 0 ? <TabCount n={knowledgeCount} /> : undefined,
            },
            {
              key: 'advanced', label: 'Nâng cao',
              badge: problemTabs.has('advanced') ? <ProblemDot /> : undefined,
            },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-4xl">
          {problems.length > 0 && (
            <div className="mb-3 space-y-1">
              {problems.map((p, i) => (
                <p key={i} className="flex gap-1.5 rounded-md border border-danger/25 bg-danger/10 px-2.5 py-1.5 text-tiny leading-snug text-danger">
                  <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                  <span>{p.message}</span>
                </p>
              ))}
            </div>
          )}

          {tab === 'basic' && <BasicTab step={step} isLast={isLast} canEdit={canEdit} onPatch={onPatch} />}
          {tab === 'tools' && <ToolsTab step={step} packs={packs} canEdit={canEdit} onPatch={onPatch} />}
          {tab === 'knowledge' && <KnowledgeTab step={step} sources={sources} canEdit={canEdit} onPatch={onPatch} />}
          {tab === 'advanced' && <AdvancedTab step={step} providers={providers} canEdit={canEdit} onPatch={onPatch} />}
        </div>
      </div>
    </div>
  );
}

function ProblemDot() {
  return <span className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-danger" aria-label="còn chỗ cần sửa" />;
}

/* ── basic ────────────────────────────────────────────────────────────────── */

function BasicTab({
  step, isLast, canEdit, onPatch,
}: {
  step: AgentStep;
  isLast: boolean;
  canEdit: boolean;
  onPatch: (p: Partial<AgentStep>) => void;
}) {
  return (
    <div className="space-y-4">
      <FieldGroup
        label="Mục tiêu của bước"
        description="Tên bạn thấy trên chuỗi bên trái. Không đi vào prompt."
      >
        <Input
          value={step.name || ''}
          disabled={!canEdit}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="ví dụ: Phân tích dữ liệu"
        />
      </FieldGroup>

      <FieldGroup
        label="Hướng dẫn cho agent"
        required
        description={
          <>
            Được <strong className="font-emphasis text-text-secondary">nối vào</strong> prompt gốc
            của hệ thống, không thay thế nó — nên bạn không cần nhắc lại các quy tắc trích nguồn hay
            ngôn ngữ trả lời. Viết “báo cáo đang mở” thay vì tên một báo cáo cụ thể: bộ não này sẽ
            chạy trên những link bạn chưa thấy.
          </>
        }
      >
        <Textarea
          rows={14}
          value={step.prompt}
          disabled={!canEdit}
          onChange={(e) => onPatch({ prompt: e.target.value })}
          placeholder={
            isLast
              ? 'Viết câu trả lời cho người xem, chỉ dùng số các bước trước đã đưa ra. Trích nguồn cho mỗi con số.'
              : 'Bạn là chuyên viên phân tích của báo cáo đang mở. Đọc câu hỏi, xác định cần con số nào, dùng công cụ lấy đúng số đó.'
          }
          className="font-normal leading-relaxed"
        />
      </FieldGroup>

      {isLast && (
        <p className="flex gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-2 text-tiny leading-relaxed text-text-tertiary">
          <Info className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span>
            Đây là bước cuối, nên chữ nó viết ra chính là câu trả lời người xem đọc được. Các bước
            trước chỉ đưa dữ liệu và lập luận cho nó.
          </span>
        </p>
      )}
    </div>
  );
}

/* ── tools ────────────────────────────────────────────────────────────────── */

/**
 * The tool picker.
 *
 * Twenty-four tools across four packs. Previously: four `<details>` blocks, no
 * search, no way to review only what was granted, and — the actual bug — the
 * external pack rendered with `disabled` checkboxes because the deployment flag came
 * back false, so `web_search` could never be granted by anybody. That gate is per
 * LINK, so the pack is offered here and the condition is stated instead.
 */
function ToolsTab({
  step, packs, canEdit, onPatch,
}: {
  step: AgentStep;
  packs: ToolPack[];
  canEdit: boolean;
  onPatch: (p: Partial<AgentStep>) => void;
}) {
  const [query, setQuery] = React.useState('');
  const [onlyGranted, setOnlyGranted] = React.useState(false);
  const grants = step.tools || [];
  const total = packs.reduce((n, p) => n + p.tools.length, 0);

  const has = (n: string) => grants.some((g) => g.tool === n);
  const toggle = (n: string) =>
    onPatch({ tools: has(n) ? grants.filter((g) => g.tool !== n) : [...grants, { tool: n, note: '' }] });
  const setNote = (n: string, note: string) =>
    onPatch({ tools: grants.map((g) => (g.tool === n ? { ...g, note } : g)) });

  const q = query.trim().toLowerCase();
  const visiblePacks = packs
    .map((pack) => ({
      pack,
      tools: pack.tools.filter((t) => {
        if (onlyGranted && !has(t.name)) return false;
        if (!q) return true;
        return t.label_vi.toLowerCase().includes(q)
          || t.name.toLowerCase().includes(q)
          || t.description_vi.toLowerCase().includes(q);
      }),
    }))
    .filter((entry) => entry.tools.length > 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[200px] flex-1">
          <Input
            size="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tìm công cụ…"
            leadingIcon={<Search />}
          />
        </div>
        <Button
          variant={onlyGranted ? 'primary' : 'secondary'}
          size="sm"
          leadingIcon={<Check className="h-3.5 w-3.5" />}
          onClick={() => setOnlyGranted((v) => !v)}
        >
          Chỉ mục đã bật
        </Button>
        <span className="text-caption tabular-nums text-text-tertiary">
          <span className="font-strong text-text-primary">{grants.length}</span>/{total}
        </span>
      </div>

      <HintText>
        Agent tự chọn gọi cái nào mỗi lượt — bật 3 công cụ không có nghĩa mỗi câu dùng cả 3.
        Ô “khi nào dùng” đi kèm tên công cụ vào prompt, nên một câu ở đó thường hiệu quả hơn
        cả đoạn viết trong Hướng dẫn.
      </HintText>

      {/* A grid, not a wrapped row. Four chip+sentence pairs flowing inline read as
          one run-on sentence with coloured words in it. */}
      <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-2">
        <p className="mb-1.5 text-tiny font-strong uppercase tracking-[0.08em] text-text-quaternary">
          Chi phí mỗi lần gọi
        </p>
        <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {COST_LEGEND.map(({ cost, hint }) => (
            <span key={cost} className="flex items-baseline gap-1.5">
              <CostChip cost={cost} />
              <span className="text-tiny leading-snug text-text-tertiary">{hint}</span>
            </span>
          ))}
        </div>
      </div>

      {visiblePacks.length === 0 && (
        <p className="rounded-lg border border-dashed border-[rgb(var(--border-line))] py-6 text-center text-tiny text-text-tertiary">
          {onlyGranted ? 'Bước này chưa bật công cụ nào.' : 'Không có công cụ nào khớp.'}
        </p>
      )}

      {visiblePacks.map(({ pack, tools }) => (
        <section key={pack.key} className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))]">
          <header className="flex flex-wrap items-center gap-2 bg-surface-2 px-2.5 py-1.5">
            <Wrench className="h-3.5 w-3.5 flex-shrink-0 text-text-tertiary" />
            <span className="text-caption font-strong text-text-primary">{pack.label_vi}</span>
            {pack.gated_by_link && (
              <Badge variant="warning" size="xs">
                <Globe className="mr-0.5 h-2.5 w-2.5" />
                phụ thuộc cấu hình link
              </Badge>
            )}
            <div className="flex-1" />
            <span className="text-tiny font-emphasis tabular-nums text-text-quaternary">
              {pack.tools.filter((t) => has(t.name)).length}/{pack.tools.length}
            </span>
          </header>

          {pack.gated_by_link && pack.gate_note_vi && (
            <p className="flex gap-1.5 border-b border-[rgb(var(--border-line))] bg-warning/5 px-2.5 py-1.5 text-tiny leading-snug text-text-secondary">
              <Info className="mt-0.5 h-3 w-3 flex-shrink-0 text-warning" />
              <span>{pack.gate_note_vi}</span>
            </p>
          )}

          <div className="divide-y divide-[rgb(var(--border-line))]">
            {tools.map((t) => {
              const on = has(t.name);
              return (
                <div key={t.name}>
                  <label className={cn(
                    'flex items-start gap-2.5 px-2.5 py-2',
                    canEdit ? 'cursor-pointer hover:bg-surface-2' : 'cursor-default',
                  )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!canEdit}
                      onChange={() => toggle(t.name)}
                      className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 accent-brand"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-caption font-emphasis text-text-primary">{t.label_vi}</span>
                        <span className="font-mono text-tiny text-text-quaternary">{t.name}</span>
                      </span>
                      <span className="mt-0.5 block text-tiny leading-relaxed text-text-tertiary">
                        {t.description_vi}
                      </span>
                    </span>
                    <span className="flex flex-shrink-0 items-center gap-1">
                      {/* Only when the cost class does not already say it. An
                          `external` tool renders "ra ngoài" as its cost chip, and
                          printing the same words twice on one row looked like two
                          different warnings. This still flags the case that matters:
                          a cheap-looking tool that nonetheless leaves AppBI. */}
                      {t.reaches_outside && t.cost_class !== 'external' && (
                        <span
                          title="Công cụ này gửi dữ liệu ra ngoài AppBI."
                          className="inline-flex h-4 items-center rounded border border-danger/25 bg-danger/10 px-1 text-tiny text-danger"
                        >
                          ra ngoài
                        </span>
                      )}
                      <CostChip cost={t.cost_class} />
                    </span>
                  </label>

                  {on && (
                    <div className="pb-2 pl-9 pr-2.5">
                      <Input
                        size="sm"
                        value={grants.find((g) => g.tool === t.name)?.note || ''}
                        disabled={!canEdit}
                        onChange={(e) => setNote(t.name, e.target.value)}
                        placeholder="Khi nào dùng công cụ này (tuỳ chọn) — ví dụ: chỉ khi câu hỏi cần số cụ thể"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ── knowledge ────────────────────────────────────────────────────────────── */

const SOURCE_LABEL: Record<KnowledgeAttachment['source'], string> = {
  document: 'Tài liệu',
  semantic: 'Bộ dữ liệu',
  metric: 'Chỉ số',
};

function KnowledgeTab({
  step, sources, canEdit, onPatch,
}: {
  step: AgentStep;
  sources: Attachable;
  canEdit: boolean;
  onPatch: (p: Partial<AgentStep>) => void;
}) {
  const items = step.knowledge || [];
  const set = (i: number, p: Partial<KnowledgeAttachment>) =>
    onPatch({ knowledge: items.map((k, idx) => (idx === i ? { ...k, ...p } : k)) });

  const poolFor = (source: KnowledgeAttachment['source']): AttachableItem[] =>
    source === 'semantic' ? sources.datasets : source === 'metric' ? sources.metrics : sources.documents;

  const emptyTextFor = (source: KnowledgeAttachment['source']) =>
    source === 'metric'
      ? 'Chưa có chỉ số quản trị nào được khai báo trong Govern.'
      : source === 'semantic'
        ? 'Bạn chưa có quyền xem bộ dữ liệu nào.'
        : 'Bạn chưa có quyền xem tài liệu nào.';

  return (
    <div className="space-y-3">
      <HintText>
        Chỉ hiện thứ <strong className="font-emphasis text-text-secondary">bạn</strong> có quyền xem —
        và chia sẻ bộ não này cũng là cho người khác đọc qua quyền của bạn. Phần mô tả là thứ giúp
        agent biết khi nào nên mở nguồn nào; thiếu nó thì nó mở sai nguồn, hoặc không mở.
      </HintText>

      <p className="flex gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-2 text-tiny leading-relaxed text-text-tertiary">
        <Info className="mt-0.5 h-3 w-3 flex-shrink-0" />
        <span>
          Không gắn gì cũng hợp lệ: bộ não sẽ chỉ đọc báo cáo đang mở, và như vậy nó dùng được
          cho mọi báo cáo.
        </span>
      </p>

      {items.map((k, i) => {
        const pool = poolFor(k.source);
        const missingRef = !k.ref.trim();
        const shortDescription = k.description.trim().length < MIN_KNOWLEDGE_DESCRIPTION;
        // A stored ref whose target is no longer in the pool: rights were lost, or
        // the source was deleted. Named rather than shown as a blank picker.
        const dangling = !missingRef && !pool.some((o) => o.ref === k.ref);
        return (
          <div
            key={i}
            className={cn(
              'rounded-lg border bg-surface-1 p-2.5',
              missingRef || shortDescription || dangling
                ? 'border-warning/45'
                : 'border-[rgb(var(--border-line))]',
            )}
          >
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Select
                size="sm"
                value={k.source}
                disabled={!canEdit}
                className="w-32"
                onChange={(e) => set(i, { source: e.target.value as KnowledgeAttachment['source'], ref: '' })}
              >
                {(Object.keys(SOURCE_LABEL) as KnowledgeAttachment['source'][]).map((s) => (
                  <option key={s} value={s}>{SOURCE_LABEL[s]}</option>
                ))}
              </Select>
              <SearchPicker
                className="min-w-[220px] flex-1"
                value={k.ref}
                options={pool}
                disabled={!canEdit}
                invalid={missingRef || dangling}
                placeholder={`— chọn ${SOURCE_LABEL[k.source].toLowerCase()} —`}
                emptyText={emptyTextFor(k.source)}
                onChange={(ref) => set(i, { ref })}
              />
              {canEdit && (
                <IconButton
                  aria-label="Bỏ nguồn này" variant="ghost" size="sm" title="Bỏ nguồn này"
                  className="hover:text-danger"
                  onClick={() => onPatch({ knowledge: items.filter((_, idx) => idx !== i) })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </IconButton>
              )}
            </div>

            {dangling && (
              <p className="mb-1.5 flex gap-1.5 text-tiny text-warning">
                <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                <span>
                  Nguồn đã gắn (<span className="font-mono">{k.ref}</span>) không còn trong danh sách
                  bạn được xem. Bước này sẽ chạy như thể không có nó — chọn lại hoặc bỏ ra.
                </span>
              </p>
            )}

            <Textarea
              rows={2}
              value={k.description}
              disabled={!canEdit}
              onChange={(e) => set(i, { description: e.target.value })}
              placeholder="Nguồn này chứa gì, khi nào nên tra? — bắt buộc"
              className="bg-surface-1"
              invalid={shortDescription}
            />
            {shortDescription && (
              <p className="mt-1 text-tiny text-warning">
                Cần ít nhất {MIN_KNOWLEDGE_DESCRIPTION} ký tự nói rõ khi nào nên tra nguồn này —
                đây là thứ duy nhất ngăn agent mở nó trên một báo cáo không liên quan.
              </p>
            )}
            {k.source === 'metric' && (
              <p className="mt-1 text-tiny text-text-quaternary">
                Chỉ số chỉ tra được nếu nó gắn với dữ liệu của báo cáo đang mở.
              </p>
            )}
          </div>
        );
      })}

      {canEdit && (
        <button
          type="button"
          onClick={() => onPatch({ knowledge: [...items, { source: 'document', ref: '', description: '' }] })}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[rgb(var(--border-line))] py-2 text-tiny font-emphasis text-text-secondary transition-colors hover:border-brand hover:text-brand"
        >
          <BookOpen className="h-3.5 w-3.5" />
          Gắn nguồn tri thức
        </button>
      )}
    </div>
  );
}

/* ── advanced ─────────────────────────────────────────────────────────────── */

function AdvancedTab({
  step, providers, canEdit, onPatch,
}: {
  step: AgentStep;
  providers: ProviderGroup[];
  canEdit: boolean;
  onPatch: (p: Partial<AgentStep>) => void;
}) {
  const current = step.provider || 'inherit';
  const group = providers.find((g) => g.provider === current);
  const cap = step.max_tool_calls ?? 8;

  return (
    <div className="max-w-2xl space-y-4">
      <FieldGroup
        label="Nhà cung cấp"
        description={group?.note || 'Bước này sẽ chạy trên nhà cung cấp bạn chọn ở đây.'}
      >
        <Select
          value={current}
          disabled={!canEdit}
          onChange={(e) => onPatch({ provider: e.target.value as AgentStep['provider'], model: '' })}
        >
          {providers.map((g) => <option key={g.provider} value={g.provider}>{g.label}</option>)}
        </Select>
      </FieldGroup>

      {group && group.models.length > 0 && (
        <FieldGroup
          label="Model"
          required
          description="Danh sách do hệ thống khai báo. Gõ tay một tên model là lỗi 404 ở câu hỏi thật đầu tiên, nên ở đây chỉ chọn."
          error={!step.model ? 'Đã chọn nhà cung cấp thì phải chọn model.' : undefined}
        >
          <Select
            value={step.model || ''}
            disabled={!canEdit}
            invalid={!step.model}
            onChange={(e) => onPatch({ model: e.target.value })}
          >
            <option value="">— chọn model —</option>
            {group.models.map((m) => (
              <option key={m.model} value={m.model}>{m.label}</option>
            ))}
          </Select>
        </FieldGroup>
      )}

      {current === 'inherit' && (
        <p className="flex gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-2 text-tiny leading-relaxed text-text-tertiary">
          <Info className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span>
            Bước này dùng đúng model mà link công khai đang cấu hình. Đây là mặc định vì nó giữ bộ
            não dùng lại được cả trên link của nhà cung cấp khác.
          </span>
        </p>
      )}

      <StepTokenField step={step} canEdit={canEdit} onPatch={onPatch} />

      <FieldGroup
        label="Số lượt gọi công cụ tối đa"
        description={`Kiểm giữa các lượt. Hết trần thì bước này trả lời bằng những gì đã có. Từ 1 đến ${MAX_TOOL_CALLS}.`}
        error={cap < 1 || cap > MAX_TOOL_CALLS ? `Phải từ 1 đến ${MAX_TOOL_CALLS}.` : undefined}
      >
        <Input
          type="number"
          min={1}
          max={MAX_TOOL_CALLS}
          value={cap}
          disabled={!canEdit}
          invalid={cap < 1 || cap > MAX_TOOL_CALLS}
          className="w-32"
          onChange={(e) => onPatch({ max_tool_calls: Number(e.target.value) })}
        />
      </FieldGroup>

      <p className="flex gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-2 text-tiny leading-relaxed text-text-tertiary">
        <Check className="mt-0.5 h-3 w-3 flex-shrink-0" />
        <span>
          Chỉ áp dụng cho bước này. Nhiệt độ, timeout và định dạng đầu ra chưa có ở đây vì runtime
          chưa xử lý — thêm ô điều khiển không có tác dụng thì tệ hơn là chưa có.
        </span>
      </p>
    </div>
  );
}

/**
 * The step's own token.
 *
 * THREE STATES, NOT ONE INPUT.
 * The server never returns a stored token, so an input bound to its value would
 * render empty over a working key and the next save would look like "the author
 * cleared it". So: a stored token shows as a fact with Đổi/Xoá beside it, and the
 * input only ever appears when a NEW value is being entered. Empty means keep.
 */
function StepTokenField({
  step, canEdit, onPatch,
}: {
  step: AgentStep;
  canEdit: boolean;
  onPatch: (p: Partial<AgentStep>) => void;
}) {
  const stored = Boolean(step.has_api_key) && !step.api_key_clear;
  const typing = step.api_key !== undefined;
  const [reveal, setReveal] = React.useState(false);
  const inheriting = !step.provider || step.provider === 'inherit';

  return (
    <FieldGroup
      label="Token riêng cho bước này"
      description={
        <>
          Điền trực tiếp ở đây thì bước này gọi bằng token của bạn, không dùng token cấu hình ở
          link. Bỏ trống thì nó dùng token của link. Token được{' '}
          <strong className="font-emphasis text-text-secondary">mã hoá khi lưu</strong> và không bao
          giờ được trả về — nên sau khi lưu bạn chỉ thấy trạng thái, không thấy lại giá trị.
        </>
      }
      error={
        (stored || typing) && inheriting
          ? 'Chọn nhà cung cấp cụ thể ở trên — token của một hãng không dùng được trên link chạy hãng khác.'
          : undefined
      }
    >
      {stored && !typing && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-success/25 bg-success/5 px-2.5 py-2">
          <KeyRound className="h-3.5 w-3.5 flex-shrink-0 text-success" />
          <span className="min-w-0 flex-1 text-tiny text-text-secondary">
            Đã lưu một token cho bước này (đã mã hoá).
          </span>
          {canEdit && (
            <>
              <Button variant="secondary" size="xs" onClick={() => onPatch({ api_key: '' })}>
                Đổi token
              </Button>
              <Button
                variant="ghost" size="xs" className="text-danger hover:text-danger"
                onClick={() => onPatch({ api_key_clear: true, api_key: undefined })}
              >
                Xoá
              </Button>
            </>
          )}
        </div>
      )}

      {step.api_key_clear && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-warning" />
          <span className="min-w-0 flex-1 text-tiny text-text-secondary">
            Token sẽ bị xoá khi bạn lưu. Bước này sẽ quay về dùng token của link.
          </span>
          <Button
            variant="secondary" size="xs"
            onClick={() => onPatch({ api_key_clear: false })}
          >
            Hoàn tác
          </Button>
        </div>
      )}

      {typing && (
        <div className="space-y-1.5">
          <Input
            autoFocus
            type={reveal ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            value={step.api_key || ''}
            disabled={!canEdit}
            onChange={(e) => onPatch({ api_key: e.target.value, api_key_clear: false })}
            placeholder="Dán token của nhà cung cấp vào đây"
            trailingIcon={
              <button
                type="button"
                onClick={() => setReveal((v) => !v)}
                aria-label={reveal ? 'Ẩn token' : 'Hiện token'}
                className="pointer-events-auto text-text-tertiary hover:text-text-primary"
              >
                {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            }
          />
          <div className="flex items-center gap-2">
            <Button
              variant="ghost" size="xs"
              onClick={() => onPatch({ api_key: undefined })}
            >
              Huỷ
            </Button>
            <span className="text-tiny text-text-quaternary">
              {stored
                ? 'Lưu để thay token đang có.'
                : 'Token chỉ được gửi khi bạn bấm Lưu nháp.'}
            </span>
          </div>
        </div>
      )}

      {!stored && !typing && !step.api_key_clear && canEdit && (
        <button
          type="button"
          onClick={() => onPatch({ api_key: '' })}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-[rgb(var(--border-line))] py-2 text-tiny font-emphasis text-text-secondary transition-colors hover:border-brand hover:text-brand"
        >
          <KeyRound className="h-3.5 w-3.5" />
          Điền token cho bước này
        </button>
      )}

      {!stored && !typing && !step.api_key_clear && !canEdit && (
        <p className="text-tiny text-text-quaternary">Chưa có token riêng — bước này dùng token của link.</p>
      )}
    </FieldGroup>
  );
}
