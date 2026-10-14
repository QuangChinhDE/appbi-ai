/**
 * Look at what actually rendered.
 *
 * Every other check in this folder reasons about a plan or a grid rectangle.
 * None of them can see that a title was cut to "Doanh thu the…", that a chart
 * came out 140px tall, or that a dark surface left grey text on navy. Those are
 * the defects a reader notices first, and they only exist in the DOM. This
 * module measures the rendered tiles directly — geometry from
 * `getBoundingClientRect`, clipping from scroll vs client size, contrast from
 * computed colours — and reports what it finds.
 *
 * It is used in two places, deliberately the same code:
 *   - the AI Design preview's post-render pass (`critic.ts`), which repairs
 *     what the preview's permission layer allows;
 *   - the end-to-end quality gate, which calls it on the builder and on the
 *     public report through `window.__APPBI_RENDER_AUDIT__`.
 *
 * No imports: it must run in any page as-is.
 */

export type RenderFindingCode =
  | 'title.clipped'
  | 'tile.tooSmall'
  | 'content.overflow'
  | 'text.lowContrast'
  | 'tile.overlap'
  | 'tile.offCanvas'
  // A chart drew its axes and no data marks, and did not say it has no data.
  // It reads as "the value is zero" or as a working chart; it is neither.
  | 'chart.noMarks';

export interface RenderFinding {
  code: RenderFindingCode;
  tileId: number | null;
  detail: string;
  /** Measured value, for the test report. */
  value?: number;
}

export interface TileMeasure {
  tileId: number | null;
  kind: 'kpi' | 'chart' | 'table' | 'widget';
  frame: string;
  rect: { x: number; y: number; w: number; h: number };
  title?: string;
  titleFontPx?: number;
  titleColor?: string;
  surfaceColor?: string;
  contrast?: number;
  /** Data marks drawn (lines/bars/sectors/areas/points) — null for a chart
   *  that is not an SVG plot (a custom visual). */
  marks?: number;
}

export interface RenderAuditResult {
  tiles: TileMeasure[];
  findings: RenderFinding[];
}

/** Below these a mark stops being itself. KPI is a number and a label. */
export const READABLE_MIN = {
  chart: { w: 200, h: 140 },
  table: { w: 240, h: 160 },
  kpi: { w: 110, h: 72 },
} as const;

/** WCAG large-text floor. Tile titles are ≥ 13px semibold, the body is the
 *  chart itself; 3:1 is the honest bar for a heading. */
export const MIN_TITLE_CONTRAST = 3;

type RGBA = [number, number, number, number];

function parseColor(value: string | null | undefined): RGBA | null {
  if (!value) return null;
  const m = value.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  return [parts[0], parts[1], parts[2], parts.length >= 4 && Number.isFinite(parts[3]) ? parts[3] : 1];
}

function luminance([r, g, b]: RGBA): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: RGBA, b: RGBA): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The first opaque-ish background from `el` upward, composited over white. */
function effectiveBackground(el: Element | null, view: Window): RGBA {
  let node: Element | null = el;
  while (node) {
    const bg = parseColor(view.getComputedStyle(node).backgroundColor);
    if (bg && bg[3] > 0.5) return bg;
    node = node.parentElement;
  }
  return [255, 255, 255, 1];
}

function kindOf(el: HTMLElement): TileMeasure['kind'] {
  const declared = el.getAttribute('data-tile-kind');
  if (declared === 'kpi' || declared === 'table' || declared === 'widget' || declared === 'chart') return declared;
  return el.querySelector('.dashboard-kpi-value') ? 'kpi' : 'chart';
}

/** Data marks in a tile's plot: a line or area with a real path, a bar or a
 *  sector with area, a dot. null when the tile has no recharts plot at all
 *  (KPI-like and custom visuals are judged elsewhere). */
export function countDataMarks(el: Element): number | null {
  const svg = el.querySelector('svg.recharts-surface');
  if (!svg) return null;
  let n = 0;
  svg.querySelectorAll('.recharts-line-curve, .recharts-area-area, .recharts-area-curve').forEach((p) => {
    if ((p.getAttribute('d') ?? '').length > 8) n += 1;
  });
  svg.querySelectorAll('.recharts-bar-rectangle path, .recharts-rectangle, .recharts-sector, .recharts-pie-sector path, .recharts-scatter-symbol, .recharts-radial-bar-sector, .recharts-funnel-trapezoid')
    .forEach((p) => {
      const d = p.getAttribute('d') ?? '';
      if (d.length > 8 || p.tagName.toLowerCase() !== 'path') n += 1;
    });
  return n;
}

function rectsOverlap(a: TileMeasure['rect'], b: TileMeasure['rect']): boolean {
  // One pixel of tolerance: sub-pixel layout rounding is not an overlap.
  return !(a.x + a.w <= b.x + 1 || b.x + b.w <= a.x + 1 || a.y + a.h <= b.y + 1 || b.y + b.h <= a.y + 1);
}

/**
 * Audit every `[data-tile-id]` element under `root`.
 *
 * A tile whose content has not finished loading (a spinner is still inside)
 * is measured for geometry but not for clipping/contrast — its title is not
 * final yet, and a false positive here would train people to ignore the gate.
 */
export function auditRenderedTiles(root: ParentNode = document): RenderAuditResult {
  const view: Window = (root as any).ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : (null as any));
  const elements = Array.from(root.querySelectorAll<HTMLElement>('[data-tile-id]'));
  const tiles: TileMeasure[] = [];
  const findings: RenderFinding[] = [];
  const container = (root as any).getBoundingClientRect ? (root as HTMLElement).getBoundingClientRect() : null;

  for (const el of elements) {
    // Hidden pre-warm copies and off-screen export clones are not the page.
    if (el.closest('[aria-hidden="true"]')) continue;
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const idAttr = el.getAttribute('data-tile-id');
    const tileId = idAttr != null && idAttr !== '' && Number.isFinite(Number(idAttr)) ? Number(idAttr) : null;
    const kind = kindOf(el);
    const measure: TileMeasure = {
      tileId,
      kind,
      frame: el.getAttribute('data-tile-frame') ?? 'card',
      rect: { x: box.left, y: box.top, w: box.width, h: box.height },
    };
    const loading = !!el.querySelector('.animate-spin, [aria-busy="true"], [data-loading="true"]');

    if (kind !== 'widget') {
      const min = READABLE_MIN[kind];
      if (box.width < min.w || box.height < min.h) {
        findings.push({
          code: 'tile.tooSmall', tileId,
          detail: `${kind} rendered ${Math.round(box.width)}×${Math.round(box.height)}px (min ${min.w}×${min.h})`,
          value: Math.min(box.width / min.w, box.height / min.h),
        });
      }
    }

    const title = el.querySelector<HTMLElement>('[data-pdf-tile-title]');
    if (title && !loading) {
      measure.title = (title.textContent ?? '').trim();
      const style = view.getComputedStyle(title);
      measure.titleFontPx = parseFloat(style.fontSize) || undefined;
      measure.titleColor = style.color;
      if (title.scrollWidth > title.clientWidth + 1 && measure.title.length > 0) {
        findings.push({
          code: 'title.clipped', tileId,
          detail: `"${measure.title}" needs ${title.scrollWidth}px, has ${title.clientWidth}px`,
          value: title.clientWidth / Math.max(1, title.scrollWidth),
        });
      }
      const fg = parseColor(style.color);
      const bg = effectiveBackground(title, view);
      measure.surfaceColor = `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`;
      if (fg) {
        // Text alpha composites over its background.
        const a = fg[3];
        const blended: RGBA = [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
        const ratio = contrastRatio(blended, bg);
        measure.contrast = Math.round(ratio * 100) / 100;
        if (ratio < MIN_TITLE_CONTRAST) {
          findings.push({
            code: 'text.lowContrast', tileId,
            detail: `title contrast ${ratio.toFixed(2)}:1 (min ${MIN_TITLE_CONTRAST}:1)`,
            value: ratio,
          });
        }
      }
    }

    const body = el.querySelector<HTMLElement>('[data-tile-body]');
    if (body && !loading && body.scrollHeight > body.clientHeight + 4 && view.getComputedStyle(body).overflowY === 'hidden') {
      findings.push({
        code: 'content.overflow', tileId,
        detail: `content ${body.scrollHeight}px in a ${body.clientHeight}px body`,
        value: body.clientHeight / Math.max(1, body.scrollHeight),
      });
    }

    if (kind === 'chart' && !loading) {
      const marks = countDataMarks(el);
      measure.marks = marks ?? undefined;
      const saysEmpty = !!el.querySelector('.dashboard-empty-state, [data-empty-state], [data-testid="chart-empty"]');
      if (marks === 0 && !saysEmpty) {
        findings.push({ code: 'chart.noMarks', tileId, detail: 'the chart rendered axes but no data marks', value: 0 });
      }
    }

    if (container && box.right > container.right + 2) {
      findings.push({ code: 'tile.offCanvas', tileId, detail: `ends ${Math.round(box.right - container.right)}px past the canvas` });
    }
    tiles.push(measure);
  }

  for (let i = 0; i < tiles.length; i += 1) {
    for (let j = i + 1; j < tiles.length; j += 1) {
      if (rectsOverlap(tiles[i].rect, tiles[j].rect)) {
        findings.push({
          code: 'tile.overlap', tileId: tiles[i].tileId,
          detail: `tiles ${tiles[i].tileId} and ${tiles[j].tileId} overlap`,
        });
      }
    }
  }
  return { tiles, findings };
}
