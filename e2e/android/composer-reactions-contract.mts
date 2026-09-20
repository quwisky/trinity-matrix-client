import assert from 'node:assert/strict';

export const COMPOSER_REACTION_SOURCES = {
  helpers:
    'e2e/browser/journeys/conversations/composer-reactions.spec.mts:22-72',
  toggle:
    'e2e/browser/journeys/conversations/composer-reactions.spec.mts:77-108',
  reaction:
    'e2e/browser/journeys/conversations/composer-reactions.spec.mts:110-204',
  android:
    'e2e/browser/journeys/conversations/composer-reactions.spec.mts:142-150',
  desktopExcluded:
    'e2e/browser/journeys/conversations/composer-reactions.spec.mts:152-177',
  app: 'e2e/support/app.mts',
  account: 'e2e/support/account.mts',
} as const;

export const composerReactionAssertions = {
  toggleComposerReady: 'composer-reactions.toggle.composer-ready',
  togglePickerVisible: 'composer-reactions.toggle.picker-visible',
  toggleTriggerExpanded: 'composer-reactions.toggle.trigger-expanded',
  togglePickerHidden: 'composer-reactions.toggle.picker-hidden',
  toggleTriggerCollapsed: 'composer-reactions.toggle.trigger-collapsed',
  messageComposerReady: 'composer-reactions.message.composer-ready',
  messageTargetVisible: 'composer-reactions.message.target-visible',
  messageDialogVisible: 'composer-reactions.message.dialog-visible',
  messagePickerVisible: 'composer-reactions.message.picker-visible',
  messageRocketVisible: 'composer-reactions.message.rocket-visible',
  messageExactTargetReaction:
    'composer-reactions.message.exact-target-reaction',
  messageMatrixRelation: 'composer-reactions.message.matrix-relation',
} as const;

export type ComposerReactionAssertion =
  (typeof composerReactionAssertions)[keyof typeof composerReactionAssertions];

export const composerReactionStageAssertions = {
  toggle: [
    composerReactionAssertions.toggleComposerReady,
    composerReactionAssertions.togglePickerVisible,
    composerReactionAssertions.toggleTriggerExpanded,
    composerReactionAssertions.togglePickerHidden,
    composerReactionAssertions.toggleTriggerCollapsed,
  ],
  message: [
    composerReactionAssertions.messageComposerReady,
    composerReactionAssertions.messageTargetVisible,
    composerReactionAssertions.messageDialogVisible,
    composerReactionAssertions.messagePickerVisible,
    composerReactionAssertions.messageRocketVisible,
    composerReactionAssertions.messageExactTargetReaction,
    composerReactionAssertions.messageMatrixRelation,
  ],
} as const;

const assertionIds = Object.values(composerReactionAssertions);

export const COMPOSER_REACTION_ASSERTION_RECORDS = assertionIds.length;

assert.equal(composerReactionStageAssertions.toggle.length, 5);
assert.equal(composerReactionStageAssertions.message.length, 7);
assert.equal(assertionIds.length, 12);
assert.equal(new Set(assertionIds).size, 12);
