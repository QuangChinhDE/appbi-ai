/**
 * How much of the page the user's words hand over.
 *
 * The model is not asked this question, or rather its answer is only ever
 * allowed to be SMALLER than this one. A language model that reads "make it
 * look like a modern SaaS report" will cheerfully rebuild the page, because a
 * rebuilt page is the most impressive answer — and the user, who spent an hour
 * placing those charts, asked for a look, not a layout. So the permission is
 * decided here, deterministically, from the words, and the plan is clamped to
 * it in code (`executor.ts`). A prompt engineer cannot widen it and neither can
 * the model.
 *
 * The default is `style`. Silence about layout is not permission to change it.
 */
import type { DesignLayer } from './types';

const RANK: Record<DesignLayer, number> = { style: 0, structure: 1, redesign: 2 };

export function layerRank(layer: DesignLayer): number {
  return RANK[layer];
}

/** The smaller of two layers — a plan may ask for less than it was granted. */
export function clampLayer(requested: DesignLayer | undefined | null, granted: DesignLayer): DesignLayer {
  if (!requested || !(requested in RANK)) return granted;
  return RANK[requested] <= RANK[granted] ? requested : granted;
}

// Normalise diacritics away so "sắp xếp" and "sap xep" match the same rule, and
// lower-case once. Vietnamese đ has no combining form and is mapped explicitly.
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd');
}

/** Explicit "leave the layout alone" — beats every other signal. */
const KEEP_LAYOUT = [
  /\bkeep (the )?(same |current |existing )?(layout|arrangement|positions?|structure)\b/,
  /\b(don'?t|do not|without) (move|moving|rearrang\w*|chang\w* (the )?(layout|positions?))\b/,
  /\blayout (as is|unchanged)\b/,
  /\bgiu (nguyen )?(bo cuc|vi tri|layout|cau truc)\b/,
  /\bkhong (doi|thay doi|di chuyen|xep lai|sap xep lai) (bo cuc|vi tri|layout)\b/,
  /\bchi (doi|thay) (mau|style|giao dien|theme|font)\b/,
];

/** The user handed over the whole page. */
const REDESIGN = [
  /\bre-?design\b/,
  /\bre-?build (the )?(page|dashboard|report|layout|presentation)\b/,
  /\bfrom scratch\b/,
  /\b(new|different|fresh) (layout|composition|arrangement)\b/,
  /\bcomposition\b/,
  /\brecompose\b/,
  /\bre-?imagine\b/,
  /\b(transform|turn) (it|this|the page|the dashboard|the report) into .*\b(report|dashboard|page|deck|board)\b/,
  /\bthiet ke lai\b/,
  /\blam lai (toan bo|ca trang|bo cuc|dashboard|bao cao)\b/,
  /\bdung lai\b/,
  /\bbo cuc moi\b/,
  /\bbien (no|trang nay|dashboard nay|bao cao nay) thanh .*\b(report|dashboard|bao cao|trang)\b/,
];

/** A specific arrangement request: it names what moves. */
const STRUCTURE = [
  /\b(move|put|place|bring|push|drag|shift)\b.*\b(top|bottom|left|right|first|last|up|down|above|below|beside|next to)\b/,
  /\b(bigger|larger|smaller|wider|narrower|taller|shorter|enlarge|shrink|full[- ]width)\b/,
  /\bmake (it|this|that|the \w+( \w+)?) (big|large|small|wide|tall)\w*\b/,
  /\bswap\b/,
  /\bside by side\b/,
  /\b(group|gather|stack)\b.*\b(together|on top|at the top|in a row|row)\b/,
  /\b(hierarchy|main chart|hero chart|primary chart)\b/,
  /\b(filters?|slicers?) (to|on) the (left|right|top|bottom)\b/,
  /\b(dua|chuyen|di chuyen|gom|keo|dat|don)\b.*\b(len|xuong|tren|duoi|trai|phai|dau|cuoi|canh)\b/,
  /\b(lon hon|to hon|nho hon|rong hon|hep hon|cao hon|thap hon|phong to|thu nho|full chieu ngang|het chieu ngang)\b/,
  /\bdoi cho\b/,
  /\bcanh nhau\b/,
  /\b(phan cap|chart chinh|bieu do chinh)\b/,
];

/**
 * "Rearrange it", with nothing named. The user handed over the arrangement of
 * the whole page but did not say what goes where, so a targeted operation has
 * nothing to act on - this grants recomposition, and locks still hold. Checked
 * AFTER the targeted rules so "sap xep KPI len tren" stays a targeted move.
 */
const GENERIC_REARRANGE = [
  /\bre-?arrang\w*\b/,
  /\bre-?organi[sz]\w*\b/,
  /\bre-?order\w*\b/,
  /\bre-?layout\b/,
  /\bsap xep\b/,
  /\bsap lai\b/,
  /\bxep lai\b/,
  /\bto chuc lai\b/,
  /\bbo cuc\b/,
  /\blayout\b/,
];

export interface LayerInference {
  layer: DesignLayer;
  /** Which rule decided, for the diff note and for tests. */
  reason: 'keep-layout' | 'redesign' | 'structure' | 'rearrange' | 'default-style';
}

/**
 * The permission the user's words grant. Pure and deterministic: the same
 * sentence always grants the same layer, which is what lets a test pin it.
 */
export function inferDesignLayer(prompt: string): LayerInference {
  const text = fold(String(prompt ?? ''));
  if (KEEP_LAYOUT.some((rule) => rule.test(text))) return { layer: 'style', reason: 'keep-layout' };
  if (REDESIGN.some((rule) => rule.test(text))) return { layer: 'redesign', reason: 'redesign' };
  if (STRUCTURE.some((rule) => rule.test(text))) return { layer: 'structure', reason: 'structure' };
  if (GENERIC_REARRANGE.some((rule) => rule.test(text))) return { layer: 'redesign', reason: 'rearrange' };
  return { layer: 'style', reason: 'default-style' };
}
