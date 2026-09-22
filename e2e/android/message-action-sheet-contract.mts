import assert from 'node:assert/strict';

export const MESSAGE_ACTION_SHEET_SOURCES = {
  helpers: 'e2e/browser/journeys/conversations/message-action-sheet.spec.mts:29-143',
  touch: 'e2e/support/touch-platform.mts',
  app: 'e2e/support/app.mts',
  account: 'e2e/support/account.mts',
} as const;

export const MESSAGE_ACTION_SHEET_ASSERTION_RECORDS = 54;

export const messageActionSheetCases = [
  {
    id: 'reply',
    source: 'e2e/browser/journeys/conversations/message-action-sheet.spec.mts:151-214',
    tag: 'a',
    messageCount: 1,
    assertions: [
      'message-action-sheet.reply.room-ready',
      'message-action-sheet.reply.toolbar-absent',
      'message-action-sheet.reply.body-wide',
      'message-action-sheet.reply.sheet-visible',
      'message-action-sheet.reply.revealed-row-absent',
      'message-action-sheet.reply.single-named-dialog',
      'message-action-sheet.reply.sheet-box-present',
      'message-action-sheet.reply.clearance.sheet-present',
      'message-action-sheet.reply.clearance.row-inside-top',
      'message-action-sheet.reply.clearance.row-inside-bottom',
      'message-action-sheet.reply.clearance.eight-pixel-gap',
      'message-action-sheet.reply.sheet-top-in-viewport',
      'message-action-sheet.reply.sheet-bottom-in-viewport',
      'message-action-sheet.reply.cancel-visible',
      'message-action-sheet.reply.cancel-box-present',
      'message-action-sheet.reply.cancel-bottom-in-viewport',
      'message-action-sheet.reply.sheet-closed',
      'message-action-sheet.reply.reply-banner',
    ],
  },
  {
    id: 'quick-reaction',
    source: 'e2e/browser/journeys/conversations/message-action-sheet.spec.mts:216-239',
    tag: 'b',
    messageCount: 1,
    assertions: [
      'message-action-sheet.quick-reaction.room-ready',
      'message-action-sheet.quick-reaction.sheet-visible',
      'message-action-sheet.quick-reaction.sheet-closed',
      'message-action-sheet.quick-reaction.reaction-ready',
    ],
  },
  {
    id: 'backdrop-dismiss',
    source: 'e2e/browser/journeys/conversations/message-action-sheet.spec.mts:241-259',
    tag: 'c',
    messageCount: 1,
    assertions: [
      'message-action-sheet.backdrop-dismiss.room-ready',
      'message-action-sheet.backdrop-dismiss.sheet-visible',
      'message-action-sheet.backdrop-dismiss.sheet-closed',
      'message-action-sheet.backdrop-dismiss.no-action',
    ],
  },
  {
    id: 'virtualized-latest',
    source: 'e2e/browser/journeys/conversations/message-action-sheet.spec.mts:261-306',
    tag: 'v',
    messageCount: 81,
    assertions: [
      'message-action-sheet.virtualized-latest.room-ready',
      'message-action-sheet.virtualized-latest.virtual-list-visible',
      'message-action-sheet.virtualized-latest.oldest-filler-rendered',
      'message-action-sheet.virtualized-latest.jump-visible',
      'message-action-sheet.virtualized-latest.latest-target-visible',
      'message-action-sheet.virtualized-latest.jump-hidden-before',
      'message-action-sheet.virtualized-latest.virtual-row-cap',
      'message-action-sheet.virtualized-latest.sheet-visible',
      'message-action-sheet.virtualized-latest.single-connected-target',
      'message-action-sheet.virtualized-latest.clearance.sheet-present',
      'message-action-sheet.virtualized-latest.clearance.row-inside-top',
      'message-action-sheet.virtualized-latest.clearance.row-inside-bottom',
      'message-action-sheet.virtualized-latest.clearance.eight-pixel-gap',
      'message-action-sheet.virtualized-latest.jump-hidden-during',
      'message-action-sheet.virtualized-latest.sheet-closed',
      'message-action-sheet.virtualized-latest.target-visible-after',
      'message-action-sheet.virtualized-latest.position-restored',
      'message-action-sheet.virtualized-latest.jump-hidden-after',
    ],
  },
  {
    id: 'thread-target',
    source: 'e2e/browser/journeys/conversations/message-action-sheet.spec.mts:308-334',
    tag: 't',
    messageCount: 1,
    assertions: [
      'message-action-sheet.thread-target.room-ready',
      'message-action-sheet.thread-target.thread-visible',
      'message-action-sheet.thread-target.thread-row-visible',
      'message-action-sheet.thread-target.sheet-visible',
      'message-action-sheet.thread-target.clearance.sheet-present',
      'message-action-sheet.thread-target.clearance.row-inside-top',
      'message-action-sheet.thread-target.clearance.row-inside-bottom',
      'message-action-sheet.thread-target.clearance.eight-pixel-gap',
      'message-action-sheet.thread-target.sheet-closed',
      'message-action-sheet.thread-target.position-restored',
    ],
  },
] as const;

export type MessageActionSheetCase = (typeof messageActionSheetCases)[number];
export type MessageActionSheetStage = MessageActionSheetCase['id'];
export type MessageActionSheetAssertion = MessageActionSheetCase['assertions'][number];

export const messageActionSheetAssertions = messageActionSheetCases.flatMap(
  (entry): readonly MessageActionSheetAssertion[] => entry.assertions,
);

assert.deepEqual(messageActionSheetCases.map((entry) => entry.assertions.length), [18, 4, 4, 18, 10]);
assert.equal(messageActionSheetAssertions.length, MESSAGE_ACTION_SHEET_ASSERTION_RECORDS);
assert.equal(new Set(messageActionSheetAssertions).size, MESSAGE_ACTION_SHEET_ASSERTION_RECORDS);

export function messageActionSheetAssertion(
  stage: MessageActionSheetStage,
  suffix: string,
): MessageActionSheetAssertion {
  const identity = `message-action-sheet.${stage}.${suffix}`;
  const found = messageActionSheetAssertions.find((candidate) => candidate === identity);
  assert(found, `Unknown message-action-sheet assertion ${identity}`);
  return found;
}
