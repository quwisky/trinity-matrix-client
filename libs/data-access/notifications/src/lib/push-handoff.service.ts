import {
  ErrorHandler,
  Injectable,
  Injector,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import {
  SESSION_ENGINE,
  type SessionAccessToken,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import { plainEqual } from '@trinity/util/matrix';
import {
  PushHandoffBridge,
  type BackgroundWork,
  type PushHandoffAccount,
  type PushHandoffRoom,
} from '@trinity/capacitor-push';
import {
  Observable,
  Subject,
  Subscription,
  catchError,
  concat,
  defaultIfEmpty,
  defer,
  distinctUntilChanged,
  finalize,
  firstValueFrom,
  forkJoin,
  from,
  ignoreElements,
  lastValueFrom,
  map,
  of,
  switchMap,
  timeout,
} from 'rxjs';
import type { PushRoom } from './notification-engine';
import { NOTIFICATION_ENGINE } from './notification-engine.token';
import type { NotificationTextMode } from './notification-text.port';

/**
 * A token that rotated more recently than this is not refreshed again as the app goes to the
 * background: the refresh would add less than this to its life and cost a rotation.
 */
export const BACKGROUND_REFRESH_MIN_AGE_MS = 60_000;

/**
 * How long the background refresh waits for each account's refresh, and then for the store
 * writes they queued. A refresh the OS suspends mid-flight can hang: past this bound the
 * action completes without it, so the next background event refreshes again, while the
 * request itself stays with the SDK until its grant bound aborts it
 * ({@link BACKGROUND_REFRESH_GRANT_TIMEOUT_MS}, or the patched SDK's 30 s for a refresh
 * already in flight that the run joined). Half the roughly 30 s of background time iOS grants.
 */
export const BACKGROUND_REFRESH_TIMEOUT_MS = 15_000;

/**
 * When the token grant of each refresh the background run starts must have answered,
 * counted from the start of that refresh; past it the patched SDK aborts the grant, or never
 * sends it. iOS discards the key of keychain items readable only while unlocked, which hold
 * the session's tokens, about 10 s after the device locks; a refresh that has not saved its
 * tokens by then leaves the SDK on the spent pair. Every refresh starts before the run can
 * see a lock, so under this bound its grant answers inside that window. A grant aborted after
 * the server processed it still spends the refresh token.
 */
export const BACKGROUND_REFRESH_GRANT_TIMEOUT_MS = 8_000;

/**
 * When the whole background refresh run gives up, from asking for background time to
 * releasing it: the refresh bound and the write bound together, the begin included, never
 * outlast the roughly 30 s of background time iOS grants.
 */
export const BACKGROUND_RUN_DEADLINE_MS = 25_000;

interface LiveAccount {
  readonly accountId: string;
  readonly generation: number;
}

/** One account session's subscriptions and what was last written for it. */
interface HandoffBinding {
  readonly generation: number;
  /**
   * `encrypted\0direct\0name` last written per room, so a sync that changes nothing writes
   * nothing.
   */
  readonly written: Map<string, string>;
  /** The session's latest token, null until the first. */
  token: SessionAccessToken | null;
  sound: boolean;
  readonly subscription: Subscription;
}

/**
 * Keeps the native push handoff store current for every signed-in account, so the
 * closed-app renderers can fetch and title a notification without the app running.
 * Writes each account's homeserver URL, access token and sound choice, plus room names
 * (DM names included), DM flags and encryption flags for rooms that changed. Active only where
 * {@link PushHandoffBridge.available}: native iOS and Android.
 *
 * An OAuth token's expiry is written with it, so the renderers can skip a read bound to
 * fail and say why. Every bridge call runs after the previous one settles, so a removal
 * can never be overtaken by a write that started before it.
 */
@Injectable({ providedIn: 'root' })
export class PushHandoffService {
  private readonly sessionEngine = inject(SESSION_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly engine = inject(NOTIFICATION_ENGINE);
  private readonly bridge = inject(PushHandoffBridge);
  private readonly injector = inject(Injector);
  private readonly errors = inject(ErrorHandler);
  private readonly bindings = new Map<string, HandoffBinding>();
  /**
   * Accounts whose sign-out began, with every session generation live for them then
   * (mid-swap, the unbound one too): nothing writes those sessions again. A new generation
   * is a new sign-in.
   */
  private readonly retired = new Map<string, Set<number>>();
  /** Epoch ms. */
  private readonly rotatedAt = new Map<string, number>();
  private tail: Promise<void> = Promise.resolve();
  /**
   * The Notification text last mirrored, written again after the store is emptied (a sign-in
   * replacing every account, App lock still on): a missing mirror would read as Show.
   */
  private notificationText: NotificationTextMode | null = null;
  private readonly mirrorLost = new Subject<void>();

  /** Each live account with its session generation: a re-auth bumps it and rebinds. */
  private readonly accounts = computed(
    (): readonly LiveAccount[] =>
      this.session.snapshot().accounts.map(({ accountId, generation }) => ({
        accountId,
        generation,
      })),
    { equal: plainEqual },
  );

  /** Emits when the store was emptied and the mirror couldn't be written again. */
  readonly notificationTextLost: Observable<void> =
    this.mirrorLost.asObservable();

  /** Own the handoff for one Application Runtime session. Never emits. */
  run(): Observable<never> {
    return new Observable<never>(() => {
      if (!this.bridge.available) return undefined;
      const accounts = effect(
        () => {
          const live = this.accounts();
          untracked(() => this.reconcile(live));
        },
        { injector: this.injector },
      );
      return () => {
        accounts.destroy();
        for (const userId of [...this.bindings.keys()]) this.unbind(userId);
      };
    });
  }

  /**
   * Remove one account's entry (its sign-out's first step), or empty the store when no
   * account is given (clear-all-data, or replacing every live account). Cold; errors when
   * the native store refused, so the cleanup that called it can record the residue.
   */
  forget(userId?: string): Observable<void> {
    return defer(() => {
      if (!this.bridge.available) return of(void 0);
      const live = this.session.snapshot().accounts;
      const ids = userId
        ? [userId]
        : [...this.bindings.keys(), ...live.map((a) => a.accountId)];
      for (const id of ids) {
        const generations = new Set<number>();
        const bound = this.bindings.get(id)?.generation;
        const current = live.find((a) => a.accountId === id)?.generation;
        if (bound !== undefined) generations.add(bound);
        if (current !== undefined) generations.add(current);
        if (generations.size > 0) this.retired.set(id, generations);
        this.bindings.get(id)?.written.clear();
      }
      const emptied = this.schedule(() =>
        userId ? this.bridge.removeAccount(userId) : this.bridge.clear(),
      );
      const text = this.notificationText;
      if (!userId && text !== null) {
        // Best effort, after the clear whatever it answered; the reset restarts the app,
        // whose session then writes the true mode.
        void this.schedule(() => this.bridge.setNotificationText(text)).catch(
          () => this.mirrorLost.next(),
        );
      }
      return from(emptied);
    });
  }

  /**
   * Cold. Mirror App lock's effective Notification text for the closed-app renderers, queued
   * after earlier writes; inert off native. Errors when the native store refused.
   */
  writeNotificationText(mode: NotificationTextMode): Observable<void> {
    return defer(() => {
      if (!this.bridge.available) return of(void 0);
      this.notificationText = mode;
      return from(this.schedule(() => this.bridge.setNotificationText(mode)));
    });
  }

  /** Cold. Remove every delivered Trinity notification, queued after earlier writes. */
  clearDelivered(): Observable<void> {
    return defer(() =>
      this.bridge.available
        ? from(this.schedule(() => this.bridge.clearDelivered()))
        : of(void 0),
    );
  }

  /**
   * As the app goes to the background, refresh each due OAuth token so the copy the
   * closed-app renderers read lives a full lifetime from now. Holds iOS background time
   * until the refreshes and their store writes land, and always releases it.
   *
   * Refreshes nothing when protected data is unavailable or the device is locking: the SDK
   * could not save the rotated pair. Otherwise starts every refresh at once, each grant
   * bound by {@link BACKGROUND_REFRESH_GRANT_TIMEOUT_MS}, so a lock that follows finds none
   * left to start and each grant answers before the lock takes the keychain away.
   *
   * Cold; emits once; never errors and never signs anything out.
   */
  refreshBeforeBackground(): Observable<void> {
    return defer(() => {
      if (!this.bridge.available) return of(void 0);
      const now = Date.now();
      const due = [...this.bindings].flatMap(([userId, binding]) => {
        if (this.isRetired(userId, binding.generation)) return [];
        const token = binding.token;
        if (!token || token.expiresAt === null || !token.refreshable) {
          return [];
        }
        const rotated = this.rotatedAt.get(userId);
        return rotated !== undefined &&
          now - rotated < BACKGROUND_REFRESH_MIN_AGE_MS
          ? []
          : [userId];
      });
      if (due.length === 0) return of(void 0);
      const refreshed = defer(() =>
        forkJoin(
          due.map((userId) =>
            this.sessionEngine
              .refreshAccessToken(userId, {
                timeoutMs: BACKGROUND_REFRESH_GRANT_TIMEOUT_MS,
              })
              .pipe(
                timeout({
                  first: BACKGROUND_REFRESH_TIMEOUT_MS,
                  with: () => of(false),
                }),
                catchError(() => of(false)),
              ),
          ),
        ),
      ).pipe(
        // A rotation queues its store write before its refresh resolves; wait for it to land.
        switchMap(() => this.drained()),
        map(() => void 0),
      );
      return this.holdingBackgroundTime((granted) =>
        granted && !canSaveTokens(granted) ? of(void 0) : refreshed,
      );
    });
  }

  /** Best effort: a native failure completes quietly, so it never surfaces in Workspace. */
  clearRoom(userId: string, roomId: string): Observable<void> {
    return defer(() =>
      this.bridge.available
        ? this.bridge.clearRoom(userId, roomId)
        : of(void 0),
    ).pipe(catchError(() => of(void 0)));
  }

  private reconcile(live: readonly LiveAccount[]): void {
    const ids = live.map((a) => a.accountId);
    for (const userId of [...this.bindings.keys()]) {
      if (!ids.includes(userId)) this.unbind(userId);
    }
    // A retired account that has gone may sign in again later and be written afresh.
    for (const userId of [...this.retired.keys()]) {
      if (!ids.includes(userId)) this.retired.delete(userId);
    }
    for (const { accountId, generation } of live) {
      const bound = this.bindings.get(accountId);
      if (bound?.generation === generation) continue;
      // A re-authentication: same user, new session, never left the list.
      if (bound) this.unbind(accountId);
      this.bind(accountId, generation);
    }
  }

  private bind(userId: string, generation: number): void {
    if (!this.isRetired(userId, generation)) this.retired.delete(userId);
    const binding: HandoffBinding = {
      generation,
      written: new Map(),
      token: null,
      sound: true,
      subscription: new Subscription(),
    };
    this.bindings.set(userId, binding);
    binding.subscription.add(
      this.engine
        .settings(userId)
        .pipe(
          map((settings) => settings.sound),
          distinctUntilChanged(),
        )
        .subscribe({
          next: (sound) => {
            binding.sound = sound;
            this.writeAccount(userId);
          },
          // A fault ends the stream until the next session generation rebinds.
          error: (error: unknown) => this.errors.handleError(error),
        }),
    );
    binding.subscription.add(
      this.sessionEngine.accessToken(userId).subscribe({
        next: (token) => {
          const previous = binding.token;
          binding.token = token;
          if (
            previous &&
            token &&
            token.accessToken !== previous.accessToken &&
            !this.isRetired(userId, generation)
          ) {
            this.rotatedAt.set(userId, Date.now());
          }
          this.writeAccount(userId);
        },
        error: (error: unknown) => this.errors.handleError(error),
      }),
    );
    binding.subscription.add(
      this.engine.pushRooms(userId).subscribe({
        next: (rooms) => this.writeRooms(userId, rooms),
        error: (error: unknown) => this.errors.handleError(error),
      }),
    );
  }

  private unbind(userId: string): void {
    this.bindings.get(userId)?.subscription.unsubscribe();
    this.bindings.delete(userId);
    this.rotatedAt.delete(userId);
  }

  private writeAccount(userId: string): void {
    const binding = this.bindings.get(userId);
    const token = binding?.token;
    if (!binding || !token || this.isRetired(userId, binding.generation)) {
      return;
    }
    const account: PushHandoffAccount = {
      userId,
      homeserverUrl: token.homeserverUrl,
      accessToken: token.accessToken,
      sound: binding.sound,
      ...(token.expiresAt === null
        ? {}
        : { accessTokenExpiresAt: token.expiresAt }),
    };
    void this.schedule(() => this.bridge.setAccount(account)).catch(
      () => undefined,
    );
  }

  private writeRooms(userId: string, rooms: readonly PushRoom[]): void {
    const binding = this.bindings.get(userId);
    if (!binding || this.isRetired(userId, binding.generation)) return;
    const changed: PushHandoffRoom[] = [];
    for (const room of rooms) {
      const entry = {
        roomId: room.roomId,
        name: room.name,
        direct: room.direct,
        encrypted: room.encrypted,
      };
      const key = `${entry.encrypted ? 1 : 0}\u0000${entry.direct ? 1 : 0}\u0000${entry.name}`;
      if (binding.written.get(entry.roomId) === key) continue;
      binding.written.set(entry.roomId, key);
      changed.push(entry);
    }
    if (changed.length === 0) return;
    void this.schedule(() => this.bridge.setRooms(userId, changed)).catch(
      () => {
        // Forget what was not stored, so the next sync writes it again.
        for (const room of changed) binding.written.delete(room.roomId);
      },
    );
  }

  private isRetired(userId: string, generation: number): boolean {
    return this.retired.get(userId)?.has(generation) ?? false;
  }

  /**
   * Run `work` while the OS keeps the app running in the background; `work` gets
   * `undefined` when the host could not grant it.
   *
   * A grant that answers after the run was cut off or unsubscribed is still ended by a
   * continuation `finalize` leaves behind: a deliberate exception to ADR 0006's no detached
   * work, since it only releases iOS background time that would otherwise stay held.
   */
  private holdingBackgroundTime(
    work: (granted: BackgroundWork | undefined) => Observable<void>,
  ): Observable<void> {
    return defer(() => {
      let ended = false;
      const begun = firstValueFrom(this.bridge.beginBackgroundWork()).catch(
        () => undefined,
      );
      const end = (granted: BackgroundWork | undefined): Observable<void> =>
        defer(() => {
          if (ended || granted === undefined) return of(void 0);
          ended = true;
          return this.bridge
            .endBackgroundWork(granted.id)
            .pipe(catchError(() => of(void 0)));
        }).pipe(defaultIfEmpty(void 0));
      return from(begun).pipe(
        switchMap((granted) =>
          concat(work(granted).pipe(ignoreElements()), end(granted)),
        ),
        timeout({ first: BACKGROUND_RUN_DEADLINE_MS, with: () => of(void 0) }),
        finalize(() => {
          // Past the deadline, on an error or on unsubscription the stream can no longer
          // carry the end, and the begin may not have answered yet: end once it does.
          if (ended) return;
          void begun
            .then((granted) =>
              lastValueFrom(end(granted), { defaultValue: undefined }),
            )
            .catch(() => undefined);
        }),
      );
    });
  }

  /** Completes once every bridge call queued so far has settled, or after the bound. */
  private drained(): Observable<void> {
    return defer(() => from(this.tail)).pipe(
      timeout({
        first: BACKGROUND_REFRESH_TIMEOUT_MS,
        with: () => of(void 0),
      }),
    );
  }

  private schedule(operation: () => Observable<void>): Promise<void> {
    const next = this.tail.then(() =>
      lastValueFrom(operation(), { defaultValue: undefined }),
    );
    this.tail = next.catch(() => undefined);
    return next;
  }
}

function canSaveTokens(granted: BackgroundWork): boolean {
  return granted.protectedDataAvailable && !granted.locking;
}
