/**
 * The matching rule behind the sidebar's filter box.
 *
 * Deliberately a plain case- and accent-insensitive substring test, not the fuzzy scoring
 * the Ctrl/Cmd+K switcher uses and not `SearchService`: this filter narrows a list you keep
 * looking at while you work through it, so a stable, predictable "does the name contain
 * what I typed" beats a ranked guess that reorders under you as you type.
 *
 * Folding is split from matching so a caller folds the query once for the whole list rather
 * than once per room.
 */

/**
 * Unicode combining marks, stripped after NFD so `Café` matches a typed `cafe`. Matrix room
 * names are frequently non-English and nobody types the accents when filtering.
 */
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
export function matchesRoomFilter(name: string, query: string): boolean {
  if (!query) {
    return true;
  }
  return fold(name).includes(query);
}
