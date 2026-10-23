import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
import {
  displayContent,
  isPollStart,
  linkedUserIds,
  pollSignature,
  reactionsFor,
  readReceiptsFor,
  unencryptedMarkFor,
  validReplacement,
} from '@trinity/util/matrix';
import { shownContent, shownSubject, showsEdit } from './shields';

/**
 * Each content object's JSON, kept while the object lives, so a row re-checked for another
 * reason (receipt, member, shield) doesn't serialise an unchanged body again. The SDK
 * replaces content rather than mutating it (decryption, edit, remote echo), except a
 * redaction, which empties it in place: a redacted event drops its entry and is serialised
 * afresh, so the deleted text is neither kept here nor stored again in its row.
 */
const contentJson = new WeakMap<object, string>();

function contentSignature(event: MatrixEvent, applyEdit: boolean): string {
  const content = applyEdit
    ? displayContent(event)
    : event.getOriginalContent();
  if (event.isRedacted()) {
    contentJson.delete(content);
    return JSON.stringify(content);
  }
  let json = contentJson.get(content);
  if (json === undefined) {
    json = JSON.stringify(content);
    contentJson.set(content, json);
  }
  return json;
}

/** A row's fingerprint in two parts, so its body's JSON is the memoised string, not a copy. */
export interface EventRevision {
  /** The effective content (edits and decryption applied) as JSON. */
  readonly content: string;
  /** Every other input; see {@link eventRevision}. */
  readonly rest: string;
}

/**
 * A compact fingerprint of every per-event input Message Presentation reads that can change
 * while the room is open: send status, redaction, decryption, edits (effective content plus
 * replacing-event presence), aggregated reactions, the reply preview (see
 * {@link replyTargetSignature}), the poll tally `roomEncrypted` decides (see `buildPollView`),
 * the mention pills' resolved names and the sender's resolved name/avatar. A view is rebuilt
 * only when this changes, so an unchanged message keeps its object and its OnPush row is
 * never touched.
 */
export function eventRevision(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
  roomEncrypted: boolean,
): string {
  const { content, rest } = revisionOf(client, room, event, roomEncrypted);
  return content + '\x1f' + rest;
}

/** {@link eventRevision} in its two parts. */
export function revisionOf(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
  roomEncrypted: boolean,
): EventRevision {
  // As the row shows it: an encrypted edit counts only once its own shield has resolved.
  const applyEdit = showsEdit(event);
  const senderId = event.getSender() ?? '';
  const member = room.getMember(senderId);
  return {
    // Effective content captures edits (m.replace) and decrypted bodies; it is far
    // cheaper than the DOMPurify pass that a rebuild would otherwise repeat.
    content: contentSignature(event, applyEdit),
    rest: [
      event.status ?? '',
      event.isRedacted() ? 'r' : '',
      event.isDecryptionFailure() ? 'd' : '',
      // A new failure reason (after a reload or a key-backup change) changes the row's text.
      event.decryptionFailureReason ?? '',
      applyEdit && validReplacement(event) ? 'e' : '',
      reactionSignature(client, room, event),
      replyTargetSignature(room, event.replyEventId, roomEncrypted),
      mentionSignature(room, event),
      member?.name ?? senderId,
      member?.getMxcAvatarUrl() ?? '',
      receiptSignature(client, room, event),
      isPollStart(event) ? pollSignature(room, event, roomEncrypted) : '',
    ].join('\x1f'),
  };
}

/** The users each content object's mention pills link to; see {@link contentJson}. */
const contentMentions = new WeakMap<object, readonly string[]>();

/**
 * Signature of the mention pills for {@link eventRevision}: each linked user and their resolved
 * name, so a pill re-renders when a member's profile arrives late or they rename.
 */
function mentionSignature(room: Room, event: MatrixEvent): string {
  const content = shownContent(event);
  let ids = event.isRedacted() ? [] : contentMentions.get(content);
  if (ids === undefined) {
    ids = linkedUserIds(
      content['format'] === 'org.matrix.custom.html' &&
        typeof content['formatted_body'] === 'string'
        ? content['formatted_body']
        : null,
    );
    contentMentions.set(content, ids);
  }
  return ids
    .map((userId) => `${userId}\x03${room.getMember(userId)?.name ?? ''}`)
    .join(',');
}

/**
 * Signature of the "seen by" receipts for {@link eventRevision}: who has read up to this
 * event and each reader's resolved name and avatar. Ids alone are not enough: a reader
 * whose profile arrives late gives an identical id list, so the memoised view is returned
 * verbatim and their receipt keeps a coloured initial.
 */
function receiptSignature(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): string {
  return readReceiptsFor(client, room, event)
    .map((receipt) =>
      [receipt.userId, receipt.name, receipt.avatarMxc ?? ''].join('\x03'),
    )
    .join(',');
}

/**
 * Signature of a reply's quoted target for {@link eventRevision}: empty when the event
 * isn't a reply, `'n'` while the target isn't loaded, else its redaction, body and the
 * quoted sender's resolved name + avatar, so the preview re-projects when the quoted
 * member's profile arrives late (lazy loading), and the not-encrypted mark its text carries.
 */
function replyTargetSignature(
  room: Room,
  replyId: string | undefined,
  roomEncrypted: boolean,
): string {
  if (!replyId) {
    return '';
  }
  const target = room.findEventById(replyId);
  if (!target) {
    return 'n';
  }
  const sender = target.getSender() ?? '';
  const member = room.getMember(sender);
  return [
    'y',
    target.isRedacted() ? 'r' : '',
    String(shownContent(target)['body'] ?? ''),
    member?.name || sender,
    member?.getMxcAvatarUrl() ?? '',
    (!target.isRedacted() &&
      unencryptedMarkFor(room, roomEncrypted)(target, shownSubject(target))) ||
      '',
  ].join('\x02');
}

/**
 * Stable signature of an event's aggregated reactions (key, count, own flag) plus the
 * reactor names the pill shows. Names resolve late (lazy member loading); without them the
 * cached view is reused and the pill keeps naming a raw mxid. The list is capped at
 * projection time (`MAX_NAMED_REACTORS`), which bounds this on a heavily-reacted message.
 */
function reactionSignature(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): string {
  return reactionsFor(client, room, event)
    .map(
      (r) =>
        `${r.key}:${r.count}:${r.reacted ? 1 : 0}:${r.reactors.join('\x03')}`,
    )
    .join(',');
}
