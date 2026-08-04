/**
 * Ready-made Experience-Studio theme presets.
 *
 * Each preset is a COMPLETE, harmonious token bundle an author can apply in one
 * click — no manual colour picking. They follow modern SaaS / dashboard
 * conventions: restrained slate neutrals, AA-contrast accents, Inter type, soft
 * shadows. The five light presets share the exact same "scientific" neutral
 * scale (slate-50 / white / slate-200 / slate-900) and differ only by the
 * accent, so the app always reads clean and consistent; "Dark Pro" ships a full
 * dark palette. Applying a preset writes ``experience.theme`` + ``experience.preset``.
 */
import type { ExperienceSpec } from './types';

export type ThemeTokens = NonNullable<ExperienceSpec['theme']>;

export interface ThemePreset {
  id: string;
  name: string;
  /** One-line description shown under the card. */
  hint: string;
  theme: ThemeTokens;
}

// Shared clean, high-contrast neutral scale + typography/shape for every light
// preset. Only the accent (primary/info) changes on top of this.
const LIGHT_BASE: ThemeTokens = {
  success: '#16a34a',
  warning: '#d97706',
  danger: '#dc2626',
  neutral: '#64748b',
  background: '#f8fafc',
  surface: '#ffffff',
  border: '#e2e8f0',
  text: '#0f172a',
  font_family: 'inter',
  heading_weight: 'semibold',
  body_weight: 'regular',
  type_scale: 100,
  density: 'cozy',
  radius: 'small',
  elevation: 'small',
  mode: 'light',
};

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'tech_blue',
    name: 'Tech Blue',
    hint: 'Classic SaaS blue — an tâm, chuyên nghiệp.',
    theme: { ...LIGHT_BASE, primary: '#2563eb', info: '#3b82f6' },
  },
  {
    id: 'slate_minimal',
    name: 'Slate Minimal',
    hint: 'Tối giản, trung tính — hợp báo cáo/khoa học.',
    theme: { ...LIGHT_BASE, primary: '#334155', info: '#0ea5e9' },
  },
  {
    id: 'indigo_saas',
    name: 'Indigo',
    hint: 'Hiện đại, mềm — phong cách Linear/Stripe.',
    theme: { ...LIGHT_BASE, primary: '#4f46e5', info: '#6366f1', radius: 'medium' },
  },
  {
    id: 'emerald_ops',
    name: 'Emerald',
    hint: 'Xanh vận hành — hợp app hiện trường/kho.',
    theme: { ...LIGHT_BASE, primary: '#059669', info: '#10b981' },
  },
  {
    id: 'teal_data',
    name: 'Teal',
    hint: 'Xanh ngọc điềm tĩnh — hợp bảng dữ liệu.',
    theme: { ...LIGHT_BASE, primary: '#0d9488', info: '#14b8a6' },
  },
  {
    id: 'dark_pro',
    name: 'Dark Pro',
    hint: 'Nền tối chuyên nghiệp, dịu mắt.',
    theme: {
      primary: '#3b82f6',
      info: '#60a5fa',
      success: '#22c55e',
      warning: '#f59e0b',
      danger: '#ef4444',
      neutral: '#94a3b8',
      background: '#0f172a',
      surface: '#1e293b',
      border: '#334155',
      text: '#e2e8f0',
      font_family: 'inter',
      heading_weight: 'semibold',
      body_weight: 'regular',
      type_scale: 100,
      density: 'cozy',
      radius: 'small',
      elevation: 'medium',
      mode: 'dark',
    },
  },
];
