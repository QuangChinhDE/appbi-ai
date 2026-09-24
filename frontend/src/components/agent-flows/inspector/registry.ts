import React from 'react';
/**
 * Node type -> its editor.
 *
 * The shell looks the type up here instead of running fourteen
 * `node.type === 'x' &&` branches in one render. Adding a node type is adding a
 * file in `editors/` and a line here; nothing in the shell has to grow.
 *
 * A type with no entry renders no type-specific fields, which is the same thing
 * the old switch did by falling through — it is not an error state.
 */
import type { NodeEditorProps } from './types';
import { AgentEditor } from './editors/agent';
import { ToolEditor } from './editors/tool';
import { SkillEditor } from './editors/skill';
import { ReportReadEditor } from './editors/report_read';
import { KnowledgeEditor } from './editors/knowledge';
import { WebEditor } from './editors/web';
import { IfEditor } from './editors/if';
import { SwitchEditor } from './editors/switch';
import { CoordinateEditor } from './editors/coordinate';
import { LoopEditor } from './editors/loop';
import { FilterEditor } from './editors/filter';
import { SetVarEditor } from './editors/set_var';
import { TransformEditor } from './editors/transform';
import { StopEditor } from './editors/stop';
import { DelayEditor } from './editors/delay';

export const NODE_EDITORS: Record<string, React.ComponentType<NodeEditorProps>> = {
  agent: AgentEditor,
  tool: ToolEditor,
  skill: SkillEditor,
  report_read: ReportReadEditor,
  knowledge: KnowledgeEditor,
  web: WebEditor,
  if: IfEditor,
  switch: SwitchEditor,
  coordinate: CoordinateEditor,
  loop: LoopEditor,
  filter: FilterEditor,
  set_var: SetVarEditor,
  transform: TransformEditor,
  stop: StopEditor,
  delay: DelayEditor,
};
