'use client';

/**
 * Shared "is this dashboard finished rendering?" protocol.
 *
 * Used by BOTH exporters: the in-browser jsPDF engine (before it screenshots a
 * tile) and the print route the server-side Chromium worker loads (it flips
 * `window.__APPBI_PDF_READY__` when this resolves). One implementation means the
 * two engines can never disagree about what "ready" means.
 */

// ── Readiness protocol ───────────────────────────────────────────────────────
//
// Capturing on a fixed timer was the single biggest cause of ugly exports: a
// tile that was still fetching, still laying out, or mid-animation got
// snapshotted as a spinner / half-drawn chart / blank box. Instead we WAIT for
// the DOM to prove it is done:
//   1. web fonts loaded (text measured with a fallback font shifts on swap),
//   2. no spinner / aria-busy / skeleton element inside the captured root,
//   3. every <img> decoded,
//   4. the render signature (count + size of svg/canvas/table + row count)
//      identical across two consecutive polls — i.e. nothing is still growing.
// Bounded by a timeout so a genuinely stuck tile can't hang the export; the
// caller still gets a PDF (with that tile's placeholder / warning).

const READY_POLL_MS = 200;
const READY_STABLE_READS = 2;
export const READY_TIMEOUT_MS = 25000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Per-tile readiness ───────────────────────────────────────────────────────
//
// A page is not "ready" because SOME tile painted: a title or a status badge is
// text, and a chart whose data had not arrived used to pass as painted — a real
// PowerPoint shipped such a tile as an empty card. Every chart tile now states
// where it is (`data-export-state` on its root, set by ChartTile and
// ReadonlyChartTile):
//   loading — not mounted, or its data is not in yet
//   error   — the chart failed (it shows its error card)
//   empty   — the data arrived with no rows (it shows its empty state)
//   data    — rows arrived; the RENDERER must still draw them
// and a `data` tile is ready only once its body holds real visual marks — the
// definition the chart visual certification uses (e2e/tests/_chart_visual.ts):
// painted SVG shapes that are not axes/grid/legend/clip chrome, a sized canvas,
// table cells with text, a KPI value, or coloured HTML marks. A title or a
// diagnostic string alone never counts. Tiles without a state (text, headers,
// images, controls) have nothing to wait for.

export type TileReadiness = 'loading' | 'ready-visual' | 'ready-empty' | 'ready-error' | 'ready-static';

// Not data: axes, grid, legend, labels and their leader lines, tooltips, clip defs.
const MARK_CHROME = '.recharts-cartesian-axis, .recharts-cartesian-grid, .recharts-legend-wrapper, defs, clipPath, .recharts-tooltip-wrapper, [data-chart-chrome], .recharts-reference-line, .recharts-pie-labels, .recharts-pie-label-line, .recharts-label-list, [data-export-hide]';

function painted(el: Element): boolean {
  const cs = getComputedStyle(el as HTMLElement);
  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
  const fill = el.getAttribute('fill') ?? cs.fill;
  const stroke = el.getAttribute('stroke') ?? cs.stroke;
  const fillOpacity = Number(el.getAttribute('fill-opacity') ?? cs.fillOpacity ?? 1);
  return Boolean((fill && fill !== 'none' && fill !== 'transparent' && fillOpacity > 0)
    || (stroke && stroke !== 'none' && stroke !== 'transparent'));
}

/** Does this element hold drawn data — not only a frame, a title or a badge? */
export function hasVisualMarks(body: Element): boolean {
  for (const el of body.querySelectorAll('svg rect, svg path, svg circle, svg polygon, svg ellipse, svg line, svg polyline')) {
    if (el.closest(MARK_CHROME)) continue;
    const r = el.getBoundingClientRect();
    if ((r.width * r.height > 4 || (r.width > 1 && el.tagName.toLowerCase() === 'path')) && painted(el)) return true;
  }
  for (const c of body.querySelectorAll('canvas')) {
    if (c.closest(MARK_CHROME)) continue;
    const r = c.getBoundingClientRect();
    if (r.width > 4 && r.height > 4) return true;
  }
  for (const cell of body.querySelectorAll('td, [role="cell"], [role="gridcell"]')) {
    if ((cell.textContent || '').trim()) return true;
  }
  const kpi = body.querySelector('.dashboard-kpi-value');
  if (kpi && (kpi.textContent || '').trim()) return true;
  for (const el of body.querySelectorAll<HTMLElement>('[style*="background"]')) {
    if (el.closest(MARK_CHROME)) continue;
    const r = el.getBoundingClientRect();
    const bg = getComputedStyle(el).backgroundColor;
    if (r.width * r.height > 16 && bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)/.test(bg)) return true;
  }
  return false;
}

/** Where one grid tile stands (its `.react-grid-item` / `[data-grid-item-id]` element). */
export function tileReadiness(tile: Element): TileReadiness {
  const host = tile.matches('[data-export-state]') ? tile : tile.querySelector('[data-export-state]');
  if (!host) return 'ready-static';
  const state = (host as HTMLElement).dataset.exportState;
  if (state === 'error') return 'ready-error';
  if (state === 'empty') return 'ready-empty';
  if (state !== 'data') return 'loading';
  const body = host.querySelector('[data-tile-body]') ?? host;
  return hasVisualMarks(body) ? 'ready-visual' : 'loading';
}

function renderSignature(root: HTMLElement): { busy: boolean; key: string } {
  const spinners = root.querySelectorAll(
    '.animate-spin,[aria-busy="true"],[data-loading="true"],[data-tile-loading="true"]',
  ).length;
  const images = [...root.querySelectorAll('img')];
  const pendingImages = images.filter((img) => !img.complete || img.naturalWidth === 0).length;
  const parts: string[] = [];
  let sized = 0;
  root.querySelectorAll('svg,canvas').forEach((el) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width > 4 && r.height > 4) {
      sized++;
      parts.push(`${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  });
  let rows = 0;
  root.querySelectorAll('table').forEach((t) => { rows += t.querySelectorAll('tbody tr').length; });
  const tileEls = [...root.querySelectorAll<HTMLElement>('.react-grid-item')];
  // EVERY tile must stand somewhere final (see tileReadiness): one painted tile
  // no longer lets the page through while another is still a blank card.
  const states = tileEls.map((t) => tileReadiness(t));
  const loading = states.filter((s) => s === 'loading').length;
  return {
    busy: spinners > 0 || pendingImages > 0 || loading > 0,
    key: `${tileEls.length}|${states.join(',')}|${sized}|${rows}|${parts.join(',')}`,
  };
}

/**
 * Block until the captured root looks settled (see above). Resolves
 * `{ready:false}` on timeout — the caller proceeds anyway rather than failing
 * the whole export.
 */
export async function waitForRenderReady(
  root: HTMLElement,
  opts?: { timeoutMs?: number; onWait?: (elapsedMs: number) => void },
): Promise<{ ready: boolean; waitedMs: number }> {
  const timeoutMs = opts?.timeoutMs ?? READY_TIMEOUT_MS;
  const started = Date.now();
  try {
    await (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
  } catch {
    /* font loading API missing → nothing to wait for */
  }
  let stable = 0;
  let lastKey = '';
  while (Date.now() - started < timeoutMs) {
    const sig = renderSignature(root);
    if (!sig.busy && sig.key === lastKey) {
      stable += 1;
      if (stable >= READY_STABLE_READS) return { ready: true, waitedMs: Date.now() - started };
    } else {
      stable = 0;
    }
    lastKey = sig.key;
    opts?.onWait?.(Date.now() - started);
    await sleep(READY_POLL_MS);
  }
  return { ready: false, waitedMs: Date.now() - started };
}

