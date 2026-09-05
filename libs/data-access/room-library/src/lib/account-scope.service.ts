import {
  Injectable,
  computed,
  inject,
  type EnvironmentProviders,
} from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  INSTALLATION_PREFERENCE_CONTEXT,
  PreferenceStoreService,
  definePreference,
  providePreferenceDescriptors,
  type PreferenceCommandOutcome,
  type PreferenceDescriptor,
  type PreferenceFailure,
  type PreferenceHydrationOutcome,
  type PreferenceValidation,
  type StoredPreference,
} from '@trinity/runtime/preferences';
import { Observable, defer, of } from 'rxjs';

/** Persisted set of account ids the user has opted into mixing. */
const SCOPE_KEY = 'trinity.accounts.mixed';

type AccountScopePreference = readonly string[];

/** Capability-owned policy for the device-local selected Account set. */
export const ACCOUNT_SCOPE_PREFERENCE = definePreference({
  id: 'room-library.selected-accounts',
  owner: 'room-library',
  section: 'room-library',
  order: 10,
  scope: 'installation',
  defaultValue: [],
  sensitivity: 'private',
  storage: 'device-preferences',
  export: 'excluded',
  editor: { kind: 'none' },
  persistence: {
    key: SCOPE_KEY,
    migration: {
      currentVersion: 1,
      migrate: validateAccountScopePreference,
    },
  },
  validate: validateAccountIds,
} satisfies PreferenceDescriptor<AccountScopePreference>);

/** Contributes Room Library's selection policy to the application preference catalog. */
export function provideRoomLibraryPreferences(): EnvironmentProviders {
  return providePreferenceDescriptors(() => [ACCOUNT_SCOPE_PREFERENCE]);
}

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
  private readonly preferences = inject(PreferenceStoreService);
  private readonly persisted = this.preferences.stateFor(
    ACCOUNT_SCOPE_PREFERENCE,
    INSTALLATION_PREFERENCE_CONTEXT,
  );

  /** Raw persisted selection; may name accounts that aren't signed in right now. */
  private readonly stored = computed<ReadonlySet<string>>(
    () => new Set(this.persisted().value),
    { equal: sameAccountSet },
  );

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
  init(): Observable<PreferenceHydrationOutcome> {
    return this.preferences.hydrateDescriptors(
      INSTALLATION_PREFERENCE_CONTEXT,
      [ACCOUNT_SCOPE_PREFERENCE],
    );
  }

  recoverHydration(
    failures: readonly PreferenceFailure[],
  ): Observable<PreferenceHydrationOutcome> {
    return this.preferences.recoverHydration(
      INSTALLATION_PREFERENCE_CONTEXT,
      failures,
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
  setSelected(
    userId: string,
    included: boolean,
  ): Observable<PreferenceCommandOutcome> {
    return defer(() => {
      const active = this.matrix.activeUserId();
      if (!included && userId === active) {
        return of({ kind: 'completed' } as const);
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
        return of({ kind: 'completed' } as const);
      }
      return this.preferences.setPreference(
        ACCOUNT_SCOPE_PREFERENCE,
        INSTALLATION_PREFERENCE_CONTEXT,
        [...next],
      );
    });
  }

  /** Flip an account's inclusion (the picker's checkbox). */
  toggle(userId: string): Observable<PreferenceCommandOutcome> {
    return defer(() => this.setSelected(userId, !this.isSelected(userId)));
  }
}

function validateAccountScopePreference(
  stored: StoredPreference,
): PreferenceValidation<AccountScopePreference> {
  if (stored.version === 0 && Array.isArray(stored.value)) {
    return {
      kind: 'accepted',
      value: [
        ...new Set(
          stored.value.filter((id): id is string => typeof id === 'string'),
        ),
      ],
    };
  }
  return stored.version === 1
    ? validateAccountIds(stored.value)
    : {
        kind: 'rejected',
        diagnostic: { code: 'room-library-account-scope-version-unsupported' },
      };
}

function validateAccountIds(
  value: unknown,
): PreferenceValidation<AccountScopePreference> {
  return isStringArray(value)
    ? { kind: 'accepted', value: [...new Set<string>(value)] }
    : {
        kind: 'rejected',
        diagnostic: { code: 'room-library-account-scope-invalid' },
      };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'string');
}
