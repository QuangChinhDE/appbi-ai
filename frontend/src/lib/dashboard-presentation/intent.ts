/**
 * How much of the page the user's words hand over.
 *
 * The model is not asked this question, or rather its answer is only ever
 * allowed to be SMALLER than this one. A language model that reads "make it
 * look like a modern SaaS report" will cheerfully rebuild the page, because a
 * rebuilt page is the most impressive answer — and the user, who spent an hour
 * placing those charts, asked for a look, not a layout. So the permission is
 * decided here, deterministically, from the words, and the plan is clamped to
 * it in code (`validator.coerceModelPlan`, then the executor and the mutation
 * validator). A prompt cannot widen it and neither can the model.
 *
 * FAIL SAFE. The default is `style`, and every rule is written so that a
 * sentence it does not understand stays at `style`:
 *   - "keep / don't move / no need to rearrange" beats everything;
 *   - a noun alone ("layout", "bố cục") grants nothing — "a cleaner layout feel"
 *     is a look;
 *   - a targeted move needs a MOVE/SIZE verb AND something to move (a KPI, a
 *     chart, the filters, or — when visuals are selected — "this / it");
 *   - recomposing the page needs an explicit request to rebuild or rearrange it.
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
export function foldText(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ');
}

/** Explicit "leave the arrangement alone" — beats every other signal. */
const KEEP_LAYOUT = [
  /\bkeep (the |my |our )?(same |current |existing |original )?(layout|arrangement|positions?|structure|placement|grid)\b/,
  /\bleave (the |my )?(layout|arrangement|positions?)\b/,
  /\b(layout|arrangement|positions?) (as is|as it is|unchanged|stays?|the same)\b/,
  /\b(don'?t|do not|never|without|no need to|not) (move|moving|rearrang\w*|reorder\w*|reorganis\w*|reorganiz\w*|resiz\w*|touch(ing)? the (layout|positions?)|chang\w* (the |my )?(layout|arrangement|positions?))\b/,
  /\bgiu (nguyen |y |lai )?(bo cuc|vi tri|layout|cau truc|cach sap xep|kich thuoc)\b/,
  /\b(bo cuc|vi tri|layout) (giu nguyen|nhu cu|khong doi)\b/,
  /\b(khong|dung|chua|khoi|khong can|chua can|dung co) (duoc )?(doi|thay doi|di chuyen|dich chuyen|xep lai|sap xep|sap xep lai|dong vao|dung vao|dao lon) ?(bo cuc|vi tri|layout|cho|gi|chart|bieu do)?\b/,
  /\bchi (doi|thay|lam dep|chinh) (mau|style|giao dien|theme|font|phong cach|mau sac)\b/,
];

/** The user handed over the whole page. */
const REDESIGN = [
  /\bre-?design\b/,
  /\bre-?build (the |this )?(page|dashboard|report|layout|presentation|whole)\b/,
  /\bfrom scratch\b/,
  /\b(a |an )?(new|different|fresh|completely different) (layout|composition|arrangement|structure)\b/,
  /\b(create|build|make|design|give me) (an? |the )?[\w\s-]{0,40}\bcomposition\b/,
  /\brecompos\w*\b/,
  /\bre-?imagine\b/,
  /\bchange (the |this |my )?(whole |entire |overall )?(layout|arrangement|structure)\b/,
  /\b(transform|turn) (it|this|the page|the dashboard|the report) into .*\b(report|dashboard|page|deck|board)\b/,
  /\bthiet ke lai\b/,
  /\blam lai (toan bo|ca trang|bo cuc|dashboard|bao cao|trang)\b/,
  /\bdung lai (trang|bo cuc|dashboard|bao cao)\b/,
  /\bbo cuc moi\b/,
  /\b(doi|thay doi|thay) (toan bo |lai )?bo cuc\b/,
  /\bbien (no|trang nay|dashboard nay|bao cao nay) thanh .*\b(report|dashboard|bao cao|trang)\b/,
];

/** "Rearrange it", with nothing named: recomposition, locks still hold. Checked
 *  AFTER the targeted rules so "sắp xếp KPI lên trên" stays a targeted move. */
const GENERIC_REARRANGE = [
  /\bre-?arrang\w*\b/,
  /\bre-?organi[sz]\w*\b/,
  /\bre-?order\w*\b/,
  /\bre-?layout\b/,
  /\bsap xep lai\b/,
  /\bsap lai\b/,
  /\bxep lai\b/,
  /\bto chuc lai\b/,
  /\bsap xep (cho |sao cho )?(dep|gon|hop ly|khoa hoc|ro rang)/,
];

/** Something on the page that can be moved or resized. */
const VISUAL_NOUN = /\b(kpis?|charts?|graphs?|tables?|visuals?|tiles?|cards?|widgets?|filters?|slicers?|trends?|donuts?|pies?|bars?|lines?|maps?|numbers?|metrics?|headline|panel|section|bang|bieu do|chart|bo loc|the kpi|chi so|so lieu|xu huong|khoi|phan)\b/;
/** Words that refer to the SELECTION — only count when something is selected. */
const SELECTION_NOUN = /\b(this|these|that|those|it|them|selected|cai nay|nhung cai nay|no|chung|muc nay|phan nay|may cai nay)\b/;

/** A move or resize verb phrase. */
const MOVE_OR_SIZE = [
  /\b(move|put|place|bring|push|shift|drag|pin|stack|group|gather|line up|align)\b.*\b(top|bottom|left|right|first|last|up|down|above|below|beside|next to|together|row|column|side|front)\b/,
  /\b(bigger|larger|smaller|wider|narrower|taller|shorter|enlarge|shrink|expand|full[- ]width|more (room|space)|less (room|space))\b/,
  /\bmake (it|this|that|them|the [\w\s]{1,30}?) (big|large|small|wide|tall|narrow|short)(ger|er)?\b/,
  /\bswap\b/,
  /\bside by side\b/,
  /\b(main|hero|primary|lead) (chart|visual)\b/,
  /\b(to|on) the (left|right|top|bottom)\b/,
  /\b(dua|chuyen|di chuyen|dich|gom|keo|dat|don|xep|cho)\b.*\b(len|xuong|tren|duoi|trai|phai|dau|cuoi|canh|mot hang|mot dong|ben)\b/,
  /\b(lon hon|to hon|nho hon|rong hon|hep hon|cao hon|thap hon|phong to|thu nho|full chieu ngang|het chieu ngang|chiem (ca|nua|het))\b/,
  /\bdoi cho\b/,
  /\bcanh nhau\b/,
  /\b(chart|bieu do) chinh\b/,
  /\blam (chart|bieu do) chinh\b/,
];

export interface LayerInference {
  layer: DesignLayer;
  /** Which rule decided, for the diff note and for tests. */
  reason: 'keep-layout' | 'redesign' | 'structure' | 'rearrange' | 'default-style';
}

export interface InferOptions {
  /** Visuals are selected, so "this / it" names something to move. */
  hasSelection?: boolean;
}

/**
 * The permission the user's words grant. Pure and deterministic: the same
 * sentence always grants the same layer, which is what lets a test pin it.
 */
export function inferDesignLayer(prompt: string, options: InferOptions = {}): LayerInference {
  const text = foldText(prompt);
  if (KEEP_LAYOUT.some((rule) => rule.test(text))) return { layer: 'style', reason: 'keep-layout' };
  if (REDESIGN.some((rule) => rule.test(text))) return { layer: 'redesign', reason: 'redesign' };
  const namesSomething = VISUAL_NOUN.test(text) || (options.hasSelection === true && SELECTION_NOUN.test(text));
  if (namesSomething && MOVE_OR_SIZE.some((rule) => rule.test(text))) {
    return { layer: 'structure', reason: 'structure' };
  }
  if (GENERIC_REARRANGE.some((rule) => rule.test(text))) return { layer: 'redesign', reason: 'rearrange' };
  return { layer: 'style', reason: 'default-style' };
}
