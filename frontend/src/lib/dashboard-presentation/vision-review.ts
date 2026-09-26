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
import type { PresentationMutation, VisualId } from './types';

export interface VisionReview {
  scores: Record<string, number>;
  overall: number | null;
  summary: string;
  issues: { visual?: number; problem: string; fix?: { key: string; value: unknown } }[];
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

/** Fold the review's repairs into the preview's mutation, within scope. */
export function applyReviewRepairs(
  mutation: PresentationMutation,
  review: VisionReview,
  opts: { allowed: ReadonlySet<VisualId>; currentStyle: (id: VisualId) => Record<string, unknown> },
): { mutation: PresentationMutation; applied: number } {
  const layoutOverrides = { ...mutation.layoutOverrides };
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
  }
  return { mutation: { ...mutation, layoutOverrides }, applied };
}

export function reviewNote(review: VisionReview, applied: number): string {
  const parts = Object.entries(review.scores).map(([k, v]) => `${k} ${v}/5`).join(', ');
  const head = `Visual review of the rendered preview (advice, not a certificate): ${parts || 'no scores'}.`;
  const tail = applied > 0 ? ` Applied ${applied} presentation fix${applied === 1 ? '' : 'es'} within your permission.` : '';
  return `${head}${review.summary ? ` ${review.summary}` : ''}${tail}`;
}
