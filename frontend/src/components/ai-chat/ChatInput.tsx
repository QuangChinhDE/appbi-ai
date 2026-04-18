'use client';

/**
 * Auto-resizing textarea input for the chat.
 */
import React, { useRef, useEffect } from 'react';
import { Send, Square } from 'lucide-react';
import { IconButton } from '@/components/ui/Button';

interface ChatInputProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop?: () => void;
  disabled?: boolean;
  loading?: boolean;
}

export function ChatInput({ value, onChange, onSend, onStop, disabled, loading }: ChatInputProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-resize
  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = `${Math.min(ref.current.scrollHeight, 160)}px`;
    }
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && !loading && value.trim()) onSend();
    }
    // Escape = stop
    if (e.key === 'Escape' && loading && onStop) {
      onStop();
    }
  };

  return (
    <div className="px-4 py-3 border-t border-[rgb(var(--border-line))] bg-surface-1">
      <div className="flex items-end gap-2 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 transition-[border-color,box-shadow] duration-150 focus-within:border-brand focus-within:shadow-focus-brand">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            loading
              ? 'AI đang xử lý… (Esc để dừng)'
              : 'Hỏi về dữ liệu của bạn… (Enter để gửi, Shift+Enter để xuống dòng)'
          }
          rows={1}
          disabled={disabled}
          className="flex-1 resize-none overflow-hidden bg-transparent text-caption leading-relaxed text-text-primary placeholder:text-text-quaternary outline-none disabled:opacity-50"
        />
        {loading ? (
          <IconButton
            variant="danger"
            size="sm"
            onClick={onStop}
            aria-label="Dừng"
            title="Dừng (Esc)"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
          </IconButton>
        ) : (
          <IconButton
            variant="primary"
            size="sm"
            onClick={onSend}
            disabled={disabled || !value.trim()}
            aria-label="Gửi"
            title="Send (Enter)"
          >
            <Send className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
    </div>
  );
}
