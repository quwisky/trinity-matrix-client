/**
 * Room Library's case- and accent-insensitive filtering contract. Substring matching, not
 * fuzzy scoring: filtering narrows a list in place, so predictable membership beats ranked
 * guesses that reorder while the user types.
 */

/** Unicode combining marks, stripped after NFD so `Café` matches a typed `cafe`. */
const COMBINING_MARKS = /\p{Diacritic}/gu;

function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLocaleLowerCase();
}

/** Fold a raw query once. An all-whitespace query normalises to `''`, i.e. no filter. */
export function normalizeRoomFilter(query: string): string {
  return fold(query.trim());
}

/**
 * Whether `name` matches an already-{@link normalizeRoomFilter}d query. An empty query
 * matches everything, so callers can apply this unconditionally.
 */
export function matchesRoomFilter(
  name: string,
  normalizedQuery: string,
): boolean {
  return !normalizedQuery || fold(name).includes(normalizedQuery);
}

/**
 * Project named Room Library rows through the canonical filtering rule. A blank query returns
 * the input by identity, keeping the unfiltered path allocation-free.
 */
export function filterRoomLibraryItems<T extends { readonly name: string }>(
  items: T[],
  query: string,
): T[];
export function filterRoomLibraryItems<T extends { readonly name: string }>(
  items: readonly T[],
  query: string,
): readonly T[];
export function filterRoomLibraryItems<T extends { readonly name: string }>(
  items: readonly T[],
  query: string,
): readonly T[] {
  const normalizedQuery = normalizeRoomFilter(query);
  return normalizedQuery
    ? items.filter((item) => matchesRoomFilter(item.name, normalizedQuery))
    : items;
}
