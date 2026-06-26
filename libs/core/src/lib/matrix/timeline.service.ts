import { Injectable, inject, signal } from '@angular/core';
import {
  Direction,
  EventType,
  MatrixEventEvent,
  MsgType,
  RoomEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { Observable, defer, from, map, of, tap } from 'rxjs';
import { MatrixClientService } from './matrix-client.service';

export type MessageKind =
  | 'text'
  | 'emote'
  | 'notice'
  | 'redacted'
  | 'unsupported';

/** A single rendered timeline message (plain view model — no SDK types leak out). */
export interface MessageView {
  id: string;
  senderId: string;
  senderName: string;
  senderInitial: string;
  senderAvatarUrl: string | null;
  body: string;
  timestamp: number;
  isOwn: boolean;
  decryptionFailed: boolean;
  kind: MessageKind;
}

const AVATAR_PX = 64;
const SCROLLBACK = 30;

/**
 * Projects the *active* room's live timeline into a `messages` signal of view
 * models. Re-maps on new events and on async E2EE decryption. The shell opens one
 * room at a time; `matrix-js-sdk` remains the source of truth.
 */
@Injectable({ providedIn: 'root' })
export class TimelineService {
  private readonly matrix = inject(MatrixClientService);

  private readonly _messages = signal<MessageView[]>([]);
  readonly messages = this._messages.asReadonly();

  private readonly _loadingOlder = signal(false);
  readonly loadingOlder = this._loadingOlder.asReadonly();

  private readonly _canLoadOlder = signal(false);
  readonly canLoadOlder = this._canLoadOlder.asReadonly();

  private roomId: string | null = null;
  private room: Room | null = null;

  private readonly onTimeline = (): void => this.refresh();
  private readonly onDecrypted = (event: MatrixEvent): void => {
    if (event.getRoomId() === this.roomId) {
      this.refresh();
    }
  };

  /** Start projecting a room's live timeline; attaches live + decryption listeners. */
  open(roomId: string): void {
    if (this.roomId === roomId || !this.matrix.isInitialized) {
      return;
    }
    this.close();

    const client = this.matrix.instance;
    const room = client.getRoom(roomId);
    if (!room) {
      return;
    }

    this.roomId = roomId;
    this.room = room;
    room.on(RoomEvent.Timeline, this.onTimeline);
    client.on(MatrixEventEvent.Decrypted, this.onDecrypted);
    this.refresh();

    // Best-effort read receipt for the most recent event.
    const events = room.getLiveTimeline().getEvents();
    const last = events[events.length - 1];
    if (last) {
      void client.sendReadReceipt(last);
    }
  }

  /** Detach listeners and clear the timeline. */
  close(): void {
    this.room?.off(RoomEvent.Timeline, this.onTimeline);
    if (this.matrix.isInitialized) {
      this.matrix.instance.off(MatrixEventEvent.Decrypted, this.onDecrypted);
    }
    this.room = null;
    this.roomId = null;
    this._messages.set([]);
    this._canLoadOlder.set(false);
  }

  /** Page in older history (backward pagination via `scrollback`). */
  loadOlder(): Observable<void> {
    const room = this.room;
    if (!room || this._loadingOlder()) {
      return of(void 0);
    }
    return defer(() => {
      this._loadingOlder.set(true);
      return from(this.matrix.instance.scrollback(room, SCROLLBACK));
    }).pipe(
      tap(() => {
        this.refresh();
        this._loadingOlder.set(false);
      }),
      map(() => void 0),
    );
  }

  private refresh(): void {
    const room = this.room;
    if (!room) {
      return;
    }
    const client = this.matrix.instance;
    const liveTimeline = room.getLiveTimeline();
    this._messages.set(
      liveTimeline
        .getEvents()
        .filter((e) => e.getType() === EventType.RoomMessage)
        .map((e) => this.toMessage(client, room, e)),
    );
    this._canLoadOlder.set(
      liveTimeline.getPaginationToken(Direction.Backward) !== null,
    );
  }

  private toMessage(
    client: MatrixClient,
    room: Room,
    event: MatrixEvent,
  ): MessageView {
    const senderId = event.getSender() ?? '';
    const member = room.getMember(senderId);
    const senderName = member?.name ?? senderId;
    const decryptionFailed = event.isDecryptionFailure();
    const { body, kind } = renderBody(event, decryptionFailed);
    return {
      id: event.getId() ?? '',
      senderId,
      senderName,
      senderInitial: initialOf(senderName),
      senderAvatarUrl:
        member?.getAvatarUrl(
          client.baseUrl,
          AVATAR_PX,
          AVATAR_PX,
          'crop',
          false,
          false,
        ) ?? null,
      body,
      timestamp: event.getTs(),
      isOwn: senderId === client.getUserId(),
      decryptionFailed,
      kind,
    };
  }
}

function renderBody(
  event: MatrixEvent,
  decryptionFailed: boolean,
): { body: string; kind: MessageKind } {
  if (decryptionFailed) {
    return { body: '⚠️ Unable to decrypt this message', kind: 'unsupported' };
  }
  if (event.isRedacted()) {
    return { body: '(message deleted)', kind: 'redacted' };
  }
  const content = event.getContent();
  const text = (content['body'] as string) ?? '';
  switch (content.msgtype) {
    case MsgType.Text:
      return { body: text, kind: 'text' };
    case MsgType.Emote:
      return { body: text, kind: 'emote' };
    case MsgType.Notice:
      return { body: text, kind: 'notice' };
    case MsgType.Image:
      return { body: '[image]', kind: 'unsupported' };
    case MsgType.File:
      return { body: '[file]', kind: 'unsupported' };
    case MsgType.Audio:
      return { body: '[audio]', kind: 'unsupported' };
    case MsgType.Video:
      return { body: '[video]', kind: 'unsupported' };
    default:
      return { body: text || '[unsupported message]', kind: 'unsupported' };
  }
}

/** First visible character (sans leading sigil), uppercased, for fallback avatars. */
function initialOf(name: string): string {
  const stripped = name.replace(/^[#@!]+/, '').trim();
  return (stripped[0] ?? '?').toUpperCase();
}
