'use client';

/**
 * ThinkingIndicator — real-time AI activity panel.
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

const INTENT_CONFIG: Record<IntentType, { label: string; cls: string }> = {
  LOOKUP:  { label: '🔍 Tra cứu',       cls: 'bg-brand/10 text-brand border-brand/20' },
  EXPLORE: { label: '🔬 Khám phá',      cls: 'bg-surface-2 text-text-secondary border-[rgb(var(--border-line))]' },
  INSIGHT: { label: '💡 Phân tích sâu', cls: 'bg-warning/10 text-warning border-warning/20' },
  CREATE:  { label: '🎨 Tạo biểu đồ',  cls: 'bg-success/10 text-success border-success/20' },
  VAGUE:   { label: '❓ Làm rõ',        cls: 'bg-surface-2 text-text-tertiary border-[rgb(var(--border-line))]' },
};

// ── Tool-specific icons ───────────────────────────────────────────────────────

function ToolIcon({ toolLabel, status }: { toolLabel: string; status: 'running' | 'done' }) {
  const isRunning = status === 'running';
  const cls = `h-3 w-3 ${isRunning ? 'text-brand' : 'text-success'}`;

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
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const totalCount = steps.length;
  const intentCfg = intent ? INTENT_CONFIG[intent] : null;

  // Initial state: animated dots while waiting for first step
  if (steps.length === 0) {
    return (
      <div className="flex items-center gap-2 py-2 px-1 text-caption text-text-quaternary">
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-current animate-bounce [animation-delay:0ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-current animate-bounce [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-current animate-bounce [animation-delay:300ms]" />
        </span>
        <span>Đang phân tích câu hỏi…</span>
        {intentCfg && (
          <span className={`ml-1 inline-flex items-center rounded-full border px-2 py-0.5 text-tiny font-emphasis ${intentCfg.cls}`}>
            {intentCfg.label}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 text-caption overflow-hidden">

      {/* ── Header / toggle ── */}
      <button
        onClick={() => setUserCollapsed((c) => (c === null ? !autoCollapsed : !c))}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-2 transition-colors text-left"
      >
        {isThinking ? (
          <Loader2 className="h-3.5 w-3.5 text-brand animate-spin flex-shrink-0" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-success flex-shrink-0" />
        )}

        <span className="flex-1 text-caption font-emphasis text-text-secondary truncate">
          {isThinking
            ? `Đang xử lý…${elapsed > 0 ? ` (${elapsed}s)` : ''}`
            : `Hoàn tất ${doneCount}/${totalCount} bước`}
        </span>

        {/* Intent badge */}
        {intentCfg && (
          <span className={`hidden sm:inline-flex items-center rounded-full border px-2 py-0.5 text-tiny font-emphasis ${intentCfg.cls}`}>
            {intentCfg.label}
          </span>
        )}

        {collapsed
          ? <ChevronDown className="h-3.5 w-3.5 text-text-quaternary flex-shrink-0" />
          : <ChevronUp className="h-3.5 w-3.5 text-text-quaternary flex-shrink-0" />}
      </button>

      {/* ── Steps list ── */}
      {!collapsed && (
        <div className="px-3 pb-3 border-t border-[rgb(var(--border-line))] space-y-1.5 pt-2">
          {steps.map((step, idx) => (
            <div key={step.id} className="flex items-start gap-2">
              {/* Step number for multi-step INSIGHT */}
              {intent === 'INSIGHT' && totalCount > 3 && (
                <span className="flex-shrink-0 mt-0.5 w-4 text-tiny text-text-quaternary text-right">
                  {idx + 1}
                </span>
              )}

              {/* Icon */}
              <div className="flex-shrink-0 mt-0.5 w-4 flex justify-center">
                {step.type === 'thinking' ? (
                  step.status === 'running'
                    ? <Brain className="h-3 w-3 text-brand animate-pulse" />
                    : <CheckCircle2 className="h-3 w-3 text-text-quaternary" />
                ) : (
                  <ToolIcon toolLabel={step.label} status={step.status} />
                )}
              </div>

              {/* Text */}
              <div className="flex-1 min-w-0">
                <p
                  className={`text-caption leading-relaxed ${
                    step.status === 'running'
                      ? 'text-text-primary font-emphasis'
                      : 'text-text-tertiary'
                  }`}
                >
                  {step.label}
                </p>
                {step.detail && (
                  <p className="text-tiny text-text-quaternary mt-0.5 leading-relaxed">{step.detail}</p>
                )}
              </div>
            </div>
          ))}

          {/* Animated dots while still running */}
          {isThinking && (
            <div className="flex items-center gap-1 pl-6 pt-1 text-text-quaternary">
              <span className="h-1.5 w-1.5 rounded-full bg-current animate-bounce [animation-delay:0ms]" />
              <span className="h-1.5 w-1.5 rounded-full bg-current animate-bounce [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 rounded-full bg-current animate-bounce [animation-delay:300ms]" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
