import { computed, signal } from '@angular/core';
import type { EmojiSearch } from '@ctrl/ngx-emoji-mart';
import type { EmojiData, EmojiService } from '@ctrl/ngx-emoji-mart/ngx-emoji';
import { type CaretReplacement } from './caret-replacement';

/**
 * A `:shortcode` being typed at the caret: a `:` at a word boundary, then at
 * least two shortcode characters, with no closing colon yet. The leading
 * boundary keeps URLs and times (`http://`, `8:30`) from opening the menu.
 */
const EMOJI_TRIGGER = /(?:^|\s):([a-z0-9_+-]{2,})$/i;
/** A fully typed `:shortcode:` (closing colon present) for inline replacement. */
const EMOJI_COMPLETE = /(?:^|\s):([a-z0-9_+-]+):$/i;
/** How many suggestions the menu offers at once. */
const EMOJI_SUGGESTION_LIMIT = 8;

/**
 * What accepting an emoji suggestion resolves to: normally a splice over the `:fragment`
 * under the caret, but a caret that has drifted off the fragment leaves nothing to
 * replace, so the emoji goes in at the cursor instead.
 */
export type EmojiAcceptance =
  | { readonly kind: 'replace'; readonly replacement: CaretReplacement }
  | { readonly kind: 'insert'; readonly native: string };

/**
 * The composer's `:shortcode` emoji autocomplete.
 *
 * Owns the trigger regexes, the ranked suggestion list, the highlighted index and the
 * caret splice an acceptance resolves to — everything except the textarea. A plain class
 * rather than an `@Injectable`: every composer instance (room and thread) needs its own,
 * it holds no injectable dependency of its own beyond the two emoji-mart collaborators
 * handed to it, and staying DI-free keeps it constructible in a bare unit test.
 */
export class EmojiAutocomplete {
  /** The `:shortcode` fragment under the caret, or null when the menu is closed. */
  readonly query = signal<string | null>(null);

  /** Ranked emoji suggestions for the current query (from emoji-mart's index). */
  readonly matches = computed<EmojiData[]>(() => {
    const q = this.query();
    if (q === null) {
      return [];
    }
    return this.search.search(q, undefined, EMOJI_SUGGESTION_LIMIT) ?? [];
  });

  /** The menu is shown only when a query yields at least one match. */
  readonly open = computed(() => this.matches().length > 0);

  /** Index of the highlighted suggestion. */
  readonly activeIndex = signal(0);

  constructor(
    private readonly search: EmojiSearch,
    private readonly emoji: EmojiService,
  ) {}

  /**
   * Recompute the menu from the text before the caret. A fully typed `:shortcode:` is
   * converted to its emoji inline — returned as a splice for the caller to apply, with the
   * menu closed; otherwise an in-progress `:fragment` opens (or, with no match, closes)
   * the suggestion menu and nothing is spliced.
   */
  sync(text: string, caret: number): CaretReplacement | null {
    const before = text.slice(0, caret);

    const complete = EMOJI_COMPLETE.exec(before);
    if (complete) {
      const char = this.nativeForShortcode(complete[1].toLowerCase());
      if (char) {
        this.query.set(null);
        const start = caret - complete[1].length - 2; // ":" + code + ":"
        return { start, end: caret, insert: char };
      }
    }

    const trigger = EMOJI_TRIGGER.exec(before);
    this.query.set(trigger ? trigger[1].toLowerCase() : null);
    return null;
  }

  /**
   * Resolve the suggestion at `index` against the `:fragment` under the caret. Null when
   * there is no such suggestion (or it carries no native character) — nothing to accept.
   */
  accept(text: string, caret: number, index: number): EmojiAcceptance | null {
    const native = this.matches()[index]?.native;
    if (!native) {
      return null;
    }
    const trigger = EMOJI_TRIGGER.exec(text.slice(0, caret));
    if (!trigger) {
      return { kind: 'insert', native };
    }
    const start = caret - trigger[1].length - 1; // ":" + fragment
    return {
      kind: 'replace',
      replacement: { start, end: caret, insert: native },
    };
  }

  /** Move the highlight by `delta`, wrapping. Returns the new index, or null when empty. */
  move(delta: number): number | null {
    const n = this.matches().length;
    if (n === 0) {
      return null;
    }
    const next = (this.activeIndex() + delta + n) % n;
    this.activeIndex.set(next);
    return next;
  }

  /** Native emoji for an exact shortcode, or undefined if it isn't a real one. */
  private nativeForShortcode(code: string): string | undefined {
    const data = this.emoji.getData(code);
    return data
      ? (this.emoji.getSanitizedData(data).native ?? undefined)
      : undefined;
  }
}
