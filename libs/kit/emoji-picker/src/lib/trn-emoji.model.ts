/**
 * What Trinity needs from a picked emoji.
 *
 * The vendor's own `EmojiEvent` is loosely typed and carries far more than either call
 * site reads — both only ever wanted `native`. Narrowing here means a swap of
 * `@ctrl/ngx-emoji-mart` is a change to this library rather than to the composer and the
 * reaction picker, and it makes the one real failure mode explicit: an entry with no
 * `native` (custom emoji, or a set the browser cannot render) is not a usable insertion.
 */
export interface TrnEmojiPick {
  /** The character to insert or react with. Never empty — the wrapper drops the event. */
  readonly native: string;
  /** Stable vendor id, e.g. `+1`. Useful as a track-by key. */
  readonly id: string;
  /** Shortcode form, e.g. `:+1:`. */
  readonly colons: string;
}

/**
 * One `:shortcode` completion.
 *
 * Exactly the three fields the autocomplete and its suggestion list read — verified
 * against both call sites rather than mirrored from the vendor's `EmojiData`, which is
 * large and mostly irrelevant here.
 */
export interface TrnEmojiSuggestion {
  readonly id: string;
  readonly native: string;
  readonly colons: string;
}
