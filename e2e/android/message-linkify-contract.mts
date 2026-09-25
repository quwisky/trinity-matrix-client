import assert from 'node:assert/strict';

export const MESSAGE_LINKIFY_BODY = 'look at https://example.com';
export const MESSAGE_LINKIFY_URL = 'https://example.com';

export const MESSAGE_LINKIFY_ASSERTIONS = [
  'message-linkify.room-ready',
  'message-linkify.link-visible',
] as const;

export type MessageLinkifyAssertion =
  (typeof MESSAGE_LINKIFY_ASSERTIONS)[number];

export interface LinkifyEventExpectation {
  readonly eventId: string;
  readonly roomId: string;
  readonly sender: string;
}

/** One read-only anchor observation from the rendered message text. */
export interface LinkifyAnchor {
  readonly text: string;
  readonly href: string | null;
  readonly visible: boolean;
}

/** Read-only renderer observation of the one sent row and the whole timeline. */
export interface LinkifyRendering {
  readonly rowCount: number;
  readonly rowId: string;
  readonly rowVisible: boolean;
  readonly text: string;
  readonly textOutsideAnchors: string;
  readonly anchors: readonly LinkifyAnchor[];
  readonly timelineMatches: number;
}

function object(value: unknown, name: string): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value),
    `${name} is an object`);
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, name: string): string {
  const candidate = value[name];
  assert(typeof candidate === 'string', `${name} is a string`);
  return candidate;
}

function booleanField(value: Record<string, unknown>, name: string): boolean {
  const candidate = value[name];
  assert(typeof candidate === 'boolean', `${name} is a boolean`);
  return candidate;
}

function countField(value: Record<string, unknown>, name: string): number {
  const candidate = value[name];
  assert(typeof candidate === 'number' && Number.isInteger(candidate) &&
    candidate >= 0, `${name} is a nonnegative integer`);
  return candidate;
}

/** Reject incomplete CDP values before any source-mapped assertion is recorded. */
export function parseLinkifyRendering(value: unknown): LinkifyRendering {
  const rendering = object(value, 'Linkify rendering');
  const anchors = rendering['anchors'];
  assert(Array.isArray(anchors), 'Linkify anchors are an array');
  return {
    rowCount: countField(rendering, 'rowCount'),
    rowId: stringField(rendering, 'rowId'),
    rowVisible: booleanField(rendering, 'rowVisible'),
    text: stringField(rendering, 'text'),
    textOutsideAnchors: stringField(rendering, 'textOutsideAnchors'),
    anchors: anchors.map((raw: unknown, index: number): LinkifyAnchor => {
      const anchor = object(raw, `Linkify anchor ${index}`);
      const href = anchor['href'];
      assert(href === null || typeof href === 'string',
        `Linkify anchor ${index} href is a string or absent`);
      return {
        text: stringField(anchor, 'text'),
        href,
        visible: booleanField(anchor, 'visible'),
      };
    }),
    timelineMatches: countField(rendering, 'timelineMatches'),
  };
}

export function assertLinkifyRecords(actual: readonly string[]): void {
  assert.equal(actual.length, 2, 'Exactly two Android linkify records');
  assert.equal(new Set(actual).size, 2, 'Every linkify record is unique');
  assert.deepEqual(actual, MESSAGE_LINKIFY_ASSERTIONS,
    'Linkify records retain source order');
}

export function assertLinkifyRoomRoute(
  url: string,
  roomId: string,
  userId: string,
): void {
  const route = new URL(url);
  assert.equal(route.pathname,
    `/rooms/${Buffer.from(roomId).toString('base64url')}`,
    'Native navigation reached the exact Room');
  assert.equal(route.searchParams.get('account'), userId,
    'Native navigation retained the exact Account');
  assert.equal(route.searchParams.get('view'), 'rooms',
    'Native navigation retained the Rooms view');
}

/** The server event is the native send, reconciled and still plain text. */
export function assertPlainLinkifyEvent(
  event: Readonly<Record<string, unknown>>,
  expected: LinkifyEventExpectation,
): void {
  const eventId = event['event_id'];
  assert(typeof eventId === 'string' && eventId.startsWith('$'),
    'Sent event has a real Matrix event id');
  assert.equal(eventId, expected.eventId,
    'Server event matches the reconciled Room row');
  assert.equal(event['room_id'], expected.roomId, 'Event belongs to the exact Room');
  assert.equal(event['sender'], expected.sender, 'Event has the active sender');
  assert.equal(event['type'], 'm.room.message', 'Event is a Room message');
  const content = object(event['content'], 'Event content');
  assert.equal(content['msgtype'], 'm.text', 'Event is a text message');
  assert.equal(content['body'], MESSAGE_LINKIFY_BODY,
    'Event body is the exact unchanged plain text');
  assert(!('format' in content) && !('formatted_body' in content),
    'Event carries no formatted HTML; the renderer linkifies plain text');
  assert(!('m.relates_to' in content) && !('m.new_content' in content),
    'Event is an original message');
}

/** Exactly the URL substring is one visible anchor; the rest stays plain text. */
export function assertLinkifiedRendering(
  rendering: LinkifyRendering,
  eventId: string,
): void {
  assert.equal(rendering.rowCount, 1, 'Exactly one Room row carries the message');
  assert.equal(rendering.rowId, eventId, 'The row is the reconciled server event');
  assert(rendering.rowVisible, 'The sent row is visible');
  assert.equal(rendering.text.trim(), MESSAGE_LINKIFY_BODY,
    'Rendered message text is the exact body');
  assert.equal(rendering.anchors.length, 1, 'Exactly one link in the message');
  const [anchor] = rendering.anchors;
  assert.equal(anchor!.text, MESSAGE_LINKIFY_URL, 'Link text is the exact URL');
  assert.equal(anchor!.href, MESSAGE_LINKIFY_URL,
    'Link destination is the exact URL');
  assert(anchor!.visible, 'The link is visible');
  assert.equal(rendering.textOutsideAnchors.trim(), 'look at',
    'Surrounding text stays plain message content');
  assert.equal(rendering.timelineMatches, 1,
    'The timeline has exactly one matching link');
}
