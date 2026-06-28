import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { AlertController } from '@ionic/angular/standalone';
import { MessageComposerComponent } from '../message-composer/message-composer.component';
import {
  MessageRowComponent,
  type MessageRow,
} from '../message-row/message-row.component';
import {
  isEditableMessage,
  type MessageView,
  type ThreadSummary,
} from '@trinity/core';

/** Trigger older-history loading when the scroll top gets within this many px. */
const AUTO_LOAD_THRESHOLD_PX = 150;

/**
 * Safety cap on consecutive auto-backfill rounds for one fill sequence, so the
 * effect can never spin even if the "did older history arrive?" check is fooled.
 * Each round pulls ~SCROLLBACK events, so this is far more than any viewport needs.
 */
const MAX_BACKFILL_ROUNDS = 20;

/** Discord-style message list for the active room (read-only timeline). */
@Component({
  selector: 'trn-message-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MessageComposerComponent, MessageRowComponent],
  templateUrl: './message-list.component.html',
  styleUrl: './message-list.component.scss',
})
export class MessageListComponent {
  readonly messages = input<MessageView[]>([]);
  /** Thread summaries keyed by root event id, for the per-row thread indicator. */
  readonly threadSummaries = input<Record<string, ThreadSummary>>({});
  readonly loadingOlder = input(false);
  readonly canLoadOlder = input(false);
  readonly roomName = input('');
  /** Attachment upload fraction in [0, 1], or null when no upload is in flight. */
  readonly uploadProgress = input<number | null>(null);
  /**
   * Event id to scroll into view, set by an external jump (e.g. in-room message
   * search). Reuses the same {@link jumpTo} scroll the reply-preview uses; a no-op
   * when the event isn't in the loaded timeline.
   */
  readonly jumpToId = input<string | null>(null);
  readonly loadOlder = output<void>();
  /** Open the thread rooted at this event id (raised by a row's indicator). */
  readonly openThread = output<string>();
  readonly send = output<string>();
  readonly sendMedia = output<File>();
  readonly retry = output<string>();
  readonly editMessage = output<{ id: string; body: string }>();
  readonly deleteMessage = output<string>();
  readonly react = output<{ id: string; key: string }>();
  readonly reply = output<{ id: string; body: string }>();

  readonly editingId = signal<string | null>(null);
  readonly editingDraft = computed(
    () => this.messages().find((m) => m.id === this.editingId())?.body ?? '',
  );

  readonly replyingToId = signal<string | null>(null);
  readonly replyingToName = computed(
    () =>
      this.messages().find((m) => m.id === this.replyingToId())?.senderName ??
      '',
  );

  /** Live-region text announcing a newly-arrived incoming message to screen readers. */
  readonly announcement = signal('');

  private readonly alertCtrl = inject(AlertController);
  private readonly scrollEl = viewChild<ElementRef<HTMLElement>>('scroll');
  private lastId = '';

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
  private lastBackfillOldestId = '';
  private backfillRounds = 0;

  /** Group consecutive messages from the same sender (Discord-style). */
  readonly rows = computed<MessageRow[]>(() => {
    const GAP_MS = 5 * 60 * 1000;
    const msgs = this.messages();
    return msgs.map((m, i) => {
      const prev = msgs[i - 1];
      const showHeader =
        !prev ||
        prev.senderId !== m.senderId ||
        m.timestamp - prev.timestamp > GAP_MS;
      return { ...m, showHeader };
    });
  });

  constructor() {
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
      const newest = msgs[msgs.length - 1]?.id ?? '';
      const newestChanged = !!newest && newest !== this.lastId;
      this.lastId = newest || this.lastId;
      if (newestChanged) {
        // New room or live message — grant a fresh backfill budget.
        this.backfillRounds = 0;
        // Announce a genuinely-new incoming message (not our own, not the first
        // load) so screen-reader users hear it without watching the timeline.
        const latest = msgs[msgs.length - 1];
        if (
          hadPrevious &&
          latest &&
          !latest.isOwn &&
          !latest.decryptionFailed &&
          latest.kind !== 'redacted'
        ) {
          this.announcement.set(`${latest.senderName}: ${latest.body}`);
        }
      }
      // Keep the newest message in view on open, on live messages, and while
      // backfilling older history.
      const stickToBottom = newestChanged || this.backfilling;

      requestAnimationFrame(() => {
        if (stickToBottom) {
          el.scrollTop = el.scrollHeight;
        }

        // If the timeline doesn't fill the viewport, pull in older history so
        // there's something to scroll. Stop once it's scrollable, history runs
        // out, the last load prepended nothing (oldest id unchanged), or the
        // round cap is hit.
        const notFull = el.scrollHeight <= el.clientHeight + 1;
        const oldestId = msgs[0]?.id ?? '';
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

    // Scroll to an externally-requested event (in-room search jump). Runs after the
    // anchoring effect above so the row is in the DOM; reuses jumpTo, so it's a no-op
    // when the event isn't loaded.
    effect(() => {
      const id = this.jumpToId();
      if (id) {
        this.jumpTo(id);
      }
    });
  }

  /** Auto-load older history once the user scrolls near the top. */
  onScroll(): void {
    const el = this.scrollEl()?.nativeElement;
    if (
      !el ||
      this.pendingPrepend ||
      this.loadingOlder() ||
      !this.canLoadOlder()
    ) {
      return;
    }
    if (el.scrollTop < AUTO_LOAD_THRESHOLD_PX) {
      this.prevScrollHeight = el.scrollHeight;
      this.prevScrollTop = el.scrollTop;
      this.pendingPrepend = true;
      this.loadOlder.emit();
    }
  }

  startEdit(row: MessageRow): void {
    this.replyingToId.set(null);
    this.editingId.set(row.id);
  }

  startReply(row: MessageRow): void {
    this.editingId.set(null);
    this.replyingToId.set(row.id);
  }

  /** Scroll the original message into view when its reply preview is clicked. */
  jumpTo(messageId: string): void {
    this.scrollEl()
      ?.nativeElement.querySelector(`[data-mid="${messageId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /** A message the current user can still edit (own, confirmed, text — not media). */
  isEditable(m: MessageView): boolean {
    return isEditableMessage(m);
  }

  /** Edit the most recent editable message of the current user (Up-arrow shortcut). */
  editLastOwn(): void {
    const msgs = this.messages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (this.isEditable(msgs[i])) {
        this.editingId.set(msgs[i].id);
        return;
      }
    }
  }

  onCopy(row: MessageRow): void {
    void navigator.clipboard?.writeText(row.body);
  }

  async onDelete(row: MessageRow): Promise<void> {
    const alert = await this.alertCtrl.create({
      header: 'Delete message',
      message: 'Delete this message? This cannot be undone.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete',
          role: 'destructive',
          handler: () => this.deleteMessage.emit(row.id),
        },
      ],
    });
    await alert.present();
  }

  /** Composer submit — routes to an edit or reply when active, else a new send. */
  onSubmit(text: string): void {
    const editId = this.editingId();
    const replyId = this.replyingToId();
    if (editId) {
      this.editMessage.emit({ id: editId, body: text });
      this.editingId.set(null);
    } else if (replyId) {
      this.reply.emit({ id: replyId, body: text });
      this.replyingToId.set(null);
    } else {
      this.send.emit(text);
    }
  }
}
