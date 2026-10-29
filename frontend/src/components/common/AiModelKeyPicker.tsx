'use client';

import { KeyRound } from 'lucide-react';
import type { AiModelProvider } from '@/types/api';
import { Input } from '@/components/ui/Input';

// The model and API key an AI surface runs on, chosen by the person (PO 2026-10-28):
// an AI Chat conversation's, a public link's assistant's. There is no server default.
// The key is write-only - pasted here, stored encrypted by the server, never shown
// again (only its last characters, `keyHint`).

export interface AiModelKeyValue {
  provider: string;
  model: string;
  apiKey: string;
}

interface AiModelKeyPickerProps {
  providers: AiModelProvider[];
  value: AiModelKeyValue;
  onChange: (next: AiModelKeyValue) => void;
  /** Last characters of the key already stored for this surface, if any. */
  keyHint?: string | null;
  /** Prefix of the data-testids: `${testId}-provider`, `-model`, `-key`. */
  testId: string;
  disabled?: boolean;
}

const SELECT = 'h-9 w-full rounded-md border border-stroke-strong bg-surface-1 px-2 text-caption text-text-primary '
  + 'focus:border-brand focus:outline-none disabled:opacity-60';

export function AiModelKeyPicker({ providers, value, onChange, keyHint, testId, disabled }: AiModelKeyPickerProps) {
  const current = providers.find((p) => p.provider === value.provider) ?? providers[0];
  const models = current?.models ?? [];

  const pickProvider = (provider: string) => {
    const next = providers.find((p) => p.provider === provider);
    const first = next?.models.find((m) => m.recommended) ?? next?.models[0];
    onChange({ ...value, provider, model: first?.model ?? '' });
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-tiny font-strong text-text-secondary">Nhà cung cấp</span>
          <select className={SELECT} value={current?.provider ?? ''} disabled={disabled}
                  onChange={(e) => pickProvider(e.target.value)} data-testid={`${testId}-provider`}>
            {providers.map((p) => <option key={p.provider} value={p.provider}>{p.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-tiny font-strong text-text-secondary">Model</span>
          <select className={SELECT} value={value.model} disabled={disabled}
                  onChange={(e) => onChange({ ...value, provider: current?.provider ?? value.provider,
                                              model: e.target.value })}
                  data-testid={`${testId}-model`}>
            <option value="">— Chọn model —</option>
            {models.map((m) => (
              <option key={m.model} value={m.model}>
                {m.label}{m.lifecycle === 'legacy' ? ' (thế hệ trước)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block">
        <span className="mb-1 flex items-center gap-1.5 text-tiny font-strong text-text-secondary">
          <KeyRound className="h-3.5 w-3.5 text-brand" aria-hidden="true" />API key
        </span>
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value.apiKey}
          disabled={disabled}
          placeholder={keyHint ? `Đã lưu key …${keyHint} — dán key mới để thay` : 'Dán API key của bạn'}
          onChange={(e) => onChange({ ...value, provider: current?.provider ?? value.provider,
                                      apiKey: e.target.value })}
          data-testid={`${testId}-key`}
        />
        <span className="mt-1 block text-tiny leading-5 text-text-tertiary">
          Key được mã hoá trên máy chủ và không bao giờ hiển thị lại; chi phí gọi model tính vào key này.
        </span>
      </label>
    </div>
  );
}
