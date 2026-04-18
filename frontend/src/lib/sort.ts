function toSortableTimestamp(value: string | null | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

export function sortByDateDesc<T>(
  items: readonly T[],
  getDateValue: (item: T) => string | null | undefined,
): T[] {
  return [...items].sort(
    (left, right) => toSortableTimestamp(getDateValue(right)) - toSortableTimestamp(getDateValue(left)),
  );
}

export function sortByUpdatedAtDesc<T extends { updated_at?: string | null }>(items: readonly T[]): T[] {
  return sortByDateDesc(items, (item) => item.updated_at);
}
