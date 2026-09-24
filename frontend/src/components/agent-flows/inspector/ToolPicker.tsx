/**
 * Granting tools to a step: the picker, its search, and the argument editor.
 *
 * Extracted whole from `NodeInspector.tsx`. It is one concern — what a step is
 * allowed to call — and it is the largest thing the Agent editor renders, so
 * leaving it inline is most of why that file was unreadable.
 */
// AUTO-EXTRACTED FROM NodeInspector.tsx — see that file's header for why.
import React from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { Input, Textarea } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import type { ToolInput, ToolPack, FlowNode } from '@/lib/agentFlows';
import { SectionTitle, HintText, CostChip, COST_HINT_KEY } from '../shared';
import { Field, Select, Toggle, NumberField } from './fields';

export const PAYLOAD_LABEL_KEY: Record<string, string> = {
  medium: 'agentFlows.payload.medium',
  large: 'agentFlows.payload.large',
  scales_with_report: 'agentFlows.payload.scalesWithReport',
};

export const PAYLOAD_HINT_KEY: Record<string, string> = {
  medium: 'agentFlows.payloadHint.medium',
  large: 'agentFlows.payloadHint.large',
  scales_with_report: 'agentFlows.payloadHint.scalesWithReport',
};

export function toolPackLabel(pack: ToolPack, language: 'en' | 'vi') {
  return (language === 'vi' ? pack.label_vi : pack.label_en) || pack.label_vi || pack.label_en;
}


/** The arguments of one tool, each bound to a variable or a literal.
 *
 *  The list of arguments is READ FROM THE TOOL rather than typed by the author:
 *  a free-text argument name is a misspelling waiting to reach a viewer, and the
 *  registry already knows what the tool takes. */
export function ToolArguments({
  tool, packs, value, onChange,
}: {
  tool: string;
  packs: ToolPack[];
  value: Record<string, ToolInput>;
  onChange: (v: Record<string, ToolInput>) => void;
}) {
  const { t } = useI18n();
  const spec = packs.flatMap((p) => p.tools).find((s) => s.name === tool);
  const args = Object.entries(spec?.inputs || {});

  if (!spec) {
    return <HintText>{t('agentFlows.inspector.tool.unknown')}</HintText>;
  }
  if (!args.length) {
    return <HintText>{t('agentFlows.inspector.tool.noArgs')}</HintText>;
  }

  const bind = (name: string, next: ToolInput) =>
    onChange({ ...value, [name]: next });

  return (
    <Field label={t('agentFlows.inspector.tool.args')}>
      <div className="space-y-2 rounded-lg border border-[rgb(var(--border-line))] p-2.5">
        {args.map(([name, meta]) => {
          const cur = value[name] || { source: 'literal' as const, value: '' };
          const required = Boolean(meta?.required);
          return (
            <div key={name} className="space-y-1">
              <div className="flex items-baseline gap-1.5">
                <code className="text-caption font-medium text-text-primary">{name}</code>
                {required && (
                  <span className="text-caption text-danger">
                    {t('agentFlows.inspector.tool.required')}
                  </span>
                )}
                <span className="text-caption text-text-tertiary">{meta?.type}</span>
              </div>
              <div className="flex gap-1.5">
                <Select
                  className="h-8 w-28 flex-shrink-0"
                  value={cur.source}
                  onChange={(v) => bind(name, v === 'variable'
                    ? { source: 'variable', ref: cur.ref || '' }
                    : { source: 'literal', value: cur.value ?? '' })}
                  options={[
                    { value: 'literal', label: t('agentFlows.inspector.tool.literal') },
                    { value: 'variable', label: t('agentFlows.inspector.tool.variable') },
                  ]} />
                {cur.source === 'variable' ? (
                  <Input
                    value={cur.ref || ''}
                    placeholder="ten_bien"
                    onChange={(e) => bind(name, { source: 'variable', ref: e.target.value })} />
                ) : (
                  <Input
                    value={String(cur.value ?? '')}
                    onChange={(e) => bind(name, { source: 'literal', value: e.target.value })} />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Field>
  );
}

export function toolPackPurpose(pack: ToolPack, language: 'en' | 'vi') {
  return language === 'vi' ? pack.purpose_vi : undefined;
}

export function toolLabel(tool: ToolPack['tools'][number], language: 'en' | 'vi') {
  return (language === 'vi' ? tool.label_vi : tool.label_en) || tool.label_vi || tool.label_en;
}

/** The tool picker.
 *
 *  Grouped by pack, because a pack is now a KIND of question rather than a file
 *  the bodies happened to share: understand the report, get a figure, compare,
 *  diagnose, project, look something up, leave the app. An author scanning for a
 *  comparison tool reads three, not eleven.
 *
 *  Three things are surfaced per tool that were not before, each because an
 *  author cannot make a good grant without it:
 *
 *  `CostChip`      — the picker was the one place a cost class was never shown,
 *                    so a step could be granted five `expensive` tools without
 *                    anything on screen saying so.
 *  "không cần AI"  — the tool answers on its own. Wiring one of these to a node
 *                    costs no tokens at all, and that is invisible from a name.
 *  `answers_vi`    — a real question it settles. Two tools whose names both sound
 *                    right are told apart by their examples far faster than by
 *                    their descriptions.
 *
 *  `returns` goes in the title attribute rather than on screen: it matters when
 *  wiring a result into the next node, which is a different moment from choosing
 *  what to grant, and putting it inline turned a scannable list into a datasheet.
 */
/** A section an author opens when they need it, and never sees when they do not.
 *
 *  Measured before this existed: one AI step showed 59 controls across 11 sections
 *  on a flat 3.2-screen scroll, with nothing marking which four a first flow
 *  actually needs. The complaint this answers is not "too many settings" — the
 *  settings are all real — it is that a beginner and an expert were shown the same
 *  wall, so neither could tell where to start.
 *
 *  Open state is remembered per section name, not per step: an author who works in
 *  the model picker wants it open on the NEXT step too, and re-opening it for every
 *  node is the kind of small tax that makes a tool feel hostile.
 */

export function foldSearch(s: string) {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/** Everything about a tool an author might type at it.
 *
 *  `answers_vi` is in here and it is the point. Every tool carries example
 *  questions, and an author looking for a tool thinks in questions — "vì sao
 *  giảm", "top mấy" — long before they think in tool names. Matching names only
 *  would make the box work for people who already know the answer. */
export function toolHaystack(tool: ToolPack['tools'][number]) {
  /* The server's `search_text` when it sends one: ONE definition of what a tool
   * can be found by, shared with the runtime's capability discovery. The local
   * list is the fallback for an older backend. */
  return foldSearch(tool.search_text || [
    tool.name, tool.label_vi, tool.label_en, tool.description_vi,
    ...(tool.answers_vi || []),
  ].filter(Boolean).join(' '));
}

export function packHaystack(pack: ToolPack) {
  return foldSearch([pack.key, pack.label_vi, pack.label_en, pack.purpose_vi]
    .filter(Boolean).join(' '));
}

export function ToolPicker({
  packs, granted, onToggle,
}: { packs: ToolPack[]; granted: string[]; onToggle: (name: string, on: boolean) => void }) {
  const { t, language } = useI18n();
  const [query, setQuery] = React.useState('');
  /* EVERY WORD, NOT THE WHOLE PHRASE.
   *
   *  This was one `includes(needle)` on the joined query, and driving the panel
   *  by hand found the hole immediately: `rank_values` carries the example
   *  question "Danh mục nào doanh thu cao nhất?", and typing "danh muc nao cao
   *  nhat" matched nothing — the words are all there, just not adjacent. An
   *  author paraphrasing their own question is the normal case, so a contiguous
   *  match makes the box work only for people who already know the wording.
   *
   *  AND across words rather than OR: two words should narrow, not widen. */
  const needles = foldSearch(query.trim()).split(/\s+/).filter(Boolean);
  const hits = (hay: string) => needles.filter((w) => hay.includes(w)).length;

  /* WHAT A SEARCH DOES TO A PACK, in three states rather than two.
   *
   *  A pack whose OWN name matches ("chẩn đoán") keeps all its tools: the author
   *  asked for the category, and hiding its contents behind a second match would
   *  answer a category question with a fragment. A pack where only some tools
   *  match shows those. A pack with neither disappears.
   *
   *  Grants survive filtering — a hidden tool stays granted. The box narrows what
   *  is VISIBLE, never what is on, because a search that silently revoked a grant
   *  would be the most expensive kind of surprise in this panel. */
  /* PRECISE WHEN IT CAN BE, FORGIVING WHEN IT CANNOT.
   *
   *  Requiring every word was right until a real paraphrase hit it. The coverage
   *  panel in the test drawer suggests "Số liệu cập nhật tới hôm nào?"; the tool
   *  that answers it carries "Số liệu tính đến khi nào?". Same question, three
   *  words in common, and an AND search found nothing — the product suggesting a
   *  question its own picker could not resolve.
   *
   *  So: if anything matches EVERY word, show only those, because the author was
   *  specific and deserves a short list. Otherwise fall back to whatever shares
   *  the most words. The second mode is what makes a paraphrase work, and it can
   *  only widen a result that would otherwise have been empty. */
  const scorePack = (pack: ToolPack, min: number) => {
    if (hits(packHaystack(pack)) >= min) return pack;
    const tools = pack.tools
      .map((tool) => ({ tool, n: hits(toolHaystack(tool)) }))
      .filter((x) => x.n >= min)
      .sort((a, b) => b.n - a.n)
      .map((x) => x.tool);
    return tools.length ? { ...pack, tools } : null;
  };
  const strict = needles.length
    ? packs.map((p) => scorePack(p, needles.length)).filter((p): p is ToolPack => p !== null)
    : packs;
  /* THE FALLBACK HAS TO CALIBRATE ITSELF.
   *
   *  A fixed floor of one word answered "so lieu cap nhat toi hom nao" with 35 of
   *  36 tools — every tool containing "so" or "nao" — which is not a search
   *  result, it is the list again. So the floor is the BEST score anything
   *  achieved: if the closest tool shares three words, only the three-word
   *  matches show. Short lists when the wording is close, and no tuning constant
   *  to go stale as the catalogue grows. */
  const best = needles.length
    ? Math.max(0, ...packs.flatMap((p) => [
        hits(packHaystack(p)), ...p.tools.map((tool) => hits(toolHaystack(tool))),
      ]))
    : 0;
  const shown = !needles.length || strict.length
    ? strict
    : best > 0
      ? packs.map((p) => scorePack(p, best)).filter((p): p is ToolPack => p !== null)
      : [];
  const hitCount = shown.reduce((n, p) => n + p.tools.length, 0);
  const loose = Boolean(needles.length) && !strict.length && hitCount > 0;

  return (
    <div className="space-y-2">
      <div className="relative">
        <input
          id="agent-flow-tool-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('agentFlows.toolPicker.searchPlaceholder')}
          aria-label={t('agentFlows.toolPicker.searchLabel')}
          className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface px-2 py-1.5 text-caption outline-none focus:border-accent focus:ring-1 focus:ring-accent/30"
        />
      </div>
      {needles.length > 0 && (
        <p className="px-0.5 text-caption text-text-tertiary">
          {hitCount === 0
            ? t('agentFlows.toolPicker.searchEmpty')
            : loose
              ? t('agentFlows.toolPicker.searchLoose', { count: String(hitCount) })
              : t('agentFlows.toolPicker.searchHits', { count: String(hitCount) })}
        </p>
      )}
      {shown.map((pack) => {
        const names = pack.tools.map((t) => t.name);
        /* A PACK WITH NOTHING GRANTED IS A HEADING, NOT A LIST.
         *
         * All eight packs rendered expanded, so the picker was 36 checkboxes tall
         * on every step — the single largest block in a panel that already ran 3.2
         * screens. Six of those eight are usually untouched, and an author scrolls
         * past ninety rows to reach the setting under them.
         *
         * Collapsed means one line that still says what the pack is FOR, so the
         * catalogue stays browsable; a search expands whatever matches, because a
         * search is the author saying they want to look inside. */
        const anyGranted = names.some((n) => granted.includes(n));
        // Counted over the tools ON SCREEN. While a search is active those are
        // the only ones "select all" can reach, so a badge counting the whole
        // pack would promise a bulk action the button does not perform.
        const onCount = names.filter((n) => granted.includes(n)).length;
        const allOn = onCount === names.length && names.length > 0;
        return (
          <PackBlock
            key={pack.key}
            openByDefault={anyGranted || needles.length > 0}
            header={({ open, toggle }) => (
            <div className="bg-surface-2/40 px-2 py-1.5">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={toggle}
                  aria-expanded={open}
                  className="flex min-w-0 items-center gap-1.5 text-left"
                >
                  <span className="w-2 flex-shrink-0 text-tiny text-text-tertiary">
                    {open ? '−' : '+'}
                  </span>
                  <b className="text-caption font-strong">{toolPackLabel(pack, language)}</b>
                </button>
                {onCount > 0 && (
                  <span className="rounded bg-accent/10 px-1 text-tiny text-accent">
                    {onCount}/{names.length}
                  </span>
                )}
                {pack.gated_by_link && (
                  <span title={language === 'vi' ? pack.gate_note_vi : t('agentFlows.toolPicker.byLink')}
                    className="rounded border border-warning/25 bg-warning/5 px-1 text-tiny text-warning">
                    {t('agentFlows.toolPicker.byLink')}
                  </span>
                )}
                <button type="button"
                  className="ml-auto text-micro text-text-tertiary underline-offset-2 hover:underline"
                  onClick={() => names.forEach((n) => onToggle(n, !allOn))}>
                  {allOn ? t('agentFlows.toolPicker.clearAll') : t('agentFlows.toolPicker.selectAll')}
                </button>
              </div>
              {/* ONLY WHILE OPEN. This paragraph tells you how to choose AMONG the
                  tools inside; it says nothing useful while you are scanning the
                  list of packs. Rendered for all eight at rest it was most of the
                  panel's text, which is what forced the type down to 10px in the
                  first place — and the space it gives back is what pays for prose
                  at a readable size. */}
              {open && toolPackPurpose(pack, language) && (
                <p className="mt-1 text-caption leading-snug text-text-tertiary">{toolPackPurpose(pack, language)}</p>
              )}
            </div>
            )}
          >
            <div className="p-1.5">
              {pack.tools.map((tool) => {
                const on = granted.includes(tool.name);
                const description = language === 'vi' ? tool.description_vi : '';
                const example = language === 'vi' ? tool.answers_vi?.[0] : undefined;
                const returns = language === 'vi' && tool.returns
                  ? Object.entries(tool.returns).map(([k, v]) => `${k}: ${v}`).join('\n')
                  : '';
                /* A CHIP MARKS AN EXCEPTION, NOT A PROPERTY.
                 *
                 * Every tool carried three chips, so one panel rendered 75 of
                 * them drawn from 9 distinct labels: "ready-to-use number" on 20
                 * rows, "query" on 18, "light" on 11. Measured over the
                 * catalogue, those are the NORMS — `cheap` + `data_query` is 81%
                 * of tools and `self_sufficient` is 56%, a majority. A badge on
                 * the majority distinguishes nothing; it only costs the author
                 * the attention they need for the row that IS unusual.
                 *
                 * So a chip survives only where it changes a decision: the call
                 * leaves AppBI, it runs several queries, its result is large, or
                 * its size grows with the report. Nothing is lost — every fact
                 * still reaches the author through the row's tooltip. */
                const facts = [
                  t(COST_HINT_KEY[tool.cost_class] || COST_HINT_KEY.cheap),
                  tool.payload ? t(PAYLOAD_HINT_KEY[tool.payload]) : '',
                  tool.self_sufficient ? t('agentFlows.toolPicker.selfSufficientTitle') : '',
                  returns ? t('agentFlows.toolPicker.returnsTitle', { returns }) : '',
                ].filter(Boolean).join('\n\n');
                const loud = tool.cost_class === 'external' || tool.cost_class === 'expensive';
                const bigPayload = tool.payload === 'large' || tool.payload === 'scales_with_report';
                return (
                  <label key={tool.name}
                    title={facts || undefined}
                    className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-surface-2">
                    <input type="checkbox" checked={on} className="mt-0.5"
                      onChange={(e) => onToggle(tool.name, e.target.checked)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1">
                        <b className="text-caption font-medium">{toolLabel(tool, language)}</b>
                        {loud && <CostChip cost={tool.cost_class} />}
                        {bigPayload && tool.payload && (
                          <span
                            title={t(PAYLOAD_HINT_KEY[tool.payload])}
                            className={cn(
                              'rounded border px-1 text-tiny',
                              tool.payload === 'scales_with_report'
                                ? 'border-warning/25 bg-warning/5 text-warning'
                                : 'border-[rgb(var(--border-line))] text-text-tertiary',
                            )}>
                            {t(PAYLOAD_LABEL_KEY[tool.payload])}
                          </span>
                        )}
                      </span>
                      {description && (
                        <span className="block text-caption leading-snug text-text-tertiary">
                          {description}
                        </span>
                      )}
                      {example && (
                        <span className="block text-caption leading-snug text-text-tertiary/70">
                          {t('agentFlows.toolPicker.example', { example })}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </PackBlock>
        );
      })}
    </div>
  );
}

/** One tool pack: a heading that is always readable, and a body that is not always
 *  open. Controlled by the picker rather than self-managed, because "has a grant"
 *  and "matches the search" are the picker's facts — a self-opening block would
 *  need both passed in anyway, and would then disagree with them after a toggle. */
export function PackBlock({
  header, openByDefault, children,
}: {
  header: (o: { open: boolean; toggle: () => void }) => React.ReactNode;
  openByDefault: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(openByDefault);
  const wasDefault = React.useRef(openByDefault);
  /* Follow the default when the REASON changes — a search starting, or the first
     grant landing in an untouched pack — but never fight a deliberate toggle. */
  React.useEffect(() => {
    if (wasDefault.current !== openByDefault) {
      wasDefault.current = openByDefault;
      setOpen(openByDefault);
    }
  }, [openByDefault]);
  return (
    <div className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))]">
      {/* NOT a button around the header: the header already holds "select all",
          and nesting interactive elements makes the inner one unreachable — the
          kind of defect that passes a type-check and fails a keyboard. The
          disclosure control is passed INTO the header instead, so it sits beside
          that button rather than around it. */}
      <div className="border-b border-[rgb(var(--border-line))]">
        {header({ open, toggle: () => setOpen((v) => !v) })}
      </div>
      {open && children}
    </div>
  );
}

/** "What the AI sees" — the screen the builder never had.
 *
 *  An author configures eleven sections for one step and, until this, nothing
 *  showed the result. The rule that governs all of them lived in a single line of
 *  helper text: your instructions are APPENDED to a base prompt. So the model had
 *  to be inferred from field names, and the product's standing complaint is that
 *  nobody can tell how a flow will behave before running it.
 *
 *  The fact this screen exists to deliver is measurable and surprising: in the
 *  answering step of the demo flow the author's 438 characters sit inside 8,976 —
 *  five percent. In a specialist, 445 of 640 — seventy. Same product, same author,
 *  opposite writing problems, and no way to know which one you were in.
 *
 *  Nothing is called and nothing is spent: the backend assembles the inputs with
 *  the same three functions a run uses and stops.
 */
