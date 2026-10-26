import {
  EnvironmentInjector,
  Injectable,
  InjectionToken,
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
   * While the window is hidden and the room stays focused: trim its SDK live timeline like
   * a room nobody has open once it passes {@link TRIM_HIGH_WATER} events, but only while
   * its view follows the newest message, never past what that view shows, and keeping
   * what `guard` names as well.
   */
  trimWhileHidden(guard: TrimGuard): void;
  /** Page the room back in after its live timeline was rewound; see {@link TimelineService.refill}. */
  refill(depth: number): Observable<void>;
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
      trimWhileHidden: (extra) => {
        const room = client.getRoom(key.roomId);
        const userId = client.getUserId();
        if (
          released ||
          !room ||
          !userId ||
          this.matrix.clientFor(key.accountId) !== client ||
          room.getLiveTimeline().getEvents().length <= TRIM_HIGH_WATER
        ) {
          return;
        }
        const guard = timeline.liveTrimGuard();
        if (!guard) return;
        trimLiveTimeline(room, userId, {
          marked: [...(guard.marked ?? []), ...(extra.marked ?? [])],
          kept: [...(guard.kept ?? []), ...(extra.kept ?? [])],
        });
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
