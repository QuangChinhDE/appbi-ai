'use client';

/**
 * DateInput — text input hiển thị theo định dạng DD/MM/YYYY quen thuộc với
 * người dùng Việt Nam, nhưng truyền/nhận giá trị ở dạng YYYY-MM-DD để tương
 * thích với HTML date input và các hàm filter.
 *
 * - Gõ số liên tục, dấu "/" được tự động chèn.
 * - Icon lịch bên phải mở native date picker để chọn nhanh.
 * - blur/commit: nếu chuỗi hợp lệ thì gọi onChange(YYYY-MM-DD).
 */

import { useState, useEffect, useRef } from 'react';
import { Calendar } from 'lucide-react';

interface DateInputProps {
  value: string;          // YYYY-MM-DD hoặc ''
  onChange: (v: string) => void; // trả về YYYY-MM-DD hoặc ''
  placeholder?: string;
  className?: string;
}

/** YYYY-MM-DD → DD/MM/YYYY */
function toDisplay(iso: string): string {
  if (!iso) return '';
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts;
  return `${d}/${m}/${y}`;
}

/** DD/MM/YYYY → YYYY-MM-DD, trả '' nếu chưa đủ */
function fromDisplay(text: string): string {
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return '';
  const [, d, m, y] = match;
  return `${y}-${m}-${d}`;
}

/** Tự động chèn dấu / khi người dùng gõ liên tục chỉ các chữ số */
function autoFormat(raw: string): string {
  // strip mọi thứ không phải số hoặc /
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

  // Đồng bộ khi value từ ngoài thay đổi (ví dụ: clear filter)
  useEffect(() => {
    setText(toDisplay(value));
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Cho phép backspace xoá ký tự / cùng với số phía trước
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
    // Tự động commit khi đủ DD/MM/YYYY
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
    // Chuỗi chưa hoàn chỉnh: giữ nguyên để user thấy
  };

  const handleNativeDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const iso = e.target.value;
    onChange(iso);
    setText(toDisplay(iso));
  };

  return (
    <div className={`relative flex items-center ${className}`}>
      <input
        type="text"
        value={text}
        onChange={handleTextChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        maxLength={10}
        className="w-full pr-7 px-2 py-1 border border-gray-200 rounded text-xs bg-white focus:ring-1 focus:ring-blue-400 focus:border-blue-400 outline-none"
      />
      {/* Calendar icon mở native date picker */}
      <label
        className="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer text-gray-400 hover:text-blue-500 transition-colors"
        title="Chọn ngày"
      >
        <span className="sr-only">Chọn ngày</span>
        {/* Native input ẩn, click vào label sẽ trigger picker */}
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
