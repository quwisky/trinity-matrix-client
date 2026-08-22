import { computed, signal } from '@angular/core';
import { SLASH_COMMANDS, type SlashCommand } from '@trinity/util/matrix';
import { type CaretReplacement } from './caret-replacement';

/**
 * A `/command` being typed at the START of the message, and only there.
 *
 * Anchored to `^` rather than to a word boundary, unlike the emoji and mention triggers,
 * because that is where the parser looks: `parseSlashCommand` only ever matches a leading
 * command, so offering one mid-sentence would complete something that then sends as literal
 * text. The name may be empty — a bare `/` opens the menu on everything, which is how anyone
 * finds out these exist at all.
 */
const SLASH_TRIGGER = /^\/([a-z]*)$/i;

/**
 * The composer's `/command` autocomplete.
 *
 * Owns the trigger, the filtered list, the highlighted index and the caret splice an
 * acceptance resolves to — everything except the textarea. A plain class rather than an
 * `@Injectable`, for the reasons {@link EmojiAutocomplete} records: one per composer, no
 * injectable dependency, and constructible in a bare unit test.
 *
 * The command list comes from `@trinity/util/matrix` rather than being restated here. It is
 * the same list the send path parses against, so a command renamed there stops being offered
 * here rather than being offered under a name that no longer works.
 */
export class SlashAutocomplete {
  /** The command fragment after the leading slash, or null when the menu is closed. */
  readonly query = signal<string | null>(null);

  /** Commands whose name starts with the fragment; all of them for a bare `/`. */
  readonly matches = computed<readonly SlashCommand[]>(() => {
    const q = this.query();
    if (q === null) {
      return [];
    }
    return SLASH_COMMANDS.filter((command) => command.name.startsWith(q));
  });

  /** The menu is shown only when a query yields at least one command. */
  readonly open = computed(() => this.matches().length > 0);

  /** Index of the highlighted command. */
  readonly activeIndex = signal(0);

  /**
   * Recompute the menu from the text before the caret.
   *
   * Nothing is ever spliced here, which is the difference from the emoji engine: there is no
   * "fully typed" form to convert inline — a complete `/me` is not finished until it has a
   * message after it, and that is the parser's business at send time.
   */
  sync(text: string, caret: number): void {
    const trigger = SLASH_TRIGGER.exec(text.slice(0, caret));
    this.query.set(trigger ? trigger[1].toLowerCase() : null);
  }

  /**
   * Resolve the command at `index` into a splice over the `/fragment`.
   *
   * The trailing space is part of the acceptance rather than a nicety: every one of these
   * takes an argument, and `parseSlashCommand` needs the separator before it will read one.
   * Accepting `/me` and leaving the caret against the `e` invites a message that sends as the
   * literal text `/mehello`.
   */
  accept(text: string, caret: number, index: number): CaretReplacement | null {
    const command = this.matches()[index];
    if (!command) {
      return null;
    }
    const trigger = SLASH_TRIGGER.exec(text.slice(0, caret));
    if (!trigger) {
      return null; // the caret drifted off the fragment; nothing to replace
    }
    return {
      start: caret - trigger[1].length - 1, // "/" + fragment
      end: caret,
      insert: `/${command.name} `,
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

  /** Close the menu without accepting anything. */
  close(): void {
    this.query.set(null);
  }
}
