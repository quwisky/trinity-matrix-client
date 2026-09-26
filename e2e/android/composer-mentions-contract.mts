import assert from 'node:assert/strict';

export const COMPOSER_MENTION_SOURCES = {
  helpers:
    'e2e/browser/journeys/conversations/composer-mentions.spec.mts:21-104',
  touch:
    'e2e/browser/journeys/conversations/composer-mentions.spec.mts:109-169',
  keyboard:
    'e2e/browser/journeys/conversations/composer-mentions.spec.mts:171-197',
  app: 'e2e/support/app.mts',
  account: 'e2e/support/account.mts',
} as const;

export const composerMentionAssertions = {
  touchComposerReady: 'composer-mentions.touch.composer-ready',
  touchAutocompleteVisible: 'composer-mentions.touch.autocomplete-visible',
  touchMemberVisible: 'composer-mentions.touch.member-visible',
  touchInsertedValue: 'composer-mentions.touch.inserted-value',
  touchSentMention: 'composer-mentions.touch.sent-mention',
  touchMentionClass: 'composer-mentions.touch.mention-class',
  touchFontWeight: 'composer-mentions.touch.font-weight',
  touchBackground: 'composer-mentions.touch.background',
  keyboardComposerReady: 'composer-mentions.keyboard.composer-ready',
  keyboardAutocompleteVisible:
    'composer-mentions.keyboard.autocomplete-visible',
  keyboardInsertedValue: 'composer-mentions.keyboard.inserted-value',
  keyboardSentLinkVisible: 'composer-mentions.keyboard.sent-link-visible',
} as const;

export type ComposerMentionAssertion =
  (typeof composerMentionAssertions)[keyof typeof composerMentionAssertions];

export const composerMentionStageAssertions = {
  touch: [
    composerMentionAssertions.touchComposerReady,
    composerMentionAssertions.touchAutocompleteVisible,
    composerMentionAssertions.touchMemberVisible,
    composerMentionAssertions.touchInsertedValue,
    composerMentionAssertions.touchSentMention,
    composerMentionAssertions.touchMentionClass,
    composerMentionAssertions.touchFontWeight,
    composerMentionAssertions.touchBackground,
  ],
  keyboard: [
    composerMentionAssertions.keyboardComposerReady,
    composerMentionAssertions.keyboardAutocompleteVisible,
    composerMentionAssertions.keyboardInsertedValue,
    composerMentionAssertions.keyboardSentLinkVisible,
  ],
} as const;

const assertionIds = Object.values(composerMentionAssertions);

export const COMPOSER_MENTION_ASSERTION_RECORDS = assertionIds.length;

assert.equal(composerMentionStageAssertions.touch.length, 8);
assert.equal(composerMentionStageAssertions.keyboard.length, 4);
assert.equal(assertionIds.length, 12);
assert.equal(new Set(assertionIds).size, 12);
