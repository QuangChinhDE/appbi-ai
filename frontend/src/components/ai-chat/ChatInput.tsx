'use client';

/**
 * Auto-resizing textarea input for the chat.
 */
import React, { useRef, useEffect } from 'react';
import { Send, Loader2, Square } from 'lucide-react';

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
    <div className="flex items-end gap-2 p-4 border-t border-gray-200 bg-white">
      <textarea
        ref={ref}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={loading ? 'AI đang xử lý… (Esc để dừng)' : 'Hỏi về dữ liệu của bạn… (Enter để gửi, Shift+Enter để xuống dòng)'}
        rows={1}
        disabled={disabled}
        className="flex-1 resize-none overflow-hidden rounded-xl border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 bg-gray-50"
      />
      {loading ? (
        <button
          onClick={onStop}
          className="flex-shrink-0 w-10 h-10 rounded-xl bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-colors"
          title="Dừng (Esc)"
        >
          <Square className="h-4 w-4 fill-current" />
        </button>
      ) : (
        <button
          onClick={onSend}
          disabled={disabled || !value.trim()}
          className="flex-shrink-0 w-10 h-10 rounded-xl bg-blue-500 text-white flex items-center justify-center hover:bg-blue-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="Send (Enter)"
        >
          <Send className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
