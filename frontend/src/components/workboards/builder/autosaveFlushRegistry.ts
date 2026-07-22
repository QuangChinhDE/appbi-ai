/**
 * Bridge so the Publish control (which lives in the workboard topbar, OUTSIDE
 * the builder tree) can force the builder's debounced autosave to flush the
 * latest DRAFT before the server snapshots it into the Published revision.
 *
 * Only one builder is mounted at a time, so a module-level slot is enough. The
 * builder registers its ``flush`` on mount and clears it on unmount; the publish
 * flow awaits ``flushPendingAutosave()`` first so "atomically copy Draft →
 * Published" always captures exactly what the builder shows — never a draft with
 * an in-flight/debounced edit still on the wire.
 */
let pendingFlush: (() => Promise<void>) | null = null;

export function registerAutosaveFlush(fn: (() => Promise<void>) | null): void {
  pendingFlush = fn;
}

export async function flushPendingAutosave(): Promise<void> {
  if (!pendingFlush) return;
  try {
    await pendingFlush();
  } catch {
    // A failed flush surfaces via the autosave badge; don't block publish on it
    // (the server still snapshots the last successfully-persisted draft).
  }
}
