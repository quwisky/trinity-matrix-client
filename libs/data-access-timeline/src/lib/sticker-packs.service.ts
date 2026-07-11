import { Injectable, inject } from '@angular/core';
import { KnownMembership } from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import {
  ROOM_EMOTES_EVENT,
  USER_EMOTES_EVENT,
  parseStickerPack,
  type StickerPack,
} from '@trinity/util-matrix';

/**
 * Reads the MSC2545 image packs available for sending stickers: the user's personal
 * pack (`im.ponies.user_emotes` account data) plus every joined room's pack(s)
 * (`im.ponies.room_emotes` room state, one per state key). Packs are near-static
 * session config, so this reads current client state on demand rather than projecting
 * a live signal — the picker calls {@link packs} each time it opens, always seeing the
 * latest synced state without any listener lifecycle to manage.
 */
@Injectable({ providedIn: 'root' })
export class StickerPacksService {
  private readonly matrix = inject(MatrixClientService);

  /**
   * Every sticker-usable pack available to the user, personal pack first then room
   * packs. Empty when not signed in or when no pack declares a sticker image.
   */
  packs(): StickerPack[] {
    if (!this.matrix.isInitialized) {
      return [];
    }
    const client = this.matrix.instance;
    const packs: StickerPack[] = [];

    const personal = parseStickerPack(
      // The event type is a custom (MSC2545) string the SDK's account-data key union
      // doesn't model; cast so it type-checks like the poll/sticker send paths.
      client.getAccountData(USER_EMOTES_EVENT as never)?.getContent(),
      'user',
      'Your stickers',
    );
    if (personal) {
      packs.push(personal);
    }

    for (const room of client.getRooms()) {
      if (room.getMyMembership() !== KnownMembership.Join) {
        continue;
      }
      for (const event of room.currentState.getStateEvents(ROOM_EMOTES_EVENT)) {
        const pack = parseStickerPack(
          event.getContent(),
          `${room.roomId}|${event.getStateKey() ?? ''}`,
          room.name,
        );
        if (pack) {
          packs.push(pack);
        }
      }
    }
    return packs;
  }

  /** Whether any sticker is available (gates the composer's sticker button). */
  hasStickers(): boolean {
    return this.packs().length > 0;
  }
}
