// Chart color system with named palettes and theme support

export type ChartPaletteName =
  | 'default'
  | 'vibrant'
  | 'classic'
  | 'monochrome'
  | 'pastel';

export type ChartPalette = {
  name: ChartPaletteName;
  label: string;
  colors: string[];
};

export const CHART_PALETTES: ChartPalette[] = [
  {
    name: 'default',
    label: 'Default',
    colors: ['#3b82f6','#ef4444','#10b981','#f59e0b','#6366f1','#ec4899','#14b8a6','#8b5cf6'],
  },
  {
    name: 'vibrant',
    label: 'Vibrant',
    colors: ['#f97316','#22c55e','#06b6d4','#e11d48','#a855f7','#facc15','#0ea5e9','#84cc16'],
  },
  {
    name: 'classic',
    label: 'Classic',
    colors: ['#1f2933','#3e4c59','#7b8794','#9fb3c8','#d8e2ec','#f5f7fa'],
  },
  {
    name: 'monochrome',
    label: 'Monochrome',
    colors: ['#111827','#1f2937','#374151','#4b5563','#6b7280','#9ca3af'],
  },
  {
    name: 'pastel',
    label: 'Pastel',
    colors: ['#bfdbfe','#fecaca','#bbf7d0','#fde68a','#e9d5ff','#fed7e2'],
  },
];

export type ChartTheme = {
  defaultPalette: ChartPaletteName;
};

export const DEFAULT_CHART_THEME: ChartTheme = {
  defaultPalette: 'default',
};

export function getPalette(name?: ChartPaletteName): ChartPalette {
  return CHART_PALETTES.find(p => p.name === name) || CHART_PALETTES[0];
}

/**
 * Build a mapping from dimension values to colors based on palette
 * Ensures consistent colors for same category values across charts
 */
export function buildDimensionColorMap(
  rows: Record<string, any>[],
  dimension: string,
  paletteName?: ChartPaletteName
): Record<string, string> {
  const palette = getPalette(paletteName);
  const map: Record<string, string> = {};
  let idx = 0;

  for (const row of rows) {
    const raw = row[dimension];
    if (raw === null || raw === undefined) continue;
    const key = String(raw);
    if (!map[key]) {
      map[key] = palette.colors[idx % palette.colors.length];
      idx++;
    }
  }

  return map;
}
