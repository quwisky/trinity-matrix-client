import {
  M_POLL_END,
  M_POLL_RESPONSE,
  M_POLL_START,
  M_TEXT,
  RelationType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import {
  arrivedInClear,
  displayContent,
  liveRoomState,
  type PollOption,
  type PollView,
} from '@trinity/util/matrix';

/**
 * Cap on poll options we project/render. MSC3381 limits a poll to 20 answers; a malicious
 * `m.poll.start` could otherwise carry an unbounded array (one rendered row each).
 */
const MAX_POLL_ANSWERS = 20;

/** Both namespaces (unstable `.name`, stable `.altName`) of an extensible type. */
const RESPONSE_TYPES = [M_POLL_RESPONSE.name, M_POLL_RESPONSE.altName];
const END_TYPES = [M_POLL_END.name, M_POLL_END.altName];

/** Whether an event starts a poll (either the stable or unstable type). */
export function isPollStart(event: MatrixEvent): boolean {
  return M_POLL_START.matches(event.getType());
}

/** Read extensible text (`m.text` / unstable / `body`) from a content object. */
function extensibleText(obj: Record<string, unknown> | undefined): string {
  if (!obj) {
    return '';
  }
  return (
    (obj[M_TEXT.name] as string) ??
    (obj[M_TEXT.altName] as string) ??
    (obj['body'] as string) ??
    ''
  );
}

/** The `m.poll.start` subtype from a start event's content (either namespace). */
function startSubtype(
  content: Record<string, unknown>,
): Record<string, unknown> | null {
  return (
    (content[M_POLL_START.name] as Record<string, unknown>) ??
    (content[M_POLL_START.altName] as Record<string, unknown>) ??
    null
  );
}

/** The raw answer ids of a poll response event (empty for a blank or malformed vote). */
function responseAnswers(event: MatrixEvent): string[] {
  const content = displayContent(event);
  const sub = (content[M_POLL_RESPONSE.name] ??
    content[M_POLL_RESPONSE.altName]) as { answers?: unknown } | undefined;
  const answers = sub?.answers;
  return Array.isArray(answers) ? answers.map(String) : [];
}

/**
 * A poll's `max_selections` as a whole number in `[1, answerCount]`; anything else
 * (absent, non-numeric, below 1) means single-select, as matrix-js-sdk treats it.
 */
function maxSelectionsOf(raw: unknown, answerCount: number): number {
  return Number.isInteger(raw) && (raw as number) > 0
    ? Math.min(raw as number, Math.max(answerCount, 1))
    : 1;
}

/** All child events of `pollId` for the given reference sub-types (stable + unstable). */
function referenceRelations(
  room: Room,
  pollId: string,
  types: readonly string[],
): MatrixEvent[] {
  const out: MatrixEvent[] = [];
  for (const type of types) {
    const relations = room.relations?.getChildEventsForEvent(
      pollId,
      RelationType.Reference,
      type,
    );
    if (relations) {
      out.push(...relations.getRelations());
    }
  }
  return out;
}

/** Counted end events whose sender may end the poll. */
function validEnds(
  room: Room,
  startEvent: MatrixEvent,
  roomEncrypted: boolean,
): MatrixEvent[] {
  return countedRelations(
    room,
    startEvent.getId() ?? '',
    END_TYPES,
    roomEncrypted,
  ).filter((end) => {
    const sender = end.getSender();
    return (
      !!sender &&
      (sender === startEvent.getSender() ||
        liveRoomState(room)?.maySendRedactionForEvent(startEvent, sender))
    );
  });
}

/**
 * When the poll was closed: the earliest valid end event, else infinity. Whether a sender
 * may end the poll is judged on the room's current state, as matrix-js-sdk's own poll end
 * validation does, so a power-level or membership change can reopen or close a poll.
 */
function pollEndTs(
  room: Room,
  startEvent: MatrixEvent,
  roomEncrypted: boolean,
): number {
  return validEnds(room, startEvent, roomEncrypted).reduce(
    (min, end) => Math.min(min, end.getTs()),
    Number.POSITIVE_INFINITY,
  );
}

/** Everyone who sent a live end event, valid or not: their standing decides the poll's state. */
export function pollEndSenders(room: Room, startEvent: MatrixEvent): string[] {
  return referenceRelations(room, startEvent.getId() ?? '', END_TYPES)
    .filter((end) => !end.isRedacted())
    .flatMap((end) => end.getSender() ?? []);
}

/**
 * Project a poll-start event into a {@link PollView}, tallying each voter's latest response
 * cast before any end event. As in matrix-js-sdk, a response naming any unknown answer id is
 * spoiled, a valid one is de-duplicated and truncated to `max_selections`, and a spoiled or
 * empty latest response withdraws the voter's earlier vote.
 */
export function buildPollView(
  client: MatrixClient,
  room: Room,
  startEvent: MatrixEvent,
  roomEncrypted: boolean,
  startContent: Record<string, unknown> = displayContent(startEvent),
): PollView {
  const pollId = startEvent.getId() ?? '';
  const subtype = startSubtype(startContent);
  const question = extensibleText(
    subtype?.['question'] as Record<string, unknown> | undefined,
  );
  // `answers` is attacker-controlled event content: it must be an array (a scalar would
  // throw on `.map` and, as the timeline projection isn't individually guarded, crash the
  // whole room), and it's capped so a huge array can't drive unbounded rendering.
  const rawAnswers = subtype?.['answers'];
  const answers = (
    Array.isArray(rawAnswers) ? rawAnswers.slice(0, MAX_POLL_ANSWERS) : []
  ) as Array<Record<string, unknown>>;
  const optionIds = new Set(
    answers.map((a) =>
      String((a && typeof a === 'object' ? a['id'] : undefined) ?? ''),
    ),
  );
  const maxSelections = maxSelectionsOf(
    subtype?.['max_selections'],
    answers.length,
  );

  const endTs = pollEndTs(room, startEvent, roomEncrypted);
  const ended = endTs !== Number.POSITIVE_INFINITY;

  // Each voter's latest response, ignoring post-close votes.
  const latest = new Map<string, { ts: number; answers: string[] }>();
  for (const event of countedRelations(
    room,
    pollId,
    RESPONSE_TYPES,
    roomEncrypted,
  )) {
    if (ended && event.getTs() > endTs) {
      continue;
    }
    const sender = event.getSender() ?? '';
    const prev = latest.get(sender);
    if (!prev || event.getTs() > prev.ts) {
      latest.set(sender, {
        ts: event.getTs(),
        answers: responseAnswers(event),
      });
    }
  }

  const counts = new Map<string, number>();
  let voters = 0;
  let mine = new Set<string>();
  for (const [sender, { answers: raw }] of latest) {
    if (raw.length === 0 || raw.some((id) => !optionIds.has(id))) {
      continue; // blank or spoiled vote
    }
    const chosen = new Set([...new Set(raw)].slice(0, maxSelections));
    voters++;
    for (const id of chosen) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    if (sender === client.getUserId()) {
      mine = chosen;
    }
  }

  const options: PollOption[] = answers.map((answer) => {
    const id = String(answer['id'] ?? '');
    return {
      id,
      text: extensibleText(answer),
      votes: counts.get(id) ?? 0,
      chosen: mine.has(id),
    };
  });

  return {
    id: pollId,
    question,
    options,
    totalVotes: voters,
    maxSelections,
    ended,
  };
}

/**
 * The responses or end events a poll counts: unredacted ones, and in an encrypted room only
 * those that arrived encrypted, since any server taking part could send an unencrypted vote
 * or end in a member's name. {@link buildPollView} and {@link pollSignature} both read this,
 * so the re-projection key moves whenever the tally would.
 */
function countedRelations(
  room: Room,
  pollId: string,
  types: readonly string[],
  roomEncrypted: boolean,
): MatrixEvent[] {
  return referenceRelations(room, pollId, types).filter(
    (e) => !e.isRedacted() && !(roomEncrypted && arrivedInClear(e)),
  );
}

/** Fingerprint of a poll's counted responses and end events, for the timeline's re-projection cache. */
export function pollSignature(
  room: Room,
  startEvent: MatrixEvent,
  roomEncrypted: boolean,
): string {
  const pollId = startEvent.getId() ?? '';
  const responses = countedRelations(
    room,
    pollId,
    RESPONSE_TYPES,
    roomEncrypted,
  )
    .map((e) => `${e.getSender()}:${responseAnswers(e).join(',')}:${e.getTs()}`)
    .sort();
  // Every valid end, not just the earliest: which one closes the poll changes when an end
  // is redacted, arrives out of order, stops counting, or its sender loses the power to end it.
  const ends = validEnds(room, startEvent, roomEncrypted)
    .map((e) => `end:${e.getId()}:${e.getTs()}`)
    .sort();
  return [...responses, ...ends].join('|');
}
