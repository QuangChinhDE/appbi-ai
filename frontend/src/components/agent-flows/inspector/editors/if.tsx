// The if step's own editor. Extracted verbatim from `NodeForm`; the
// registry in `../registry.ts` is what reaches it, so a new node type adds a
// file here instead of another branch in a 695-line switch.
import React from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { HintText } from '../../shared';
import { useI18n } from '@/providers/LanguageProvider';
import type { NodeEditorProps } from '../types';
import type {
  Condition, ConditionOp, FlowNode, FlowPath, SwitchCase, ToolInput, IfNode,
} from '@/lib/agentFlows';
import { MAX_LOOP_ITERATIONS, MAX_TOOL_CALLS } from '@/lib/agentFlows';


export function IfEditor(props: NodeEditorProps) {
  const { t, language } = useI18n();
  const { set, spec, toolPacks, providers, attachable, brainKey,
    flowType, isAnswerNode, seeing, setSeeing } = props;
  // NARROWED HERE, because the registry is what guarantees it. Inside the old
  // `NodeForm` the `node.type === 'if' &&` guard narrowed the union for
  // free; a file reached only through `NODE_EDITORS.if` has the same
  // guarantee from a different place, and says so once instead of per field.
  const node = props.node as IfNode;
  void language; void spec; void toolPacks; void providers; void attachable;
  void brainKey; void flowType; void isAnswerNode; void seeing; void setSeeing;
  return (
    <>
        <HintText>
          {t('agentFlows.inspector.ifHint')}
        </HintText>
        {/* A third (fourth…) path, added before the fallback so the fallback
            stays last — the order the engine evaluates them in. */}
        <Button
          variant="secondary" size="xs" className="mt-2" data-testid="add-path"
          onClick={() => {
            const taken = new Set(node.paths.map((p) => p.key));
            let n = node.paths.length + 1;
            while (taken.has(`path_${n}`)) n += 1;
            const fresh: FlowPath = {
              key: `path_${n}`, name: `${t('agentFlows.inspector.pathName')} ${n}`, kind: 'rules',
              match: 'all', conditions: [{ left: '{{question}}', op: 'contains', right: '' }], body: [],
            };
            const fb = node.paths.findIndex((p) => p.kind === 'fallback');
            const paths = fb < 0 ? [...node.paths, fresh]
              : [...node.paths.slice(0, fb), fresh, ...node.paths.slice(fb)];
            set({ paths } as Partial<FlowNode>);
          }}
        >
          <Plus className="h-3 w-3" /> {t('agentFlows.inspector.addPath')}
        </Button>
    </>
  );
}
