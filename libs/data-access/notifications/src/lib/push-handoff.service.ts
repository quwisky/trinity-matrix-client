import { Injectable, Injector, effect, inject, untracked } from '@angular/core';
import {
  ClientEvent,
  EventType,
  RoomEvent,
  SyncState,
  type MatrixClient,
  type MatrixEvent,
} from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { RoomEncryptionFlags } from '@trinity/util/matrix';
import {
  PushHandoffBridge,
  type BackgroundWork,
  type PushHandoffAccount,
  type PushHandoffRoom,
} from '@trinity/capacitor-push';
import {
  Observable,
  Subject,
  catchError,
  concat,
  defaultIfEmpty,
  defer,
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
import type { NotificationTextMode } from './notification-text.port';
import {
  LEGACY_NOTIFICATION_SOUND_EVENT,
  NOTIFICATION_SOUND_EVENT,
  NotificationSoundService,
} from './notification-sound.service';

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

/** One live account's listeners and what was last written for its rooms. */
interface HandoffBinding {
  readonly client: MatrixClient;
  /**
   * `encrypted\0direct\0name` last written per room, so a sync that changes nothing writes
   * nothing.
   */
  readonly written: Map<string, string>;
  readonly encryption: RoomEncryptionFlags;
  readonly detach: () => void;
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
  private readonly matrix = inject(MatrixClientService);
  private readonly bridge = inject(PushHandoffBridge);
  private readonly sound = inject(NotificationSoundService);
  private readonly injector = inject(Injector);
  private readonly bindings = new Map<string, HandoffBinding>();
  /**
   * Accounts whose sign-out began, with every client live for them then (mid-swap, the
   * unbound one too): nothing writes those clients again. A new client is a new sign-in.
   */
  private readonly retired = new Map<string, Set<MatrixClient>>();
  /** Epoch ms. */
  private readonly rotatedAt = new Map<string, number>();
  private tail: Promise<void> = Promise.resolve();
  /**
   * The Notification text last mirrored, written again after the store is emptied (a sign-in
   * replacing every account, App lock still on): a missing mirror would read as Show.
   */
  private notificationText: NotificationTextMode | null = null;
  private readonly mirrorLost = new Subject<void>();

  /** Emits when the store was emptied and the mirror couldn't be written again. */
  readonly notificationTextLost: Observable<void> =
    this.mirrorLost.asObservable();

  /** Own the handoff for one Application Runtime session. Never emits. */
  run(): Observable<never> {
    return new Observable<never>(() => {
      if (!this.bridge.available) return undefined;
      const accounts = effect(
        () => {
          const ids = this.matrix.accountIds();
          untracked(() => this.reconcile(ids));
        },
        { injector: this.injector },
      );
      const rotations = this.matrix.accessTokenRotations.subscribe(
        ({ userId, accessToken }) => {
          const binding = this.bindings.get(userId);
          if (binding && !this.isRetired(userId, binding.client)) {
            this.rotatedAt.set(userId, Date.now());
          }
          this.writeAccount(userId, accessToken);
        },
      );
      return () => {
        accounts.destroy();
        rotations.unsubscribe();
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
      const ids = userId
        ? [userId]
        : [...this.bindings.keys(), ...this.matrix.accountIds()];
      for (const id of ids) {
        const clients = new Set<MatrixClient>();
        const bound = this.bindings.get(id)?.client;
        const current = this.matrix.clientFor(id);
        if (bound) clients.add(bound);
        if (current) clients.add(current);
        if (clients.size > 0) this.retired.set(id, clients);
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
        if (this.isRetired(userId, binding.client)) return [];
        const token = binding.client.getAccessToken();
        if (
          !token ||
          this.matrix.accessTokenExpiry(userId, token) === undefined ||
          !this.matrix.canRefreshAccessToken(userId)
        ) {
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
            this.matrix
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

  /**
   * As the app returns to the foreground, use the pair native code holds: a push may have
   * rotated it while the app was away. Cold; emits once; inert off native.
   */
  adoptOnResume(): Observable<void> {
    return defer(() =>
      this.bridge.available ? this.matrix.adoptNativeTokens() : of(void 0),
    );
  }

  /** Best effort: a native failure completes quietly, so it never surfaces in Workspace. */
  clearRoom(userId: string, roomId: string): Observable<void> {
    return defer(() =>
      this.bridge.available
        ? this.bridge.clearRoom(userId, roomId)
        : of(void 0),
    ).pipe(catchError(() => of(void 0)));
  }

  private reconcile(ids: readonly string[]): void {
    for (const userId of [...this.bindings.keys()]) {
      if (!ids.includes(userId)) this.unbind(userId);
    }
    // A retired account that has gone may sign in again later and be written afresh.
    for (const userId of [...this.retired.keys()]) {
      if (!ids.includes(userId)) this.retired.delete(userId);
    }
    for (const userId of ids) {
      const client = this.matrix.clientFor(userId);
      const bound = this.bindings.get(userId);
      if (!client || bound?.client === client) continue;
      // A re-authentication: same user, new client, never left the list.
      if (bound) this.unbind(userId);
      this.bind(userId, client);
    }
  }

  private bind(userId: string, client: MatrixClient): void {
    if (!this.isRetired(userId, client)) this.retired.delete(userId);
    const onSync = (state: SyncState): void => {
      if (state === SyncState.Prepared || state === SyncState.Syncing) {
        this.writeRooms(userId);
      }
    };
    const onName = (): void => this.writeRooms(userId);
    const onAccountData = (event: MatrixEvent): void => {
      const type = event.getType();
      if (type === EventType.Direct) {
        this.writeRooms(userId);
      } else if (
        type === NOTIFICATION_SOUND_EVENT ||
        type === LEGACY_NOTIFICATION_SOUND_EVENT
      ) {
        this.writeAccount(userId);
      }
    };
    client.on(ClientEvent.Sync, onSync);
    client.on(RoomEvent.Name, onName);
    client.on(ClientEvent.AccountData, onAccountData);
    this.bindings.set(userId, {
      client,
      written: new Map(),
      encryption: new RoomEncryptionFlags(),
      detach: () => {
        client.off(ClientEvent.Sync, onSync);
        client.off(RoomEvent.Name, onName);
        client.off(ClientEvent.AccountData, onAccountData);
      },
    });
    this.writeAccount(userId);
    this.writeRooms(userId);
  }

  private unbind(userId: string): void {
    this.bindings.get(userId)?.detach();
    this.bindings.delete(userId);
    this.rotatedAt.delete(userId);
  }

  /** `accessToken` is passed on rotation: the SDK adopts the new token after this runs. */
  private writeAccount(userId: string, accessToken?: string): void {
    const binding = this.bindings.get(userId);
    if (!binding || this.isRetired(userId, binding.client)) return;
    const token = accessToken ?? binding.client.getAccessToken();
    if (!token) return;
    const expiresAt = this.matrix.accessTokenExpiry(userId, token);
    const account: PushHandoffAccount = {
      userId,
      homeserverUrl: binding.client.getHomeserverUrl(),
      accessToken: token,
      sound: this.sound.isOn(userId),
      ...(expiresAt === undefined ? {} : { accessTokenExpiresAt: expiresAt }),
    };
    void this.schedule(() => this.bridge.setAccount(account)).catch(
      () => undefined,
    );
  }

  private writeRooms(userId: string): void {
    const binding = this.bindings.get(userId);
    if (!binding || this.isRetired(userId, binding.client)) return;
    const direct = directRoomIds(binding.client);
    const { encryption } = binding;
    const changed: PushHandoffRoom[] = [];
    for (const room of binding.client.getRooms()) {
      if (room.getMyMembership() !== 'join') continue;
      const answered = encryption.answered(room.roomId);
      if (!answered) {
        void encryption
          .refresh(binding.client.getCrypto(), room.roomId)
          .then(() => {
            if (encryption.answered(room.roomId)) this.writeRooms(userId);
          });
      }
      const entry = {
        roomId: room.roomId,
        name: room.name,
        direct: direct.has(room.roomId),
        // Until the crypto store answers, the room may be encrypted without saying so in its
        // state; the renderers would show unencrypted text from it as a member's message.
        encrypted: !answered || encryption.isEncrypted(room),
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

  private isRetired(userId: string, client: MatrixClient): boolean {
    return this.retired.get(userId)?.has(client) ?? false;
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

/** Room ids the `m.direct` account data lists as DMs. */
function directRoomIds(client: MatrixClient): ReadonlySet<string> {
  const map =
    client
      .getAccountData(EventType.Direct)
      ?.getContent<Record<string, unknown>>() ?? {};
  const ids = new Set<string>();
  for (const roomIds of Object.values(map)) {
    if (!Array.isArray(roomIds)) continue;
    for (const roomId of roomIds) {
      if (typeof roomId === 'string') ids.add(roomId);
    }
  }
  return ids;
}
