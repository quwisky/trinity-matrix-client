import {
  ClientEvent,
  EventType,
  MatrixEventEvent,
  RelationType,
  RoomEvent,
  SyncState,
  type IRoomTimelineData,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { Observable } from 'rxjs';
import {
  RoomEncryptionFlags,
  displayContent,
  validReplacement,
} from '@trinity/util/matrix';
import type {
  IncomingNotification,
  ReactionAnnotation,
  ReactionTarget,
} from '../notification-engine';
import { normalizeNotificationEvent } from './normalize-notification-event';

/** Permanent UTDs stay pending for a later retry, so the set needs a cap. */
const PENDING_DECRYPTION_CAP = 500;
/** Reactions handed out, so `reactionTarget` still sees their redaction after a timeline reset. */
const REMEMBERED_REACTIONS_CAP = 500;

function addCapped<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  map.set(key, value);
  if (map.size > cap) map.delete(map.keys().next().value as K);
}

function annotationOf(
  accountId: string,
  client: MatrixClient,
  event: MatrixEvent,
  room: Room,
): ReactionAnnotation | null {
  const eventId = event.getId();
  const senderId = event.getSender();
  if (
    !eventId ||
    event.getRoomId() !== room.roomId ||
    event.isRedacted() ||
    !senderId ||
    senderId === accountId ||
    client.isUserIgnored(senderId)
  ) {
    return null;
  }
  const relation = event.getRelation();
  if (
    relation?.rel_type !== RelationType.Annotation ||
    typeof relation.event_id !== 'string' ||
    relation.event_id.length === 0 ||
    typeof relation.key !== 'string' ||
    relation.key.trim().length === 0
  ) {
    return null;
  }
  return {
    kind: 'reaction-annotation',
    accountId,
    roomId: room.roomId,
    roomName: room.name || null,
    eventId,
    targetEventId: relation.event_id,
    key: relation.key,
    senderId,
    senderName:
      event.sender?.name || room.getMember(senderId)?.name || senderId,
  };
}

/**
 * The incoming half of the js-sdk notification engine. Encryption flags and the reactions handed
 * out are kept per client, so `reactionTarget` shares what a `notifications` feed learned.
 */
export class JsSdkIncomingNotifications {
  private readonly encryption = new WeakMap<
    MatrixClient,
    RoomEncryptionFlags
  >();
  private readonly reactions = new WeakMap<
    MatrixClient,
    Map<string, MatrixEvent>
  >();

  /** `current` is false once the account's client has been replaced; nothing is emitted then. */
  feed(
    accountId: string,
    client: MatrixClient,
    current: () => boolean,
  ): Observable<IncomingNotification> {
    return new Observable<IncomingNotification>((subscriber) => {
      const syncState = client.getSyncState();
      let firstSyncCompleted =
        syncState === SyncState.Prepared || syncState === SyncState.Syncing;
      const encryption = this.encryptionOf(client);
      const reactions = this.reactionsOf(client);
      /** Live events only, so scrollback that later decrypts never notifies. */
      const pendingDecryption = new Map<string, true>();
      // A room counts as encrypted by its state OR by the crypto store. The store's answer is
      // async, so ask it once per room up front; a room first seen later is covered next sync.
      const warmEncryption = (): void => {
        const crypto = client.getCrypto();
        for (const room of client.getRooms()) {
          void encryption.refresh(crypto, room.roomId);
        }
      };
      if (firstSyncCompleted) warmEncryption();

      // `rescore` makes the rules score the cleartext, not a cached ciphertext result.
      const handle = (
        event: MatrixEvent,
        room: Room | undefined,
        rescore: boolean,
      ): void => {
        if (!room || !current()) return;
        if (event.getType() === EventType.Reaction) {
          const annotation = annotationOf(accountId, client, event, room);
          if (!annotation) return;
          addCapped(
            reactions,
            annotation.eventId,
            event,
            REMEMBERED_REACTIONS_CAP,
          );
          subscriber.next(annotation);
          return;
        }
        if (
          event.getSender() === accountId ||
          client.getPushActionsForEvent(event, rescore)?.notify !== true
        ) {
          return;
        }
        subscriber.next(
          normalizeNotificationEvent(
            accountId,
            event,
            room,
            encryption.isEncrypted(room),
          ),
        );
      };

      const onSync = (state: SyncState): void => {
        if (state === SyncState.Prepared || state === SyncState.Syncing) {
          firstSyncCompleted = true;
          warmEncryption();
        }
      };
      const onTimeline = (
        event: MatrixEvent,
        room: Room | undefined,
        _toStart?: boolean,
        _removed?: boolean,
        data?: IRoomTimelineData,
      ): void => {
        // This runs inside the SDK's sync emit loop — a throw must never disrupt it.
        try {
          // matrix-js-sdk labels the first /sync batch as live while it is still applying
          // stored room state and history. PREPARED is emitted afterwards.
          if (data?.liveEvent !== true || !firstSyncCompleted) return;
          if (event.isEncrypted() && event.getClearContent() == null) {
            const id = event.getId();
            if (id) {
              addCapped(pendingDecryption, id, true, PENDING_DECRYPTION_CAP);
            }
            return;
          }
          handle(event, room, false);
        } catch {
          /* a notification failure is non-fatal */
        }
      };
      const onDecrypted = (event: MatrixEvent): void => {
        // Also runs inside the SDK's emit loop — never let a throw escape.
        try {
          const id = event.getId();
          // A failure stays pending for a later retry.
          if (
            !id ||
            !pendingDecryption.has(id) ||
            event.isDecryptionFailure()
          ) {
            return;
          }
          pendingDecryption.delete(id);
          handle(
            event,
            client.getRoom(event.getRoomId() ?? '') ?? undefined,
            true,
          );
        } catch {
          /* a notification failure is non-fatal */
        }
      };
      client.on(ClientEvent.Sync, onSync);
      client.on(RoomEvent.Timeline, onTimeline);
      client.on(MatrixEventEvent.Decrypted, onDecrypted);
      return () => {
        client.off(ClientEvent.Sync, onSync);
        client.off(RoomEvent.Timeline, onTimeline);
        client.off(MatrixEventEvent.Decrypted, onDecrypted);
      };
    });
  }

  async target(
    accountId: string,
    client: MatrixClient,
    roomId: string,
    targetEventId: string,
    reactionIds: readonly string[],
  ): Promise<ReactionTarget | null> {
    const room = client.getRoom(roomId);
    if (!room) return null;
    const live = (): string[] =>
      reactionIds.filter((id) => {
        const reaction =
          this.reactions.get(client)?.get(id) ?? room.findEventById(id);
        const senderId = reaction?.getSender();
        return (
          !!reaction &&
          !reaction.isRedacted() &&
          !!senderId &&
          !client.isUserIgnored(senderId)
        );
      });
    if (live().length === 0) return null;

    let target = room.findEventById(targetEventId);
    if (!target) {
      const raw = await client.fetchRoomEvent(roomId, targetEventId);
      if (raw.room_id && raw.room_id !== roomId) return null;
      target = client.getEventMapper({ decrypt: false })({
        ...raw,
        room_id: roomId,
      });
    }
    const own = (event: MatrixEvent): boolean =>
      event.getId() === targetEventId &&
      event.getRoomId() === roomId &&
      event.getSender() === accountId &&
      !event.isRedacted();
    if (!own(target)) return null;
    if (target.isEncrypted() && target.getClearContent() == null) {
      await client.decryptEventIfNeeded(target);
    }
    // Checked again: a redaction can land while the target is fetched or decrypted.
    const liveReactionIds = live();
    if (
      !own(target) ||
      target.getType() !== EventType.RoomMessage ||
      target.isDecryptionFailure() ||
      liveReactionIds.length === 0
    ) {
      return null;
    }
    const body: unknown = displayContent(target)['body'];
    // As for messages: text that arrived in the clear in an encrypted room is not previewed.
    const previewable =
      typeof body === 'string' &&
      ((validReplacement(target) ?? target).isEncrypted() ||
        !this.encryptionOf(client).isEncrypted(room));
    return { body: previewable ? body : null, liveReactionIds };
  }

  private encryptionOf(client: MatrixClient): RoomEncryptionFlags {
    let flags = this.encryption.get(client);
    if (!flags) {
      flags = new RoomEncryptionFlags();
      this.encryption.set(client, flags);
    }
    return flags;
  }

  private reactionsOf(client: MatrixClient): Map<string, MatrixEvent> {
    let reactions = this.reactions.get(client);
    if (!reactions) {
      reactions = new Map();
      this.reactions.set(client, reactions);
    }
    return reactions;
  }
}
