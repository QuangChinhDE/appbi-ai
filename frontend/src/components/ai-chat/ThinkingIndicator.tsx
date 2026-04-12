'use client';

/**
 * ThinkingIndicator — real-time AI activity panel.
 *
 * Phase UI improvements:
 * - Intent mode badge: shows LOOKUP / EXPLORE / INSIGHT / CREATE
 * - Richer step icons per tool category
 * - Better visual hierarchy for multi-step INSIGHT analysis
 * - Smoother collapse transition
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Brain, CheckCircle2, ChevronDown, ChevronUp, Loader2,
  Search, BarChart3, Database, Lightbulb, LayoutDashboard,
  FlaskConical, Zap, List,
} from 'lucide-react';
import type { ActivityStep, IntentType } from './types';

interface ActivityPanelProps {
  steps: ActivityStep[];
  isThinking: boolean;
  hasText: boolean;
  intent?: IntentType | null;
}

// ── Intent badge config ──────────────────────────────────────────────────────

const INTENT_CONFIG: Record<IntentType, { label: string; color: string; bg: string; border: string }> = {
  LOOKUP:  { label: '🔍 Tra cứu',       color: 'text-blue-700',   bg: 'bg-blue-50',   border: 'border-blue-200' },
  EXPLORE: { label: '🔬 Khám phá',      color: 'text-purple-700', bg: 'bg-purple-50', border: 'border-purple-200' },
  INSIGHT: { label: '💡 Phân tích sâu', color: 'text-amber-700',  bg: 'bg-amber-50',  border: 'border-amber-200' },
  CREATE:  { label: '🎨 Tạo biểu đồ',  color: 'text-green-700',  bg: 'bg-green-50',  border: 'border-green-200' },
  VAGUE:   { label: '❓ Làm rõ',        color: 'text-gray-600',   bg: 'bg-gray-50',   border: 'border-gray-200' },
};

// ── Tool-specific icons ───────────────────────────────────────────────────────

function ToolIcon({ toolLabel, status }: { toolLabel: string; status: 'running' | 'done' }) {
  const isRunning = status === 'running';
  const cls = `h-3 w-3 ${isRunning ? 'text-blue-500' : 'text-green-500'}`;

  if (toolLabel.includes('Tìm chart') || toolLabel.includes('search_chart'))
    return <BarChart3 className={cls} />;
  if (toolLabel.includes('Tìm dashboard') || toolLabel.includes('dashboard'))
    return <LayoutDashboard className={cls} />;
  if (toolLabel.includes('Truy vấn') || toolLabel.includes('query'))
    return isRunning ? <Loader2 className={`${cls} animate-spin`} /> : <Database className={cls} />;
  if (toolLabel.includes('Khám phá') || toolLabel.includes('explore'))
    return <FlaskConical className={cls} />;
  if (toolLabel.includes('Phân tích') || toolLabel.includes('insight'))
    return <Lightbulb className={cls} />;
  if (toolLabel.includes('Liệt kê') || toolLabel.includes('list'))
    return <List className={cls} />;
  if (toolLabel.includes('Tạo') || toolLabel.includes('create'))
    return <Zap className={cls} />;
  if (toolLabel.includes('Tìm') || toolLabel.includes('search'))
    return <Search className={cls} />;

  // Default
  return isRunning
    ? <Loader2 className={`${cls} animate-spin`} />
    : <CheckCircle2 className={cls} />;
}

// ── Main component ────────────────────────────────────────────────────────────

export function ThinkingIndicator({ steps, isThinking, hasText, intent }: ActivityPanelProps) {
  const [elapsed, setElapsed] = useState(0);
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef<number | null>(null);

  // ── Timer ──
  useEffect(() => {
    if (isThinking) {
      if (!startRef.current) startRef.current = Date.now();
      intervalRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startRef.current!) / 1000));
      }, 1000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [isThinking]);

  useEffect(() => {
    if (isThinking) {
      setUserCollapsed(null);
      setElapsed(0);
      startRef.current = null;
    }
  }, [isThinking]);

  const autoCollapsed = !isThinking && hasText;
  const collapsed = userCollapsed !== null ? userCollapsed : autoCollapsed;
  const doneCount = steps.filter(s => s.status === 'done').length;
  const totalCount = steps.length;
  const intentCfg = intent ? INTENT_CONFIG[intent] : null;

  // Initial spinner before first step arrives
  if (steps.length === 0) {
    return (
      <div className="flex items-center gap-2 py-2 px-1 text-xs text-gray-400">
        <Loader2 className="h-3.5 w-3.5 text-blue-400 animate-spin" />
        <span>Đang phân tích câu hỏi…</span>
        {intentCfg && (
          <span className={`ml-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${intentCfg.bg} ${intentCfg.border} ${intentCfg.color}`}>
            {intentCfg.label}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-blue-100 bg-blue-50/40 text-sm overflow-hidden">

      {/* ── Header / toggle ── */}
      <button
        onClick={() => setUserCollapsed(c => (c === null ? !autoCollapsed : !c))}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-blue-50/70 transition-colors text-left"
      >
        {isThinking ? (
          <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin flex-shrink-0" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
        )}

        <span className="flex-1 text-xs font-medium text-gray-600 truncate">
          {isThinking
            ? `Đang xử lý…${elapsed > 0 ? ` (${elapsed}s)` : ''}`
            : `Hoàn tất ${doneCount}/${totalCount} bước`}
        </span>

        {/* Intent badge */}
        {intentCfg && (
          <span className={`hidden sm:inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${intentCfg.bg} ${intentCfg.border} ${intentCfg.color}`}>
            {intentCfg.label}
          </span>
        )}

        {collapsed
          ? <ChevronDown className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          : <ChevronUp className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />}
      </button>

      {/* ── Steps list ── */}
      {!collapsed && (
        <div className="px-3 pb-3 border-t border-blue-100 space-y-1.5 pt-2">
          {steps.map((step, idx) => (
            <div key={step.id} className="flex items-start gap-2">
              {/* Step number for multi-step INSIGHT */}
              {intent === 'INSIGHT' && totalCount > 3 && (
                <span className="flex-shrink-0 mt-0.5 w-4 text-[9px] text-gray-400 text-right">
                  {idx + 1}
                </span>
              )}

              {/* Icon */}
              <div className="flex-shrink-0 mt-0.5 w-4 flex justify-center">
                {step.type === 'thinking' ? (
                  step.status === 'running'
                    ? <Brain className="h-3 w-3 text-blue-400 animate-pulse" />
                    : <CheckCircle2 className="h-3 w-3 text-gray-300" />
                ) : (
                  <ToolIcon toolLabel={step.label} status={step.status} />
                )}
              </div>

              {/* Text */}
              <div className="flex-1 min-w-0">
                <p className={`text-xs leading-relaxed ${
                  step.status === 'running'
                    ? 'text-gray-800 font-medium'
                    : 'text-gray-500'
                }`}>
                  {step.label}
                </p>
                {step.detail && (
                  <p className="text-[10px] text-gray-400 mt-0.5 leading-relaxed">{step.detail}</p>
                )}
              </div>
            </div>
          ))}

          {/* Waiting dots */}
          {isThinking && (
            <div className="flex items-center gap-1 pl-6 pt-1">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce [animation-delay:0ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce [animation-delay:300ms]" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
