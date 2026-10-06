'use client';

/**
 * The live-data freshness contract on a tile: a live result re-served from the
 * result cache is the source AS OF when it was read (up to the cache TTL ago),
 * so the tile says "As of HH:MM" instead of presenting it as the source now.
 * Renders nothing for a current read or a snapshot (the page's own "data as
 * of" label covers snapshots).
 */
import { Clock } from 'lucide-react';

import { cachedLiveNotice, type TileFreshness } from '@/lib/snapshot-coherence';
import { useI18n } from '@/providers/LanguageProvider';

export function CachedLiveBadge({ debug }: { debug?: TileFreshness | null }) {
  const { t } = useI18n();
  const notice = cachedLiveNotice(debug);
  if (!notice) return null;
  const time = notice.asOf
    ? new Date(notice.asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  return (
    <span
      data-testid="tile-cached-as-of"
      data-as-of={notice.asOf ?? ''}
      // Shrinks before the tile's title does: on a narrow tile the text
      // truncates down to the clock (the time stays in the tooltip), and the
      // header keeps one line — its height, and so an AUTO device layout
      // fitted to it, does not change with the age of the cache.
      className="inline-flex min-w-0 shrink items-center gap-1 overflow-hidden px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary bg-surface-2 border border-[rgb(var(--border-line))] rounded"
      title={time ? t('dashboards.tile.cachedAsOfHint', { time }) : t('dashboards.tile.cachedAsOfHintUnknown')}
    >
      <Clock className="h-3 w-3 shrink-0" />
      <span className="truncate">{time ? t('dashboards.tile.cachedAsOf', { time }) : t('dashboards.tile.cachedAsOfUnknown')}</span>
    </span>
  );
}
