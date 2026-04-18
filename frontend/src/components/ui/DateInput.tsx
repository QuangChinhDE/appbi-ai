'use client';

/**
 * DateInput — text input hiển thị theo định dạng DD/MM/YYYY quen thuộc với
 * người dùng Việt Nam, nhưng truyền/nhận giá trị ở dạng YYYY-MM-DD để tương
 * thích với HTML date input và các hàm filter.
 */

import { useState, useEffect, useRef } from 'react';
import { Calendar } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DateInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}

function toDisplay(iso: string): string {
  if (!iso) return '';
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts;
  return `${d}/${m}/${y}`;
}

function fromDisplay(text: string): string {
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return '';
  const [, d, m, y] = match;
  return `${y}-${m}-${d}`;
}

function autoFormat(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  let out = digits;
  if (out.length > 2) out = out.slice(0, 2) + '/' + out.slice(2);
  if (out.length > 5) out = out.slice(0, 5) + '/' + out.slice(5);
  return out.slice(0, 10);
}

export function DateInput({
  value,
  onChange,
  placeholder = 'DD/MM/YYYY',
  className = '',
}: DateInputProps) {
  const [text, setText] = useState(() => toDisplay(value));
  const nativeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText(toDisplay(value));
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      const t = text;
      if (t.endsWith('/')) {
        e.preventDefault();
        setText(t.slice(0, -1));
      }
    }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    const formatted = autoFormat(raw);
    setText(formatted);
    if (formatted.length === 10) {
      const iso = fromDisplay(formatted);
      if (iso) onChange(iso);
    } else if (formatted === '') {
      onChange('');
    }
  };

  const handleBlur = () => {
    if (text === '') {
      onChange('');
      return;
    }
    const iso = fromDisplay(text);
    if (iso) {
      onChange(iso);
      setText(toDisplay(iso));
    }
  };

  const handleNativeDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const iso = e.target.value;
    onChange(iso);
    setText(toDisplay(iso));
  };

  return (
    <div className={cn('relative flex items-center', className)}>
      <input
        type="text"
        value={text}
        onChange={handleTextChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        maxLength={10}
        className={cn(
          'w-full pr-7 pl-2.5 py-1 h-8 rounded-md text-caption',
          'bg-surface-1 text-text-primary placeholder:text-text-quaternary',
          'border border-[rgb(var(--border-strong))]',
          'focus:border-brand focus:shadow-focus-brand focus:outline-none',
          'transition-[border-color,box-shadow]',
        )}
      />
      <label
        className="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer text-text-tertiary hover:text-brand transition-colors"
        title="Chọn ngày"
      >
        <span className="sr-only">Chọn ngày</span>
        <input
          ref={nativeRef}
          type="date"
          value={value}
          onChange={handleNativeDateChange}
          tabIndex={-1}
          style={{
            position: 'absolute',
            opacity: 0,
            inset: 0,
            cursor: 'pointer',
            width: '100%',
            height: '100%',
          }}
        />
        <Calendar className="w-3.5 h-3.5 relative z-10 pointer-events-none" />
      </label>
    </div>
  );
}
