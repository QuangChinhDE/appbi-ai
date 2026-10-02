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
}

export interface SnapshotCoherence {
  /** Every dataset's loaded tiles share one generation. */
  coherent: boolean;
  /** Tiles older than the newest generation loaded for their dataset. */
  stale: number[];
  /** The oldest snapshot build time among the loaded tiles (null: none snapshot-backed). */
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
    if (debug.snapshot_as_of && (asOf === null || debug.snapshot_as_of < asOf)) asOf = debug.snapshot_as_of;
    if (typeof gen !== 'number' || typeof ds !== 'number') continue;
    seen.push({ id, ds, gen });
    newest.set(ds, Math.max(newest.get(ds) ?? gen, gen));
  }
  const stale = seen.filter((t) => t.gen < (newest.get(t.ds) ?? t.gen)).map((t) => t.id);
  return { coherent: stale.length === 0, stale, asOf };
}
