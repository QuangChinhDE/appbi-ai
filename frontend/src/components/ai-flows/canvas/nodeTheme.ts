/**
 * Semantic colours and icons for flow nodes.
 *
 * Colour carries meaning here — blue = system, purple = AI, teal = reads data,
 * green = deterministic check, orange = control flow — but it is NEVER the only
 * carrier: every node also shows an icon and a type label, so the canvas stays
 * readable for colour-blind users and in a screenshot.
 */
import type { LucideIcon } from 'lucide-react';
import {
  Bot, Braces, CheckCircle2, Compass, Cpu, Flag, GitBranch, HelpCircle,
  Layers, Library, Shield, ShieldCheck, Wrench,
} from 'lucide-react';

export type NodeFamily = 'system' | 'agent' | 'data' | 'check' | 'control';

export interface NodeTheme {
  family: NodeFamily;
  icon: LucideIcon;
  /** Card border + header tint. */
  border: string;
  headerBg: string;
  iconBg: string;
  iconFg: string;
  /** True when running this step calls a paid model. */
  usesLlm: boolean;
}

const SYSTEM: Omit<NodeTheme, 'icon' | 'usesLlm'> = {
  family: 'system',
  border: 'border-[#B8CCF0]',
  headerBg: 'bg-[#EAF2FF]',
  iconBg: 'bg-[#2459C4]',
  iconFg: 'text-white',
};
const AGENT: Omit<NodeTheme, 'icon' | 'usesLlm'> = {
  family: 'agent',
  border: 'border-[#CBB8F5]',
  headerBg: 'bg-[#F1ECFF]',
  iconBg: 'bg-[#7047D7]',
  iconFg: 'text-white',
};
const DATA: Omit<NodeTheme, 'icon' | 'usesLlm'> = {
  family: 'data',
  border: 'border-[#9EDCE1]',
  headerBg: 'bg-[#E8FAFA]',
  iconBg: 'bg-[#0E9AA3]',
  iconFg: 'text-white',
};
const CHECK: Omit<NodeTheme, 'icon' | 'usesLlm'> = {
  family: 'check',
  border: 'border-[#A5DCC2]',
  headerBg: 'bg-[#E9F8F0]',
  iconBg: 'bg-[#22A06B]',
  iconFg: 'text-white',
};
const CONTROL: Omit<NodeTheme, 'icon' | 'usesLlm'> = {
  family: 'control',
  border: 'border-[#F2C795]',
  headerBg: 'bg-[#FFF3E6]',
  iconBg: 'bg-[#E77713]',
  iconFg: 'text-white',
};

export const NODE_THEME: Record<string, NodeTheme> = {
  guard: { ...SYSTEM, icon: Shield, usesLlm: false },
  end: { ...SYSTEM, icon: Flag, usesLlm: false },
  route: { ...CONTROL, icon: GitBranch, usesLlm: false },
  condition: { ...CONTROL, icon: Compass, usesLlm: false },
  parallel: { ...CONTROL, icon: Layers, usesLlm: false },
  clarify: { ...CONTROL, icon: HelpCircle, usesLlm: false },
  context: { ...DATA, icon: Library, usesLlm: false },
  tool: { ...DATA, icon: Wrench, usesLlm: false },
  agent: { ...AGENT, icon: Bot, usesLlm: true },
  legacy: { ...AGENT, icon: Cpu, usesLlm: true },
  function: { ...CHECK, icon: Braces, usesLlm: false },
  verify: { ...CHECK, icon: ShieldCheck, usesLlm: false },
};

export const FALLBACK_THEME: NodeTheme = {
  ...SYSTEM, icon: CheckCircle2, usesLlm: false,
};

export function themeFor(type: string): NodeTheme {
  return NODE_THEME[type] ?? FALLBACK_THEME;
}

/** Steps the author may never remove — the runtime's guarantees rest on them. */
export const LOCKED_TYPES = new Set(['guard', 'end']);

export type PreviewStatus =
  | 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export const PREVIEW_RING: Record<PreviewStatus, string> = {
  pending: '',
  running: 'ring-2 ring-[#7047D7] ring-offset-2 animate-pulse',
  completed: 'ring-2 ring-[#22A06B] ring-offset-2',
  failed: 'ring-2 ring-[#D92D20] ring-offset-2',
  skipped: 'opacity-50',
};
