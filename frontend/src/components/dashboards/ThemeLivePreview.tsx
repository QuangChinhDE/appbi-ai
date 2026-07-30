'use client';

import React from 'react';
import type { DashboardThemeConfig } from '@/types/api';
import { DashboardThemeProvider } from './DashboardThemeProvider';
import { resolveStyleTokens, roleFontSize } from '@/lib/dashboard-theme-tokens';

/**
 * A miniature report rendered with the theme being edited.
 *
 * Why sample data instead of the real dashboard: the preview has to answer
 * "what will my report look like" in under a second, for every keystroke, and
 * with every surface visible at once — KPI, bar, line, donut, table, slicer,
 * section header. Re-rendering the live report would be slower, would only show
 * whichever visuals happen to be on the current page, and would fight the
 * unsaved-changes model. The shapes here are deliberately the same DOM hooks
 * (`dashboard-tile`, `dashboard-slicer`, a real `<table>`) the report uses, so
 * they pick up exactly the same CSS the real thing will.
 */
export function ThemeLivePreview({ theme }: { theme: DashboardThemeConfig }) {
  const tokens = resolveStyleTokens(theme);
  const accent = (theme.accent && String(theme.accent).trim()) || '#5b5bd6';
  const palette = Array.isArray(theme.dataColors) && theme.dataColors.length
    ? theme.dataColors
    : [accent, '#22b8cf', '#12b886', '#fab005', '#fa5252'];

  const bars = [62, 88, 45, 74, 96, 58];
  const line = [18, 34, 28, 52, 44, 68, 82];
  const linePath = line
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i / (line.length - 1)) * 100} ${40 - (v / 100) * 34}`)
    .join(' ');

  const tileCls = 'dashboard-tile rounded-[var(--dashboard-card-radius,12px)] border border-[rgb(var(--border-line))] bg-surface-1 overflow-hidden';

  return (
    <DashboardThemeProvider theme={theme} className="rounded-lg p-3">
      <div className="flex flex-col gap-2.5">
        {/* Slicer row */}
        <div className="flex items-center gap-2">
          <div className="dashboard-slicer flex flex-col gap-0.5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-1.5">
            <span className="text-[9px] text-text-quaternary">Khu vực</span>
            <span className="text-[10px] font-medium text-text-primary">Miền Bắc ▾</span>
          </div>
          <div className="dashboard-slicer flex flex-col gap-0.5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-1.5">
            <span className="text-[9px] text-text-quaternary">Kỳ</span>
            <span className="text-[10px] font-medium text-text-primary">Q3 2026 ▾</span>
          </div>
        </div>

        <div
          className="dashboard-section-title text-text-primary"
          style={{ fontSize: roleFontSize(tokens, 'sectionTitle'), fontWeight: 600 }}
        >
          Tổng quan
        </div>

        {/* KPI row */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Doanh thu', value: '15.8M', delta: '+12%' },
            { label: 'Đơn hàng', value: '99.4K', delta: '+4%' },
            { label: 'AOV', value: '137.8', delta: '−2%' },
          ].map((k) => (
            <div key={k.label} className={`${tileCls} px-2.5 py-2`}>
              <div
                className="dashboard-kpi-label truncate text-text-secondary"
                style={{ fontSize: roleFontSize(tokens, 'kpiLabel') }}
              >
                {k.label}
              </div>
              <div
                className="truncate font-bold text-text-primary"
                style={{
                  // The preview pane is ~300px wide: a full-size KPI value would
                  // truncate to "1…" and read as broken. Clamp hard; the ratio
                  // between roles is what the preview needs to show, not the px.
                  fontSize: Math.min(19, roleFontSize(tokens, 'kpiValue')),
                  color: tokens.kpiStyle === 'accent' || tokens.kpiStyle === 'gradient' ? accent : undefined,
                }}
              >
                {k.value}
              </div>
              <div className="text-[9px]" style={{ color: theme.goodColor || '#12b886' }}>{k.delta}</div>
            </div>
          ))}
        </div>

        {/* Charts */}
        <div className="grid grid-cols-3 gap-2">
          <div className={`${tileCls} px-2.5 py-2`}>
            <div className="truncate text-text-secondary" style={{ fontSize: roleFontSize(tokens, 'chartTitle') }}>Theo tháng</div>
            <svg viewBox="0 0 100 44" className="mt-1 h-[52px] w-full" preserveAspectRatio="none">
              {tokens.chart.gridlines !== 'none' && [10, 20, 30].map((y) => (
                <line key={y} x1="0" x2="100" y1={y} y2={y}
                  stroke={theme.gridlineColor || 'rgba(20,26,42,0.10)'} strokeWidth="0.5"
                  strokeDasharray={tokens.chart.gridlines === 'dashed' ? '2 2' : undefined} />
              ))}
              {bars.map((b, i) => (
                <rect key={i} x={i * 16 + 3} y={40 - (b / 100) * 34} width="10" height={(b / 100) * 34}
                  rx={Math.min(5, tokens.chart.barRadius / 2)} fill={palette[i % palette.length]} />
              ))}
              {tokens.chart.axisLine && <line x1="0" x2="100" y1="40" y2="40" stroke="rgba(20,26,42,0.25)" strokeWidth="0.6" />}
            </svg>
          </div>
          <div className={`${tileCls} px-2.5 py-2`}>
            <div className="truncate text-text-secondary" style={{ fontSize: roleFontSize(tokens, 'chartTitle') }}>Xu hướng</div>
            <svg viewBox="0 0 100 44" className="mt-1 h-[52px] w-full" preserveAspectRatio="none">
              {tokens.chart.gridlines !== 'none' && [10, 20, 30].map((y) => (
                <line key={y} x1="0" x2="100" y1={y} y2={y}
                  stroke={theme.gridlineColor || 'rgba(20,26,42,0.10)'} strokeWidth="0.5"
                  strokeDasharray={tokens.chart.gridlines === 'dashed' ? '2 2' : undefined} />
              ))}
              <path d={`${linePath} L 100 40 L 0 40 Z`} fill={accent} opacity={tokens.chart.areaOpacity} />
              <path d={linePath} fill="none" stroke={accent} strokeWidth={tokens.chart.lineWidth / 2} />
            </svg>
          </div>
          <div className={`${tileCls} px-2.5 py-2`}>
            <div className="truncate text-text-secondary" style={{ fontSize: roleFontSize(tokens, 'chartTitle') }}>Cơ cấu</div>
            <svg viewBox="0 0 44 44" className="mt-1 h-[52px] w-full">
              {[0, 1, 2, 3].map((i) => {
                const start = [0, 0.45, 0.7, 0.88][i] * 2 * Math.PI - Math.PI / 2;
                const end = [0.45, 0.7, 0.88, 1][i] * 2 * Math.PI - Math.PI / 2;
                const large = end - start > Math.PI ? 1 : 0;
                const r = 16;
                const x1 = 22 + r * Math.cos(start), y1 = 22 + r * Math.sin(start);
                const x2 = 22 + r * Math.cos(end), y2 = 22 + r * Math.sin(end);
                return <path key={i} d={`M 22 22 L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`} fill={palette[i % palette.length]} />;
              })}
              <circle cx="22" cy="22" r="8" fill="rgb(var(--surface-1))" />
            </svg>
          </div>
        </div>

        {/* Table */}
        <div className={`${tileCls} px-2.5 py-2`}>
          <div className="mb-1 truncate text-text-secondary" style={{ fontSize: roleFontSize(tokens, 'chartTitle') }}>Chi tiết</div>
          <table className="w-full border-separate border-spacing-0">
            <thead>
              <tr>
                {['Danh mục', 'Doanh thu', 'Đơn'].map((h) => (
                  <th key={h} className="border-b border-[rgb(var(--border-line))] px-1.5 py-1 text-left text-text-secondary"
                    style={{ fontSize: roleFontSize(tokens, 'tableHeader') }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[['Điện tử', '1.3M', '9,670'], ['Gia dụng', '1.2M', '5,991'], ['Thời trang', '1.0M', '11,115']].map((r) => (
                <tr key={r[0]}>
                  {r.map((c, i) => (
                    <td key={i} className="border-b border-[rgb(var(--border-line))] px-1.5 py-1 text-text-primary"
                      style={{ fontSize: roleFontSize(tokens, 'tableBody'), textAlign: i === 0 ? 'left' : 'right' }}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </DashboardThemeProvider>
  );
}
