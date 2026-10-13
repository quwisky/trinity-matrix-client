import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Observable, Subject, defer, from, of, take } from 'rxjs';
import {
  SESSION_CHANNEL_FACTORY,
  SESSION_HANDOVER_TIMEOUT_MS,
  SESSION_LOCK_NAME,
  SESSION_LOCK_REQUIRED,
  SESSION_LOCKS,
  type SessionChannel,
  type SessionHandoverRequest,
  type SessionLockAcquisition,
  type SessionLockState,
  type SessionLocks,
} from './session-lock.tokens';

/**
 * One running Trinity per browser profile and origin (#1267). The tab holding the
 * `trinity-session` Web Lock runs the Matrix clients and crypto stores; every other tab waits
 * in the lock's queue and can ask the holder, on the `trinity-session` channel, to hand over.
 * Root-provided, so it lives as long as the page. The lock is never handed back early: the
 * browser frees it when the page goes, closed, crashed or restarted after a handover.
 */
@Injectable({ providedIn: 'root' })
export class SessionLockService {
  private readonly locks = inject(SESSION_LOCKS);
  private readonly required = inject(SESSION_LOCK_REQUIRED);
  private readonly openChannel = inject(SESSION_CHANNEL_FACTORY);
  private readonly lockState = signal<SessionLockState>('acquiring');
  private readonly grants = new Subject<void>();
  private readonly requests = new Subject<void>();
  private firstAttempt: Promise<SessionLockAcquisition> | null = null;
  private channel: SessionChannel | null = null;
  private releaseHeld: (() => void) | null = null;
  private queued = false;
  private readonly teardown = new AbortController();
  private handoverTimer: ReturnType<typeof setTimeout> | null = null;

  readonly state = this.lockState.asReadonly();
  /**
   * Another tab's "Use here". Emits only in the holding tab, which is then `releasing` until
   * its restart unloads the page and so frees the lock.
   */
  readonly handoverRequests: Observable<void> = this.requests.asObservable();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      // Withdraw a queued request, so a later release by another tab grants nothing here.
      this.teardown.abort();
      this.grants.complete();
      this.requests.complete();
      this.clearHandoverTimer();
      this.channel?.close();
      this.channel = null;
      this.releaseHeld?.();
      this.releaseHeld = null;
    });
  }

  /**
   * Claim the session for this tab: `held` when no other tab has it, `waiting` (and queued)
   * when one does. Cold; the browser is asked once, and later calls answer from the state.
   */
  acquire(): Observable<SessionLockAcquisition> {
    return defer(() => {
      const state = this.lockState();
      switch (state) {
        case 'acquiring':
          this.firstAttempt ??= this.tryAcquire();
          return from(this.firstAttempt);
        case 'held':
        case 'unavailable':
        case 'not-required':
          return of(state);
        case 'waiting':
        case 'taking-over':
        case 'handover-timed-out':
        case 'releasing':
          return of('waiting' as const);
        default: {
          const unhandled: never = state;
          void unhandled;
          return of('unavailable' as const);
        }
      }
    });
  }

  /**
   * Emits once, when this tab holds the lock (at once if it already does), whether it got it
   * straight away or after waiting. Never emits where the lock is `not-required` or
   * `unavailable`; completes when the service is destroyed.
   */
  granted(): Observable<void> {
    return defer(() =>
      this.lockState() === 'held' ? of(undefined) : this.grants.pipe(take(1)),
    );
  }

  /**
   * "Use here": ask the holder to hand over; offers "Try again" after 15 seconds. Queues again
   * first if the browser dropped this tab's request from the queue.
   */
  requestHandover(): void {
    const state = this.lockState();
    if (state !== 'waiting' && state !== 'handover-timed-out') return;
    if (this.teardown.signal.aborted) return;
    if (this.locks) this.queue(this.locks);
    const request: SessionHandoverRequest = {
      type: 'handover-request',
      id: crypto.randomUUID(),
    };
    this.ensureChannel()?.postMessage(request);
    this.lockState.set('taking-over');
    this.clearHandoverTimer();
    this.handoverTimer = setTimeout(() => {
      this.handoverTimer = null;
      if (this.lockState() === 'taking-over') {
        this.lockState.set('handover-timed-out');
      }
    }, SESSION_HANDOVER_TIMEOUT_MS);
  }

  private async tryAcquire(): Promise<SessionLockAcquisition> {
    if (!this.required) {
      this.lockState.set('not-required');
      return 'not-required';
    }
    const locks = this.locks;
    if (!locks) {
      this.lockState.set('unavailable');
      return 'unavailable';
    }
    let granted: boolean;
    try {
      granted = await this.request(locks, {
        mode: 'exclusive',
        ifAvailable: true,
      });
    } catch {
      this.lockState.set('unavailable');
      return 'unavailable';
    }
    if (granted) {
      this.becomeHolder();
      this.grants.next();
      return 'held';
    }
    this.lockState.set('waiting');
    this.queue(locks);
    return 'waiting';
  }

  /** Wait in the lock's queue; on the grant this tab holds the lock and startup may go on. */
  private queue(locks: SessionLocks): void {
    if (this.queued) return;
    this.queued = true;
    void this.request(locks, {
      mode: 'exclusive',
      signal: this.teardown.signal,
    }).then(
      (granted) => {
        this.queued = false;
        if (!granted) return;
        this.becomeHolder();
        this.grants.next();
      },
      () => {
        // Aborted on destroy: nothing is waiting any more.
        if (this.teardown.signal.aborted) return;
        // The browser dropped the queued request although this context has Web Locks: not
        // the secure-connection case. Offer "Try again", which queues again.
        this.queued = false;
        this.clearHandoverTimer();
        this.lockState.set('handover-timed-out');
      },
    );
  }

  /**
   * Resolves `true` once the lock is granted, and keeps it for the life of the page; `false`
   * when `ifAvailable` found it taken. Rejects when the browser refuses the request.
   */
  private request(locks: SessionLocks, options: LockOptions): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      locks
        .request(SESSION_LOCK_NAME, options, (lock) => {
          if (!lock) {
            resolve(false);
            return undefined;
          }
          resolve(true);
          // Held until the page goes; resolved early only when the root injector is destroyed.
          return new Promise<void>((releaseHeld) => {
            this.releaseHeld = () => releaseHeld();
          });
        })
        .catch(reject);
    });
  }

  private becomeHolder(): void {
    this.clearHandoverTimer();
    this.lockState.set('held');
    this.ensureChannel();
  }

  private ensureChannel(): SessionChannel | null {
    if (!this.channel) {
      const channel = this.openChannel();
      if (channel) {
        channel.onmessage = (event) => this.onMessage(event.data);
      }
      this.channel = channel;
    }
    return this.channel;
  }

  /** Only the holder acts, once, and only while someone will carry the handover out. */
  private onMessage(data: unknown): void {
    if (
      !isHandoverRequest(data) ||
      this.lockState() !== 'held' ||
      !this.requests.observed
    ) {
      return;
    }
    this.lockState.set('releasing');
    this.requests.next();
  }

  private clearHandoverTimer(): void {
    if (this.handoverTimer !== null) {
      clearTimeout(this.handoverTimer);
      this.handoverTimer = null;
    }
  }
}

function isHandoverRequest(data: unknown): data is SessionHandoverRequest {
  if (typeof data !== 'object' || data === null) return false;
  const message = data as { readonly type?: unknown; readonly id?: unknown };
  return message.type === 'handover-request' && typeof message.id === 'string';
}
