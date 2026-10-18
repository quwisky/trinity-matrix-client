import {
  NotificationCountType,
  type MatrixEvent,
  type Room,
  type Thread,
} from 'matrix-js-sdk';
import { initialOf } from '@trinity/util/matrix';
import { shownContent } from './shields';
import type { ThreadParticipant } from './conversation-threads';

/** Most participant avatars shown in a summary cluster before "+N". */
const MAX_PARTICIPANTS = 8;

/**
 * A compact fingerprint of every input {@link ThreadsService.summaryFor} reads that can
 * change for a thread: its reply count (also tracks new participants), its root and
 * latest-reply events (id/timestamp/redaction/decryption/body/sender + resolved name, so
 * edits and redactions are caught) and its unread counts. The summary is rebuilt only
 * when this changes.
 */
export function threadSummaryRevision(room: Room, thread: Thread): string {
  const latest = thread.replyToEvent;
  const unread = threadUnread(room, thread.id);
  return [
    thread.id,
    String(thread.length),
    threadEventSignature(room, thread.rootEvent ?? null),
    // The SDK falls back to the root when every reply is redacted; mirror
    // summaryFor and treat that as "no latest reply".
    latest && latest.getId() !== thread.id
      ? threadEventSignature(room, latest)
      : '',
    String(unread.count),
    unread.highlight ? '1' : '0',
  ].join('\x1f');
}

/** Signature of a thread root/reply event for {@link threadSummaryRevision}. */
function threadEventSignature(room: Room, event: MatrixEvent | null): string {
  if (!event) {
    return '';
  }
  const sender = event.getSender() ?? '';
  return [
    event.getId() ?? '',
    String(event.getTs()),
    event.isRedacted() ? 'r' : '',
    event.isDecryptionFailure() ? 'd' : '',
    String(shownContent(event)['body'] ?? ''),
    sender,
    room.getMember(sender)?.name ?? sender,
  ].join('\x02');
}

/**
 * A thread's unread notification counts, defensively read. A server/SDK that
 * doesn't expose per-thread counts (older homeserver, missing API) must yield a
 * read state rather than throw.
 */
export function threadUnread(
  room: Room,
  threadId: string,
): { count: number; highlight: boolean } {
  try {
    const total = room.getThreadUnreadNotificationCount(
      threadId,
      NotificationCountType.Total,
    );
    const highlight = room.getThreadUnreadNotificationCount(
      threadId,
      NotificationCountType.Highlight,
    );
    return { count: total, highlight: highlight > 0 };
  } catch {
    return { count: 0, highlight: false };
  }
}

/** Distinct senders of a thread's loaded events (root + replies), capped. */
export function participantsOf(
  room: Room,
  thread: Thread,
): ThreadParticipant[] {
  const participants: ThreadParticipant[] = [];
  const seen = new Set<string>();
  const events = [
    ...(thread.rootEvent ? [thread.rootEvent] : []),
    ...thread.events,
  ];
  for (const event of events) {
    const id = event.getSender();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const member = room.getMember(id);
    const name = member?.name ?? id;
    participants.push({
      id,
      name,
      initial: initialOf(name),
      avatarMxc: member?.getMxcAvatarUrl() ?? null,
    });
    if (participants.length >= MAX_PARTICIPANTS) {
      break;
    }
  }
  return participants;
}
