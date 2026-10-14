/** What every node editor is handed.
 *
 *  One shape for all fourteen, so the shell does not have to know which editor
 *  wants what — and so adding a field is one change rather than fourteen. */
import type {
  AgentRole, Attachable, FlowNode, FlowType, NodeSpec, ProviderGroup, SkillSummary, ToolPack,
} from '@/lib/agentFlows';

export interface NodeEditorProps {
  node: FlowNode;
  /** Merge a patch into the node. The editors never rebuild the node themselves;
   *  that was true before the split and is what makes them interchangeable. */
  set: (patch: Partial<FlowNode>) => void;
  spec?: NodeSpec;
  toolPacks: ToolPack[];
  /** Published Skills this author may attach. */
  skills: SkillSummary[];
  /** Specialized Agent roles, as the server defines them. */
  roles: AgentRole[];
  /** Steps before this one that produce a result (for "reads from"). */
  earlierSteps: EarlierStep[];
  providers: ProviderGroup[];
  attachable: Attachable | null;
  flowType: FlowType;
  brainKey: string;
  isAnswerNode: boolean;
  seeing: boolean;
  setSeeing: (v: boolean) => void;
}

export interface EarlierStep { key: string; name: string; type: string }
