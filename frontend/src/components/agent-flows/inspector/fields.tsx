/**
 * The field primitives every node editor is built from.
 *
 * They were at the top of `NodeInspector.tsx`, above a 695-line `NodeForm` that
 * held one `node.type === 'x'` branch per node type. Splitting the editors out
 * meant splitting these out first: they are the shared vocabulary, and a copy per
 * editor is how two node types start looking different for no reason.
 *
 * Shared on purpose, and NOT a UI framework. Each one is the smallest wrapper
 * that keeps label, hint and spacing consistent; anything more general belongs in
 * `@/components/ui`.
 */
// AUTO-EXTRACTED FROM NodeInspector.tsx — see that file's header for why.
import React from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { Input, Textarea } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import type {
  Condition, ConditionOp, FlowPath, SwitchCase, FlowNode, NodeSpec,
} from '@/lib/agentFlows';
import { SectionTitle, HintText } from '../shared';

export const OPS: { value: ConditionOp; labelKey?: string; label?: string }[] = [
  { value: 'contains', labelKey: 'agentFlows.inspector.op.contains' },
  { value: 'not_contains', labelKey: 'agentFlows.inspector.op.notContains' },
  { value: 'equals', labelKey: 'agentFlows.inspector.op.equals' },
  { value: 'not_equals', labelKey: 'agentFlows.inspector.op.notEquals' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'is_empty', labelKey: 'agentFlows.inspector.op.isEmpty' },
  { value: 'is_not_empty', labelKey: 'agentFlows.inspector.op.isNotEmpty' },
  { value: 'matches', labelKey: 'agentFlows.inspector.op.matches' },
  { value: 'in_list', labelKey: 'agentFlows.inspector.op.inList' },
];

export const RUN_POLICY: { value: string; labelKey: string; hintKey: string }[] = [
  { value: 'every_turn', labelKey: 'agentFlows.inspector.runPolicy.everyTurn', hintKey: 'agentFlows.inspector.runPolicy.everyTurnHint' },
  { value: 'when_stale', labelKey: 'agentFlows.inspector.runPolicy.whenStale', hintKey: 'agentFlows.inspector.runPolicy.whenStaleHint' },
  { value: 'once_per_session', labelKey: 'agentFlows.inspector.runPolicy.oncePerSession', hintKey: 'agentFlows.inspector.runPolicy.oncePerSessionHint' },
];

export const CONTEXT_POLICY: { value: string; labelKey: string }[] = [
  { value: 'none', labelKey: 'agentFlows.inspector.context.none' },
  { value: 'question', labelKey: 'agentFlows.inspector.context.question' },
  { value: 'last_3', labelKey: 'agentFlows.inspector.context.last3' },
  { value: 'full', labelKey: 'agentFlows.inspector.context.full' },
];

export type TFn = (key: string, values?: Record<string, string | number>) => string;

export function opOptions(t: TFn) {
  return OPS.map((o) => ({ value: o.value, label: o.labelKey ? t(o.labelKey) : o.label || o.value }));
}

export function specLabel(spec: NodeSpec | undefined, language: 'en' | 'vi') {
  if (!spec) return '';
  return (language === 'vi' ? spec.label_vi : spec.label_en) || spec.label_vi || spec.label_en;
}

export function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 first:mt-0">
      <label className="mb-1 block text-caption font-medium text-text-secondary">{label}</label>
      {hint && <p className="mb-1 text-caption leading-snug text-text-tertiary">{hint}</p>}
      {children}
    </div>
  );
}

export function Select({
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

export function Toggle({
  on, onChange, title, hint, disabled,
}: {
  on: boolean; onChange: (v: boolean) => void; title: string; hint?: string;
  /** A switch that changes nothing must not look like one that does. `detail:
   *  "index"` short-circuits before either read tool is called, so "chart summary"
   *  and "chart data" are silently inert there - an author flipping them saw no
   *  effect and no reason. */
  disabled?: boolean;
}) {
  return (
    <div className={cn(
      'flex items-center gap-2 border-t border-[rgb(var(--border-line))] py-2 first:border-t-0',
      disabled && 'opacity-50',
    )}>
      <div className="min-w-0 flex-1">
        <b className="block text-caption font-medium">{title}</b>
        {hint && <span className="mt-px block text-caption text-text-tertiary">{hint}</span>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={cn(
          'h-[18px] w-[34px] flex-shrink-0 rounded-full p-0.5 transition',
          on ? 'bg-brand' : 'bg-surface-3',
          disabled && 'cursor-not-allowed',
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

export function ConditionRows({
  conditions, onChange,
}: { conditions: Condition[]; onChange: (next: Condition[]) => void }) {
  const { t } = useI18n();
  const set = (i: number, patch: Partial<Condition>) =>
    onChange(conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  return (
    <div>
      {conditions.map((c, i) => {
        const unary = c.op === 'is_empty' || c.op === 'is_not_empty';
        return (
          <div key={i} className="mt-1.5 grid grid-cols-[1.2fr_0.8fr_1fr_28px] gap-1.5 first:mt-0">
            <Input value={c.left} onChange={(e) => set(i, { left: e.target.value })}
              placeholder="{{available_metrics}}" className="h-8 text-caption" />
            <Select value={c.op} onChange={(v) => set(i, { op: v as ConditionOp })} options={opOptions(t)} />
            <Input
              value={c.right || ''}
              disabled={unary}
              onChange={(e) => set(i, { right: e.target.value })}
              placeholder={unary ? '-' : t('agentFlows.inspector.value')}
              className="h-8 text-caption"
            />
            <button
              type="button"
              onClick={() => onChange(conditions.filter((_, idx) => idx !== i))}
              className="rounded-md text-text-tertiary hover:bg-surface-2 hover:text-danger"
              aria-label={t('agentFlows.inspector.deleteCondition')}
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
        <Plus className="h-3 w-3" /> {t('agentFlows.inspector.addCondition')}
      </Button>
      <HintText>
        {t('agentFlows.inspector.conditionHintPrefix')} <code>{t('agentFlows.inspector.conditionVariableExample')}</code>.{' '}
        {t('agentFlows.inspector.conditionHintMiddle')} <code>revenue</code> {t('agentFlows.inspector.conditionHintMatch')}{' '}
        <code>table.total_revenue</code>).
      </HintText>
    </div>
  );
}

/** A bounded number box that never emits a value outside its own bounds.
 *
 *  WHAT IT REPLACES, AND WHY IT IS A COMPONENT RATHER THAN EIGHT FIXES.
 *
 *  Every number field here was `value={x ?? 8}` with
 *  `onChange={(e) => set({ x: Number(e.target.value) })}`. `Number('')` is `0`, so
 *  the instant somebody selected the contents to type a new number the model
 *  received 0 — below every `min={1}` on this screen — and the flow went invalid
 *  mid-keystroke. The server said so, correctly, and the builder printed the
 *  refusal in its title bar. Eight boxes, one bug, so one component.
 *
 *  The text is held locally while it is being edited, which is what lets the box
 *  be empty without the model being wrong. Only a parse that lands inside
 *  [min, max] is committed; leaving the box snaps it back to the value that is
 *  actually in the flow, so what is on screen and what will be saved cannot
 *  disagree once focus moves on.
 */
export function NumberField({
  value, min, max, step, onCommit, className,
}: {
  value: number;
  min: number;
  max: number;
  step?: string;
  onCommit: (n: number) => void;
  className?: string;
}) {
  const [text, setText] = React.useState(String(value));
  const [editing, setEditing] = React.useState(false);

  // Someone else changed it (undo, loading another step) — follow, unless the
  // author is mid-keystroke in this very box.
  React.useEffect(() => { if (!editing) setText(String(value)); }, [value, editing]);

  return (
    <Input
      type="number"
      min={min}
      max={max}
      step={step}
      className={className}
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        if (next.trim() === '') return;        // mid-edit, not a value yet
        const n = Number(next);
        if (Number.isFinite(n) && n >= min && n <= max) onCommit(n);
      }}
      onBlur={() => {
        setEditing(false);
        const n = Number(text);
        const ok = text.trim() !== '' && Number.isFinite(n);
        const clamped = ok ? Math.min(max, Math.max(min, n)) : value;
        setText(String(clamped));
        if (clamped !== value) onCommit(clamped);
      }}
    />
  );
}



export function PathForm({ path, onChange }: { path: FlowPath; onChange: (p: FlowPath) => void }) {
  const { t } = useI18n();
  return (
    <div className="p-3">
      <Field label={t('agentFlows.inspector.branchName')}>
        <Input value={path.name || ''} onChange={(e) => onChange({ ...path, name: e.target.value })} />
      </Field>
      <Field
        label={t('agentFlows.inspector.branchType')}
        hint={t('agentFlows.inspector.branchTypeHint')}
      >
        <Select
          value={path.kind}
          onChange={(v) => onChange({ ...path, kind: v as FlowPath['kind'] })}
          options={[
            { value: 'rules', label: t('agentFlows.inspector.branchType.rules') },
            { value: 'always', label: t('agentFlows.inspector.branchType.always') },
            { value: 'fallback', label: t('agentFlows.inspector.branchType.fallback') },
          ]}
        />
      </Field>
      {path.kind === 'rules' && (
        <>
          <Field label={t('agentFlows.inspector.matchMode')}>
            <Select
              value={path.match || 'all'}
              onChange={(v) => onChange({ ...path, match: v as 'all' | 'any' })}
              options={[{ value: 'all', label: t('agentFlows.inspector.matchAllConditions') }, { value: 'any', label: t('agentFlows.inspector.matchAnyCondition') }]}
            />
          </Field>
          <div className="mt-4 border-t border-[rgb(var(--border-line))] pt-3">
            <SectionTitle>{t('agentFlows.inspector.conditions')}</SectionTitle>
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

export function CaseForm({ item, onChange }: { item: SwitchCase; onChange: (c: SwitchCase) => void }) {
  const { t } = useI18n();
  return (
    <div className="p-3">
      <Field label={t('agentFlows.inspector.caseLabel')}>
        <Input value={item.label || ''} onChange={(e) => onChange({ ...item, label: e.target.value })} />
      </Field>
      <Field label={t('agentFlows.inspector.compare')}>
        <div className="grid grid-cols-[0.9fr_1.1fr] gap-1.5">
          <Select
            value={item.op || 'equals'}
            onChange={(v) => onChange({ ...item, op: v as ConditionOp })}
            options={opOptions(t)}
          />
          <Input value={item.value || ''} onChange={(e) => onChange({ ...item, value: e.target.value })}
            placeholder={t('agentFlows.inspector.value')} />
        </div>
      </Field>
      <HintText>{t('agentFlows.inspector.caseHint')}</HintText>
    </div>
  );
}


export function Advanced({
  name, title, subtitle, children,
}: { name: string; title: string; subtitle?: string; children: React.ReactNode }) {
  const key = `appbi.flowinspector.adv.${name}`;
  const [open, setOpen] = React.useState(() => {
    try { return window.localStorage.getItem(key) === '1'; } catch { return false; }
  });
  const toggle = () => setOpen((v) => {
    try { window.localStorage.setItem(key, v ? '0' : '1'); } catch { /* private mode */ }
    return !v;
  });
  return (
    <div className="mt-4 border-t border-[rgb(var(--border-line))] pt-3">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="min-w-0">
          <SectionTitle>{title}</SectionTitle>
          {!open && subtitle && (
            <span className="block text-caption leading-snug text-text-tertiary">{subtitle}</span>
          )}
        </span>
        <span className="ml-2 flex-shrink-0 text-tiny text-text-tertiary">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

/** Fold for searching: lowercase, accents removed, so "nguyen nhan" finds
 *  "nguyên nhân". An author who types without diacritics is the common case, and
 *  a search that fails them silently is worse than no search. */
