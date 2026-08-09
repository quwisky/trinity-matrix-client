/**
 * A caret-anchored splice: replace `text[start, end)` with {@link CaretReplacement.insert}.
 *
 * The autocomplete engines compute one; the composer applies it. The caret belongs to the
 * textarea, which the composer owns — so an engine is told where the caret is and answers
 * with where the text should change, never touching the DOM itself.
 */
export interface CaretReplacement {
  readonly start: number;
  readonly end: number;
  readonly insert: string;
}
