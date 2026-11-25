import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  EMPTY,
  Observable,
  catchError,
  defer,
  finalize,
  from,
  switchMap,
  timeout,
} from 'rxjs';
import { callIntent, callWidgetUrl, hasOngoingCall } from './call-intent';
import type { CallTransport } from './call-transport';
import type { CallSession, CallSessionState } from './call-runtime';
import { matrixCallTransport } from './matrix-call-transport';

export interface ActiveCall {
  /** New for every started call, so a view can give each call its own frame. */
  readonly id: number;
  readonly roomId: string;
  readonly accountId: string;
  readonly widgetUrl: string;
  /** `ending`: hung up, and the hidden frame stays until Element Call has left the call. */
  readonly state: CallSessionState | 'ending';
}

interface Call {
  readonly id: number;
  readonly roomId: string;
  readonly accountId: string;
  readonly widgetUrl: string;
  readonly transport: CallTransport;
}

const CALL_WIDGET_ID = 'trinity-call';
const CALL_MEMBER_TYPE = 'org.matrix.msc3401.call.member';

// Same budget as the widget bridge: the runtime chunk is small, so this only trips on a dead network.
export const CALL_RUNTIME_LOAD_TIMEOUT_MS = 20_000;

/** Owns the one call that may be active app-wide, and ends it when the account changes. */
@Injectable({ providedIn: 'root' })
export class CallService {
  private readonly clients = inject(MatrixClientService);
  private readonly call = signal<Call | null>(null);
  private readonly session = signal<CallSession | null>(null);
  private readonly hungUp = new WeakSet<CallSession>();
  private readonly loadFailed = signal(false);
  private readonly ending = signal(false);
  /** A call started while the previous one was ending; it starts once that one has left. */
  private next: Call | null = null;
  private lastId = 0;

  readonly activeCall = computed<ActiveCall | null>(() => {
    const call = this.call();
    if (!call) return null;
    const { id, roomId, accountId, widgetUrl } = call;
    const state = this.ending()
      ? 'ending'
      : this.loadFailed()
        ? 'failed'
        : (this.session()?.state() ?? 'loading');
    return { id, roomId, accountId, widgetUrl, state };
  });

  constructor() {
    effect(() => {
      const accountId = this.clients.activeUserId();
      const call = this.call();
      if (call && call.accountId !== accountId) this.end();
    });
  }

  start(
    roomId: string,
    options: { video: boolean; dm: boolean; theme: 'light' | 'dark' },
  ): void {
    const accountId = this.clients.activeUserId();
    const client = accountId ? this.clients.clientFor(accountId) : null;
    if (!accountId || !client) return;
    this.end();
    const transport = matrixCallTransport(client, roomId);
    const ongoing = hasOngoingCall(
      transport.readState(CALL_MEMBER_TYPE),
      Date.now(),
    );
    const widgetUrl = callWidgetUrl({
      appOrigin: location.origin,
      widgetId: CALL_WIDGET_ID,
      roomId,
      userId: transport.userId,
      deviceId: transport.deviceId,
      homeserverUrl: transport.homeserverUrl,
      intent: callIntent({ dm: options.dm, ongoing, video: options.video }),
      theme: options.theme,
    });
    const call = { id: ++this.lastId, roomId, accountId, widgetUrl, transport };
    if (this.ending()) this.next = call;
    else this.call.set(call);
  }

  /**
   * Bind the call to `iframe`. Cold: subscribing lazy-loads the runtime and starts the
   * session; it completes when the call ends, and unsubscribing hangs up.
   */
  attach(iframe: HTMLIFrameElement): Observable<never> {
    return defer(() => {
      const call = this.call();
      if (!call || this.session()) return EMPTY;
      // Unsubscribing before the chunk lands leaves no session to hang up, so end the call here.
      let settled = false;
      return from(import('./call-runtime')).pipe(
        timeout(CALL_RUNTIME_LOAD_TIMEOUT_MS),
        switchMap(({ startCallSession }) => {
          settled = true;
          return new Observable<never>((subscriber) => {
            // A newer call, an account switch or a second attach got here first.
            if (
              this.call() !== call ||
              this.session() ||
              this.clients.activeUserId() !== call.accountId
            ) {
              subscriber.complete();
              return;
            }
            let ended = false;
            const session = startCallSession(
              call.transport,
              call.widgetUrl,
              CALL_WIDGET_ID,
              iframe,
              () => {
                ended = true;
                // A late end from a replaced session must not clear the newer call.
                if (this.call() === call) this.settle(session);
                subscriber.complete();
              },
            );
            this.session.set(session);
            return () => {
              if (ended) return;
              // shortcut: leaving the rooms page destroys the frame before Element Call can
              // leave the call, so its membership lingers until it expires; slice 2's
              // app-level call host keeps the frame mounted and removes this.
              this.hangUpOnce(session);
              if (this.call() === call) this.clear();
            };
          });
        }),
        catchError(() => {
          settled = true;
          if (this.call() === call) this.loadFailed.set(true);
          return EMPTY;
        }),
        finalize(() => {
          if (!settled && this.call() === call) this.end();
        }),
      );
    });
  }

  hangUp(): void {
    this.end();
  }

  /** Hang up, keeping a live session's frame until Element Call has left the call. */
  private end(): void {
    this.next = null;
    const session = this.session();
    const state = session?.state();
    if (session && (state === 'loading' || state === 'joined')) {
      this.ending.set(true);
      this.hangUpOnce(session);
    } else {
      this.clear();
    }
  }

  /** The session finished: keep a failure on screen until closed, else start any queued call. */
  private settle(session: CallSession): void {
    if (!this.ending() && session.state() === 'failed') return;
    const next = this.next;
    this.clear();
    if (next) this.call.set(next);
  }

  private hangUpOnce(session: CallSession): void {
    if (this.hungUp.has(session)) return;
    this.hungUp.add(session);
    session.hangUp();
  }

  private clear(): void {
    this.call.set(null);
    this.session.set(null);
    this.loadFailed.set(false);
    this.ending.set(false);
    this.next = null;
  }
}
