'use client';

/**
 * The flow canvas: a tree drawn top-down, the way the flow actually executes.
 *
 * WHY A TREE AND NOT A FREE CANVAS
 * --------------------------------
 * Branch bodies are nested, and a branch that ends simply continues with the next
 * sibling — so merging is implicit. That removes a whole class of pictures that
 * cannot run: no dangling edge, no orphan node, no accidental cycle. It also means
 * there is no layout to persist, so the canvas is a pure function of the flow.
 *
 * EDGES ARE VECTOR, AND DERIVED FROM THE TREE
 * -------------------------------------------
 * The connectors are SVG paths measured from the real DOM (`useFlowEdges`), not
 * CSS borders. Borders could only join things already adjacent in the layout, so
 * every branch needed its own bar and its own offsets, and a card growing one line
 * taller pulled the joins out of alignment. The tree says what connects; the DOM
 * says where it is.
 *
 * EVERY GAP IS AN INSERT POINT — AND A DROP ZONE
 * ----------------------------------------------
 * A "+" between two nodes knows its own destination (`containerPath` + index), so
 * adding inside Path B of an IF inside a Loop is the same gesture as adding at the
 * end — and dragging a node onto that same point moves it there.
 */
import React from 'react';
import { GripVertical, Plus } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import type { FlowNode, InsertTarget, NodeSpec } from '@/lib/agentFlows';
import { idBox, idInsert, idNode, idRule, useFlowEdges } from './useFlowEdges';
import type { MiniRect } from './Minimap';

export interface CanvasProps {
  nodes: FlowNode[];
  specs: Record<string, NodeSpec>;
  selectedKey: string | null;
  answerKey: string;
  onSelect: (key: string) => void;
  onInsert: (target: InsertTarget) => void;
  /** node key → runs in the coverage window. `0` marks a branch nobody reaches. */
  coverage?: Record<string, number>;
  running?: Record<string, 'running' | 'done' | 'error' | 'skipped' | 'reused'>;
  zoom?: number;
  /** Dragging is owned by the parent so undo can capture the move as one step. */
  onMove?: (key: string, target: InsertTarget) => void;
  canDropInto?: (key: string, containerPath: string) => boolean;
  /** Reports measured card positions so the minimap can draw the same shape the
   *  canvas is showing rather than a second guess at it. */
  onLayout?: (rects: MiniRect[]) => void;
}

type SharedProps = Omit<CanvasProps, 'nodes'> & {
  register: (id: string) => (el: HTMLElement | null) => void;
  drag: DragState;
  setDrag: (d: DragState) => void;
  t: (key: string, values?: Record<string, string | number>) => string;
  language: 'en' | 'vi';
};

interface DragState {
  key: string | null;
  x: number;
  y: number;
  over: InsertTarget | null;
}

const TONE: Record<string, string> = {
  ai: 'bg-brand/10 text-brand',
  data: 'bg-success/10 text-success',
  logic: 'bg-warning/10 text-warning',
  flow: 'bg-info/10 text-info',
  utility: 'bg-surface-2 text-text-secondary',
};

function specText(spec: NodeSpec, field: 'label' | 'description', language: 'en' | 'vi') {
  if (field === 'description') return spec.description_vi;
  return (language === 'vi' ? spec.label_vi : spec.label_en) || spec.label_vi || spec.label_en;
}

export function FlowCanvas(props: CanvasProps) {
  const { t, language } = useI18n();
  const { nodes, onInsert, zoom = 1, onMove, canDropInto, onLayout, ...rest } = props;
  const [drag, setDrag] = React.useState<DragState>({ key: null, x: 0, y: 0, over: null });

  const { register, paths, junctions, rects, size, stageRef, remeasure } = useFlowEdges(
    nodes, zoom, [props.selectedKey, drag.key],
  );

  // Pointer-driven drag. Hit-testing the real insert buttons rather than tracking a
  // parallel model of where they are: the drop target IS the "+" the author can see.
  React.useEffect(() => {
    if (!drag.key) return undefined;
    const move = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-drop]');
      const raw = el?.getAttribute('data-drop');
      let over: InsertTarget | null = null;
      if (raw) {
        const idx = raw.lastIndexOf('#');
        const containerPath = raw.slice(0, idx);
        const index = Number(raw.slice(idx + 1));
        if (!canDropInto || canDropInto(drag.key!, containerPath)) {
          over = { containerPath, index };
        }
      }
      setDrag((d) => ({ ...d, x: e.clientX, y: e.clientY, over }));
    };
    const up = () => {
      setDrag((d) => {
        if (d.key && d.over && onMove) onMove(d.key, d.over);
        return { key: null, x: 0, y: 0, over: null };
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [drag.key, onMove, canDropInto]);

  React.useEffect(() => { remeasure(); }, [nodes, zoom, remeasure]);
  React.useEffect(() => { onLayout?.(rects); }, [rects, onLayout]);

  const shared: SharedProps = { ...rest, onInsert, zoom, onMove, canDropInto, register, drag, setDrag, t, language };

  return (
    <div
      ref={stageRef}
      style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
      className={cn(
        'relative flex min-w-[860px] flex-col items-center px-10 pb-24 pt-6',
        drag.key && 'select-none',
      )}
    >
      <svg
        aria-hidden
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${size.w} ${size.h}`}
        className="pointer-events-none absolute inset-0 z-0 overflow-visible"
      >
        {paths.map((p) => (
          <path
            key={p.key}
            d={p.d}
            fill="none"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            className="stroke-[rgb(var(--border-strong))]"
          />
        ))}
        {junctions.map((j) => (
          <circle
            key={j.key} cx={j.x} cy={j.y} r={3}
            className="fill-[rgb(var(--surface-1))] stroke-[rgb(var(--border-strong))]"
            strokeWidth={1.4}
          />
        ))}
      </svg>

      <SystemBand
        id="input" register={register}
        title="INPUT" hint={t('agentFlows.canvas.inputHint')}
      />
      <Gap />
      <Body nodes={nodes} containerPath="" {...shared} />
      <InsertPoint containerPath="" index={nodes.length} label={t('agentFlows.canvas.addEnd')} {...shared} />
      <Gap />
      <SystemBand
        id="output" register={register}
        title="OUTPUT" hint={t('agentFlows.canvas.outputHint')}
      />

      {drag.key && (
        <div
          className="pointer-events-none fixed z-[100] rounded-md border border-brand bg-surface-1 px-2 py-1 text-tiny shadow-linear-lg"
          style={{ left: drag.x + 12, top: drag.y + 12 }}
        >
          {drag.over ? t('agentFlows.canvas.dropHere') : t('agentFlows.canvas.dragToPlus')}
        </div>
      )}
    </div>
  );
}

/** Vertical spacing only. The line itself is drawn by the SVG layer. */
function Gap({ short = false }: { short?: boolean }) {
  return <div aria-hidden className={short ? 'h-5' : 'h-7'} />;
}

function SystemBand({
  id, register, title, hint,
}: {
  id: string; register: SharedProps['register']; title: string; hint: string;
}) {
  return (
    <div
      ref={register(id)}
      data-edge-id={id}
      className="relative z-10 w-[300px] rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-center"
    >
      <b className="text-tiny font-strong uppercase tracking-wide">{title}</b>
      <span className="mt-0.5 block text-tiny text-text-tertiary">{hint}</span>
    </div>
  );
}

/** A "+" that is also a drop target. One affordance, two gestures — the alternative
 *  is a separate "move here" marker that only appears while dragging, which means
 *  the author has to learn two maps of the same canvas. */
function InsertPoint({
  containerPath, index, label, onInsert, register, drag,
}: SharedProps & { containerPath: string; index: number; label: string }) {
  const active = drag.over?.containerPath === containerPath && drag.over?.index === index;
  return (
    <div className="relative z-10 flex h-8 items-center justify-center">
      <button
        type="button"
        data-drop={`${containerPath}#${index}`}
        data-edge-id={idInsert(containerPath, index)}
        ref={register(idInsert(containerPath, index))}
        onClick={() => onInsert({ containerPath, index })}
        title={label}
        aria-label={label}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full border bg-surface-1 shadow-linear-sm transition',
          active
            ? 'scale-125 border-brand bg-brand text-white'
            : drag.key
              ? 'border-brand/40 text-brand'
              : 'border-[rgb(var(--border-strong))] text-text-tertiary hover:border-brand hover:text-brand',
        )}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function NodeCard({
  node, spec, selected, isAnswer, onSelect, width, coverage, runState, register, drag, setDrag,
  draggable,
}: {
  node: FlowNode; spec?: NodeSpec; selected: boolean; isAnswer: boolean;
  onSelect: () => void; width: string; coverage?: number; runState?: string;
  register: SharedProps['register']; drag: DragState;
  setDrag: (d: DragState) => void; draggable: boolean;
}) {
  const { t, language } = useI18n();
  const specLabel = spec ? specText(spec, 'label', language) : '';
  const title = node.name || specLabel || node.type;
  const never = coverage === 0;
  return (
    <div
      ref={register(idNode(node.key))}
      data-edge-id={idNode(node.key)}
      style={{ width }}
      className={cn(
        'group relative z-10 rounded-lg border bg-surface-1 shadow-linear-sm transition',
        selected ? 'border-brand ring-[3px] ring-brand/10'
          : 'border-[rgb(var(--border-strong))] hover:border-brand/40',
        runState === 'running' && 'border-info ring-[3px] ring-info/10',
        runState === 'done' && 'border-success',
        runState === 'error' && 'border-danger',
        drag.key === node.key && 'opacity-40',
      )}
    >
      {draggable && (
        <button
          type="button"
          aria-label={t('agentFlows.canvas.dragHandle')}
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDrag({ key: node.key, x: e.clientX, y: e.clientY, over: null });
          }}
          className="absolute -left-6 top-3 cursor-grab p-1 text-text-quaternary opacity-0 transition group-hover:opacity-100"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      )}
      <button type="button" onClick={onSelect} className="w-full text-left">
        <div className="flex min-h-[44px] items-center gap-2 border-b border-[rgb(var(--border-line))] px-2.5 py-1.5">
          <span className={cn(
            'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-small',
            TONE[spec?.category || 'utility'],
          )}>
              {spec?.icon || '•'}
          </span>
          <span className="min-w-0 flex-1">
            <b className="block truncate text-caption font-strong">{title}</b>
            <span className="mt-px block text-tiny text-text-quaternary">
              {specLabel || node.type}
            </span>
          </span>
          {isAnswer && (
            <span className="rounded-full border border-success/20 bg-success/5 px-1.5 py-px text-tiny text-success">
              {t('agentFlows.common.output')}
            </span>
          )}
          {node.run_policy && node.run_policy !== 'every_turn' && (
            <span
              title={t('agentFlows.canvas.runPolicyTitle')}
              className="rounded-full border border-info/20 bg-info/5 px-1.5 py-px text-tiny text-info"
            >
              {node.run_policy === 'when_stale'
                ? t('agentFlows.canvas.runPolicy.whenStale')
                : t('agentFlows.canvas.runPolicy.oncePerSession')}
            </span>
          )}
          {spec?.costs_llm && (
            <span title={t('agentFlows.canvas.llmTitle')}
              className="rounded-full border border-brand/20 bg-brand/5 px-1.5 py-px text-tiny text-brand">
              LLM
            </span>
          )}
        </div>
        <div className="px-2.5 py-2">
          <p className="line-clamp-2 text-tiny leading-snug text-text-secondary">{describe(node, t)}</p>
          {(never || node.output_var) && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {node.output_var && (
                <span className="rounded border border-[rgb(var(--border-line))] bg-surface-2 px-1.5 py-px text-tiny text-text-tertiary">
                  {`→ {{${node.output_var}}}`}
                </span>
              )}
              {never && (
                <span title={t('agentFlows.canvas.neverTitle')}
                  className="rounded border border-warning/25 bg-warning/5 px-1.5 py-px text-tiny text-warning">
                  {t('agentFlows.canvas.neverLabel')}
                </span>
              )}
            </div>
          )}
        </div>
      </button>
    </div>
  );
}

/** One line saying what this node does, from its own configuration.
 *  Generated rather than authored so it cannot go stale when a setting changes. */
function describe(node: FlowNode, t: (key: string, values?: Record<string, string | number>) => string): string {
  switch (node.type) {
    case 'agent':
      return node.prompt?.slice(0, 140) || t('agentFlows.canvas.describe.noPrompt');
    case 'report_read': {
      const parts = [
        node.include_summary && t('agentFlows.canvas.describe.summary'),
        node.include_data && t('agentFlows.canvas.describe.data'),
        node.include_filters && 'filter',
      ].filter(Boolean);
      return t('agentFlows.canvas.describe.reportRead', {
        parts: parts.join(', ') || t('agentFlows.canvas.describe.report'),
      });
    }
    case 'knowledge':
      return t('agentFlows.canvas.describe.knowledge', { count: node.knowledge?.length || 0, top: node.top_k ?? 5 });
    case 'web':
      return node.allowed_domains?.length
        ? t('agentFlows.canvas.describe.webLimited', { domains: node.allowed_domains.join(', ') })
        : t('agentFlows.canvas.describe.web');
    case 'if':
      return t('agentFlows.canvas.describe.if', { count: node.paths?.length || 0 });
    case 'switch':
      return t('agentFlows.canvas.describe.switch', {
        value: node.value,
        count: node.cases?.length || 0,
        fallback: node.has_fallback ? t('agentFlows.canvas.describe.fallbackSuffix') : '',
      });
    case 'coordinate':
      return t('agentFlows.canvas.describe.coordinate', {
        count: node.specialists?.length || 0,
        max: node.max_specialists ?? 3,
      });
    case 'loop':
      return t('agentFlows.canvas.describe.loop', {
        over: node.over,
        max: node.max_iterations ?? 10,
        item: `{{${node.item_var || 'item'}}}`,
      });
    case 'filter':
      return t('agentFlows.canvas.describe.filter', { count: node.conditions?.length || 0 });
    case 'set_var':
      return `{{${node.var}}} = ${node.value || t('agentFlows.canvas.describe.empty')}`;
    case 'transform':
      return `${node.operation} → {{${node.target || node.output_var || '?'}}}`;
    case 'stop':
      return node.message || t('agentFlows.canvas.describe.stop');
    case 'delay':
      return t('agentFlows.canvas.describe.delay', { seconds: node.seconds ?? 0 });
    default:
      return '';
  }
}

function RuleCard({
  id, register, label, title, subtitle, tone, onClick, selected,
}: {
  id: string; register: SharedProps['register'];
  label: string; title: string; subtitle: string;
  tone: 'ok' | 'neutral' | 'danger'; onClick: () => void; selected: boolean;
}) {
  return (
    <button
      type="button"
      ref={register(id)}
      data-edge-id={id}
      onClick={onClick}
      className={cn(
        'relative z-10 w-[280px] overflow-hidden rounded-lg border bg-surface-1 text-left transition',
        selected ? 'border-brand ring-[3px] ring-brand/10'
          : 'border-[rgb(var(--border-strong))] hover:border-brand/40',
      )}
    >
      <div className={cn(
        'flex h-8 items-center gap-1.5 border-b border-[rgb(var(--border-line))] px-2',
        tone === 'ok' && 'bg-success/5',
        tone === 'danger' && 'bg-danger/5',
        tone === 'neutral' && 'bg-surface-2',
      )}>
        <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-1 px-1.5 py-px text-tiny text-text-tertiary">
          {label}
        </span>
        <b className="truncate text-tiny font-strong">{title}</b>
      </div>
      {/* TWO LINES, ALWAYS — so lanes side by side start their bodies at the same
          height. A Switch's subtitle is "equals <value>" and fits on one; a
          specialist's is the author's own "when to use this one", which routinely
          wraps. With the height free, one lane's card sat 14px lower than its
          neighbour's and the row read as misaligned rather than parallel. Clamped
          as well as floored: a long `when` must not push the lanes apart either. */}
      <div className="px-2 py-1.5 text-tiny leading-snug text-text-secondary">
        {/* The floor is on the TEXT, not on the padded box. `min-h` measured
            against the box includes its own padding under `border-box`, so
            2.6em resolved to 26px — the height of ONE line plus the padding,
            which is what it was already. `leading-snug` is 1.375, so two lines
            is 2.75em exactly and stays right if the type scale moves. */}
        <div className="line-clamp-2 min-h-[2.75em]">{subtitle}</div>
      </div>
    </button>
  );
}

function Body({
  nodes, containerPath, ...rest
}: SharedProps & { nodes: FlowNode[]; containerPath: string }) {
  const { onInsert } = rest;
  if (!nodes.length) {
    return (
      <button
        type="button"
        data-drop={`${containerPath}#0`}
        onClick={() => onInsert({ containerPath, index: 0 })}
        className={cn(
          'relative z-10 my-1 w-[260px] rounded-lg border border-dashed px-3 py-3 text-caption transition',
          rest.drag.over?.containerPath === containerPath
            ? 'border-brand bg-brand/5 text-brand'
            : 'border-[rgb(var(--border-strong))] text-text-tertiary hover:border-brand hover:text-brand',
        )}
      >
        {rest.t('agentFlows.canvas.addBranch')}
      </button>
    );
  }
  return (
    <>
      {nodes.map((node, index) => (
        <React.Fragment key={node.key}>
          {index > 0 && (
            <InsertPoint containerPath={containerPath} index={index} label={rest.t('agentFlows.canvas.insertHere')} {...rest} />
          )}
          <NodeBlock node={node} containerPath={containerPath} {...rest} />
        </React.Fragment>
      ))}
    </>
  );
}

function NodeBlock({
  node, containerPath, ...rest
}: SharedProps & { node: FlowNode; containerPath: string }) {
  const { specs, selectedKey, answerKey, onSelect, onInsert, coverage, running, register, drag, setDrag } = rest;
  const spec = specs[node.type];
  const width = containerPath ? '280px' : '360px';

  const card = (
    <NodeCard
      node={node} spec={spec}
      selected={selectedKey === node.key}
      isAnswer={node.key === answerKey}
      onSelect={() => onSelect(node.key)}
      width={width}
      coverage={coverage?.[node.key]}
      runState={running?.[node.key]}
      register={register} drag={drag} setDrag={setDrag}
      draggable={!!rest.onMove}
    />
  );

  if (node.type === 'if' || node.type === 'switch' || node.type === 'coordinate') {
    const lanes = node.type === 'coordinate'
      // Drawn as lanes like a Switch, because that is what it is on the canvas:
      // parallel bodies, one per specialist. What differs is who chooses — a
      // model reading the question rather than a condition the author typed —
      // and the lane subtitle is that choice's only visible input, so it shows
      // `when` rather than an operator and a value.
      ? [
          ...(node.specialists || []).map((s) => ({
            key: s.key,
            label: rest.t('agentFlows.canvas.lane.specialist'),
            title: s.name || s.key,
            sub: s.when || rest.t('agentFlows.canvas.lane.specialistNoWhen'),
            tone: 'ok' as const,
            body: s.body || [],
            path: `${node.key}:specialist:${s.key}`,
            selKey: `${node.key}:specialist:${s.key}`,
          })),
          ...((node.fallback || []).length ? [{
            key: 'fallback',
            label: rest.t('agentFlows.canvas.lane.fallback'),
            title: rest.t('agentFlows.canvas.lane.fallback'),
            sub: rest.t('agentFlows.canvas.lane.noSpecialist'),
            tone: 'neutral' as const,
            body: node.fallback || [],
            path: `${node.key}:fallback:`,
            selKey: `${node.key}:fallback:`,
          }] : []),
        ]
      : node.type === 'if'
      ? node.paths.map((p) => ({
          key: p.key,
          label: p.kind === 'fallback' ? rest.t('agentFlows.canvas.lane.fallback') : rest.t('agentFlows.canvas.lane.condition'),
          title: p.name || p.key,
          sub: p.kind === 'fallback'
            ? rest.t('agentFlows.canvas.lane.fallbackIf')
            : rest.t('agentFlows.canvas.lane.matchSummary', {
                count: p.conditions?.length || 0,
                match: p.match === 'any' ? rest.t('agentFlows.canvas.lane.matchOne') : rest.t('agentFlows.canvas.lane.matchAll'),
              }),
          tone: (p.kind === 'fallback' ? 'neutral' : 'ok') as 'ok' | 'neutral',
          body: p.body || [],
          path: `${node.key}:path:${p.key}`,
          selKey: `${node.key}:path:${p.key}`,
        }))
      : [
          ...node.cases.map((c) => ({
            key: c.key, label: 'Case', title: c.label || c.key,
            sub: `${c.op || 'equals'} ${c.value ?? ''}`,
            tone: 'ok' as const, body: c.body || [],
            path: `${node.key}:case:${c.key}`, selKey: `${node.key}:case:${c.key}`,
          })),
          ...(node.has_fallback !== false ? [{
            key: 'fallback', label: rest.t('agentFlows.canvas.lane.fallback'), title: rest.t('agentFlows.canvas.lane.fallback'),
            sub: rest.t('agentFlows.canvas.lane.fallbackSwitch'),
            tone: 'neutral' as const, body: node.fallback || [],
            path: `${node.key}:fallback:`, selKey: `${node.key}:fallback:`,
          }] : []),
        ];

    return (
      <>
        {card}
        <Gap short />
        <div
          className="relative grid w-full gap-8 pt-6"
          style={{ gridTemplateColumns: `repeat(${Math.max(lanes.length, 1)}, minmax(0, 1fr))` }}
        >
          {lanes.map((lane) => (
            <div key={lane.key} className="relative flex min-w-0 flex-col items-center">
              <RuleCard
                id={idRule(node.key, lane.key)}
                register={register}
                label={lane.label}
                title={lane.title}
                subtitle={lane.sub}
                tone={lane.tone}
                selected={selectedKey === lane.selKey}
                onClick={() => onSelect(lane.selKey)}
              />
              <Gap short />
              <Body nodes={lane.body} containerPath={lane.path} {...rest} />
              <InsertPoint
                containerPath={lane.path} index={lane.body.length}
                label={rest.t('agentFlows.canvas.addToLane', { lane: lane.title })} {...rest}
              />
            </div>
          ))}
        </div>
        <MergeLabel />
      </>
    );
  }

  if (node.type === 'loop') {
    return (
      <>
        {card}
        <Gap short />
        <div
          ref={register(idBox(node.key))}
          data-edge-id={idBox(node.key)}
          className="relative z-10 flex w-[620px] flex-col items-center rounded-xl border border-brand/30 bg-brand/[0.02] px-4 pb-4"
        >
          <div className="-mx-4 flex h-9 w-[calc(100%+2rem)] items-center gap-2 border-b border-brand/15 px-3 text-tiny font-strong text-brand">
            ↻ Loop
            <span className="font-normal text-text-tertiary">
              {`${node.over} · item {{${node.item_var || 'item'}}}`}
            </span>
          </div>
          <div className="flex flex-col items-center pt-3">
            <Body nodes={node.body || []} containerPath={`${node.key}:body:`} {...rest} />
            <InsertPoint
              containerPath={`${node.key}:body:`} index={(node.body || []).length}
              label={rest.t('agentFlows.canvas.addLoop')} {...rest}
            />
          </div>
        </div>
      </>
    );
  }

  return card;
}

/** The lanes rejoin here. Labelled because "where do the branches go" is the first
 *  question anyone asks of a branching diagram, and a tree answers it silently. */
function MergeLabel() {
  const { t } = useI18n();
  return (
    <div className="relative z-10 flex h-11 w-full items-start justify-center pt-4">
      <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-px text-tiny text-text-quaternary">
        {t('agentFlows.canvas.merge')}
      </span>
    </div>
  );
}
