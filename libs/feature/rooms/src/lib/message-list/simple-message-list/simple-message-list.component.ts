import {
  ChangeDetectionStrategy,
  Component,
  effect,
  signal,
} from '@angular/core';
import { MessageComposerComponent } from '../../message-composer/message-composer.component';
import { MessageRowComponent } from '../../message-row/message-row.component';
import { MessageListBase } from '../message-list-base';
import { TrnFileDropDirective } from '../../shared/file-drop.directive';
import { DropOverlayComponent } from '../drop-overlay/drop-overlay.component';
import { TimelineDividerComponent } from '../timeline-divider/timeline-divider.component';
import { scrollBehavior } from '@trinity/util/ui';

/** Trigger older-history loading when the scroll top gets within this many px. */
const AUTO_LOAD_THRESHOLD_PX = 150;

/**
 * Treat the viewport as "at the bottom" within this many px of the end, so an
 * incoming live message still auto-scrolls when the user is effectively pinned to
 * the newest message (accounts for sub-pixel rounding and a partially-visible row).
 */
const NEAR_BOTTOM_PX = 120;

/**
 * Safety cap on consecutive auto-backfill rounds for one fill sequence, so the
 * effect can never spin even if the "did older history arrive?" check is fooled.
 * Each round pulls ~SCROLLBACK events, so this is far more than any viewport needs.
 */
const MAX_BACKFILL_ROUNDS = 20;

/**
 * Discord-style message list for the active room — the plain, non-virtualized
 * timeline (renders every loaded row). The windowed variant
 * ({@link VirtualMessageListComponent}) is selected instead when the experimental
 * virtualized-timeline flag is on. Shared logic lives in {@link MessageListBase}.
 */
@Component({
  selector: 'trn-simple-message-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MessageComposerComponent,
    MessageRowComponent,
    DropOverlayComponent,
    TimelineDividerComponent,
  ],
  // The whole conversation is the drop target — "drop it on the room" is the gesture, and
  // these templates are host fragments with no element of their own to carry it.
  hostDirectives: [
    {
      directive: TrnFileDropDirective,
      // Neither is exposed on this element, and both are stated so that is a decision rather
      // than an omission (see `scripts/host-directives.spec.mjs`). `filesDropped` in
      // particular is deliberately NOT re-exported: `MessageListBase` subscribes to it
      // directly, so a host binding would be a second, silently divergent way in.
      inputs: [],
      outputs: [],
    },
  ],
  templateUrl: './simple-message-list.component.html',
  styleUrl: './simple-message-list.component.scss',
})
export class SimpleMessageListComponent extends MessageListBase {
  private lastId = '';
  /** Whether the user is scrolled to (or near) the bottom — gates auto-scroll on
   * incoming messages. Starts true so the first load and each new room stick. */
  private atBottom = true;
  /** Reactive mirror of `!atBottom` for the template's jump-to-latest pill. */
  protected readonly notAtBottom = signal(false);

  // Scroll-anchoring state while older history is being prepended.
  private pendingPrepend = false;
  private prevScrollHeight = 0;
  private prevScrollTop = 0;

  // Backfill state: keep loading older history until the viewport is full so the
  // user has room to scroll (otherwise a short timeline can never paginate).
  // Progress is tracked by the *oldest* message id — a backfill that prepends
  // nothing leaves it unchanged — rather than the message count, which a
  // same-length redaction/dedup could fool into stopping early or spinning.
  private backfilling = false;
  // Null (not '') so an EMPTY projection still counts as "history not yet requested" — a
  // room whose whole loaded window is hidden system lines would otherwise compare '' to ''
  // and never backfill, leaving a permanently blank timeline with no scrollbar to recover
  // from.
  private lastBackfillOldestId: string | null = null;
  private backfillRounds = 0;

  constructor() {
    super();

    effect(() => {
      const msgs = this.messages();
      const el = this.scrollEl()?.nativeElement;
      if (!el) {
        return;
      }

      if (this.pendingPrepend) {
        // User scrolled up to paginate — keep the viewport anchored on what they
        // were reading instead of jumping to the top.
        this.pendingPrepend = false;
        this.lastId = msgs[msgs.length - 1]?.id ?? this.lastId;
        const prevHeight = this.prevScrollHeight;
        const prevTop = this.prevScrollTop;
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight - prevHeight + prevTop;
        });
        return;
      }

      const hadPrevious = !!this.lastId;
      const latest = msgs[msgs.length - 1];
      const newest = latest?.id ?? '';
      const newestChanged = !!newest && newest !== this.lastId;
      this.lastId = newest || this.lastId;
      if (newestChanged) {
        // New room or live message — grant a fresh backfill budget.
        this.backfillRounds = 0;
        // Announce a genuinely-new incoming message (not our own, not the first
        // load) so screen-reader users hear it without watching the timeline.
        if (
          hadPrevious &&
          latest &&
          !latest.isOwn &&
          !latest.decryptionFailed &&
          latest.kind !== 'redacted' &&
          latest.kind !== 'event'
        ) {
          this.announcement.set(`${latest.senderName}: ${latest.body}`);
        }
      }
      // Auto-scroll to the newest message on open, when the user sends their own
      // message, or when a live message arrives while they're already at the
      // bottom — but NOT when an incoming message lands while they've scrolled up
      // to read history. Also stick while backfilling older history.
      const stickToBottom =
        (newestChanged && (this.atBottom || !!latest?.isOwn)) ||
        this.backfilling;

      requestAnimationFrame(() => {
        if (stickToBottom) {
          el.scrollTop = el.scrollHeight;
        }

        // If the timeline doesn't fill the viewport, pull in older history so
        // there's something to scroll. Stop once it's scrollable, history runs
        // out, the last load prepended nothing (oldest id unchanged), or the
        // round cap is hit.
        const notFull = el.scrollHeight <= el.clientHeight + 1;
        const oldestId = this.oldestEventId();
        const prependedOlder = oldestId !== this.lastBackfillOldestId;
        if (
          notFull &&
          this.canLoadOlder() &&
          !this.loadingOlder() &&
          !this.pendingPrepend &&
          prependedOlder &&
          this.backfillRounds < MAX_BACKFILL_ROUNDS
        ) {
          this.backfilling = true;
          this.lastBackfillOldestId = oldestId;
          this.backfillRounds++;
          this.loadOlder.emit();
        } else {
          this.backfilling = false;
        }
      });
    });

    // Scroll to an externally-requested event (search / reply / pinned-panel jump).
    // Runs after the anchoring effect above so the row is in the DOM; reuses jumpTo,
    // so it's a no-op when the event isn't loaded. Reads jumpToNonce so re-requesting
    // the same id re-fires (an unchanged jumpToId alone wouldn't).
    effect(() => {
      this.jumpToNonce();
      const id = this.jumpToId();
      if (id) {
        this.jumpTo(id);
      }
    });
  }

  protected override resetOnRoomChange(): void {
    super.resetOnRoomChange();
    this.lastId = '';
    this.lastBackfillOldestId = null;
    this.backfillRounds = 0;
    this.pendingPrepend = false;
    this.atBottom = true;
    this.notAtBottom.set(false);
  }

  /** Auto-load older history once the user scrolls near the top. */
  onScroll(): void {
    const el = this.scrollEl()?.nativeElement;
    if (!el) {
      return;
    }
    // Track whether the user is pinned to (or near) the bottom so the anchoring
    // effect only auto-scrolls incoming messages when they're already there.
    this.atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    this.notAtBottom.set(!this.atBottom);
    this.updateJumpToUnread(); // divider may have scrolled in/out of view
    if (this.pendingPrepend || this.loadingOlder() || !this.canLoadOlder()) {
      return;
    }
    if (el.scrollTop < AUTO_LOAD_THRESHOLD_PX) {
      this.prevScrollHeight = el.scrollHeight;
      this.prevScrollTop = el.scrollTop;
      this.pendingPrepend = true;
      this.loadOlder.emit();
    }
  }

  /** Jump straight back to the newest message (the jump-to-latest pill). */
  scrollToLatest(): void {
    const el = this.scrollEl()?.nativeElement;
    if (!el) {
      return;
    }
    el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior() });
    this.atBottom = true;
    this.notAtBottom.set(false);
  }

  /** Scroll a message into view (reply preview, in-room search, or pinned panel) and
   * briefly highlight it. */
  jumpTo(messageId: string): void {
    const el = this.scrollEl()?.nativeElement.querySelector(
      `[data-mid="${messageId}"]`,
    );
    el?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
    this.flash(el);
  }
}
