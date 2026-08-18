import { Injectable, inject } from '@angular/core';
import { EmojiSearch } from '@ctrl/ngx-emoji-mart';
import { EmojiService } from '@ctrl/ngx-emoji-mart/ngx-emoji';
import type { TrnEmojiSuggestion } from './trn-emoji.model';

/** How many completions a `:shortcode` query returns. */
const SUGGESTION_LIMIT = 8;

/**
 * The emoji index, behind Trinity's own API.
 *
 * The picker element hides only four of the seven files that named the vendor; the other
 * three are the `:shortcode` autocomplete, which never touches the picker at all. Without
 * this facade the vendor ban could not land — which is why it exists alongside the
 * component rather than after it.
 *
 * It is also the only place a lazy index could later be introduced. AUDIT.md M11 measured
 * that: the emoji weight is anchored by these two eager injections, not by the picker
 * template, so deferring the element moved nothing. Making that change possible is the
 * point; this does not deliver it.
 */
@Injectable({ providedIn: 'root' })
export class TrnEmojiIndex {
  private readonly search = inject(EmojiSearch);
  private readonly emoji = inject(EmojiService);

  /** Completions for a `:shortcode` fragment, most relevant first. */
  suggest(
    query: string,
    limit = SUGGESTION_LIMIT,
  ): readonly TrnEmojiSuggestion[] {
    const found = this.search.search(query, undefined, limit) ?? [];
    return found.map((entry) => ({
      id: String(entry.id ?? ''),
      native: String(entry.native ?? ''),
      colons: String(entry.colons ?? ''),
    }));
  }

  /**
   * The character for a shortcode, or null when it names nothing.
   *
   * Null rather than the input echoed back: the caller converts `:shrug:` in place, and a
   * silent passthrough would leave an unresolved shortcode looking like a resolved one.
   */
  nativeFor(shortcode: string): string | null {
    const data = this.emoji.getData(shortcode);
    if (!data) return null;
    return this.emoji.getSanitizedData(data).native ?? null;
  }
}
