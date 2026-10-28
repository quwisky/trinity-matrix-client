import {
  EnvironmentInjector,
  Injectable,
  InjectionToken,
  type Signal,
  createEnvironmentInjector,
  inject,
} from '@angular/core';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { ConversationActionContextService } from './conversation-action-context.service';
import type { ConversationKey } from './conversation-messages';
import { ConversationTimelineReadiness } from './conversation-timeline-readiness';
import { TimelineService } from './timeline.service';
import { ThreadsService } from './threads.service';
import { ConversationPinsController } from './conversation-pins.controller';
import { ConversationSearchController } from './conversation-search.service';
import type { TrimGuard } from './js-sdk/live-timeline-trim';

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
  | 'eventSource'
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
  /** What a trim of the room must keep while its view follows the newest message, else null. */
  readonly liveTrimGuard: Signal<TrimGuard | null>;
  resources(): ConversationResources;
}

export interface ConversationTimelineFactory {
  create(key: ConversationKey): ConversationTimelineController;
}

@Injectable({ providedIn: 'root' })
class AngularConversationTimelineFactory implements ConversationTimelineFactory {
  private readonly parentInjector = inject(EnvironmentInjector);
  private readonly session = inject(SessionStateService);
  private readonly actionContext = inject(ConversationActionContextService);

  create(key: ConversationKey): ConversationTimelineController {
    if (!this.session.status(key.accountId)) {
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
      timeline.open(key);
      readiness.start(key, timeline);
      threads.attach(key);
      pins.attach(key);
      search.attach(key);
    } catch (error: unknown) {
      injector.destroy();
      throw error;
    }
    let released = false;
    const resolveActionContext = () => key;
    return {
      timeline,
      threads,
      pins,
      search,
      liveTrimGuard: timeline.liveTrimGuard,
      setVisible: (visible) => {
        timeline.setVisible(visible);
        // After the timeline: loadOlder() no-ops while hidden, so readiness must resume second.
        readiness.setVisible(visible);
        if (visible) {
          // Retained Conversations keep only the bounded main timeline warm. Thread
          // summaries and pins re-read SDK-authoritative state when focus returns;
          // their potentially room-sized projections never enter the retained budget.
          threads.attach(key);
          pins.attach(key);
          search.attach(key);
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
