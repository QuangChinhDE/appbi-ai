import type { DashboardHtmlSummary, DashboardHtmlSummaryBlock } from '@/types/dashboard-html-import';

const BLOCK_KEYWORD_RE = /\b(chart|graph|plot|viz|visual|trend|timeseries|time series|share|mix|breakdown|composition|rank|kpi|metric|summary|table)\b/i;
const KPI_KEYWORD_RE = /\b(kpi|metric|score|total|avg|average|growth|rate|summary)\b/i;
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'meta', 'link', 'head']);
const APPBI_METADATA_RE = /<script[^>]+type\s*=\s*["']application\/appbi-dashboard["'][^>]*>([\s\S]*?)<\/script>/i;

function normalizeText(value: string | null | undefined, maxLen = 900): string {
  const normalized = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
}

function summarizeTable(element: HTMLElement): DashboardHtmlSummaryBlock['table'] {
  const table = element.tagName.toLowerCase() === 'table'
    ? element as HTMLTableElement
    : element.querySelector('table');
  if (!table) return null;

  const headerCells = Array.from(table.querySelectorAll('thead th, tr th'))
    .map((cell) => normalizeText(cell.textContent, 120))
    .filter(Boolean)
    .slice(0, 12);
  const rows = Array.from(table.querySelectorAll('tbody tr, tr'))
    .slice(0, 4)
    .map((row) => Array.from(row.querySelectorAll('td, th'))
      .map((cell) => normalizeText(cell.textContent, 120))
      .filter(Boolean)
      .slice(0, 12))
    .filter((row) => row.length > 0);

  if (headerCells.length === 0 && rows.length === 0) return null;
  return { headers: headerCells, rows };
}

function inferBlockRole(
  element: HTMLElement,
  heading: string,
  text: string,
  table: DashboardHtmlSummaryBlock['table'],
): string | undefined {
  const tag = element.tagName.toLowerCase();
  // Keywords are read from what the AUTHOR NAMED the block, not from its prose.
  // Matching prose let one word decide the role: a pull quote reading "Late
  // orders average 4.1 days beyond estimate" matched `average` and was
  // classified as a KPI, so it was laid out in the metric strip -- while the
  // three actual KPI cards beside it, whose wrappers had no class at all,
  // matched nothing and were classified as copy.
  const namedText = [
    element.getAttribute('class') ?? '',
    element.getAttribute('id') ?? '',
    element.getAttribute('data-testid') ?? '',
  ].join(' ');

  // What a metric LOOKS like: a small box that is mostly a figure. This is the
  // signal that survives a source with no useful class names, which is most
  // generated HTML.
  const compactMetric = !table
    && !element.querySelector('canvas, svg')
    && text.length > 0
    && text.length <= 48
    && (text.match(/\d/g) || []).length >= 2;

  if (tag === 'table' || table) return 'table';
  if (/^h[1-6]$/.test(tag)) return 'title';
  if (compactMetric || KPI_KEYWORD_RE.test(namedText)) return 'kpi';
  if (BLOCK_KEYWORD_RE.test(`${namedText} ${heading}`) || element.querySelector('canvas, svg')) return 'chart';
  return undefined;
}

/**
 * `instanceof HTMLElement` across realms.
 *
 * A staged source document lives inside an iframe, and its elements are
 * instances of THAT window's HTMLElement -- not this one's. A bare
 * `instanceof` check is therefore false for every node in it, which silently
 * emptied the block list: the backend then fell back to its "no blocks" path
 * and turned the whole page into a single block, so a nine-section console
 * imported as one chart.
 */
function isElement(node: unknown): node is HTMLElement {
  return Boolean(node) && (node as Node).nodeType === 1 && typeof (node as HTMLElement).tagName === 'string';
}

function countMeaningfulChildren(element: HTMLElement): number {
  return Array.from(element.children).filter((child) => {
    if (!isElement(child)) return false;
    if (SKIP_TAGS.has(child.tagName.toLowerCase())) return false;
    return normalizeText(child.innerText || child.textContent, 120).length > 0 || Boolean(child.querySelector('table, canvas, svg'));
  }).length;
}

/**
 * How many units of content this element contains.
 *
 * A unit is something that stands alone in a report: a chart, a table, a
 * drawing. An element holding two or more of them is a SECTION, and a section
 * has to be walked into rather than taken whole.
 *
 * Counted across the whole subtree, not among the direct children. Counting
 * children missed the commonest page shape there is -- a filter rail beside one
 * content column -- because the wrapper had exactly one child carrying
 * anything, so the wrapper was taken whole and a nine-block report imported as
 * a single tile.
 */
function countUnits(element: HTMLElement): number {
  return element.querySelectorAll('canvas, svg, table').length;
}

function isMeaningfulBlock(element: HTMLElement, depth: number): boolean {
  const tag = element.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return false;

  const heading = normalizeText(element.querySelector('h1, h2, h3, h4, h5, h6')?.textContent, 160);
  const text = normalizeText(element.innerText || element.textContent, 900);
  const table = summarizeTable(element);
  const childCount = countMeaningfulChildren(element);
  const hasVisualChild = Boolean(element.querySelector('canvas, svg'));
  const classOrId = `${element.className ?? ''} ${element.id ?? ''}`;

  // A bare heading IS the block that introduces the tiles under it. Without
  // this it matched nothing below -- no `heading` descendant, too little text --
  // so an imported report arrived with its section structure stripped out.
  if (/^h[1-6]$/.test(tag) && text.length >= 3) return true;

  // The section guard, and it has to come FIRST.
  //
  // `hasVisualChild` is a descendant query at any depth, so the outermost
  // wrapper of any page containing a single <svg> anywhere was accepted whole
  // and `collectBlocks` never recursed. Every vibe-coded report draws
  // something, so every one of them arrived as EXACTLY ONE block: measured on
  // a 4-KPI, 4-chart, 1-gauge, 1-table console, the analyzer received one block
  // whose text was the entire page. That is why imported dashboards never
  // resembled their source -- there was never more than one thing to arrange.
  if (countUnits(element) >= 2) return false;

  if (tag === 'table' || hasVisualChild || table) return true;
  if (depth <= 1 && childCount >= 4 && !BLOCK_KEYWORD_RE.test(classOrId) && !heading) return false;
  if (childCount >= 8 && !BLOCK_KEYWORD_RE.test(classOrId) && !heading) return false;
  if (KPI_KEYWORD_RE.test(classOrId) && text.length >= 8) return true;
  if (BLOCK_KEYWORD_RE.test(`${classOrId} ${heading}`) && text.length >= 16) return true;
  if (heading && text.length >= 24 && childCount <= 6) return true;
  if (text.length >= 120 && childCount <= 3) return true;

  // A small box whose text is mostly a figure is a metric, whatever its class
  // is called -- and class names were the only signal here. A KPI row written
  // with unnamed wrappers (`<div><div class="label">…</div><div class="value">…`)
  // matched nothing at all and its three headline figures were dropped.
  if (
    childCount <= 3
    && !hasVisualChild
    && countUnits(element) === 0
    && text.length > 0
    && text.length <= 48
    && (text.match(/\d/g) || []).length >= 2
  ) {
    return true;
  }

  return false;
}

/**
 * Render source HTML in a real browsing context so its CSS actually applies.
 *
 * `DOMParser.parseFromString` returns an INERT document: no view, no CSSOM, no
 * layout. Every `getComputedStyle` call against it comes back with initial
 * values, so a fragment captured from it is markup with `background: transparent`
 * and `border-radius: 0` frozen into it -- worse than not capturing at all,
 * because it also carries the payload.
 *
 * An offscreen iframe is the smallest thing that IS a browsing context. It is
 * also the isolation: the source's `body {}` and `.card {}` rules stay inside
 * it instead of repainting the app around it. `sandbox` without
 * `allow-scripts` means the source's own JavaScript never runs.
 */
const STAGE_WIDTH = 1240;
const STAGE_HEIGHT = 2400;
const STAGE_TIMEOUT_MS = 4000;

export async function withRenderedSource<T>(
  html: string,
  visit: (doc: Document) => T,
): Promise<T | null> {
  if (typeof document === 'undefined') return null;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.style.cssText =
    `position:fixed;left:-20000px;top:0;width:${STAGE_WIDTH}px;height:${STAGE_HEIGHT}px;` +
    'border:0;visibility:hidden;pointer-events:none;';
  frame.srcdoc = html;
  document.body.appendChild(frame);
  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      frame.addEventListener('load', done, { once: true });
      // A source that never fires load (a pending font, a hung image) must not
      // hang the import: measuring a partly-styled page beats measuring none.
      window.setTimeout(done, STAGE_TIMEOUT_MS);
    });
    const doc = frame.contentDocument;
    if (!doc || !doc.body) return null;
    return visit(doc);
  } catch {
    return null;
  } finally {
    frame.remove();
  }
}

/**
 * CSS properties worth carrying with a preserved fragment.
 *
 * A vibe-coded block looks designed because of a stylesheet in `<head>`, not
 * because of anything on the element. Sending `outerHTML` therefore sends class
 * names that mean nothing on the far side, and the block arrives as unstyled
 * text -- which is exactly the "we dropped it" outcome the fragment exists to
 * avoid. Freezing a curated set of COMPUTED values onto each element carries
 * the look across without carrying the stylesheet (and without a `<style>` tag
 * that would let source CSS reach the rest of the dashboard).
 *
 * The set is curated rather than exhaustive on purpose: `getComputedStyle`
 * exposes ~340 properties, and serializing all of them turns a 20-element card
 * into 60KB of noise that the fragment cap then truncates.
 */
const FRAGMENT_STYLE_PROPS = [
  'display', 'flex-direction', 'flex-wrap', 'flex', 'gap', 'row-gap', 'column-gap',
  'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
  'align-items', 'justify-content', 'align-self', 'text-align',
  'padding', 'margin', 'width', 'height', 'min-height', 'max-width',
  'background-color', 'background-image',
  'border', 'border-radius', 'box-shadow', 'opacity',
  'color', 'font-family', 'font-size', 'font-weight', 'line-height',
  'letter-spacing', 'text-transform', 'white-space', 'overflow',
  'position', 'inset', 'transform', 'z-index',
] as const;

/** Defaults not worth serializing -- they are what the property already is. */
const FRAGMENT_STYLE_NOISE = new Set([
  'none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)', 'transparent', '0s', 'visible',
  // Initial values that `getComputedStyle` reports for every element whether or
  // not the page ever said them. Left in, they tripled the size of a fragment.
  'start', '1', '0 1 auto', 'row', 'nowrap', 'static', 'baseline', 'block', 'inline',
  '0%', 'repeat', 'scroll', 'padding-box', 'border-box',
]);

const FRAGMENT_MAX_ELEMENTS = 160;
const FRAGMENT_MAX_CHARS = 20000;

/**
 * Freeze an element's rendered appearance into standalone markup.
 *
 * Returns '' when there is nothing worth preserving, so the caller can leave
 * `html` off the block entirely rather than shipping an empty fragment.
 */
export function captureFragment(element: HTMLElement): string {
  // Measure on the LIVE element -- a detached clone has no computed style at
  // all, so reading styles after cloning yields the initial value for every
  // property and the fragment comes back blank.
  // The element belongs to the STAGED document, not this page, so the styles
  // have to be read through that document's own window. Using the app's
  // `window` here returns initial values for everything and the fragment comes
  // back with `background: transparent` frozen into it.
  const view = element.ownerDocument?.defaultView;
  if (!view) return '';

  const live: HTMLElement[] = [element, ...Array.from(element.querySelectorAll<HTMLElement>('*'))];
  if (live.length > FRAGMENT_MAX_ELEMENTS) return '';

  const frozen = live.map((node) => {
    const computed = view.getComputedStyle(node);
    const parent = node.parentElement;
    const inherited = parent && parent !== element.parentElement ? view.getComputedStyle(parent) : null;
    const declarations: string[] = [];
    for (const prop of FRAGMENT_STYLE_PROPS) {
      const value = computed.getPropertyValue(prop).trim();
      if (!value || FRAGMENT_STYLE_NOISE.has(value)) continue;
      // Inherited values are already carried by the ancestor; repeating them on
      // every descendant is most of what makes these fragments huge.
      if (inherited && inherited.getPropertyValue(prop).trim() === value) continue;
      declarations.push(`${prop}:${value}`);
    }
    return declarations.join(';');
  });

  const clone = element.cloneNode(true) as HTMLElement;
  const cloned: HTMLElement[] = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>('*'))];
  if (cloned.length !== live.length) return '';
  cloned.forEach((node, index) => {
    const style = frozen[index];
    if (style) node.setAttribute('style', style);
    else node.removeAttribute('style');
    // Class names are meaningless once the stylesheet is gone, and they collide
    // with the dashboard's own utility classes.
    node.removeAttribute('class');
    node.removeAttribute('id');
  });

  // The element sits inside a page; on its own it must not keep the absolute
  // positioning that placed it there.
  clone.style.removeProperty('position');
  clone.style.removeProperty('inset');
  clone.style.removeProperty('z-index');
  clone.style.removeProperty('transform');
  // The captured width is whatever the source page happened to be; the tile it
  // lands in is a different width. Letting the root fill its tile is the whole
  // difference between a preserved block and a screenshot of one. Inner sizes
  // stay -- a 30px avatar dot means 30px wherever it is.
  clone.style.removeProperty('width');
  clone.style.removeProperty('height');
  clone.style.removeProperty('max-width');

  const html = clone.outerHTML;
  // The backend sanitizes and caps this again; stopping here only avoids
  // posting a megabyte that is going to be thrown away.
  return html.length > FRAGMENT_MAX_CHARS ? '' : html;
}

function summarizeElement(
  element: HTMLElement,
  order: number,
  captureAppearance = false,
): DashboardHtmlSummaryBlock {
  const ownHeading = /^h[1-6]$/.test(element.tagName.toLowerCase());
  const heading = normalizeText(
    ownHeading ? element.textContent : element.querySelector('h1, h2, h3, h4, h5, h6')?.textContent,
    160,
  );
  const text = normalizeText(element.innerText || element.textContent, 900);
  const table = summarizeTable(element);
  const style = normalizeText(element.getAttribute('style'), 240);

  return {
    id: element.getAttribute('id') || `block-${order}`,
    order,
    tag: element.tagName.toLowerCase(),
    role: inferBlockRole(element, heading, text, table),
    heading,
    text,
    classes: Array.from(element.classList).slice(0, 12),
    id_attr: normalizeText(element.getAttribute('id'), 120),
    style,
    table,
    html: captureAppearance ? captureFragment(element) : '',
  };
}

/**
 * A rail or bar whose job is filtering, not saying anything.
 *
 * Its labels are collected separately as slicer candidates, so leaving it in
 * the block list double-counts it -- a left rail's `<h4>Order status</h4>`
 * caption was being imported as a section header in the middle of the report,
 * introducing nothing.
 *
 * The test is "holds controls, holds no content": a page wrapper that happens
 * to contain the filter bar still has charts and tables in it, so it fails this
 * and is walked into as normal.
 */
function isFilterRegion(element: HTMLElement): boolean {
  if (!element.querySelector(FILTER_CONTROL_SELECTOR)) return false;
  if (countUnits(element) > 0) return false;
  return normalizeText(element.innerText || element.textContent, 400).length < 200;
}

function collectBlocks(root: Element, depth = 0, blocks: HTMLElement[] = []): HTMLElement[] {
  Array.from(root.children).forEach((child) => {
    if (!isElement(child)) return;
    if (SKIP_TAGS.has(child.tagName.toLowerCase())) return;
    if (isFilterRegion(child)) return;

    if (isMeaningfulBlock(child, depth)) {
      blocks.push(child);
      return;
    }

    if (depth < 5) {
      collectBlocks(child, depth + 1, blocks);
    }
  });
  return blocks;
}

function extractEmbeddedAppbiMetadata(html: string): Record<string, any> | null {
  const match = APPBI_METADATA_RE.exec(String(html ?? ''));
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null;
  } catch {
    return null;
  }
}

/**
 * Detect an AppBI dashboard snapshot (exported via "Export HTML"). These files
 * embed a verbatim `appbi-snapshot/v1` payload and can be re-imported in one
 * click, bypassing the fuzzy HTML analyzer entirely.
 */
export function detectDashboardSnapshotHtml(html: string): {
  isSnapshot: boolean;
  name: string | null;
  chartCount: number;
} {
  const embedded = extractEmbeddedAppbiMetadata(html);
  if (!embedded || String(embedded.version ?? '').trim().toLowerCase() !== 'appbi-snapshot/v1') {
    return { isSnapshot: false, name: null, chartCount: 0 };
  }
  const dashboard = embedded.dashboard && typeof embedded.dashboard === 'object'
    ? (embedded.dashboard as Record<string, unknown>)
    : {};
  const charts = Array.isArray(embedded.charts) ? embedded.charts : [];
  const name = typeof dashboard.name === 'string' && dashboard.name.trim() ? dashboard.name.trim() : null;
  return { isSnapshot: true, name, chartCount: charts.length };
}

export function detectEmbeddedMultiPageImportHtml(html: string): {
  isMultiPage: boolean;
  pageCount: number;
  pageNames: string[];
} {
  const embedded = extractEmbeddedAppbiMetadata(html);
  if (!embedded || String(embedded.version ?? '').trim().toLowerCase() !== 'appbi-import/v2') {
    return {
      isMultiPage: false,
      pageCount: 0,
      pageNames: [],
    };
  }

  const pages = Array.isArray(embedded.pages) ? embedded.pages : [];
  const pageNames = pages
    .map((page, index) => {
      if (!page || typeof page !== 'object') return `Page ${index + 1}`;
      const title = String((page as Record<string, unknown>).title ?? (page as Record<string, unknown>).name ?? '').trim();
      return title || `Page ${index + 1}`;
    });

  return {
    isMultiPage: pageNames.length > 1,
    pageCount: pageNames.length,
    pageNames,
  };
}

/**
 * The names of the source's own filter controls.
 *
 * These are not blocks and never will be: a `<select>` in a topbar carries no
 * heading, almost no text, and no visual, so every block heuristic rejects it —
 * and the analyzer, seeing no filter anywhere, produced a report with no
 * slicers at all. A report without its filters is a screenshot.
 *
 * Only the LABEL is collected here. Turning a label into a slicer means
 * resolving it against real dataset columns, which the server does; a control
 * whose label matches nothing is dropped rather than guessed at.
 */
const FILTER_CONTROL_SELECTOR = [
  'select',
  'input[type="date"]',
  'input[type="search"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[data-filter]',
].join(', ');

const FILTER_LABEL_MAX = 60;
const FILTER_CONTROL_MAX = 8;

function labelForControl(control: Element): string {
  // In order of how reliably each names the thing being filtered.
  const id = control.getAttribute('id');
  const owner = control.ownerDocument;
  const explicit = id ? owner?.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
  const candidates: Array<string | null | undefined> = [
    control.getAttribute('aria-label'),
    control.getAttribute('data-filter'),
    explicit?.textContent,
    control.closest('label')?.textContent,
    // A control usually sits under the small caption that names it.
    control.parentElement?.querySelector('label, .label, h4, h5, span')?.textContent,
    control.getAttribute('name'),
    id,
  ];
  for (const candidate of candidates) {
    const label = normalizeText(candidate, FILTER_LABEL_MAX);
    // "All statuses" is the placeholder option, not the field name; a label
    // that is only a placeholder is worse than none because it resolves to
    // nothing and costs a round trip.
    if (label && label.length >= 2) return label;
  }
  // Last resort: the first option often reads "All sellers", which names the
  // dimension once the leading "All" is dropped.
  const firstOption = normalizeText((control as HTMLSelectElement).options?.[0]?.text, FILTER_LABEL_MAX);
  return firstOption.replace(/^all\s+/i, '').trim();
}

function collectFilterControls(root: Document): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  root.querySelectorAll(FILTER_CONTROL_SELECTOR).forEach((control) => {
    const label = labelForControl(control);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) return;
    seen.add(key);
    labels.push(label);
  });
  return labels.slice(0, FILTER_CONTROL_MAX);
}

export function summarizeImportedDashboardHtml(html: string): DashboardHtmlSummary {
  return summarizeDocument(parseSourceHtml(html));
}

/**
 * The same summary, with each block's appearance frozen into `html`.
 *
 * Separate from the synchronous version because it has to RENDER the source
 * first -- the styles that make a vibe-coded block look designed live in a
 * stylesheet, and a stylesheet only means anything inside a browsing context.
 * Falls back to the structure-only summary if the source cannot be staged, so
 * an import never fails because a fragment could not be captured.
 */
export async function summarizeImportedDashboardHtmlWithFragments(
  html: string,
): Promise<DashboardHtmlSummary> {
  const normalized = String(html ?? '').trim();
  if (!normalized) return { title: '', blocks: [] };
  const staged = await withRenderedSource(normalized, (doc) => summarizeDocument(doc, true));
  return staged ?? summarizeImportedDashboardHtml(normalized);
}

function parseSourceHtml(html: string): Document {
  return new DOMParser().parseFromString(String(html ?? '').trim(), 'text/html');
}

function summarizeDocument(doc: Document, captureAppearance = false): DashboardHtmlSummary {
  const root = doc.body ?? doc.documentElement;
  if (!root) return { title: '', blocks: [] };
  const candidateElements = collectBlocks(root);
  const seen = new Set<HTMLElement>();
  const seenIds = new Set<string>();
  const blocks = candidateElements
    .filter((element) => {
      if (seen.has(element)) return false;
      seen.add(element);
      return true;
    })
    .slice(0, 24)
    .map((element, index) => {
      const block = summarizeElement(element, index + 1, captureAppearance);
      // Deduplicate block IDs to prevent AI lookup mismatches and duplicate charts
      if (seenIds.has(block.id)) {
        block.id = `block-${index + 1}`;
      }
      seenIds.add(block.id);
      return block;
    })
    .filter((block) => block.text || block.heading || block.table);

  const title = normalizeText(
    doc.title
      || doc.querySelector('h1, h2')?.textContent
      || blocks.find((block) => block.role === 'title')?.heading
      || '',
    180,
  );

  return {
    filterControls: collectFilterControls(doc),
    title,
    blocks,
  };
}
