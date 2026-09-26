import assert from 'node:assert/strict';

export const MESSAGE_FORWARD_ASSERTIONS = [
  'message-forward.source-room-ready',
  'message-forward.source-row-visible',
  'message-forward.source-server-ready',
  'message-forward.sheet-ready',
  'message-forward.picker-visible',
  'message-forward.target-room-ready',
  'message-forward.target-row-and-event',
] as const;

export type MessageForwardAssertion = (typeof MESSAGE_FORWARD_ASSERTIONS)[number];

interface EventExpectation {
  readonly roomId: string;
  readonly sender: string;
  readonly body: string;
}

export interface SourceEventExpectation extends EventExpectation {
  readonly eventId: string;
}

export interface TargetEventExpectation extends EventExpectation {
  readonly sourceEventId: string;
}

export interface ForwardPickerResult {
  readonly title: string;
  readonly kind: string;
  readonly visible: boolean;
}

export interface ForwardVisibleTarget {
  readonly visible: boolean;
}

function eventContent(
  event: Readonly<Record<string, unknown>>,
  expected: EventExpectation,
): Readonly<Record<string, unknown>> {
  assert.equal(event['room_id'], expected.roomId, 'Event belongs to the exact Room');
  assert.equal(event['sender'], expected.sender, 'Event has the active sender');
  const content = event['content'];
  assert(content !== null && typeof content === 'object' && !Array.isArray(content),
    'Event has object content');
  const fields = content as Readonly<Record<string, unknown>>;
  assert.equal(fields['body'], expected.body, 'Event has the exact message body');
  assert.equal(fields['msgtype'], 'm.text', 'Event is a text message');
  return fields;
}

export function assertForwardRecords(actual: readonly string[]): void {
  assert.equal(new Set(actual).size, 7, 'Seven unique forward identities');
  assert.deepEqual(actual, MESSAGE_FORWARD_ASSERTIONS, 'Forward identities retain source order');
}

export function assertForwardRoomRoute(
  actualUrl: string,
  roomId: string,
  userId: string,
): void {
  const route = new URL(actualUrl);
  assert.equal(route.pathname, `/rooms/${Buffer.from(roomId).toString('base64url')}`,
    'Native navigation reached the exact Room');
  assert.equal(route.searchParams.get('account'), userId,
    'Native navigation retained the active account');
  assert.equal(route.searchParams.get('view'), 'rooms',
    'Native navigation retained the Rooms view');
}

export function assertReadySourceEvent(
  event: Readonly<Record<string, unknown>>,
  expected: SourceEventExpectation,
): void {
  const eventId = event['event_id'];
  assert(typeof eventId === 'string' && eventId.startsWith('$'),
    'Source event has a real Matrix event id');
  assert.equal(eventId, expected.eventId, 'Server source event matches the reconciled row');
  eventContent(event, expected);
}

export function assertForwardTargetEvent(
  event: Readonly<Record<string, unknown>>,
  expected: TargetEventExpectation,
): void {
  const eventId = event['event_id'];
  assert(typeof eventId === 'string' && eventId.startsWith('$'),
    'Target event has a real Matrix event id');
  assert.notEqual(eventId, expected.sourceEventId,
    'Forward created a distinct target event');
  const content = eventContent(event, expected);
  assert(!('m.relates_to' in content), 'Forward has no stale source relation');
  assert(!('m.new_content' in content), 'Forward has no stale edit content');
}

export function assertExactPickerResult(
  results: readonly ForwardPickerResult[],
  targetName: string,
): void {
  assert.equal(results.length, 1, 'Picker has exactly one result');
  assert.equal(results[0]?.title, targetName, 'Picker title matches exact target Room');
  assert.equal(results[0]?.kind, 'Room', 'Picker result is a Room');
  assert.equal(results[0]?.visible, true, 'Picker result is visible');
}

export function assertNativeSheetReady(
  dialogs: readonly ForwardVisibleTarget[],
  forwardActions: readonly ForwardVisibleTarget[],
): void {
  assert.equal(dialogs.length, 1, 'Exactly one Android message-action sheet');
  assert.equal(dialogs[0]?.visible, true, 'Android action sheet is visible');
  assert.equal(forwardActions.length, 1, 'Exactly one Forward action');
  assert.equal(forwardActions[0]?.visible, true, 'Forward action is visible');
}
