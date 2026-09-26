import assert from 'node:assert/strict';

export const LINK_PREVIEW_SOURCES = {
  ogUrl: 'e2e/browser/journeys/conversations/link-preview.spec.mts:17-23',
  definition:
    'e2e/browser/journeys/conversations/link-preview.spec.mts:28-74',
  caddy: 'e2e/support/synapse/Caddyfile:52-62',
  app: 'e2e/support/app.mts',
  account: 'e2e/support/account.mts',
} as const;

export const linkPreviewAssertions = {
  cardVisible: 'link-preview.card-visible',
  exactTitle: 'link-preview.exact-title',
  exactDestination: 'link-preview.exact-destination',
} as const;

export const LINK_PREVIEW_ASSERTION_RECORDS = 3;
export const LINK_PREVIEW_TITLE = 'Trinity E2E Preview';

const assertionIds = Object.values(linkPreviewAssertions);
assert.equal(assertionIds.length, LINK_PREVIEW_ASSERTION_RECORDS);
assert.equal(new Set(assertionIds).size, LINK_PREVIEW_ASSERTION_RECORDS);
