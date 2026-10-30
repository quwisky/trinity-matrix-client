import { Observable } from 'rxjs';
import type { SessionEngine } from './session-engine';

/**
 * Holds back the hard-logout wipe for one account while a deletion request is in flight:
 * a non-soft `M_UNKNOWN_TOKEN` then only stops the client and is recorded.
 */
export interface ServerLogoutHold {
  /** Whether the server revoked the account's token while held. */
  readonly tokenDied: () => boolean;
  /** False once released, or once the account left this device and took its holds with it. */
  readonly isHeld: () => boolean;
  /**
   * `deleted: true` hands what follows to the deletion cleanup; `deleted: false` replays a
   * recorded logout through the ordinary hard path.
   */
  release(outcome: { readonly deleted: boolean }): void;
}

/**
 * Takes a {@link SessionEngine.holdServerLogout} hold and emits its handle once the engine
 * reports it in place. The hold outlives this observable: it ends with `release` or when
 * the account leaves. Facts reach the handle and the callbacks as soon as the engine
 * reports them, so a dead token is known before the request that met it settles.
 */
export function serverLogoutHold(
  engine: SessionEngine,
  accountId: string,
  callbacks: {
    readonly onTokenDied?: () => void;
    readonly onSignedInAgain?: () => void;
  } = {},
): Observable<ServerLogoutHold> {
  return new Observable<ServerLogoutHold>((subscriber) => {
    let holdId: string | null = null;
    let confirmed = false;
    let died = false;
    let held = true;
    const handle: ServerLogoutHold = {
      tokenDied: () => died,
      isHeld: () => held,
      release: ({ deleted }) => {
        if (holdId === null) return;
        const id = holdId;
        holdId = null;
        held = false;
        // The engine completes the hold's stream.
        engine.releaseServerLogoutHold(id, deleted).subscribe();
      },
    };
    const updates = engine.holdServerLogout(accountId).subscribe({
      next: (update) => {
        switch (update.kind) {
          case 'held':
            holdId = update.holdId;
            died = update.tokenDied;
            confirmed = true;
            subscriber.next(handle);
            subscriber.complete();
            return;
          case 'token-died':
            died = true;
            callbacks.onTokenDied?.();
            return;
          case 'token-renewed':
            died = false;
            return;
          case 'signed-in-again':
            callbacks.onSignedInAgain?.();
            return;
          case 'released':
            held = false;
            return;
        }
      },
      error: (error: unknown) => {
        held = false;
        subscriber.error(error);
      },
      complete: () => (held = false),
    });
    // Dropped before the engine confirmed it: nobody could release this hold.
    return () => {
      if (!confirmed) updates.unsubscribe();
    };
  });
}
