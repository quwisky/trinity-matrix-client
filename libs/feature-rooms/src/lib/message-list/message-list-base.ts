import {
  Directive,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TrnAlertService } from '@trinity/helm/overlay';
import {
  isEditableMessage,
  type MessageView,
  type ThreadSummary,
} from '@trinity/core';
import { type MessageRow } from '../message-row/message-row.component';

/**
 * Shared domain logic for the room timeline, independent of scroll strategy: the
 * inputs/outputs, the edit/reply state + action handlers, and the Discord-style row
 * grouping. {@link SimpleMessageListComponent} (plain scroll) and
 * {@link VirtualMessageListComponent} (windowed) extend this and add only their own
 * scroll container, effects and template — the feature flag selects which one the
 * room renders. Kept an abstract `@Directive()` (no selector) so Angular wires the
 * inherited inputs/outputs/queries for the subclasses.
 */
@Directive()
export abstract class MessageListBase {
  readonly messages = input<MessageView[]>([]);
  /** Thread summaries keyed by root event id, for the per-row thread indicator. */
  readonly threadSummaries = input<Record<string, ThreadSummary>>({});
  readonly loadingOlder = input(false);
  readonly canLoadOlder = input(false);
  readonly roomName = input('');
  /**
   * Active room id. The list instance is reused across room switches, so a change
   * here resets the per-room UI + scroll state (see {@link resetOnRoomChange}) —
   * otherwise a pending edit/reply target and the scroll anchors leak between rooms.
   */
  readonly roomId = input<string | null>(null);
  /** Attachment upload fraction in [0, 1], or null when no upload is in flight. */
  readonly uploadProgress = input<number | null>(null);
  /**
   * Event id to scroll into view, set by an external jump (e.g. in-room search).
   * A no-op when the event isn't in the loaded timeline.
   */
  readonly jumpToId = input<string | null>(null);
  readonly loadOlder = output<void>();
  /** Open the thread rooted at this event id (raised by a row's indicator). */
  readonly openThread = output<string>();
  readonly send = output<string>();
  readonly sendMedia = output<{ file: File; caption: string }>();
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

  protected readonly alert = inject(TrnAlertService);
  protected readonly scrollEl = viewChild<ElementRef<HTMLElement>>('scroll');

  // Grouping rows, cached per event id so an unchanged message (same view object AND
  // same header flag) keeps its row identity — an OnPush row is then re-rendered only
  // when its own message or grouping changes, not on every live event in the room.
  private rowCache = new Map<
    string,
    { view: MessageView; showHeader: boolean; row: MessageRow }
  >();

  /** Group consecutive messages from the same sender (Discord-style). */
  readonly rows = computed<MessageRow[]>(() => {
    const GAP_MS = 5 * 60 * 1000;
    const msgs = this.messages();
    const nextCache = new Map<
      string,
      { view: MessageView; showHeader: boolean; row: MessageRow }
    >();
    const result = msgs.map((m, i) => {
      const prev = msgs[i - 1];
      const showHeader =
        !prev ||
        prev.senderId !== m.senderId ||
        m.timestamp - prev.timestamp > GAP_MS ||
        // A reply always shows its own header: the quoted preview breaks the visual
        // flow, so a headerless continuation would look like the reply lost its
        // author (name + avatar).
        !!m.replyTo;
      const cached = this.rowCache.get(m.id);
      const row =
        cached && cached.view === m && cached.showHeader === showHeader
          ? cached.row
          : { ...m, showHeader };
      nextCache.set(m.id, { view: m, showHeader, row });
      return row;
    });
    this.rowCache = nextCache;
    return result;
  });

  constructor() {
    // Reset per-room state when the active room changes. Created here — before any
    // scroll effect a subclass adds in its own constructor — so it runs FIRST
    // (effects fire in creation order), letting the scroll effect treat the new room
    // as a fresh load. Subclasses override resetOnRoomChange() to also clear their
    // scroll/windowing state.
    effect(() => {
      this.roomId();
      untracked(() => this.resetOnRoomChange());
    });
  }

  /** Reset per-room state on a room switch. Subclasses override to add scroll state. */
  protected resetOnRoomChange(): void {
    this.editingId.set(null);
    this.replyingToId.set(null);
    this.announcement.set('');
    this.rowCache.clear();
  }

  startEdit(row: MessageRow): void {
    this.replyingToId.set(null);
    this.editingId.set(row.id);
  }

  startReply(row: MessageRow): void {
    this.editingId.set(null);
    this.replyingToId.set(row.id);
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
    const confirmed = await this.alert.confirm({
      header: 'Delete message',
      message: 'Delete this message? This cannot be undone.',
      confirmText: 'Delete',
      destructive: true,
    });
    if (confirmed) {
      this.deleteMessage.emit(row.id);
    }
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
