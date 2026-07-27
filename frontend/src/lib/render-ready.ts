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
  // A tile counts as "painted" when it holds a sized chart/table OR any text
  // (KPI cards, text widgets have no svg). Tiles exist in the DOM the instant a
  // page switches, so "tiles present but nothing painted yet" is the classic
  // capture-too-early state — treat it as busy.
  const painted = tileEls.filter((t) => {
    const el = t.querySelector('svg,canvas,table') as HTMLElement | null;
    if (el && el.getBoundingClientRect().height > 12) return true;
    return (t.innerText || '').trim().length > 0;
  }).length;
  return {
    busy: spinners > 0 || pendingImages > 0 || (tileEls.length > 0 && painted === 0),
    key: `${tileEls.length}|${painted}|${sized}|${rows}|${parts.join(',')}`,
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

