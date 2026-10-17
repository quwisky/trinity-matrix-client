/**
 * The three fields Trinity reads off an emoji, whatever produced it. Narrowed from what call
 * sites read, not mirrored from the loose vendor types; the two aliases below name the two
 * directions it travels.
 */
interface TrnEmojiFields {
  /** Stable vendor id, e.g. `+1`. Useful as a track-by key. */
  readonly id: string;
  /** The character to insert or react with. */
  readonly native: string;
  /** Shortcode form, e.g. `:+1:`. */
  readonly colons: string;
}

/**
 * What the picker emits when someone chooses an emoji. Its `native` is never empty: an entry
 * without one (a custom emoji, or a set the browser cannot render) is dropped, not forwarded.
 */
export type TrnEmojiPick = TrnEmojiFields;

/** One `:shortcode` completion, as the autocomplete and its suggestion list read it. */
export type TrnEmojiSuggestion = TrnEmojiFields;
