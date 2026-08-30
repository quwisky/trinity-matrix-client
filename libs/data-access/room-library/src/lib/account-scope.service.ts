import { Injectable, computed, inject, signal } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { DevicePreferenceStorageService } from '@trinity/platform-native';
import { Observable, catchError, defer, map, of, tap } from 'rxjs';

/** Persisted set of account ids the user has opted into mixing. */
const SCOPE_KEY = 'trinity.accounts.mixed';

/** Whether two id sets hold the same members (order-independent). */
export function sameAccountSet(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): boolean {
  if (a === b) {
    return true;
  }
  if (a.size !== b.size) {
    return false;
  }
  for (const id of a) {
    if (!b.has(id)) {
      return false;
    }
  }
  return true;
}

/**
 * Which signed-in accounts the room list, rail and space pills draw from — the user's
 * mixed-account selection.
 *
 * The **active** account is always included: it is the one every action runs as (sending,
 * creating rooms, receipts), so hiding its rooms while still posting as it would be
 * incoherent, and it rules out an empty selection. Everything else is opt-in.
 *
 * The stored selection is kept raw and intersected with the live accounts on read, so an
 * account that is signed out simply stops contributing (and returns to the mix if it is
 * added back) rather than being silently forgotten mid-session. Stale ids are deliberately
 * NOT pruned on write — a soft-logged-out account is absent from `accountIds()`, and
 * dropping it there would discard the user's pick for good.
 */
@Injectable({ providedIn: 'root' })
export class AccountScopeService {
  private readonly matrix = inject(MatrixClientService);
  private readonly storage = inject(DevicePreferenceStorageService);

  /** Raw persisted selection; may name accounts that aren't signed in right now. */
  private readonly stored = signal<ReadonlySet<string>>(new Set());

  /**
   * The accounts actually shown: the stored selection ∩ signed-in accounts, plus the active
   * account. Carries a set-equality check so a recompute that yields the same members does
   * not churn its consumers — the projections below re-attach per-account listeners on every
   * emission, and the badge lookup is rebuilt from it.
   */
  readonly selected = computed<ReadonlySet<string>>(
    () => {
      const live = new Set(this.matrix.accountIds());
      const shown = new Set<string>();
      for (const id of this.stored()) {
        if (live.has(id)) {
          shown.add(id);
        }
      }
      const active = this.matrix.activeUserId();
      if (active) {
        shown.add(active);
      }
      return shown;
    },
    { equal: sameAccountSet },
  );

  /** Whether more than one account is being mixed (one account = the plain single view). */
  readonly mixing = computed(() => this.selected().size > 1);

  /** Restore the saved selection. Wired as an app initializer at startup. */
  init(): Observable<void> {
    return this.storage.get(SCOPE_KEY).pipe(
      tap((value) => {
        const parsed: unknown = value ? JSON.parse(value) : null;
        if (Array.isArray(parsed)) {
          this.stored.set(
            new Set(
              parsed.filter((id): id is string => typeof id === 'string'),
            ),
          );
        }
      }),
      map(() => void 0),
      // Absent, unavailable or corrupt → start with just the active account.
      catchError(() => of(void 0)),
    );
  }

  /** Whether an account is currently included in the view. */
  isSelected(userId: string): boolean {
    return this.selected().has(userId);
  }

  /**
   * Include or exclude an account. The active account is always shown, so a request to drop
   * it is ignored rather than producing a view that hides the account you're acting as.
   *
   * Including an account also *materialises* the current active account into the stored set.
   * The active account is only unioned in at read time, so without this the mix would
   * collapse the moment you used it: opening a mixed-in account's room switches to that
   * account, and the account you were mixing *from* — never stored, only implied — would
   * drop straight back out.
   */
  setSelected(userId: string, included: boolean): Observable<void> {
    return defer(() => {
      const active = this.matrix.activeUserId();
      if (!included && userId === active) {
        return of(void 0);
      }
      const next = new Set(this.stored());
      if (included) {
        next.add(userId);
        if (active) {
          next.add(active);
        }
      } else {
        next.delete(userId);
        // Turning the mix off must clear the stored active account too. Leaving it behind
        // means the set is still "one explicit member", so the next time the user switches
        // accounts that member plus the new active account would silently re-enable mixing.
        if (active && next.size === 1 && next.has(active)) {
          next.clear();
        }
      }
      if (sameAccountSet(next, this.stored())) {
        return of(void 0);
      }
      this.stored.set(next);
      return this.persist(next);
    });
  }

  /** Flip an account's inclusion (the picker's checkbox). */
  toggle(userId: string): Observable<void> {
    return defer(() => this.setSelected(userId, !this.isSelected(userId)));
  }

  /**
   * Write the selection back verbatim. Deliberately *not* pruned against the live accounts:
   * an account that is soft-logged-out (revoked token) or still starting up is absent from
   * `accountIds()`, and pruning here would silently discard the user's pick the next time
   * they touched the picker — losing it for good on the next launch. Stale ids are inert
   * anyway, since {@link selected} intersects with the live accounts on read, and the set is
   * bounded by the number of accounts the user has ever mixed.
   */
  private persist(selection: ReadonlySet<string>): Observable<void> {
    return this.storage
      .set(SCOPE_KEY, JSON.stringify([...selection]))
      .pipe(map(() => void 0));
  }
}
