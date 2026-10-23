import {
  DestroyRef,
  ErrorHandler,
  Injectable,
  InjectionToken,
  Signal,
  computed,
  inject,
  signal,
} from '@angular/core';
import { EMPTY, Observable, defer, of } from 'rxjs';
import {
  MediaPipeline,
  type MediaTransferEvent,
  type MediaTransferRequest,
  type StagedMediaReference,
} from '@trinity/data-access/media';
import {
  DraftStoreService,
  PrivacySettingsService,
} from '@trinity/platform-native';
import {
  ConversationComposeController,
  type ConversationCompose,
  type ConversationComposeSnapshot,
} from './conversation-compose';
import { CONVERSATION_TEXT_SENDER } from './conversation-text-sender.service';
import { CONVERSATION_MESSAGE_ADAPTER } from './conversation-message-adapter.service';
import {
  type ConversationKey,
  type ConversationMessageOperation,
  type ConversationMessageOutcome,
  type ConversationMessages,
} from './conversation-messages';
import type { ConversationThreads } from './conversation-threads';
import { isEditableMessage } from './message-presentation';
import type {
  ConversationPinOperation,
  ConversationPinOutcome,
  ConversationPins,
} from './conversation-pins';
import { READY_LOAD_STATE } from './conversation-timeline-readiness';
import { createConversationThreadChildren } from './conversation-thread-children';
import {
  CONVERSATION_TIMELINE_FACTORY,
  type ConversationSearch,
  type ConversationTimeline,
  type ConversationTimelineController,
} from './conversation-timeline-factory';
import { conversationDraftKey } from './conversation-draft-key';

export { CONVERSATION_TEXT_SENDER } from './conversation-text-sender.service';
export type {
  ConversationTextSendRequest,
  ConversationTextSender,
} from './conversation-compose';

const MAX_RETAINED_COMPOSE_INTENTS = 200;

export type ConversationState = 'focused' | 'retained' | 'retired';

export interface ConversationHandle {
  readonly key: ConversationKey;
  readonly state: Signal<ConversationState>;
  readonly timeline: ConversationTimeline;
  readonly search: ConversationSearch;
  readonly compose: ConversationCompose;
  readonly messages: ConversationMessages;
  readonly media: ConversationMedia;
  readonly threads: ConversationThreads;
  readonly pins: ConversationPins;
}

/** Exact-Conversation attachment command surface; staged bytes remain opaque. */
export interface ConversationMedia {
  send(
    media: StagedMediaReference,
    caption: string,
  ): Observable<MediaTransferEvent>;
}

export interface ConversationRuntimeDiagnostics {
  readonly lastAttachDurationMs: number | null;
  readonly activeHandles: number;
  readonly focusedHandles: number;
  readonly retainedHandles: number;
  readonly retiredHandles: number;
  readonly listenerCount: number;
  readonly retainedBytes: number;
}

export const CONVERSATION_RETENTION_LIMIT = new InjectionToken<number>(
  'conversation-runtime.retained-handles-per-account',
  {
    providedIn: 'root',
    factory: () => 2,
  },
);

interface ConversationEntry {
  readonly handle: ConversationHandle;
  readonly state: ReturnType<typeof signal<ConversationState>>;
  readonly controller: ConversationTimelineController;
  readonly composeController: ConversationComposeController;
  readonly releaseThread: () => void;
  lastFocused: number;
}

/**
 * Owns immutable Account-and-Room Conversation handles and their bounded warm lifetime.
 *
 * Focus changes visibility effects; blur retains listener-backed timeline state; eviction
 * permanently retires the exact handle. A later open of the same key creates a new handle
 * rather than reviving an object whose cleanup already ran.
 */
@Injectable({ providedIn: 'root' })
export class ConversationRuntime {
  private readonly factory = inject(CONVERSATION_TIMELINE_FACTORY);
  private readonly drafts = inject(DraftStoreService);
  private readonly textSender = inject(CONVERSATION_TEXT_SENDER);
  private readonly messageAdapter = inject(CONVERSATION_MESSAGE_ADAPTER);
  private readonly mediaPipeline = inject(MediaPipeline);
  private readonly privacy = inject(PrivacySettingsService);
  private readonly retainedPerAccount = Math.max(
    0,
    inject(CONVERSATION_RETENTION_LIMIT),
  );
  private readonly destroyRef = inject(DestroyRef);
  private readonly errors = inject(ErrorHandler);
  private readonly entries = new Map<string, Map<string, ConversationEntry>>();
  private readonly composeSnapshots = new Map<
    string,
    ConversationComposeSnapshot
  >();
  private readonly focusedHandle = signal<ConversationHandle | null>(null);
  private readonly retiredHandles = signal(0);
  private readonly lastAttachDurationMs = signal<number | null>(null);
  private focusOrder = 0;
  /** How many {@link trimFocusedWhileHidden} lifetimes are running. */
  private readonly hiddenWindows = signal(0);

  constructor() {
    this.destroyRef.onDestroy(() => this.retireAll());
  }

  readonly focused = this.focusedHandle.asReadonly();
  /** Whether {@link trimFocusedWhileHidden} is running: the window has been hidden a while. */
  readonly windowHidden = computed(() => this.hiddenWindows() > 0);
  readonly timeline = this.focusedTimeline();
  readonly search = this.focusedSearch();
  readonly compose = this.focusedCompose();
  readonly messages = this.focusedMessages();
  readonly media = this.focusedMedia();
  readonly threads = this.focusedThreads();
  readonly pins = this.focusedPins();
  readonly diagnostics = computed<ConversationRuntimeDiagnostics>(() => {
    const entries = [...this.entries.values()].flatMap((account) => [
      ...account.values(),
    ]);
    let focusedHandles = 0;
    let retainedHandles = 0;
    let listenerCount = 0;
    let retainedBytes = 0;
    for (const entry of entries) {
      const state = entry.state();
      if (state === 'focused') focusedHandles += 1;
      if (state === 'retained') retainedHandles += 1;
      entry.handle.timeline.messages();
      const resources = entry.controller.resources();
      listenerCount += resources.listenerCount;
      if (state === 'retained') retainedBytes += resources.retainedBytes;
    }
    return {
      lastAttachDurationMs: this.lastAttachDurationMs(),
      activeHandles: entries.length,
      focusedHandles,
      retainedHandles,
      retiredHandles: this.retiredHandles(),
      listenerCount,
      retainedBytes,
    };
  });

  focus(key: ConversationKey): ConversationHandle {
    const existing = this.entry(key);
    if (existing?.handle === this.focusedHandle()) {
      return existing.handle;
    }

    // Touch a retained target before blurring the current handle. Otherwise the target
    // can be the LRU victim of the blur that makes room for it, and a focus operation
    // would needlessly retire the exact handle it is trying to reuse.
    if (existing) existing.lastFocused = ++this.focusOrder;
    this.blur();
    const entry = this.entry(key) ?? this.create(key);
    entry.lastFocused = ++this.focusOrder;
    entry.state.set('focused');
    entry.controller.setVisible(true);
    this.focusedHandle.set(entry.handle);
    return entry.handle;
  }

  blur(): void {
    const handle = this.focusedHandle();
    if (!handle) return;
    const entry = this.entry(handle.key);
    this.focusedHandle.set(null);
    if (!entry || entry.handle !== handle) return;
    entry.state.set('retained');
    entry.releaseThread();
    entry.composeController.stopTyping();
    entry.controller.setVisible(false);
    this.evictRetained(handle.key.accountId);
  }

  /**
   * Retire every warm, non-focused handle; reopening one later attaches it cold, and pages
   * its older history in again.
   */
  retireRetained(): void {
    for (const account of [...this.entries.values()]) {
      for (const entry of [...account.values()]) {
        if (entry.state() === 'retained') this.retire(entry, 'release-history');
      }
    }
  }

  /** Whether the Account has a focused or retained handle for the room. */
  holds(accountId: string, roomId: string): boolean {
    return this.entries.get(accountId)?.has(roomId) ?? false;
  }

  /**
   * For as long as it is subscribed, the window is hidden ({@link windowHidden}): the
   * `LiveTimelineTrimmer` trims the focused room through {@link trimHeld} right away and
   * after each sync, like a room nobody has open, but only while its view follows the
   * newest message. A trim never cuts past what that view shows or the event the
   * composer replies to or edits; below the 1,000-event ceiling it also keeps the open
   * thread's root. Showing the window again ends it. Owned by the Application Runtime's
   * hidden-window release.
   */
  trimFocusedWhileHidden(): Observable<never> {
    return new Observable<never>(() => {
      this.hiddenWindows.update((count) => count + 1);
      return () => {
        this.hiddenWindows.update((count) => count - 1);
      };
    });
  }

  /**
   * Trim a room a handle holds, if it may be trimmed now: only the focused room, only while
   * the window is hidden. A retained room waits for its handle to retire. A failed trim
   * throws and leaves the room as it was; the trimmer reports a room once.
   */
  trimHeld(accountId: string, roomId: string): void {
    const handle = this.focusedHandle();
    if (
      this.hiddenWindows() === 0 ||
      !handle ||
      handle.key.accountId !== accountId ||
      handle.key.roomId !== roomId
    ) {
      return;
    }
    const entry = this.entry(handle.key);
    if (entry?.handle !== handle) return;
    const intent = entry.composeController.compose.intent();
    // The thread panel reads its root from the Thread, so the root needs no more than the
    // receipt's protection.
    const root = entry.controller.threads.openThreadRootId();
    entry.controller.trimWhileHidden({
      kept: intent.kind === 'message' ? [] : [intent.eventId],
      marked: root ? [root] : [],
    });
  }

  /**
   * Page a held room back in after its live timeline was rewound: to about `depth` events
   * while it is focused, one page while it is retained. Cold; completes at once for a room
   * no handle holds.
   */
  refillHeld(
    accountId: string,
    roomId: string,
    depth: number,
  ): Observable<void> {
    return defer(
      () =>
        this.entry({ accountId, roomId })?.controller.refill(depth) ?? EMPTY,
    );
  }

  retireAll(): void {
    const failures: unknown[] = [];
    for (const account of [...this.entries.values()]) {
      for (const entry of [...account.values()]) {
        try {
          this.retire(entry);
        } catch (error: unknown) {
          failures.push(error);
        }
      }
    }
    this.composeSnapshots.clear();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Conversation retirement failed.');
    }
  }

  private create(key: ConversationKey): ConversationEntry {
    const immutableKey = Object.freeze({ ...key });
    const draftKey = conversationDraftKey(immutableKey);
    const startedAt = performance.now();
    const controller = this.factory.create(immutableKey);
    this.lastAttachDurationMs.set(performance.now() - startedAt);
    const state = signal<ConversationState>('retained');
    const composeController = new ConversationComposeController({
      key: immutableKey,
      state: state.asReadonly(),
      initialDraft: this.initialDraft(immutableKey, draftKey),
      initialSnapshot: this.composeSnapshots.get(draftKey),
      persistDraft: (draft) => this.drafts.set(draftKey, draft),
      persistSnapshot: (snapshot) =>
        this.persistComposeSnapshot(draftKey, snapshot),
      setTyping: (typing) => controller.timeline.setTyping(typing, 'room'),
      send: (request) => this.textSender.send(request),
    });
    const availableMessage = (messageId: string) =>
      controller.timeline
        .messages()
        .find((message) => message.id === messageId);
    const rejected = (
      operation: ConversationMessageOperation,
      failure: Extract<
        ConversationMessageOutcome,
        { kind: 'rejected' }
      >['failure'],
    ): ConversationMessageOutcome => ({
      kind: 'rejected',
      operation,
      failure,
      retryable: false,
    });
    const applied = (
      operation: ConversationMessageOperation,
    ): ConversationMessageOutcome => ({ kind: 'applied', operation });
    const messages: ConversationMessages = {
      beginReply: (messageId: string): ConversationMessageOutcome => {
        if (state() !== 'focused') {
          return rejected('reply', 'conversation-unavailable');
        }
        const message = availableMessage(messageId);
        if (!message) {
          return rejected('reply', 'message-unavailable');
        }
        composeController.beginReply(messageId);
        return applied('reply');
      },
      beginEdit: (
        messageId: string,
        draft: string,
      ): ConversationMessageOutcome => {
        if (state() !== 'focused') {
          return rejected('edit', 'conversation-unavailable');
        }
        const message = availableMessage(messageId);
        if (!message || !isEditableMessage(message)) {
          return rejected('edit', 'message-unavailable');
        }
        composeController.beginEdit(messageId, draft);
        return applied('edit');
      },
      toggleReaction: (messageId: string, reaction: string) =>
        defer(() =>
          state() === 'focused'
            ? this.messageAdapter.toggleReaction({
                key: immutableKey,
                messageId,
                reaction,
              })
            : of(rejected('reaction', 'conversation-unavailable')),
        ),
      redact: (messageId: string) =>
        defer(() =>
          state() === 'focused'
            ? this.messageAdapter.redact({ key: immutableKey, messageId })
            : of(rejected('redaction', 'conversation-unavailable')),
        ),
      retry: (messageId: string) =>
        defer(() =>
          state() === 'focused'
            ? this.messageAdapter.retry({ key: immutableKey, messageId })
            : of(rejected('retry', 'conversation-unavailable')),
        ),
      cancel: (messageId: string) =>
        defer(() =>
          state() === 'focused'
            ? this.messageAdapter.cancel({ key: immutableKey, messageId })
            : of(rejected('cancel', 'conversation-unavailable')),
        ),
      acknowledge: (messageId: string) =>
        defer(() =>
          state() === 'focused'
            ? this.messageAdapter.acknowledge({
                key: immutableKey,
                messageId,
              })
            : of(rejected('receipt', 'conversation-unavailable')),
        ),
    };
    Object.freeze(messages);
    const threadChildren = createConversationThreadChildren({
      key: immutableKey,
      isFocused: () => state() === 'focused',
      projection: controller.threads,
      messages: this.messageAdapter,
      media: { transfer: (request) => this.transferMedia(request) },
    });
    const threads = threadChildren.threads;
    const releaseThread = threadChildren.release;
    const pinRejected = (
      operation: ConversationPinOperation,
    ): ConversationPinOutcome => ({
      kind: 'rejected',
      operation,
      failure: 'conversation-unavailable',
      retryable: false,
    });
    const pins: ConversationPins = Object.freeze({
      eventIds: controller.pins.eventIds,
      messages: controller.pins.messages,
      canMutate: computed(
        () => state() === 'focused' && controller.pins.canMutate(),
      ),
      isPinned: (eventId: string) => controller.pins.isPinned(eventId),
      retryFailed: () => controller.pins.retryFailed(),
      pin: (eventId: string) =>
        defer(() =>
          state() === 'focused'
            ? controller.pins.pin(eventId)
            : of(pinRejected('pin')),
        ),
      unpin: (eventId: string) =>
        defer(() =>
          state() === 'focused'
            ? controller.pins.unpin(eventId)
            : of(pinRejected('unpin')),
        ),
    });
    const handle = Object.freeze({
      key: immutableKey,
      state: state.asReadonly(),
      timeline: controller.timeline,
      search: controller.search,
      compose: composeController.compose,
      messages,
      media: Object.freeze({
        send: (media: StagedMediaReference, caption: string) =>
          defer(() =>
            this.transferMedia({
              key: immutableKey,
              media,
              caption,
            }),
          ),
      }),
      threads,
      pins,
    });
    const entry: ConversationEntry = {
      handle,
      state,
      controller,
      composeController,
      releaseThread,
      lastFocused: 0,
    };
    const account = this.entries.get(key.accountId) ?? new Map();
    account.set(key.roomId, entry);
    this.entries.set(key.accountId, account);
    return entry;
  }

  /**
   * Sends staged media with the person's photo and video metadata choice as it stands when
   * the send starts. The choice covers message attachments only; avatars never pass through
   * here.
   */
  private transferMedia(
    request: MediaTransferRequest,
  ): Observable<MediaTransferEvent> {
    return this.mediaPipeline.transfer({
      ...request,
      imageMetadata: this.privacy.keepPhotoMetadata() ? 'keep' : 'strip',
    });
  }

  private persistComposeSnapshot(
    key: string,
    snapshot: ConversationComposeSnapshot | null,
  ): void {
    this.composeSnapshots.delete(key);
    if (!snapshot) return;
    this.composeSnapshots.set(key, snapshot);
    while (this.composeSnapshots.size > MAX_RETAINED_COMPOSE_INTENTS) {
      const oldest = this.composeSnapshots.keys().next().value as
        string | undefined;
      if (oldest === undefined) return;
      this.composeSnapshots.delete(oldest);
    }
  }

  private initialDraft(key: ConversationKey, draftKey: string): string {
    const scoped = this.drafts.get(draftKey);
    if (scoped) return scoped;

    // The first exact Account-and-Room handle claims the legacy Room-only draft, then the
    // ambiguous key is removed so another Account in the same Room cannot inherit it.
    const legacy = this.drafts.get(key.roomId);
    if (!legacy) return '';
    this.drafts.clear(key.roomId);
    this.drafts.set(draftKey, legacy);
    return legacy;
  }

  private focusedTimeline(): ConversationTimeline {
    const focused = this.focusedHandle.asReadonly();
    return {
      messages: computed(() => focused()?.timeline.messages() ?? []),
      loadingOlder: computed(() => focused()?.timeline.loadingOlder() ?? false),
      canLoadOlder: computed(() => focused()?.timeline.canLoadOlder() ?? false),
      loadState: computed(
        () => focused()?.timeline.loadState() ?? READY_LOAD_STATE,
      ),
      retryLoad: () => focused()?.timeline.retryLoad(),
      oldestEventId: computed(
        () => focused()?.timeline.oldestEventId() ?? null,
      ),
      typingNames: computed(() => focused()?.timeline.typingNames() ?? []),
      canRedactOthers: computed(
        () => focused()?.timeline.canRedactOthers() ?? false,
      ),
      tombstone: computed(() => focused()?.timeline.tombstone() ?? null),
      firstUnreadId: computed(
        () => focused()?.timeline.firstUnreadId() ?? null,
      ),
      get openRoomId() {
        return focused()?.key.roomId ?? null;
      },
      get roomEncrypted() {
        return focused()?.timeline.roomEncrypted ?? false;
      },
      loadOlder: () =>
        defer(() => focused()?.timeline.loadOlder() ?? of(void 0)),
      jumpToDate: (dayStartMs) =>
        defer(
          () =>
            focused()?.timeline.jumpToDate(dayStartMs) ??
            of({ kind: 'no-event' as const }),
        ),
      loadEvent: (eventId) =>
        defer(() => focused()?.timeline.loadEvent(eventId) ?? of(false)),
      setLiveView: (oldestShownId) =>
        focused()?.timeline.setLiveView(oldestShownId),
      setTyping: (typing, owner) =>
        focused()?.timeline.setTyping(typing, owner),
      rawEvent: (roomId, eventId) =>
        focused()?.timeline.rawEvent(roomId, eventId) ?? null,
      reactionDetails: (eventId) =>
        focused()?.timeline.reactionDetails(eventId) ?? [],
    };
  }

  private focusedSearch(): ConversationSearch {
    const focused = this.focusedHandle.asReadonly();
    const emptyLoaded = {
      hits: [],
      scanned: 0,
      encrypted: false,
      serverAvailable: false,
    } as const;
    const emptyServer = { hits: [], count: 0, nextBatch: null } as const;
    return {
      searchLoaded: (query) =>
        focused()?.search.searchLoaded(query) ?? emptyLoaded,
      searchServer: (term, nextBatch) =>
        defer(
          () =>
            focused()?.search.searchServer(term, nextBatch) ?? of(emptyServer),
        ),
      loadOlder: (count) =>
        defer(() => focused()?.search.loadOlder(count) ?? of(0)),
    };
  }

  private focusedCompose(): ConversationCompose {
    const focused = this.focusedHandle.asReadonly();
    return {
      draft: computed(() => focused()?.compose.draft() ?? ''),
      intent: computed(
        () => focused()?.compose.intent() ?? ({ kind: 'message' } as const),
      ),
      sending: computed(() => focused()?.compose.sending() ?? false),
      setDraft: (draft) => focused()?.compose.setDraft(draft),
      cancelIntent: () => focused()?.compose.cancelIntent(),
      setTyping: (typing) => focused()?.compose.setTyping(typing),
      submit: (mentions) =>
        defer(
          () =>
            focused()?.compose.submit(mentions) ??
            of({
              kind: 'rejected' as const,
              failure: 'conversation-unavailable' as const,
              retryable: false,
            }),
        ),
    };
  }

  private focusedMedia(): ConversationMedia {
    const focused = this.focusedHandle.asReadonly();
    return {
      send: (media, caption) =>
        defer(
          () =>
            focused()?.media.send(media, caption) ??
            of({
              kind: 'rejected' as const,
              failure: 'conversation-unavailable' as const,
              retryable: false,
            }),
        ),
    };
  }

  private focusedThreads(): ConversationThreads {
    const focused = this.focusedHandle.asReadonly();
    return {
      summaries: computed(() => focused()?.threads.summaries() ?? {}),
      list: computed(() => focused()?.threads.list() ?? []),
      forRoot: (rootEventId) => focused()?.threads.forRoot(rootEventId) ?? null,
    };
  }

  private focusedPins(): ConversationPins {
    const focused = this.focusedHandle.asReadonly();
    const unavailable = (
      operation: ConversationPinOperation,
    ): ConversationPinOutcome => ({
      kind: 'rejected',
      operation,
      failure: 'conversation-unavailable',
      retryable: false,
    });
    return {
      eventIds: computed(() => focused()?.pins.eventIds() ?? []),
      messages: computed(() => focused()?.pins.messages() ?? []),
      canMutate: computed(() => focused()?.pins.canMutate() ?? false),
      isPinned: (eventId) => focused()?.pins.isPinned(eventId) ?? false,
      retryFailed: () => focused()?.pins.retryFailed(),
      pin: (eventId) =>
        defer(() => focused()?.pins.pin(eventId) ?? of(unavailable('pin'))),
      unpin: (eventId) =>
        defer(() => focused()?.pins.unpin(eventId) ?? of(unavailable('unpin'))),
    };
  }

  private focusedMessages(): ConversationMessages {
    const focused = this.focusedHandle.asReadonly();
    const unavailable = (
      operation: ConversationMessageOperation,
    ): ConversationMessageOutcome => ({
      kind: 'rejected',
      operation,
      failure: 'conversation-unavailable',
      retryable: false,
    });
    return {
      beginReply: (messageId) =>
        focused()?.messages.beginReply(messageId) ?? unavailable('reply'),
      beginEdit: (messageId, draft) =>
        focused()?.messages.beginEdit(messageId, draft) ?? unavailable('edit'),
      toggleReaction: (messageId, reaction) =>
        defer(
          () =>
            focused()?.messages.toggleReaction(messageId, reaction) ??
            of(unavailable('reaction')),
        ),
      redact: (messageId) =>
        defer(
          () =>
            focused()?.messages.redact(messageId) ??
            of(unavailable('redaction')),
        ),
      retry: (messageId) =>
        defer(
          () =>
            focused()?.messages.retry(messageId) ?? of(unavailable('retry')),
        ),
      cancel: (messageId) =>
        defer(
          () =>
            focused()?.messages.cancel(messageId) ?? of(unavailable('cancel')),
        ),
      acknowledge: (messageId) =>
        defer(
          () =>
            focused()?.messages.acknowledge(messageId) ??
            of(unavailable('receipt')),
        ),
    };
  }

  private entry(key: ConversationKey): ConversationEntry | null {
    return this.entries.get(key.accountId)?.get(key.roomId) ?? null;
  }

  private evictRetained(accountId: string): void {
    const account = this.entries.get(accountId);
    if (!account) return;
    const retained = [...account.values()]
      .filter((entry) => entry.state() === 'retained')
      .sort((left, right) => left.lastFocused - right.lastFocused);
    while (retained.length > this.retainedPerAccount) {
      this.retire(retained.shift()!, 'release-history');
    }
  }

  /**
   * Retire one handle. A handle retired while the Account stays signed in also releases
   * its room's SDK history: nothing shows the room now, so only the latest events stay.
   */
  private retire(
    entry: ConversationEntry,
    history: 'keep-history' | 'release-history' = 'keep-history',
  ): void {
    if (entry.state() === 'retired') return;
    if (this.focusedHandle() === entry.handle) {
      this.focusedHandle.set(null);
    }
    const { accountId, roomId } = entry.handle.key;
    const account = this.entries.get(accountId);
    if (account?.get(roomId) === entry) {
      account.delete(roomId);
      if (account.size === 0) this.entries.delete(accountId);
    }
    entry.state.set('retired');
    entry.releaseThread();
    entry.composeController.stopTyping();
    this.retiredHandles.update((count) => count + 1);
    entry.controller.release();
    if (history === 'release-history') {
      try {
        entry.controller.releaseHistory();
      } catch (error: unknown) {
        // Best effort: the handle is already retired, and the history stays as it was.
        this.errors.handleError(error);
      }
    }
  }
}
