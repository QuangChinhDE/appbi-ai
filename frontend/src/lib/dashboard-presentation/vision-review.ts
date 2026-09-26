/**
 * The visual review of a rendered preview — the half of the closed loop that
 * DOM geometry cannot do.
 *
 * After the deterministic critic has run, the preview the author is looking at
 * is captured as an image and reviewed ONCE by a vision model against a fixed
 * rubric (hierarchy, legibility, composition, balance, consistency, density,
 * emphasis). Its proposed repairs are coerced here through the same closed
 * style allow-list as every design change and must pass the same validator;
 * a repair outside the granted permission, on a tile not in scope, or with a
 * value no renderer draws is dropped. The scores are shown as advice — they
 * certify nothing.
 */
import { isAllowedChartStyleKey, isValidStyleValue } from './capabilities';
import { auditRenderedTiles, type RenderFinding } from './render-audit';
import type { PresentationMutation, VisualId } from './types';

export interface VisionReview {
  scores: Record<string, number>;
  overall: number | null;
  summary: string;
  issues: { visual?: number; problem: string; fix?: { key: string; value: unknown } }[];
}

export interface RenderReadiness { ready: boolean; reason?: string; waitedMs: number }

/** What is still loading inside `root`, or null when the render has settled. */
export function pendingWork(root: HTMLElement): string | null {
  const spinning = root.querySelectorAll('.animate-spin, [aria-busy="true"], [data-loading="true"]').length;
  if (spinning) return `${spinning} visual(s) still loading`;
  const updating = root.querySelectorAll('.dashboard-narrative__item.is-pending').length;
  if (updating) return `${updating} finding(s) still updating`;
  const images = Array.from(root.querySelectorAll('img')).filter((img) => !(img as HTMLImageElement).complete).length;
  if (images) return `${images} image(s) not loaded`;
  return null;
}

function layoutSignature(root: HTMLElement): string {
  return Array.from(root.querySelectorAll('[data-grid-item-id]'))
    .map((el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`; })
    .join('|');
}

/**
 * Wait until the preview is a FINISHED report: every lazy tile mounted (the
 * canvas is scrolled through once to mount them), no spinner or "updating"
 * sentence, fonts and images loaded, and the layout still for two polls. A
 * placeholder is never reviewed as if it were the design: on timeout the
 * review is skipped and the reason is said.
 */
export async function waitForSettledRender(root: HTMLElement, timeoutMs = 20_000): Promise<RenderReadiness> {
  const started = Date.now();
  const scroller = (root.closest('main') as HTMLElement | null) ?? (document.scrollingElement as HTMLElement | null);
  if (scroller) {
    const back = scroller.scrollTop;
    for (let y = 0; y <= scroller.scrollHeight; y += Math.max(300, scroller.clientHeight / 2)) {
      scroller.scrollTop = y;
      await new Promise((r) => setTimeout(r, 120));
    }
    scroller.scrollTop = back;
  }
  try { await (document as any).fonts?.ready; } catch { /* fonts API absent: nothing to wait for */ }
  let last = '';
  let stable = 0;
  while (Date.now() - started < timeoutMs) {
    const pending = pendingWork(root);
    const sig = layoutSignature(root);
    stable = !pending && sig === last ? stable + 1 : 0;
    last = sig;
    if (stable >= 2) return { ready: true, waitedMs: Date.now() - started };
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ready: false, reason: pendingWork(root) ?? 'the layout kept moving', waitedMs: Date.now() - started };
}

/** The preview as a compact JPEG data URL (≤ 1280px wide). */
export async function capturePreview(root: HTMLElement): Promise<string | null> {
  try {
    const { default: html2canvas } = await import('html2canvas-pro');
    const width = root.scrollWidth || root.clientWidth;
    const scale = Math.min(1, 1280 / Math.max(1, width));
    const canvas = await html2canvas(root, { scale, useCORS: true, logging: false, backgroundColor: null });
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  }
}

/** At most this many reviews per preview: the first, and one re-check of the
 *  repaired render. The re-check never repairs again — it reports. */
export const MAX_REVIEW_ROUNDS = 2;

/** What a style repair cannot fix: the render itself failed (no marks, content
 *  cut off, a tile off the canvas or on top of another). Reported as such,
 *  never scored as a design choice and never "repaired" with a style token. */
const RENDER_DEFECT_CODES = new Set(['chart.noMarks', 'content.overflow', 'tile.offCanvas', 'tile.overlap']);
export function renderDefects(root: ParentNode): RenderFinding[] {
  try {
    return auditRenderedTiles(root).findings.filter((f) => RENDER_DEFECT_CODES.has(f.code));
  } catch {
    return [];
  }
}

export interface RepairRecord { visual: VisualId; key: string; problem: string }

export interface ReviewOutcome {
  /** Repaired issues the re-check no longer reports on that visual. */
  resolved: RepairRecord[];
  /** Repaired issues whose visual the re-check still flags. */
  persisting: Array<RepairRecord & { now: string }>;
  /** Legibility the re-check scored below "acceptable" (3/5). */
  lowLegibility: boolean;
}

/**
 * Compare the re-check with the repairs made after the first look. A repair is
 * only "resolved" when the re-rendered image no longer shows a problem on that
 * visual; a changed style token alone proves nothing.
 */
export function reviewOutcome(repaired: RepairRecord[], recheck: VisionReview): ReviewOutcome {
  const flagged = new Map<number, string>();
  for (const issue of recheck.issues) if (issue.visual !== undefined) flagged.set(issue.visual, issue.problem);
  const resolved: RepairRecord[] = [];
  const persisting: Array<RepairRecord & { now: string }> = [];
  for (const r of repaired) {
    const now = flagged.get(r.visual);
    if (now) persisting.push({ ...r, now });
    else resolved.push(r);
  }
  const legibility = Number(recheck.scores?.legibility);
  return { resolved, persisting, lowLegibility: Number.isFinite(legibility) && legibility < 3 };
}

export function recheckNote(outcome: ReviewOutcome, recheck: VisionReview): string {
  const parts = Object.entries(recheck.scores).map(([k, v]) => `${k} ${v}/5`).join(', ');
  const total = outcome.resolved.length + outcome.persisting.length;
  const head = `Re-checked the repaired preview (advice, not a certificate): ${parts || 'no scores'}.`;
  const fixed = total ? ` ${outcome.resolved.length} of ${total} repaired issue(s) no longer visible.` : '';
  const still = outcome.persisting.length
    ? ` Still visible: ${outcome.persisting.map((p) => `visual ${p.visual} — ${p.now}`).join('; ')}.`
    : '';
  const legible = outcome.lowLegibility ? ' Legibility is still below acceptable; the design is not accepted on looks.' : '';
  return `${head}${fixed}${still}${legible}`;
}

export function renderDefectNote(defects: RenderFinding[]): string {
  if (defects.length === 0) return '';
  const byTile = defects.slice(0, 4).map((d) => `visual ${d.tileId}: ${d.detail ?? d.code}`).join('; ');
  return `Render defects, not design choices (a style change cannot fix them): ${byTile}${defects.length > 4 ? ` and ${defects.length - 4} more` : ''}.`;
}

/** Fold the review's repairs into the preview's mutation, within scope. */
export function applyReviewRepairs(
  mutation: PresentationMutation,
  review: VisionReview,
  opts: { allowed: ReadonlySet<VisualId>; currentStyle: (id: VisualId) => Record<string, unknown> },
): { mutation: PresentationMutation; applied: number; repaired: RepairRecord[] } {
  const layoutOverrides = { ...mutation.layoutOverrides };
  const repaired: RepairRecord[] = [];
  let applied = 0;
  for (const issue of review.issues) {
    const fix = issue.fix;
    const id = issue.visual;
    if (!fix || id === undefined || !opts.allowed.has(id)) continue;
    if (!isAllowedChartStyleKey(fix.key) || !isValidStyleValue(fix.key, fix.value)) continue;
    const prev = (layoutOverrides[id] ?? {}) as Record<string, any>;
    const style = { ...(prev.styleConfigOverride ?? opts.currentStyle(id)), [fix.key]: fix.value };
    layoutOverrides[id] = { ...prev, styleConfigOverride: style } as any;
    applied += 1;
    repaired.push({ visual: id, key: fix.key, problem: issue.problem });
  }
  return { mutation: { ...mutation, layoutOverrides }, applied, repaired };
}

export function reviewNote(review: VisionReview, applied: number): string {
  const parts = Object.entries(review.scores).map(([k, v]) => `${k} ${v}/5`).join(', ');
  const head = `Visual review of the rendered preview (advice, not a certificate): ${parts || 'no scores'}.`;
  const tail = applied > 0 ? ` Applied ${applied} presentation fix${applied === 1 ? '' : 'es'} within your permission.` : '';
  return `${head}${review.summary ? ` ${review.summary}` : ''}${tail}`;
}
