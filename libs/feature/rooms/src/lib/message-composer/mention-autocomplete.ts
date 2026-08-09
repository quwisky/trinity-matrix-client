import { computed, signal, type Signal } from '@angular/core';
import { type Mention } from '@trinity/util/matrix';
import { type CaretReplacement } from './caret-replacement';

/** A room member offered by the @-mention autocomplete. */
export interface MentionMember {
  userId: string;
  name: string;
}

/**
 * An `@mention` being typed at the caret: `@` at a word boundary (so an email's
 * `a@b` doesn't trigger) followed by the query so far (may be empty right after `@`).
 */
const MENTION_TRIGGER = /(?:^|\s)@([^\s@]*)$/;
/** How many member suggestions the mention menu offers at once. */
const MENTION_SUGGESTION_LIMIT = 8;

/**
 * The composer's `@mention` autocomplete.
 *
 * Owns the trigger regex, the filtered member list, the highlighted index, the caret
 * splice an acceptance resolves to, and the set of members actually chosen so far (which
 * is what `m.mentions` is built from on submit) — everything except the textarea. A plain
 * class rather than an `@Injectable` for the same reasons as {@link EmojiAutocomplete},
 * plus one of its own: it reads the member list straight off the composer's `members`
 * input signal, so a membership change is visible in the same tick a keystroke sees it —
 * which copying the list into injectable state would not preserve.
 */
export class MentionAutocomplete {
  /** The `@mention` query under the caret, or null when the menu is closed. */
  readonly query = signal<string | null>(null);

  /** Members matching the current query (prefix matches first), capped for the menu. */
  readonly matches = computed<MentionMember[]>(() => {
    const q = this.query();
    if (q === null) {
      return [];
    }
    const query = q.toLowerCase();
    return this.members()
      .filter(
        (m) =>
          m.name.toLowerCase().includes(query) ||
          m.userId.toLowerCase().includes(query),
      )
      .sort(
        (a, b) =>
          Number(b.name.toLowerCase().startsWith(query)) -
          Number(a.name.toLowerCase().startsWith(query)),
      )
      .slice(0, MENTION_SUGGESTION_LIMIT);
  });

  /** The mention menu shows only when a query yields at least one member. */
  readonly open = computed(() => this.matches().length > 0);

  /** Index of the highlighted member suggestion. */
  readonly activeIndex = signal(0);

  /** Users chosen via the mention menu, for `m.mentions` + pills on submit. */
  private readonly chosen = signal<Mention[]>([]);

  constructor(private readonly members: Signal<readonly MentionMember[]>) {}

  /** Recompute the menu from the `@query` under the caret. */
  sync(text: string, caret: number): void {
    const trigger = MENTION_TRIGGER.exec(text.slice(0, caret));
    this.query.set(trigger ? trigger[1] : null);
  }

  /**
   * Accept the member at `index`: record the mention and answer with the splice that swaps
   * the `@query` under the caret for `@Name `. Null when there is no such member.
   */
  accept(text: string, caret: number, index: number): CaretReplacement | null {
    const member = this.matches()[index];
    if (!member) {
      return null;
    }
    const trigger = MENTION_TRIGGER.exec(text.slice(0, caret));
    const display = `@${member.name}`;
    const start = trigger ? caret - trigger[1].length - 1 : caret; // drop "@query"
    this.chosen.update((list) => [...list, { userId: member.userId, display }]);
    return { start, end: caret, insert: `${display} ` };
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

  /** Chosen mentions still present in the text (deleted ones dropped), deduped. */
  active(text: string): Mention[] {
    const seen = new Set<string>();
    const out: Mention[] = [];
    for (const mention of this.chosen()) {
      if (text.includes(mention.display) && !seen.has(mention.userId)) {
        seen.add(mention.userId);
        out.push(mention);
      }
    }
    return out;
  }

  /** Forget the tracked mentions — they belonged to the message or room just left. */
  clearChosen(): void {
    this.chosen.set([]);
  }
}
