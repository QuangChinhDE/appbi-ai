// The report_read step's own editor. Extracted verbatim from `NodeForm`; the
// registry in `../registry.ts` is what reaches it, so a new node type adds a
// file here instead of another branch in a 695-line switch.
import React from 'react';
import { Textarea } from '@/components/ui/Input';
import { HintText } from '../../shared';
import { Field, NumberField, Select, Toggle } from '../fields';
import { useI18n } from '@/providers/LanguageProvider';
import type { NodeEditorProps } from '../types';
import type {
  Condition, ConditionOp, FlowNode, FlowPath, SwitchCase, ToolInput, ReportReadNode,
} from '@/lib/agentFlows';
import { MAX_LOOP_ITERATIONS, MAX_TOOL_CALLS } from '@/lib/agentFlows';


export function ReportReadEditor(props: NodeEditorProps) {
  const { t, language } = useI18n();
  const { set, spec, toolPacks, providers, attachable, brainKey,
    flowType, isAnswerNode, seeing, setSeeing } = props;
  // NARROWED HERE, because the registry is what guarantees it. Inside the old
  // `NodeForm` the `node.type === 'report_read' &&` guard narrowed the union for
  // free; a file reached only through `NODE_EDITORS.report_read` has the same
  // guarantee from a different place, and says so once instead of per field.
  const node = props.node as ReportReadNode;
  void language; void spec; void toolPacks; void providers; void attachable;
  void brainKey; void flowType; void isAnswerNode; void seeing; void setSeeing;
  return (
    <>
{(() => {
        // `index` never calls either read tool - it describes each chart from the
        // configuration the run already holds. The two toggles under it are inert
        // in that mode, so they say so rather than lying quietly.
        const indexed = (node.detail ?? 'compact') === 'index';
        return (
        <>
          {/* WHICH CHARTS, before how much of each. Reading everything the binding
              allows is what this step did with no way to say otherwise, and on a
              seventy-chart report that is twenty charts fetched so the first six or
              seven can survive the cut into the next step. */}
          <Field label={t('agentFlows.inspector.read.scope')}>
            <div className="rounded-lg border border-[rgb(var(--border-line))] px-2.5">
              <Toggle on={node.match_question === true}
                title={t('agentFlows.inspector.read.matchQuestion')}
                hint={t('agentFlows.inspector.read.matchQuestionHint')}
                onChange={(v) => set({ match_question: v } as Partial<FlowNode>)} />
            </div>
          </Field>
          {node.match_question && (
            <Field label={t('agentFlows.inspector.read.matchOn')}
              hint={t('agentFlows.inspector.read.matchOnHint')}>
              <Textarea rows={2} value={node.query || ''}
                onChange={(e) => set({ query: e.target.value } as Partial<FlowNode>)} />
            </Field>
          )}
          <Field label={t('agentFlows.inspector.read.maxCharts')}
            hint={t('agentFlows.inspector.read.maxChartsHint')}>
            <NumberField min={1} max={50} value={node.max_charts ?? 20}
              onCommit={(n) => set({ max_charts: n } as Partial<FlowNode>)} />
          </Field>

          <Field label={t('agentFlows.inspector.read.detail')}
            hint={t('agentFlows.inspector.read.detail.' + (node.detail ?? 'compact') + 'Hint')}>
            <Select value={node.detail ?? 'compact'}
              onChange={(v) => set({ detail: v as 'index' | 'compact' | 'full' } as Partial<FlowNode>)}
              options={[
                { value: 'index', label: t('agentFlows.inspector.read.detail.index') },
                { value: 'compact', label: t('agentFlows.inspector.read.detail.compact') },
                { value: 'full', label: t('agentFlows.inspector.read.detail.full') },
              ]} />
          </Field>

          <Field label={t('agentFlows.inspector.readWhat')}>
            <div className="rounded-lg border border-[rgb(var(--border-line))] px-2.5">
              <Toggle on={node.include_summary !== false} disabled={indexed}
                title={t('agentFlows.inspector.read.summary')}
                hint={indexed ? t('agentFlows.inspector.read.indexIgnores')
                              : t('agentFlows.inspector.read.summaryHint')}
                onChange={(v) => set({ include_summary: v } as Partial<FlowNode>)} />
              <Toggle on={node.include_data !== false} disabled={indexed}
                title={t('agentFlows.inspector.read.data')}
                hint={indexed ? t('agentFlows.inspector.read.indexIgnores')
                              : t('agentFlows.inspector.read.dataHint')}
                onChange={(v) => set({ include_data: v } as Partial<FlowNode>)} />
              <Toggle on={node.include_filters !== false} title={t('agentFlows.inspector.read.filters')}
                hint={t('agentFlows.inspector.read.filtersHint')}
                onChange={(v) => set({ include_filters: v } as Partial<FlowNode>)} />
            </div>
          </Field>
          {!indexed && node.include_data !== false && (
            <Field label={t('agentFlows.inspector.maxRows')}
              hint={t('agentFlows.inspector.read.maxRowsHint')}>
              <NumberField min={1} max={5000} value={node.max_rows ?? 200}
                onCommit={(n) => set({ max_rows: n } as Partial<FlowNode>)} />
            </Field>
          )}
          <HintText>
            {t('agentFlows.inspector.reportReadHint')}
          </HintText>
        </>
        );
      })()}
    </>
  );
}
