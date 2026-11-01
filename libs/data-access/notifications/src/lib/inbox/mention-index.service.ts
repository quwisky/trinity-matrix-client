import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { SessionStorageService } from '@trinity/platform-native';
import {
  MatrixEventEvent,
  RelationType,
  RoomEvent,
  type IRoomTimelineData,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import {
  Observable,
  TimeoutError,
  defer,
  firstValueFrom,
  from,
  timeout,
  type ObservableInput,
} from 'rxjs';
import { MentionInboxPreferences } from './mention-inbox.preferences';
import {
  MENTION_INDEX_STORE,
  type MentionCursor,
  type MentionRecord,
} from './mention-index-store';

/** One account's client plus its bound listeners. */
interface AccountRecorder {
  readonly client: MatrixClient;
  readonly onTimeline: (
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline?: boolean,
    removed?: boolean,
    data?: IRoomTimelineData,
  ) => void;
  readonly onDecrypted: (event: MatrixEvent) => void;
}

/** Permanent UTDs stay pending for a later retry, so the set needs a cap. */
const PENDING_DECRYPTION_CAP = 500;

/** A hung store would otherwise hold every delete and stop queued behind it for good. */
const STEP_LIMIT_MS = 10_000;

/**
 * Records which messages mentioned the person, for every signed-in account at once, which is
 * why this is not a `projectFromClient` projection. It is separate from presentation: catch-up
 * and a backlog after sleep are recorded even though they never show a notification.
 */
@Injectable({ providedIn: 'root' })
export class MentionIndexService {
  private readonly matrix = inject(MatrixClientService);
  private readonly preferences = inject(MentionInboxPreferences);
  private readonly sessions = inject(SessionStorageService);
  private readonly store = inject(MENTION_INDEX_STORE);

  private readonly recorders = new Map<string, AccountRecorder>();
  private readonly started = signal(false);
  private readonly stopped = signal(false);
  private readonly deleteFailedState = signal(false);

  private session: symbol | null = null;
  private writes: Promise<void> = Promise.resolve();

  readonly recording = computed(
    () => this.started() && !this.stopped() && this.preferences.recordAllowed(),
  );
  readonly deleteFailed = this.deleteFailedState.asReadonly();

  constructor() {
    effect(() => {
      const accountIds = this.recording() ? this.matrix.accountIds() : [];
      untracked(() => this.reconcile(accountIds));
    });
  }

  /** Own recording for one Application Runtime session; teardown releases it. */
  run(): Observable<never> {
    return new Observable<never>(() => {
      this.stopped.set(false);
      const session = Symbol();
      this.session = session;
      void this.start(session);
      return () => {
        if (this.session === session) {
          this.halt();
        }
      };
    });
  }

  /** Ends recording; completes once no write is in flight. */
  stop(): Observable<void> {
    return defer(() => {
      this.halt();
      return from(this.writes);
    });
  }

  page(
    accountId: string,
    before: MentionCursor | null,
    limit: number,
  ): Observable<readonly MentionRecord[]> {
    return defer(() =>
      from(this.store.page(accountId, before, limit, Date.now())),
    );
  }

  forget(accountId: string, eventIds: readonly string[]): Observable<void> {
    return defer(() =>
      from(this.enqueue(() => this.store.remove(accountId, eventIds))),
    );
  }

  count(accountId?: string): Observable<number> {
    return defer(() => from(this.store.count(accountId)));
  }

  forgetAccount(accountId: string): Observable<void> {
    return defer(() =>
      from(this.enqueue(() => this.store.clearAccount(accountId))),
    );
  }

  deleteAll(): Observable<void> {
    return defer(() => from(this.wipe()));
  }

  private async start(session: symbol): Promise<void> {
    await firstValueFrom(this.preferences.init()).catch(() => undefined);
    if (this.session !== session) {
      return;
    }
    this.started.set(true);
    // A stop and this start can fall between two effect runs, which then see no change.
    this.reconcile(this.recording() ? this.matrix.accountIds() : []);
    if (this.preferences.recordDeclined()) {
      // Also how a delete that failed earlier is retried; `deleteFailed` reports this one.
      await this.wipe().catch(() => undefined);
    } else if (this.preferences.recordAllowed()) {
      await this.sweep(session);
    } else {
      // A setting that couldn't be read may be either answer: a failed read deletes nothing.
      this.stopForSession();
    }
  }

  /** Forgets accounts removed while no client could. The next start retries a failure. */
  private async sweep(session: symbol): Promise<void> {
    try {
      // A registry that can't be read must throw here: an empty list deletes every row.
      const accounts = await this.enqueue(() => this.sessions.list());
      const ids = accounts.map((account) => account.userId);
      // So must a corrupt record: an `undefined` ID matches no row, and deletes them all.
      const valid = ids.every((id: unknown) => typeof id === 'string' && id);
      if (valid && this.session === session) {
        await this.enqueue(() => this.store.keepOnlyAccounts(ids));
      }
    } catch {
      /* the next start retries */
    }
  }

  private async wipe(): Promise<void> {
    try {
      await this.enqueue(() => this.store.deleteAll());
      this.deleteFailedState.set(false);
    } catch (error) {
      this.deleteFailedState.set(true);
      throw error;
    }
  }

  private halt(): void {
    this.session = null;
    this.started.set(false);
    this.reconcile([]);
  }

  private stopForSession(): void {
    if (this.stopped()) {
      return;
    }
    this.stopped.set(true);
    console.warn('mention index: recording stopped for this session');
  }

  /** Past the limit a step counts as a storage failure, and its late answer is ignored. */
  private enqueue<T>(work: () => ObservableInput<T>): Promise<T> {
    const result = this.writes.then(() =>
      firstValueFrom(defer(work).pipe(timeout(STEP_LIMIT_MS))).catch(
        (error: unknown) => {
          if (error instanceof TimeoutError) {
            this.stopForSession();
          }
          throw error;
        },
      ),
    );
    this.writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private reconcile(accountIds: readonly string[]): void {
    for (const [accountId, recorder] of this.recorders) {
      // Re-adding a signed-in account re-creates its client; the old one is stopped.
      if (
        !accountIds.includes(accountId) ||
        this.matrix.clientFor(accountId) !== recorder.client
      ) {
        recorder.client.off(RoomEvent.Timeline, recorder.onTimeline);
        recorder.client.off(MatrixEventEvent.Decrypted, recorder.onDecrypted);
        this.recorders.delete(accountId);
      }
    }
    for (const accountId of accountIds) {
      const client = this.matrix.clientFor(accountId);
      // A client not fully started yet: a later accountIds tick re-checks it.
      if (client && !this.recorders.has(accountId)) {
        const recorder = this.buildRecorder(accountId, client);
        client.on(RoomEvent.Timeline, recorder.onTimeline);
        client.on(MatrixEventEvent.Decrypted, recorder.onDecrypted);
        this.recorders.set(accountId, recorder);
      }
    }
  }

  private buildRecorder(
    accountId: string,
    client: MatrixClient,
  ): AccountRecorder {
    // Live events only, so scrollback that later decrypts is never recorded.
    const pending = new Set<string>();
    return {
      client,
      onTimeline: (event, _room, _toStart, _removed, data): void => {
        // Both listeners run inside the SDK's emit loop: a throw must never disrupt it.
        try {
          // A cached replay reports thread events as live, and the sync state is null until it
          // ends. Scrolling back in a thread reads as live too and can record a real old mention,
          // which we accept.
          if (data?.liveEvent !== true || client.getSyncState() === null) {
            return;
          }
          const id = event.getId();
          // A failure can beat the timeline emit, and new keys can still rescue it.
          const awaiting =
            event.isEncrypted() &&
            (event.getClearContent() === null || event.isDecryptionFailure());
          if (!awaiting) {
            this.record(accountId, client, event);
          } else if (id) {
            pending.add(id);
            if (pending.size > PENDING_DECRYPTION_CAP) {
              const [oldest] = pending;
              pending.delete(oldest as string);
            }
          }
        } catch {
          /* recording is best-effort */
        }
      },
      onDecrypted: (event): void => {
        try {
          const id = event.getId();
          if (id && pending.has(id) && !event.isDecryptionFailure()) {
            pending.delete(id);
            this.record(accountId, client, event);
          }
        } catch {
          /* recording is best-effort */
        }
      },
    };
  }

  private record(
    accountId: string,
    client: MatrixClient,
    event: MatrixEvent,
  ): void {
    if (
      event.getSender() === client.getUserId() ||
      event.isRedacted() ||
      // A legacy edit highlights by display name again, so a bot's edits could use up the cap.
      event.getRelation()?.rel_type === RelationType.Replace ||
      client.getPushActionsForEvent(event, true)?.tweaks?.highlight !== true
    ) {
      return;
    }
    const record: MentionRecord = {
      eventId: event.getId() ?? '',
      roomId: event.getRoomId() ?? '',
      ts: event.getTs(),
    };
    void this.enqueue(() =>
      // Checked here, not at the emit: a failure or a switch going off also drops queued writes.
      this.recording()
        ? this.store.put(accountId, record, Date.now())
        : Promise.resolve(),
    ).catch((error: unknown) => {
      // A TypeError is one malformed event from a server, which is no reason to stop.
      if (!(error instanceof TypeError)) {
        this.stopForSession();
      }
    });
  }
}
