/**
 * The reader's thumb on a public AI answer — the V1 feedback contract.
 *
 * A rating is one current verdict, `up` or `down`, and it is never cleared:
 *
 *   none + up   -> up        up + up     -> up   (stays; not a toggle)
 *   none + down -> down      down + down -> down
 *   up + down   -> down      down + up   -> up
 *
 * Why no clear. The public session-save endpoint maps a rated message onto
 * `agent_flow_runs.rating` — the column the Runs tab and the pilot funnel read —
 * and it only ever WRITES a verdict. A thumb that toggled itself off made the
 * reader's page say "no rating" while the operator's run still said "up". One
 * truth: the page shows what the run holds.
 *
 * Pure, so `scripts/check-reader-rating.mjs` can prove every transition without
 * a browser or a model.
 */
export type ReaderRating = 'up' | 'down';

export function nextReaderRating(_current: ReaderRating | undefined, clicked: ReaderRating): ReaderRating {
  return clicked;
}

/** The messages after the reader clicks `clicked` on message `index`. */
export function applyReaderRating<M extends { rating?: ReaderRating }>(
  messages: M[], index: number, clicked: ReaderRating,
): M[] {
  return messages.map((m, i) => (i === index ? { ...m, rating: nextReaderRating(m.rating, clicked) } : m));
}

/**
 * Undo a rating whose save failed — but only if the message still shows the
 * verdict that failed. A later click the reader made meanwhile is theirs to keep.
 */
export function revertReaderRating<M extends { rating?: ReaderRating }>(
  messages: M[], index: number, attempted: ReaderRating, previous: ReaderRating | undefined,
): M[] {
  return messages.map((m, i) => (i === index && m.rating === attempted ? { ...m, rating: previous } : m));
}

/**
 * How ONE message is written into the saved session snapshot — for every save,
 * not just the one a thumb triggers. Each turn re-saves the whole session, and
 * a serializer that dropped `rating` wiped the reader's thumb on the next
 * reload while the run kept its verdict. `failed` travels too, so an error
 * bubble stays unratable after a reload.
 */
export function toSnapshotMessage<R extends string>(m: {
  role: R; content: string; rating?: ReaderRating; failed?: true;
}): { role: R; content: string; rating?: ReaderRating; failed?: true } {
  return {
    role: m.role,
    content: m.content,
    ...(m.rating ? { rating: m.rating } : {}),
    ...(m.failed ? { failed: true as const } : {}),
  };
}
