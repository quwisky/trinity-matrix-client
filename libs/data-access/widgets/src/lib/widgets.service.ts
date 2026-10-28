import {
  Injector,
  Injectable,
  type Signal,
  type WritableSignal,
  computed,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { plainEqual } from '@trinity/util/matrix';
import {
  type Subscription,
  distinctUntilChanged,
  startWith,
  switchMap,
  take,
} from 'rxjs';
import type { RoomWidgetSnapshot, WidgetIdentity } from './room-widget-engine';
import { ROOM_WIDGET_ENGINE } from './room-widget-engine.token';
import { WIDGET_APPEARANCE_PROJECTION } from './widget-appearance-projection';
import type {
  RoomWidget,
  RoomWidgetTarget,
  WidgetLaunch,
  WidgetTemplateContext,
} from './widget.model';
import { resolveWidgetLaunch } from './widget-template';

const TRINITY_WIDGET_CLIENT_ID = 'dev.trinityproject.trinity';

interface WatchedRoom {
  readonly target: RoomWidgetTarget;
  readonly state: WritableSignal<readonly RoomWidget[]>;
  readonly canManage: WritableSignal<boolean>;
  readonly identity: WritableSignal<WidgetIdentity | null>;
  consumers: number;
  subscription: Subscription | null;
}

/**
 * Demand-driven projection of the widgets declared in rooms whose settings dialog has
 * asked for them. Tier 1 deliberately stops at discovery and an external browser link —
 * no iframe, postMessage bridge, decrypted events, or widget writes live here.
 */
@Injectable({ providedIn: 'root' })
export class WidgetsService {
  private readonly engine = inject(ROOM_WIDGET_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly appearance = inject(WIDGET_APPEARANCE_PROJECTION);
  private readonly injector = inject(Injector);
  private readonly watched = new Map<string, WatchedRoom>();

  /**
   * Widgets currently declared in one room. The signal is memoized and synchronously
   * seeded, so the dialog does not flash an empty state before its first render.
   */
  widgetsFor(target: RoomWidgetTarget): Signal<readonly RoomWidget[]> {
    return this.watchedRoom(target).state.asReadonly();
  }

  /** Live management authorization for the exact Account in one watched Room. */
  canManageFor(target: RoomWidgetTarget): Signal<boolean> {
    return this.watchedRoom(target).canManage.asReadonly();
  }

  /** Acquire one exact target and subscribe to its widgets for the first consumer. */
  connect(target: RoomWidgetTarget): void {
    const watched = this.watchedRoom(target);
    watched.consumers += 1;
    if (watched.consumers > 1) return;
    const { accountId, roomId } = watched.target;
    // A new client for the exact Account restarts the subscription; the active Account
    // is never followed.
    const generation = computed(
      () => this.session.status(accountId)?.generation ?? null,
    );
    watched.subscription = toObservable(generation, { injector: this.injector })
      .pipe(
        startWith(untracked(generation)),
        distinctUntilChanged(),
        switchMap(() => this.engine.roomWidgets(accountId, roomId)),
      )
      .subscribe((snapshot) => apply(watched, snapshot));
  }

  /** Release one consumer without disrupting another settings view of this target. */
  disconnect(target: RoomWidgetTarget): void {
    const key = targetKey(target);
    const watched = this.watched.get(key);
    if (!watched) {
      return;
    }
    watched.consumers = Math.max(0, watched.consumers - 1);
    if (watched.consumers > 0) {
      return;
    }
    watched.subscription?.unsubscribe();
    watched.subscription = null;
    watched.state.set([]);
    watched.canManage.set(false);
    this.watched.delete(key);
  }

  /** Expand a destination using the immutable opening Account and current client UI. */
  launchFor(target: RoomWidgetTarget, widget: RoomWidget): WidgetLaunch {
    return resolveWidgetLaunch(widget, this.templateContext(target));
  }

  private watchedRoom(target: RoomWidgetTarget): WatchedRoom {
    const key = targetKey(target);
    let watched = this.watched.get(key);
    if (!watched) {
      const stableTarget = { ...target };
      const seed = this.currentSnapshot(stableTarget);
      watched = {
        target: stableTarget,
        state: signal<readonly RoomWidget[]>(seed.widgets, {
          equal: plainEqual,
        }),
        canManage: signal(seed.canManage),
        identity: signal(seed.identity, { equal: plainEqual }),
        consumers: 0,
        subscription: null,
      };
      this.watched.set(key, watched);
    }
    return watched;
  }

  /** The engine's first snapshot, which a js-sdk engine emits synchronously. */
  private currentSnapshot(target: RoomWidgetTarget): RoomWidgetSnapshot {
    let snapshot: RoomWidgetSnapshot = {
      widgets: [],
      canManage: false,
      identity: null,
    };
    this.engine
      .roomWidgets(target.accountId, target.roomId)
      .pipe(take(1))
      .subscribe((first) => (snapshot = first));
    return snapshot;
  }

  private templateContext(target: RoomWidgetTarget): WidgetTemplateContext {
    const watched = this.watched.get(targetKey(target));
    const identity = watched
      ? watched.identity()
      : this.currentSnapshot(target).identity;
    const userId = identity?.userId ?? target.accountId;
    return {
      roomId: target.roomId,
      userId,
      displayName: identity?.displayName ?? userId,
      avatarUrl: identity?.avatarUrl ?? '',
      clientId: TRINITY_WIDGET_CLIENT_ID,
      theme: this.appearance.resolved()?.mode ?? 'dark',
      language: typeof navigator === 'undefined' ? '' : navigator.language,
      deviceId: identity?.deviceId ?? '',
      baseUrl: identity?.homeserverUrl ?? '',
    };
  }
}

function apply(watched: WatchedRoom, snapshot: RoomWidgetSnapshot): void {
  watched.state.set(snapshot.widgets);
  watched.canManage.set(snapshot.canManage);
  watched.identity.set(snapshot.identity);
}

function targetKey(target: RoomWidgetTarget): string {
  return `${target.accountId.length}:${target.accountId}${target.roomId}`;
}
