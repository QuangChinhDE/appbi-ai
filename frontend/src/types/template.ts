/**
 * TypeScript types for the Report Template module (v3 — Builder).
 */

/* ── Layout & column types ─────────────────────────────────── */

export type LayoutType = 'table' | 'card' | 'cross-tab';
export type ColumnType = 'raw' | 'input' | 'formula' | 'subtotal';
export type NumberFormat = 'integer' | 'decimal' | 'percentage' | 'text';

/* ── Column definition ─────────────────────────────────────── */

export interface TemplateColumn {
  id: string;
  key: string;               // unique key referenced in formulas
  label: string;             // display header text
  type: ColumnType;
  sourceColumn?: string;     // maps to dataset column (raw / input)
  expression?: string;       // formula expression (formula / subtotal)
  width?: number;            // px
  align?: 'left' | 'center' | 'right';
  format?: NumberFormat;
  suffix?: string;           // e.g. "KIP", "USD", "%"
  bold?: boolean;
  highlightNegative?: boolean;
  visible?: boolean;         // default true
}

/* ── Data source binding ───────────────────────────────────── */

export interface TemplateDataSource {
  datasetId: number;
  tableId: number;
  datasetName?: string;
  tableName?: string;
}

/* ── Cross-tab config ──────────────────────────────────────── */

export interface CrossTabConfig {
  rowColumns: string[];       // column keys for row headers
  pivotColumn: string;        // column whose distinct values become columns
  valueColumn: string;        // column for cell values
  showRowTotal?: boolean;
  showColumnTotal?: boolean;
}

/* ── Card config ───────────────────────────────────────────── */

export interface CardConfig {
  cardsPerRow: number;         // 2, 3, 4
  titleColumn: string;         // column key for card title
  subtitleColumns?: string[];  // column keys for subtitle line
  totalLabel?: string;
  deductionColumns?: string[]; // columns shown as negative
}

/* ── Template definition (v3) — stored in blocks JSON field ── */

/* ── Header / Footer config ─────────────────────────────────── */

export interface HeaderLine {
  text: string;
  rightText?: string;            // optional right-side text (2-column header row)
  align?: 'left' | 'center' | 'right';
  bold?: boolean;
  fontSize?: 'sm' | 'base' | 'lg' | 'xl';
}

/* ── Column groups (merged header rows) ────────────────────── */

export interface ColumnGroup {
  id: string;
  label: string;
  columnIds: string[];           // IDs of columns this group spans
  level?: number;                // optional merged-header depth, defaults to 1
}

export interface TemplateAppendixSection {
  id: string;
  title: string;
  description?: string;
  columnKeys: string[];
  groupBy?: string;
  showSubtotals?: boolean;
}

export interface TemplateFooter {
  lines?: HeaderLine[];         // free-text lines (notes, conditions, etc.)
  signatureSlots?: number;      // number of blank signature boxes (e.g. 3)
  signatureLabels?: string[];   // labels under each signature box
}

/* ── Color theme ────────────────────────────────────────────── */

export interface TemplateTheme {
  headerBg: string;           // table header background  (hex)
  headerText: string;         // table header text color  (hex)
  groupBg: string;            // group band / section bg  (hex)
  groupText: string;          // group band text          (hex)
  subtotalBg: string;         // subtotal row bg          (hex)
  subtotalText: string;       // subtotal row text        (hex)
  accentColor: string;        // accent / primary color   (hex)
  sectionBg?: string;         // section header bg        (hex)
  sectionText?: string;       // section header text      (hex)
}

export const PRESET_THEMES: Record<string, TemplateTheme> = {
  'dark-blue': {
    headerBg: '#073763', headerText: '#ffffff',
    groupBg: '#c9daf8', groupText: '#073763',
    subtotalBg: '#dbeafe', subtotalText: '#1e40af',
    accentColor: '#4a86e8',
    sectionBg: '#c9daf8', sectionText: '#073763',
  },
  'light-gray': {
    headerBg: '#374151', headerText: '#f9fafb',
    groupBg: '#f3f4f6', groupText: '#374151',
    subtotalBg: '#f9fafb', subtotalText: '#111827',
    accentColor: '#6b7280',
    sectionBg: '#f3f4f6', sectionText: '#374151',
  },
  'green': {
    headerBg: '#065f46', headerText: '#ffffff',
    groupBg: '#d1fae5', groupText: '#065f46',
    subtotalBg: '#ecfdf5', subtotalText: '#047857',
    accentColor: '#10b981',
    sectionBg: '#d1fae5', sectionText: '#065f46',
  },
  'orange': {
    headerBg: '#9a3412', headerText: '#ffffff',
    groupBg: '#ffedd5', groupText: '#9a3412',
    subtotalBg: '#fff7ed', subtotalText: '#c2410c',
    accentColor: '#f97316',
    sectionBg: '#ffedd5', sectionText: '#9a3412',
  },
};

export const DEFAULT_THEME: TemplateTheme = PRESET_THEMES['dark-blue'];

export interface TemplateDefinition {
  version: 3;
  layout: LayoutType;
  dataSource?: TemplateDataSource;
  columns: TemplateColumn[];
  groupBy?: string;           // column key to group rows
  showSubtotals?: boolean;
  theme?: TemplateTheme;      // color customization
  header?: {
    lines?: HeaderLine[];     // multi-line header (company, address, title, etc.)
    title: string;            // supports {{variable}} placeholders
    meta?: string;
    titleAlign?: 'left' | 'center' | 'right';
    titleFontSize?: 'sm' | 'base' | 'lg' | 'xl';
    titleBold?: boolean;
  };
  footer?: TemplateFooter;
  columnGroups?: ColumnGroup[];  // merged header row groups
  appendixSections?: TemplateAppendixSection[];
  crossTabConfig?: CrossTabConfig;
  cardConfig?: CardConfig;
  variables?: Record<string, string>;
}

export interface TemplateDocumentPage {
  size: 'A4' | 'A3' | 'Letter';
  orientation: 'portrait' | 'landscape';
  margin: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

export interface TemplateDocumentTheme {
  palette: Record<string, string>;
  typography: Record<string, string>;
  spacing: Record<string, number>;
}

export interface TemplateDocumentModes {
  default: 'design' | 'bind' | 'entry' | 'preview' | 'publish' | 'share';
  available: Array<'design' | 'bind' | 'entry' | 'preview' | 'publish' | 'share'>;
}

export interface TemplateDocumentDataSource {
  id: string;
  kind: 'dataset_table' | 'query' | 'manual';
  datasetId?: number;
  tableId?: number;
  name?: string;
  config?: Record<string, any>;
}

export interface TemplateDocumentBlock {
  id: string;
  type: string;
  name?: string;
  children?: TemplateDocumentBlock[];
  [key: string]: any;
}

export interface TemplateDocumentDefinition {
  engine: 'document';
  schemaVersion: number;
  page: TemplateDocumentPage;
  theme: TemplateDocumentTheme;
  modes: TemplateDocumentModes;
  dataSources: TemplateDocumentDataSource[];
  root: TemplateDocumentBlock;
}

export interface TemplateDocumentRuntimeSourcePreview {
  sourceId: string;
  datasetId?: number;
  tableId?: number;
  columns: Array<{
    name: string;
    type?: string;
    nullable?: boolean;
  }>;
  rows: Record<string, any>[];
  total: number;
}

export interface TemplateDocumentRuntimeBlockPreview {
  blockId: string;
  blockType: string;
  kind: 'table' | 'metric' | 'input' | 'repeater';
  sourceId?: string;
  columns?: string[];
  rows?: Record<string, any>[];
  value?: any;
  items?: any[];
  total?: number;
  field?: string | null;
  warnings?: string[];
}

export interface TemplateDocumentRuntimePreviewResponse {
  sources: Record<string, TemplateDocumentRuntimeSourcePreview>;
  blocks: Record<string, TemplateDocumentRuntimeBlockPreview>;
  warnings: string[];
}

export type TemplateBlocks = TemplateDefinition | TemplateDocumentDefinition;

/* ── Filter ────────────────────────────────────────────────── */

export interface TemplateFilter {
  id: string;
  label: string;
  datasetId: number;
  tableId: number;
  column: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'in' | 'not_in' | 'contains' | 'like';
  defaultValue?: string;
}

export interface TemplateActiveFilterValue {
  filterId: string;
  value: any;
}

/* ── API types (match backend schemas) ─────────────────────── */

export interface ReportTemplate {
  id: number;
  name: string;
  description?: string;
  page_size: string;
  orientation: string;
  blocks: TemplateBlocks | Record<string, any>;
  filters?: TemplateFilter[];
  owner_id?: string;
  owner_email?: string;
  user_permission?: string;
  created_at: string;
  updated_at: string;
}

export interface ReportTemplateCreate {
  name: string;
  description?: string;
  page_size?: string;
  orientation?: string;
  blocks?: TemplateBlocks;
  filters?: TemplateFilter[];
}

export interface ReportTemplateUpdate {
  name?: string;
  description?: string;
  page_size?: string;
  orientation?: string;
  blocks?: TemplateBlocks;
  filters?: TemplateFilter[];
}

/* ── Type guards & helpers ─────────────────────────────────── */

export function isTemplateDefinition(data: unknown): data is TemplateDefinition {
  return !!data && typeof data === 'object' && (data as any).version === 3;
}

export function isTemplateDocumentDefinition(data: unknown): data is TemplateDocumentDefinition {
  return !!data
    && typeof data === 'object'
    && (data as any).engine === 'document'
    && typeof (data as any).root === 'object';
}

export function createDefaultDefinition(): TemplateDefinition {
  return {
    version: 3,
    layout: 'table',
    columns: [],
    header: { title: '' },
  };
}

export function createDefaultDocumentDefinition(): TemplateDocumentDefinition {
  return {
    engine: 'document',
    schemaVersion: 1,
    page: {
      size: 'A4',
      orientation: 'portrait',
      margin: { top: 24, right: 24, bottom: 24, left: 24 },
    },
    theme: {
      palette: {
        primary: '#0f172a',
        accent: '#2563eb',
        surface: '#ffffff',
        muted: '#e2e8f0',
        text: '#0f172a',
        subtleText: '#475569',
      },
      typography: {
        headingFont: 'var(--font-sans)',
        bodyFont: 'var(--font-sans)',
      },
      spacing: {
        blockGap: 16,
        sectionGap: 24,
      },
    },
    modes: {
      default: 'design',
      available: ['design', 'bind', 'entry', 'preview', 'publish', 'share'],
    },
    dataSources: [],
    root: {
      id: 'root',
      type: 'page',
      name: 'Document Root',
      children: [
        { id: 'section-header', type: 'section', name: 'Header', children: [] },
        { id: 'section-body', type: 'section', name: 'Body', children: [] },
      ],
    },
  };
}
