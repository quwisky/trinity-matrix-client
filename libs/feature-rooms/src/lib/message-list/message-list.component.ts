import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { AvatarComponent } from '../avatar/avatar.component';
import { MessageComposerComponent } from '../message-composer/message-composer.component';
import { MessageToolbarComponent } from '../message-toolbar/message-toolbar.component';
import type { MessageView } from '@trinity/core';

interface MessageRow extends MessageView {
  showHeader: boolean;
}

/** Trigger older-history loading when the scroll top gets within this many px. */
const AUTO_LOAD_THRESHOLD_PX = 150;

/** Discord-style message list for the active room (read-only timeline). */
@Component({
  selector: 'trn-message-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarComponent,
    DatePipe,
    MessageComposerComponent,
    MessageToolbarComponent,
  ],
  templateUrl: './message-list.component.html',
  styleUrl: './message-list.component.scss',
})
export class MessageListComponent {
  readonly messages = input<MessageView[]>([]);
  readonly loadingOlder = input(false);
  readonly canLoadOlder = input(false);
  readonly roomName = input('');
  readonly loadOlder = output<void>();
  readonly send = output<string>();
  readonly retry = output<string>();
  readonly editMessage = output<{ id: string; body: string }>();
  readonly deleteMessage = output<string>();

  readonly editingId = signal<string | null>(null);
  readonly editingDraft = computed(
    () => this.messages().find((m) => m.id === this.editingId())?.body ?? '',
  );

  private readonly scrollEl = viewChild<ElementRef<HTMLElement>>('scroll');
  private lastId = '';

  // Scroll-anchoring state while older history is being prepended.
  private pendingPrepend = false;
  private prevScrollHeight = 0;
  private prevScrollTop = 0;

  // Backfill state: keep loading older history until the viewport is full so the
  // user has room to scroll (otherwise a short timeline can never paginate).
  private backfilling = false;
  private backfillCount = -1;

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

      const newest = msgs[msgs.length - 1]?.id ?? '';
      const newestChanged = !!newest && newest !== this.lastId;
      this.lastId = newest || this.lastId;
      if (newestChanged) {
        // New room or live message — restart the backfill stall guard.
        this.backfillCount = -1;
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
        // out, or a load adds nothing (stall guard via backfillCount).
        const notFull = el.scrollHeight <= el.clientHeight + 1;
        if (
          notFull &&
          this.canLoadOlder() &&
          !this.loadingOlder() &&
          !this.pendingPrepend &&
          msgs.length !== this.backfillCount
        ) {
          this.backfilling = true;
          this.backfillCount = msgs.length;
          this.loadOlder.emit();
        } else {
          this.backfilling = false;
        }
      });
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
    this.editingId.set(row.id);
  }

  /** Edit the most recent editable message of the current user (Up-arrow shortcut). */
  editLastOwn(): void {
    const msgs = this.messages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (
        m.isOwn &&
        !m.status &&
        !m.decryptionFailed &&
        m.kind !== 'redacted'
      ) {
        this.editingId.set(m.id);
        return;
      }
    }
  }

  onCopy(row: MessageRow): void {
    void navigator.clipboard?.writeText(row.body);
  }

  onDelete(row: MessageRow): void {
    if (window.confirm('Delete this message?')) {
      this.deleteMessage.emit(row.id);
    }
  }

  /** Composer submit — routes to an edit when one is in progress, else a new send. */
  onSubmit(text: string): void {
    const id = this.editingId();
    if (id) {
      this.editMessage.emit({ id, body: text });
      this.editingId.set(null);
    } else {
      this.send.emit(text);
    }
  }
}
