/**
 * The dashboard generation contract, client side.
 *
 * One read on the server (a page batch, an AI turn) is served ONE snapshot
 * generation per dataset. A view is assembled from several reads, though — page
 * switches, lazy tiles, a re-fetch after a filter — and a publish can land
 * between two of them. Then tiles of the SAME dataset hold two generations,
 * and one "data as of" label over them would present two snapshots as one.
 *
 * `snapshotCoherence` says, from the tiles actually loaded, which ones are
 * older than the newest generation seen for their dataset (they are re-read),
 * and the as-of the screen really shows (the OLDEST build among the tiles).
 */
export interface TileFreshness {
  snapshot_generation?: number | null;
  snapshot_dataset_id?: number | null;
  snapshot_as_of?: string | null;
  /** A live read: when the source was read (UTC). */
  result_as_of?: string | null;
  /** This response re-served that read from the result cache. */
  result_cached?: boolean | null;
}

/** A cached live result younger than this is, for the reader, the source now. */
export const CACHED_LIVE_NOTICE_MIN_AGE_MS = 60_000;

/**
 * The live-data freshness contract, client side. A live read served from the
 * result cache is the source AS OF when it was read — up to the cache TTL ago.
 * Such a tile must say so ("as of HH:MM"); it is never presented as the source
 * right now. Returns null when the tile is current (read now, or a snapshot —
 * whose own build time is the label), else the read time (`asOf: null` when
 * the cached entry predates the stamp: cached, time unknown).
 */
export function cachedLiveNotice(
  debug: TileFreshness | null | undefined,
  now: number = Date.now(),
): { asOf: string | null } | null {
  if (!debug || !debug.result_cached || debug.snapshot_as_of) return null;
  if (!debug.result_as_of) return { asOf: null };
  const read = new Date(debug.result_as_of).getTime();
  if (!Number.isNaN(read) && now - read < CACHED_LIVE_NOTICE_MIN_AGE_MS) return null;
  return { asOf: debug.result_as_of };
}

export interface SnapshotCoherence {
  /** Every dataset's loaded tiles share one generation. */
  coherent: boolean;
  /** Tiles older than the newest generation loaded for their dataset. */
  stale: number[];
  /** The oldest data time among the loaded tiles: a snapshot build, or a cached
   *  live read (null: every tile is current). */
  asOf: string | null;
}

export function snapshotCoherence(
  tiles: Record<number, { debug?: TileFreshness | null } | undefined>,
  chartIds?: number[],
): SnapshotCoherence {
  const ids = chartIds ?? Object.keys(tiles).map(Number);
  const newest = new Map<number, number>();
  const seen: Array<{ id: number; ds: number; gen: number }> = [];
  let asOf: string | null = null;
  for (const id of ids) {
    const debug = tiles[id]?.debug;
    if (!debug) continue;
    const gen = debug.snapshot_generation;
    const ds = debug.snapshot_dataset_id;
    // The view is as old as its OLDEST tile: a snapshot's build, or a cached
    // live read (a live tile read just now does not lower it).
    const tileAsOf = debug.snapshot_as_of || cachedLiveNotice(debug)?.asOf || null;
    if (tileAsOf && (asOf === null || Date.parse(tileAsOf) < Date.parse(asOf))) asOf = tileAsOf;
    if (typeof gen !== 'number' || typeof ds !== 'number') continue;
    seen.push({ id, ds, gen });
    newest.set(ds, Math.max(newest.get(ds) ?? gen, gen));
  }
  const stale = seen.filter((t) => t.gen < (newest.get(t.ds) ?? t.gen)).map((t) => t.id);
  return { coherent: stale.length === 0, stale, asOf };
}
