import { Injectable, inject } from '@angular/core';
import {
  Direction,
  EventType,
  RelationType,
  type MatrixClient,
  type MatrixEvent,
} from 'matrix-js-sdk';
import { Observable, defer, from, map } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  buildEditRevisions,
  type MessageRevisionView,
} from '@trinity/util/matrix';

/** Every version of a message we could fetch, and whether that was all of them. */
export interface EditHistoryResult {
  /** Oldest first: the original, then each edit. */
  revisions: MessageRevisionView[];
  /** True when the message has more revisions than we fetched — say so, don't imply
   *  the list is complete. */
  truncated: boolean;
}

/** Revisions per request; the endpoint's own cap is higher, this keeps a page small. */
const PAGE_SIZE = 50;
/** Stop after this many pages. 500 revisions of one message is already pathological. */
const MAX_PAGES = 10;

/**
 * Fetches the edit history of a message: its `m.replace` relations, projected into
 * {@link MessageRevisionView}s by {@link buildEditRevisions}.
 *
 * Sits beside {@link TimelineService} rather than inside it — the timeline is already
 * past the file-size threshold, and this is a one-shot fetch with no state of its own,
 * so there is nothing to share but the client.
 */
@Injectable({ providedIn: 'root' })
export class EditHistoryService {
  private readonly matrix = inject(MatrixClientService);

  /**
   * The versions of `eventId`, oldest first. Cold — runs on subscribe, no caching: a
   * message can be edited again while the dialog is open, and history is only ever
   * fetched because the user asked to see it.
   */
  revisions(roomId: string, eventId: string): Observable<EditHistoryResult> {
    return defer(() => from(this.fetchRevisions(roomId, eventId)));
  }

  private async fetchRevisions(
    roomId: string,
    eventId: string,
  ): Promise<EditHistoryResult> {
    if (!this.matrix.isInitialized) {
      throw new Error('Not connected — try again in a moment.');
    }
    const client = this.matrix.instance;

    const edits: MatrixEvent[] = [];
    let original: MatrixEvent | null = null;
    let from: string | undefined;
    let pages = 0;

    do {
      // EventType.RoomMessage is load-bearing, not decoration: the SDK only decrypts the
      // relation chunk when it was asked for a *specific* event type (it resolves that to
      // m.room.encrypted for an encrypted room). Pass null here and an encrypted room
      // hands back ciphertext that no rule below can read.
      const page = await client.relations(
        roomId,
        eventId,
        RelationType.Replace,
        EventType.RoomMessage,
        { dir: Direction.Backward, limit: PAGE_SIZE, from },
      );
      original ??= page.originalEvent ?? null;
      edits.push(...page.events);
      from = page.nextBatch ?? undefined;
      pages++;
    } while (from && pages < MAX_PAGES);

    // The SDK resolves the original itself, but only via a /event round trip that can
    // come back empty; fall back to the copy already in the timeline.
    original ??= client.getRoom(roomId)?.findEventById(eventId) ?? null;
    if (!original) {
      throw new Error('That message could not be loaded.');
    }
    // Deleting a message doesn't delete its edits server-side, so this is a real state,
    // not a defensive one. Refuse it here as well as in the UI: the row's "edited" flag
    // survives a redaction that arrived from the server, so the affordance can outlive
    // the message it belongs to.
    if (original.isRedacted()) {
      throw new Error('This message was deleted.');
    }

    this.repairAggregation(client, roomId, eventId, edits);

    return {
      revisions: buildEditRevisions(original, edits, client.getUserId()),
      truncated: !!from,
    };
  }

  /**
   * Point the room's own copy of the message at the newest surviving edit.
   *
   * Redacting an edit leaves matrix-js-sdk's in-memory aggregation wrong: it re-resolves
   * the message by filtering relations against a timestamp taken from the ORIGINAL
   * event's bundle, which the redaction never refreshes, so the message falls all the way
   * back to its first wording and stops counting as edited. Measured against a live
   * server: remove the newest of two edits and the timeline showed the original, while a
   * cold reload of the same room showed the correct middle version — the server was right
   * and only the client's cache was stale.
   *
   * We have just fetched the surviving edits, so we already know the right answer; this
   * applies it. `makeReplaced` is what the SDK's own relation handling calls, and it
   * emits `MatrixEventEvent.Replaced`, which the timeline listens for.
   */
  private repairAggregation(
    client: MatrixClient,
    roomId: string,
    eventId: string,
    edits: readonly MatrixEvent[],
  ): void {
    const target = client.getRoom(roomId)?.findEventById(eventId);
    if (!target) {
      return; // not in a loaded timeline — nothing on screen to correct
    }
    const newest = edits
      .filter(
        (edit) =>
          !edit.isRedacted() &&
          edit.getType() === EventType.RoomMessage &&
          edit.getSender() === target.getSender() &&
          edit.status === null,
      )
      .reduce<MatrixEvent | null>(
        (latest, edit) =>
          !latest || edit.getTs() > latest.getTs() ? edit : latest,
        null,
      );

    if (
      (target.replacingEvent()?.getId() ?? null) === (newest?.getId() ?? null)
    ) {
      return; // already correct; don't emit a pointless re-render
    }
    target.makeReplaced(newest ?? undefined);
  }

  /**
   * Remove one earlier version of a message by redacting the `m.replace` event that
   * introduced it. Unlike {@link TimelineService.redact} this takes the room explicitly
   * rather than reading the active room: the dialog outlives a room switch, and a
   * redaction that quietly sent nothing would look exactly like one that worked.
   *
   * Only ever called for a revision the user sent. Removing the NEWEST edit leaves the
   * SDK aggregating the message back to its ORIGINAL wording, so the caller re-reads the
   * history afterwards — not for the list's sake but because that read runs
   * {@link repairAggregation}, which is what actually puts the timeline right. Re-fetching
   * alone does not: measured, the row stayed on the original until a cold reload.
   */
  removeRevision(roomId: string, revisionId: string): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        throw new Error('Not connected — try again in a moment.');
      }
      return from(this.matrix.instance.redactEvent(roomId, revisionId)).pipe(
        map(() => void 0),
      );
    });
  }
}
