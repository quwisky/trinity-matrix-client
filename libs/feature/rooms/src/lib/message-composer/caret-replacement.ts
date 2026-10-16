/**
 * A caret-anchored splice: replace `text[start, end)` with {@link CaretReplacement.insert}.
 *
 * The composer owns the textarea and its caret, so an autocomplete engine only answers with
 * where the text should change and never touches the DOM.
 */
export interface CaretReplacement {
  readonly start: number;
  readonly end: number;
  readonly insert: string;
}
