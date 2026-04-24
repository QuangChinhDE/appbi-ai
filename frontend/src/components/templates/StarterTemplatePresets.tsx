'use client';

import React from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { TemplateStarterPreset } from '@/lib/template-starter-presets';

interface StarterTemplatePresetsProps {
  presets: TemplateStarterPreset[];
  canEdit: boolean;
  creatingPresetId?: string | null;
  onCreatePreset: (preset: TemplateStarterPreset) => void;
}

export function StarterTemplatePresets({
  presets,
  canEdit,
  creatingPresetId,
  onCreatePreset,
}: StarterTemplatePresetsProps) {
  return (
    <section className="rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 p-4 shadow-linear-sm">
      <div className="flex flex-col gap-2 border-b border-[rgb(var(--border-line))] pb-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">Starter presets</p>
          <h2 className="mt-1 text-lg font-semibold text-text-primary">3 mẫu để bạn bấm tạo và xem ngay</h2>
          <p className="mt-1 max-w-3xl text-sm text-text-tertiary">
            Mỗi mẫu đã có sẵn tiêu đề, cấu trúc cột, header gộp, footer và bộ lọc khởi tạo.
            Tạo xong là có thể mở builder để bind dataset rồi chỉnh tiếp theo nhu cầu thật.
          </p>
        </div>
        {!canEdit && (
          <p className="text-xs text-text-quaternary">Bạn cần quyền chỉnh sửa Template để tạo từ preset.</p>
        )}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        {presets.map((preset) => {
          const isCreating = creatingPresetId === preset.id;
          return (
            <article
              key={preset.id}
              className="relative overflow-hidden rounded-2xl border border-[rgb(var(--border-line))] bg-[rgba(var(--surface-2-rgb),0.78)] p-4"
            >
              <div
                className="absolute inset-x-0 top-0 h-1.5"
                style={{ background: preset.accent }}
              />

              <div className="mt-2 flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-text-quaternary">{preset.useCase}</p>
                  <h3 className="mt-1 text-base font-semibold text-text-primary">{preset.name}</h3>
                </div>
                <span
                  className="rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                  style={{ borderColor: `${preset.accent}55`, color: preset.accent, background: `${preset.accent}12` }}
                >
                  Demo
                </span>
              </div>

              <p className="mt-3 min-h-[48px] text-sm leading-6 text-text-secondary">{preset.description}</p>

              <div className="mt-4 flex flex-wrap gap-2">
                {preset.features.map((feature) => (
                  <span
                    key={feature}
                    className="rounded-full border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-1 text-[11px] text-text-tertiary"
                  >
                    {feature}
                  </span>
                ))}
              </div>

              <div className="mt-5">
                <Button
                  variant="primary"
                  size="sm"
                  className="w-full justify-center"
                  onClick={() => onCreatePreset(preset)}
                  disabled={!canEdit || isCreating}
                  leadingIcon={isCreating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
                >
                  {isCreating ? 'Đang tạo…' : 'Tạo từ mẫu này'}
                </Button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}