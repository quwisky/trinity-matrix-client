import {
  EventType,
  RelationType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import {
  EMPTY,
  Subscription,
  catchError,
  defer,
  filter,
  finalize,
  from,
  map,
  of,
  switchMap,
  timeout,
} from 'rxjs';
import type { ReactionNotificationEvent } from './notification-intent';

export interface ReactionNotificationBatchOptions {
  readonly accountId: string;
  readonly client: MatrixClient;
  readonly allowed: (room: Room, senderId: string) => boolean;
  readonly present: (event: ReactionNotificationEvent) => void;
}

interface PendingReactions {
  readonly room: Room;
  readonly targetId: string;
  readonly started: number;
  readonly events: Map<string, MatrixEvent>;
  timer: ReturnType<typeof setTimeout> | null;
  lookup: Subscription | null;
}

const QUIET_WINDOW_MS = 2000;
const MAX_BURST_MS = 10_000;
const LOOKUP_TIMEOUT_MS = 10_000;
const MAX_BATCHES = 100;
const MAX_REACTIONS_PER_BATCH = 100;
const MAX_SEEN_EVENTS = 500;

/** Transient reaction work owned by one exact account/client notification lifetime. */
export class ReactionNotificationBatch {
  private readonly pending = new Map<string, PendingReactions>();
  private readonly seen = new Set<string>();
  private disposed = false;

  constructor(private readonly options: ReactionNotificationBatchOptions) {}

  add(event: MatrixEvent, room: Room): void {
    const relation = this.annotation(event, room);
    if (!relation) return;
    const eventId = event.getId()!;
    if (this.seen.has(eventId)) return;
    this.seen.add(eventId);
    if (this.seen.size > MAX_SEEN_EVENTS) {
      this.seen.delete(this.seen.values().next().value!);
    }

    const key = `${room.roomId} ${relation.event_id}`;
    let batch = this.pending.get(key);
    if (!batch) {
      if (this.pending.size >= MAX_BATCHES) return;
      batch = {
        room,
        targetId: relation.event_id,
        started: Date.now(),
        events: new Map(),
        timer: null,
        lookup: null,
      };
      this.pending.set(key, batch);
    }
    if (batch.events.size >= MAX_REACTIONS_PER_BATCH) return;
    batch.events.set(eventId, event);
    // A target lookup already in progress consumes the whole batch when it finishes.
    if (batch.lookup) return;
    if (batch.timer !== null) clearTimeout(batch.timer);
    const delay = Math.max(
      0,
      Math.min(QUIET_WINDOW_MS, MAX_BURST_MS - (Date.now() - batch.started)),
    );
    batch.timer = setTimeout(() => this.flush(key, batch), delay);
  }

  dispose(): void {
    this.disposed = true;
    for (const batch of this.pending.values()) {
      if (batch.timer !== null) clearTimeout(batch.timer);
      batch.lookup?.unsubscribe();
    }
    this.pending.clear();
    this.seen.clear();
  }

  private annotation(event: MatrixEvent, room: Room) {
    try {
      if (
        this.disposed ||
        event.getType() !== EventType.Reaction ||
        !event.getId() ||
        event.getRoomId() !== room.roomId ||
        event.isRedacted()
      )
        return null;
      const senderId = event.getSender();
      if (
        !senderId ||
        senderId === this.options.client.getUserId() ||
        !this.options.allowed(room, senderId)
      )
        return null;
      const relation = event.getRelation();
      return relation?.rel_type === RelationType.Annotation &&
        typeof relation.event_id === 'string' &&
        relation.event_id.length > 0 &&
        typeof relation.key === 'string' &&
        relation.key.trim().length > 0
        ? { event_id: relation.event_id, key: relation.key }
        : null;
    } catch {
      return null;
    }
  }

  private flush(key: string, batch: PendingReactions): void {
    batch.timer = null;
    if (this.disposed || this.pending.get(key) !== batch) return;
    const lookup = new Subscription();
    batch.lookup = lookup;
    lookup.add(
      defer(() => {
        const stillEligible = [...batch.events.values()].some((event) =>
          this.annotation(event, batch.room),
        );
        if (!stillEligible) return EMPTY;
        const local = batch.room.findEventById(batch.targetId);
        return local
          ? of(local)
          : from(
              this.options.client.fetchRoomEvent(
                batch.room.roomId,
                batch.targetId,
              ),
            ).pipe(
              filter(
                (raw) => !raw.room_id || raw.room_id === batch.room.roomId,
              ),
              map((raw) =>
                this.options.client.getEventMapper({ decrypt: false })({
                  ...raw,
                  room_id: batch.room.roomId,
                }),
              ),
            );
      })
        .pipe(
          filter((target) => this.isOwnTarget(target, batch)),
          switchMap((target) =>
            target.isEncrypted() && target.getClearContent() == null
              ? from(this.options.client.decryptEventIfNeeded(target)).pipe(
                  map(() => target),
                )
              : of(target),
          ),
          timeout(LOOKUP_TIMEOUT_MS),
          map((target) => this.presentBatch(batch, target)),
          // A missing target or key is not a failure of the host presentation capability.
          catchError(() => EMPTY),
          finalize(() => {
            if (this.pending.get(key) === batch) this.pending.delete(key);
            batch.lookup = null;
          }),
        )
        .subscribe(),
    );
  }

  private isOwnTarget(target: MatrixEvent, batch: PendingReactions): boolean {
    return (
      !this.disposed &&
      target.getId() === batch.targetId &&
      target.getRoomId() === batch.room.roomId &&
      target.getSender() === this.options.client.getUserId() &&
      !target.isRedacted()
    );
  }

  private presentBatch(batch: PendingReactions, target: MatrixEvent): void {
    if (
      !this.isOwnTarget(target, batch) ||
      target.getType() !== EventType.RoomMessage ||
      target.isDecryptionFailure()
    )
      return;

    const senders = new Map<string, string>();
    const keys = new Set<string>();
    for (const event of batch.events.values()) {
      const relation = this.annotation(event, batch.room);
      if (!relation || relation.event_id !== batch.targetId) continue;
      const senderId = event.getSender()!;
      senders.set(
        senderId,
        event.sender?.name || batch.room.getMember(senderId)?.name || senderId,
      );
      keys.add(relation.key!);
    }
    const first = senders.entries().next().value;
    if (!first) return;
    const body: unknown = target.getContent()['body'];
    this.options.present(
      Object.freeze({
        kind: 'reaction',
        accountId: this.options.accountId,
        roomId: batch.room.roomId,
        eventId: batch.targetId,
        senderId: first[0],
        senderName: first[1],
        senderCount: senders.size,
        reactionKeys: Object.freeze([...keys]),
        roomName: batch.room.name || null,
        body: typeof body === 'string' ? body : null,
      }),
    );
  }
}
