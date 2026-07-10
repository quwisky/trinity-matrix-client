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
import { type ThreadSummary } from '@trinity/data-access-timeline';
import {
  formatTypingNotice,
  isEditableMessage,
  type MessageView,
  type Mention,
} from '@trinity/util-matrix';
import {
  type MessageRow,
  type MessageRowAction,
  type MessageRowCaps,
} from '../message-row/message-row.component';
import {
  type ComposerSubmit,
  type MentionMember,
} from '../message-composer/message-composer.component';

/** Fallback caps for a row not present in the memoized map (defensive; unreached). */
const DEFAULT_ROW_CAPS: MessageRowCaps = {
  editable: false,
  deletable: false,
  canPin: false,
  pinned: false,
  canThread: true,
  readOnly: false,
};

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
  /** Whether the current user may pin/unpin in this room (drives the per-row Pin item). */
  readonly canPin = input(false);
  /** Currently-pinned event ids, for the per-row pinned state. */
  readonly pinnedIds = input<readonly string[]>([]);
  readonly loadingOlder = input(false);
  readonly canLoadOlder = input(false);
  readonly roomName = input('');
  /**
   * Active room id. The list instance is reused across room switches, so a change
   * here resets the per-room UI + scroll state (see {@link resetOnRoomChange}) —
   * otherwise a pending edit/reply target and the scroll anchors leak between rooms.
   */
  readonly roomId = input<string | null>(null);
  /** Room members, forwarded to the composer's @-mention autocomplete. */
  readonly members = input<MentionMember[]>([]);
  /** Display names of members currently typing in the room (excludes the local user). */
  readonly typingNames = input<string[]>([]);
  /** Attachment upload fraction in [0, 1], or null when no upload is in flight. */
  readonly uploadProgress = input<number | null>(null);
  /**
   * Event id to scroll into view, set by an external jump (e.g. in-room search).
   * A no-op when the event isn't in the loaded timeline.
   */
  readonly jumpToId = input<string | null>(null);
  /**
   * Bumped by the host on every jump request. Paired with {@link jumpToId} so that
   * re-requesting the SAME event id (e.g. clicking the same pinned message twice)
   * still changes an input and re-fires the jump effect — an unchanged `jumpToId`
   * alone would be an Object.is no-op and never re-run.
   */
  readonly jumpToNonce = input(0);
  readonly loadOlder = output<void>();
  /** Open the thread rooted at this event id (raised by a row's indicator). */
  readonly openThread = output<string>();
  /** Pin or unpin this event id (host resolves which, given its current pinned state). */
  readonly togglePin = output<string>();
  readonly send = output<{ body: string; mentions: Mention[] }>();
  readonly sendMedia = output<{ file: File; caption: string }>();
  readonly retry = output<string>();
  readonly editMessage = output<{
    id: string;
    body: string;
    mentions: Mention[];
  }>();
  readonly deleteMessage = output<string>();
  readonly react = output<{ id: string; key: string }>();
  readonly reply = output<{ id: string; body: string; mentions: Mention[] }>();
  /** The composer's typing state changed — host debounces it into a typing notification. */
  readonly typing = output<boolean>();

  /** "X is typing…" text for the row above the composer, or '' when nobody is typing. */
  readonly typingLabel = computed(() => formatTypingNotice(this.typingNames()));

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

  /**
   * Briefly highlight a just-jumped-to message row (after `jumpTo` scrolls it into
   * view) so the eye lands on it. Resets any in-flight flash with a forced reflow so a
   * repeat jump to the same row re-triggers the animation, and self-clears on
   * `animationend`.
   */
  protected flash(el: Element | null | undefined): void {
    if (!el) {
      return;
    }
    el.classList.remove('msg--flash');
    void (el as HTMLElement).offsetWidth; // reflow to restart the CSS animation
    el.classList.add('msg--flash');
    el.addEventListener(
      'animationend',
      () => el.classList.remove('msg--flash'),
      {
        once: true,
      },
    );
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

  /** Whether a row's event id is currently pinned. */
  isPinned(id: string): boolean {
    return this.pinnedIds().includes(id);
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

  /** Scroll a message into view (each scroll strategy implements it differently). */
  abstract jumpTo(messageId: string): void;

  /**
   * Per-row caps keyed by event id, memoized so the reference is stable across
   * change-detection ticks that don't touch pinning/permissions/the message set.
   * `rowCaps()` is called from an `@for` on every CD; returning a fresh object each
   * time would defeat the OnPush `MessageRowComponent` and re-render every row.
   */
  private readonly rowCapsById = computed<Map<string, MessageRowCaps>>(() => {
    const canPin = this.canPin();
    const pinnedIds = this.pinnedIds();
    const caps = new Map<string, MessageRowCaps>();
    for (const message of this.messages()) {
      caps.set(message.id, {
        editable: this.isEditable(message),
        deletable: message.isOwn && !message.status,
        canPin,
        pinned: pinnedIds.includes(message.id),
        canThread: true,
        readOnly: false,
      });
    }
    return caps;
  });

  /** Per-row capabilities/state for {@link MessageRowComponent} in the main timeline. */
  rowCaps(row: MessageRow): MessageRowCaps {
    return this.rowCapsById().get(row.id) ?? DEFAULT_ROW_CAPS;
  }

  /** Route a single row action to its handler / upward output. */
  onRowAction(row: MessageRow, action: MessageRowAction): void {
    switch (action.type) {
      case 'react':
        this.react.emit({ id: row.id, key: action.key });
        break;
      case 'reply':
        this.startReply(row);
        break;
      case 'copy':
        this.onCopy(row);
        break;
      case 'edit':
        this.startEdit(row);
        break;
      case 'delete':
        void this.onDelete(row);
        break;
      case 'pin':
        this.togglePin.emit(row.id);
        break;
      case 'retry':
        this.retry.emit(row.id);
        break;
      case 'jump':
        this.jumpTo(action.id);
        break;
      case 'thread':
        this.openThread.emit(row.id);
        break;
      default: {
        // Exhaustiveness guard: adding a MessageRowAction variant without a case
        // here becomes a compile error rather than a silently-dropped action.
        const unhandled: never = action;
        void unhandled;
        break;
      }
    }
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
  onSubmit({ text, mentions }: ComposerSubmit): void {
    const editId = this.editingId();
    const replyId = this.replyingToId();
    if (editId) {
      this.editMessage.emit({ id: editId, body: text, mentions });
      this.editingId.set(null);
    } else if (replyId) {
      this.reply.emit({ id: replyId, body: text, mentions });
      this.replyingToId.set(null);
    } else {
      this.send.emit({ body: text, mentions });
    }
  }
}
