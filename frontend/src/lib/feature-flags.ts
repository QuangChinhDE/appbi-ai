const truthy = new Set(['1', 'true', 'yes', 'on']);

export const DATASOURCE_SYNC_ENABLED = truthy.has(
  String(process.env.NEXT_PUBLIC_ENABLE_DATASOURCE_SYNC ?? 'false').toLowerCase(),
);

export const LIVE_QUERY_ONLY_MODE = !DATASOURCE_SYNC_ENABLED;
