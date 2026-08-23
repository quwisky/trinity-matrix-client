import { computed, type Signal } from '@angular/core';
import { type TrnEmojiIndex } from '@trinity/components/emoji-picker';
import { type Mention } from '@trinity/util/matrix';
import { EmojiAutocomplete } from './emoji-autocomplete';
import {
  MentionAutocomplete,
  type MentionMember,
} from './mention-autocomplete';
import { SlashAutocomplete } from './slash-autocomplete';

/** What the three menus need from the field they are anchored to. */
export interface ComposerAutocompletePorts {
  /** The composer's current text. */
  readonly text: Signal<string>;
  /** Caret offset in the textarea. */
  readonly caret: () => number;
  /** Apply a caret-anchored splice. */
  readonly replaceRange: (start: number, end: number, insert: string) => void;
  /** Scroll the option with this id into view. */
  readonly scrollIntoView: (id: string) => void;
  /** Insert a bare character at the cursor (the emoji fallback path). */
  readonly insertAtCursor: (text: string) => void;
  /**
   * Whether a leading slash is READ as a command on the way out.
   *
   * A port rather than something the menus work out, because it is a fact about the composer's
   * MODE: only `TimelineActionsService.send` and `ThreadsService.sendThreadMessage` run
   * `slashCommandContent`, while a reply, an edit and an attachment caption route through
   * `replyMessageContent` / `editMessageContent` / `mediaCaptionFields`, none of which look at
   * a leading slash. Offering a command in those states completes something that then sends as
   * its own nine literal characters.
   */
  readonly commandsParsed: Signal<boolean>;
}

/**
 * The composer's three autocomplete menus, as one thing.
 *
 * Each engine owns its trigger detection, suggestion list, highlighted index and the caret
 * splice an acceptance resolves to. What lived in the component was the layer above them: the
 * caret handover, the accept/move plumbing repeated three times, and the ORDER — which menu
 * gets Enter, which rung of the Escape ladder closes what. That order is the only thing
 * making the three safe together, so it belongs in one place rather than spread across six
 * key handlers.
 *
 * The ladder is mention → emoji → slash throughout. A slash only triggers at the start of the
 * message, where neither of the others can be open, so in practice they never compete — but
 * stating an order beats relying on that.
 */
export class ComposerAutocompletes {
  private readonly emoji: EmojiAutocomplete;
  private readonly mention: MentionAutocomplete;
  private readonly slash = new SlashAutocomplete();

  /** The `:shortcode` fragment under the caret, or null when the menu is closed. */
  readonly emojiQuery: EmojiAutocomplete['query'];
  /** Ranked emoji suggestions for the current query (from emoji-mart's index). */
  readonly emojiMatches: EmojiAutocomplete['matches'];
  /** The menu is shown only when a query yields at least one match. */
  readonly emojiOpen: Signal<boolean>;
  /** Index of the highlighted suggestion. */
  readonly emojiActiveIndex: EmojiAutocomplete['activeIndex'];
  /** The `@mention` query under the caret, or null when the menu is closed. */
  readonly mentionQuery: MentionAutocomplete['query'];
  /** Members matching the current query (prefix matches first), capped for the menu. */
  readonly mentionMatches: MentionAutocomplete['matches'];
  /** The mention menu shows only when a query yields at least one member. */
  readonly mentionOpen: Signal<boolean>;
  /** Index of the highlighted member suggestion. */
  readonly mentionActiveIndex: MentionAutocomplete['activeIndex'];
  /** Commands matching the `/fragment` at the start of the message. */
  readonly slashMatches: SlashAutocomplete['matches'];
  /** Whether the slash menu is showing. */
  readonly slashOpen: Signal<boolean>;
  /** Index of the highlighted command. */
  readonly slashActiveIndex: SlashAutocomplete['activeIndex'];

  constructor(
    emojiIndex: TrnEmojiIndex,
    members: Signal<readonly MentionMember[]>,
    private readonly ports: ComposerAutocompletePorts,
  ) {
    this.emoji = new EmojiAutocomplete(emojiIndex);
    this.mention = new MentionAutocomplete(members);
    this.emojiQuery = this.emoji.query;
    this.emojiMatches = this.emoji.matches;
    this.emojiOpen = this.emoji.open;
    this.emojiActiveIndex = this.emoji.activeIndex;
    this.mentionQuery = this.mention.query;
    this.mentionMatches = this.mention.matches;
    this.mentionOpen = this.mention.open;
    this.mentionActiveIndex = this.mention.activeIndex;
    this.slashMatches = this.slash.matches;
    // Gated, not just "has matches": see `commandsParsed`. The engine still tracks its query
    // underneath — this decides only whether the menu is shown and whether the key ladders
    // above will hand it Enter, Tab and the arrows.
    this.slashOpen = computed(
      () => this.ports.commandsParsed() && this.slash.open(),
    );
    this.slashActiveIndex = this.slash.activeIndex;
  }

  /**
   * Recompute all three menus from the text under the caret.
   *
   * The emoji engine is the only one that can splice here: a fully typed `:shortcode:` is
   * converted inline, which the others have no equivalent of.
   */
  sync(): void {
    const replacement = this.emoji.sync(this.ports.text(), this.ports.caret());
    if (replacement) {
      this.ports.replaceRange(
        replacement.start,
        replacement.end,
        replacement.insert,
      );
    }
    this.mention.sync(this.ports.text(), this.ports.caret());
    this.slash.sync(this.ports.text(), this.ports.caret());
  }

  /**
   * Accept whatever is highlighted in the topmost open menu.
   *
   * Returns whether a menu took the key, so the caller knows not to let Enter send or Tab
   * move focus.
   */
  acceptHighlighted(): boolean {
    if (this.mentionOpen()) {
      this.acceptMention();
      return true;
    }
    if (this.emojiOpen()) {
      this.acceptEmoji();
      return true;
    }
    if (this.slashOpen()) {
      this.acceptSlash();
      return true;
    }
    return false;
  }

  /** Move the highlight in the topmost open menu. Returns whether a menu took the key. */
  moveHighlight(delta: number): boolean {
    if (this.mentionOpen()) {
      this.move(this.mention.move(delta), 'mention');
      return true;
    }
    if (this.emojiOpen()) {
      this.move(this.emoji.move(delta), 'emoji');
      return true;
    }
    if (this.slashOpen()) {
      this.move(this.slash.move(delta), 'slash');
      return true;
    }
    return false;
  }

  /** Close the topmost open menu. Returns whether there was one — the Escape ladder's rung. */
  closeTopmost(): boolean {
    if (this.mentionOpen()) {
      this.mentionQuery.set(null);
      return true;
    }
    if (this.emojiOpen()) {
      this.emojiQuery.set(null);
      return true;
    }
    if (this.slashOpen()) {
      this.slash.close();
      return true;
    }
    return false;
  }

  /** Close every menu, leaving the chosen mentions alone (a blur is not a send). */
  closeAll(): void {
    this.emojiQuery.set(null);
    this.mentionQuery.set(null);
    this.slash.close();
  }

  /** Close every menu AND forget the tracked mentions — they belong to the message just sent. */
  reset(): void {
    this.closeAll();
    this.mention.clearChosen();
  }

  /** Forget the tracked mentions without touching the menus (a room change). */
  clearChosen(): void {
    this.mention.clearChosen();
  }

  /** Accept a suggestion: swap the `:fragment` under the caret for the emoji. */
  acceptEmoji(index = this.emojiActiveIndex()): void {
    const acceptance = this.emoji.accept(
      this.ports.text(),
      this.ports.caret(),
      index,
    );
    if (!acceptance) {
      return;
    }
    if (acceptance.kind === 'replace') {
      const { start, end, insert } = acceptance.replacement;
      this.ports.replaceRange(start, end, insert);
    } else {
      // Caret drifted off the fragment — fall back to a plain cursor insert.
      this.ports.insertAtCursor(acceptance.native);
    }
    this.emojiQuery.set(null);
  }

  /** Accept a member: swap the `@query` for `@Name ` and record the mention. */
  acceptMention(index = this.mentionActiveIndex()): void {
    const replacement = this.mention.accept(
      this.ports.text(),
      this.ports.caret(),
      index,
    );
    if (!replacement) {
      return;
    }
    this.ports.replaceRange(
      replacement.start,
      replacement.end,
      replacement.insert,
    );
    this.mentionQuery.set(null);
  }

  /** Accept a command: swap the `/fragment` for `/name ` and close the menu. */
  acceptSlash(index = this.slashActiveIndex()): void {
    const replacement = this.slash.accept(
      this.ports.text(),
      this.ports.caret(),
      index,
    );
    if (!replacement) {
      return;
    }
    this.ports.replaceRange(
      replacement.start,
      replacement.end,
      replacement.insert,
    );
    this.slash.close();
  }

  /** Chosen mentions still present in the text (deleted ones dropped), deduped. */
  activeMentions(): Mention[] {
    return this.mention.active(this.ports.text());
  }

  private move(next: number | null, kind: string): void {
    if (next !== null) {
      this.ports.scrollIntoView(`${kind}-suggestion-${next}`);
    }
  }
}
