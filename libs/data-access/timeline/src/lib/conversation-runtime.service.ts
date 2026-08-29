import {
  DestroyRef,
  EnvironmentInjector,
  Injectable,
  InjectionToken,
  Signal,
  computed,
  createEnvironmentInjector,
  inject,
  signal,
} from '@angular/core';
import { Observable, defer, of } from 'rxjs';
import {
  MediaPipeline,
  type MediaTransferEvent,
  type StagedMediaReference,
} from '@trinity/data-access/media';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { DraftStoreService } from '@trinity/platform-native';
import {
  ConversationComposeController,
  type ConversationCompose,
  type ConversationComposeSnapshot,
} from './conversation-compose';
import { ConversationActionContextService } from './conversation-action-context.service';
import { CONVERSATION_TEXT_SENDER } from './conversation-text-sender.service';
import { TimelineService } from './timeline.service';

export { CONVERSATION_TEXT_SENDER } from './conversation-text-sender.service';
export type {
  ConversationTextSendRequest,
  ConversationTextSender,
} from './conversation-compose';

export const CONVERSATION_RUNTIME_BASELINE = {
  retainedHandlesPerAccount: 2,
} as const;

export interface ConversationKey {
  readonly accountId: string;
  readonly roomId: string;
}

function composeDraftKey(key: ConversationKey): string {
  return `conversation:${JSON.stringify([key.accountId, key.roomId])}`;
}

const MAX_RETAINED_COMPOSE_INTENTS = 200;

export type ConversationState = 'focused' | 'retained' | 'retired';

export type ConversationTimeline = Pick<
  TimelineService,
  | 'messages'
  | 'loadingOlder'
  | 'canLoadOlder'
  | 'oldestEventId'
  | 'typingNames'
  | 'canRedactOthers'
  | 'tombstone'
  | 'firstUnreadId'
  | 'openRoomId'
  | 'roomEncrypted'
  | 'loadOlder'
  | 'jumpToDate'
  | 'setTyping'
  | 'rawEvent'
  | 'reactionDetails'
>;

export interface ConversationHandle {
  readonly key: ConversationKey;
  readonly state: Signal<ConversationState>;
  readonly timeline: ConversationTimeline;
  readonly compose: ConversationCompose;
  readonly media: ConversationMedia;
}

/** Exact-Conversation attachment command surface; staged bytes remain opaque. */
export interface ConversationMedia {
  send(
    media: StagedMediaReference,
    caption: string,
  ): Observable<MediaTransferEvent>;
}

export interface ConversationResources {
  readonly listenerCount: number;
  readonly retainedBytes: number;
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

export interface ConversationTimelineController {
  readonly timeline: ConversationTimeline;
  setVisible(visible: boolean): void;
  release(): void;
  resources(): ConversationResources;
}

export interface ConversationTimelineFactory {
  create(key: ConversationKey): ConversationTimelineController;
}

@Injectable({ providedIn: 'root' })
class AngularConversationTimelineFactory implements ConversationTimelineFactory {
  private readonly parentInjector = inject(EnvironmentInjector);
  private readonly matrix = inject(MatrixClientService);
  private readonly actionContext = inject(ConversationActionContextService);

  create(key: ConversationKey): ConversationTimelineController {
    const client = this.matrix.clientFor(key.accountId);
    if (!client) {
      throw new Error('Conversation account is not live.');
    }
    const injector = createEnvironmentInjector(
      [TimelineService],
      this.parentInjector,
    );
    let timeline: TimelineService;
    try {
      timeline = injector.get(TimelineService);
      timeline.open(key.roomId, client);
    } catch (error: unknown) {
      injector.destroy();
      throw error;
    }
    let released = false;
    const resolveActionContext = () => timeline.openContext();
    return {
      timeline,
      setVisible: (visible) => {
        timeline.setVisible(visible);
        if (visible) {
          this.actionContext.bind(resolveActionContext);
        } else {
          this.actionContext.clear(resolveActionContext);
        }
      },
      resources: () => timeline.resources(),
      release: () => {
        if (released) return;
        released = true;
        this.actionContext.clear(resolveActionContext);
        try {
          timeline.close();
        } finally {
          injector.destroy();
        }
      },
    };
  }
}

export const CONVERSATION_TIMELINE_FACTORY =
  new InjectionToken<ConversationTimelineFactory>(
    'conversation-runtime.timeline-factory',
    {
      providedIn: 'root',
      factory: () => inject(AngularConversationTimelineFactory),
    },
  );

export const CONVERSATION_RETENTION_LIMIT = new InjectionToken<number>(
  'conversation-runtime.retained-handles-per-account',
  {
    providedIn: 'root',
    factory: () => CONVERSATION_RUNTIME_BASELINE.retainedHandlesPerAccount,
  },
);

interface ConversationEntry {
  readonly handle: ConversationHandle;
  readonly state: ReturnType<typeof signal<ConversationState>>;
  readonly controller: ConversationTimelineController;
  readonly composeController: ConversationComposeController;
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
  private readonly mediaPipeline = inject(MediaPipeline);
  private readonly retainedPerAccount = Math.max(
    0,
    inject(CONVERSATION_RETENTION_LIMIT),
  );
  private readonly destroyRef = inject(DestroyRef);
  private readonly entries = new Map<string, Map<string, ConversationEntry>>();
  private readonly composeSnapshots = new Map<
    string,
    ConversationComposeSnapshot
  >();
  private readonly focusedHandle = signal<ConversationHandle | null>(null);
  private readonly retiredHandles = signal(0);
  private readonly lastAttachDurationMs = signal<number | null>(null);
  private focusOrder = 0;

  constructor() {
    this.destroyRef.onDestroy(() => this.retireAll());
  }

  readonly focused = this.focusedHandle.asReadonly();
  readonly timeline = this.focusedTimeline();
  readonly compose = this.focusedCompose();
  readonly media = this.focusedMedia();
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
    entry.composeController.stopTyping();
    entry.controller.setVisible(false);
    this.evictRetained(handle.key.accountId);
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
    const draftKey = composeDraftKey(immutableKey);
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
    const handle = Object.freeze({
      key: immutableKey,
      state: state.asReadonly(),
      timeline: controller.timeline,
      compose: composeController.compose,
      media: Object.freeze({
        send: (media: StagedMediaReference, caption: string) =>
          defer(() =>
            this.mediaPipeline.transfer({
              key: immutableKey,
              media,
              caption,
            }),
          ),
      }),
    });
    const entry: ConversationEntry = {
      handle,
      state,
      controller,
      composeController,
      lastFocused: 0,
    };
    const account = this.entries.get(key.accountId) ?? new Map();
    account.set(key.roomId, entry);
    this.entries.set(key.accountId, account);
    return entry;
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

    // Before Conversation Runtime, the main composer persisted by Room only. Let the first
    // exact Account-and-Room handle claim that legacy draft, then remove the ambiguous key so
    // another Account in the same Room cannot inherit it.
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
      setTyping: (typing, owner) =>
        focused()?.timeline.setTyping(typing, owner),
      rawEvent: (roomId, eventId) =>
        focused()?.timeline.rawEvent(roomId, eventId) ?? null,
      reactionDetails: (eventId) =>
        focused()?.timeline.reactionDetails(eventId) ?? [],
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
      beginReply: (eventId) => focused()?.compose.beginReply(eventId),
      beginEdit: (eventId, draft) =>
        focused()?.compose.beginEdit(eventId, draft),
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
      this.retire(retained.shift()!);
    }
  }

  private retire(entry: ConversationEntry): void {
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
    entry.composeController.stopTyping();
    this.retiredHandles.update((count) => count + 1);
    entry.controller.release();
  }
}
