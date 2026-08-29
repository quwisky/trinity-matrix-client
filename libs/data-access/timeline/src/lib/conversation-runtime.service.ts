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
import { defer, of } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ConversationActionContextService } from './conversation-action-context.service';
import { TimelineService } from './timeline.service';

export const CONVERSATION_RUNTIME_BASELINE = {
  retainedHandlesPerAccount: 2,
} as const;

export interface ConversationKey {
  readonly accountId: string;
  readonly roomId: string;
}

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
  private readonly retainedPerAccount = Math.max(
    0,
    inject(CONVERSATION_RETENTION_LIMIT),
  );
  private readonly destroyRef = inject(DestroyRef);
  private readonly entries = new Map<string, Map<string, ConversationEntry>>();
  private readonly focusedHandle = signal<ConversationHandle | null>(null);
  private readonly retiredHandles = signal(0);
  private readonly lastAttachDurationMs = signal<number | null>(null);
  private focusOrder = 0;

  constructor() {
    this.destroyRef.onDestroy(() => this.retireAll());
  }

  readonly focused = this.focusedHandle.asReadonly();
  readonly timeline = this.focusedTimeline();
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
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Conversation retirement failed.');
    }
  }

  private create(key: ConversationKey): ConversationEntry {
    const immutableKey = Object.freeze({ ...key });
    const startedAt = performance.now();
    const controller = this.factory.create(immutableKey);
    this.lastAttachDurationMs.set(performance.now() - startedAt);
    const state = signal<ConversationState>('retained');
    const handle = Object.freeze({
      key: immutableKey,
      state: state.asReadonly(),
      timeline: controller.timeline,
    });
    const entry: ConversationEntry = {
      handle,
      state,
      controller,
      lastFocused: 0,
    };
    const account = this.entries.get(key.accountId) ?? new Map();
    account.set(key.roomId, entry);
    this.entries.set(key.accountId, account);
    return entry;
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
    this.retiredHandles.update((count) => count + 1);
    entry.controller.release();
  }
}
