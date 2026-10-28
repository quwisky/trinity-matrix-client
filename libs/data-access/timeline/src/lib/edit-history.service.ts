import { Injectable, inject } from '@angular/core';
import { Observable, defer, map } from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import {
  EngineRequestError,
  UNDECRYPTABLE_BODY,
  mentionNamesIn,
  renderNormalizedTextBody,
  type EngineFailure,
  type MessageRevisionView,
} from '@trinity/util/matrix';
import type { Revision } from './conversation-content-engine';
import { CONVERSATION_CONTENT_ENGINE } from './conversation-content-engine.token';
import type { MessageShield } from './message-presentation';
import { unencryptedShield } from './shield-presentation';
import { profileName } from './timeline-item-presentation';

/** One version of a message, with the unencrypted mark for its own text. */
export interface EditRevisionView extends MessageRevisionView {
  shield: MessageShield | null;
}

/** Every version of a message we could fetch, and whether that was all of them. */
export interface EditHistoryResult {
  /** Oldest first: the original, then each edit. */
  revisions: EditRevisionView[];
  /** True when the message has more revisions than we fetched — say so, don't imply
   *  the list is complete. */
  truncated: boolean;
}

/** Stop after this many pages. 500 revisions of one message is already pathological. */
const MAX_PAGES = 10;

const NOT_CONNECTED = 'Not connected — try again in a moment.';

function failureError(failure: EngineFailure): Error {
  switch (failure.code) {
    case 'account-not-live':
      return new Error(NOT_CONNECTED);
    case 'message-unavailable':
      return new Error('That message could not be loaded.');
    default:
      return new EngineRequestError(failure);
  }
}

function view(revision: Revision, isOwn: boolean): EditRevisionView {
  const shield = unencryptedShield(revision.unencryptedMark);
  if (revision.kind === 'undecryptable') {
    return {
      id: revision.eventId,
      timestamp: revision.ts,
      body: UNDECRYPTABLE_BODY,
      html: null,
      kind: 'undecryptable',
      isOwn,
      shield,
    };
  }
  // `isReply: false`: an edit carries no reply fallback; the reply relation lives on the
  // original event, whose body was already stripped when rendered.
  const { text, textHtml } = renderNormalizedTextBody(
    revision.body,
    revision.html,
    false,
    false,
    mentionNamesIn(revision.html, (id) =>
      profileName(id, revision.profiles[id]),
    ),
  );
  return {
    id: revision.eventId,
    timestamp: revision.ts,
    body: text,
    html: textHtml,
    kind: 'text',
    isOwn,
    shield,
  };
}

/**
 * Fetches the edit history of a message for the active account, rendered for the
 * edit-history view. A one-shot fetch with no state of its own.
 */
@Injectable({ providedIn: 'root' })
export class EditHistoryService {
  private readonly engine = inject(CONVERSATION_CONTENT_ENGINE);
  private readonly session = inject(SessionStateService);

  /**
   * The versions of `eventId`, oldest first. Cold — runs on subscribe, no caching: a
   * message can be edited again while the dialog is open, and history is only ever
   * fetched because the user asked to see it.
   */
  revisions(roomId: string, eventId: string): Observable<EditHistoryResult> {
    return defer(() => {
      const accountId = this.accountId();
      return this.engine
        .editHistory(accountId, roomId, eventId, { maxPages: MAX_PAGES })
        .pipe(
          map((result) => {
            if (!result.ok) throw failureError(result.failure);
            const { revisions, truncated } = result.value;
            // Deleting a message doesn't delete its edits server-side; the engine lists
            // none, and the row's "edited" flag can outlive the message, so say why.
            if (revisions.length === 0) {
              throw new Error('This message was deleted.');
            }
            // Every listed edit shares the original's sender, so one check covers all.
            const isOwn = revisions[0].sender === accountId;
            return {
              revisions: revisions.map((revision) => view(revision, isOwn)),
              truncated,
            };
          }),
        );
    });
  }

  /**
   * Remove one earlier version of a message by redacting the `m.replace` event that
   * introduced it. Takes the room explicitly: the dialog outlives a room switch.
   *
   * Only ever called for a revision the user sent. Removing the NEWEST edit leaves the SDK
   * aggregating the message back to its ORIGINAL wording, so the caller re-reads the
   * history afterwards, which repairs the timeline.
   */
  removeRevision(roomId: string, revisionId: string): Observable<void> {
    return defer(() =>
      this.engine.removeRevision(this.accountId(), roomId, revisionId),
    ).pipe(
      map((result) => {
        if (!result.ok) throw failureError(result.failure);
      }),
    );
  }

  private accountId(): string {
    const accountId = this.session.activeAccountId();
    if (!accountId) throw new Error(NOT_CONNECTED);
    return accountId;
  }
}
