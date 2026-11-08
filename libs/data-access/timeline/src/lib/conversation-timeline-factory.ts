import {
  EnvironmentInjector,
  Injectable,
  InjectionToken,
  type Signal,
  createEnvironmentInjector,
  inject,
} from '@angular/core';
import type { Observable } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ConversationActionContextService } from './conversation-action-context.service';
import type { ConversationKey } from './conversation-messages';
import { ConversationTimelineReadiness } from './conversation-timeline-readiness';
import { TimelineService } from './timeline.service';
import { ThreadsService } from './threads.service';
import { ConversationPinsController } from './conversation-pins.controller';
import { ConversationSearchController } from './conversation-search.service';
import {
  TRIM_CEILING,
  TRIM_HIGH_WATER,
  trimLiveTimeline,
  type TrimGuard,
} from './live-timeline-trim';

export type ConversationTimeline = Pick<
  TimelineService,
  | 'messages'
  | 'loadingOlder'
  | 'canLoadOlder'
  | 'oldestEventId'
  | 'typingNames'
  | 'canRedactOthers'
  | 'canSendMessages'
  | 'tombstone'
  | 'firstUnreadId'
  | 'openRoomId'
  | 'roomEncrypted'
  | 'loadOlder'
  | 'jumpToDate'
  | 'loadEvent'
  | 'setTyping'
  | 'rawEvent'
  | 'roomVia'
  | 'reactionDetails'
  | 'loadState'
  | 'retryLoad'
  | 'setLiveView'
>;

export type ConversationSearch = Pick<
  ConversationSearchController,
  'searchLoaded' | 'searchServer' | 'loadOlder'
>;

export interface ConversationResources {
  readonly listenerCount: number;
  readonly retainedBytes: number;
}

export type ConversationClientStatus = 'attached' | 'removed' | 'replaced';

export interface ConversationTimelineController {
  readonly timeline: ConversationTimeline;
  readonly threads: ThreadsService;
  readonly pins: ConversationPinsController;
  readonly search: ConversationSearch;
  setVisible(visible: boolean): void;
  release(): void;
  /**
   * Trim the room's SDK live timeline back to its latest events once the handle is
   * released, so the history it paged in or received is freed until it is paged in again.
   */
  releaseHistory(): void;
  /**
   * While the room is focused: trim its SDK live timeline like a room nobody has open, but
   * only while its view follows the newest message, never past what that view shows, and
   * keeping what `guard` names as well. While the window is hidden that is once it passes
   * {@link TRIM_HIGH_WATER} events; while `shown`, once it passes {@link TRIM_CEILING},
   * keeping what is marked too.
   */
  trimFocused(guard: TrimGuard, shown: boolean): void;
  /** See {@link TimelineService.liveSettled}. */
  readonly liveSettled: Signal<boolean>;
  /** Page the room back in after its live timeline was rewound; see {@link TimelineService.refill}. */
  refill(depth: number): Observable<void>;
  resources(): ConversationResources;
  /**
   * The account's client now: the one this controller attached to, none, or another one,
   * as after signing out and in again.
   */
  clientStatus(): ConversationClientStatus;
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
      [
        TimelineService,
        ConversationTimelineReadiness,
        ThreadsService,
        ConversationPinsController,
        ConversationSearchController,
      ],
      this.parentInjector,
    );
    let timeline: TimelineService;
    let readiness: ConversationTimelineReadiness;
    let threads: ThreadsService;
    let pins: ConversationPinsController;
    let search: ConversationSearchController;
    try {
      timeline = injector.get(TimelineService);
      readiness = injector.get(ConversationTimelineReadiness);
      threads = injector.get(ThreadsService);
      pins = injector.get(ConversationPinsController);
      search = injector.get(ConversationSearchController);
      readiness.start(key.roomId, client, timeline);
      threads.attach(key, client);
      pins.attach(key, client);
      search.attach(key, client);
    } catch (error: unknown) {
      injector.destroy();
      throw error;
    }
    let released = false;
    const resolveActionContext = () => timeline.openContext();
    return {
      timeline,
      threads,
      pins,
      search,
      refill: (depth) => timeline.refill(depth),
      clientStatus: () => {
        const current = this.matrix.clientFor(key.accountId);
        if (current === client) return 'attached';
        return current ? 'replaced' : 'removed';
      },
      setVisible: (visible) => {
        timeline.setVisible(visible);
        // After the timeline: loadOlder() no-ops while hidden, so readiness must resume second.
        readiness.setVisible(visible);
        if (visible) {
          // Retained Conversations keep only the bounded main timeline warm. Thread
          // summaries and pins re-read SDK-authoritative state when focus returns;
          // their potentially room-sized projections never enter the retained budget.
          threads.attach(key, client);
          pins.attach(key, client);
          search.attach(key, client);
          this.actionContext.bind(resolveActionContext);
        } else {
          this.actionContext.clear(resolveActionContext);
          threads.closeThread();
          threads.close();
          pins.release();
          search.release();
        }
      },
      resources: () => {
        const timelineResources = timeline.resources();
        const threadResources = threads.resources();
        const pinResources = pins.resources();
        return {
          listenerCount:
            timelineResources.listenerCount +
            threadResources.listenerCount +
            pinResources.listenerCount,
          retainedBytes:
            timelineResources.retainedBytes +
            threadResources.retainedBytes +
            pinResources.retainedBytes,
        };
      },
      release: () => {
        if (released) return;
        released = true;
        this.actionContext.clear(resolveActionContext);
        try {
          readiness.stop();
          threads.closeThread();
          threads.close();
          pins.release();
          search.release();
          timeline.close();
        } finally {
          injector.destroy();
        }
      },
      releaseHistory: () => {
        // Only on the client this handle was opened with, and only while it is still the
        // Account's live client: a signed-out or restarted Account keeps no history here.
        const room = client.getRoom(key.roomId);
        const userId = client.getUserId();
        if (
          released &&
          room &&
          userId &&
          this.matrix.clientFor(key.accountId) === client
        ) {
          trimLiveTimeline(room, userId);
        }
      },
      liveSettled: timeline.liveSettled,
      trimFocused: (extra, shown) => {
        const room = client.getRoom(key.roomId);
        const userId = client.getUserId();
        if (
          released ||
          !room ||
          !userId ||
          this.matrix.clientFor(key.accountId) !== client ||
          room.getLiveTimeline().getEvents().length <=
            (shown ? TRIM_CEILING : TRIM_HIGH_WATER)
        ) {
          return;
        }
        const guard = timeline.liveTrimGuard();
        if (!guard) return;
        const marked = [...(guard.marked ?? []), ...(extra.marked ?? [])];
        const kept = [...(guard.kept ?? []), ...(extra.kept ?? [])];
        // On screen, a quote whose target went would lose its preview, and the divider
        // and its jump pill their anchor, so what is marked stays past the ceiling too.
        trimLiveTimeline(
          room,
          userId,
          shown ? { kept: [...kept, ...marked] } : { marked, kept },
        );
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
