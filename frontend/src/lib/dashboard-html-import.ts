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
  const keywordText = [
    heading,
    text,
    element.getAttribute('class') ?? '',
    element.getAttribute('id') ?? '',
    element.getAttribute('data-testid') ?? '',
  ].join(' ');

  if (tag === 'table' || table) return 'table';
  if (tag === 'h1' || tag === 'h2' || tag === 'h3') return 'title';
  if (KPI_KEYWORD_RE.test(keywordText)) return 'kpi';
  if (BLOCK_KEYWORD_RE.test(keywordText) || element.querySelector('canvas, svg')) return 'chart';
  return undefined;
}

function countMeaningfulChildren(element: HTMLElement): number {
  return Array.from(element.children).filter((child) => {
    if (!(child instanceof HTMLElement)) return false;
    if (SKIP_TAGS.has(child.tagName.toLowerCase())) return false;
    return normalizeText(child.innerText || child.textContent, 120).length > 0 || Boolean(child.querySelector('table, canvas, svg'));
  }).length;
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

  if (tag === 'table' || hasVisualChild || table) return true;
  if (depth <= 1 && childCount >= 4 && !BLOCK_KEYWORD_RE.test(classOrId) && !heading) return false;
  if (childCount >= 8 && !BLOCK_KEYWORD_RE.test(classOrId) && !heading) return false;
  if (KPI_KEYWORD_RE.test(classOrId) && text.length >= 8) return true;
  if (BLOCK_KEYWORD_RE.test(`${classOrId} ${heading}`) && text.length >= 16) return true;
  if (heading && text.length >= 24 && childCount <= 6) return true;
  if (text.length >= 120 && childCount <= 3) return true;
  return false;
}

function summarizeElement(element: HTMLElement, order: number): DashboardHtmlSummaryBlock {
  const heading = normalizeText(element.querySelector('h1, h2, h3, h4, h5, h6')?.textContent, 160);
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
  };
}

function collectBlocks(root: Element, depth = 0, blocks: HTMLElement[] = []): HTMLElement[] {
  Array.from(root.children).forEach((child) => {
    if (!(child instanceof HTMLElement)) return;
    if (SKIP_TAGS.has(child.tagName.toLowerCase())) return;

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

export function summarizeImportedDashboardHtml(html: string): DashboardHtmlSummary {
  const normalizedHtml = String(html ?? '').trim();
  if (!normalizedHtml) {
    return { title: '', blocks: [] };
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(normalizedHtml, 'text/html');
  const root = doc.body ?? doc.documentElement;
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
      const block = summarizeElement(element, index + 1);
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
    title,
    blocks,
  };
}
