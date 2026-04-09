import type { DatasetTable } from '@/hooks/use-datasets';

const SQL_ALIAS_RESERVED_WORDS = new Set([
  'as',
  'by',
  'cross',
  'from',
  'full',
  'group',
  'inner',
  'join',
  'left',
  'limit',
  'on',
  'order',
  'outer',
  'right',
  'select',
  'table',
  'where',
  'with',
]);

export function normalizeDatasetTableSqlAlias(value: string | null | undefined, fallback = 'table'): string {
  let text = String(value ?? '').trim();
  if (text.includes('.') && !/\s/.test(text)) {
    const parts = text.split('.');
    text = parts[parts.length - 1] ?? text;
  }
  text = text.replace(/\u0110/g, 'D').replace(/\u0111/g, 'd');

  let alias = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();

  if (!alias) alias = fallback;
  if (/^\d/.test(alias)) alias = `table_${alias}`;
  if (SQL_ALIAS_RESERVED_WORDS.has(alias)) alias = `${alias}_table`;
  return alias;
}

function buildDatasetTableAliasBase(table: Pick<DatasetTable, 'id' | 'display_name' | 'source_table_name'>): string {
  const fallback = table.id ? `table_${table.id}` : 'table';
  return normalizeDatasetTableSqlAlias(table.display_name || table.source_table_name || fallback, fallback);
}

export function buildDatasetTableAliasMap(
  tables: Array<Pick<DatasetTable, 'id' | 'display_name' | 'source_table_name'>>
): Record<number, string> {
  const grouped = new Map<string, number[]>();
  for (const table of tables) {
    const baseAlias = buildDatasetTableAliasBase(table);
    const current = grouped.get(baseAlias) ?? [];
    current.push(table.id);
    grouped.set(baseAlias, current);
  }

  const aliasMap: Record<number, string> = {};
  for (const table of tables) {
    const baseAlias = buildDatasetTableAliasBase(table);
    const groupedIds = grouped.get(baseAlias) ?? [];
    aliasMap[table.id] = groupedIds.length <= 1 ? baseAlias : `${baseAlias}_${table.id}`;
  }
  return aliasMap;
}
