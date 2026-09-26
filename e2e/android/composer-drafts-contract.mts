import assert from 'node:assert/strict';

export const COMPOSER_DRAFT_SOURCES = {
  helpers: 'e2e/browser/journeys/conversations/composer-drafts.spec.mts:23-69',
  definition:
    'e2e/browser/journeys/conversations/composer-drafts.spec.mts:74-108',
  app: 'e2e/support/app.mts',
  account: 'e2e/support/account.mts',
} as const;

export const composerDraftAssertions = {
  roomAInitialReady: 'composer-drafts.room-a-initial-ready',
  roomBReady: 'composer-drafts.room-b-ready',
  roomAReturnReady: 'composer-drafts.room-a-return-ready',
  roomARelaunchReady: 'composer-drafts.room-a-relaunch-ready',
  roomBEmpty: 'composer-drafts.room-b-empty',
  roomARestored: 'composer-drafts.room-a-restored',
  nativePreferencePersisted: 'composer-drafts.native-preference-persisted',
  coldRelaunchRestored: 'composer-drafts.cold-relaunch-restored',
} as const;

export type ComposerDraftAssertion =
  (typeof composerDraftAssertions)[keyof typeof composerDraftAssertions];

const assertionIds = Object.values(composerDraftAssertions);

export const COMPOSER_DRAFT_ASSERTION_RECORDS = assertionIds.length;

assert.equal(
  assertionIds.length,
  8,
  'Composer drafts own exactly eight assertion identities',
);
assert.equal(
  new Set(assertionIds).size,
  8,
  'Composer draft assertion identities must be unique',
);
