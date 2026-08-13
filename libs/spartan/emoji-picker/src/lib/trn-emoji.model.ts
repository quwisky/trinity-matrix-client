/**
 * The three fields Trinity reads off an emoji, whatever produced it.
 *
 * The vendor's own types are loose and carry far more than any call site wants — an
 * `EmojiEvent`'s payload, an `EmojiData` record — so this is narrowed from what the call
 * sites actually read rather than mirrored from the library. Declared once because the
 * picker and the index genuinely agree on the shape; the two aliases below name the two
 * directions it travels, and either can grow fields without disturbing the other.
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
 * What the picker emits when someone chooses an emoji.
 *
 * Its `native` is never empty: an entry without one (a custom emoji, or a set the browser
 * cannot render) is not a usable insertion, so the wrapper drops the event rather than
 * forwarding a pick no call site could act on.
 */
export type TrnEmojiPick = TrnEmojiFields;

/** One `:shortcode` completion, as the autocomplete and its suggestion list read it. */
export type TrnEmojiSuggestion = TrnEmojiFields;
