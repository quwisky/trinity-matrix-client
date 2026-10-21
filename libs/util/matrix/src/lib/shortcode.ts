/**
 * The characters of a `:shortcode:`, as a regex character-class body: the one source for the
 * pack editor's rule and the send path's match.
 */
export const SHORTCODE_CHARACTERS = 'A-Za-z0-9_-';

/** A character that, touching a `:shortcode:`, keeps it text: `10:30:45` stays a time. */
export const SHORTCODE_JOINER = /[\p{L}\p{N}_:]/u;
