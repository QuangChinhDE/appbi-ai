'use client';

/**
 * ActivityPanel — shows a real-time step-by-step log of what the AI is doing.
 * Expanded while thinking, auto-collapses once the text response starts arriving.
 * User can always click the header to toggle.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Brain, CheckCircle2, ChevronDown, ChevronUp, Loader2, Wrench } from 'lucide-react';
import type { ActivityStep } from './types';

interface ActivityPanelProps {
  steps: ActivityStep[];
  isThinking: boolean;
  /** Collapse by default when there is already text content in the message */
  hasText: boolean;
}

export function ThinkingIndicator({ steps, isThinking, hasText }: ActivityPanelProps) {
  const [elapsed, setElapsed] = useState(0);
  // null = auto-controlled; true/false = user override
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef<number | null>(null);

  // Timer — counts seconds while AI is working
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

  // Auto-collapse when text arrives; reset user override when new AI turn starts
  useEffect(() => {
    if (isThinking) setUserCollapsed(null);   // new turn → reset
  }, [isThinking]);

  // Derived: expanded or collapsed?
  const autoCollapsed = !isThinking && hasText;
  const collapsed = userCollapsed !== null ? userCollapsed : autoCollapsed;

  const doneCount = steps.filter(s => s.status === 'done').length;
  const totalCount = steps.length;

  // Initial state: steps haven't arrived yet
  if (steps.length === 0) {
    return (
      <div className="flex items-center gap-2 py-2 px-1 text-xs text-gray-400">
        <Loader2 className="h-3.5 w-3.5 text-blue-400 animate-spin" />
        <span>Đang kết nối AI…</span>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-blue-100 bg-blue-50/40 text-sm overflow-hidden">
      {/* ── Header / toggle ─────────────────────────────────── */}
      <button
        onClick={() => setUserCollapsed(c => (c === null ? !autoCollapsed : !c))}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-blue-50 transition-colors text-left"
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

        {collapsed
          ? <ChevronDown className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          : <ChevronUp className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />}
      </button>

      {/* ── Steps list ──────────────────────────────────────── */}
      {!collapsed && (
        <div className="px-3 pb-3 border-t border-blue-100 space-y-2 pt-2">
          {steps.map((step) => (
            <div key={step.id} className="flex items-start gap-2">
              {/* Icon */}
              <div className="flex-shrink-0 mt-0.5 w-4 flex justify-center">
                {step.status === 'running' ? (
                  step.type === 'tool'
                    ? <Loader2 className="h-3 w-3 text-blue-500 animate-spin" />
                    : <Brain className="h-3 w-3 text-blue-400 animate-pulse" />
                ) : (
                  step.type === 'tool'
                    ? <CheckCircle2 className="h-3 w-3 text-green-500" />
                    : <CheckCircle2 className="h-3 w-3 text-gray-400" />
                )}
              </div>

              {/* Text */}
              <div className="flex-1 min-w-0">
                <p className={`text-xs leading-relaxed ${
                  step.status === 'running' ? 'text-gray-800 font-medium' : 'text-gray-500'
                }`}>
                  {step.type === 'tool' && (
                    <Wrench className="h-2.5 w-2.5 inline mr-1 opacity-60" />
                  )}
                  {step.label}
                </p>
                {step.detail && (
                  <p className="text-xs text-gray-400 mt-0.5">{step.detail}</p>
                )}
              </div>
            </div>
          ))}

          {/* Animated "waiting" indicator for the current running step */}
          {isThinking && (
            <div className="flex items-center gap-1 pl-6">
              <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce [animation-delay:0ms]" />
              <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce [animation-delay:150ms]" />
              <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce [animation-delay:300ms]" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

